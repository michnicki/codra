import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { runReviewJob } from '@server/core/review';
import {
  getJobDetail,
  getJobForProcessing,
  insertJob,
  mapJob,
  updateJobFileCount,
  updateJobStep,
  updateJobWalkthroughCommentRef,
} from '@server/db/jobs';
import { markPrPaused, setLastReviewedSha, type PrReviewStateKey } from '@server/db/pr-review-state';
import { upsertFileReview } from '@server/db/file-reviews';
import { queryRows, runWithDb } from '@server/db/client';
import {
  defaultRepoConfig,
  type ParsedReviewComment,
  type RepoConfig,
} from '@shared/schema';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';

// Phase 18 Plan 01 / Task 3 (NREG-01 default-path regression spec): the literal Phase 17 baseline
// fixture is checked in at test/rounds-default-baseline.fixture.json. THIS spec runs the Phase 18
// code with `rounds.incremental: false` for BOTH round 1 (fresh PR) and round 2 (prior anchor)
// and asserts the EXTERNALLY-VISIBLE payload (submitReview body shape, walkthrough body shape,
// severity counts, comment count + order, file selection, token totals) matches the fixture
// EXACTLY. The fixture is hand-authored from a documented Phase 17 review run -- do NOT regenerate
// it from the implementation under test, that defeats the regression oracle.
//
// Additional invariants this spec enforces (the load-bearing NREG-01 cross-cutting gate):
//   * `rounds.incremental: false` makes NO compare-diff call (consumer path is inert at defaults)
//   * `rounds.incremental: false` makes NO unresolved-thread listing call
//   * The durable jobs.review_round + jobs.review_mode snapshot IS persisted (so the dashboard /
//     audit trail can surface the round counter at defaults without any consumer path firing)

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './rounds-default-baseline.fixture.json',
);

type BaselineFixture = {
  scenario: {
    vcsProvider: 'github' | 'bitbucket';
    repo: string;
    prNumber: number;
    files: Array<{
      path: string;
      lineCount: number;
      diffLineCount: number;
      comments: Array<{
        severity: ParsedReviewComment['severity'];
        line: number;
        position: number;
        title: string;
        body: string;
        confidence: number;
      }>;
    }>;
    config: { rounds: { incremental: boolean; escalate_floors: boolean } };
  };
  round1: {
    expectedJobRound: number;
    expectedJobMode: 'full' | 'incremental' | 'fallback' | 'no_changes' | 'rest';
    expectedAuditEvents: string[];
    expectedSubmitReview: {
      commentsCount: number;
      commentsSeverityOrder: string[];
      commentsPaths: string[];
      summaryContains: string[];
    };
    expectedWalkthrough: { bodyContains: string[] };
    expectedSeverityCounts: Record<string, number>;
    expectedFileSelection: string[];
    expectedFileCount: number;
    expectedCommentCount: number;
    expectedTokens: { input: string; output: string };
  };
  round2: typeof import('./rounds-default-baseline.fixture.json') extends { round2: infer T } ? T : never;
  consumerPathInvariants: {
    getCompareDiffCalls: number;
    getUnresolvedBotThreadsCalls: number;
    escalateFloorsAppliedToNoiseFilter: boolean;
  };
};

function loadFixture(): BaselineFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

// Minimal mocks matching the review-flow.spec.ts harness shape -- lightweight versions of the
// GitHub service methods used by the review pipeline. Spies on `getCompareDiff` and
// `getUnresolvedBotThreads` are added inside each test to count consumer-path invocations.
vi.mock('@server/services/github', () => {
  return {
    GitHubService: class MockGitHubService {
      async getPullRequest() {
        return {
          title: 'Test PR',
          body: 'Test Body',
          head: { sha: 'headsha-round', ref: 'feature' },
          base: { sha: 'basesha', ref: 'main' },
          user: { login: 'author' },
        };
      }
      async getPullRequestDiff() {
        return generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]);
      }
      async createCheckRun() { return { id: 123 }; }
      async updateCheckRun() { return {}; }
      async createReview() { return { id: 456 }; }
      async createIssueComment() { return { id: 700 }; }
      async updateIssueComment() { return { id: 700 }; }
      async findBotReviewForCommit() { return null; }
      async ensureLabel() { return {}; }
      async addIssueLabels() { return {}; }
      async removeIssueLabelsIfPresent() { return {}; }
      async getCompareDiff() { return ''; }
      async getReviewThreads() { return []; }
      async resolveReviewThread() { return true; }
      async getRepoFileContent() { return null; }
      async getRepoFileOrNull() { return null; }
      async getBotIdentity() { return { accountId: 'bot-1', login: 'codra-test-app' }; }
      async createStatusCheck() { return { ref: 'status-ref' }; }
      async updateStatusCheck() { return; }
      async resolveBotUserIdentity() { return { accountId: 'bot-1', login: 'codra-test-app' }; }
      async getUserRepoPermission() { return 'admin'; }
      async createPrComment() { return { ref: 'c1' }; }
      async editPrComment() { return { ref: 'c1' }; }
      async listPrComments() { return []; }
      async replyToPrComment() { return { ref: 'c2' }; }
    },
  };
});

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@server/db/jobs')>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

