// NREG-01 regression safety net (Phase 02 vcs-provider-abstraction, criterion 1).
//
// This spec pins three GitHub state-machine invariants as first-class, LABELED assertions
// against today's unmodified `core/review.ts` pipeline, BEFORE any provider-abstraction
// refactor touches it (D-04). It must stay green, unmodified, through and after the Wave 2
// branch-point flip that routes review.ts through a VcsProvider adapter -- it survives that
// flip because it mocks '@server/services/github' (the same module path review-flow.spec.ts
// mocks), and the adapter constructs GitHubService through that exact module path. This is NOT
// a claim that every protected spec shares this mock path (see 02-PLAN.md review finding 5) --
// only that this one does, which is why it is the pre-flip/post-flip tripwire.
//
// Invariant 1 (Task 1): the job lease/heartbeat (jobs.lease_owner) is released on every
// runReviewJob exit path, so a bug that drops a `releaseJobLease` call surfaces here loudly
// instead of silently wedging jobs behind a stale lease.
//
// Invariant 2 (Task 2): the `freshInstance` producer flag on ReviewJobRunResult is set
// correctly for the phase transitions that need a clean subrequest budget (finalize,
// subrequest-limit deferrals) and left false for normal in-instance continuations; a
// lease-recovery-shaped ReviewJobMessage with forceFreshInstance:true round-trips through
// reviewJobMessageSchema with its PARSED value preserved (review finding 10).
//
// Invariant 3 (Task 2): the supersede-on-new-push guard (T-02-02) -- a mid-execution
// JOB_SUPERSEDED releases the lease and acks, and a newer push for the same PR marks the
// older in-flight job 'superseded' via supersedeOlderJobs -- so a refactor that drops this
// guard fails loudly here rather than shipping a stale/duplicate review post.

import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi } from 'vitest';
import {
  findExistingJobForHead,
  getJobForProcessing,
  insertJob,
  updateJobFileCount,
  updateJobStep,
} from '@server/db/jobs';
import { upsertFileReview } from '@server/db/file-reviews';
import { defaultRepoConfig, reviewJobMessageSchema } from '@shared/schema';
import { runWithDb, queryRows } from '@server/db/client';

const sha = (char: string) => char.repeat(40);

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

