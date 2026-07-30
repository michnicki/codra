import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createApp } from '@server/app';
import { queryRows } from '@server/db/client';
import { getOrCreateRepository } from '@server/db/repositories';
import { BitbucketClient } from '@server/core/bitbucket';
import { addBitbucketWorkspaceInputSchema, discoverBitbucketWorkspaceInputSchema } from '@shared/bitbucket';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// Phase 31 (WS-01, D-05): POST /api/repos/bitbucket/workspaces/discover -- the tracer slice's
// read-only discover endpoint. Mirrors test/add-bitbucket-repo.spec.ts's session/CSRF harness.

function mockGitHubProfile(login = 'devarshishimpi') {
  return {
    id: 42,
    login,
    name: 'Devarshi Shimpi',
    avatar_url: 'https://avatars.githubusercontent.com/u/42',
    email: null,
  };
}

async function getAuthCookie(app: ReturnType<typeof createApp>, env: ReturnType<typeof createTestEnv>, login = 'devarshishimpi') {
  const originalFetch = globalThis.fetch;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'oauth-access-token' });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json(mockGitHubProfile(login));
    }
    return originalFetch(input, init);
  });

  const authStart = await app.request('/auth/github', {}, env);
  const authLocation = authStart.headers.get('location');
  const state = authLocation ? new URL(authLocation).searchParams.get('state') : null;

  const stateCookie = (authStart.headers.get('set-cookie') || '').match(/codra_oauth_state=[^;]+/)?.[0] ?? '';
  const callback = await app.request(`/auth/github/callback?code=test-code&state=${state}`, { headers: { cookie: stateCookie } }, env);
  const cookieHeader = callback.headers.get('set-cookie') || '';
  const match = cookieHeader.match(/codra_session=([^;]+)/);
  return match ? match[1] : '';
}

/**
 * Installs a fetch mock scoped to the workspace-discovery endpoint's own upstream call:
 * `GET https://api.bitbucket.org/2.0/repositories/{workspace}...`. Pages are served in order from
 * `pages`; anything else (there should be nothing else once `getAuthCookie` has already run) throws
 * loudly rather than silently returning an unrelated fixture.
 */
function mockBitbucketWorkspaceRepos(pages: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const queue = [...pages];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (!url.startsWith('https://api.bitbucket.org/2.0/repositories/')) {
      throw new Error(`Unexpected fetch in workspace-discover test: ${url}`);
    }
    const page = queue.shift();
    if (!page) {
      throw new Error('No more scripted Bitbucket workspace-repos pages');
    }
    const status = page.status ?? 200;
    return new Response(JSON.stringify(page.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json', ...page.headers },
    });
  });
}

