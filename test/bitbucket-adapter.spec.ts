import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import {
  BitbucketClient,
  BitbucketError,
  createBitbucketBotIdentityResolver,
} from '@server/core/bitbucket';
import { parseUnifiedDiff } from '@server/core/diff';
import { logger } from '@server/core/logger';
import { createTestEnv } from './helpers';
import {
  BITBUCKET_FIXTURE_ACCOUNT_ID,
  BITBUCKET_FIXTURE_DISPLAY_NAME,
  BITBUCKET_FIXTURE_NICKNAME,
  expectBitbucketPut,
  installBitbucketFetchMock,
} from './bitbucket-fetch-mock';
import type { VcsSubmitReviewInput } from '@server/vcs/types';
import type { ParsedReviewComment } from '@shared/schema';

const WORKSPACE = 'acme';
const REPO = 'backend';
const PR_NUMBER = 42;
const COMMIT_SHA = 'head123';
const HEAD_SHA = COMMIT_SHA;

function buildJobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-bb-1',
    owner: WORKSPACE,
    repo: REPO,
    prNumber: PR_NUMBER,
    commitSha: COMMIT_SHA,
    headSha: HEAD_SHA,
    installationId: null,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: WORKSPACE,
    ...overrides,
  } as const;
}

// buildAdapter directly constructs an adapter with a stubbed client (the credential-read path is
// covered in test/vcs-service.spec.ts; this spec exercises the adapter's per-method contract).
type AdapterHandle = {
  adapter: BitbucketAdapter;
  client: BitbucketClient;
  env: ReturnType<typeof createTestEnv>;
  tracker: { incrementSubrequests: ReturnType<typeof vi.fn> };
};