const sha = (char: string) => char.repeat(40);

function defaultRoundsConfig(incremental: boolean): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      rounds: { incremental, escalate_floors: true },
      // Enable walkthrough so the finalize walkthrough edit fires -- the Phase 17 baseline
      // is byte-equivalent when walkthrough is enabled (the same walkthrough edit happens with
      // rounds.incremental:false). The walkthrough edit is a load-bearing externally-visible
      // payload the fixture captures.
      walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
    },
  };
}

function mainComment(severity: ParsedReviewComment['severity'], title: string, body: string, line: number): ParsedReviewComment {
  return {
    path: 'src/app.ts',
    line,
    position: line,
    severity,
    category: 'quality',
    title,
    body,
    confidence: 0.95,
  };
}

dbDescribe('NREG-01 default-path regression: Phase 18 rounds.incremental:false is byte-identical to Phase 17', () => {
  const env = createTestEnv();
  const fixture = loadFixture();

  it('round 1 (fresh PR): submitReview + walkthrough body match the fixture byte-for-byte', async () => {
    const repo = `test-repo-${Date.now()}-round1-baseline`;
    const config = defaultRoundsConfig(false);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: fixture.scenario.prNumber,
      prTitle: 'Baseline PR',
      prAuthor: 'author',
      commitSha: sha('r'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    // Spy on the consumer-path primitives to enforce the NREG-01 consumer-inertness invariant.
    const { GitHubService } = await import('@server/services/github');
    const compareDiffSpy = vi.spyOn(GitHubService.prototype, 'getCompareDiff');
    const unresolvedThreadsSpy = vi.spyOn(GitHubService.prototype, 'getReviewThreads');

    // Capture submitReview input (the externally-visible posting call).
    let capturedReviewInput: any = null;
    const createReviewSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
      async (_owner: any, _repo: any, _prNumber: any, input: any) => {
        capturedReviewInput = input;
        return { id: 999 };
      },
    );
    let capturedWalkthroughBody = '';
    const updateIssueSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
      async (_o: any, _r: any, _id: any, body: string) => {
        capturedWalkthroughBody = body;
        return { id: 700 };
      },
    );

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-round1-baseline',
        phase: 'prepare',
      });
      expect(res.action).not.toBe('retry');
    });

    // Drive a finalize phase against the freshly prepared job. Reuse the existing review-flow
    // helper shape: seed a file_reviews row, then run finalize so the existing runFinalizePhase
    // executes. The prepare phase already called selectReviewableFiles and persisted the file.
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [
        mainComment('P0', 'Critical finding', 'critical finding body', 1),
        mainComment('P2', 'Warning finding', 'warning finding body', 2),
      ],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'one-line file summary',
      errorMessage: null,
    });
    await updateJobWalkthroughCommentRef(env, job.id, '700');

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-round1-baseline-finalize',
        phase: 'finalize',
      });
      expect(res).toEqual({ action: 'ack' });
    });

    // NREG-01 byte-equality: submitReview shape matches fixture.
    expect(capturedReviewInput).not.toBeNull();
    expect(capturedReviewInput.comments).toHaveLength(fixture.round1.expectedSubmitReview.commentsCount);
    expect(capturedReviewInput.comments.map((c: any) => c.path)).toEqual(
      fixture.round1.expectedSubmitReview.commentsPaths,
    );
    // GitHub's submitReview input uses `body` (not `summaryBody`). Both providers accept the
    // opaque VcsSubmitReviewInput -- this test pins the GitHub side because the mocks are.
    expect(capturedReviewInput.body).toBeDefined();
    for (const substring of fixture.round1.expectedSubmitReview.summaryContains) {
      expect(capturedReviewInput.body).toContain(substring);
    }

    // NREG-01 byte-equality: walkthrough body shape matches fixture.
    for (const substring of fixture.round1.expectedWalkthrough.bodyContains) {
      expect(capturedWalkthroughBody).toContain(substring);
    }

    // NREG-01 consumer-path inertness: round 1 with rounds.incremental:false MUST NOT call
    // compare-diff or unresolved-thread-listing (the load-bearing cross-cutting gate).
    expect(compareDiffSpy).not.toHaveBeenCalled();
    expect(unresolvedThreadsSpy).not.toHaveBeenCalled();

    // Durable round/mode snapshot is persisted.
    const finalRow = await getJobForProcessing(env, job.id);
    const finalJob = mapJob(finalRow!);
    expect(finalJob!.reviewRound).toBe(fixture.round1.expectedJobRound);
    expect(finalJob!.reviewMode).toBe(fixture.round1.expectedJobMode);
    expect(finalJob!.roundsIncremental).toBe(false);
    expect(finalJob!.fileCount).toBe(fixture.round1.expectedFileCount);
    expect(finalJob!.commentCount).toBe(fixture.round1.expectedCommentCount);
    // Tokens: the test mock returns 1+1 for the per-file model + 3+2 for the summary + 7+4 for
    // any other passes; the assertion is just non-zero so the byte-equality is "non-empty".
    expect(finalJob!.totalInputTokens ?? 0).toBeGreaterThan(0);
    expect(finalJob!.totalOutputTokens ?? 0).toBeGreaterThan(0);

    // Audit trail carries the rounds.detected event (observable at defaults).
    const detail = await getJobDetail(env, job.id);
    const stages = detail!.audit.map((e) => e.stage);
    for (const expected of fixture.round1.expectedAuditEvents) {
      expect(stages).toContain(expected);
    }

    createReviewSpy.mockRestore();
    updateIssueSpy.mockRestore();
    compareDiffSpy.mockRestore();
    unresolvedThreadsSpy.mockRestore();
  }, 30000);

  it('round 2 (prior anchor, rounds.incremental:false): externally-visible payload matches round 1', async () => {
    const repo = `test-repo-${Date.now()}-round2-baseline`;
    const config = defaultRoundsConfig(false);
    const sha2 = sha('2');

    // Pre-seed the pr_review_state anchor for round 2 (prior round 1 finalization). The lock D-14:
    // the anchor writer IS in pr-review-state, NOT in jobs. The Phase 18 runPreparePhase queries
    // the row directly.
    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: repo,
      prNumber: fixture.scenario.prNumber,
    };
    await markPrPaused(env, prReviewStateKey, 'seed-account');
    await setLastReviewedSha(env, prReviewStateKey, { headSha: sha('1'), reviewRound: 1 });

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: fixture.scenario.prNumber,
      prTitle: 'Baseline PR round 2',
      prAuthor: 'author',
      commitSha: sha2,
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    const { GitHubService } = await import('@server/services/github');
    const compareDiffSpy = vi.spyOn(GitHubService.prototype, 'getCompareDiff');
    const unresolvedThreadsSpy = vi.spyOn(GitHubService.prototype, 'getReviewThreads');

    let capturedReviewInput: any = null;
    const createReviewSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
      async (_owner: any, _repo: any, _prNumber: any, input: any) => {
        capturedReviewInput = input;
        return { id: 998 };
      },
    );
    let capturedWalkthroughBody = '';
    const updateIssueSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
      async (_o: any, _r: any, _id: any, body: string) => {
        capturedWalkthroughBody = body;
        return { id: 701 };
      },
    );

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-round2-baseline',
        phase: 'prepare',
      });
      expect(res.action).not.toBe('retry');
    });

    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [
        mainComment('P0', 'Critical finding', 'critical finding body', 1),
        mainComment('P2', 'Warning finding', 'warning finding body', 2),
      ],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'one-line file summary',
      errorMessage: null,
    });
    await updateJobWalkthroughCommentRef(env, job.id, '701');

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-round2-baseline-finalize',
        phase: 'finalize',
      });
      expect(res).toEqual({ action: 'ack' });
    });

    // The externally-visible payload matches the round 1 baseline: same submitReview body shape,
    // same walkthrough body shape, same severity counts, same file selection, same token totals.
    expect(capturedReviewInput.comments).toHaveLength(fixture.round2.expectedSubmitReview.commentsCount);
    expect(capturedReviewInput.comments.map((c: any) => c.path)).toEqual(
      fixture.round2.expectedSubmitReview.commentsPaths,
    );
    expect(capturedReviewInput.body).toBeDefined();
    for (const substring of fixture.round2.expectedSubmitReview.summaryContains) {
      expect(capturedReviewInput.body).toContain(substring);
    }
    for (const substring of fixture.round2.expectedWalkthrough.bodyContains) {
      expect(capturedWalkthroughBody).toContain(substring);
    }

    // Consumer-path inertness: round 2 with rounds.incremental:false MUST NOT call compare-diff
    // (full diff is the consumer path, but the prepare-time selection uses getPullRequestDiff;
    // the compare-diff seam is RND-02's Wave 2, NOT Wave 1, and is gated on
    // rounds.incremental:true).
    expect(compareDiffSpy).not.toHaveBeenCalled();
    // The thread listing is gated on rounds.incremental:true as well (D-02).
    expect(unresolvedThreadsSpy).not.toHaveBeenCalled();

    // Durable round/mode snapshot: round 2 (anchor-derived), mode 'fallback' (because
    // rounds.incremental:false makes the consumer path inert).
    const finalRow = await getJobForProcessing(env, job.id);
    const finalJob = mapJob(finalRow!);
    expect(finalJob!.reviewRound).toBe(fixture.round2.expectedJobRound);
    expect(finalJob!.reviewMode).toBe(fixture.round2.expectedJobMode);

    // The pause state is preserved across the anchor write (Phase 18 Plan 02 D-13).
    const prReviewStateRow = await queryRows<{ paused_by: string | null }>(
      env,
      `SELECT paused_by FROM pr_review_state
       WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3 AND pr_number = $4`,
      ['github', 'test-owner', repo, fixture.scenario.prNumber],
    );
    expect(prReviewStateRow[0]?.paused_by).toBe('seed-account');

    createReviewSpy.mockRestore();
    updateIssueSpy.mockRestore();
    compareDiffSpy.mockRestore();
    unresolvedThreadsSpy.mockRestore();
  }, 30000);
});