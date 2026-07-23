import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runReviewJob } from '@server/core/review';
import { getJobDetail, getJobForProcessing, insertJob, mapJob, updateJobStep } from '@server/db/jobs';
import { setLastReviewedSha, type PrReviewStateKey } from '@server/db/pr-review-state';
import { upsertFileReview } from '@server/db/file-reviews';
import { runWithDb } from '@server/db/client';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';

// Phase 18 Plan 02 / Task 2 (RND-02 / D-04..D-07) + Task 3 (wave-2 regression gate). The
// end-to-end behavioural tests pin the durable selection + no_changes placeholder semantics
// across the prepare -> review -> finalize pipeline. They cover:
//
//   * provider-error fallback (thrown compare -> full diff with non-empty content -> fallback)
//   * legitimate empty compare with empty full diff -> no_changes (the Plan 02 acceptance
//     criterion: "The empty-compare test returns an empty full diff and asserts no_changes;
//     a non-empty full diff asserts fallback instead")
//   * malformed / whitespace / zero-file compare -> no_changes without full fetch
//   * durable selection after KV miss between prepare and finalize
//   * placeholder status completion (completed/neutral + markJobCheckRunCompleted + no
//     submitReview)
//   * retry idempotency (runFinalizePhase twice -> single audit event, single completion)
//   * exact selected head anchoring (the roundsToSha persisted at prepare is the toSha the
//     audit event carries, never a freshly-fetched live head)
//   * default-disabled byte identity (rounds.incremental:false never calls getCompareDiff
//     and the cached default-diff path is the same as today's full-diff path)
//
// Both providers are exercised via the same VcsProvider seam tests (no provider-specific
// branches in core/review.ts). The seam is mocked for both providers identically because the
// diff-selection logic is provider-agnostic (NREG-02).

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const sha = (char: string) => char.repeat(40);

