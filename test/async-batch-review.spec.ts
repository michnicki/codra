import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi, expect } from 'vitest';
import { findExistingJobForHead, getJobForProcessing } from '@server/db/jobs';
import { getFileReviewsForJobs } from '@server/db/file-reviews';
import { runWithDb, queryRows } from '@server/db/client';

const sha = (char: string) => char.repeat(40);

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getOtherRunningJobsCount: vi.fn().mockResolvedValue(0) };
});

vi.mock('@server/services/github', () => {
  class MockGitHubService {
    async getPullRequest() {
      return { title: 'Test PR', body: 'Test Body', head: { sha: 'headsha', ref: 'feature' }, base: { sha: 'basesha', ref: 'main' }, user: { login: 'author' } };
    }
    async getPullRequestDiff() { return generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]); }
    async createCheckRun() { return { id: 123 }; }
    async updateCheckRun() { return {}; }
    async createReview() { return { id: 456 }; }
    async ensureLabel() { return {}; }
    async addIssueLabels() { return {}; }
    async removeIssueLabelsIfPresent() { return {}; }
  }
  return { GitHubService: MockGitHubService };
});

// Controllable async-batch model: submit hands back a request_id; the first poll is still
// pending, the second completes. reviewFile must NOT be called on the async path.
const pollCalls = { count: 0 };
const reviewFileSpy = vi.fn();
vi.mock('@server/services/model', () => {
  class MockModelService {
    async submitReviewBatch() {
      return { requestId: 'req-async-1', model: '@cf/moonshotai/kimi-k2.6', modelLineCap: 800 };
    }
    async pollReviewBatch() {
      pollCalls.count += 1;
      if (pollCalls.count < 2) return { status: 'pending' as const };
      return {
        status: 'done' as const,
        response: {
          modelUsed: '@cf/moonshotai/kimi-k2.6',
          provider: 'Cloudflare',
          inputTokens: 11,
          outputTokens: 7,
          rawText: '{"findings":[]}',
          userPrompt: '',
          parsed: { comments: [], verdict: 'approve' as const, fileSummary: 'ok', overallCorrectness: 'patch is correct', confidenceScore: 0.9 },
        },
      };
    }
    async reviewFile() { reviewFileSpy(); throw new Error('sync reviewFile should not be called on the async path'); }
    async generateSummary() { return { modelUsed: 'm', provider: 'p', rawText: '{"summary":"s"}', inputTokens: 1, outputTokens: 1 }; }
  }
  return { ModelService: MockModelService, isRetryableModelError: (e: unknown) => Boolean(e && typeof e === 'object' && (e as any).retryable === true) };
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('Async batch review flow', () => {
  const env = createTestEnv();

  // A delayed reschedule sets last_queue_message_at into the future; claimJobLease refuses to
  // claim until then (in prod the workflow's step.sleep waits it out). Backdate it to simulate
  // that scheduled delay having elapsed so the next poll can claim immediately.
  async function simulateScheduledDelayElapsed(jobId: string) {
    await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
  }

  it('submits to the async queue, stays pending across polls, then completes and finalizes', async () => {
    pollCalls.count = 0;
    const repo = `test-repo-${Date.now()}-async`;
    const headSha = sha('c');

    await runWithDb(env, async () => {
      // Phase 1: prepare (creates the job, enqueues review).
      const prep = await runReviewJob(env, {
        deliveryId: `delivery-async-${Date.now()}`,
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          installation: { id: 123 },
          repository: { owner: { login: 'test-owner' }, name: repo },
          pull_request: { number: 1, head: { sha: headSha, ref: 'feature' }, base: { sha: sha('d'), ref: 'main' }, title: 'Test PR', user: { login: 'author' }, draft: false },
        },
      } as any);
      expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

      const job = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 1, commitSha: headSha, trigger: 'auto' });
      const jobId = job!.id;

      // Phase 2: first review invocation -> submits the async batch, persists a 'pending' row.
      const submitResult = await runReviewJob(env, { jobId, phase: 'review' } as any);
      expect(submitResult).toMatchObject({ action: 'next_phase', phase: 'review' });
      let reviews = await getFileReviewsForJobs(env, [jobId]);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].file_status).toBe('pending');
      expect(reviews[0].async_request_id).toBe('req-async-1');

      // Phase 3: poll returns pending -> stays in review phase.
      await simulateScheduledDelayElapsed(jobId);
      const pollPending = await runReviewJob(env, { jobId, phase: 'review' } as any);
      expect(pollPending).toMatchObject({ action: 'next_phase', phase: 'review' });
      reviews = await getFileReviewsForJobs(env, [jobId]);
      expect(reviews[0].file_status).toBe('pending');

      // Phase 4: poll returns done -> persists 'done', clears async bookkeeping, moves to finalize.
      await simulateScheduledDelayElapsed(jobId);
      const pollDone = await runReviewJob(env, { jobId, phase: 'review' } as any);
      expect(pollDone).toMatchObject({ action: 'next_phase', phase: 'finalize' });
      reviews = await getFileReviewsForJobs(env, [jobId]);
      expect(reviews[0].file_status).toBe('done');
      expect(reviews[0].async_request_id).toBeNull();
      expect(reviews[0].model_used).toBe('@cf/moonshotai/kimi-k2.6');

      // The synchronous reviewFile path must never have been used.
      expect(reviewFileSpy).not.toHaveBeenCalled();
      // Sanity: the batch was polled until it completed.
      expect(pollCalls.count).toBeGreaterThanOrEqual(2);

      expect(await getJobForProcessing(env, jobId)).toBeTruthy();
    });
  }, 60_000);
});
