import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitbucketClient, BitbucketError } from '@server/core/bitbucket';
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
});