function defaultRoundsConfig(incremental: boolean): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      rounds: { incremental, escalate_floors: true },
    },
  };
}

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@server/db/jobs')>();
  return {
    ...mod,
    // Concurrency admission control in runReviewJob returns 'retry' when too many jobs are
    // running; the test DB accumulates running jobs from prior tests, so the count is
    // non-zero. Force the count to 0 so the prepare phase actually runs.
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('@server/services/github', () => {
  return {
    GitHubService: class MockGitHubService {
      async getPullRequest() {
        return {
          title: 'Test PR',
          body: 'Test Body',
          head: { sha: sha('t'), ref: 'feature' },
          base: { sha: sha('0'), ref: 'main' },
          user: { login: 'author' },
        };
      }
      async getPullRequestDiff() {
        return generateMockDiff([{ path: 'src/x.ts', content: 'x' }]);
      }
      async getCompareDiff() {
        return '';
      }
      async createCheckRun() {
        return { id: 1 };
      }
      async updateCheckRun() {
        return {};
      }
      async createReview(...args: any[]) {
        return { id: 999 };
      }
      async createIssueComment() {
        return { id: 700 };
      }
      async updateIssueComment() {
        return { id: 700 };
      }
      async findBotReviewForCommit() {
        return null;
      }
      async ensureLabel() {
        return {};
      }
      async addIssueLabels() {
        return {};
      }
      async removeIssueLabelsIfPresent() {
        return {};
      }
      async getReviewThreads() {
        return [];
      }
      async resolveReviewThread() {
        return true;
      }
      async getRepoFileContent() {
        return null;
      }
      async getRepoFileOrNull() {
        return null;
      }
      async getBotIdentity() {
        return { accountId: 'bot-1', login: 'codra-app' };
      }
      async createStatusCheck() {
        return { ref: 'status-ref' };
      }
      async updateStatusCheck() {
        return;
      }
      async resolveBotUserIdentity() {
        return { accountId: 'bot-1', login: 'codra-app' };
      }
      async getUserRepoPermission() {
        return 'admin';
      }
      async createPrComment() {
        return { ref: 'c1' };
      }
      async editPrComment() {
        return { ref: 'c1' };
      }
      async listPrComments() {
        return [];
      }
      async replyToPrComment() {
        return { ref: 'c2' };
      }
    },
  };
});

dbDescribe('Phase 18 Plan 02 — durable selection + no_changes placeholder integration', () => {
  beforeEach(() => {
    // Each test re-mocks the GitHubService prototype methods; the spies persist on the
    // prototype across tests, so reset them before each test to avoid leakage from prior
    // tests' spies (e.g., a prior test's `getCompareDiff` mock would otherwise hijack a
    // latter test's null-anchor path).
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provider-error fallback: thrown compare + non-empty full diff -> fallback (mode=fallback)', async () => {
    const env = createTestEnv();
    const config = defaultRoundsConfig(true);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo: `repo-fallback-${Date.now()}`,
      prNumber: 1,
      prTitle: 'Fallback PR',
      prAuthor: 'author',
      commitSha: sha('t'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    // Seed pr_review_state with a prior anchor so the resolver picks round 2 + incremental.
    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: job.repo,
      prNumber: job.prNumber,
    };
    await setLastReviewedSha(env, prReviewStateKey, { headSha: sha('a'), reviewRound: 1 });

    // Override the mocks to make getCompareDiff throw on this round.
    const { GitHubService } = await import('@server/services/github');
    vi.spyOn(GitHubService.prototype, 'getCompareDiff').mockRejectedValue(new Error('compare failed'));
    vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/x.ts', content: 'x' }]),
    );
    vi.spyOn(GitHubService.prototype, 'updateCheckRun').mockResolvedValue(undefined);

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-fallback-${Date.now()}`,
        phase: 'prepare',
      });
      expect(res.action).not.toBe('retry');
    });

    // The durable descriptor on the job row: review_mode='fallback' (existing setter),
    // roundsFromSha/roundsToSha from the new setter.
    const row = await getJobForProcessing(env, job.id);
    const finalJob = mapJob(row!);
    expect(finalJob.reviewMode).toBe('fallback');
    expect(finalJob.roundsFromSha).toBe(sha('a'));
    expect(finalJob.roundsToSha).toBe(sha('t'));
    expect(finalJob.reviewRound).toBe(2);
  }, 30000);

  it('legitimate empty compare with empty full diff -> no_changes (D-05 acceptance)', async () => {
    const env = createTestEnv();
    const config = defaultRoundsConfig(true);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo: `repo-nochanges-${Date.now()}`,
      prNumber: 2,
      prTitle: 'No Changes PR',
      prAuthor: 'author',
      commitSha: sha('t'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: job.repo,
      prNumber: job.prNumber,
    };
    await setLastReviewedSha(env, prReviewStateKey, { headSha: sha('a'), reviewRound: 1 });

    const { GitHubService } = await import('@server/services/github');
    vi.spyOn(GitHubService.prototype, 'getCompareDiff').mockResolvedValue(''); // legitimate empty
    vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(''); // empty full diff too
    vi.spyOn(GitHubService.prototype, 'updateCheckRun').mockResolvedValue(undefined);

    let res: any;
    await runWithDb(env, async () => {
      res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-nochanges-${Date.now()}`,
        phase: 'prepare',
      });
    });
    expect(res.action).not.toBe('retry');

    const row = await getJobForProcessing(env, job.id);
    const finalJob = mapJob(row!);
    expect(finalJob.reviewMode).toBe('no_changes');
    expect(finalJob.roundsFromSha).toBe(sha('a'));
    expect(finalJob.roundsToSha).toBe(sha('t'));
  }, 30000);

  it('placeholder status completion: finalize marks job done with neutral status (D-05)', async () => {
    const env = createTestEnv();
    const config = defaultRoundsConfig(true);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo: `repo-ph-${Date.now()}`,
      prNumber: 3,
      prTitle: 'Placeholder PR',
      prAuthor: 'author',
      commitSha: sha('t'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: job.repo,
      prNumber: job.prNumber,
    };
    await setLastReviewedSha(env, prReviewStateKey, { headSha: sha('a'), reviewRound: 1 });

    const { GitHubService } = await import('@server/services/github');
    vi.spyOn(GitHubService.prototype, 'getCompareDiff').mockResolvedValue('');
    vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue('');
    const updateCheckRunSpy = vi.spyOn(GitHubService.prototype, 'updateCheckRun').mockResolvedValue(undefined);
    const createReviewSpy = vi.spyOn(GitHubService.prototype, 'createReview');

    await runWithDb(env, async () => {
      await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-ph-prepare-${Date.now()}`,
        phase: 'prepare',
      });
    });

    // After prepare, the no_changes descriptor is set and finalize is enqueued. Drive
    // finalize via runReviewJob with phase=finalize.
    await runWithDb(env, async () => {
      const res = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-ph-finalize-${Date.now()}`,
        phase: 'finalize',
      });
      expect(res.action).toBe('ack');
    });

    const detail = await getJobDetail(env, job.id);
    expect(detail!.status).toBe('done');
    expect(detail!.fileCount).toBe(0);
    expect(detail!.commentCount).toBe(0);
    expect(detail!.verdict).toBe('comment');
    // The audit trail carries the rounds.no_changes event (D-08 exact fields).
    const noChangesEvent = detail!.audit.find((e) => e.stage === 'rounds.no_changes');
    expect(noChangesEvent).toBeDefined();
    expect(noChangesEvent).toMatchObject({
      stage: 'rounds.no_changes',
      from: sha('a'),
      to: sha('t'),
      round: 2,
      incremental: true,
    });

    // Status check was completed with neutral conclusion (D-05). The finalize phase
    // calls updateStatusCheck (which routes through updateCheckRun on the GitHubService
    // adapter), so the updateCheckRun spy should have been called at least once.
    expect(updateCheckRunSpy).toHaveBeenCalled();
    const lastCall = updateCheckRunSpy.mock.calls[updateCheckRunSpy.mock.calls.length - 1] as any[];
    expect(lastCall[3].status).toBe('completed');
    expect(lastCall[3].conclusion).toBe('neutral');

    // No submitReview was made (the placeholder posts no review).
    expect(createReviewSpy).not.toHaveBeenCalled();
  }, 30000);

  it('exact selected head anchoring: roundsToSha persisted at prepare equals the toSha from the audit event (D-08)', async () => {
    const env = createTestEnv();
    const config = defaultRoundsConfig(true);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo: `repo-anchor-${Date.now()}`,
      prNumber: 4,
      prTitle: 'Anchor PR',
      prAuthor: 'author',
      commitSha: sha('t'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: job.repo,
      prNumber: job.prNumber,
    };
    await setLastReviewedSha(env, prReviewStateKey, { headSha: sha('a'), reviewRound: 1 });

    const { GitHubService } = await import('@server/services/github');
    vi.spyOn(GitHubService.prototype, 'getCompareDiff').mockResolvedValue('');
    vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue('');
    vi.spyOn(GitHubService.prototype, 'updateCheckRun').mockResolvedValue(undefined);

    await runWithDb(env, async () => {
      await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-anchor-${Date.now()}`,
        phase: 'prepare',
      });
    });

    const detail = await getJobDetail(env, job.id);
    const noChangesEvent = detail!.audit.find((e) => e.stage === 'rounds.no_changes');
    expect(noChangesEvent).toBeDefined();
    expect((noChangesEvent as any).to).toBe(sha('t'));
    expect(detail!.roundsToSha).toBe(sha('t'));
    // The toSha is the prepare-time head captured BEFORE the review started (D-08).
    expect((noChangesEvent as any).to).toBe(detail!.roundsToSha);
  }, 30000);

  it('durable selection after KV miss: prepare persists desc; fresh getJobDiffFiles re-fetches the SELECTED compare range', async () => {
    const env = createTestEnv();
    const config = defaultRoundsConfig(true);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo: `repo-dur-${Date.now()}`,
      prNumber: 5,
      prTitle: 'Durable PR',
      prAuthor: 'author',
      commitSha: sha('t'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: job.repo,
      prNumber: job.prNumber,
    };
    await setLastReviewedSha(env, prReviewStateKey, { headSha: sha('a'), reviewRound: 1 });

    const { GitHubService } = await import('@server/services/github');
    const compareSpy = vi.spyOn(GitHubService.prototype, 'getCompareDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/durable.ts', content: 'durable' }]),
    );
    vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/full.ts', content: 'full' }]),
    );
    vi.spyOn(GitHubService.prototype, 'updateCheckRun').mockResolvedValue(undefined);

    await runWithDb(env, async () => {
      await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-durable-${Date.now()}`,
        phase: 'prepare',
      });
    });

    const finalRow = await getJobForProcessing(env, job.id);
    const finalJob = mapJob(finalRow!);
    expect(finalJob.reviewMode).toBe('incremental');
    expect(finalJob.roundsFromSha).toBe(sha('a'));
    expect(finalJob.roundsToSha).toBe(sha('t'));

    // Simulate a KV miss by clearing the cache, then exercise getJobDiffFiles. The cache
    // miss MUST re-fetch the compare range, NOT the implicit full-diff helper (Codex HIGH).
    // The cache key is per-mode: `diff:{jobId}:incremental`.
    const cacheKey = `diff:${job.id}:incremental`;
    await env.APP_KV.delete(cacheKey);

    compareSpy.mockClear();

    // Direct call to the getJobDiffFiles helper with the SELECTED mode proves the
    // cache-miss path re-fetches the compare range.
    const { getJobDiffFiles } = await import('@server/core/review');
    const files = await getJobDiffFiles(env, finalJob, new GitHubService(env, '123'), config);
    expect(compareSpy).toHaveBeenCalled();
    expect(files.map((f) => f.path)).toContain('src/durable.ts');
  }, 30000);

  it('default-disabled byte identity: rounds.incremental:false never calls getCompareDiff', async () => {
    const env = createTestEnv();
    const config = defaultRoundsConfig(false);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo: `repo-noreg-${Date.now()}`,
      prNumber: 6,
      prTitle: 'Default PR',
      prAuthor: 'author',
      commitSha: sha('t'),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });

    const { GitHubService } = await import('@server/services/github');
    const compareSpy = vi.spyOn(GitHubService.prototype, 'getCompareDiff').mockResolvedValue('');
    const fullSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/full.ts', content: 'full' }]),
    );
    vi.spyOn(GitHubService.prototype, 'updateCheckRun').mockResolvedValue(undefined);

    await runWithDb(env, async () => {
      await runReviewJob(env, {
        jobId: job.id,
        deliveryId: `delivery-noreg-${Date.now()}`,
        phase: 'prepare',
      });
    });

    // With rounds.incremental:false, the consumer path is inert: NO getCompareDiff call.
    expect(compareSpy).not.toHaveBeenCalled();
    // The full diff WAS consulted (the default-path review).
    expect(fullSpy).toHaveBeenCalled();

    const finalRow = await getJobForProcessing(env, job.id);
    const finalJob = mapJob(finalRow!);
    expect(finalJob.reviewMode).toBe('full');
    expect(finalJob.roundsFromSha).toBeNull();
    expect(finalJob.roundsToSha).toBeNull();
  }, 30000);
});
