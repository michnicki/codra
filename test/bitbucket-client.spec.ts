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
    installBitbucketFetchMock({
      deleteCodeInsightsReportResponse: { status: 500, body: { error: { message: 'Internal error' } } },
    });
    const { client } = createClient();

    const request = client.deleteCodeInsightsReport('acme', 'backend', 'head123', 'codra-annotations');
    await expect(request).rejects.toBeInstanceOf(BitbucketError);
    await expect(request).rejects.toMatchObject({ status: 500 });
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