// Copied verbatim from test/review-flow.spec.ts -- this exact mock module path is load-bearing
// per D-04: it is what keeps this spec green unmodified after the Wave 2 flip, when review.ts
// reaches GitHubService through the VcsProvider adapter rather than directly.
vi.mock('@server/services/github', () => {
  class MockGitHubService {
    async getPullRequest() {
      return {
        title: 'Test PR',
        body: 'Test Body',
        head: { sha: 'headsha', ref: 'feature' },
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
    async findBotReviewForCommit() { return null; }
    async ensureLabel() { return {}; }
    async addIssueLabels() { return {}; }
    async removeIssueLabelsIfPresent() { return {}; }
    async removeIssueLabel() { return {}; }
  }
  return { GitHubService: MockGitHubService };
});

vi.mock('@server/services/model', () => {
  class MockModelService {
    // Return null so the review phase uses the synchronous reviewFile path these tests exercise.
    async submitReviewBatch() {
      return null;
    }
    async pollReviewBatch() {
      return { status: 'pending' as const };
    }
    async reviewFile() {
      return {
        parsed: {
          comments: [],
          verdict: 'approve' as const,
          fileSummary: 'Looks ok',
          overallCorrectness: 'no issues',
          confidenceScore: 0.9,
        },
        modelUsed: 'test-model',
        provider: 'test-provider',
        inputTokens: 10,
        outputTokens: 5,
        rawText: '{}',
        userPrompt: '',
      };
    }
    async generateSummary() {
      return {
        modelUsed: 'sum-model',
        provider: 'google',
        rawText: '{"summary": "test"}',
        inputTokens: 3,
        outputTokens: 2,
      };
    }
  }
  return {
    ModelService: MockModelService,
    isRetryableModelError: (error: unknown) => Boolean(error && typeof error === 'object' && (error as any).retryable === true),
  };
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
const REGRESSION_TIMEOUT_MS = 60_000;

async function getLeaseOwner(env: ReturnType<typeof createTestEnv>, jobId: string) {
  const row = await getJobForProcessing(env, jobId);
  return row?.lease_owner ?? null;
}

// Schema-level assertion needs no DB, so it runs unconditionally (never skipped by a missing
// TEST_DATABASE_URL) -- it is the cheapest possible tripwire for the forceFreshInstance producer
// contract (review finding 10: assert the PARSED value, not merely that parsing succeeds).
describe('Invariant 2b: forceFreshInstance schema round-trip (no DB required)', () => {
  it('parses a lease-recovery-shaped message with forceFreshInstance:true and preserves the parsed value', () => {
    const parsed = reviewJobMessageSchema.parse({
      deliveryId: 'delivery-lease-recovery',
      jobId: crypto.randomUUID(),
      phase: 'review',
      forceFreshInstance: true,
    });
    // Review finding 10: the whole point of this assertion is the parsed VALUE, not that
    // `.parse()` merely succeeded without throwing.
    expect(parsed.forceFreshInstance).toBe(true);
  });
});

dbDescribe('VCS Regression Safety Net (NREG-01)', () => {
  const env = createTestEnv();

  describe('Invariant 1: lease/heartbeat is released on every runReviewJob exit path', () => {
    it('releases the lease when a job completes successfully (ack, done)', async () => {
      const repo = `vcs-regress-${Date.now()}-success`;
      const headSha = sha('1');
      const baseSha = sha('2');

      await runWithDb(env, async () => {
        let currentMessage: Parameters<typeof runReviewJob>[1] | null = {
          deliveryId: 'delivery-nreg-success',
          eventName: 'pull_request',
          payload: {
            action: 'opened',
            installation: { id: 123 },
            repository: { owner: { login: 'test-owner' }, name: repo },
            pull_request: {
              number: 1,
              head: { sha: headSha, ref: 'feature' },
              base: { sha: baseSha, ref: 'main' },
              title: 'Success Test',
              user: { login: 'author' },
              draft: false,
            },
          },
        };
        let retries = 0;
        const MAX_RETRIES = 5;

        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            const jobId = (currentMessage as any).jobId;
            const repoName = (currentMessage as any).payload?.repository?.name;
            if (jobId) {
              await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
            } else if (repoName) {
              await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE repository_id IN (SELECT id FROM repositories WHERE repo = $1)`, [repoName]);
            }
          } else if (result.action === 'retry') {
            if (++retries > MAX_RETRIES) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      const finalJob = await findExistingJobForHead(env, {
        owner: 'test-owner',
        repo,
        prNumber: 1,
        commitSha: headSha,
        trigger: 'auto',
      });
      expect(finalJob?.status).toBe('done');
      expect(await getLeaseOwner(env, finalJob!.id)).toBeNull();
    }, REGRESSION_TIMEOUT_MS);

    it('releases the lease when a NextPhaseError transitions the job into finalize on a fresh instance', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `vcs-regress-${Date.now()}-nextphase-finalize`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 100, prTitle: 'NextPhase Finalize', prAuthor: 'author',
        commitSha: sha('3'), baseSha: sha('4'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-nextphase-finalize', phase: 'review' });
        expect(result).toEqual({ action: 'next_phase', phase: 'finalize', delaySeconds: expect.any(Number), jobId: job.id, freshInstance: true });
      });

      expect(await getLeaseOwner(env, job.id)).toBeNull();
      getDiffSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('releases the lease when a retryable model/provider failure defers the job in-instance', async () => {
      const { ModelService } = await import('@server/services/model');
      const retryableError = Object.assign(new Error('Google API timed out after 45000ms'), { retryable: true });
      const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockRejectedValue(retryableError);
      const repo = `vcs-regress-${Date.now()}-retryable`;

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 101, prTitle: 'Retryable Model Failure', prAuthor: 'author',
        commitSha: sha('5'), baseSha: sha('6'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-retryable', phase: 'review' });
        expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: 30, jobId: job.id, freshInstance: false });
      });

      expect(await getLeaseOwner(env, job.id)).toBeNull();
      reviewSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('releases the lease when a subrequest-budget error defers the job to a fresh instance', async () => {
      const { ModelService } = await import('@server/services/model');
      const budgetError = new Error('Too many subrequests by single Worker invocation');
      const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockRejectedValue(budgetError);
      const repo = `vcs-regress-${Date.now()}-subrequest`;

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 102, prTitle: 'Subrequest Budget', prAuthor: 'author',
        commitSha: sha('7'), baseSha: sha('8'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-subrequest', phase: 'review' });
        expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: expect.any(Number), jobId: job.id, freshInstance: true });
      });

      expect(await getLeaseOwner(env, job.id)).toBeNull();
      reviewSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('releases the lease when the job is superseded mid-execution', async () => {
      const { ModelService } = await import('@server/services/model');
      const repo = `vcs-regress-${Date.now()}-superseded-midexec`;

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 103, prTitle: 'Superseded Mid Exec', prAuthor: 'author',
        commitSha: sha('9'), baseSha: sha('0'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockImplementationOnce(async () => {
        // Simulate a newer push arriving mid-chunk: flip the job to 'superseded' while the
        // review chunk is still in flight, exactly as heartbeatAndCheckSuperseded expects to see.
        await queryRows(env, `UPDATE jobs SET status = 'superseded' WHERE id = $1`, [job.id]);
        return {
          parsed: { comments: [], verdict: 'approve' as const, fileSummary: 'ok', overallCorrectness: 'no issues', confidenceScore: 0.9, severityAuditEvents: [] },
          modelUsed: 'test-model', provider: 'test-provider', inputTokens: 1, outputTokens: 1, rawText: '{}', userPrompt: '',
          reviewedLineCount: 1, wasPromptTruncated: false,
        };
      });

      const result = await runWithDb(env, async () => {
        return runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-superseded-midexec', phase: 'review' });
      });

      expect(result).toEqual({ action: 'ack' });
      expect(await getLeaseOwner(env, job.id)).toBeNull();
      reviewSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('releases the lease when the job fails terminally', async () => {
      const repo = `vcs-regress-${Date.now()}-terminal-fail`;

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 104, prTitle: 'Terminal Failure', prAuthor: 'author',
        commitSha: sha('a'), baseSha: sha('b'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      await upsertFileReview(env, job.id, {
        filePath: 'src/app.ts',
        fileStatus: 'failed',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: '',
        rawAiOutput: null,
        parsedComments: [],
        inputTokens: null,
        outputTokens: null,
        durationMs: 1,
        verdict: null,
        fileSummary: null,
        errorMessage: 'Simulated unrecoverable failure.',
      });

      const result = await runWithDb(env, async () => {
        return runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-terminal-fail', phase: 'finalize' });
      });

      expect(result).toEqual({ action: 'ack' });
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('failed');
      expect(await getLeaseOwner(env, job.id)).toBeNull();
    }, REGRESSION_TIMEOUT_MS);

    it('never leaks a lease on the early-return no-op path (duplicate terminal job)', async () => {
      // opencode review Concern 1: the lease is acquired in runReviewJob (:372), NOT in
      // resolveQueuedJob -- so an early `return null` out of resolveQueuedJob (here, the
      // duplicate-terminal-job branch at :628) must never have leased anything to leak.
      const repo = `vcs-regress-${Date.now()}-early-return`;
      const headSha = sha('c');
      const baseSha = sha('d');

      const terminalJob = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 105, prTitle: 'Early Return', prAuthor: 'author',
        commitSha: headSha, baseSha, trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await queryRows(env, `UPDATE jobs SET status = 'done', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [terminalJob.id]);

      const result = await runWithDb(env, async () => {
        return runReviewJob(env, {
          deliveryId: 'delivery-early-return',
          eventName: 'pull_request',
          payload: {
            action: 'opened',
            installation: { id: 123 },
            repository: { owner: { login: 'test-owner' }, name: repo },
            pull_request: {
              number: 105,
              head: { sha: headSha, ref: 'feature' },
              base: { sha: baseSha, ref: 'main' },
              title: 'Early Return',
              user: { login: 'author' },
              draft: false,
            },
          },
        });
      });

      // findExistingJobForHead finds the terminal (status 'done') duplicate job for the same
      // owner/repo/prNumber/commitSha/trigger -> resolveQueuedJob returns null -> runReviewJob
      // acks WITHOUT ever calling claimJobLease.
      expect(result).toEqual({ action: 'ack' });
      expect(await getLeaseOwner(env, terminalJob.id)).toBeNull();
    }, REGRESSION_TIMEOUT_MS);
  });

  describe('Invariant 2: forceFreshInstance producer flag threads correctly', () => {
    it('sets freshInstance=true for the NextPhaseError transition into finalize', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `vcs-regress-${Date.now()}-freshinstance-finalize`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 201, prTitle: 'FreshInstance Finalize', prAuthor: 'author',
        commitSha: sha('e'), baseSha: sha('f'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-freshinstance-finalize', phase: 'review' });
        expect(result).toEqual({ action: 'next_phase', phase: 'finalize', delaySeconds: expect.any(Number), jobId: job.id, freshInstance: true });
      });

      getDiffSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('sets freshInstance=true for a subrequest-limit deferral via continueOrFailWedgedJob', async () => {
      const { ModelService } = await import('@server/services/model');
      const budgetError = new Error('Too many subrequests by single Worker invocation');
      const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockRejectedValue(budgetError);
      const repo = `vcs-regress-${Date.now()}-freshinstance-subrequest`;

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 202, prTitle: 'FreshInstance Subrequest', prAuthor: 'author',
        commitSha: sha('1'), baseSha: sha('2'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-freshinstance-subrequest', phase: 'review' });
        expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: expect.any(Number), jobId: job.id, freshInstance: true });
      });

      reviewSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('leaves freshInstance false/absent for a normal in-instance phase continuation', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `vcs-regress-${Date.now()}-ininstance-continuation`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'a' },
          { path: 'src/two.ts', content: 'b' },
          { path: 'src/three.ts', content: 'c' },
        ]),
      );

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 203, prTitle: 'In-instance continuation', prAuthor: 'author',
        commitSha: sha('3'), baseSha: sha('4'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      // 3 files with the default 'medium' concurrency (chunk limit 2) leaves one file for the
      // next chunk -- a normal same-instance continuation, distinct from the finalize/subrequest
      // transitions above that both correctly set freshInstance=true.
      await updateJobFileCount(env, job.id, 3);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-ininstance-continuation', phase: 'review' });
        expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: expect.any(Number), jobId: job.id, freshInstance: false });
      });

      getDiffSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);
  });

  describe('Invariant 3: supersede-on-new-push (T-02-02)', () => {
    it('a mid-execution JOB_SUPERSEDED releases the lease and returns action:"ack"', async () => {
      const { ModelService } = await import('@server/services/model');
      const repo = `vcs-regress-${Date.now()}-supersede-midexec`;

      const job = await insertJob(env, {
        installationId: '123', owner: 'test-owner', repo,
        prNumber: 301, prTitle: 'Supersede Mid Exec', prAuthor: 'author',
        commitSha: sha('5'), baseSha: sha('6'), trigger: 'auto',
        headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockImplementationOnce(async () => {
        await queryRows(env, `UPDATE jobs SET status = 'superseded' WHERE id = $1`, [job.id]);
        return {
          parsed: { comments: [], verdict: 'approve' as const, fileSummary: 'ok', overallCorrectness: 'no issues', confidenceScore: 0.9, severityAuditEvents: [] },
          modelUsed: 'test-model', provider: 'test-provider', inputTokens: 1, outputTokens: 1, rawText: '{}', userPrompt: '',
          reviewedLineCount: 1, wasPromptTruncated: false,
        };
      });

      const result = await runWithDb(env, async () => {
        return runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-supersede-midexec', phase: 'review' });
      });

      // This is the supersede invariant itself, not an incidental stop: a job that discovers it
      // has been superseded mid-chunk must stop cleanly (ack) and release its lease so nothing
      // is left wedged behind a dead job's lease.
      expect(result).toEqual({ action: 'ack' });
      expect(await getLeaseOwner(env, job.id)).toBeNull();
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('superseded');
      reviewSpy.mockRestore();
    }, REGRESSION_TIMEOUT_MS);

    it('a newer push marks the older in-flight job "superseded" via supersedeOlderJobs', async () => {
      const repo = `vcs-regress-${Date.now()}-supersede-newpush`;
      const olderSha = sha('7');
      const newerSha = sha('8');
      const baseSha = sha('9');

      let olderJobId: string | null = null;

      await runWithDb(env, async () => {
        const firstResult = await runReviewJob(env, {
          deliveryId: 'delivery-supersede-older',
          eventName: 'pull_request',
          payload: {
            action: 'opened',
            installation: { id: 123 },
            repository: { owner: { login: 'test-owner' }, name: repo },
            pull_request: {
              number: 302,
              head: { sha: olderSha, ref: 'feature' },
              base: { sha: baseSha, ref: 'main' },
              title: 'Supersede New Push',
              user: { login: 'author' },
              draft: false,
            },
          },
        });
        expect(firstResult.action).toBe('next_phase');
        if (firstResult.action === 'next_phase') {
          olderJobId = firstResult.jobId ?? null;
        }
      });

      expect(olderJobId).not.toBeNull();
      const olderBeforeSecondPush = await getJobForProcessing(env, olderJobId!);
      expect(olderBeforeSecondPush?.status).not.toBe('superseded');

      await runWithDb(env, async () => {
        await runReviewJob(env, {
          deliveryId: 'delivery-supersede-newer',
          eventName: 'pull_request',
          payload: {
            action: 'synchronize',
            installation: { id: 123 },
            repository: { owner: { login: 'test-owner' }, name: repo },
            pull_request: {
              number: 302,
              head: { sha: newerSha, ref: 'feature' },
              base: { sha: baseSha, ref: 'main' },
              title: 'Supersede New Push',
              user: { login: 'author' },
              draft: false,
            },
          },
        });
      });

      const olderJobAfter = await getJobForProcessing(env, olderJobId!);
      expect(olderJobAfter?.status).toBe('superseded');
    }, REGRESSION_TIMEOUT_MS);
  });
});