function buildAdapter(env: ReturnType<typeof createTestEnv> = createTestEnv()): AdapterHandle {
  const tracker = { incrementSubrequests: vi.fn() };
  const client = new BitbucketClient(env, 'test-token-bearer', tracker);
  const job = buildJobFixture();
  // Pass-through constructor: the production code uses BitbucketAdapter.create() (async factory),
  // but the adapter's per-method contract is independent of credential reading, so we exercise the
  // private constructor shape via `as unknown as` once the class exists.
  const adapter = new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    job: ReturnType<typeof buildJobFixture>,
    tracker: { incrementSubrequests: ReturnType<typeof vi.fn> },
  ) => BitbucketAdapter)(env, client, job, tracker);
  return { adapter, client, env, tracker };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BitbucketAdapter (VcsProvider mapping)', () => {
  it('exposes name="bitbucket" (Bitbucket has no native PR labels)', () => {
    const { adapter } = buildAdapter();
    expect(adapter.name).toBe('bitbucket');
  });

  it('flattens the Bitbucket PR shape into VcsPullRequest (headSha=source.commit.hash, baseSha=destination.commit.hash)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();
    const pr = await adapter.getPullRequest(WORKSPACE, REPO, PR_NUMBER);
    expect(pr).toEqual({
      number: PR_NUMBER,
      title: 'Add Bitbucket support',
      body: 'Review Bitbucket pull requests.',
      draft: false,
      headSha: 'head123',
      headRef: 'feature/bitbucket',
      baseSha: 'base123',
      baseRef: 'main',
      authorLogin: 'alice',
    });
    expect(mock.calls[0].path).toBe(`/2.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${PR_NUMBER}`);
  });

  it('delegates getPullRequestDiff to BitbucketClient', async () => {
    const mock = installBitbucketFetchMock({
      getPullRequestDiffResponse: {
        body: 'diff --git a/src/foo.ts b/src/foo.ts\n+const added = true;\n',
        headers: { 'content-type': 'text/plain' },
      },
    });
    const { adapter } = buildAdapter();
    const diff = await adapter.getPullRequestDiff(WORKSPACE, REPO, PR_NUMBER);
    expect(diff).toContain('+const added = true;');
    expect(mock.calls[0].path).toBe(`/2.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${PR_NUMBER}/diff?context=3`);
  });

  it('createStatusCheck PUTs a Code Insights report with REPORT_TYPE=BUG, result=PASSED, returns { ref: "codra-review" }', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const { ref } = await adapter.createStatusCheck(WORKSPACE, REPO, {
      headSha: HEAD_SHA,
      title: 'Review queued',
      summary: 'Codra has started reviewing this pull request.',
    });

    expect(ref).toBe('codra-review');
    const put = mock.calls.find((call) => call.method === 'PUT' && call.path.includes('/reports/codra-review'));
    expect(put).toBeDefined();
    expect(put?.body).toMatchObject({
      title: 'Review queued',
      details: 'Codra has started reviewing this pull request.',
      report_type: 'BUG',
      result: 'PASSED',
    });
  });

  it('updateStatusCheck PUTs the report THEN POSTs the build status with key="codra-review" (regardless of ref)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'something-else', {
      title: 'LGTM',
      summary: 'No issues',
      status: 'completed',
      conclusion: 'success',
    });

    // PUT report happens first.
    const put = mock.calls.find((call) => call.method === 'PUT' && call.path.includes('/reports/codra-review'));
    expect(put).toBeDefined();
    expect(put?.body).toMatchObject({ result: 'PASSED', title: 'LGTM' });

    // POST build status uses HARDCODED key='codra-review' regardless of ref argument (REV-M-10).
    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post).toBeDefined();
    expect(post?.body).toMatchObject({
      key: 'codra-review',
      state: 'SUCCESSFUL',
      description: 'LGTM',
    });
    // POST comes AFTER PUT.
    const putIndex = mock.calls.indexOf(put!);
    const postIndex = mock.calls.indexOf(post!);
    expect(putIndex).toBeLessThan(postIndex);
  });

  it('updateStatusCheck maps verdict="comment" (conclusion="neutral") to SUCCESSFUL (NOT INPROGRESS — the antigravity merge-blocking bug)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'codra-review', {
      title: 'Comments posted',
      summary: 'No blocking findings',
      status: 'completed',
      conclusion: 'neutral',
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post?.body).toMatchObject({
      key: 'codra-review',
      state: 'SUCCESSFUL',
      description: 'Comments posted',
    });
    expect(post?.body).not.toMatchObject({ state: 'INPROGRESS' });
  });

  it('updateStatusCheck maps conclusion="failure" to FAILED', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'codra-review', {
      title: 'Review failed',
      summary: 'Something blew up',
      status: 'completed',
      conclusion: 'failure',
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post?.body).toMatchObject({ state: 'FAILED', description: 'Review failed' });
  });

  it('updateStatusCheck maps status="in_progress" to INPROGRESS', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'codra-review', {
      title: 'Reviewing',
      summary: 'in flight',
      status: 'in_progress',
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post?.body).toMatchObject({ state: 'INPROGRESS' });
  });

  it('submitReview posts the combined marker+summary as the FINAL comment (REV-R-A)', async () => {
    const mock = installBitbucketFetchMock({
      postPullRequestCommentResponses: [
        { status: 201, body: { id: 100 } }, // inline comment
        { status: 201, body: { id: 101 } }, // combined marker+summary
      ],
      listPullRequestCommentsResponse: { body: { values: [] } },
    });
    const { adapter, env } = buildAdapter();
    // Seed the diff cache so submitReview can translate position=3 to a valid anchor.
    const seededDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..890abcd 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,3 @@',
      ' context',
      '+added1',
      '+added2',
    ].join('\n');
    await env.APP_KV.put(`diff:${(adapter as unknown as { job: { id: string } }).job.id}`, seededDiff);

    const input: VcsSubmitReviewInput = {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Looks mostly good',
      jobIdHint: 'job-bb-1',
      comments: [
        { path: 'src/foo.ts', position: 3, body: 'first inline comment' },
      ],
    };

    const { ref } = await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, input);
    expect(ref).toBe('101');

    const commentPosts = mock.calls.filter(
      (call) => call.method === 'POST' && call.path.includes('/pullrequests/') && call.path.endsWith('/comments'),
    );
    expect(commentPosts).toHaveLength(2);

    // The LAST post is the summary with the clean Bitbucket dedup footer (Thread C): no
    // GitHub-flavored HTML marker (`<!-- ... -->`) and no `<sub>` — both render as junk on Bitbucket.
    const combined = commentPosts[commentPosts.length - 1];
    const raw = (combined.body as { content: { raw: string } }).content.raw;
    expect(raw).toContain('codra-review · reviewed commit `head123`');
    expect(raw).not.toContain('<!--');
    expect(raw).not.toContain('<sub>');
    expect(raw).toContain('Looks mostly good');
    // The summary body comes first; the dedup footer is appended last.
    expect(raw.indexOf('Looks mostly good')).toBeLessThan(raw.indexOf('codra-review · reviewed commit'));

    // The first post is the inline comment, with the file/line anchor.
    const inline = commentPosts[0];
    expect(inline.body).toMatchObject({
      content: { raw: 'first inline comment' },
      inline: { path: 'src/foo.ts', to: 3 },
    });
  });

  it('submitReview skips an inline comment when a matching one already exists in the dedup set (REV-R-A dedup)', async () => {
    // Seed listPullRequestComments with an existing comment matching the proposed one. The
    // existing comment's `inline: { to }` (no `from`) makes buildDedupIndex infer line_type
    // 'added' -- the diff below is seeded so the freshly-computed anchor for position 2 (an
    // ADDED line) matches that same inferred line_type, so the dedup match actually engages
    // (rather than passing only because the anchor itself failed to resolve).
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: {
          values: [
            {
              id: 999,
              content: { raw: 'first inline comment' },
              inline: { path: 'src/foo.ts', to: 2 },
              links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42/_/diff#comment-999' } },
            },
          ],
        },
      },
      postPullRequestCommentResponses: [
        // Only the combined marker+summary is posted.
        { status: 201, body: { id: 200 } },
      ],
    });
    const { adapter, env } = buildAdapter();
    const seededDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..890abcd 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' context',
      '+added1',
    ].join('\n');
    await env.APP_KV.put(`diff:${(adapter as unknown as { job: { id: string } }).job.id}`, seededDiff);

    const result = await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Looks good',
      jobIdHint: 'job-bb-1',
      comments: [
        // Position 2 = the '+added1' line (newLineNumber=2, kind='add').
        { path: 'src/foo.ts', position: 2, body: 'first inline comment' },
      ],
    });
    expect(result.ref).toBe('200');

    // Only one POST: the combined marker+summary. The duplicate inline was skipped.
    const commentPosts = mock.calls.filter(
      (call) => call.method === 'POST' && call.path.includes('/comments'),
    );
    expect(commentPosts).toHaveLength(1);

    // Phase 30 (ANNO-01, D-11/Pitfall 1): the dedup-matched branch still populates
    // postedComments with a link -- proving a re-review round's already-existing comments are
    // not silently dropped from the join postAnnotations depends on.
    expect(result.postedComments).toEqual([
      {
        path: 'src/foo.ts',
        line: 2,
        body: 'first inline comment',
        link: 'https://bitbucket.org/acme/backend/pull-requests/42/_/diff#comment-999',
      },
    ]);
  });

  it('submitReview populates postedComments with a link for a freshly-posted inline comment', async () => {
    const mock = installBitbucketFetchMock({
      postPullRequestCommentResponses: [
        {
          status: 201,
          body: { id: 100, links: { html: { href: 'https://bitbucket.org/acme/backend/pull-requests/42/_/diff#comment-100' } } },
        },
        { status: 201, body: { id: 101 } }, // combined marker+summary
      ],
      listPullRequestCommentsResponse: { body: { values: [] } },
    });
    const { adapter, env } = buildAdapter();
    const seededDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..890abcd 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,3 @@',
      ' context',
      '+added1',
      '+added2',
    ].join('\n');
    await env.APP_KV.put(`diff:${(adapter as unknown as { job: { id: string } }).job.id}`, seededDiff);

    const result = await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Looks mostly good',
      jobIdHint: 'job-bb-1',
      comments: [
        { path: 'src/foo.ts', position: 3, body: 'first inline comment' },
      ],
    });

    void mock;
    expect(result.postedComments).toEqual([
      {
        path: 'src/foo.ts',
        line: 3,
        body: 'first inline comment',
        link: 'https://bitbucket.org/acme/backend/pull-requests/42/_/diff#comment-100',
      },
    ]);
  });

  it('submitReview calls approvePullRequest ONLY when verdict === "approve"', async () => {
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: { body: { values: [] } },
      postPullRequestCommentResponses: [
        { status: 201, body: { id: 300 } },
      ],
    });
    const { adapter } = buildAdapter();

    await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Just notes',
      jobIdHint: 'job-bb-1',
      comments: [],
    });

    const approve = mock.calls.find((call) => call.method === 'POST' && call.path.endsWith('/approve'));
    expect(approve).toBeUndefined();

    // Now verify the approve path IS taken for verdict === 'approve'.
    const mock2 = installBitbucketFetchMock({
      listPullRequestCommentsResponse: { body: { values: [] } },
      postPullRequestCommentResponses: [{ status: 201, body: { id: 400 } }],
    });
    const adapter2 = buildAdapter().adapter;
    await adapter2.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'approve',
      summaryBody: 'LGTM',
      jobIdHint: 'job-bb-1',
      comments: [],
    });
    const approve2 = mock2.calls.find((call) => call.method === 'POST' && call.path.endsWith('/approve'));
    expect(approve2).toBeDefined();
  });

  it('findExistingReviewForCommit lists comments and filters for the codra-review footer with the commit substring', async () => {
    const matchingId = 555;
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: {
          values: [
            { id: 100, content: { raw: 'unrelated comment' }, inline: undefined },
            {
              id: matchingId,
              content: {
                raw: `Looks good\n\n---\n\ncodra-review · reviewed commit \`${COMMIT_SHA}\``,
              },
              inline: undefined,
            },
          ],
        },
      },
    });
    const { adapter } = buildAdapter();

    const result = await adapter.findExistingReviewForCommit(WORKSPACE, REPO, PR_NUMBER, COMMIT_SHA);
    expect(result).toEqual({ ref: String(matchingId) });
    expect(mock.calls[0].path).toContain(`/pullrequests/${PR_NUMBER}/comments?pagelen=100`);
  });

  it('findExistingReviewForCommit returns null when no marker comment is found', async () => {
    installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: { values: [{ id: 1, content: { raw: 'unrelated' }, inline: undefined }] },
      },
    });
    const { adapter } = buildAdapter();

    const result = await adapter.findExistingReviewForCommit(WORKSPACE, REPO, PR_NUMBER, COMMIT_SHA);
    expect(result).toBeNull();
  });

  it('translates VcsReviewComment.position to Bitbucket inline anchor by walking the parsed FileDiff', async () => {
    // The diff has two hunks, with positions accumulating across hunks (parseUnifiedDiff
    // increments position globally per file). After parseUnifiedDiff we get:
    //   - hunk 1 (@@ -1,1 +1,2 @@): context pos=1 (newLine=1); added pos=2 (newLine=2)
    //   - hunk 2 (@@ -5,1 +6,2 @@): deleted pos=3 (oldLine=5); context pos=4 (newLine=6); added pos=5 (newLine=7)
    // The walk searches flattened hunk lines for `line.position === comment.position` (uniform).
    const rawDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..890abcd 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' context',
      '+added',
      '@@ -5,1 +6,2 @@',
      '-deleted',
      ' contextA',
      '+addedB',
    ].join('\n');
    const files = parseUnifiedDiff(rawDiff);
    expect(files).toHaveLength(1);
    // Seed the diff cache so submitReview can walk it.
    const { adapter, env } = buildAdapter();
    await env.APP_KV.put(`diff:${(adapter as unknown as { job: { id: string } }).job.id}`, rawDiff);

    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: { body: { values: [] } },
      postPullRequestCommentResponses: [
        { status: 201, body: { id: 501 } },
        { status: 201, body: { id: 502 } },
        { status: 201, body: { id: 503 } },
      ],
    });

    await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'notes',
      jobIdHint: 'job-bb-1',
      comments: [
        { path: 'src/foo.ts', position: 2, body: 'added line note' },
        { path: 'src/foo.ts', position: 3, body: 'removed line note' },
        { path: 'src/foo.ts', position: 5, body: 'addedB note' },
      ],
    });

    // Find each comment's POST. The inline posts are interleaved with the list-comments call,
    // so filter for inline posts (the ones with `inline` in body).
    const inlinePosts = mock.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/comments') && (call.body as { inline?: unknown })?.inline !== undefined,
    );
    expect(inlinePosts).toHaveLength(3);

    // Position 2 -> newLineNumber=2 (to=2, line_type='added').
    expect(inlinePosts[0].body).toMatchObject({
      content: { raw: 'added line note' },
      inline: { path: 'src/foo.ts', to: 2 },
    });

    // Position 3 -> oldLineNumber=5 (from=5, line_type='removed') via R-03 inverse mapping.
    expect(inlinePosts[1].body).toMatchObject({
      content: { raw: 'removed line note' },
      inline: { path: 'src/foo.ts', from: 5 },
    });

    // Position 5 -> newLineNumber=7 (to=7, line_type='added').
    expect(inlinePosts[2].body).toMatchObject({
      content: { raw: 'addedB note' },
      inline: { path: 'src/foo.ts', to: 7 },
    });
  });

  it('createPrComment posts a content-only comment and returns { ref: "<prNumber>:<commentId>" }', async () => {
    const mock = installBitbucketFetchMock({
      postPullRequestCommentResponses: [{ status: 201, body: { id: 8 } }],
    });
    const { adapter } = buildAdapter();

    const result = await adapter.createPrComment(WORKSPACE, REPO, PR_NUMBER, 'Standalone note');
    expect(result).toEqual({ ref: `${PR_NUMBER}:8` });

    const post = mock.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith(`/pullrequests/${PR_NUMBER}/comments`),
    );
    expect(post?.body).toEqual({ content: { raw: 'Standalone note' } });
  });

  it('replyToPrComment posts { content: { raw }, parent: { id } } with parent.id the bare decoded integer and returns { ref: "<prNumber>:<newId>" } (D-01)', async () => {
    const mock = installBitbucketFetchMock({
      postPullRequestCommentResponses: [{ status: 201, body: { id: 9 } }],
    });
    const { adapter } = buildAdapter();

    const result = await adapter.replyToPrComment(WORKSPACE, REPO, PR_NUMBER, 'A threaded reply', `${PR_NUMBER}:1997`);
    // The new comment's ref self-encodes the PR id with the reply's own id.
    expect(result).toEqual({ ref: `${PR_NUMBER}:9` });

    const post = mock.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith(`/pullrequests/${PR_NUMBER}/comments`),
    );
    // parent.id is the BARE integer decoded from the opaque `${PR}:${commentId}` ref, never the string.
    expect(post?.body).toEqual({ content: { raw: 'A threaded reply' }, parent: { id: 1997 } });
    expect(typeof (post?.body as { parent: { id: unknown } }).parent.id).toBe('number');
  });

  it('replyToPrComment rejects a malformed opaque ref before any request (T-12-01-1)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    for (const ref of ['42', '42:', 'x:y', '42:1:2']) {
      await expect(adapter.replyToPrComment(WORKSPACE, REPO, PR_NUMBER, 'reply', ref)).rejects.toThrow();
    }
    // No HTTP request was issued for any malformed ref (rejected pre-request).
    expect(mock.calls).toHaveLength(0);
  });

  it('replyToPrComment throws before any request when the decoded prId != the target prNumber (T-12-01-4)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    // ref "43:1997" decodes prId=43 but the target PR is 42 — the encoded PR component must match.
    await expect(adapter.replyToPrComment(WORKSPACE, REPO, PR_NUMBER, 'reply', `43:1997`)).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
  });

  it('editPrComment parses the ref, PUTs { content: { raw } }, and returns the same ref', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const result = await adapter.editPrComment(WORKSPACE, REPO, `${PR_NUMBER}:8`, 'Edited note');
    expect(result).toEqual({ ref: `${PR_NUMBER}:8` });

    expectBitbucketPut(mock.calls[0], `/2.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${PR_NUMBER}/comments/8`);
    expect(mock.calls[0].body).toEqual({ content: { raw: 'Edited note' } });
  });

  it('editPrComment returns null when the comment is gone (404)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 404, body: { error: { message: 'Not found' } } }],
    });
    const { adapter } = buildAdapter();

    await expect(adapter.editPrComment(WORKSPACE, REPO, `${PR_NUMBER}:8`, 'Edited note')).resolves.toBeNull();
  });

  it('editPrComment returns null when the comment is gone (410)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 410, body: { error: { message: 'Gone' } } }],
    });
    const { adapter } = buildAdapter();

    await expect(adapter.editPrComment(WORKSPACE, REPO, `${PR_NUMBER}:8`, 'Edited note')).resolves.toBeNull();
  });

  it('editPrComment throws BitbucketError on a non-gone status (403)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 403, body: { error: { message: 'Forbidden' } } }],
    });
    const { adapter } = buildAdapter();

    const request = adapter.editPrComment(WORKSPACE, REPO, `${PR_NUMBER}:8`, 'Edited note');
    await expect(request).rejects.toBeInstanceOf(BitbucketError);
    await expect(request).rejects.toMatchObject({ status: 403 });
  });

  it('editPrComment rejects malformed refs before any request', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const malformed = ['42:', '42:8:extra', '4.2:8', '42:8x', 'abc:8', '', '0:8', '42:0'];
    for (const ref of malformed) {
      await expect(adapter.editPrComment(WORKSPACE, REPO, ref, 'Edited note')).rejects.toThrow(/Invalid Bitbucket comment ref/);
    }
    // No HTTP request was issued for any malformed ref (rejected pre-request, review F4).
    expect(mock.calls).toHaveLength(0);
  });

  it('listPrComments maps author.id from the immutable account_id, never the nickname/display_name', async () => {
    installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const comments = await adapter.listPrComments(WORKSPACE, REPO, PR_NUMBER);
    expect(comments).toEqual([
      {
        ref: `${PR_NUMBER}:7`,
        body: 'Existing comment',
        author: { id: BITBUCKET_FIXTURE_ACCOUNT_ID, login: BITBUCKET_FIXTURE_NICKNAME },
      },
    ]);
    // author.id is the account_id, NOT the renameable handle.
    expect(comments[0].author.id).not.toBe(BITBUCKET_FIXTURE_NICKNAME);
    expect(comments[0].author.id).not.toBe(BITBUCKET_FIXTURE_DISPLAY_NAME);
  });

  it('getUserRepoPermission maps the effective permission on 200, keyed strictly on account_id', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: [
        {
          status: 200,
          body: {
            values: [
              { permission: 'write', user: { account_id: BITBUCKET_FIXTURE_ACCOUNT_ID } },
            ],
          },
        },
      ],
    });
    const { adapter } = buildAdapter();

    const result = await adapter.getUserRepoPermission(WORKSPACE, REPO, BITBUCKET_FIXTURE_ACCOUNT_ID, BITBUCKET_FIXTURE_NICKNAME);
    expect(result).toBe('write');
    // The read keys on the immutable account_id in the query, never the nickname.
    expect(mock.calls[0].path).toContain('/permissions/repositories/');
    expect(mock.calls[0].path).toContain(encodeURIComponent(`user.account_id="${BITBUCKET_FIXTURE_ACCOUNT_ID}"`));
  });

  it('getUserRepoPermission returns null on a 403 (repository access tokens cannot query permissions — A1, no membership fallback)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 403, body: { error: { message: 'Forbidden' } } }],
    });
    const { adapter } = buildAdapter();

    const result = await adapter.getUserRepoPermission(WORKSPACE, REPO, BITBUCKET_FIXTURE_ACCOUNT_ID, BITBUCKET_FIXTURE_NICKNAME);
    // NEVER maps membership → write; a 403 fails closed to null (defer to the allow-list).
    expect(result).toBeNull();
  });

  it('getUserRepoPermission returns null when the account_id is not in the results (non-member)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 200, body: { values: [] } }],
    });
    const { adapter } = buildAdapter();

    const result = await adapter.getUserRepoPermission(WORKSPACE, REPO, BITBUCKET_FIXTURE_ACCOUNT_ID, BITBUCKET_FIXTURE_NICKNAME);
    expect(result).toBeNull();
  });

  it('getUserRepoPermission returns null on a 404 (fail-closed)', async () => {
    installBitbucketFetchMock({
      responseSequence: [{ status: 404, body: { error: { message: 'Not found' } } }],
    });
    const { adapter } = buildAdapter();

    const result = await adapter.getUserRepoPermission(WORKSPACE, REPO, BITBUCKET_FIXTURE_ACCOUNT_ID);
    expect(result).toBeNull();
  });

  it('createBitbucketBotIdentityResolver resolves the immutable account_id via GET /2.0/user', async () => {
    const mock = installBitbucketFetchMock({
      responseSequence: [
        {
          status: 200,
          body: {
            account_id: BITBUCKET_FIXTURE_ACCOUNT_ID,
            nickname: BITBUCKET_FIXTURE_NICKNAME,
            display_name: BITBUCKET_FIXTURE_DISPLAY_NAME,
          },
        },
      ],
    });
    const { client } = buildAdapter();
    const resolver = createBitbucketBotIdentityResolver(client);

    const identity = await resolver.resolveIdentity();
    expect(identity.accountId).toBe(BITBUCKET_FIXTURE_ACCOUNT_ID);
    expect(identity.accountId).not.toBe('');
    // login is the renameable nickname, never the immutable account_id.
    expect(identity.login).toBe(BITBUCKET_FIXTURE_NICKNAME);
    expect(mock.calls[0].path).toBe('/2.0/user');
  });

  it('listPrComments OMITS a comment with a missing account_id (never surfaces author.id "")', async () => {
    installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: {
          values: [
            {
              id: 7,
              content: { raw: 'authored comment' },
              user: {
                account_id: BITBUCKET_FIXTURE_ACCOUNT_ID,
                nickname: BITBUCKET_FIXTURE_NICKNAME,
                display_name: BITBUCKET_FIXTURE_DISPLAY_NAME,
              },
            },
            // A user-less comment (e.g. a deleted/anonymized author): no immutable id -> OMITTED.
            { id: 8, content: { raw: 'author-less comment' } },
          ],
        },
      },
    });
    const { adapter } = buildAdapter();

    const comments = await adapter.listPrComments(WORKSPACE, REPO, PR_NUMBER);
    expect(comments).toHaveLength(1);
    expect(comments[0].ref).toBe(`${PR_NUMBER}:7`);
    expect(comments.every((c) => c.author.id !== '')).toBe(true);
  });
});

