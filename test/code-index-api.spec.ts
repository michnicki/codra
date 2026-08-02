import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createApp } from '@server/app';
import { getRepoConfigRecord, upsertRepoConfig } from '@server/db/repo-configs';
import { findRepositoryIdByIdentity } from '@server/db/repositories';
import {
  getCodeIndexState,
  markCodeIndexBuildCompleted,
  markCodeIndexBuildStarted,
} from '@server/db/code-index';
import { codeIndexInstanceId, type IndexBuildParams } from '@server/core/code-index-build';
import { queryRows } from '@server/db/client';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

/**
 * Phase 29 (QA-IDX-01) — HTTP-level coverage for the two codebase-index ROUTES in
 * `src/server/routes/api/repos.ts`: the D-07 build trigger and the operator status read.
 *
 * `test/code-index-workflow.spec.ts` proves the build LOGIC (budget arithmetic, selection,
 * resumability, lease coalescing, the durable loop). This file covers what those tests structurally
 * cannot: the route bodies — the 404 branch, the toggle-off gate that must precede any lease claim,
 * the provider narrowing that keeps a same-named GitHub/Bitbucket pair from cross-resolving, the CSRF
 * guard, the double-press coalescing, and the shape of the status response.
 *
 * EVERY ASSERTION ABOUT PERSISTED STATE RE-READS IT FROM POSTGRES rather than trusting the response
 * body. The defect class this file exists to catch is "the route answered 200 but nothing was
 * persisted and nothing was started" — a shape a response-body assertion cannot see.
 *
 * ── TEST-ENVIRONMENT HAZARDS (so a future reader does not misdiagnose them) ────────────────────────
 *
 *  - The LIVE test Postgres does not necessarily listen on the port `.env.test` names (5432).
 *    Observed on 5433 and later on 5455. A connection refusal here is an ENVIRONMENT problem — an
 *    exported `TEST_DATABASE_URL` pointing at the live port fixes it. It is never a code problem, and
 *    it must never be "fixed" by editing a port into production code.
 *  - The test database is NEVER RESET between runs, so rows ACCUMULATE. The fix is truncating or
 *    deleting the seeded rows (this file does so in `afterAll`), never a change to production code.
 *  - A bare `npx vitest run` skips the env files and `createTestEnv()` then throws on
 *    `BITBUCKET_CLIENT_ID`. Run the suite through `npm test`.
 */
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

/** Shared owner/workspace text. The provider-narrowing case relies on BOTH providers using it. */
const OWNER = 'code-index-api-owner';
const INSTALLATION_ID = '456';

/**
 * A Workflow mock that DEDUPLICATES INSTANCE IDS, unlike the permissive `MockWorkflow` in
 * `test/helpers.ts`.
 *
 * This is the point of the file, not a convenience. In production the second press of "Build index"
 * is coalesced by Cloudflare rejecting a `create` for an id that already exists — the lease re-claim
 * deliberately SUCCEEDS for a repeat press, because `claimCodeIndexBuildLease` treats a re-claim under
 * the same `workflow_instance_id` as legal re-entry (that rule is what lets a hibernating build resume
 * without locking itself out). So `instance.already_exists` is the guard that actually fires for a
 * double press, and the shared mock — which happily records two creations — would make the
 * double-press case pass no matter what the handler did.
 */
class DedupingMockWorkflow {
  public readonly created: Array<{ id: string; params: IndexBuildParams }> = [];
  private readonly ids = new Set<string>();

  async create(opts: { id: string; params: IndexBuildParams }) {
    if (this.ids.has(opts.id)) {
      // The handler matches on the `instance.already_exists` substring, exactly as the queue consumer
      // in src/server/index.ts already does for REVIEW_WORKFLOW.
      throw new Error(`instance.already_exists: An instance with id "${opts.id}" already exists.`);
    }
    this.ids.add(opts.id);
    this.created.push(opts);
  }

  async get(id: string) {
    return { terminate: async () => undefined, id };
  }
}

