import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createApp } from '@server/app';
import { queryRows } from '@server/db/client';
import { getOrCreateRepository } from '@server/db/repositories';
import { discoverBitbucketWorkspaceInputSchema } from '@shared/bitbucket';
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