// Phase 30 (ANNO-01): BitbucketAdapter.postAnnotations — bulk-create-or-replace the dedicated
// Code Insights annotation report mirroring the exact set of findings already posted as inline
// comments (D-07/D-08). Every automated test here mocks the delete-then-recreate cascade as
// given (D-09) — Assumption A1 (report-delete cascades to its annotations) is a phase-blocking
// live-API check, tracked in this plan's Task 3 <human-check>, not exercised by these mocks.
describe('BitbucketAdapter.postAnnotations (ANNO-01)', () => {
  function buildFinding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
    return {
      path: 'src/foo.ts',
      line: 10,
      severity: 'P1',
      category: 'security',
      title: 'Missing input validation',
      body: 'Detailed finding body',
      ...overrides,
    };
  }

  it('DELETEs then PUTs the dedicated report then bulk-POSTs the built annotations, in that order', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      findings: [buildFinding()],
    });

    const del = mock.calls.find((call) => call.method === 'DELETE' && call.path.includes('/reports/codra-annotations'));
    const put = mock.calls.find((call) => call.method === 'PUT' && call.path.includes('/reports/codra-annotations'));
    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/reports/codra-annotations/annotations'));
    expect(del).toBeDefined();
    expect(put).toBeDefined();
    expect(post).toBeDefined();

    const delIndex = mock.calls.indexOf(del!);
    const putIndex = mock.calls.indexOf(put!);
    const postIndex = mock.calls.indexOf(post!);
    expect(delIndex).toBeLessThan(putIndex);
    expect(putIndex).toBeLessThan(postIndex);

    expect(put?.body).toMatchObject({
      title: 'Codra Annotations',
      report_type: 'BUG',
      result: 'PASSED',
    });
  });

  it('maps P0/P1/P2/P3/nit findings to CRITICAL/HIGH/MEDIUM/LOW severities', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const findings = [
      buildFinding({ severity: 'P0', line: 1 }),
      buildFinding({ severity: 'P1', line: 2 }),
      buildFinding({ severity: 'P2', line: 3 }),
      buildFinding({ severity: 'P3', line: 4 }),
      buildFinding({ severity: 'nit', line: 5 }),
    ];
    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, { commitSha: COMMIT_SHA, findings });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/annotations'));
    const body = post?.body as Array<{ severity: string }>;
    expect(body.map((a) => a.severity)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'LOW']);
  });

  it('the annotation report result is ALWAYS PASSED regardless of finding severity', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const findings = [
      buildFinding({ severity: 'P0', line: 1 }),
      buildFinding({ severity: 'P0', line: 2 }),
    ];
    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, { commitSha: COMMIT_SHA, findings });

    const put = mock.calls.find((call) => call.method === 'PUT' && call.path.includes('/reports/codra-annotations'));
    expect(put?.body).toMatchObject({ result: 'PASSED' });
  });

  it('chunks annotations at 100 per POST', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const findings = Array.from({ length: 150 }, (_, i) => buildFinding({ line: i + 1, title: `Finding ${i}` }));
    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, { commitSha: COMMIT_SHA, findings });

    const posts = mock.calls.filter((call) => call.method === 'POST' && call.path.includes('/annotations'));
    expect(posts).toHaveLength(2);
    expect((posts[0].body as unknown[]).length).toBe(100);
    expect((posts[1].body as unknown[]).length).toBe(50);
  });

  it('annotation titles equal the raw finding title verbatim, with no additional metadata', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const distinctiveTitle = 'SQL injection via unsanitized query parameter `id`';
    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      findings: [buildFinding({ title: distinctiveTitle })],
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/annotations'));
    const body = post?.body as Array<{ title: string; summary: string }>;
    expect(body[0].title).toBe(distinctiveTitle);
    expect(body[0].summary).toBe(distinctiveTitle);
  });

  it('a finding matching a postedComments entry gets its link; an unmatched finding omits link entirely', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      findings: [
        buildFinding({ path: 'src/foo.ts', line: 10 }),
        buildFinding({ path: 'src/bar.ts', line: 20 }),
      ],
      postedComments: [
        { path: 'src/foo.ts', line: 10, body: 'first inline comment', link: 'https://bitbucket.org/acme/backend/pull-requests/42/_/diff#comment-1' },
      ],
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/annotations'));
    const body = post?.body as Array<{ path: string; link?: string }>;
    const matched = body.find((a) => a.path === 'src/foo.ts');
    const unmatched = body.find((a) => a.path === 'src/bar.ts');
    expect(matched?.link).toBe('https://bitbucket.org/acme/backend/pull-requests/42/_/diff#comment-1');
    expect(unmatched).not.toHaveProperty('link');
  });

  it('two findings sharing path+line+category but different titles get DISTINCT external_ids', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      findings: [
        buildFinding({ path: 'src/foo.ts', line: 10, category: 'security', title: 'First P0 on this line' }),
        buildFinding({ path: 'src/foo.ts', line: 10, category: 'security', title: 'Second P0 on this line' }),
      ],
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/annotations'));
    const body = post?.body as Array<{ external_id: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].external_id).not.toBe(body[1].external_id);
  });

  it('two consecutive calls each independently delete-then-recreate (no client-side accumulation across rounds)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      findings: [buildFinding({ path: 'src/round1.ts', line: 1, title: 'Round 1 finding' })],
    });
    await adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      findings: [buildFinding({ path: 'src/round2.ts', line: 2, title: 'Round 2 finding' })],
    });

    const posts = mock.calls.filter((call) => call.method === 'POST' && call.path.includes('/annotations'));
    expect(posts).toHaveLength(2);
    const secondBody = posts[1].body as Array<{ path?: string; title?: string }>;
    expect(secondBody).toHaveLength(1);
    expect(secondBody[0].path).toBe('src/round2.ts');
    expect(secondBody[0].title).toBe('Round 2 finding');
  });

  it('a failing chunk logs a warning naming the batch index before the error propagates', async () => {
    installBitbucketFetchMock({
      bulkUpsertAnnotationsResponse: { status: 500, body: { error: { message: 'boom' } } },
    });
    const { adapter } = buildAdapter();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const findings = Array.from({ length: 150 }, (_, i) => buildFinding({ line: i + 1, title: `Finding ${i}` }));
    await expect(
      adapter.postAnnotations(WORKSPACE, REPO, PR_NUMBER, { commitSha: COMMIT_SHA, findings }),
    ).rejects.toBeInstanceOf(BitbucketError);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('batch 0 of 2'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

// G-28-3 / NREG-02: Bitbucket has NO diff offset — it anchors inline comments by
// `inline.to ?? inline.from`, a LINE, on both the post and the read path. The adapter must therefore
// report `position: null` explicitly rather than omitting the field, so the enrichment lookup
// resolves Bitbucket on `review_comments.line` and never borrows GitHub's coordinate.
describe('BitbucketAdapter.getInlineCommentDetails (LRN-01 coordinate contract)', () => {
  it('returns the line from inline.to with position explicitly null', async () => {
    installBitbucketFetchMock({
      responseSequence: [
        {
          status: 200,
          body: {
            id: 77,
            inline: { path: 'src/server/core/commands.ts', to: 120, from: 118 },
            content: { raw: 'inline finding body' },
          },
        },
      ],
    });
    const { adapter } = buildAdapter();

    const details = await adapter.getInlineCommentDetails(WORKSPACE, REPO, PR_NUMBER, '77');
    expect(details).toEqual({
      path: 'src/server/core/commands.ts',
      line: 120,
      position: null,
      body: 'inline finding body',
    });
    // Explicit, not merely absent: `position` must be present and null.
    expect(details).toHaveProperty('position', null);
  });

  it('falls back to inline.from when inline.to is absent, still with position null', async () => {
    installBitbucketFetchMock({
      responseSequence: [
        {
          status: 200,
          body: {
            id: 78,
            inline: { path: 'src/server/db/reject-feedback.ts', from: 96 },
            content: { raw: 'deleted-side finding' },
          },
        },
      ],
    });
    const { adapter } = buildAdapter();

    const details = await adapter.getInlineCommentDetails(WORKSPACE, REPO, PR_NUMBER, '78');
    expect(details).toEqual({
      path: 'src/server/db/reject-feedback.ts',
      line: 96,
      position: null,
      body: 'deleted-side finding',
    });
  });

  it('returns null for a comment with no inline object (a general PR comment)', async () => {
    installBitbucketFetchMock({
      responseSequence: [
        { status: 200, body: { id: 79, content: { raw: 'just a top-level comment' } } },
      ],
    });
    const { adapter } = buildAdapter();

    expect(await adapter.getInlineCommentDetails(WORKSPACE, REPO, PR_NUMBER, '79')).toBeNull();
  });
});