function mockGitHubProfile(login = 'devarshishimpi') {
  return { id: 42, login, name: 'Devarshi Shimpi', avatar_url: 'https://example.invalid/a.png', email: null };
}

/** The default config with only `review.interactive.qa.index.enabled` moved. */
function indexConfig(enabled: boolean): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      interactive: {
        ...defaultRepoConfig.review.interactive,
        qa: {
          ...defaultRepoConfig.review.interactive.qa,
          index: { ...defaultRepoConfig.review.interactive.qa.index, enabled },
        },
      },
    },
  };
}

dbDescribe('codebase-index routes (QA-IDX-01 build trigger + status read)', () => {
  const app = createApp();
  /** Every repo slug this file seeds, so `afterAll` can remove exactly its own rows. */
  const seededRepos: Array<{ vcsProvider: 'github' | 'bitbucket'; repo: string }> = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // The test database is never reset; remove what this file created. Deleting the `repositories`
    // rows cascades to code_index_state / code_index_files / code_index_chunks (migration 018's
    // ON DELETE CASCADE), but repo_configs is deleted explicitly so the cleanup does not depend on
    // another table's FK action.
    const env = createTestEnv();
    for (const seeded of seededRepos) {
      const repositoryId = await findRepositoryIdByIdentity(env, {
        vcsProvider: seeded.vcsProvider,
        ownerOrWorkspace: OWNER,
        repo: seeded.repo,
      });
      if (repositoryId === null) continue;
      await queryRows(env, `DELETE FROM code_index_chunks WHERE repository_id = $1`, [repositoryId]);
      await queryRows(env, `DELETE FROM code_index_files WHERE repository_id = $1`, [repositoryId]);
      await queryRows(env, `DELETE FROM code_index_state WHERE repository_id = $1`, [repositoryId]);
      await queryRows(env, `DELETE FROM repo_configs WHERE repository_id = $1`, [repositoryId]);
      await queryRows(env, `DELETE FROM repositories WHERE id = $1`, [repositoryId]);
    }
  });

  /** A test env whose INDEX_WORKFLOW deduplicates ids the way Cloudflare does. */
  function createIndexTestEnv() {
    const workflow = new DedupingMockWorkflow();
    const env = createTestEnv({ INDEX_WORKFLOW: workflow as unknown as Workflow });
    return { env, workflow };
  }

  /** Drive the real OAuth callback to mint a session cookie (same approach as test/api.spec.ts). */
  async function getAuthCookie(env: ReturnType<typeof createTestEnv>): Promise<string> {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-access-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json(mockGitHubProfile());
      }
      return originalFetch(input, init);
    });

    const authStart = await app.request('/auth/github', {}, env);
    const state = new URL(authStart.headers.get('location')!).searchParams.get('state');
    const stateCookie = (authStart.headers.get('set-cookie') || '').match(/codra_oauth_state=[^;]+/)?.[0] ?? '';
    const callback = await app.request(
      `/auth/github/callback?code=test-code&state=${state}`,
      { headers: { cookie: stateCookie } },
      env,
    );
    return (callback.headers.get('set-cookie') || '').match(/codra_session=([^;]+)/)?.[1] ?? '';
  }

  function writeHeaders(token: string) {
    return {
      Cookie: `codra_session=${token}`,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/json',
    };
  }

  function readHeaders(token: string) {
    return { Cookie: `codra_session=${token}` };
  }

  /**
   * Seed a repository row plus its per-repo config on the given provider.
   *
   * The Bitbucket branch passes `vcsProvider` + `workspace` so `getOrCreateRepository` takes its
   * Bitbucket path: installation_id NULL, ON CONFLICT (vcs_provider, workspace, repo). That is what
   * makes the provider-narrowing case a genuine same-owner/same-repo collision across providers, and
   * it is also the shape that proves these endpoints work for a repository with no installation at all.
   */
  async function seedRepo(
    env: ReturnType<typeof createTestEnv>,
    repo: string,
    options: { enabled?: boolean; vcsProvider?: 'github' | 'bitbucket' } = {},
  ): Promise<number> {
    const vcsProvider = options.vcsProvider ?? 'github';
    await upsertRepoConfig(env, {
      installationId: vcsProvider === 'bitbucket' ? null : INSTALLATION_ID,
      owner: OWNER,
      repo,
      parsedJson: indexConfig(options.enabled ?? true),
      vcsProvider,
      workspace: vcsProvider === 'bitbucket' ? OWNER : undefined,
    });
    seededRepos.push({ vcsProvider, repo });

    const repositoryId = await findRepositoryIdByIdentity(env, {
      vcsProvider,
      ownerOrWorkspace: OWNER,
      repo,
    });
    if (repositoryId === null) {
      throw new Error(`Seeding failed: no ${vcsProvider} repositories row for ${OWNER}/${repo}`);
    }
    return repositoryId;
  }

  function buildUrl(repo: string, provider?: 'github' | 'bitbucket') {
    const query = provider ? `?provider=${provider}` : '';
    return `/api/repos/${OWNER}/${repo}/code-index/build${query}`;
  }

  function statusUrl(repo: string, provider?: 'github' | 'bitbucket') {
    const query = provider ? `?provider=${provider}` : '';
    return `/api/repos/${OWNER}/${repo}/code-index/status${query}`;
  }

  // --- Behavior 1: unknown repository ------------------------------------------------------------

  it('returns 404 from BOTH endpoints for a repository that does not exist', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-missing-${Date.now()}`;

    const build = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);
    expect(build.status).toBe(404);

    const status = await app.request(statusUrl(repo, 'github'), { headers: readHeaders(token) }, env);
    expect(status.status).toBe(404);

    // A 404 must not have started anything.
    expect(workflow.created).toHaveLength(0);
  });

  // --- Behavior 2: toggle off (NREG-01 / T-29-08-04) ---------------------------------------------

  it('returns 400 naming the config key when the index toggle is off, and starts nothing', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-off-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo, { enabled: false });

    const response = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('review.interactive.qa.index.enabled');

    expect(workflow.created).toHaveLength(0);
    // The gate precedes the LEASE CLAIM, not merely the workflow create: an opted-out repository must
    // have no code_index_state row at all afterwards.
    expect(await getCodeIndexState(env, { repositoryId })).toBeNull();
  });

  // --- Behavior 3: the positive build ------------------------------------------------------------

  it('claims the lease and starts exactly one full-rebuild instance when the toggle is on', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-build-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);

    const response = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, coalesced: false });

    expect(workflow.created).toHaveLength(1);
    expect(workflow.created[0].params).toMatchObject({
      repositoryId,
      vcsProvider: 'github',
      owner: OWNER,
      repo,
      mode: 'full',
      // A genuinely new build. A handoff starts at 1 precisely so it cannot re-run the destructive reset.
      continuation: 0,
    });

    // Re-read from Postgres: the lease is claimed and owned by the instance that was created.
    const state = await getCodeIndexState(env, { repositoryId });
    expect(state).not.toBeNull();
    expect(state!.status).toBe('building');
    expect(state!.workflow_instance_id).toBe(codeIndexInstanceId(repositoryId));
    expect(state!.lease_expires_at).not.toBeNull();
  });

  // --- Behavior 8: the instance id is the shared helper's output ---------------------------------

  it('keys the instance on codeIndexInstanceId(repositoryId), the same helper both push branches use', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-instid-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);

    const response = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);
    expect(response.status).toBe(200);

    // Compared against the IMPORTED helper, never a retyped literal: a hand-formatted id differing by
    // one character would make `instance.already_exists` unreachable across the three creation sites
    // while every "stable per-repository id" assertion still passed.
    expect(workflow.created[0].id).toBe(codeIndexInstanceId(repositoryId));
    expect(workflow.created[0].params.workflowInstanceId).toBe(codeIndexInstanceId(repositoryId));
  });

  // --- Behavior 4: the double press --------------------------------------------------------------

  it('retries with a fresh instance id when the per-repository id is already taken', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-double-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);

    const first = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);
    expect(first.status).toBe(200);
    expect(workflow.created).toHaveLength(1);

    const second = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);

    // The per-repository id is taken (terminated instance record), so the endpoint retries with a
    // fresh unique id. This is NOT coalescing — a terminated instance can never resume, so the build
    // must proceed under a new id rather than being silently dropped.
    expect(second.status).toBe(200);
    const body = await second.json() as { ok: boolean; coalesced: boolean };
    expect(body.ok).toBe(true);
    expect(body.coalesced).toBe(false);

    // Two creations: one per-repository id (first press), one fresh id (second press after retry).
    expect(workflow.created).toHaveLength(2);
    expect(workflow.created[0].id).toBe(codeIndexInstanceId(repositoryId));
    expect(workflow.created[1].id).not.toBe(codeIndexInstanceId(repositoryId));
    expect(workflow.created[1].id).toContain(codeIndexInstanceId(repositoryId));

    const state = await getCodeIndexState(env, { repositoryId });
    // The state is updated to the fresh instance id from the second (successful) create.
    expect(state!.workflow_instance_id).toBe(workflow.created[1].id);
  });

  it('coalesces when a DIFFERENT instance holds the live lease (the handoff case)', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-foreign-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);

    // A fresh-instance handoff owns the lease under a random UUID, so the endpoint's own claim FAILS
    // rather than being treated as legal re-entry. That is the second, independent coalescing branch.
    const foreignInstanceId = crypto.randomUUID();
    await markCodeIndexBuildStarted(env, {
      repositoryId,
      mode: 'full',
      indexedRef: 'refs/heads/main',
      buildingSha: 'a'.repeat(40),
      workflowInstanceId: foreignInstanceId,
      leaseSeconds: 900,
    });

    const response = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, coalesced: true, reason: 'lease_held' });
    expect(workflow.created).toHaveLength(0);

    // The live build's lease was NOT stolen.
    const state = await getCodeIndexState(env, { repositoryId });
    expect(state!.workflow_instance_id).toBe(foreignInstanceId);
  });

  // --- Behavior 5: provider narrowing (T-29-08-02) -----------------------------------------------

  it('narrows on the provider parameter so a same-named GitHub/Bitbucket pair cannot cross-resolve', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    // ONE repo slug, deliberately: both providers share owner AND repo text, which is the collision
    // the provider filter exists to survive.
    const repo = `ci-provider-${Date.now()}`;
    const githubRepositoryId = await seedRepo(env, repo, { vcsProvider: 'github' });
    const bitbucketRepositoryId = await seedRepo(env, repo, { vcsProvider: 'bitbucket' });
    expect(githubRepositoryId).not.toBe(bitbucketRepositoryId);

    const response = await app.request(
      buildUrl(repo, 'bitbucket'),
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );
    expect(response.status).toBe(200);

    // A count-only assertion cannot distinguish the two repositories — assert on BOTH state rows.
    const bitbucketState = await getCodeIndexState(env, { repositoryId: bitbucketRepositoryId });
    const githubState = await getCodeIndexState(env, { repositoryId: githubRepositoryId });
    expect(bitbucketState).not.toBeNull();
    expect(bitbucketState!.status).toBe('building');
    expect(bitbucketState!.workflow_instance_id).toBe(codeIndexInstanceId(bitbucketRepositoryId));
    expect(githubState).toBeNull();

    // The started build carries the Bitbucket identity, including the NULL installation the known
    // Bitbucket hazard is about: a handler that required a non-null installationId would have 404'd or
    // 500'd above rather than reaching here.
    expect(workflow.created).toHaveLength(1);
    expect(workflow.created[0].params).toMatchObject({
      repositoryId: bitbucketRepositoryId,
      vcsProvider: 'bitbucket',
      workspace: OWNER,
      installationId: null,
      mode: 'full',
    });
  });

  it('serves the status read for a Bitbucket repository with a NULL installation id', async () => {
    const { env } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-bb-status-${Date.now()}`;
    await seedRepo(env, repo, { vcsProvider: 'bitbucket' });

    const response = await app.request(statusUrl(repo, 'bitbucket'), { headers: readHeaders(token) }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      index: { status: 'idle', mode: null, indexedSha: null },
    });
  });

  // --- Behavior 6: CSRF (T-29-08-01) ------------------------------------------------------------

  it('rejects a build POST that omits the CSRF header', async () => {
    const { env, workflow } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-csrf-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);

    const response = await app.request(
      buildUrl(repo, 'github'),
      {
        method: 'POST',
        // A valid session cookie, but no `x-requested-with` — the exact shape of a cross-site form post.
        headers: { Cookie: `codra_session=${token}`, 'content-type': 'application/json' },
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(workflow.created).toHaveLength(0);
    expect(await getCodeIndexState(env, { repositoryId })).toBeNull();
  });

  // --- Behavior 7: the status shape -------------------------------------------------------------

  it('returns a well-defined status for a never-built repository rather than a 404', async () => {
    const { env } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-never-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);

    // Precondition, read from Postgres: there really is no state row yet.
    expect(await getCodeIndexState(env, { repositoryId })).toBeNull();

    const response = await app.request(statusUrl(repo, 'github'), { headers: readHeaders(token) }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      index: {
        status: 'idle',
        // NULL mode is the "never built" case the panel must distinguish from a push refresh.
        mode: null,
        indexedSha: null,
        indexedAt: null,
        fileCount: 0,
        chunkCount: 0,
        truncated: false,
        lastError: null,
      },
    });
  });

  it('reports the recorded status, mode, sha, counts and truncated flag after a completed build', async () => {
    const { env } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-ready-${Date.now()}`;
    const repositoryId = await seedRepo(env, repo);
    const indexedSha = 'b'.repeat(40);

    // Drive the real accessors, so the response is asserted against genuine persisted state.
    await markCodeIndexBuildStarted(env, {
      repositoryId,
      mode: 'full',
      indexedRef: 'refs/heads/main',
      buildingSha: indexedSha,
      workflowInstanceId: codeIndexInstanceId(repositoryId),
      leaseSeconds: 900,
    });
    await markCodeIndexBuildCompleted(env, {
      repositoryId,
      indexedRef: 'refs/heads/main',
      indexedSha,
      fileCount: 14,
      chunkCount: 41,
      truncated: true,
    });

    const response = await app.request(statusUrl(repo, 'github'), { headers: readHeaders(token) }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { index: Record<string, unknown> };

    // `mode: 'full'` is the dashboard-rebuild provenance (OpenCode 29-09 #15) — the half of "Last
    // refresh: never / push / manual" that lives on the server.
    expect(body.index).toMatchObject({
      status: 'ready',
      mode: 'full',
      indexedSha,
      fileCount: 14,
      chunkCount: 41,
      truncated: true,
      lastError: null,
    });
    expect(body.index.indexedAt).not.toBeNull();

    // The response is a faithful projection of the row, not a computed summary.
    const state = await getCodeIndexState(env, { repositoryId });
    expect(body.index.status).toBe(state!.status);
    expect(body.index.mode).toBe(state!.mode);
    expect(body.index.indexedSha).toBe(state!.indexed_sha);
  });

  // --- T-29-08-06: starting a build is not a config edit ----------------------------------------

  it('writes no repository configuration when a build is started', async () => {
    const { env } = createIndexTestEnv();
    const token = await getAuthCookie(env);
    const repo = `ci-noconfig-${Date.now()}`;
    await seedRepo(env, repo);

    const before = await getRepoConfigRecord(env, OWNER, repo, 'github');
    const response = await app.request(buildUrl(repo, 'github'), { method: 'POST', headers: writeHeaders(token) }, env);
    expect(response.status).toBe(200);
    const after = await getRepoConfigRecord(env, OWNER, repo, 'github');

    // `updated_at` is the observable the omitted config-write tail would have moved. If a future edit
    // copies `upsertRepoConfig` + `invalidateRepoConfigCache` back in, an operator action starts
    // looking like a config edit to every downstream reader and this assertion fails.
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after!.parsedJson).toEqual(before!.parsedJson);
  });
});
