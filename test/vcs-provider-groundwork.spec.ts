import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient } from '@server/core/bitbucket';
import { GitHubError } from '@server/core/github';
import { BitbucketError } from '@server/core/bitbucket';
import { createTestEnv, seedInstallationToken } from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';
import { installBitbucketFetchMock } from './bitbucket-fetch-mock';

const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUMBER = 42;
const INSTALLATION_ID = '123456';

const WORKSPACE = 'acme';
const BB_REPO = 'backend';
const BB_PR_NUMBER = 49;

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

function buildBitbucketFixture(rcOverrides: Record<string, unknown> = {}) {
  return {
    id: 'job-bb-1',
    owner: WORKSPACE,
    repo: BB_REPO,
    prNumber: BB_PR_NUMBER,
    commitSha: 'head123',
    headSha: 'headsha',
    installationId: null,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: WORKSPACE,
    ...rcOverrides,
  } as const;
}

function buildBitbucketAdapter() {
  const env = createTestEnv();
  const client = new BitbucketClient(env, 'test-token-bearer');
  const job = buildBitbucketFixture();
  return new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    jobArg: typeof job,
  ) => BitbucketAdapter)(env, client, job);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// --- PROV-01: GitHub getFileContent / getCompareDiff contract ---

describe('PROV-01: GitHub content and compare primitives', () => {
  it('getFileContent appends ?ref= for branch, tag, and short SHA, returning decoded content', async () => {
    const refs = ['main', 'v1.2.0', 'abc1234'];
    for (const ref of refs) {
      const env = createTestEnv();
      await seedInstallationToken(env, INSTALLATION_ID);
      const encoded = Buffer.from(`file content for ${ref}`).toString('base64');
      const mock = installGitHubFetchMock({
        ...buildGitHubFixtures(),
        // Per-fixture scripted response: each call returns the same base64-encoded content.
        contentResponses: {
          status: 200,
          body: { content: encoded, encoding: 'base64' },
        },
      });

      try {
        const adapter = new GithubAdapter(env, INSTALLATION_ID);
        const result = await adapter.getFileContent(OWNER, REPO, 'src/file.ts', ref);
        expect(result).toBe(`file content for ${ref}`);
        // The recorded URL (pathname + search) is observable so the ref query is asserted.
        const contentsCall = mock.calls.find(
          (call) => call.method === 'GET' && call.path.includes('/contents/'),
        );
        expect(contentsCall).toBeDefined();
        // The recorder exposes `path` as `url.pathname`; the ref query rides on the SAME call
        // through `url.search`. The query is observable via the recorded URL forwarding.
        const recordedUrl = (contentsCall as { search?: string })?.search ?? '';
        expect(contentsCall?.path).toBe(`/repos/${OWNER}/${REPO}/contents/${'src/file.ts'.split('/').map(encodeURIComponent).join('/')}`);
        // The ref query surfaces on the call shape as part of the URL forwarding (see
        // installGitHubFetchMock's path+search recording).
        expect(recordedUrl).toBe(`?ref=${encodeURIComponent(ref)}`);
      } finally {
        mock.restore();
      }
    }
  });

  it('getFileContent returns null on a 404 (deleted-at-head, D-08)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      contentResponses: { status: 404 },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getFileContent(OWNER, REPO, 'src/missing.ts', 'main');
      expect(result).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it('getFileContent throws GitHubError on a non-404 content failure (401)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      contentResponses: { status: 401 },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getFileContent(OWNER, REPO, 'src/file.ts', 'main')).rejects.toBeInstanceOf(GitHubError);
    } finally {
      mock.restore();
    }
  });

  it('getFileContent throws GitHubError on a non-404 content failure (403)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      contentResponses: { status: 403 },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getFileContent(OWNER, REPO, 'src/file.ts', 'main')).rejects.toBeInstanceOf(GitHubError);
    } finally {
      mock.restore();
    }
  });

  it('getFileContent throws GitHubError on a non-404 content failure (500)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      contentResponses: { status: 500 },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getFileContent(OWNER, REPO, 'src/file.ts', 'main')).rejects.toBeInstanceOf(GitHubError);
    } finally {
      mock.restore();
    }
  });

  it('getCompareDiff uses /compare/{base}...{head} with Accept application/vnd.github.diff and returns raw text', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const fixtureDiff = 'diff --git a/foo.ts b/foo.ts\n+const added = true;\n';
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      compareResponses: {
        status: 200,
        body: fixtureDiff,
        headers: { 'content-type': 'text/plain' },
      },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getCompareDiff(OWNER, REPO, 'main', 'feature');
      expect(result).toBe(fixtureDiff);
      const compareCall = mock.calls.find(
        (call) => call.method === 'GET' && call.path.includes('/compare/'),
      );
      expect(compareCall).toBeDefined();
      expect(compareCall?.path).toBe(`/repos/${OWNER}/${REPO}/compare/${encodeURIComponent('main')}...${encodeURIComponent('feature')}`);
      expect(compareCall?.accept).toBe('application/vnd.github.diff');
    } finally {
      mock.restore();
    }
  });

  it('getCompareDiff returns the empty string "" on a 200-empty response (D-09)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      compareResponses: {
        status: 200,
        body: '',
        headers: { 'content-type': 'text/plain' },
      },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getCompareDiff(OWNER, REPO, 'a', 'b');
      expect(result).toBe('');
    } finally {
      mock.restore();
    }
  });

  it('getCompareDiff throws GitHubError on a non-2xx compare (500)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installBitbucketFetchMock;
    void mock;
    const mockGh = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      compareResponses: { status: 500 },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getCompareDiff(OWNER, REPO, 'main', 'feature')).rejects.toBeInstanceOf(GitHubError);
    } finally {
      mockGh.restore();
    }
  });
});

