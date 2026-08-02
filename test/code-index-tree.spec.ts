import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient, BitbucketError } from '@server/core/bitbucket';
import { GitHubError } from '@server/core/github';
import { createTestEnv, seedInstallationToken } from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';
import { installBitbucketFetchMock, type BitbucketMockResponse } from './bitbucket-fetch-mock';

/**
 * QA-IDX-01 (D-09) — `listDefaultBranchTree` on BOTH adapters (NREG-02).
 *
 * No database is touched; both adapters are driven through their existing fetch mocks so the REAL
 * client code (core/github.ts `getTree`, core/bitbucket.ts `listSrcTree`) executes. The Bitbucket
 * half additionally pins the three security-relevant properties of the `/src` walk that the threat
 * register names: off-origin `next` rejection (T-29-03-01), the cycle guard, and the page cap's
 * partial-listing disposition (T-29-03-02).
 */

const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUMBER = 42;
const INSTALLATION_ID = '123456';

const WORKSPACE = 'acme';
const BB_REPO = 'backend';
const BB_BRANCH = 'main';
const BB_COMMIT_SHA = 'bbcommitsha0123456789';

function githubFixtures(overrides: Record<string, unknown> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    pull: {
      number: PR_NUMBER,
      title: 'Test PR',
      body: 'Test body',
      draft: false,
      head: { sha: 'headsha1234567890', ref: 'feature-branch' },
      base: { sha: 'basesha1234567890', ref: 'main' },
      user: { login: 'author-login' },
    },
    diff: '',
    ...overrides,
  } as Parameters<typeof installGitHubFetchMock>[0];
}

async function buildGithubAdapter() {
  const env = createTestEnv();
  await seedInstallationToken(env, INSTALLATION_ID);
  return new GithubAdapter(env, INSTALLATION_ID);
}

/**
 * The Bitbucket walk's request order is deterministic: repository metadata, branch ref, then one
 * page per `/src` request. `installBitbucketFetchMock` consumes `responseSequence` strictly in call
 * order and BEFORE any route matching, so scripting the sequence is what gives a spec control over
 * the page shape (the mock's default `/src/` route returns raw text for the file-content primitive,
 * which is not JSON and would not survive the tree walk's parse).
 */
function bitbucketSequence(pages: Array<BitbucketMockResponse | ((call: { path: string }) => BitbucketMockResponse)>) {
  return [
    { body: { mainbranch: { name: BB_BRANCH } } },
    { body: { target: { hash: BB_COMMIT_SHA } } },
    ...pages,
  ];
}

function buildBitbucketAdapter(tracker?: { incrementSubrequests: (n?: number) => void; hasRemainingSafeBudget?: (n?: number) => boolean }) {
  const env = createTestEnv();
  const resolvedTracker = tracker ?? { incrementSubrequests: vi.fn() };
  const client = new BitbucketClient(env, 'test-token-bearer', resolvedTracker);
  const job = {
    id: 'job-index-tree-1',
    owner: WORKSPACE,
    repo: BB_REPO,
    prNumber: 7,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: WORKSPACE,
  };
  const adapter = new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    jobArg: typeof job,
    trackerArg: typeof resolvedTracker,
  ) => BitbucketAdapter)(env, client, job, resolvedTracker);
  return { adapter, client, env };
}

