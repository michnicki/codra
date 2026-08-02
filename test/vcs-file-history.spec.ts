import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient } from '@server/core/bitbucket';
import { createTestEnv, seedInstallationToken } from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';
import { installBitbucketFetchMock } from './bitbucket-fetch-mock';

const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUMBER = 42;
const INSTALLATION_ID = '123456';

function buildGitHubFixtures(overrides: Partial<Parameters<typeof installGitHubFetchMock>[0]> = {}) {
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
    diff: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ...overrides,
  };
}

// Bitbucket adapter is constructed with a stubbed client via the private-constructor shape,
// mirroring test/bitbucket-adapter.spec.ts (the credential-read path is covered elsewhere).
type AdapterHandle = {
  adapter: BitbucketAdapter;
  client: BitbucketClient;
  env: ReturnType<typeof createTestEnv>;
};

type BitbucketJobFixture = {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  headSha: string;
  installationId: null;
  repositoryVcsProvider: 'bitbucket';
  repositoryWorkspace: string;
};

function buildBitbucketAdapter(env: ReturnType<typeof createTestEnv> = createTestEnv()): AdapterHandle {
  const client = new BitbucketClient(env, 'test-token-bearer');
  const job: BitbucketJobFixture = {
    id: 'job-bb-1',
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    commitSha: 'head123',
    headSha: 'head123',
    installationId: null,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: OWNER,
  };
  const adapter = new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    job: BitbucketJobFixture,
    tracker?: { incrementSubrequests: ReturnType<typeof vi.fn> },
  ) => BitbucketAdapter)(env, client, job);
  return { adapter, client, env };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubAdapter.getFileHistory', () => {
  // CR-01 (34-REVIEW): this is the SHAPE GITHUB ACTUALLY RETURNS from the list-commits endpoint —
  // no `files[]`, no `stats`. The previous fixture fabricated `files` and so proved only that the
  // mapper works against a response GitHub never sends, hiding the hardcoded `filesAvailable: true`.
  it('reports filesAvailable: false when the list-commits response carries no files[] (real GitHub shape)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildGitHubFixtures({
        fileHistoryResponses: {
          body: [
            { sha: 'abc1234567890abcdef', commit: { message: 'fix: resolve race\n\nbody' } },
            { sha: 'def4567abcdef1234567', commit: { message: 'feat: add retry' } },
          ],
        },
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const history = await adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5);

      // filesAvailable MUST be false so buildFileHistoryBlock renders "(files list not available)"
      // instead of falsely claiming the commit touched only this file.
      expect(history).toEqual([
        { hash: 'abc1234', message: 'fix: resolve race', files: [], filesAvailable: false },
        { hash: 'def4567', message: 'feat: add retry', files: [], filesAvailable: false },
      ]);
    } finally {
      restore();
    }
  });

  // The manifest-present branch stays covered for the day a caller feeds this mapper a
  // single-commit / compare payload (which DO carry files[]); it is not the list-commits shape.
  it('reports filesAvailable: true and filters the queried path when a manifest IS present', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildGitHubFixtures({
        fileHistoryResponses: {
          body: [
            { sha: 'abc1234567890abcdef', commit: { message: 'fix: resolve race\n\nbody' }, files: [{ filename: 'src/main.ts' }, { filename: 'src/locks.ts' }] },
            { sha: 'def4567abcdef1234567', commit: { message: 'feat: add retry' }, files: [{ filename: 'src/main.ts' }] },
            { sha: 'ghi9012abcdef3456789', commit: { message: 'refactor: extract validator' }, files: [] },
          ],
        },
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const history = await adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5);

      expect(history).toEqual([
        { hash: 'abc1234', message: 'fix: resolve race', files: ['src/locks.ts'], filesAvailable: true },
        { hash: 'def4567', message: 'feat: add retry', files: [], filesAvailable: true },
        // An EMPTY manifest is still a manifest: the commit genuinely touched only this file.
        { hash: 'ghi9012', message: 'refactor: extract validator', files: [], filesAvailable: true },
      ]);
      // The queried path is excluded from every entry's other-files list.
      expect(history?.[0].files).not.toContain('src/main.ts');
    } finally {
      restore();
    }
  });

  it('returns empty array for a new file', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildGitHubFixtures({ fileHistoryResponses: { body: [] } }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const history = await adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5);
      expect(history).toEqual([]);
    } finally {
      restore();
    }
  });

  it('throws on non-2xx response', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildGitHubFixtures({ fileHistoryResponses: { status: 500, body: { message: 'boom' } } }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5)).rejects.toThrow();
    } finally {
      restore();
    }
  });
});

describe('BitbucketAdapter.getFileHistory', () => {
  it('returns commit entries with empty files list', async () => {
    const mock = installBitbucketFetchMock({
      fileHistoryResponses: {
        body: {
          values: [
            { hash: 'abc1234567890abcdef', message: 'fix: resolve race\n\nbody' },
            { hash: 'def4567abcdef1234567', message: 'feat: add retry' },
          ],
        },
      },
    });
    const { adapter } = buildBitbucketAdapter();

    const history = await adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5);

    expect(history).toEqual([
      { hash: 'abc1234', message: 'fix: resolve race', files: [], filesAvailable: false },
      { hash: 'def4567', message: 'feat: add retry', files: [], filesAvailable: false },
    ]);
    // The commit-list endpoint is path-filtered via query params on the commits/{ref} path.
    expect(mock.calls[0].path).toBe(`/2.0/repositories/${OWNER}/${REPO}/commits/main?path=src/main.ts&pagelen=5`);
  });

  it('returns empty array for an empty values response', async () => {
    installBitbucketFetchMock({ fileHistoryResponses: { body: { values: [] } } });
    const { adapter } = buildBitbucketAdapter();

    const history = await adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5);

    expect(history).toEqual([]);
  });

  it('throws on non-2xx response', async () => {
    installBitbucketFetchMock({ fileHistoryResponses: { status: 500, body: { error: { message: 'boom' } } } });
    const { adapter } = buildBitbucketAdapter();

    await expect(adapter.getFileHistory?.(OWNER, REPO, 'src/main.ts', 'main', 5)).rejects.toThrow();
  });
});