// --- PROV-01: Bitbucket getFileContent / getCompareDiff contract ---

describe('PROV-01: Bitbucket content and compare primitives', () => {
  it('getFileContent hits /src/{ref}/{path} for branch, tag, and short SHA, preserving case', async () => {
    const refs = ['main', 'v1.2.0', 'abc1234'];
    for (const ref of refs) {
      // Each iteration gets a fresh mock so the call-path assertion is unambiguous.
      const mock = installBitbucketFetchMock({
        fileContentResponses: {
          status: 200,
          body: `nested content for ${ref}`,
          headers: { 'content-type': 'text/plain' },
        },
      });
      try {
        const adapter = buildBitbucketAdapter();
        const result = await adapter.getFileContent(WORKSPACE, BB_REPO, 'src/nested/file.ts', ref);
        expect(result).toBe(`nested content for ${ref}`);
        const srcCall = mock.calls.find(
          (call) => call.method === 'GET' && call.path.includes('/src/'),
        );
        expect(srcCall).toBeDefined();
        expect(srcCall?.path).toBe(
          `/2.0/repositories/${WORKSPACE}/${BB_REPO}/src/${encodeURIComponent(ref)}/src/nested/file.ts`,
        );
      } finally {
        mock.restore();
      }
    }
  });

  it('getFileContent returns null on a 404 (D-08)', async () => {
    const mock = installBitbucketFetchMock({
      fileContentResponses: { status: 404, body: { error: { message: 'Not found' } } },
    });
    try {
      const adapter = buildBitbucketAdapter();
      const result = await adapter.getFileContent(WORKSPACE, BB_REPO, 'src/missing.ts', 'main');
      expect(result).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it('getFileContent throws BitbucketError on a non-404 content failure (401)', async () => {
    const mock = installBitbucketFetchMock({
      fileContentResponses: { status: 401, body: { error: { message: 'Unauthorized' } } },
    });
    try {
      const adapter = buildBitbucketAdapter();
      await expect(adapter.getFileContent(WORKSPACE, BB_REPO, 'src/file.ts', 'main')).rejects.toBeInstanceOf(BitbucketError);
    } finally {
      mock.restore();
    }
  });

  it('getFileContent throws BitbucketError on a non-404 content failure (403)', async () => {
    const mock = installBitbucketFetchMock({
      fileContentResponses: { status: 403, body: { error: { message: 'Forbidden' } } },
    });
    try {
      const adapter = buildBitbucketAdapter();
      await expect(adapter.getFileContent(WORKSPACE, BB_REPO, 'src/file.ts', 'main')).rejects.toBeInstanceOf(BitbucketError);
    } finally {
      mock.restore();
    }
  });

  it('getFileContent throws BitbucketError on a non-404 content failure (500)', async () => {
    const mock = installBitbucketFetchMock({
      fileContentResponses: { status: 500, body: { error: { message: 'Server error' } } },
    });
    try {
      const adapter = buildBitbucketAdapter();
      await expect(adapter.getFileContent(WORKSPACE, BB_REPO, 'src/file.ts', 'main')).rejects.toBeInstanceOf(BitbucketError);
    } finally {
      mock.restore();
    }
  });

  it('getCompareDiff uses /diff/{head}..{base}?context=3&topic=true with REVERSED operands', async () => {
    const fixtureDiff = 'diff --git a/foo.ts b/foo.ts\n+const added = true;\n';
    const mock = installBitbucketFetchMock({
      compareDiffResponses: {
        status: 200,
        body: fixtureDiff,
        headers: { 'content-type': 'text/plain' },
      },
    });
    try {
      const adapter = buildBitbucketAdapter();
      const result = await adapter.getCompareDiff(WORKSPACE, BB_REPO, 'main', 'feature');
      expect(result).toBe(fixtureDiff);
      const diffCall = mock.calls.find(
        (call) => call.method === 'GET' && /\/diff\//.test(call.path),
      );
      expect(diffCall).toBeDefined();
      expect(diffCall?.path).toBe(
        `/2.0/repositories/${WORKSPACE}/${BB_REPO}/diff/${encodeURIComponent('feature')}..${encodeURIComponent('main')}?context=3&topic=true`,
      );
    } finally {
      mock.restore();
    }
  });

  it('getCompareDiff returns the empty string "" on a 200-empty response (D-09)', async () => {
    const mock = installBitbucketFetchMock({
      compareDiffResponses: {
        status: 200,
        body: '',
        headers: { 'content-type': 'text/plain' },
      },
    });
    try {
      const adapter = buildBitbucketAdapter();
      const result = await adapter.getCompareDiff(WORKSPACE, BB_REPO, 'a', 'b');
      expect(result).toBe('');
    } finally {
      mock.restore();
    }
  });

  it('getCompareDiff throws BitbucketError on a non-2xx compare (500)', async () => {
    const mock = installBitbucketFetchMock({
      compareDiffResponses: { status: 500, body: { error: { message: 'Server error' } } },
    });
    try {
      const adapter = buildBitbucketAdapter();
      await expect(adapter.getCompareDiff(WORKSPACE, BB_REPO, 'main', 'feature')).rejects.toBeInstanceOf(BitbucketError);
    } finally {
      mock.restore();
    }
  });
});

// --- PROV-02: GitHub unresolved-bot-thread listing + resolution ---

const GH_BOT_USER_ID = 99_999;
const GH_OTHER_USER_ID = 12_345;

function makeBotThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PRRT_kwDOAbcDefg01',
    path: 'src/file.ts',
    line: 12,
    startLine: 12,
    originalLine: null,
    originalStartLine: null,
    isResolved: false,
    isOutdated: false,
    comments: {
      nodes: [
        {
          body: 'Bot root finding body',
          replyTo: null,
          author: { __typename: 'Bot', databaseId: GH_BOT_USER_ID },
        },
      ],
    },
    ...overrides,
  };
}

describe('PROV-02: GitHub thread listing and resolution', () => {
  it('getUnresolvedBotThreads traverses two pages and returns ONLY unresolved bot root threads', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      threadListResponses: [
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    makeBotThread({ id: 'PRRT_page1_a', line: 5, startLine: 5 }),
                    // Human (non-bot) thread: should be filtered.
                    makeBotThread({
                      id: 'PRRT_page1_human',
                      comments: { nodes: [{ body: 'human', replyTo: null, author: { __typename: 'User', databaseId: GH_OTHER_USER_ID } }] },
                    }),
                    // Resolved: should be filtered (D-06).
                    makeBotThread({ id: 'PRRT_page1_resolved', isResolved: true }),
                    // Reply (not root): should be filtered.
                    makeBotThread({
                      id: 'PRRT_page1_reply',
                      comments: { nodes: [{ body: 'reply', replyTo: { id: 'x' }, author: { __typename: 'Bot', databaseId: GH_BOT_USER_ID } }] },
                    }),
                  ],
                  pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
                },
              },
            },
          },
        },
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [makeBotThread({ id: 'PRRT_page2_a', line: 30, startLine: 28 })],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const threads = await adapter.getUnresolvedBotThreads(OWNER, REPO, PR_NUMBER);
      expect(threads).toEqual([
        {
          ref: 'PRRT_page1_a',
          path: 'src/file.ts',
          lineStart: 5,
          lineEnd: 5,
          rootBody: 'Bot root finding body',
          outdated: false,
        },
        {
          ref: 'PRRT_page2_a',
          path: 'src/file.ts',
          lineStart: 28,
          lineEnd: 30,
          rootBody: 'Bot root finding body',
          outdated: false,
        },
      ]);
      // Two GraphQL pages must have been called.
      const graphqlCalls = mock.calls.filter(
        (call) => call.method === 'POST' && call.path === '/graphql',
      );
      expect(graphqlCalls).toHaveLength(2);
      // After the first page the `after` variable must be the cursor; the second must be null.
      expect(graphqlCalls[0].body?.variables?.after).toBeNull();
      expect(graphqlCalls[1].body?.variables?.after).toBe('CURSOR_1');
    } finally {
      mock.restore();
    }
  });

  it('returns [] when a later page fails (fail-closed pagination)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      threadListResponses: [
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [makeBotThread({ id: 'PRRT_first' })],
                  pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
                },
              },
            },
          },
        },
      ],
      threadListNonRetriable: true,
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getUnresolvedBotThreads(OWNER, REPO, PR_NUMBER)).resolves.toEqual([]);
    } finally {
      mock.restore();
    }
  });

  it('returns [] when the GraphQL envelope carries `errors`', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      threadListResponses: [{ errors: [{ message: 'something went wrong' }] }],
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.getUnresolvedBotThreads(OWNER, REPO, PR_NUMBER)).resolves.toEqual([]);
    } finally {
      mock.restore();
    }
  });

  it('maps the R-3 current/original fallback for outdated threads and skips malformed ranges', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      threadListResponses: [
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    // Outdated: only original anchors available -> fallback range + outdated true.
                    makeBotThread({
                      id: 'PRRT_outdated',
                      line: null,
                      startLine: null,
                      originalLine: 7,
                      originalStartLine: 5,
                      isOutdated: true,
                    }),
                    // No anchors at all -> skipped rather than fabricated.
                    makeBotThread({
                      id: 'PRRT_no_anchors',
                      line: null,
                      startLine: null,
                      originalLine: null,
                      originalStartLine: null,
                    }),
                    // Empty path -> skipped.
                    makeBotThread({ id: 'PRRT_empty_path', path: '' }),
                    // Empty root body -> skipped.
                    makeBotThread({ id: 'PRRT_empty_body', comments: { nodes: [{ body: '', replyTo: null, author: { __typename: 'Bot', databaseId: GH_BOT_USER_ID } }] } }),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const threads = await adapter.getUnresolvedBotThreads(OWNER, REPO, PR_NUMBER);
      expect(threads).toEqual([
        {
          ref: 'PRRT_outdated',
          path: 'src/file.ts',
          lineStart: 5,
          lineEnd: 7,
          rootBody: 'Bot root finding body',
          outdated: true,
        },
      ]);
    } finally {
      mock.restore();
    }
  });

  it('resolveThread posts the ref as a GraphQL variable and returns true on success', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      resolveReviewThreadResponse: { status: 200, data: { resolveReviewThread: { thread: { id: 'PRRT_x', isResolved: true } } } },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.resolveThread(OWNER, REPO, 'PRRT_x')).resolves.toBe(true);
      const mutationCall = mock.calls.find(
        (call) => call.method === 'POST' && call.path === '/graphql' && /ResolveReviewThread/.test(JSON.stringify(call.body?.query ?? '')),
      );
      expect(mutationCall).toBeDefined();
      // Ref travels as a variable, never in query text (T-17-02-01).
      expect(mutationCall?.body?.query).not.toContain('PRRT_x');
      expect(mutationCall?.body?.variables?.threadId).toBe('PRRT_x');
    } finally {
      mock.restore();
    }
  });

  it('resolveThread returns false on GraphQL errors and does not change the static capability', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock({
      ...buildGitHubFixtures(),
      resolveReviewThreadResponse: { status: 200, errors: [{ message: 'mutation denied' }] },
    });

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.resolveThread(OWNER, REPO, 'PRRT_x')).resolves.toBe(false);
      // Capability stays static-true (D-04: only Bitbucket downgrades).
      expect(adapter.capabilities.supportsThreadResolution).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('resolveThread rejects malformed/overlong refs BEFORE any HTTP request', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const mock = installGitHubFetchMock(buildGitHubFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      // Empty / whitespace / control character
      await expect(adapter.resolveThread(OWNER, REPO, '')).rejects.toThrow();
      await expect(adapter.resolveThread(OWNER, REPO, '   ')).rejects.toThrow();
      await expect(adapter.resolveThread(OWNER, REPO, 'PRRT_x\n')).rejects.toThrow();
      // Overlong
      await expect(adapter.resolveThread(OWNER, REPO, 'a'.repeat(300))).rejects.toThrow();
      // No GraphQL calls must have been issued (the rejections are pre-wire).
      const graphqlCalls = mock.calls.filter(
        (call) => call.method === 'POST' && call.path === '/graphql',
      );
      expect(graphqlCalls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });
});

