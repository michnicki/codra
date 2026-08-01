import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { GitHubService } from '@server/services/github';
import { GitHubError, createGithubBotIdentityResolver } from '@server/core/github';
import { TokenTracker } from '@server/core/token-tracker';
import { logger } from '@server/core/logger';
import { createTestEnv, seedInstallationToken } from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';

const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUMBER = 42;
const INSTALLATION_ID = '123456';

function buildFixtures(overrides: Partial<Parameters<typeof installGitHubFetchMock>[0]> = {}) {
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

describe('GithubAdapter (VcsProvider mapping)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flattens the nested PR shape into a flat VcsPullRequest', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const pr = await adapter.getPullRequest(OWNER, REPO, PR_NUMBER);

      expect(pr).toEqual({
        number: PR_NUMBER,
        title: 'Test PR',
        body: 'Test body',
        draft: false,
        headSha: 'headsha1234567890',
        headRef: 'feature-branch',
        baseSha: 'basesha1234567890',
        baseRef: 'main',
        authorLogin: 'author-login',
      });
      // Not the nested GitHub shape.
      expect(pr).not.toHaveProperty('head');
      expect(pr).not.toHaveProperty('base');
      expect(pr).not.toHaveProperty('user');
    } finally {
      restore();
    }
  });

  it('round-trips the id<->ref conversion across createStatusCheck/updateStatusCheck', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const { ref } = await adapter.createStatusCheck(OWNER, REPO, {
        headSha: 'headsha1234567890',
        title: 'Review queued',
        summary: 'Codra is reviewing this PR',
      });

      // installGitHubFetchMock's check-runs POST always returns { id: 9001 }.
      expect(ref).toBe('9001');
      expect(Number(ref)).toBe(9001);

      await adapter.updateStatusCheck(OWNER, REPO, ref, {
        title: 'Review complete',
        summary: 'No issues found',
        status: 'completed',
        conclusion: 'success',
      });

      const patchCall = calls.find((call) => call.method === 'PATCH' && call.path.includes('/check-runs/'));
      expect(patchCall?.path).toBe(`/repos/${OWNER}/${REPO}/check-runs/${Number(ref)}`);
    } finally {
      restore();
    }
  });

  it('maps verdict to a GitHub review event and returns an opaque ref', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures({ reviewResponses: [{ status: 200, id: 777 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const { ref } = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'approve',
        summaryBody: 'Looks good',
        comments: [],
      });

      expect(ref).toBe('777');
      const reviewPost = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPost?.body.event).toBe('APPROVE');
    } finally {
      restore();
    }
  });

  it('maps a comment verdict to the COMMENT event', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [],
      });

      const reviewPost = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPost?.body.event).toBe('COMMENT');
    } finally {
      restore();
    }
  });

  // --- Phase 33 (FR-031, D-01): batch-422 per-comment fallback + skippedComments seam ---

  it('clean batch 200 posts once and omits skippedComments entirely (NREG-01)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures({ reviewResponses: [{ status: 200, id: 777 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [
          { path: 'src/a.ts', position: 2, body: 'a' },
          { path: 'src/b.ts', position: 4, body: 'b' },
        ],
      });

      expect(result.ref).toBe('777');
      // Exactly ONE POST to /reviews and ZERO posts to /pulls/{n}/comments on the clean path.
      const reviewPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      const commentPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`,
      );
      expect(reviewPosts).toHaveLength(1);
      expect(commentPosts).toHaveLength(0);
      expect(result).not.toHaveProperty('skippedComments');
    } finally {
      restore();
    }
  });

  it('batch 422 retries summary-only then posts each comment individually with a fixed 4-key body (FR-031)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({ reviewResponses: [{ status: 422 }, { status: 200, id: 777 }] }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [
          { path: 'src/a.ts', position: 2, body: 'a', title: 'finding a' },
          { path: 'src/b.ts', position: 4, body: 'b', title: 'finding b' },
        ],
      });

      const reviewPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPosts).toHaveLength(2);
      // The summary-only retry carries an empty comments array.
      expect(reviewPosts[1]?.body.comments).toEqual([]);

      const commentPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`,
      );
      expect(commentPosts).toHaveLength(2);
      // Per-comment wire body is EXACTLY { body, commit_id, path, position } -- no title key.
      expect(commentPosts[0]?.body).toEqual({
        body: 'a',
        commit_id: 'headsha1234567890',
        path: 'src/a.ts',
        position: 2,
      });
      expect(commentPosts[1]?.body).toEqual({
        body: 'b',
        commit_id: 'headsha1234567890',
        path: 'src/b.ts',
        position: 4,
      });
      expect(commentPosts[0]?.body).not.toHaveProperty('title');
      expect(commentPosts[1]?.body).not.toHaveProperty('title');

      expect(result.ref).toBe('777');
      // All per-comment posts succeeded -- no skips on the fallback path.
      expect(result).not.toHaveProperty('skippedComments');
    } finally {
      restore();
    }
  });

  it('per-comment 422 skips with a warning (no body in payload) and surfaces skippedComments', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({
        reviewResponses: [{ status: 422 }, { status: 200, id: 777 }],
        reviewCommentResponses: [{ status: 422 }, { status: 201, id: 1 }],
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [
          { path: 'src/a.ts', position: 2, body: 'a', title: 'finding a' },
          { path: 'src/b.ts', position: 4, body: 'b', title: 'finding b' },
        ],
      });

      // The 422'd comment (src/a.ts) is skipped; the other comment's POST still records 201.
      // WR-01: 2 is a DIFF POSITION, so it lands in `position` and `line` stays null. Reporting it
      // as `line: 2` made the audit trail claim a head-side line the finding was never on (G-28-3).
      expect(result).toEqual({
        ref: '777',
        skippedComments: [{ path: 'src/a.ts', line: null, position: 2, title: 'finding a' }],
      });
      const commentPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`,
      );
      expect(commentPosts).toHaveLength(2);
      expect(commentPosts[1]?.body.path).toBe('src/b.ts');

      // One warn for the skipped comment with path/position/title and NO body key.
      const skipWarn = warnSpy.mock.calls.find(([message]) =>
        String(message).includes('per-comment review comment failed with 422'),
      );
      expect(skipWarn).toBeDefined();
      const payload = skipWarn?.[1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        owner: OWNER,
        repo: REPO,
        pullNumber: PR_NUMBER,
        path: 'src/a.ts',
        position: 2,
        // WR-05: the RAW model-supplied title must never reach the log sink. redactFindingTitle
        // exists because jobs.audit can never retain title content, and the logger's redaction
        // list does not cover `title` -- so logging it verbatim put exactly the value the audit
        // trail is forbidden to store into the logs.
        title: '[title-redacted]',
        reason: 'unprocessable',
      });
      expect(payload.title).not.toBe('finding a');
      expect(payload).not.toHaveProperty('body');
    } finally {
      warnSpy.mockRestore();
      restore();
    }
  });

  // CR-02: the per-comment fallback loop used to live INSIDE createReview's withRetry, so one
  // transient 5xx on the k-th per-comment POST replayed the whole operation -- a duplicate summary
  // review on the PR plus k-1 duplicate inline comments. Nothing in that replay is idempotent: the
  // GitHub path has no dedup index and the loop has no cursor. The retried unit must stay the
  // single /reviews POST.
  it('a transient 5xx on a per-comment POST does not replay the review or the already-posted comments (CR-02)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({
        // Enough scripted responses that a replay WOULD get a second 422 -> second summary post,
        // i.e. the bug would be plainly visible in the call log rather than masked by clamping.
        reviewResponses: [{ status: 422 }, { status: 200, id: 777 }, { status: 422 }, { status: 200, id: 778 }],
        reviewCommentResponses: [{ status: 201, id: 1 }, { status: 500 }],
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      // A non-422 per-comment failure still fails loud (D-01) -- it just must not be retried here.
      await expect(
        adapter.submitReview(OWNER, REPO, PR_NUMBER, {
          commitSha: 'headsha1234567890',
          verdict: 'comment',
          summaryBody: 'Some notes',
          comments: [
            { path: 'src/a.ts', position: 2, body: 'a', title: 'finding a' },
            { path: 'src/b.ts', position: 4, body: 'b', title: 'finding b' },
          ],
        }),
      ).rejects.toThrow();

      // EXACTLY two /reviews POSTs: the 422'd batch and the summary-only retry. A third would be
      // a duplicate summary review posted to the PR.
      const reviewPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPosts).toHaveLength(2);

      // src/a.ts posted exactly once. A second POST would be a duplicate inline comment.
      const aPosts = calls.filter(
        (call) =>
          call.method === 'POST' &&
          call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments` &&
          (call.body as { path?: string })?.path === 'src/a.ts',
      );
      expect(aPosts).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      restore();
    }
    // createReviewComment keeps its OWN inner retry (2 backoffs on a 5xx), which is safe because it
    // retries a single un-acknowledged POST -- but it makes this test wall-clock slow.
  }, 30_000);

  // WR-07: nothing exercised the SAFE_MARGIN budget guard in createReview's fallback loop, and the
  // VcsService factory signatures were too narrow to even carry `hasRemainingSafeBudget` into the
  // adapter -- so the guard could be dropped with no compile error and no failing test, leaving
  // `undefined === false` (i.e. the loop never stopping).
  it('the fallback loop stops on budget exhaustion and reports the remainder as skipped (WR-07)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({
        reviewResponses: [{ status: 422 }, { status: 200, id: 777 }],
        reviewCommentResponses: [{ status: 201, id: 1 }],
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      // Budget runs out after the FIRST per-comment post.
      let budgetCalls = 0;
      const tracker = {
        incrementSubrequests: () => {},
        hasRemainingSafeBudget: () => {
          budgetCalls += 1;
          return budgetCalls < 2;
        },
      };

      const adapter = new GithubAdapter(env, INSTALLATION_ID, tracker);
      const result = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [
          { path: 'src/a.ts', position: 2, body: 'a', title: 'finding a' },
          { path: 'src/b.ts', position: 4, body: 'b', title: 'finding b' },
          { path: 'src/c.ts', position: 6, body: 'c', title: 'finding c' },
        ],
      });

      // Only the first comment posted; the loop stopped rather than exhausting the invocation.
      const commentPosts = calls.filter(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`,
      );
      expect(commentPosts).toHaveLength(1);

      // The whole remainder is reported, so the audit trail can answer for every un-posted finding.
      expect(result.skippedComments).toEqual([
        { path: 'src/b.ts', line: null, position: 4, title: 'finding b' },
        { path: 'src/c.ts', line: null, position: 6, title: 'finding c' },
      ]);

      const budgetWarn = warnSpy.mock.calls.find(([message]) =>
        String(message).includes('subrequest budget exhausted'),
      );
      expect(budgetWarn).toBeDefined();
      expect(budgetWarn?.[1]).toMatchObject({ reason: 'budget_exhausted', remaining: 2 });
    } finally {
      warnSpy.mockRestore();
      restore();
    }
  });

  // WR-04: the batch body filtered position-less comments with `.filter((c) => c.position)` while
  // the fallback used `typeof c.position === 'number'` -- two predicates for one concept, in
  // disagreement on `position === 0`. Neither path recorded the dropped comments anywhere, so a
  // finding that never reached GitHub was unanswerable from the audit trail.
  it('a comment with no usable diff position is reported through skippedComments (WR-04)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures({ reviewResponses: [{ status: 200, id: 777 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [
          { path: 'src/a.ts', position: 2, body: 'a', title: 'finding a' },
          // position 0 is not a valid GitHub anchor (positions are 1-based) -- the two former
          // predicates disagreed on exactly this value.
          { path: 'src/zero.ts', position: 0, body: 'zero', title: 'finding zero' },
          { path: 'src/none.ts', body: 'none', title: 'finding none' },
        ],
      });

      expect(result.ref).toBe('777');
      // Only the positioned comment reaches the wire.
      const reviewPost = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPost?.body.comments).toEqual([{ path: 'src/a.ts', position: 2, body: 'a' }]);

      // Both un-anchorable comments are surfaced rather than vanishing.
      expect(result.skippedComments).toEqual([
        { path: 'src/zero.ts', line: null, position: null, title: 'finding zero' },
        { path: 'src/none.ts', line: null, position: null, title: 'finding none' },
      ]);
    } finally {
      restore();
    }
  });

  it('a per-comment non-422 failure rethrows GitHubError (the review fails loudly)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildFixtures({
        reviewResponses: [{ status: 422 }, { status: 200, id: 777 }],
        reviewCommentResponses: [{ status: 403 }],
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(
        adapter.submitReview(OWNER, REPO, PR_NUMBER, {
          commitSha: 'headsha1234567890',
          verdict: 'comment',
          summaryBody: 'Some notes',
          comments: [{ path: 'src/a.ts', position: 2, body: 'a' }],
        }),
      ).rejects.toBeInstanceOf(GitHubError);
    } finally {
      restore();
    }
  });

  it('reply POSTs never consume the per-comment script (route discrimination, REVIEWS R2/R11)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({
        reviewResponses: [{ status: 422 }, { status: 200, id: 777 }],
        reviewCommentResponses: [{ status: 422 }, { status: 201, id: 1 }],
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const reply = await adapter.replyToPrComment(OWNER, REPO, PR_NUMBER, 'a threaded reply', '1997');
      // The reply default id is still returned -- the script was not consumed.
      expect(reply).toEqual({ ref: '8002' });
      const replyPost = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`,
      );
      expect(replyPost?.body).toEqual({ body: 'a threaded reply', in_reply_to: 1997 });
    } finally {
      restore();
    }
  });

  // installGitHubFetchMock returns [] for the review-list lookup (github-fetch-mock.ts:88), so it
  // cannot prove the botLogin argument over the wire (review finding 3). Instead, spy on
  // GitHubService.prototype.findBotReviewForCommit directly and assert the argument the adapter
  // passes in equals env.BOT_USERNAME.
  it('injects env.BOT_USERNAME into findExistingReviewForCommit', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const spy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue(null);

    const adapter = new GithubAdapter(env, INSTALLATION_ID);
    const result = await adapter.findExistingReviewForCommit(OWNER, REPO, PR_NUMBER, 'headsha1234567890');

    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(OWNER, REPO, PR_NUMBER, 'headsha1234567890', env.BOT_USERNAME);
  });

  it('returns a ref when an existing bot review is found', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue({ id: 555 });

    const adapter = new GithubAdapter(env, INSTALLATION_ID);
    const result = await adapter.findExistingReviewForCommit(OWNER, REPO, PR_NUMBER, 'headsha1234567890');

    expect(result).toEqual({ ref: '555' });
  });

  it('forwards the tracker into GitHubService so the subrequest budget is preserved', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures());
    const tracker = new TokenTracker();

    try {
      expect(tracker.getSubrequestCount()).toBe(0);
      const adapter = new GithubAdapter(env, INSTALLATION_ID, tracker);
      await adapter.getPullRequest(OWNER, REPO, PR_NUMBER);

      // The adapter did not drop the tracker -- GitHubClient increments it internally for both
      // the installation-token lookup and the PR fetch (Pitfall 1).
      expect(tracker.getSubrequestCount()).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('delegates labels.ensure/add/removeIfPresent to the corresponding GitHubService calls', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      expect(adapter.labels).toBeDefined();

      await adapter.labels!.ensure(OWNER, REPO, 'codra-reviewed', '00ff00');
      await adapter.labels!.add(OWNER, REPO, PR_NUMBER, ['codra-reviewed']);
      await adapter.labels!.removeIfPresent(OWNER, REPO, PR_NUMBER, ['codra-reviewed']);

      expect(calls.some((call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/labels`)).toBe(true);
      expect(
        calls.some(
          (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/labels`,
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/labels/codra-reviewed`,
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it('createPrComment posts issues/{n}/comments with body { body } and returns the bare comment id as ref', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures({ commentId: 8001 }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.createPrComment(OWNER, REPO, PR_NUMBER, 'new comment text');

      // GitHub ref is the bare comment id (D-02).
      expect(result).toEqual({ ref: '8001' });
      const postCall = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`,
      );
      // Exact wire body is { body } (review F9).
      expect(postCall?.body).toEqual({ body: 'new comment text' });
    } finally {
      restore();
    }
  });

  it('replyToPrComment posts pulls/{n}/comments with in_reply_to as an integer and returns the reply id as ref (D-01, NREG-02)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({ commentId: 8001, replyCommentId: 8002 }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.replyToPrComment(OWNER, REPO, PR_NUMBER, 'a threaded reply', '1997');

      // GitHub reply ref is the bare comment id of the NEW reply (D-02).
      expect(result).toEqual({ ref: '8002' });
      const postCall = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`,
      );
      // The reply must hit the PULLS comments route, NOT the ISSUES comments route.
      expect(postCall).toBeDefined();
      expect(
        calls.some((call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`),
      ).toBe(false);
      // in_reply_to is the integer 1997 (not the string), and body carries the reply text.
      expect(postCall?.body).toEqual({ body: 'a threaded reply', in_reply_to: 1997 });
      expect(typeof postCall?.body.in_reply_to).toBe('number');
    } finally {
      restore();
    }
  });

  it('replyToPrComment throws before any request on a malformed inReplyToRef (T-12-01-2)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      for (const badRef of ['', '  12  ', '1.5', '-1', '0', '01']) {
        await expect(adapter.replyToPrComment(OWNER, REPO, PR_NUMBER, 'reply', badRef)).rejects.toThrow();
      }
      // No POST to the pulls-comments endpoint was ever issued (rejected before the client call).
      expect(
        calls.some((call) => call.method === 'POST' && call.path.includes(`/pulls/${PR_NUMBER}/comments`)),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it('editPrComment patches issues/comments/{id} with body { body } and returns the ref', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({ commentEditResponses: [{ status: 200, id: 8001 }] }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.editPrComment(OWNER, REPO, '8001', 'edited text');

      expect(result).toEqual({ ref: '8001' });
      const patchCall = calls.find(
        (call) => call.method === 'PATCH' && call.path === `/repos/${OWNER}/${REPO}/issues/comments/8001`,
      );
      // Exact wire body is { body } (review F9).
      expect(patchCall?.body).toEqual({ body: 'edited text' });
    } finally {
      restore();
    }
  });

  it('editPrComment returns null when the PATCH is 404 (gone comment, D-05)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures({ commentEditResponses: [{ status: 404 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.editPrComment(OWNER, REPO, '8001', 'edited text');
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it('editPrComment returns null when the PATCH is 410 Gone (amended D-05, review F3)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures({ commentEditResponses: [{ status: 410 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.editPrComment(OWNER, REPO, '8001', 'edited text');
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it('editPrComment THROWS GitHubError on a non-gone status (422) — it does NOT return null (review F9)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures({ commentEditResponses: [{ status: 422 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await expect(adapter.editPrComment(OWNER, REPO, '8001', 'edited text')).rejects.toBeInstanceOf(GitHubError);
    } finally {
      restore();
    }
  });

  it('editPrComment throws before any request on a malformed ref (review F4)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      for (const badRef of ['', '  ', '1.5', '1e3', '-1', '0']) {
        await expect(adapter.editPrComment(OWNER, REPO, badRef, 'edited text')).rejects.toThrow();
      }
      // No PATCH to the comments endpoint was ever issued (rejected before the client call).
      expect(calls.some((call) => call.method === 'PATCH' && call.path.includes('/issues/comments/'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('listPrComments maps author.id from the immutable numeric user.id, never the login (NREG-02, D-07)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildFixtures({
        commentListItems: [
          { id: 8001, body: 'existing comment body', user: { id: 424242, login: 'commenter-login' } },
        ],
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const comments = await adapter.listPrComments(OWNER, REPO, PR_NUMBER);

      expect(comments).toEqual([
        { ref: '8001', body: 'existing comment body', author: { id: '424242', login: 'commenter-login' } },
      ]);
      // author.id is the numeric user id as a string, NOT the login.
      expect(comments[0].author.id).toBe('424242');
      expect(comments[0].author.id).not.toBe('commenter-login');
    } finally {
      restore();
    }
  });

  it('getUserRepoPermission maps admin/write/read/none when the response user.id matches authorId', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);

    for (const permission of ['admin', 'write', 'read', 'none'] as const) {
      const { restore } = installGitHubFetchMock(
        buildFixtures({ permissionResponse: { permission, userId: 424242 } }),
      );
      try {
        const adapter = new GithubAdapter(env, INSTALLATION_ID);
        // authorId is the immutable numeric user id as a string; authorLogin only forms the URL.
        const result = await adapter.getUserRepoPermission(OWNER, REPO, '424242', 'commenter-login');
        expect(result).toBe(permission);
      } finally {
        restore();
      }
    }
  });

  it('getUserRepoPermission returns null on a 404 (not a collaborator), keyed on the immutable id', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures({ permissionResponse: { status: 404 } }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getUserRepoPermission(OWNER, REPO, '424242', 'commenter-login');
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it('getUserRepoPermission returns null on a 403 (token lacks access) — fail closed', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures({ permissionResponse: { status: 403 } }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getUserRepoPermission(OWNER, REPO, '424242', 'commenter-login');
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it('getUserRepoPermission returns null when the response user.id does NOT match authorId (login reassigned — fail closed)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    // The endpoint resolves the login to user.id 424242, but the webhook-paired immutable authorId
    // is 999 — a login/id mismatch (a renamed login now points at a different account) → null.
    const { restore } = installGitHubFetchMock(
      buildFixtures({ permissionResponse: { permission: 'admin', userId: 424242 } }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getUserRepoPermission(OWNER, REPO, '999', 'commenter-login');
      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it('getUserRepoPermission returns null when no authorLogin is supplied (cannot form the URL)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const result = await adapter.getUserRepoPermission(OWNER, REPO, '424242');
      expect(result).toBeNull();
      // No permission request was issued (rejected before any call).
      expect(calls.some((call) => call.path.includes('/collaborators/'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('createGithubBotIdentityResolver resolves a non-null immutable accountId from the bot user', async () => {
    // The resolver wraps GitHubClient.resolveBotUserIdentity; exercise it via a minimal stub so the
    // test does not depend on the live /users/{slug}[bot] route.
    const resolver = createGithubBotIdentityResolver({
      resolveBotUserIdentity: async () => ({ accountId: '191919', login: 'codraapp[bot]' }),
    });
    const identity = await resolver.resolveIdentity();
    expect(identity.accountId).toBe('191919');
    expect(identity.accountId).not.toBe('');
    expect(identity.login).toBe('codraapp[bot]');
  });

  it('listPrComments OMITS a comment with a missing/invalid author id (review F5)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildFixtures({
        commentListItems: [
          { id: 1, body: 'authored', user: { id: 111, login: 'real-login' } },
          { id: 2, body: 'user-less', user: null },
        ],
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const comments = await adapter.listPrComments(OWNER, REPO, PR_NUMBER);

      // Only the authored comment survives; the user-less one is omitted, never surfaced with a
      // false '' / 'undefined' id.
      expect(comments).toEqual([{ ref: '1', body: 'authored', author: { id: '111', login: 'real-login' } }]);
      expect(comments.every((c) => c.author.id !== '' && c.author.id !== 'undefined')).toBe(true);
    } finally {
      restore();
    }
  });
});

// G-28-3: GitHub posts inline comments by diff `position` (`createReview` sends
// `{ path, position, body }`), so the adapter MUST surface that position — the original `as` cast in
// `core/github.ts getReviewComment` silently dropped it, which made every GitHub reject enrich to
// NULL. This block runs the FULL chain (stubbed fetch -> GitHubClient -> GitHubService pass-through
// -> GithubAdapter) that the DB-level specs stub out, so re-dropping `position` fails here.
describe('getInlineCommentDetails (LRN-01 coordinate contract)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces the diff position alongside path/line/body', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildFixtures({
        reviewCommentResponse: {
          path: 'src/server/core/commands.ts',
          line: 364,
          position: 32,
          body: 'inline finding body',
        },
      }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const details = await adapter.getInlineCommentDetails(OWNER, REPO, PR_NUMBER, '900123');

      expect(details).toEqual({
        path: 'src/server/core/commands.ts',
        line: 364,
        position: 32,
        body: 'inline finding body',
      });
      // Asserted EXPLICITLY: a spec that only checked `line` would not have caught G-28-3.
      expect(details?.position).toBe(32);
      expect(details?.position).not.toBeUndefined();
    } finally {
      restore();
    }
  });

  it('returns null when the comment was deleted (404)', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(
      buildFixtures({ reviewCommentResponse: { status: 404 } }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      expect(await adapter.getInlineCommentDetails(OWNER, REPO, PR_NUMBER, '900123')).toBeNull();
    } finally {
      restore();
    }
  });

  it('returns null for a non-numeric or non-positive commentRef WITHOUT calling the API', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(
      buildFixtures({ reviewCommentResponse: { path: 'a.ts', line: 1, position: 1, body: 'b' } }),
    );

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      expect(await adapter.getInlineCommentDetails(OWNER, REPO, PR_NUMBER, 'not-a-number')).toBeNull();
      expect(await adapter.getInlineCommentDetails(OWNER, REPO, PR_NUMBER, '0')).toBeNull();
      expect(await adapter.getInlineCommentDetails(OWNER, REPO, PR_NUMBER, '-5')).toBeNull();
      // The adapter's guard short-circuits before any transport call.
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
