import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitbucketClient, BitbucketError } from '@server/core/bitbucket';
import { addBitbucketWorkspaceInputSchema } from '@shared/bitbucket';
import type { AppBindings } from '@server/env';
import {
  BITBUCKET_FIXTURE_ACCOUNT_ID,
  BITBUCKET_FIXTURE_EDIT_COMMENT_ID,
  BITBUCKET_FIXTURE_NICKNAME,
  expectBitbucketGet,
  expectBitbucketPost,
  expectBitbucketPut,
  installBitbucketFetchMock,
} from './bitbucket-fetch-mock';

const env = { BOT_USERNAME: 'codra-bot' } as Pick<AppBindings, 'BOT_USERNAME'>;
const token = 'test-token-bearer';
const repoPrefix = '/2.0/repositories/acme/backend';

function createClient() {
  const tracker = { incrementSubrequests: vi.fn() };
  return {
    client: new BitbucketClient(env, token, tracker),
    tracker,
  };
}

function expectAuthenticated(call: { authorization: string | null }) {
  expect(call.authorization).toBe(`Bearer ${token}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BitbucketClient', () => {
  it('gets and flattens pull request metadata', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();

    await expect(client.getPullRequest('acme', 'backend', 42)).resolves.toEqual({
      number: 42,
      title: 'Add Bitbucket support',
      body: 'Review Bitbucket pull requests.',
      draft: false,
      headSha: 'head123',
      headRef: 'feature/bitbucket',
      baseSha: 'base123',
      baseRef: 'main',
      authorLogin: 'alice',
    });

    expectBitbucketGet(mock.calls[0], `${repoPrefix}/pullrequests/42`);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('gets the unified pull request diff with fixed context', async () => {
    const mock = installBitbucketFetchMock({
      getPullRequestDiffResponse: {
        body: 'diff --git a/src/foo.ts b/src/foo.ts\n+const added = true;\n',
        headers: { 'content-type': 'text/plain' },
      },
    });
    const { client, tracker } = createClient();

    await expect(client.getPullRequestDiff('acme', 'backend', 42)).resolves.toContain('+const added = true;');
    expectBitbucketGet(mock.calls[0], `${repoPrefix}/pullrequests/42/diff?context=3`);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('lists pull request comments with pagelen=100', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();

    await expect(client.listPullRequestComments('acme', 'backend', 42)).resolves.toEqual([
      {
        id: 7,
        body: 'Existing comment',
        inline: undefined,
        author: { id: BITBUCKET_FIXTURE_ACCOUNT_ID, login: BITBUCKET_FIXTURE_NICKNAME },
      },
    ]);
    expectBitbucketGet(mock.calls[0], `${repoPrefix}/pullrequests/42/comments?pagelen=100`);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('lists pull request comments with links.html.href projected additively', async () => {
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: {
          values: [
            {
              id: 7,
              content: { raw: 'Existing comment' },
              links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42#comment-7' } },
              user: {
                account_id: BITBUCKET_FIXTURE_ACCOUNT_ID,
                nickname: BITBUCKET_FIXTURE_NICKNAME,
              },
            },
          ],
        },
      },
    });
    const { client } = createClient();

    await expect(client.listPullRequestComments('acme', 'backend', 42)).resolves.toEqual([
      {
        id: 7,
        body: 'Existing comment',
        inline: undefined,
        links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42#comment-7' } },
        author: { id: BITBUCKET_FIXTURE_ACCOUNT_ID, login: BITBUCKET_FIXTURE_NICKNAME },
      },
    ]);
    expectBitbucketGet(mock.calls[0], `${repoPrefix}/pullrequests/42/comments?pagelen=100`);
  });

  it('posts an added-line comment using content.raw and inline.to', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();

    await expect(client.postPullRequestComment('acme', 'backend', 42, {
      path: 'src/foo.ts',
      line: 12,
      line_type: 'added',
      content: { raw: 'Check this line.' },
    })).resolves.toEqual({ id: 8 });

    expectBitbucketPost(mock.calls[0], `${repoPrefix}/pullrequests/42/comments`);
    expect(mock.calls[0].body).toEqual({
      content: { raw: 'Check this line.' },
      inline: { path: 'src/foo.ts', to: 12 },
    });
    expect(mock.calls[0].body).not.toHaveProperty('body');
    expect(mock.calls[0].body).not.toHaveProperty('inline.lineType');
    expect(mock.calls[0].body).not.toHaveProperty('inline.line_type');
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('resolves links.html.href on postPullRequestComment when the provider response includes it', async () => {
    const mock = installBitbucketFetchMock({
      postPullRequestCommentResponses: [
        {
          status: 201,
          body: {
            id: 8,
            links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42#comment-8' } },
          },
        },
      ],
    });
    const { client } = createClient();

    await expect(client.postPullRequestComment('acme', 'backend', 42, {
      path: 'src/foo.ts',
      line: 12,
      line_type: 'added',
      content: { raw: 'Check this line.' },
    })).resolves.toEqual({
      id: 8,
      links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42#comment-8' } },
    });

    expectBitbucketPost(mock.calls[0], `${repoPrefix}/pullrequests/42/comments`);
  });

  it('maps removed-line comments to the documented inline.from field', async () => {
    const mock = installBitbucketFetchMock();
    const { client } = createClient();

    await client.postPullRequestComment('acme', 'backend', 42, {
      path: 'src/foo.ts',
      line: 9,
      line_type: 'removed',
      content: { raw: 'Was this deletion intentional?' },
    });

    expect(mock.calls[0].body).toEqual({
      content: { raw: 'Was this deletion intentional?' },
      inline: { path: 'src/foo.ts', from: 9 },
    });
  });

  it('posts marker and summary comments without an inline anchor', async () => {
    const mock = installBitbucketFetchMock();
    const { client } = createClient();

    await client.postPullRequestComment('acme', 'backend', 42, {
      content: { raw: '<!-- codra:job=job-1 commit=head123 -->' },
    });

    expect(mock.calls[0].body).toEqual({
      content: { raw: '<!-- codra:job=job-1 commit=head123 -->' },
    });
  });

  it('edits a pull request comment via PUT with body { content: { raw } }', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();

    await expect(
      client.editPullRequestComment('acme', 'backend', 42, 8, 'Edited body'),
    ).resolves.toEqual({ id: BITBUCKET_FIXTURE_EDIT_COMMENT_ID });

    expectBitbucketPut(mock.calls[0], `${repoPrefix}/pullrequests/42/comments/8`);
    expect(mock.calls[0].body).toEqual({ content: { raw: 'Edited body' } });
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('returns null when editing a comment that is gone (404)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 404, body: { error: { message: 'Not found' } } }],
    });
    const { client } = createClient();

    await expect(
      client.editPullRequestComment('acme', 'backend', 42, 8, 'Edited body'),
    ).resolves.toBeNull();
  });

  it('returns null when editing a comment that is gone (410)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 410, body: { error: { message: 'Gone' } } }],
    });
    const { client } = createClient();

    await expect(
      client.editPullRequestComment('acme', 'backend', 42, 8, 'Edited body'),
    ).resolves.toBeNull();
  });

  it('throws BitbucketError on a non-gone edit status (403)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 403, body: { error: { message: 'Forbidden' } } }],
    });
    const { client } = createClient();

    const request = client.editPullRequestComment('acme', 'backend', 42, 8, 'Edited body');
    await expect(request).rejects.toBeInstanceOf(BitbucketError);
    await expect(request).rejects.toMatchObject({ status: 403 });
  });

  it('approves a pull request with an empty POST body', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();

    await expect(client.approvePullRequest('acme', 'backend', 42)).resolves.toBeUndefined();
    expectBitbucketPost(mock.calls[0], `${repoPrefix}/pullrequests/42/approve`);
    expect(mock.calls[0].body).toBeNull();
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('upserts the canonical Code Insights report', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();
    const report = {
      title: 'Codra review',
      details: 'No blocking findings.',
      report_type: 'BUG' as const,
      result: 'PASSED' as const,
    };

    await expect(client.upsertCodeInsightsReport('acme', 'backend', 'head123', report)).resolves.toBeUndefined();
    expectBitbucketPut(mock.calls[0], `${repoPrefix}/commit/head123/reports/codra-review`);
    expect(mock.calls[0].body).toEqual(report);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('upserts a NAMED report when reportId is supplied', async () => {
    const mock = installBitbucketFetchMock();
    const { client } = createClient();
    const report = {
      title: 'Codra annotations',
      details: 'Per-line findings.',
      report_type: 'BUG' as const,
      result: 'PASSED' as const,
    };

    await expect(
      client.upsertCodeInsightsReport('acme', 'backend', 'head123', report, 'codra-annotations'),
    ).resolves.toBeUndefined();
    expectBitbucketPut(mock.calls[0], `${repoPrefix}/commit/head123/reports/codra-annotations`);
    expect(mock.calls[0].body).toEqual(report);
  });

  it('deleteCodeInsightsReport DELETEs the named report and resolves undefined on 204', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();

    await expect(
      client.deleteCodeInsightsReport('acme', 'backend', 'head123', 'codra-annotations'),
    ).resolves.toBeUndefined();
    expect(mock.calls[0].method).toBe('DELETE');
    expect(mock.calls[0].path).toBe(`${repoPrefix}/commit/head123/reports/codra-annotations`);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('deleteCodeInsightsReport swallows a 404 (round 1, no prior report)', async () => {
    installBitbucketFetchMock({
      deleteCodeInsightsReportResponse: { status: 404, body: { error: { message: 'Not found' } } },
    });
    const { client } = createClient();

    await expect(
      client.deleteCodeInsightsReport('acme', 'backend', 'head123', 'codra-annotations'),
    ).resolves.toBeUndefined();
  });

  it('deleteCodeInsightsReport rethrows a non-404 BitbucketError (500)', async () => {
    // Exercises withRetry exponential backoff (2s + 4s) — use fake timers to avoid real delays.
    vi.useFakeTimers();
    try {
      installBitbucketFetchMock({
        deleteCodeInsightsReportResponse: { status: 500, body: { error: { message: 'Internal error' } } },
      });
      const { client } = createClient();

      const request = client.deleteCodeInsightsReport('acme', 'backend', 'head123', 'codra-annotations');
      request.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(request).rejects.toBeInstanceOf(BitbucketError);
      await expect(request).rejects.toMatchObject({ status: 500 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bulkUpsertAnnotations POSTs the annotation array verbatim', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();
    const annotations = [
      {
        external_id: 'finding-1',
        severity: 'HIGH' as const,
        path: 'src/foo.ts',
        line: 12,
      },
      {
        external_id: 'finding-2',
        severity: 'LOW' as const,
      },
    ];

    await expect(
      client.bulkUpsertAnnotations('acme', 'backend', 'head123', 'codra-annotations', annotations),
    ).resolves.toBeUndefined();
    expectBitbucketPost(mock.calls[0], `${repoPrefix}/commit/head123/reports/codra-annotations/annotations`);
    expect(mock.calls[0].body).toEqual(annotations);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it('posts a merge-gating commit build status', async () => {
    const mock = installBitbucketFetchMock();
    const { client, tracker } = createClient();
    const status = {
      key: 'codra-review',
      state: 'SUCCESSFUL' as const,
      description: 'Codra review passed',
      url: 'https://app.example.com/jobs/123',
    };

    await expect(client.postCommitBuildStatus('acme', 'backend', 'head123', status)).resolves.toBeUndefined();
    expectBitbucketPost(mock.calls[0], `${repoPrefix}/commit/head123/statuses/build`);
    expect(mock.calls[0].body).toEqual(status);
    expectAuthenticated(mock.calls[0]);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('retries status %s and succeeds on the second attempt', async (status) => {
    const mock = installBitbucketFetchMock({
      responseSequence: [
        { status, body: { error: { message: 'Try again' } }, headers: { 'retry-after': '0' } },
        { body: {
          id: 42,
          title: 'Retried PR',
          description: null,
          draft: false,
          source: { branch: { name: 'feature' }, commit: { hash: 'head' } },
          destination: { branch: { name: 'main' }, commit: { hash: 'base' } },
          author: { username: 'alice' },
          state: 'OPEN',
        } },
      ],
    });
    const { client, tracker } = createClient();

    await expect(client.getPullRequest('acme', 'backend', 42)).resolves.toMatchObject({ title: 'Retried PR' });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(2);
  });

  it('retries TimeoutError failures', async () => {
    vi.useFakeTimers();
    const mock = installBitbucketFetchMock({
      responseSequence: [
        () => {
          const error = new Error('Bitbucket request timed out');
          error.name = 'TimeoutError';
          throw error;
        },
        { body: {
          id: 42,
          title: 'Retried after timeout',
          description: null,
          draft: false,
          source: { branch: { name: 'feature' }, commit: { hash: 'head' } },
          destination: { branch: { name: 'main' }, commit: { hash: 'base' } },
          author: { username: 'alice' },
          state: 'OPEN',
        } },
      ],
    });
    const { client } = createClient();

    const request = client.getPullRequest('acme', 'backend', 42);
    await vi.runAllTimersAsync();
    await expect(request).resolves.toMatchObject({ title: 'Retried after timeout' });
    expect(mock.calls).toHaveLength(2);
  });

  it('surfaces the final BitbucketError after exhausting retries', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: [
        { status: 503, body: 'unavailable', headers: { 'retry-after': '0' } },
        { status: 503, body: 'still unavailable', headers: { 'retry-after': '0' } },
        { status: 503, body: 'finally unavailable', headers: { 'retry-after': '0' } },
      ],
    });
    const { client } = createClient();

    await expect(client.getPullRequest('acme', 'backend', 42)).rejects.toMatchObject({
      name: 'BitbucketError',
      status: 503,
      body: 'finally unavailable',
    });
    expect(mock.calls).toHaveLength(3);
  });

  it('surfaces non-retryable 4xx errors immediately', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: [{ status: 400, body: { error: { message: 'Bad request' } } }],
    });
    const { client } = createClient();

    const request = client.getPullRequest('acme', 'backend', 42);
    await expect(request).rejects.toBeInstanceOf(BitbucketError);
    await expect(request).rejects.toMatchObject({ status: 400 });
    expect(mock.calls).toHaveLength(1);
  });

  // Phase 31 (WS-01, D-05): workspace-level repo discovery. `responseSequence` is checked before
  // any URL-pattern route in the shared fetch mock, so these tests script the
  // `/repositories/{workspace}` listing directly without needing a dedicated mock route.
  describe('listWorkspaceRepositories', () => {
    it('single-page happy path returns the mapped {slug,name}[]', async () => {
      const mock = installBitbucketFetchMock({
        responseSequence: [
          { body: { values: [{ slug: 'repo-a', name: 'Repo A' }, { slug: 'repo-b', name: 'Repo B' }] } },
        ],
      });
      const { client, tracker } = createClient();

      await expect(client.listWorkspaceRepositories('acme')).resolves.toEqual([
        { slug: 'repo-a', name: 'Repo A' },
        { slug: 'repo-b', name: 'Repo B' },
      ]);
      expect(mock.calls).toHaveLength(1);
      expectBitbucketGet(mock.calls[0], '/2.0/repositories/acme?pagelen=100');
      expectAuthenticated(mock.calls[0]);
      expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
    });

    it('follows a response-supplied next link across pages, fetching BOTH pages through requestRaw', async () => {
      const nextUrl = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=100&page=2';
      const mock = installBitbucketFetchMock({
        responseSequence: [
          { body: { values: [{ slug: 'repo-a', name: 'Repo A' }], next: nextUrl } },
          { body: { values: [{ slug: 'repo-b', name: 'Repo B' }] } },
        ],
      });
      const { client, tracker } = createClient();

      await expect(client.listWorkspaceRepositories('acme')).resolves.toEqual([
        { slug: 'repo-a', name: 'Repo A' },
        { slug: 'repo-b', name: 'Repo B' },
      ]);
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
      expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(2);
    });

    it('rejects (never returns a partial array) when a page after the first fails', async () => {
      const nextUrl = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=100&page=2';
      installBitbucketFetchMock({
        responseSequence: [
          { body: { values: [{ slug: 'repo-a', name: 'Repo A' }], next: nextUrl } },
          { status: 400, body: { error: { message: 'Bad request' } } },
        ],
      });
      const { client } = createClient();

      await expect(client.listWorkspaceRepositories('acme')).rejects.toBeInstanceOf(BitbucketError);
    });

    it('transparently retries a page-2+ 429 and still returns the full concatenated result (OpenCode review finding, HIGH)', async () => {
      const nextUrl = 'https://api.bitbucket.org/2.0/repositories/acme?pagelen=100&page=2';
      const mock = installBitbucketFetchMock({
        responseSequence: [
          { body: { values: [{ slug: 'repo-a', name: 'Repo A' }], next: nextUrl } },
          { status: 429, body: { error: { message: 'Try again' } }, headers: { 'retry-after': '0' } },
          { body: { values: [{ slug: 'repo-b', name: 'Repo B' }] } },
        ],
      });
      const { client } = createClient();

      await expect(client.listWorkspaceRepositories('acme')).resolves.toEqual([
        { slug: 'repo-a', name: 'Repo A' },
        { slug: 'repo-b', name: 'Repo B' },
      ]);
      expect(mock.calls).toHaveLength(3);
    });

    it('throws when a response-supplied next link fails the SSRF origin/path guard', async () => {
      installBitbucketFetchMock({
        responseSequence: [
          { body: { values: [{ slug: 'repo-a', name: 'Repo A' }], next: 'https://evil.example.com/repositories/acme' } },
        ],
      });
      const { client } = createClient();

      await expect(client.listWorkspaceRepositories('acme')).rejects.toBeInstanceOf(BitbucketError);
    });
  });

  // Phase 31 (WS-01, finalize): the workspace-webhook client methods the finalize endpoint's
  // list-then-create-if-missing idempotency check depends on (T-31-03-04).
  describe('listWorkspaceWebhooks / createWorkspaceWebhook', () => {
    it('listWorkspaceWebhooks GETs /workspaces/{workspace}/hooks and maps to {uuid,url}[]', async () => {
      const mock = installBitbucketFetchMock({
        responseSequence: [
          { body: { values: [{ uuid: '{hook-1}', url: 'https://codra.example.com/webhook/bitbucket' }] } },
        ],
      });
      const { client, tracker } = createClient();

      await expect(client.listWorkspaceWebhooks('acme')).resolves.toEqual([
        { uuid: '{hook-1}', url: 'https://codra.example.com/webhook/bitbucket' },
      ]);
      expectBitbucketGet(mock.calls[0], '/2.0/workspaces/acme/hooks');
      expectAuthenticated(mock.calls[0]);
      expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
    });

    it('listWorkspaceWebhooks returns an empty array when the workspace has no hooks', async () => {
      installBitbucketFetchMock({ responseSequence: [{ body: { values: [] } }] });
      const { client } = createClient();

      await expect(client.listWorkspaceWebhooks('acme')).resolves.toEqual([]);
    });

    it('createWorkspaceWebhook POSTs the expected body and returns the created uuid', async () => {
      const mock = installBitbucketFetchMock({
        responseSequence: [{ status: 201, body: { uuid: '{hook-2}' } }],
      });
      const { client, tracker } = createClient();

      await expect(
        client.createWorkspaceWebhook('acme', {
          url: 'https://codra.example.com/webhook/bitbucket',
          secret: 'whsec',
          events: ['pullrequest:created', 'pullrequest:updated'],
        }),
      ).resolves.toEqual({ uuid: '{hook-2}' });
      expectBitbucketPost(mock.calls[0], '/2.0/workspaces/acme/hooks');
      expect(mock.calls[0].body).toEqual({
        description: 'Codra review webhook',
        url: 'https://codra.example.com/webhook/bitbucket',
        active: true,
        secret: 'whsec',
        events: ['pullrequest:created', 'pullrequest:updated'],
      });
      expectAuthenticated(mock.calls[0]);
      expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * PRD-06 (FR-131, D-05) — `BitbucketClient.searchCode`.
 *
 * The best-covered branch here is `null`, on purpose. Atlassian has confirmed the workspace
 * code-search endpoint does NOT accept Workspace/Repository Access Tokens (BCLOUD-22586), which is
 * the only credential class Codra stores, and the endpoint is removed on 2026-11-01. The `null`
 * degradation is therefore the EXPECTED STEADY STATE on Bitbucket, not a rare edge case, so it gets
 * four dedicated cases (401/403/404/429) while the success path gets the mapping cases.
 *
 * Every fixture is synthetic (workspace `acme`, repo `backend`, fragments `ALPHA`/`BETA`): no real
 * workspace slug, repository name, account id or token is committed (T-35-14).
 */
describe('BitbucketClient.searchCode (PRD-06 / FR-131 / D-05)', () => {
  const WORKSPACE = 'acme';
  const REPO = 'backend';
  /** The literal endpoint path. Asserted rather than interpolated so a route rename is caught here. */
  const SEARCH_PATH = `/2.0/workspaces/${WORKSPACE}/search/code`;

  /** One well-formed `values[]` entry: one file, one content match, two matched lines. */
  const twoLineValue = {
    type: 'code_search_result',
    content_match_count: 1,
    file: { path: 'src/server/auth.ts', type: 'commit_file' },
    content_matches: [
      {
        lines: [
          { line: 12, segments: [{ text: 'const ' }, { text: 'ALPHA', match: true }, { text: ' = 1;' }] },
          { line: 47, segments: [{ text: 'return ' }, { text: 'BETA', match: true }, { text: '();' }] },
        ],
      },
    ],
  };

  /** The `search_query` operand of the single recorded search call, URL-decoded. */
  function decodedSearchQuery(path: string) {
    return new URLSearchParams(path.slice(path.indexOf('?'))).get('search_query');
  }

  function pagelen(path: string) {
    return new URLSearchParams(path.slice(path.indexOf('?'))).get('pagelen');
  }

  it('reassembles each matched line from its segment texts, in order', async () => {
    const mock = installBitbucketFetchMock({ codeSearchResponses: { body: { values: [twoLineValue] } } });
    const { client, tracker } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'ALPHA', 30);

    expect(hits).toEqual([
      { path: 'src/server/auth.ts', fragment: 'const ALPHA = 1;', line: 12, ref: 'default branch' },
      { path: 'src/server/auth.ts', fragment: 'return BETA();', line: 47, ref: 'default branch' },
    ]);
    expectAuthenticated(mock.calls[0]);
    // Exactly one subrequest per call: `requestOnce` self-increments once and searchCode never
    // re-increments on top of it, and there is no retry wrapper to multiply it.
    expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
    expect(mock.calls).toHaveLength(1);
  });

  it('carries the provider line number when present and null when absent — never fabricated', async () => {
    const mock = installBitbucketFetchMock({
      codeSearchResponses: {
        body: {
          values: [
            {
              file: { path: 'src/a.ts' },
              content_matches: [
                {
                  lines: [
                    { line: 3, segments: [{ text: 'withLine' }] },
                    { segments: [{ text: 'withoutLine' }] },
                    { line: 'not-a-number', segments: [{ text: 'nonNumericLine' }] },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const { client } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'q', 30);

    expect(hits).toEqual([
      { path: 'src/a.ts', fragment: 'withLine', line: 3, ref: 'default branch' },
      { path: 'src/a.ts', fragment: 'withoutLine', line: null, ref: 'default branch' },
      { path: 'src/a.ts', fragment: 'nonNumericLine', line: null, ref: 'default branch' },
    ]);
    expect(mock.calls).toHaveLength(1);
  });

  it('labels every hit with the default branch, never a SHA and never the pull-request head (D-07)', async () => {
    installBitbucketFetchMock({ codeSearchResponses: { body: { values: [twoLineValue] } } });
    const { client } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'ALPHA', 30);

    expect(hits).not.toBeNull();
    for (const hit of hits!) {
      expect(hit.ref).toBe('default branch');
      expect(hit.ref).not.toBe('head123');
      // A bare 7-to-40-char hex string would be a SHA masquerading as a branch label.
      expect(hit.ref).not.toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('returns exactly maxHits when the payload carries more matched lines than that', async () => {
    installBitbucketFetchMock({
      codeSearchResponses: {
        body: {
          values: [
            {
              file: { path: 'src/a.ts' },
              content_matches: [
                { lines: Array.from({ length: 8 }, (_, i) => ({ line: i + 1, segments: [{ text: `line-${i}` }] })) },
              ],
            },
            {
              file: { path: 'src/b.ts' },
              content_matches: [{ lines: [{ line: 1, segments: [{ text: 'never-reached' }] }] }],
            },
          ],
        },
      },
    });
    const { client } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'line', 3);

    expect(hits).toHaveLength(3);
    expect(hits!.map((h) => h.fragment)).toEqual(['line-0', 'line-1', 'line-2']);
  });

  it('skips a value with no file.path and a line whose reassembled segments are blank', async () => {
    installBitbucketFetchMock({
      codeSearchResponses: {
        body: {
          values: [
            // No file object at all.
            { content_matches: [{ lines: [{ line: 1, segments: [{ text: 'orphan' }] }] }] },
            // file present, path a non-string.
            { file: { path: 42 }, content_matches: [{ lines: [{ line: 1, segments: [{ text: 'numeric-path' }] }] }] },
            {
              file: { path: 'src/ok.ts' },
              content_matches: [
                {
                  lines: [
                    { line: 1, segments: [{ text: '' }, { text: '   ' }] },
                    { line: 2, segments: [{ text: 'kept' }] },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const { client } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'q', 30);

    expect(hits).toEqual([
      { path: 'src/ok.ts', fragment: 'kept', line: 2, ref: 'default branch' },
    ]);
  });

  it('does not throw on a malformed segments array — absent, non-array, or a text-less entry (35-REVIEWS.md Antigravity #3)', async () => {
    installBitbucketFetchMock({
      codeSearchResponses: {
        body: {
          values: [
            {
              file: { path: 'src/shapes.ts' },
              content_matches: [
                {
                  lines: [
                    // 1. `segments` key absent entirely.
                    { line: 1 },
                    // 2. `segments` present but NOT an array — `.map` on this would throw.
                    { line: 2, segments: 'const x = 1;' },
                    // 3. an entry with no `text`, a null entry, and a non-string `text`. The
                    //    reassembly must coalesce all three to '' rather than stringifying
                    //    `undefined` into the fragment.
                    { line: 3, segments: [{ match: true }, null, { text: 7 }, { text: 'survivor' }] },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const { client } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'q', 30);

    // Shapes 1 and 2 reassemble to '' and are skipped as blank; shape 3 keeps only the one real
    // segment text. Crucially, NOTHING threw — a payload-shape change degrades to fewer hits.
    expect(hits).toEqual([
      { path: 'src/shapes.ts', fragment: 'survivor', line: 3, ref: 'default branch' },
    ]);
    expect(hits![0].fragment).not.toContain('undefined');
  });

  it('returns an empty array for a 200 with no values key at all', async () => {
    installBitbucketFetchMock({ codeSearchResponses: { body: { size: 0, page: 1 } } });
    const { client } = createClient();

    await expect(client.searchCode(WORKSPACE, REPO, 'q', 30)).resolves.toEqual([]);
  });

  // The four capability-unavailable branches. These are the EXPECTED Bitbucket steady state.
  for (const status of [401, 403, 404, 429]) {
    it(`returns null on ${status} (capability unavailable, not an error)`, async () => {
      const mock = installBitbucketFetchMock({
        codeSearchResponses: { status, body: { error: { message: `search refused with ${status}` } } },
      });
      const { client, tracker } = createClient();

      await expect(client.searchCode(WORKSPACE, REPO, 'q', 30)).resolves.toBeNull();
      // No retry storm against a deprecated endpoint with no documented numeric limit (T-35-12) —
      // this is why the 429 case in particular must cost exactly one call, not three.
      expect(mock.calls).toHaveLength(1);
      expect(tracker.incrementSubrequests).toHaveBeenCalledTimes(1);
    });
  }

  it('returns an EMPTY ARRAY (never null) on 400 — a malformed query is a QUERY problem', async () => {
    const mock = installBitbucketFetchMock({
      codeSearchResponses: { status: 400, body: { error: { message: 'Invalid query', data: { key: 'search.query.invalid' } } } },
    });
    const { client } = createClient();

    const hits = await client.searchCode(WORKSPACE, REPO, 'AND OR NOT', 30);

    // If this ever becomes `null`, one bad query kills grep_repo for the whole run.
    expect(hits).not.toBeNull();
    expect(hits).toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });

  it('throws on 500 with the status on the error, so a real outage is never masked as "unsupported"', async () => {
    const mock = installBitbucketFetchMock({ codeSearchResponses: { status: 500, body: 'boom' } });
    const { client } = createClient();

    const call = client.searchCode(WORKSPACE, REPO, 'q', 30);
    await expect(call).rejects.toBeInstanceOf(BitbucketError);
    await expect(call).rejects.toMatchObject({ status: 500 });
    // Not retried either: one attempt, then the throw (T-35-12).
    expect(mock.calls).toHaveLength(1);
  });

  it('targets the workspace-scoped path with the repository qualifier URL-encoded into search_query (T-35-07)', async () => {
    const mock = installBitbucketFetchMock({ codeSearchResponses: { body: { values: [] } } });
    const { client } = createClient();

    await client.searchCode(WORKSPACE, REPO, 'handleWebhook payload', 30);

    expect(mock.calls[0].method).toBe('GET');
    expect(mock.calls[0].path.startsWith(`${SEARCH_PATH}?`)).toBe(true);
    // The qualifier is built from the PINNED repo slug the job already resolved and is never
    // model-supplied; the model's literal query is the only model-controlled part.
    expect(decodedSearchQuery(mock.calls[0].path)).toBe(`handleWebhook payload repo:${REPO}`);
    // Encoded on the wire, not raw — the space and the colon must both be percent-encoded.
    expect(mock.calls[0].path).toContain('search_query=handleWebhook%20payload%20repo%3Abackend');
  });

  it('sends an explicit pagelen clamped to the closed 1..100 range', async () => {
    for (const [maxHits, expected] of [[30, '30'], [0, '1'], [500, '100'], [100, '100'], [1, '1']] as const) {
      const mock = installBitbucketFetchMock({ codeSearchResponses: { body: { values: [] } } });
      const { client } = createClient();

      await client.searchCode(WORKSPACE, REPO, 'q', maxHits);

      // Explicit because the provider default is 10 — omitting it would silently cap grep at 10 hits.
      expect(pagelen(mock.calls[0].path)).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it('returns an empty array (never one hit) when maxHits is 0, even though pagelen clamps up to 1', async () => {
    installBitbucketFetchMock({ codeSearchResponses: { body: { values: [twoLineValue] } } });
    const { client } = createClient();

    // The pagelen clamp is a REQUEST-operand clamp and must not leak into the returned array length.
    await expect(client.searchCode(WORKSPACE, REPO, 'q', 0)).resolves.toEqual([]);
  });
});

// Phase 31 (WS-01): the finalize endpoint's input contract. Route-level acceptance (400 on an
// invalid payload) is covered end-to-end in test/add-bitbucket-workspace.spec.ts; these are the
// direct schema-boundary assertions the task's own acceptance criteria calls out.
describe('addBitbucketWorkspaceInputSchema', () => {
  const validInput = {
    workspace: 'acme',
    accessToken: 'tok',
    webhookSecret: 'whsec',
    selectedRepoSlugs: ['repo-a'],
  };

  it('accepts a valid finalize payload', () => {
    expect(addBitbucketWorkspaceInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects an empty selectedRepoSlugs array', () => {
    const result = addBitbucketWorkspaceInputSchema.safeParse({ ...validInput, selectedRepoSlugs: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a selectedRepoSlugs array over 500 entries', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `repo-${i}`);
    const result = addBitbucketWorkspaceInputSchema.safeParse({ ...validInput, selectedRepoSlugs: tooMany });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 500 selectedRepoSlugs entries (boundary)', () => {
    const exactly500 = Array.from({ length: 500 }, (_, i) => `repo-${i}`);
    const result = addBitbucketWorkspaceInputSchema.safeParse({ ...validInput, selectedRepoSlugs: exactly500 });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key (strict)', () => {
    const result = addBitbucketWorkspaceInputSchema.safeParse({ ...validInput, extra: 'nope' });
    expect(result.success).toBe(false);
  });
});