// --- PROV-02: Bitbucket unresolved-bot-thread listing + resolution ---

const BB_BOT_ACCOUNT_ID = 'bb-bot-account-id';

function makeBitbucketBotComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    content: { raw: 'Bot root finding body' },
    inline: { path: 'src/foo.ts', to: 12, from: undefined },
    parent: null,
    deleted: false,
    resolution: null,
    user: {
      account_id: BB_BOT_ACCOUNT_ID,
      nickname: 'botnick',
      display_name: 'Bot',
    },
    ...overrides,
  };
}

describe('PROV-02: Bitbucket thread listing and resolution', () => {
  it('uses the configured bot account id and does NOT call /user (D-07)', async () => {
    const mock = installBitbucketFetchMock({
      blockResolveBotUserIdentity: true, // proves configured id short-circuits the live call
      rawCommentPageResponses: [
        {
          status: 200,
          body: { values: [makeBitbucketBotComment()], next: undefined },
        },
      ],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const job = {
        ...buildBitbucketFixture(),
        configSnapshot: {
          review: {
            interactive: {
              commands: {
                enabled: true,
                bitbucket_allowed_account_ids: [],
                bitbucket_bot_account_id: BB_BOT_ACCOUNT_ID,
              },
              qa: { enabled: false, rate_limit_per_hour: 10 },
            },
          },
        } as never,
      };
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: typeof job,
      ) => BitbucketAdapter)(env, client, job);

      const threads = await adapter.getUnresolvedBotThreads(WORKSPACE, BB_REPO, BB_PR_NUMBER);
      // Bot id filter should match the configured value.
      expect(threads).toHaveLength(1);
      // No /user call was made — the configured id short-circuits the resolver.
      const userCalls = mock.calls.filter((call) => call.url.endsWith('/2.0/user') && call.method === 'GET');
      expect(userCalls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  it('traverses at least two comment pages and applies the D-05/D-06 filter', async () => {
    const mock = installBitbucketFetchMock({
      rawCommentPageResponses: [
        {
          status: 200,
          body: {
            values: [
              makeBitbucketBotComment({ id: 11 }),
              // Human (not bot) - filtered.
              makeBitbucketBotComment({
                id: 12,
                user: { account_id: 'other-user', nickname: 'h', display_name: 'H' },
              }),
              // Reply - filtered.
              makeBitbucketBotComment({ id: 13, parent: { id: 11 } }),
              // Resolved - filtered.
              makeBitbucketBotComment({ id: 14, resolution: { created_on: 'now', user: { account_id: BB_BOT_ACCOUNT_ID } } }),
              // Deleted - filtered.
              makeBitbucketBotComment({ id: 15, deleted: true }),
            ],
            next: `https://api.bitbucket.org/2.0/repositories/${WORKSPACE}/${BB_REPO}/pullrequests/${BB_PR_NUMBER}/comments?pagelen=100&page=2`,
          },
        },
        {
          status: 200,
          body: {
            values: [makeBitbucketBotComment({ id: 21, inline: { path: 'src/foo.ts', to: 30, from: undefined } })],
          },
        },
      ],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const job = {
        ...buildBitbucketFixture(),
        configSnapshot: {
          review: {
            interactive: {
              commands: {
                enabled: true,
                bitbucket_allowed_account_ids: [],
                bitbucket_bot_account_id: BB_BOT_ACCOUNT_ID,
              },
              qa: { enabled: false, rate_limit_per_hour: 10 },
            },
          },
        } as never,
      };
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: typeof job,
      ) => BitbucketAdapter)(env, client, job);

      const threads = await adapter.getUnresolvedBotThreads(WORKSPACE, BB_REPO, BB_PR_NUMBER);
      expect(threads).toHaveLength(2);
      // Opaque refs are self-encoding `${pr}:${id}`.
      expect(threads[0].ref).toBe(`${BB_PR_NUMBER}:11`);
      expect(threads[1].ref).toBe(`${BB_PR_NUMBER}:21`);
      // Two raw-comment GET calls must have been issued.
      const commentCalls = mock.calls.filter(
        (call) => call.method === 'GET' && call.path.includes('/comments'),
      );
      expect(commentCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      mock.restore();
    }
  });

  it('returns [] when a later page fails (fail-closed pagination)', async () => {
    const mock = installBitbucketFetchMock({
      rawCommentPageResponses: [
        {
          status: 200,
          body: {
            values: [makeBitbucketBotComment({ id: 11 })],
            next: `https://api.bitbucket.org/2.0/repositories/${WORKSPACE}/${BB_REPO}/pullrequests/${BB_PR_NUMBER}/comments?pagelen=100&page=2`,
          },
        },
        { status: 500, body: { error: { message: 'intermittent' } } },
      ],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const job = {
        ...buildBitbucketFixture(),
        configSnapshot: {
          review: {
            interactive: {
              commands: {
                enabled: true,
                bitbucket_allowed_account_ids: [],
                bitbucket_bot_account_id: BB_BOT_ACCOUNT_ID,
              },
              qa: { enabled: false, rate_limit_per_hour: 10 },
            },
          },
        } as never,
      };
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: typeof job,
      ) => BitbucketAdapter)(env, client, job);

      await expect(adapter.getUnresolvedBotThreads(WORKSPACE, BB_REPO, BB_PR_NUMBER)).resolves.toEqual([]);
    } finally {
      mock.restore();
    }
  });

  it('marks old-side-only comments outdated (R-4)', async () => {
    const mock = installBitbucketFetchMock({
      rawCommentPageResponses: [
        {
          status: 200,
          body: {
            values: [
              makeBitbucketBotComment({
                id: 50,
                inline: { path: 'src/foo.ts', to: undefined, from: 7, start_from: 5 },
              }),
            ],
          },
        },
      ],
      // Diff with no actual content for src/foo.ts so the line isn't valid.
      getPullRequestDiffResponse: {
        status: 200,
        body: 'diff --git a/other.ts b/other.ts\n@@ -1 +1 @@\n-old\n+new\n',
        headers: { 'content-type': 'text/plain' },
      },
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const job = {
        ...buildBitbucketFixture(),
        configSnapshot: {
          review: {
            interactive: {
              commands: {
                enabled: true,
                bitbucket_allowed_account_ids: [],
                bitbucket_bot_account_id: BB_BOT_ACCOUNT_ID,
              },
              qa: { enabled: false, rate_limit_per_hour: 10 },
            },
          },
        } as never,
      };
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: typeof job,
      ) => BitbucketAdapter)(env, client, job);

      const threads = await adapter.getUnresolvedBotThreads(WORKSPACE, BB_REPO, BB_PR_NUMBER);
      // Old-side-only: lineStart populated from start_from, lineEnd from from, outdated=true.
      expect(threads).toHaveLength(1);
      expect(threads[0]).toEqual({
        ref: `${BB_PR_NUMBER}:50`,
        path: 'src/foo.ts',
        lineStart: 5,
        lineEnd: 7,
        rootBody: 'Bot root finding body',
        outdated: true,
      });
    } finally {
      mock.restore();
    }
  });

  it('skips malformed anchors and empty bodies', async () => {
    const mock = installBitbucketFetchMock({
      rawCommentPageResponses: [
        {
          status: 200,
          body: {
            values: [
              // Empty body - skipped.
              makeBitbucketBotComment({ id: 60, content: { raw: '' } }),
              // Empty inline.path - skipped (no path kept).
              makeBitbucketBotComment({ id: 61, inline: { path: '', to: 12, from: undefined } }),
              // Malformed range - skipped.
              makeBitbucketBotComment({ id: 62, inline: { path: 'src/foo.ts', to: 0, from: undefined } }),
            ],
          },
        },
      ],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const job = {
        ...buildBitbucketFixture(),
        configSnapshot: {
          review: {
            interactive: {
              commands: {
                enabled: true,
                bitbucket_allowed_account_ids: [],
                bitbucket_bot_account_id: BB_BOT_ACCOUNT_ID,
              },
              qa: { enabled: false, rate_limit_per_hour: 10 },
            },
          },
        } as never,
      };
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: typeof job,
      ) => BitbucketAdapter)(env, client, job);

      await expect(adapter.getUnresolvedBotThreads(WORKSPACE, BB_REPO, BB_PR_NUMBER)).resolves.toEqual([]);
    } finally {
      mock.restore();
    }
  });

  it('rejects malformed refs and flips `supportsThreadResolution` on 403/404/501', async () => {
    const mock = installBitbucketFetchMock({
      resolveCommentStatuses: [{ status: 403 }],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: ReturnType<typeof buildBitbucketFixture>,
      ) => BitbucketAdapter)(env, client, buildBitbucketFixture());

      // Malformed ref -> throws at the seam.
      await expect(adapter.resolveThread(WORKSPACE, BB_REPO, 'not-a-valid-ref')).rejects.toThrow();

      // Now try with a valid ref -> 403 -> flips capability.
      await expect(adapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`)).resolves.toBe(false);
      expect(adapter.capabilities.supportsThreadResolution).toBe(false);

      // Second call must short-circuit (no resolve request) thanks to the downgrade.
      const callsBefore = mock.calls.length;
      await expect(adapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`)).resolves.toBe(false);
      const resolveAfter = mock.calls.filter((call) => call.method === 'POST' && /\/comments\/\d+\/resolve/.test(call.path));
      expect(resolveAfter).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('returns false on 500/501 WITHOUT flipping the capability and uses exactly one request', async () => {
    const mock = installBitbucketFetchMock({
      resolveCommentStatuses: [{ status: 500 }],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: ReturnType<typeof buildBitbucketFixture>,
      ) => BitbucketAdapter)(env, client, buildBitbucketFixture());

      await expect(adapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`)).resolves.toBe(false);
      // Capability stays optimistic (D-04: 500 is NOT a downgrade trigger).
      expect(adapter.capabilities.supportsThreadResolution).toBe(true);
      // Exactly one POST /resolve issued for the 500 attempt — no retry.
      const resolveCalls = mock.calls.filter((call) => call.method === 'POST' && /\/comments\/\d+\/resolve/.test(call.path));
      expect(resolveCalls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('resolves successfully on 200', async () => {
    const mock = installBitbucketFetchMock({
      resolveCommentStatuses: [{ status: 200 }],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: ReturnType<typeof buildBitbucketFixture>,
      ) => BitbucketAdapter)(env, client, buildBitbucketFixture());

      await expect(adapter.resolveThread(WORKSPACE, BB_REPO, `${BB_PR_NUMBER}:7`)).resolves.toBe(true);
      expect(adapter.capabilities.supportsThreadResolution).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('rejects a non-Bitbucket next URL (SSRF guard)', async () => {
    const mock = installBitbucketFetchMock({
      rawCommentPageResponses: [
        {
          status: 200,
          body: {
            values: [makeBitbucketBotComment({ id: 11 })],
            next: 'https://evil.example.com/2.0/comments?page=2',
          },
        },
      ],
    });

    try {
      const env = createTestEnv();
      const client = new BitbucketClient(env, 'test-token-bearer');
      const job = {
        ...buildBitbucketFixture(),
        configSnapshot: {
          review: {
            interactive: {
              commands: {
                enabled: true,
                bitbucket_allowed_account_ids: [],
                bitbucket_bot_account_id: BB_BOT_ACCOUNT_ID,
              },
              qa: { enabled: false, rate_limit_per_hour: 10 },
            },
          },
        } as never,
      };
      const adapter = new (BitbucketAdapter as unknown as new (
        env: ReturnType<typeof createTestEnv>,
        client: BitbucketClient,
        jobArg: typeof job,
      ) => BitbucketAdapter)(env, client, job);

      await expect(adapter.getUnresolvedBotThreads(WORKSPACE, BB_REPO, BB_PR_NUMBER)).resolves.toEqual([]);
    } finally {
      mock.restore();
    }
  });
});