async function authedPost(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createTestEnv>,
  cookie: string,
  body: unknown,
  withCsrf = true,
) {
  return app.request(
    '/api/repos/bitbucket/workspaces/discover',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `codra_session=${cookie}`,
        ...(withCsrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

dbDescribe('POST /api/repos/bitbucket/workspaces/discover -- WS-01 tracer slice (D-04/D-05)', () => {
  const env = createTestEnv();
  const app = createApp();
  const WORKSPACE = 'ws-discover-acme';

  async function deleteWorkspaceRows() {
    await queryRows(env, `DELETE FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1`, [WORKSPACE]);
  }

  beforeAll(async () => {
    await deleteWorkspaceRows();
  });

  afterAll(async () => {
    await deleteWorkspaceRows();
  });

  it('rejects a request without a session cookie (401)', async () => {
    const res = await app.request(
      '/api/repos/bitbucket/workspaces/discover',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: JSON.stringify({ workspace: WORKSPACE, accessToken: 'tok' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a valid session without the x-requested-with CSRF header (403)', async () => {
    const cookie = await getAuthCookie(app, env);
    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE, accessToken: 'tok' }, false);
    expect(res.status).toBe(403);
  });

  it('rejects a body that fails Zod strict parse -- missing accessToken (400)', async () => {
    expect(discoverBitbucketWorkspaceInputSchema.safeParse({ workspace: WORKSPACE }).success).toBe(false);

    const cookie = await getAuthCookie(app, env);
    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE });
    expect(res.status).toBe(400);
    const json = (await res.json()) as unknown;
    expect(JSON.stringify(json)).toContain('Invalid Bitbucket workspace discovery payload.');
  });

  it('returns discovered repos, computes alreadyOnboarded, and writes zero rows (D-05)', async () => {
    const cookie = await getAuthCookie(app, env);
    mockBitbucketWorkspaceRepos([
      { body: { values: [{ slug: 'repo-a', name: 'Repo A' }, { slug: 'repo-b', name: 'Repo B' }] } },
    ]);

    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE, accessToken: 'tok' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { repos: Array<{ slug: string; name: string; alreadyOnboarded: boolean }> };
    expect(json.repos).toEqual([
      { slug: 'repo-a', name: 'Repo A', alreadyOnboarded: false },
      { slug: 'repo-b', name: 'Repo B', alreadyOnboarded: false },
    ]);

    const rows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [WORKSPACE],
    );
    expect(rows[0].count).toBe('0');
  });

  it('annotates a repo already present in `repositories` as alreadyOnboarded: true (D-04)', async () => {
    await getOrCreateRepository(env, {
      installationId: null,
      vcsProvider: 'bitbucket',
      owner: WORKSPACE,
      repo: 'repo-already-added',
      workspace: WORKSPACE,
    });

    const cookie = await getAuthCookie(app, env);
    mockBitbucketWorkspaceRepos([
      { body: { values: [{ slug: 'repo-already-added', name: 'Already Added' }, { slug: 'repo-new', name: 'New Repo' }] } },
    ]);

    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE, accessToken: 'tok' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { repos: Array<{ slug: string; alreadyOnboarded: boolean }> };
    expect(json.repos).toEqual(
      expect.arrayContaining([
        { slug: 'repo-already-added', name: 'Already Added', alreadyOnboarded: true },
        { slug: 'repo-new', name: 'New Repo', alreadyOnboarded: false },
      ]),
    );
  });

  it('annotates a mixed-case Bitbucket-returned slug against the stored lowercase row (Antigravity review finding)', async () => {
    await getOrCreateRepository(env, {
      installationId: null,
      vcsProvider: 'bitbucket',
      owner: WORKSPACE,
      repo: 'my-repo',
      workspace: WORKSPACE,
    });

    const cookie = await getAuthCookie(app, env);
    mockBitbucketWorkspaceRepos([
      { body: { values: [{ slug: 'My-Repo', name: 'My Repo' }] } },
    ]);

    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE, accessToken: 'tok' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { repos: Array<{ slug: string; alreadyOnboarded: boolean }> };
    expect(json.repos).toEqual([{ slug: 'My-Repo', name: 'My Repo', alreadyOnboarded: true }]);
  });

  it('a discover call against a workspace with zero repos returns { repos: [] }', async () => {
    const cookie = await getAuthCookie(app, env);
    mockBitbucketWorkspaceRepos([{ body: { values: [] } }]);

    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE, accessToken: 'tok' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { repos: unknown[] };
    expect(json.repos).toEqual([]);
  });

  it('a client throw mid-pagination returns a non-200 JSON error, never a partial repos array', async () => {
    const cookie = await getAuthCookie(app, env);
    const nextUrl = `https://api.bitbucket.org/2.0/repositories/${WORKSPACE}?pagelen=100&page=2`;
    mockBitbucketWorkspaceRepos([
      { body: { values: [{ slug: 'repo-a', name: 'Repo A' }], next: nextUrl } },
      { status: 400, body: { error: { message: 'Bad request' } } },
    ]);

    const res = await authedPost(app, env, cookie, { workspace: WORKSPACE, accessToken: 'tok' });
    expect(res.status).not.toBe(200);
    const json = (await res.json()) as { error?: string; repos?: unknown };
    expect(json.repos).toBeUndefined();
  });
});

// Phase 31 (WS-01, D-06/D-07): POST /api/repos/bitbucket/workspaces -- the transactional finalize
// endpoint. Extends this file per the plan's file list, reusing the discover suite's auth/CSRF
// harness. BitbucketClient.prototype.listWorkspaceWebhooks/createWorkspaceWebhook are mocked via
// vi.spyOn rather than hitting a real Bitbucket API.
async function authedFinalizePost(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createTestEnv>,
  cookie: string,
  body: unknown,
  withCsrf = true,
) {
  return app.request(
    '/api/repos/bitbucket/workspaces',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `codra_session=${cookie}`,
        ...(withCsrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

dbDescribe('POST /api/repos/bitbucket/workspaces -- WS-01 finalize endpoint (D-06/D-07)', () => {
  const env = createTestEnv();
  const app = createApp();
  const WEBHOOK_URL = 'http://localhost/webhook/bitbucket';

  async function deleteWorkspaceIdentity(workspace: string) {
    await queryRows(env, `DELETE FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1`, [workspace]);
    await queryRows(env, `DELETE FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1`, [workspace]);
  }

  const WORKSPACES = [
    'ws-finalize-1',
    'ws-finalize-2',
    'ws-finalize-3',
    'ws-finalize-4',
    'ws-finalize-5',
    'ws-finalize-6',
    'ws-finalize-7',
  ];

  beforeAll(async () => {
    for (const workspace of WORKSPACES) await deleteWorkspaceIdentity(workspace);
  });

  afterEach(() => {
    // `vi.spyOn` on an ALREADY-spied method returns the SAME mock instance (with its accumulated
    // `.mock.calls` history) rather than a fresh one -- restore after every test so each test's
    // spy/call-count assertions are scoped to that test alone, not the whole describe block.
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const workspace of WORKSPACES) await deleteWorkspaceIdentity(workspace);
  });

  function mockNoMatchingHook() {
    vi.spyOn(BitbucketClient.prototype, 'listWorkspaceWebhooks').mockResolvedValue([]);
    vi.spyOn(BitbucketClient.prototype, 'createWorkspaceWebhook').mockResolvedValue({ uuid: '{new-hook}' });
  }

  it('Test 1: a valid finalize payload with 2 selected repo slugs creates exactly 1 credential row and 2 repositories rows', async () => {
    const workspace = 'ws-finalize-1';
    mockNoMatchingHook();
    const cookie = await getAuthCookie(app, env);

    const res = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok',
      webhookSecret: 'whsec',
      selectedRepoSlugs: ['repo-a', 'repo-b'],
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { credential: unknown; repositoryCount: number };
    expect(json.repositoryCount).toBe(2);

    const credRows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(credRows[0].count).toBe('1');

    const repoRows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(repoRows[0].count).toBe('2');
  });

  it('Test 2: a repo slug not present in selectedRepoSlugs never gets a repositories row', async () => {
    const workspace = 'ws-finalize-2';
    mockNoMatchingHook();
    const cookie = await getAuthCookie(app, env);

    const res = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok',
      webhookSecret: 'whsec',
      selectedRepoSlugs: ['repo-selected'],
    });
    expect(res.status).toBe(201);

    const rows = await queryRows<{ repo: string }>(
      env,
      `SELECT repo FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(rows.map((r) => r.repo)).toEqual(['repo-selected']);
    expect(rows.map((r) => r.repo)).not.toContain('repo-not-selected');
  });

  it('Test 3: createWorkspaceWebhook is skipped when a matching-URL hook already exists', async () => {
    const workspace = 'ws-finalize-3';
    vi.spyOn(BitbucketClient.prototype, 'listWorkspaceWebhooks').mockResolvedValue([
      { uuid: '{existing-hook}', url: WEBHOOK_URL },
    ]);
    const createSpy = vi.spyOn(BitbucketClient.prototype, 'createWorkspaceWebhook').mockResolvedValue({ uuid: '{new-hook}' });
    const cookie = await getAuthCookie(app, env);

    const res = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok',
      webhookSecret: 'whsec',
      selectedRepoSlugs: ['repo-a'],
    });
    expect(res.status).toBe(201);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('Test 4: resubmitting the SAME workspace with [already-onboarded, new] results in 1 credential row and exactly 1 additional repositories row', async () => {
    const workspace = 'ws-finalize-4';
    mockNoMatchingHook();
    const cookie = await getAuthCookie(app, env);

    const firstRes = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok',
      webhookSecret: 'whsec',
      selectedRepoSlugs: ['repo-existing'],
    });
    expect(firstRes.status).toBe(201);

    const secondRes = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok-rotated',
      webhookSecret: 'whsec-rotated',
      selectedRepoSlugs: ['repo-existing', 'repo-new'],
    });
    expect(secondRes.status).toBe(201);

    const credRows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(credRows[0].count).toBe('1');

    const repoRows = await queryRows<{ repo: string }>(
      env,
      `SELECT repo FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1 ORDER BY repo`,
      [workspace],
    );
    expect(repoRows.map((r) => r.repo)).toEqual(['repo-existing', 'repo-new']);
  });

  it('Test 5: selectedRepoSlugs: [] is rejected 400 by schema validation before any DB write or Bitbucket call', async () => {
    const workspace = 'ws-finalize-5';
    expect(
      addBitbucketWorkspaceInputSchema.safeParse({
        workspace,
        accessToken: 'tok',
        webhookSecret: 'whsec',
        selectedRepoSlugs: [],
      }).success,
    ).toBe(false);

    const listSpy = vi.spyOn(BitbucketClient.prototype, 'listWorkspaceWebhooks');
    const cookie = await getAuthCookie(app, env);

    const res = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok',
      webhookSecret: 'whsec',
      selectedRepoSlugs: [],
    });
    expect(res.status).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();

    const credRows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(credRows[0].count).toBe('0');
  });

  it('Test 6 (concurrency): two simultaneous finalize requests for the SAME never-before-added workspace never duplicate the credential row', async () => {
    const workspace = 'ws-finalize-6';
    mockNoMatchingHook();
    const cookie = await getAuthCookie(app, env);

    const [firstRes, secondRes] = await Promise.all([
      authedFinalizePost(app, env, cookie, {
        workspace,
        accessToken: 'tok-a',
        webhookSecret: 'whsec-a',
        selectedRepoSlugs: ['repo-a'],
      }),
      authedFinalizePost(app, env, cookie, {
        workspace,
        accessToken: 'tok-b',
        webhookSecret: 'whsec-b',
        selectedRepoSlugs: ['repo-b'],
      }),
    ]);
    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);

    // The comparison is done IN SQL (not via JS `Date.getTime()`, which truncates to millisecond
    // precision and can falsely report equality for two timestamptz values that differ only at
    // the microsecond level) -- `updated_at > created_at` is evaluated by Postgres itself, at full
    // native precision, on the SAME row.
    const rows = await queryRows<{ count: string; updated_after_created: boolean }>(
      env,
      `SELECT count(*)::text AS count, bool_and(updated_at > created_at) AS updated_after_created
       FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(rows[0].count).toBe('1');
    // The row-count assertion alone proves the UNIQUE(vcs_provider, workspace) constraint
    // prevented a duplicate INSERT. This second assertion proves the SECOND call's
    // ON CONFLICT DO UPDATE branch genuinely executed (rather than the test harness accidentally
    // serializing the two calls such that the second one no-ops).
    expect(rows[0].updated_after_created).toBe(true);
  });

  it('Test 7: a webhook-creation failure after the transaction commits returns a distinct 502, with credential/repos rows confirmed present', async () => {
    const workspace = 'ws-finalize-7';
    vi.spyOn(BitbucketClient.prototype, 'listWorkspaceWebhooks').mockResolvedValue([]);
    vi.spyOn(BitbucketClient.prototype, 'createWorkspaceWebhook').mockRejectedValueOnce(new Error('network blip'));
    const cookie = await getAuthCookie(app, env);

    const res = await authedFinalizePost(app, env, cookie, {
      workspace,
      accessToken: 'tok',
      webhookSecret: 'whsec',
      selectedRepoSlugs: ['repo-a'],
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain('credential and repositories were saved');
    expect(json.error).toContain('Resubmit this form');
    expect(json.error).not.toContain('Failed to add Bitbucket workspace.');

    const credRows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(credRows[0].count).toBe('1');

    const repoRows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1`,
      [workspace],
    );
    expect(repoRows[0].count).toBe('1');
  });
});
