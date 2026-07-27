import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { GitHubService } from '@server/services/github';
import { GitHubError, createGithubBotIdentityResolver } from '@server/core/github';
import { TokenTracker } from '@server/core/token-tracker';
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
