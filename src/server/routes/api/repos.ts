import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings, AppEnv } from '@server/env';
import { getRepoConfigRecord, listRepoConfigs, upsertRepoConfig, syncRepoConfig, updateRepoConfigEnabled, deleteStaleRepoConfigs } from '@server/db/repo-configs';
import { jsonError } from '@server/core/http';
import { GitHubClient, type GitHubRepository } from '@server/core/github';
import { invalidateRepoConfigCache } from '@server/core/config';
import { repoConfigSchema } from '@shared/schema';
import { findRepositoryIdByIdentity, getOrCreateRepository } from '@server/db/repositories';
import { upsertVcsCredential } from '@server/db/vcs-credentials';
import { encryptSecret } from '@server/core/crypto';
import { queryTransaction } from '@server/db/client';
import { addBitbucketRepoInputSchema } from '@shared/bitbucket';
import { clusterRejectFeedback, synthesizeRules } from '@server/core/learned-rules';
import { getRejectFeedbackForRepo } from '@server/db/reject-feedback';
import { requireSession } from '@server/middleware/auth';
import { requireCsrfHeader } from '@server/middleware/csrf';
import {
  claimCodeIndexBuildLease,
  getCodeIndexState,
  releaseCodeIndexBuildLease,
} from '@server/db/code-index';
import {
  INDEX_BUILD_LEASE_SECONDS,
  codeIndexInstanceId,
  type IndexBuildParams,
} from '@server/core/code-index-build';
import { logger } from '@server/core/logger';

const repoConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    review: repoConfigSchema.shape.review.optional(),
    model: repoConfigSchema.shape.model.optional(),
  })
  .strict()
  .refine(
    (patch) => patch.enabled !== undefined || patch.review !== undefined || patch.model !== undefined,
    'Repository config patch cannot be empty.',
  );

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A non-null record as returned by `getRepoConfigRecord` (i.e. `repoConfigRecordSchema`'s shape). */
type ResolvedRepoConfigRecord = NonNullable<Awaited<ReturnType<typeof getRepoConfigRecord>>>;

/**
 * Resolve the internal `repositories.id` for a record `getRepoConfigRecord` already returned.
 *
 * WHY THIS EXISTS AT ALL, since it looks like a second lookup for data the caller "already has":
 * `getRepoConfigRecord`'s SELECT never includes `r.id`, and `mapRepo` builds its result through the
 * SHARED `repoConfigRecordSchema` — the very schema serialized into the `/api/repos` list response and
 * the `/api/repos/:owner/:repo/config` read. Widening either one to carry an internal database id would
 * put a brand-new field on the dashboard's wire contract for the convenience of two internal callers,
 * so the id is RESOLVED through 29-07's read-only accessor instead. Do not "optimize" this away by
 * adding `r.id` to that SELECT.
 *
 * The record's OWN `vcsProvider` is used here, never the narrowed `?provider=` query value: an omitted
 * provider parameter must still resolve against the provider the record actually belongs to, and
 * `findRepositoryIdByIdentity` filters on `vcs_provider` so a same-named GitHub/Bitbucket pair can never
 * cross-resolve (T-29-08-02).
 *
 * The `workspace` fallback is provider-conditional because the two UNIQUE keys differ: Bitbucket's is
 * (vcs_provider, workspace, repo) and GitHub's is (vcs_provider, owner, repo) — migration 005. A
 * Bitbucket record added through the dashboard sets owner === workspace, so the `?? owner` fallback is
 * a safety net for a row written before that invariant held rather than the normal path.
 *
 * `null` means "no such repositories row", which callers must treat as a plain 404 and never an error.
 */
async function resolveRepositoryIdForRecord(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  record: ResolvedRepoConfigRecord,
): Promise<number | null> {
  return findRepositoryIdByIdentity(env, {
    vcsProvider: record.vcsProvider,
    ownerOrWorkspace:
      record.vcsProvider === 'bitbucket' ? (record.workspace ?? record.owner) : record.owner,
    repo: record.repo,
  });
}

export function createReposRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const repos = await listRepoConfigs(c.env);
    return c.json({ repos });
  });

  app.get('/install', async (c) => {
    try {
      return c.redirect(await GitHubClient.getAppInstallationUrl(c.env), 302);
    } catch (error) {
      console.error('Failed to resolve GitHub App installation URL:', error);
      return jsonError(`Failed to resolve GitHub App installation URL: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.post('/sync', async (c) => {
    try {
      const installations = await GitHubClient.listInstallations(c.env);
      const synced: string[] = [];

      for (const inst of installations) {
        const github = new GitHubClient(c.env, String(inst.id));
        const repos: GitHubRepository[] = await github.listRepositories();

        const results = await mapWithConcurrency(
          repos,
          5,
          async (repo: GitHubRepository) => {
            try {
              await syncRepoConfig(c.env, {
                installationId: String(inst.id),
                owner: repo.owner.login,
                repo: repo.name,
              });
              return `${repo.owner.login}/${repo.name}`;
            } catch (repoError) {
              console.error(`Failed to sync ${repo.owner.login}/${repo.name}:`, repoError);
              return null;
            }
          },
        );

        const installationSynced: string[] = [];
        for (const res of results) {
          if (res) {
            synced.push(res);
            installationSynced.push(res);
          }
        }
        
        await deleteStaleRepoConfigs(c.env, String(inst.id), installationSynced);
      }

      return c.json({ ok: true, synced });
    } catch (error) {
      console.error('Manual sync failed:', error);
      return jsonError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.get('/:owner/:repo/config', async (c) => {
    // Provider-address the read via an optional ?provider query param so a same-named
    // GitHub+Bitbucket pair is GET-isolated (review: Codex HIGH). When absent — GitHub-only or an
    // in-flight client that has not yet appended it — behavior is byte-identical to today (NREG-01).
    const providerQuery = c.req.query('provider');
    const vcsProvider = providerQuery === 'github' || providerQuery === 'bitbucket' ? providerQuery : undefined;
    const repo = await getRepoConfigRecord(c.env, c.req.param('owner'), c.req.param('repo'), vcsProvider);
    if (!repo) {
      return jsonError('Repository config not found.', 404);
    }

    return c.json({ repo });
  });

  app.patch('/:owner/:repo/config', async (c) => {
    const { owner, repo } = c.req.param();
    const providerQuery = c.req.query('provider');
    const vcsProvider = providerQuery === 'github' || providerQuery === 'bitbucket' ? providerQuery : undefined;
    const body = await c.req.json();
    const parsedPatch = repoConfigPatchSchema.safeParse(body);
    if (!parsedPatch.success) {
      return jsonError('Invalid repository config patch.', 400);
    }

    const existing = await getRepoConfigRecord(c.env, owner, repo, vcsProvider);

    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    const patch = parsedPatch.data;
    const hasConfigPatch = patch.review !== undefined || patch.model !== undefined;

    if (!hasConfigPatch && patch.enabled !== undefined) {
      // Key the toggle on the RESOLVED provider (not the raw query param) so it touches exactly one
      // provider's row for a same-named pair.
      await updateRepoConfigEnabled(c.env, {
        owner,
        repo,
        enabled: patch.enabled,
        vcsProvider: existing.vcsProvider,
      });
      await invalidateRepoConfigCache(c.env, owner, repo);
      return c.json({ ok: true });
    }

    const configPatch: Partial<z.infer<typeof repoConfigSchema>> = {};
    if (patch.review !== undefined) {
      configPatch.review = patch.review;
    }
    if (patch.model !== undefined) {
      configPatch.model = patch.model;
    }
    
    const updatedParsedJson = {
      ...existing.parsedJson,
      ...configPatch,
      // CRITICAL PATH FIX #3 (Plan 26-02): deep-merge the `review` sub-object so patching specific
      // review fields (e.g., `evidence`) does not destroy other review settings like `dedup`, `passes`,
      // `rounds`. If configPatch.review is undefined the spread of undefined is a no-op.
      review: {
        ...existing.parsedJson.review,
        ...configPatch.review,
      },
    };
    const parsedConfig = repoConfigSchema.safeParse(updatedParsedJson);

    if (!parsedConfig.success) {
      return jsonError('Invalid repository config.', 400);
    }
    
    await upsertRepoConfig(c.env, {
      installationId: existing.installationId,
      owner,
      repo,
      parsedJson: parsedConfig.data,
      enabled: patch.enabled,
      // Thread the resolved provider + workspace so a Bitbucket write routes through the Bitbucket
      // getOrCreateRepository branch (NULL installation_id, ON CONFLICT (vcs_provider, workspace,
      // repo)) and never cross-binds a same-named GitHub row (D-05).
      vcsProvider: existing.vcsProvider,
      workspace: existing.workspace,
    });
    await invalidateRepoConfigCache(c.env, owner, repo);

    return c.json({ ok: true });
  });

  // POST /bitbucket -- D-32 transactional add-repo endpoint. Reuses getOrCreateRepository's
  // existing bitbucket branch (installationId is ignored there and installation_id is bound NULL
  // implicitly) + encryptSecret + upsertVcsCredential inside a single queryTransaction, so the
  // repository row and the encrypted credential row commit atomically or not at all.
  app.post('/bitbucket', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = addBitbucketRepoInputSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError('Invalid Bitbucket repository payload.', 400);
    }

    const { workspace, repoSlug, accessToken, webhookSecret, tokenExpiresAt } = parsed.data;

    try {
      // Encrypt-at-boundary before the transaction (Phase 4 D-06). `c.env` is passed as the
      // env-like object encryptSecret expects, NOT the raw LLM_CONFIG_ENCRYPTION_KEY string.
      const encryptedAccessToken = await encryptSecret(c.env, accessToken);
      const encryptedWebhookSecret = await encryptSecret(c.env, webhookSecret);

      const credential = await queryTransaction(c.env, async () => {
        // Defensive guard: vcsProvider MUST be the literal 'bitbucket' here. If a future refactor
        // accidentally routes a Bitbucket call through the GitHub branch (which USES installationId),
        // the empty-string placeholder below would be stored as a non-NULL installation_id, breaking
        // Phase 5's findRepositoryByBitbucketIdentity NULL-installation_id assumption.
        await getOrCreateRepository(c.env, {
          installationId: '',
          vcsProvider: 'bitbucket',
          owner: workspace,
          repo: repoSlug,
          workspace,
        });

        return upsertVcsCredential(c.env, {
          vcsProvider: 'bitbucket',
          workspace,
          repoSlug,
          encryptedAccessToken,
          encryptedWebhookSecret,
          tokenExpiresAt: tokenExpiresAt ?? null,
        });
      });

      return c.json({ credential }, 201);
    } catch (error) {
      console.error('Failed to add Bitbucket repository:', error);
      return jsonError(
        error instanceof Error ? error.message : 'Failed to add Bitbucket repository.',
        500,
      );
    }
  });

  // POST /api/repos/:id/learned-rules/synthesize — LRN-01 on-demand synthesis trigger (D-10/D-11).
  // Clusters reject_feedback rows by (category, file_path), produces new pending rules, appends
  // to existing config. Gated on learning.enabled (NREG-01). Uses explicit requireSession +
  // requireCsrfHeader middleware (C6 — defense-in-depth, same as group-level /api/* guards).
  app.post('/:owner/:repo/learned-rules/synthesize', async (c) => {
    const { owner, repo } = c.req.param();
    const providerQuery = c.req.query('provider');
    const vcsProvider = providerQuery === 'github' || providerQuery === 'bitbucket' ? providerQuery : undefined;

    const existing = await getRepoConfigRecord(c.env, owner, repo, vcsProvider);
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    const config = existing.parsedJson;
    if (!(config.review.learning?.enabled ?? false)) {
      return jsonError('Learned-rule synthesis is not enabled for this repository. Enable learning.enabled first.', 400);
    }

    // Query all reject_feedback for this repo
    const rows = await getRejectFeedbackForRepo(c.env, {
      vcsProvider: existing.vcsProvider,
      workspace: existing.workspace ?? existing.owner,
      repoSlug: existing.repo,
    });

    // Cluster and synthesize
    const clusters = clusterRejectFeedback(rows);
    const existingRules = config.review.learning?.learned_rules ?? [];
    const newRules = synthesizeRules(clusters, existingRules);

    if (newRules.length === 0) {
      return c.json({ ok: true, rules: [], message: 'No new rule candidates found' });
    }

    // Append new rules to existing rules (never replace — preserves operator decisions per Antigravity 1.1)
    const updatedLearning = {
      ...config.review.learning,
      learned_rules: [...existingRules, ...newRules],
    };

    const updatedParsedJson = {
      ...config,
      review: {
        ...config.review,
        learning: updatedLearning,
      },
    };

    const parsedConfig = repoConfigSchema.safeParse(updatedParsedJson);
    if (!parsedConfig.success) {
      return jsonError('Invalid repository config after synthesis.', 500);
    }

    await upsertRepoConfig(c.env, {
      installationId: existing.installationId,
      owner,
      repo,
      parsedJson: parsedConfig.data,
      vcsProvider: existing.vcsProvider,
      workspace: existing.workspace,
    });
    await invalidateRepoConfigCache(c.env, owner, repo);

    return c.json({ ok: true, rules: newRules });
  });

  // PATCH /api/repos/:id/learned-rules/:ruleId — LRN-01 rule status transition (D-08).
  // Transitions: pending->active, active->disabled, disabled->active. Rejects invalid
  // transitions with 400. Uses explicit requireSession + requireCsrfHeader middleware (C6).
  app.patch('/:owner/:repo/learned-rules/:ruleId', async (c) => {
    const { owner, repo, ruleId } = c.req.param();
    const providerQuery = c.req.query('provider');
    const vcsProvider = providerQuery === 'github' || providerQuery === 'bitbucket' ? providerQuery : undefined;

    const body = await c.req.json().catch(() => null);
    const statusParsed = z.enum(['pending', 'active', 'disabled']).safeParse(body?.status);
    if (!statusParsed.success) {
      return jsonError('Invalid status. Must be one of: pending, active, disabled.', 400);
    }
    const newStatus = statusParsed.data;

    const existing = await getRepoConfigRecord(c.env, owner, repo, vcsProvider);
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    const config = existing.parsedJson;
    const rules = config.review.learning?.learned_rules ?? [];
    const ruleIndex = rules.findIndex((r) => r.id === ruleId);
    if (ruleIndex === -1) {
      return jsonError('Learned rule not found.', 404);
    }

    const currentRule = rules[ruleIndex];

    // Validate status transitions: pending->active, active->disabled, disabled->active
    const validTransitions: Record<string, string[]> = {
      pending: ['active'],
      active: ['disabled'],
      disabled: ['active'],
    };
    if (!validTransitions[currentRule.status]?.includes(newStatus)) {
      return jsonError(
        `Invalid status transition: ${currentRule.status} -> ${newStatus}. Valid transitions: ${validTransitions[currentRule.status]?.join(', ')}`,
        400,
      );
    }

    // Update the rule's status
    const updatedRules = [...rules];
    updatedRules[ruleIndex] = { ...currentRule, status: newStatus };

    const updatedLearning = {
      ...config.review.learning,
      learned_rules: updatedRules,
    };

    const updatedParsedJson = {
      ...config,
      review: {
        ...config.review,
        learning: updatedLearning,
      },
    };

    const parsedConfig = repoConfigSchema.safeParse(updatedParsedJson);
    if (!parsedConfig.success) {
      return jsonError('Invalid repository config after rule update.', 500);
    }

    await upsertRepoConfig(c.env, {
      installationId: existing.installationId,
      owner,
      repo,
      parsedJson: parsedConfig.data,
      vcsProvider: existing.vcsProvider,
      workspace: existing.workspace,
    });
    await invalidateRepoConfigCache(c.env, owner, repo);

    return c.json({ ok: true, rule: updatedRules[ruleIndex] });
  });

  // ---------------------------------------------------------------------------------------------
  // Phase 29 / QA-IDX-01: the codebase index's two operator endpoints (D-07).
  //
  // D-07 is explicit that an index build starts ONLY from a deliberate dashboard action, on both
  // providers, through ONE code path — there is no auto-build on repository install and no auto-build
  // on a question that finds nothing. THESE HANDLERS ARE THAT PATH: without them 29-05's
  // IndexWorkflow has no trigger at all, and an operator has no way to see whether an index exists,
  // how fresh it is, or why the last build failed.
  //
  // Both are modelled on POST /:owner/:repo/learned-rules/synthesize above, and both are
  // provider-agnostic by construction — `getRepoConfigRecord` handles a Bitbucket repository with a
  // NULL installation_id (repo-configs.ts types the column `string | null` and lazily materializes a
  // missing Bitbucket `repo_configs` row, which the add-Bitbucket flow does not create), and
  // `findRepositoryIdByIdentity` matches each provider's own UNIQUE key.
  // ---------------------------------------------------------------------------------------------

  // POST /api/repos/:owner/:repo/code-index/build — start a FULL rebuild of the codebase index.
  //
  // `requireSession` + `requireCsrfHeader` are applied EXPLICITLY here as defense in depth over the
  // group-level /api/* guards in app.ts, matching the learned-rules endpoints' C6 treatment
  // (T-29-08-01). The repository is resolved SERVER-SIDE from the authenticated path plus the narrowed
  // provider query parameter; no repository identifier is ever read from the body or the query, so a
  // caller cannot start a build for a repository other than the one named in the path (T-29-08-02).
  app.post('/:owner/:repo/code-index/build', requireSession, requireCsrfHeader, async (c) => {
    const { owner, repo } = c.req.param();
    const providerQuery = c.req.query('provider');
    const vcsProvider = providerQuery === 'github' || providerQuery === 'bitbucket' ? providerQuery : undefined;

    const existing = await getRepoConfigRecord(c.env, owner, repo, vcsProvider);
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    // NREG-01 / T-29-08-04: the toggle gate precedes the lease claim AND the instance creation, so a
    // repository whose operator has not opted in cannot have a build started for it at all. The message
    // names the exact config key, because "not enabled" without the key is not actionable.
    const config = existing.parsedJson;
    if (!config.review.interactive.qa.index.enabled) {
      return jsonError(
        'Codebase indexing is not enabled for this repository. Enable review.interactive.qa.index.enabled first.',
        400,
      );
    }

    const repositoryId = await resolveRepositoryIdForRecord(c.env, existing);
    if (repositoryId === null) {
      return jsonError('Repository config not found.', 404);
    }

    // THE INSTANCE ID AND THE LEASE OWNER MUST BE THE SAME STRING, and that is not a stylistic
    // preference. `IndexWorkflow.execute` claims the lease under `event.instanceId` — the LIVE id of the
    // instance created below — and `claimCodeIndexBuildLease` only permits a re-claim when
    // `workflow_instance_id` matches. Claiming here under any other value (a fresh UUID, say) would make
    // the workflow's own first claim fail, so the build it just started would coalesce ITSELF away and
    // nothing would ever index.
    //
    // `codeIndexInstanceId` is CALLED, never re-implemented: 29-06's two push branches key on the same
    // helper, and the whole `instance.already_exists` coalescing story needs all three sites to produce a
    // byte-identical id. A locally formatted "stable per-repository id" differing by one character makes
    // that rejection unreachable and leaves the durable lease as the only guard.
    const workflowInstanceId = codeIndexInstanceId(repositoryId);

    const coalesced = (reason: string) =>
      c.json({
        ok: true,
        coalesced: true,
        build: { mode: 'full' as const, workflowInstanceId },
        message: 'A codebase index build is already running for this repository.',
        reason,
      });

    // T-29-08-03: the lease claim precedes the instance creation, and a FAILED claim is a BENIGN
    // COALESCED DUPLICATE rather than an error — a second press while a build is live is not a client
    // mistake, and answering 409 would train an operator to retry the one thing that must not be retried.
    const claimed = await claimCodeIndexBuildLease(c.env, {
      repositoryId,
      workflowInstanceId,
      leaseSeconds: INDEX_BUILD_LEASE_SECONDS,
    });
    if (!claimed) {
      logger.info('Codebase index build request coalesced: a build already holds the lease', {
        repositoryId,
        vcsProvider: existing.vcsProvider,
        reason: 'lease_held',
      });
      return coalesced('lease_held');
    }

    // `mode: 'full'` is D-07's dashboard rebuild, and `continuation: 0` marks a genuinely NEW build (a
    // fresh-instance handoff deliberately starts at 1 so it cannot re-run the destructive reset).
    const params: IndexBuildParams = {
      repositoryId,
      vcsProvider: existing.vcsProvider,
      owner: existing.owner,
      repo: existing.repo,
      workspace: existing.workspace ?? null,
      installationId: existing.installationId,
      mode: 'full',
      workflowInstanceId,
      continuation: 0,
    };

    try {
      await c.env.INDEX_WORKFLOW.create({ id: workflowInstanceId, params });
    } catch (error) {
      if (error instanceof Error && error.message.includes('instance.already_exists')) {
        // The same disposition the queue consumer already gives this rejection (src/server/index.ts):
        // an instance for this repository is live, so the press is a duplicate rather than a failure.
        // Reachable even though the lease claim succeeded — a re-claim by the SAME instance id is legal,
        // which is exactly the case where a still-running instance already owns this id.
        logger.info('Codebase index build request coalesced: workflow instance already exists', {
          repositoryId,
          vcsProvider: existing.vcsProvider,
          reason: 'instance_already_exists',
        });
        return coalesced('instance_already_exists');
      }

      // RELEASE THE LEASE THE REQUEST JUST TOOK. Without this, a Cloudflare-side create failure leaves
      // the state row reading `building` with a live 15-minute lease and no build behind it: the panel
      // shows a phantom build and every retry in that window coalesces against a lease nobody owns.
      // Best-effort — a failed release must not mask the create error, and lease expiry is the backstop.
      try {
        await releaseCodeIndexBuildLease(c.env, { repositoryId, workflowInstanceId });
      } catch (releaseError) {
        logger.error(
          'Failed to release the codebase index build lease after a failed workflow create',
          releaseError instanceof Error ? releaseError : new Error(String(releaseError)),
        );
      }

      logger.error(
        'Failed to start the codebase index build workflow',
        error instanceof Error ? error : new Error(String(error)),
      );
      return jsonError('Failed to start the codebase index build.', 500);
    }

    // NO CONFIG WRITE, DELIBERATELY. The learned-rules handler this is modelled on ends with
    // `upsertRepoConfig` + `invalidateRepoConfigCache`; starting a build mutates NO configuration, so
    // copying that tail would bump `repo_configs.updated_at` and evict the config cache on every press —
    // making an operator action look like a config edit to every downstream reader (the repo list's
    // "updated" column, the cache, anything auditing config churn) and re-serializing a config nobody
    // asked to change (T-29-08-06).
    return c.json({
      ok: true,
      coalesced: false,
      // Returned so an operator report ("I pressed build and nothing happened") can be correlated with
      // the actual Workflow instance in the Cloudflare dashboard. Derived server-side from the resolved
      // repository; never accepted as input.
      build: { mode: 'full' as const, workflowInstanceId },
    });
  });

  // GET /api/repos/:owner/:repo/code-index/status — the operator's read of the current index.
  //
  // `requireSession` is applied explicitly for the same defense-in-depth reason as the POST.
  // `requireCsrfHeader` is deliberately NOT listed: it self-exempts GET/HEAD/OPTIONS, so adding it here
  // would be an inert line that reads as a guard. The group-level /api/* guards cover this route too.
  app.get('/:owner/:repo/code-index/status', requireSession, async (c) => {
    const { owner, repo } = c.req.param();
    const providerQuery = c.req.query('provider');
    const vcsProvider = providerQuery === 'github' || providerQuery === 'bitbucket' ? providerQuery : undefined;

    const existing = await getRepoConfigRecord(c.env, owner, repo, vcsProvider);
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }

    const repositoryId = await resolveRepositoryIdForRecord(c.env, existing);
    if (repositoryId === null) {
      return jsonError('Repository config not found.', 404);
    }

    // Scoped to the resolved repository ONLY — `getCodeIndexState` is keyed on the bound repository_id,
    // so this response can never describe another tenant's index (T-29-08-05).
    const state = await getCodeIndexState(c.env, { repositoryId });

    // A NEVER-BUILT REPOSITORY GETS A WELL-DEFINED RESPONSE, NOT A 404. The absence of a
    // `code_index_state` row is a normal state ("no build has ever run"), not a missing resource, and
    // 404 here would force the panel to render an error for the one case where it should render an
    // invitation to press Build. `status: 'idle'` is migration 018's documented word for exactly that
    // state, so the panel has one status vocabulary rather than a null special case.
    //
    // The keys are the dashboard's camelCase wire convention (matching `mapJob`), projecting the
    // `code_index_state` columns `status`, `mode`, `indexed_sha`, `indexed_at`, `file_count`,
    // `chunk_count`, `truncated` and `last_error`.
    //
    // `mode` IS INCLUDED DELIBERATELY (review: OpenCode 29-09 #15 — "Last refresh: never / push /
    // manual"). It is the operator's answer to "what produced the index I am looking at": `full` for a
    // dashboard rebuild, `incremental` for a push-triggered refresh, NULL before the first build. That is
    // the question a stale `indexed_at` actually raises — a Bitbucket repository whose webhook
    // subscription was never edited to include the push event sits at `mode: 'full'` forever no matter
    // how many merges land, and without `mode` the panel cannot tell that apart from a quiet repository.
    //
    // `lastError` IS ALREADY REDACTED where it was written (AUD-01: `runIndexBuild` routes it through
    // `redactErrorMessage` at the single `markCodeIndexBuildFailed` call site, because db/ must not
    // import core/). It is passed through UNCHANGED — do not re-process, enrich, or re-expand it here.
    return c.json({
      index: {
        status: state?.status ?? 'idle',
        mode: state?.mode ?? null,
        indexedSha: state?.indexed_sha ?? null,
        indexedAt: state?.indexed_at ?? null,
        fileCount: state?.file_count ?? 0,
        chunkCount: state?.chunk_count ?? 0,
        truncated: state?.truncated ?? false,
        lastError: state?.last_error ?? null,
      },
    });
  });

  return app;
}