function srcPageUrl(page: number) {
  return `https://api.bitbucket.org/2.0/repositories/${WORKSPACE}/${BB_REPO}/src/${BB_BRANCH}/?page=${page}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GithubAdapter.listDefaultBranchTree (QA-IDX-01, D-09)', () => {
  it('returns ONLY blob paths — directory (tree) and submodule (commit) entries are dropped', async () => {
    const { restore, calls } = installGitHubFetchMock(
      githubFixtures({
        repositoryResponse: { body: { default_branch: 'trunk' } },
        branchResponse: { body: { commit: { sha: 'ghcommitsha0123456789' } } },
        treeResponse: {
          truncated: false,
          tree: [
            { path: 'src', type: 'tree' },
            { path: 'src/server/core/auth.ts', type: 'blob' },
            { path: 'vendor/submodule', type: 'commit' },
            { path: 'README.md', type: 'blob' },
          ],
        },
      }),
    );

    try {
      const adapter = await buildGithubAdapter();
      const listing = await adapter.listDefaultBranchTree(OWNER, REPO);

      expect(listing.paths).toEqual(['src/server/core/auth.ts', 'README.md']);
      expect(listing.paths).not.toContain('src');
      expect(listing.paths).not.toContain('vendor/submodule');
      // ref is the resolved default branch; sha is the branch head COMMIT, never the tree sha.
      expect(listing.ref).toBe('trunk');
      expect(listing.sha).toBe('ghcommitsha0123456789');
      expect(listing.truncated).toBe(false);

      // The tree read is recursive — one call, not a per-directory walk.
      const treeCall = calls.find((call) => call.path.includes('/git/trees/'));
      expect(treeCall).toBeDefined();
      expect(treeCall?.search).toContain('recursive=1');
      expect(treeCall?.path).toContain('/git/trees/trunk');
    } finally {
      restore();
    }
  });

  it('surfaces a recursive-tree truncated:true response as truncated (never swallowed)', async () => {
    const { restore } = installGitHubFetchMock(
      githubFixtures({
        repositoryResponse: { body: { default_branch: 'main' } },
        branchResponse: { body: { commit: { sha: 'ghcommitsha0123456789' } } },
        treeResponse: {
          truncated: true,
          tree: [{ path: 'src/a.ts', type: 'blob' }],
        },
      }),
    );

    try {
      const adapter = await buildGithubAdapter();
      const listing = await adapter.listDefaultBranchTree(OWNER, REPO);
      expect(listing.truncated).toBe(true);
      // The prefix is still returned and usable — truncation is a disclosure, not a failure.
      expect(listing.paths).toEqual(['src/a.ts']);
    } finally {
      restore();
    }
  });

  it('falls back to master_branch when default_branch is absent', async () => {
    const { restore } = installGitHubFetchMock(
      githubFixtures({
        repositoryResponse: { body: { master_branch: 'master' } },
        branchResponse: { body: { commit: { sha: 'ghcommitsha0123456789' } } },
        treeResponse: { tree: [{ path: 'src/a.ts', type: 'blob' }] },
      }),
    );

    try {
      const adapter = await buildGithubAdapter();
      const listing = await adapter.listDefaultBranchTree(OWNER, REPO);
      expect(listing.ref).toBe('master');
    } finally {
      restore();
    }
  });

  it('THROWS when the repository reports neither default_branch nor master_branch (never guesses a branch)', async () => {
    const { restore, calls } = installGitHubFetchMock(
      githubFixtures({
        repositoryResponse: { body: {} },
        branchResponse: { body: { commit: { sha: 'ghcommitsha0123456789' } } },
        treeResponse: { tree: [{ path: 'src/a.ts', type: 'blob' }] },
      }),
    );

    try {
      const adapter = await buildGithubAdapter();
      await expect(adapter.listDefaultBranchTree(OWNER, REPO)).rejects.toThrow(/no default branch/i);
      await expect(adapter.listDefaultBranchTree(OWNER, REPO)).rejects.toBeInstanceOf(GitHubError);
      // No tree read was attempted: guessing 'main' would index a branch the operator did not choose.
      expect(calls.some((call) => call.path.includes('/git/trees/'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('THROWS when the branch read reports no head commit sha (a tree sha is not an acceptable substitute)', async () => {
    const { restore } = installGitHubFetchMock(
      githubFixtures({
        repositoryResponse: { body: { default_branch: 'main' } },
        branchResponse: { body: {} },
        treeResponse: { sha: 'treesha999', tree: [{ path: 'src/a.ts', type: 'blob' }] },
      }),
    );

    try {
      const adapter = await buildGithubAdapter();
      await expect(adapter.listDefaultBranchTree(OWNER, REPO)).rejects.toThrow(/no head commit sha/i);
    } finally {
      restore();
    }
  });
});

describe('BitbucketAdapter.listDefaultBranchTree (QA-IDX-01, D-09)', () => {
  it('unions both pages of a two-page /src listing and drops commit_directory entries', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: bitbucketSequence([
        {
          body: {
            values: [
              { path: 'src/a.ts', type: 'commit_file' },
              { path: 'src/sub', type: 'commit_directory' },
            ],
            next: srcPageUrl(2),
          },
        },
        {
          body: {
            values: [
              { path: 'src/b.ts', type: 'commit_file' },
              // A child of src/sub IS returned by the depth-limited response, so that directory needs
              // no follow-up request.
              { path: 'src/sub/c.ts', type: 'commit_file' },
            ],
          },
        },
      ]),
    });

    try {
      const { adapter } = buildBitbucketAdapter();
      const listing = await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);

      expect(listing.paths).toEqual(['src/a.ts', 'src/b.ts', 'src/sub/c.ts']);
      expect(listing.paths).not.toContain('src/sub');
      expect(listing.ref).toBe(BB_BRANCH);
      expect(listing.sha).toBe(BB_COMMIT_SHA);
      expect(listing.truncated).toBe(false);

      // The FIRST /src url is built locally: it carries max_depth + pagelen and the segment-encoded ref.
      const firstSrcCall = mock.calls.find((call) => call.path.includes('/src/'));
      expect(firstSrcCall?.path).toContain(`/src/${BB_BRANCH}/`);
      expect(firstSrcCall?.path).toContain('max_depth=');
      expect(firstSrcCall?.path).toContain('pagelen=100');
    } finally {
      mock.restore();
    }
  });

  it('walks a commit_directory whose contents the depth-limited response did NOT return', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: bitbucketSequence([
        // Root page: one directory, no children returned -> must be enqueued or its subtree vanishes.
        { body: { values: [{ path: 'deep', type: 'commit_directory' }] } },
        { body: { values: [{ path: 'deep/x.ts', type: 'commit_file' }] } },
      ]),
    });

    try {
      const { adapter } = buildBitbucketAdapter();
      const listing = await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);

      expect(listing.paths).toEqual(['deep/x.ts']);
      expect(listing.truncated).toBe(false);
      const srcCalls = mock.calls.filter((call) => call.path.includes('/src/'));
      expect(srcCalls).toHaveLength(2);
      // The second request is a LOCALLY built directory url, not a server-supplied next link.
      expect(srcCalls[1].path).toContain(`/src/${BB_BRANCH}/deep?max_depth=`);
    } finally {
      mock.restore();
    }
  });

  it('REJECTS an off-origin next URL and fails the walk rather than following it (T-29-03-01)', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: bitbucketSequence([
        {
          body: {
            values: [{ path: 'src/a.ts', type: 'commit_file' }],
            next: 'https://evil.example.com/2.0/repositories/acme/backend/src/main/',
          },
        },
      ]),
    });

    try {
      const { adapter } = buildBitbucketAdapter();
      // ONE invocation only — `responseSequence` is consumed per call, so a second attempt would
      // assert against an exhausted script rather than against the guard.
      let thrown: unknown;
      try {
        await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BitbucketError);
      expect((thrown as BitbucketError).status).toBe(502);
      expect((thrown as Error).message).toMatch(/SSRF validation/i);
      // The off-origin host was never contacted.
      expect(mock.calls.some((call) => call.url.includes('evil.example.com'))).toBe(false);
    } finally {
      mock.restore();
    }
  });

  it('treats an already-seen next URL as a cycle and STOPS instead of looping', async () => {
    const cyclicUrl = srcPageUrl(2);
    const mock = installBitbucketFetchMock({
      responseSequence: bitbucketSequence([
        { body: { values: [{ path: 'src/a.ts', type: 'commit_file' }], next: cyclicUrl } },
        // The server hands back the SAME link it just served.
        { body: { values: [{ path: 'src/b.ts', type: 'commit_file' }], next: cyclicUrl } },
      ]),
    });

    try {
      const { adapter } = buildBitbucketAdapter();
      const listing = await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);

      // Two pages were fetched, then the repeat link stopped the walk. The listing is incomplete,
      // so it is FLAGGED rather than presented as the whole tree.
      expect(listing.paths).toEqual(['src/a.ts', 'src/b.ts']);
      expect(listing.truncated).toBe(true);
      expect(mock.calls.filter((call) => call.path.includes('/src/'))).toHaveLength(2);
    } finally {
      mock.restore();
    }
  });

  it('returns the paths collected so far with truncated:true when the page cap is reached (never throws)', async () => {
    const maxPages = BitbucketClient.MAX_SRC_TREE_PAGES;
    // Every page advertises a DISTINCT next link, so only the cap can stop the walk.
    const pages = Array.from({ length: maxPages + 2 }, (_, index) => ({
      body: {
        values: [{ path: `src/file-${index}.ts`, type: 'commit_file' }],
        next: srcPageUrl(index + 2),
      },
    }));
    const mock = installBitbucketFetchMock({ responseSequence: bitbucketSequence(pages) });

    try {
      const { adapter } = buildBitbucketAdapter();
      const listing = await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);

      expect(listing.truncated).toBe(true);
      // The DIVERGENCE from the thread-list template: a partial tree is returned, not thrown away.
      expect(listing.paths.length).toBe(maxPages);
      expect(listing.paths[0]).toBe('src/file-0.ts');
      expect(mock.calls.filter((call) => call.path.includes('/src/'))).toHaveLength(maxPages);
    } finally {
      mock.restore();
    }
  });

  it('stops with a flagged partial listing when the live subrequest budget is exhausted (T-29-03-02)', async () => {
    let remaining = 2;
    const tracker = {
      incrementSubrequests: vi.fn(),
      hasRemainingSafeBudget: vi.fn(() => remaining-- > 0),
    };
    const mock = installBitbucketFetchMock({
      responseSequence: bitbucketSequence([
        { body: { values: [{ path: 'src/a.ts', type: 'commit_file' }], next: srcPageUrl(2) } },
        { body: { values: [{ path: 'src/b.ts', type: 'commit_file' }], next: srcPageUrl(3) } },
        { body: { values: [{ path: 'src/c.ts', type: 'commit_file' }] } },
      ]),
    });

    try {
      const { adapter } = buildBitbucketAdapter(tracker);
      const listing = await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);

      expect(tracker.hasRemainingSafeBudget).toHaveBeenCalled();
      expect(listing.paths).toEqual(['src/a.ts', 'src/b.ts']);
      expect(listing.truncated).toBe(true);
      expect(mock.calls.filter((call) => call.path.includes('/src/'))).toHaveLength(2);
    } finally {
      mock.restore();
    }
  });

  it('retries a max_depth request at a SMALLER depth on HTTP 555 rather than failing the build', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: bitbucketSequence([
        // The community-reported max_depth timeout status.
        { status: 555, body: { error: { message: 'timeout' } } },
        { body: { values: [{ path: 'src/a.ts', type: 'commit_file' }] } },
      ]),
    });

    try {
      const { adapter } = buildBitbucketAdapter();
      const listing = await adapter.listDefaultBranchTree(WORKSPACE, BB_REPO);

      expect(listing.paths).toEqual(['src/a.ts']);
      expect(listing.truncated).toBe(false);

      const srcCalls = mock.calls.filter((call) => call.path.includes('/src/'));
      expect(srcCalls).toHaveLength(2);
      const firstDepth = Number(/max_depth=(\d+)/.exec(srcCalls[0].path)?.[1]);
      const retryDepth = Number(/max_depth=(\d+)/.exec(srcCalls[1].path)?.[1]);
      expect(retryDepth).toBeLessThan(firstDepth);
    } finally {
      mock.restore();
    }
  });

  it('THROWS when the repository reports no mainbranch name (symmetric with GitHub — never guesses)', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: [{ body: {} }],
    });

    try {
      const { adapter } = buildBitbucketAdapter();
      await expect(adapter.listDefaultBranchTree(WORKSPACE, BB_REPO)).rejects.toThrow(/no mainbranch name/i);
      // No /src walk was started.
      expect(mock.calls.some((call) => call.path.includes('/src/'))).toBe(false);
    } finally {
      mock.restore();
    }
  });
});

describe('NREG-02: listDefaultBranchTree exists on BOTH adapters with no capability flag', () => {
  it('both adapters expose listDefaultBranchTree as a callable function', async () => {
    const github = await buildGithubAdapter();
    const { adapter: bitbucket } = buildBitbucketAdapter();
    expect(typeof (github as unknown as Record<string, unknown>).listDefaultBranchTree).toBe('function');
    expect(typeof (bitbucket as unknown as Record<string, unknown>).listDefaultBranchTree).toBe('function');
  });

  it('neither adapter advertises a tree-listing capability flag (the providers differ only in cost)', async () => {
    const github = await buildGithubAdapter();
    const { adapter: bitbucket } = buildBitbucketAdapter();
    for (const capabilities of [github.capabilities, bitbucket.capabilities]) {
      expect(Object.keys(capabilities).sort()).toEqual([
        'supportsMermaid',
        'supportsThreadListing',
        'supportsThreadResolution',
      ]);
    }
  });
});
