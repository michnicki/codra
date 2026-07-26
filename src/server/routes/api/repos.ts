import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import { getRepoConfigRecord, listRepoConfigs, upsertRepoConfig, syncRepoConfig, updateRepoConfigEnabled, deleteStaleRepoConfigs } from '@server/db/repo-configs';
import { jsonError } from '@server/core/http';
import { GitHubClient, type GitHubRepository } from '@server/core/github';
import { invalidateRepoConfigCache } from '@server/core/config';
import { repoConfigSchema } from '@shared/schema';
import { getOrCreateRepository } from '@server/db/repositories';
import { upsertVcsCredential } from '@server/db/vcs-credentials';
import { encryptSecret } from '@server/core/crypto';
import { queryTransaction } from '@server/db/client';
import { addBitbucketRepoInputSchema } from '@shared/bitbucket';

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

  return app;
}
