import { budgetAwareFileLimit, runReviewJob } from '@server/core/review';
import { TokenTracker } from '@server/core/token-tracker';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi } from 'vitest';
import { findExistingJobForHead, getJobDetail, getJobForProcessing, insertJob, mapJob, markJobContinuationQueued, setJobThreadVerifications, updateJobCriticResult, updateJobFileCount, updateJobStep, updateJobWalkthroughCommentRef } from '@server/db/jobs';
// Alias the module namespace under a stable name so vi.spyOn can wrap markJobContinuationQueued
// on the SAME module instance the production code imports (vitest's vi.mock + dynamic
// import('@server/db/jobs') would otherwise create a separate instance the spy can't see).
import * as jobsModule from '@server/db/jobs';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { getFileReviewsForJobs, upsertFileReview } from '@server/db/file-reviews';
import { defaultRepoConfig, REVIEW_CONCURRENCY_LIMITS, type ParsedReviewComment, type RepoConfig, type ThreadVerifications } from '@shared/schema';
import { runWithDb, queryRows } from '@server/db/client';
import { buildWalkthroughData, editWalkthroughComment, postWalkthroughPlaceholder, type WalkthroughReviewRow } from '@server/core/walkthrough';
import { FormatterService } from '@server/services/formatter';
import type { VcsProvider } from '@server/vcs/types';

const sha = (char: string) => char.repeat(40);

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

// Properly mock the services as real classes with prototype methods
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
        // Phase 9 walkthrough PR-comment primitives (GitHubAdapter.createPrComment/editPrComment map
        // onto these). Defaults: create returns a fresh numeric comment id; edit echoes success.
        // Individual walkthrough tests spy/override these on the prototype.
        async createIssueComment() { return { id: 700 }; }
        async updateIssueComment() { return { id: 700 }; }
        async findBotReviewForCommit() { return null; }
        async ensureLabel() { return {}; }
        async addIssueLabels() { return {}; }
        async removeIssueLabelsIfPresent() { return {}; }
        async removeIssueLabel() { return {}; }
        // Phase 20.1 (BLOCKER 3 chain integration): the verify-fixes phase needs these methods
        // on the GitHubService so the GithubAdapter can satisfy the VcsProvider contract. Defaults
        // are inert (no threads, content returns null, identity resolves to a fake bot) so the
        // verify-fixes phase runs through the no-threads path without needing per-test spies.
        // Individual tests override these via vi.spyOn(GitHubService.prototype, ...) as needed.
        async getRepoFileContent() { return null; }
        async getReviewThreads() { return []; }
        async resolveReviewThread() { return true; }
        async resolveBotUserIdentity() { return { accountId: '0', login: 'codra-bot' }; }
    }
    return { GitHubService: MockGitHubService };
});

vi.mock('@server/services/model', () => {
    class MockModelService {
        // Return null so the review phase uses the synchronous reviewFile path these tests exercise.
        // (A real request_id here would route through the async batch submit/poll flow instead.)
        async submitReviewBatch() {
            return null;
        }
        async pollReviewBatch() {
            return { status: 'pending' as const };
        }
        async reviewFile() {
            return {
                parsed: {
                    comments: [{
                        path: 'src/app.ts',
                        line: 1,
                        position: 1,
                        severity: 'P2',
                        category: 'quality',
                        title: 'Typo',
                        body: 'Fixed typo',
                    }],
                    verdict: 'comment',
                    fileSummary: 'Looks ok',
                    overallCorrectness: 'issues found',
                    confidenceScore: 0.9
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
        // Phase 9 Plan 03 WT-03: the optional whole-diff Mermaid diagram call. Default returns a
        // valid sequenceDiagram so the GitHub finalize path renders a ```mermaid fence; individual
        // tests spy/override this on the prototype to assert args, count, tokens, and failure omit.
        async generateWalkthroughDiagram() {
            return {
                modelUsed: 'diagram-model',
                provider: 'google',
                rawText: 'sequenceDiagram\n  participant A\n  A->>B: call()',
                inputTokens: 7,
                outputTokens: 4,
            };
        }
        // Phase 10 Plan 06 MP-03: the critic's single whole-set, ID-based, prune-only call. Default
        // returns an empty prune (keep-all); critic tests spy/override this on the prototype to assert
        // it is (or isn't) called, to prune specific ids, or to inject a failure (fail-open).
        async critiqueFindings() {
            return {
                rawText: '{"prune": []}',
                modelUsed: 'critic-model',
                inputTokens: 5,
                outputTokens: 2,
            };
        }
    }
    class MockRetryableModelError extends Error {
        readonly retryable = true;
        constructor(message: string) {
            super(message);
            this.name = 'RetryableModelError';
        }
    }
    return {
        ModelService: MockModelService,
        RetryableModelError: MockRetryableModelError,
        isRetryableModelError: (error: unknown) => Boolean(error && typeof error === 'object' && (error as any).retryable === true),
    };
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
const REVIEW_FLOW_TIMEOUT_MS = 60_000;

dbDescribe('Review Flow Lifecycle', () => {
  const env = createTestEnv();

  async function runAndDrain(message: Parameters<typeof runReviewJob>[1]) {
    await runWithDb(env, async () => {
      let currentMessage: typeof message | null = message;
      let retries = 0;
      const MAX_RETRIES = 5;
      
      while (currentMessage) {
        const result = await runReviewJob(env, currentMessage);
        if (result.action === 'next_phase') {
          currentMessage = { ...currentMessage, phase: result.phase };
          retries = 0;
          // Phase/chunk transitions now yield long enough to hibernate into a fresh invocation,
          // which schedules the next delivery into the future (last_queue_message_at). In-process
          // we don't actually wait, so backdate it to simulate the delay elapsing -- otherwise the
          // next claim would report 'busy'.
          const jobId = (currentMessage as any).jobId;
          const repo = (currentMessage as any).payload?.repository?.name;
          if (jobId) {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
          } else if (repo) {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE repository_id IN (SELECT id FROM repositories WHERE repo = $1)`, [repo]);
          }
        } else if (result.action === 'retry') {
          if (++retries > MAX_RETRIES) throw new Error('Max retries exceeded');
          // In test environments, if we get throttled or told to retry, just break to prevent infinite loops.
          // Tests that expect a retry will assert on the direct return value instead of using runAndDrain.
          break;
        } else {
          currentMessage = null;
        }
      }
    });
  }

  it('completes a full review from pending job to finished', async () => {
    const repo = `test-repo-${Date.now()}-full`;
    const headSha = sha('a');
    const baseSha = sha('b');

    await runAndDrain({
      deliveryId: 'delivery-123',
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: 123 },
        repository: { owner: { login: 'test-owner' }, name: repo },
        pull_request: {
          number: 1,
          head: { sha: headSha, ref: 'feature' },
          base: { sha: baseSha, ref: 'main' },
          title: 'Test PR',
          user: { login: 'author' },
          draft: false,
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
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('stops processing if the job is superseded mid-way', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-supersede`;
      const headSha = sha('c');
      const baseSha = sha('d');

      // Spy on the prototype of our mocked class
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff');
      
      getDiffSpy.mockImplementationOnce(async () => {
          const { getDb } = await import('@server/db/client');
          const sql = getDb(env);
          await sql.query(
            `
              UPDATE jobs j
              SET status = 'superseded'
              FROM repositories r
              WHERE j.repository_id = r.id
                AND r.owner = $1
                AND r.repo = $2
                AND j.pr_number = $3
            `,
            ['test-owner', repo, 2],
          );
          return generateMockDiff([{ path: 'test.ts', content: 'a' }]);
      });

      await runAndDrain({
        deliveryId: 'delivery-456',
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          installation: { id: 123 },
          repository: { owner: { login: 'test-owner' }, name: repo },
          pull_request: {
            number: 2,
            head: { sha: headSha, ref: 'feature' },
            base: { sha: baseSha, ref: 'main' },
            title: 'Supersede Test',
            user: { login: 'author' },
            draft: false,
          }
        }
      });

      const finalJob = await findExistingJobForHead(env, {
        owner: 'test-owner',
        repo,
        prNumber: 2,
        commitSha: headSha,
        trigger: 'auto',
      });
      expect(finalJob?.status).toBe('superseded');
      expect(finalJob?.verdict).toBeNull();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('throttles a new (queued) job at the concurrency limit but never a running continuation', async () => {
    const jobsMod = await import('@server/db/jobs');
    const repo = `test-repo-${Date.now()}-admission`;
    const baseSha = sha('0');
    const base = {
      installationId: '123', owner: 'test-owner', repo, prAuthor: 'author',
      baseSha, trigger: 'auto' as const, headRef: 'feature', baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    };

    const queued = await insertJob(env, { ...base, prNumber: 30, prTitle: 'Admission Queued', commitSha: sha('c') });
    const running = await insertJob(env, { ...base, prNumber: 31, prTitle: 'Admission Running', commitSha: sha('d') });
    // Report far over any concurrency limit for the whole test. (The running case never calls this --
    // the gate is skipped by status -- so restore the module-mock default afterwards to avoid leaking.)
    vi.mocked(jobsMod.getOtherRunningJobsCount).mockResolvedValue(99);
    try {
      // A brand-new (queued) job IS gated at the limit -> retry (admission control).
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: queued.id, deliveryId: 'delivery-adm-queued', phase: 'prepare' });
        expect(res.action).toBe('retry');
      });

      // A job already 'running' must NOT be re-gated on its continuations, even far over the limit --
      // that is the starvation bug (every in-flight job retries forever and gets lease-recovery-failed).
      await runWithDb(env, async () => {
        await queryRows(env, `UPDATE jobs SET status = 'running' WHERE id = $1`, [running.id]);
        const res = await runReviewJob(env, { jobId: running.id, deliveryId: 'delivery-adm-running', phase: 'review' });
        expect(res.action).not.toBe('retry');
      });
    } finally {
      vi.mocked(jobsMod.getOtherRunningJobsCount).mockResolvedValue(0);
    }
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('bulk-marks missing files failed in a single pass without clobbering existing rows', async () => {
    const { bulkMarkFilesFailed } = await import('@server/db/file-reviews');
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-bulk-failed`,
      prNumber: 40, prTitle: 'Bulk failed', prAuthor: 'author', commitSha: sha('e'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await bulkMarkFilesFailed(env, job.id, [
      { filePath: 'src/a.ts', pass: 'main', diffLineCount: 10 },
      { filePath: 'src/b.ts', pass: 'main', diffLineCount: 20 },
    ], { modelUsed: 'gemini-3.1-flash-lite', errorMessage: 'infra limit' });

    // Second call including an existing path must not duplicate or overwrite it (ON CONFLICT DO NOTHING).
    await bulkMarkFilesFailed(env, job.id, [
      { filePath: 'src/a.ts', pass: 'main', diffLineCount: 10 },
      { filePath: 'src/c.ts', pass: 'main', diffLineCount: 5 },
    ], { modelUsed: 'other-model', errorMessage: 'second call' });

    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(reviews).toHaveLength(3);
    expect(reviews.every((r) => r.file_status === 'failed')).toBe(true);
    // a.ts keeps its first values (not clobbered by the second call).
    expect(reviews.find((r) => r.file_path === 'src/a.ts')?.error_msg).toBe('infra limit');
    expect(reviews.find((r) => r.file_path === 'src/c.ts')?.error_msg).toBe('second call');
  });

  it('completes the job with the review recorded even if post-review check-run/label updates fail', async () => {
    // Regression: the GitHub review is posted mid-finalize; if the subsequent (cosmetic) check-run
    // or label calls throw -- e.g. a large PR exhausting the invocation's subrequest budget -- the
    // job must still finish 'done' with review_id set, not be stranded 'failed' with the review
    // already live on the PR.
    const { GitHubService } = await import('@server/services/github');
    const checkRunSpy = vi.spyOn(GitHubService.prototype, 'updateCheckRun' as any)
      .mockRejectedValue(new Error('Too many subrequests by single Worker invocation'));

    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-besteffort`,
      prNumber: 41, prTitle: 'Best effort', prAuthor: 'author', commitSha: sha('f'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-besteffort' });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    expect(final?.review_id).not.toBeNull();
    // The check-run update failed, so it must NOT be marked completed -- it stays pending so the
    // maintenance sweep can finish it (the check run always ends up 'completed', never stuck).
    // Assert THIS job's own sweep-eligibility (terminal status + a check_run_id + no
    // check_run_completed_at) rather than calling getTerminalJobsNeedingCheckRunCompletion() and
    // checking membership. That query is windowed (ORDER BY finished_at ASC LIMIT n), so on the
    // shared test DB a backlog of >n uncompleted terminal jobs pushes this (newest) job out of the
    // window and the membership check flakes independently of the code under test. The query's own
    // WHERE/ordering behavior is covered in job-recovery-provider.spec.ts; here we only need to prove
    // this job is left in the exact state that query selects on.
    expect(final?.check_run_id).not.toBeNull();
    expect(final?.check_run_completed_at).toBeNull();
    checkRunSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('marks the check-run completed on a successful finalize (no maintenance needed)', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-checkrun-ok`,
      prNumber: 42, prTitle: 'Check run ok', prAuthor: 'author', commitSha: sha('a'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-checkrun-ok' });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    // The inline check-run update succeeded, so it's marked complete and won't be re-done by
    // maintenance. A non-null check_run_completed_at is exactly what excludes this job from
    // getTerminalJobsNeedingCheckRunCompletion() (its predicate requires check_run_completed_at IS
    // NULL), so this single job-scoped assertion is the DB-cleanliness-independent equivalent of the
    // old windowed membership check (which flaked once the shared test DB's backlog exceeded the LIMIT).
    expect(final?.check_run_completed_at).not.toBeNull();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('marks "Reviewing Files" done at finalize even when a degrade path left it running', async () => {
    // Regression: continueOrFailWedgedJob's review->finalize degrade doesn't mark "Reviewing Files"
    // done, so a job that reached finalize that way stayed 'done' overall but showed the step stuck
    // "In progress". Finalize now defensively marks it done.
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-revstuck`,
      prNumber: 43, prTitle: 'Reviewing stuck', prAuthor: 'author', commitSha: sha('b'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts', fileStatus: 'done', modelUsed: 'test-model', modelProvider: 'test',
      diffLineCount: 1, diffInput: 'x', rawAiOutput: '{}', parsedComments: [], inputTokens: 1,
      outputTokens: 1, durationMs: 1, verdict: 'comment', fileSummary: 'ok', errorMessage: null,
    });

    await runWithDb(env, async () => {
      // Reach finalize with "Reviewing Files" left 'running', as the continuation-ceiling degrade does.
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });
      await queryRows(env, `UPDATE jobs SET status = 'running', file_count = 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [job.id]);
      await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-revstuck', phase: 'finalize' });
    });

    const final = await getJobForProcessing(env, job.id);
    expect(final?.status).toBe('done');
    const reviewingStep = (final?.steps as Array<{ name: string; status: string }>).find((s) => s.name === 'Reviewing Files');
    expect(reviewingStep?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('processes a pre-created retry job from a queue message', async () => {
    const repo = `test-repo-${Date.now()}-retry`;
    const sourceHeadSha = sha('1');
    const retryHeadSha = sha('2');
    const baseSha = sha('3');

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 3,
      prTitle: 'Retry Test',
      prAuthor: 'author',
      commitSha: sourceHeadSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    const retry = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 3,
      prTitle: 'Retry Test',
      prAuthor: 'author',
      commitSha: retryHeadSha,
      baseSha,
      trigger: 'retry',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
      retryOfJobId: source.id,
    });

    await runAndDrain({
      jobId: retry.id,
      deliveryId: 'delivery-retry',
    });

    const finalJob = await getJobForProcessing(env, retry.id);
    expect(finalJob?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('does not inherit parent file reviews from models outside the current retry strategy', async () => {
    const { ModelService } = await import('@server/services/model');
    const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile');
    const repo = `test-repo-${Date.now()}-retry-model-filter`;
    const sourceHeadSha = sha('8');
    const retryHeadSha = sha('9');
    const baseSha = sha('0');

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 6,
      prTitle: 'Retry Model Filter',
      prAuthor: 'author',
      commitSha: sourceHeadSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it', '@cf/zai-org/glm-4.7-flash'],
          size_overrides: [],
        },
      },
    });

    await upsertFileReview(env, source.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: '@cf/zai-org/glm-4.7-flash',
      modelProvider: 'cloudflare',
      diffLineCount: 1,
      diffInput: 'old diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'old',
      errorMessage: null,
    });

    const retry = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 6,
      prTitle: 'Retry Model Filter',
      prAuthor: 'author',
      commitSha: retryHeadSha,
      baseSha,
      trigger: 'retry',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        model: {
          main: 'gemma-4-31b-it',
          fallbacks: ['gemma-4-26b-a4b-it'],
          size_overrides: [],
        },
      },
      retryOfJobId: source.id,
    });

    await runAndDrain({
      jobId: retry.id,
      deliveryId: 'delivery-retry-model-filter',
    });

    expect(reviewSpy).toHaveBeenCalled();
    const reviews = await getFileReviewsForJobs(env, [retry.id]);
    expect(reviews.find((review) => review.file_path === 'src/app.ts')?.model_used).toBe('test-model');
    reviewSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('inherits a parent review when the config model id is provider-prefixed but the stored model_used is bare', async () => {
    // Regression: file reviews persist the bare model id (e.g. `gemini-3.1-flash-lite`) while the
    // configured strategy stores the provider-qualified id (e.g. `google:gemini-3.1-flash-lite`).
    // Inheritance must match on the bare name; otherwise every retry re-reviews every file.
    const { ModelService } = await import('@server/services/model');
    const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile');
    const repo = `test-repo-${Date.now()}-retry-prefix`;
    const sourceHeadSha = sha('a');
    const retryHeadSha = sha('b');
    const baseSha = sha('0');

    const prefixedConfig = {
      ...defaultRepoConfig,
      model: {
        main: 'google:gemini-3.1-flash-lite',
        fallbacks: ['google:gemini-2.5-flash-lite'],
        size_overrides: [],
      },
    };

    const source = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Retry Prefix Match',
      prAuthor: 'author',
      commitSha: sourceHeadSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: prefixedConfig,
    });

    await upsertFileReview(env, source.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'gemini-3.1-flash-lite', // bare, as the model service actually stores it
      modelProvider: 'google',
      diffLineCount: 1,
      diffInput: 'old diff',
      rawAiOutput: '{}',
      parsedComments: [{
        path: 'src/app.ts',
        line: 1,
        position: 1,
        severity: 'P2',
        category: 'quality',
        title: 'Inherited finding',
        body: 'This comment must survive inheritance',
      }],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'inherited-summary',
      errorMessage: null,
    });

    const retry = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Retry Prefix Match',
      prAuthor: 'author',
      commitSha: retryHeadSha,
      baseSha,
      trigger: 'retry',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: prefixedConfig,
      retryOfJobId: source.id,
    });

    await runAndDrain({
      jobId: retry.id,
      deliveryId: 'delivery-retry-prefix-match',
    });

    // The file must be inherited verbatim (bare model id + parent summary preserved), not re-reviewed.
    expect(reviewSpy).not.toHaveBeenCalled();
    const reviews = await getFileReviewsForJobs(env, [retry.id]);
    const inherited = reviews.find((review) => review.file_path === 'src/app.ts');
    expect(inherited?.model_used).toBe('gemini-3.1-flash-lite');
    expect(inherited?.file_summary).toBe('inherited-summary');
    // The parent's comments must be carried over by the bulk-inherit copy, not lost.
    expect(inherited?.parsed_comments).toHaveLength(1);
    expect((inherited?.parsed_comments as ParsedReviewComment[])[0]?.title).toBe('Inherited finding');
    reviewSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('resumes an existing queued duplicate job instead of stranding it', async () => {
    const repo = `test-repo-${Date.now()}-duplicate`;
    const headSha = sha('4');
    const baseSha = sha('5');

    const existing = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 4,
      prTitle: 'Duplicate Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    await runAndDrain({
      deliveryId: 'delivery-duplicate',
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: 123 },
        repository: { owner: { login: 'test-owner' }, name: repo },
        pull_request: {
          number: 4,
          head: { sha: headSha, ref: 'feature' },
          base: { sha: baseSha, ref: 'main' },
          title: 'Duplicate Test',
          user: { login: 'author' },
          draft: false,
        },
      },
    });

    const finalJob = await getJobForProcessing(env, existing.id);
    expect(finalJob?.status).toBe('done');
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('schedules a delayed continuation instead of spending queue retries on transient model failures', async () => {
    const { ModelService } = await import('@server/services/model');
    const retryableError = Object.assign(new Error('Google API timed out after 45000ms'), { retryable: true });
    const reviewSpy = vi.spyOn(ModelService.prototype, 'reviewFile').mockRejectedValue(retryableError);
    const repo = `test-repo-${Date.now()}-transient`;
    const headSha = sha('6');
    const baseSha = sha('7');

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 5,
      prTitle: 'Transient Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-transient',
        phase: 'review',
      });

      // Transient model failure (not a subrequest limit) -> stays in-instance, freshInstance false.
      expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: 30, jobId: expect.any(String), freshInstance: false });
      expect(reviewSpy).toHaveBeenCalled();
      expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
    });

    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('running');
    expect(finalJob?.lease_owner).toBeNull();

    reviewSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('reviews files in a chunk concurrently', async () => {
    const { GitHubService } = await import('@server/services/github');
    const { ModelService } = await import('@server/services/model');
    const repo = `test-repo-${Date.now()}-concurrent`;
    const headSha = sha('8');
    const baseSha = sha('9');
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([
        { path: 'src/one.ts', content: 'console.log(1);' },
        { path: 'src/two.ts', content: 'console.log(2);' },
      ]),
    );
    let active = 0;
    let maxActive = 0;
    const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(async (params: any) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return {
        parsed: {
          comments: [],
          verdict: 'approve',
          fileSummary: `Reviewed ${params.file.path}`,
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
    });

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 6,
      prTitle: 'Concurrent Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 2);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-concurrent',
        phase: 'review',
      });

      // Finalize always yields long enough to hibernate into a fresh invocation (fresh subrequest
      // budget), so the delay is the hibernation yield, not 0.
      // Transitioning into finalize -> runs on a fresh instance for a clean subrequest budget.
      expect(result).toEqual({ action: 'next_phase', phase: 'finalize', delaySeconds: expect.any(Number), jobId: expect.any(String), freshInstance: true });
      expect(result.action === 'next_phase' && result.delaySeconds).toBeGreaterThan(0);
      expect(maxActive).toBe(2);
      expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
    });

    const reviews = await getFileReviewsForJobs(env, [job.id]);
    expect(reviews.filter((review) => review.file_status === 'done')).toHaveLength(2);

    reviewSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  // --- Phase 10-05 multi-pass security scheduling (MP-01 / MP-05 / NREG-01) ------------------------
  describe('multi-pass security scheduling', () => {
    // Repo config with the security pass enabled; everything else is default (NREG-01 baseline uses
    // plain defaultRepoConfig, which has passes.security.enabled === false).
    const securityConfig = (): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        passes: {
          ...defaultRepoConfig.review.passes,
          security: { enabled: true, cross_file: false },
        },
      },
    });

    const insertReviewJob = (repo: string, config: RepoConfig, commitChar: string) =>
      insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 7,
        prTitle: 'Security Pass Test',
        prAuthor: 'author',
        commitSha: sha(commitChar),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });

    const okReview = (path: string) => ({
      parsed: {
        comments: [],
        verdict: 'approve' as const,
        fileSummary: `Reviewed ${path}`,
        overallCorrectness: 'no issues',
        confidenceScore: 0.9,
      },
      modelUsed: 'test-model',
      provider: 'test-provider',
      inputTokens: 10,
      outputTokens: 5,
      rawText: '{}',
      userPrompt: '',
    });

    it('schedules a (file,security) unit alongside (file,main) and persists both passes (MP-01)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-sec-schedule`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );
      const seen: Array<{ path: string; pass: string }> = [];
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(async (params: any) => {
        seen.push({ path: params.file.path, pass: params.pass ?? 'main' });
        return okReview(params.file.path);
      });

      const job = await insertReviewJob(repo, securityConfig(), 'a');
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runAndDrain({ jobId: job.id, deliveryId: 'delivery-sec-schedule' });

      const reviews = await getFileReviewsForJobs(env, [job.id]);
      for (const path of ['src/one.ts', 'src/two.ts']) {
        const passes = reviews.filter((r) => r.file_path === path).map((r) => r.pass).sort();
        expect(passes).toEqual(['main', 'security']);
        expect(reviews.filter((r) => r.file_path === path && r.file_status === 'done')).toHaveLength(2);
      }
      // The security prompt (10-04) is actually routed for each eligible file, not just persisted.
      expect(seen.filter((s) => s.pass === 'security').map((s) => s.path).sort()).toEqual(['src/one.ts', 'src/two.ts']);

      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('retries only the security unit on a transient failure and leaves the main row intact (per-unit retry)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService, RetryableModelError } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-sec-retry`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      // Fail ONLY the security unit; the main unit succeeds. The tuple-keyed writers must record the
      // security failure on the (file,'security') row without disturbing the (file,'main') row.
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(async (params: any) => {
        if ((params.pass ?? 'main') === 'security') {
          throw new (RetryableModelError as any)('Google API timed out after 45000ms');
        }
        return okReview(params.file.path);
      });

      const job = await insertReviewJob(repo, securityConfig(), 'b');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runWithDb(env, async () => {
        (env.REVIEW_QUEUE as any).sent.length = 0;
        const result = await runReviewJob(env, {
          jobId: job.id,
          deliveryId: 'delivery-sec-retry',
          phase: 'review',
        });
        // A transient security-unit failure defers the chunk (stays in-instance, freshInstance false)
        // exactly like a transient main-unit failure would -- it does not fail the job.
        expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: expect.any(Number), jobId: expect.any(String), freshInstance: false });
      });

      const reviews = await getFileReviewsForJobs(env, [job.id]);
      const main = reviews.find((r) => r.file_path === 'src/app.ts' && r.pass === 'main');
      const security = reviews.find((r) => r.file_path === 'src/app.ts' && r.pass === 'security');
      // Main row is terminal and untouched by the security failure.
      expect(main?.file_status).toBe('done');
      // Security row carries its OWN retryable-failure bookkeeping (separate (job,file,'security') row).
      expect(security?.file_status).toBe('failed');
      expect(security?.transient_error_count).toBeGreaterThanOrEqual(1);

      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('bounds concurrent in-flight model calls to budgetAwareFileLimit even with a doubled unit list (MP-05)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-sec-concurrency`;
      // A large file whose security unit would fan out to multiple chunks inside the real reviewFile
      // (bounded WITHIN the unit by isNearLimit); here it is one mocked call, but it stands in for the
      // large multi-chunk security file the budget model must still bound at the UNIT-concurrency level.
      const largeContent = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
          { path: 'src/big.ts', content: largeContent },
        ]),
      );
      let active = 0;
      let maxActive = 0;
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(async (params: any) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return okReview(params.file.path);
      });

      const job = await insertReviewJob(repo, securityConfig(), 'c');
      await updateJobFileCount(env, job.id, 3);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runAndDrain({ jobId: job.id, deliveryId: 'delivery-sec-concurrency' });

      // The concurrency bound is derived from the SAME budget model the scheduler uses (default
      // 'medium' concurrency). Even though security DOUBLES the unit list to 6 units, in-flight calls
      // never exceed budgetAwareFileLimit -- the extra pass runs as MORE chunks, not wider chunks.
      const bound = budgetAwareFileLimit(new TokenTracker().remainingSafeBudget(), REVIEW_CONCURRENCY_LIMITS.medium);
      expect(maxActive).toBeLessThanOrEqual(bound);
      // ...and the doubled unit list actually saturates the bound (proves it is genuinely bounded, not
      // merely that too few units existed to reach the limit).
      expect(maxActive).toBe(bound);

      const reviews = await getFileReviewsForJobs(env, [job.id]);
      expect(reviews.filter((r) => r.file_status === 'done')).toHaveLength(6);

      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('writes no security rows and stays byte-identical when the security pass is off (NREG-01)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-sec-off`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );

      const job = await insertReviewJob(repo, defaultRepoConfig, 'd');
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      await runAndDrain({ jobId: job.id, deliveryId: 'delivery-sec-off' });

      const reviews = await getFileReviewsForJobs(env, [job.id]);
      expect(reviews.filter((r) => r.pass === 'security')).toHaveLength(0);
      expect(reviews.filter((r) => r.pass === 'main' && r.file_status === 'done')).toHaveLength(2);

      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);
  });

  describe('multi-pass critic phase (MP-03)', () => {
    // Repo config with the critic pass enabled. skip_threshold/input_char_budget/security are
    // overridable so a case can force the model call (skip_threshold: 0/1) or leave the default guard.
    const criticConfig = (overrides?: { skip_threshold?: number; input_char_budget?: number; security?: boolean }): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        passes: {
          ...defaultRepoConfig.review.passes,
          security: { enabled: overrides?.security ?? false, cross_file: false },
          critic: {
            enabled: true,
            ...(overrides?.skip_threshold !== undefined ? { skip_threshold: overrides.skip_threshold } : {}),
            ...(overrides?.input_char_budget !== undefined ? { input_char_budget: overrides.input_char_budget } : {}),
          },
        },
      },
    });

    const insertCriticJob = (repo: string, config: RepoConfig, commitChar: string) =>
      insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'Critic Pass Test',
        prAuthor: 'author',
        commitSha: sha(commitChar),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });

    // A finding per reviewed file so a multi-file diff yields a multi-finding candidate set.
    const findingReview = (params: any) => ({
      parsed: {
        comments: [{
          path: params.file.path,
          line: 1,
          position: 1,
          severity: 'P2',
          category: 'quality',
          title: `Finding in ${params.file.path}`,
          body: `Issue body for ${params.file.path}`,
        }],
        verdict: 'comment' as const,
        fileSummary: `Reviewed ${params.file.path}`,
        overallCorrectness: 'issues found',
        confidenceScore: 0.9,
      },
      modelUsed: 'test-model',
      provider: 'test-provider',
      inputTokens: 10,
      outputTokens: 5,
      rawText: '{}',
      userPrompt: '',
    });

    // Drain the phase loop, recording the observed next_phase sequence so a test can assert whether
    // the critic phase was (or was not) entered.
    async function drainCapturingPhases(message: Parameters<typeof runReviewJob>[1]) {
      const phases: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: typeof message | null = message;
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phases.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            const jobId = (currentMessage as any).jobId;
            if (jobId) {
              await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
            }
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });
      return phases;
    }

    const readCriticResult = async (jobId: string) => {
      const row = await getJobForProcessing(env, jobId);
      return row ? mapJob(row).criticResult : null;
    };

    it('persists { kept, pruned } and reconciles kept = deduped minus pruned-by-id', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-persist`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      // Phase 19 (PASS-01 / D-09): the critic v2 model output is `{ verdicts: [{id, verdict, reason}] }`.
      // Mark id 0 as unsupported so the reconciler drops it; id 1 is omitted and falls through to the
      // v2 no-verdict drop path.
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings').mockResolvedValue({
        rawText: '{"verdicts":[{"id":0,"verdict":"unsupported","reason":"duplicate of another finding"},{"id":1,"verdict":"proven","reason":"evidence-supported"}]}',
        modelUsed: 'critic-model',
        inputTokens: 5,
        outputTokens: 2,
      });

      // skip_threshold: 1 so a 2-finding set is above the threshold and the model call runs.
      const job = await insertCriticJob(repo, criticConfig({ skip_threshold: 1 }), 'a');
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const phases = await drainCapturingPhases({ jobId: job.id, deliveryId: 'delivery-critic-persist' });

      expect(phases).toContain('critic');
      expect(phases.indexOf('critic')).toBeLessThan(phases.indexOf('finalize'));
      expect(critiqueSpy).toHaveBeenCalledTimes(1);

      const criticResult = await readCriticResult(job.id);
      expect(criticResult).not.toBeNull();
      expect(criticResult?.skipped).toBe(false);
      expect(criticResult?.dedupedCount).toBe(2);
      // v2 ledger: exactly 2 decisions, one per candidate.
      expect(criticResult?.decisions).toHaveLength(2);
      expect(criticResult?.decisions?.[0].outcome).toBe('dropped');
      expect(criticResult?.decisions?.[1].outcome).toBe('kept');
      expect(criticResult?.status).toBe('completed');
      expect(criticResult?.version).toBe(2);
      // kept + pruned accounts for the whole deduped candidate set (nothing invented, nothing lost).
      expect((criticResult?.kept.length ?? 0) + (criticResult?.pruned.length ?? 0)).toBe(2);

      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('a'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('honors an explicit skip_threshold and keeps all findings when the candidate set is at/below it', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-skip`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      // D-06 (v2): the implicit small-set skip is gone. The critic still runs on a single-finding
      // set by default; only an explicit skip_threshold keeps it as a no-op keep-all skip.
      const job = await insertCriticJob(repo, criticConfig({ skip_threshold: 1 }), 'b');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const phases = await drainCapturingPhases({ jobId: job.id, deliveryId: 'delivery-critic-skip' });

      expect(phases).toContain('critic');
      // The critic phase ran but did NOT call the model (keep-all skip).
      expect(critiqueSpy).not.toHaveBeenCalled();

      const criticResult = await readCriticResult(job.id);
      expect(criticResult?.skipped).toBe(true);
      expect(criticResult?.pruned).toHaveLength(0);
      expect(criticResult?.kept).toHaveLength(1);
      expect(criticResult?.status).toBe('skipped');
      expect(criticResult?.reason).toBe('below-skip-threshold');
      expect(criticResult?.decisions).toHaveLength(1);
      expect(criticResult?.decisions?.[0].outcome).toBe('kept');
      expect(criticResult?.decisions?.[0].verdict).toBeNull();

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('fails open (keeps all findings, job completes) when the critic model call errors', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService, RetryableModelError } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-failopen`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      // Even a RetryableModelError must fail OPEN inside the critic (never fail/wedge the job).
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings').mockRejectedValue(
        new (RetryableModelError as any)('Critic provider timed out'),
      );

      const job = await insertCriticJob(repo, criticConfig({ skip_threshold: 1 }), 'c');
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const phases = await drainCapturingPhases({ jobId: job.id, deliveryId: 'delivery-critic-failopen' });

      expect(phases).toContain('critic');
      expect(phases).toContain('finalize');

      const criticResult = await readCriticResult(job.id);
      expect(criticResult?.skipped).toBe(true);
      expect(criticResult?.pruned).toHaveLength(0);
      // All candidate findings survive a failed critic — nothing is lost.
      expect(criticResult?.kept).toHaveLength(2);

      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('c'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('routes a continuation-ceiling review degrade INTO the critic when the critic is enabled', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-degrade`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      // A subrequest-budget error makes the review chunk defer; with the continuation counter already
      // at the ceiling, continueOrFailWedgedJob degrades — and must route through the critic selector.
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      const job = await insertCriticJob(repo, criticConfig(), 'd');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      // Pre-set the continuation counter to the ceiling so the next deferral tips the degrade branch.
      await queryRows(env, `UPDATE jobs SET continuation_count = 20 WHERE id = $1`, [job.id]);

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-critic-degrade', phase: 'review' });
        // A degraded review with the critic ON routes to 'critic' (not straight to 'finalize').
        expect(result).toEqual({
          action: 'next_phase',
          phase: 'critic',
          delaySeconds: expect.any(Number),
          jobId: job.id,
          freshInstance: true,
        });
      });

      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('NREG-01: with the critic off, no critic phase is entered and critic_result stays null', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-off`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      const job = await insertCriticJob(repo, defaultRepoConfig, 'e');
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const phases = await drainCapturingPhases({ jobId: job.id, deliveryId: 'delivery-critic-off' });

      // review -> finalize directly; the critic phase is never observed and the model is never called.
      expect(phases).not.toContain('critic');
      expect(critiqueSpy).not.toHaveBeenCalled();
      expect(await readCriticResult(job.id)).toBeNull();

      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('e'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Phase 20.1 (BLOCKER 3 + chain-order integration): end-to-end proof that the full chain
    // review → verify_fixes → critic → walkthrough_enrichment → finalize runs through `runReviewJob`
    // when all v1.2 toggles are ON. The verify-fixes phase uses the existing MockGitHubService
    // defaults (no unresolved threads, no file content) so it completes via the no-work-found path.
    // The critic phase runs `critiqueFindings` which returns a keep-all prune. The walkthrough
    // enrichment phase runs the default buildWalkthroughData path. The draining helper captures
    // every `next_phase` action so the chain order is asserted explicitly.
    it('chains review → verify_fixes → critic → walkthrough_enrichment → finalize at all-v1.2-toggles-on (BLOCKER 3 + chain integration)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-blocker3-chain`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([
          { path: 'src/one.ts', content: 'console.log(1);' },
          { path: 'src/two.ts', content: 'console.log(2);' },
        ]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      // Critic v2 calls `parseCriticV2Response(response.rawText)` (review.ts:2846). The mock must
      // return a `rawText` string containing the v2 envelope `{ verdicts: [{id, verdict, reason}] }`
      // (see critic-v2.ts:parseCriticV2Response). The default MockModelService.critiqueFindings
      // returns the legacy `{"prune": []}` shape which the v2 parser rejects → fail-open.
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings').mockResolvedValue({
        rawText: JSON.stringify({
          verdicts: [
            { id: 0, verdict: 'keep', reason: 'kept' },
            { id: 1, verdict: 'keep', reason: 'kept' },
          ],
        }),
        modelUsed: 'critic-model',
        inputTokens: 5,
        outputTokens: 2,
      });
      // The MockGitHubService defaults (added with the verify-fixes fix) make the verify-fixes
      // phase run via the no-threads path: getReviewThreads returns [] and resolveReviewThread
      // returns true. No per-test spy required.

      // All v1.2 toggles ON: the full chain review → verify_fixes → critic → walkthrough_enrichment → finalize.
      const allOnConfig: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true, skip_threshold: 1 },
          },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertCriticJob(repo, allOnConfig, 'g');
      await updateJobFileCount(env, job.id, 2);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      // Drain the chain, capturing every `next_phase` action so the chain order is asserted explicitly.
      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker3-chain', phase: 'review' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // Pin the chain order: verify_fixes first (after review), then critic, then walkthrough_enrichment, then finalize.
      const verifyIdx = phasesObserved.indexOf('verify_fixes');
      const criticIdx = phasesObserved.indexOf('critic');
      const walkIdx = phasesObserved.indexOf('walkthrough_enrichment');
      const finalizeIdx = phasesObserved.indexOf('finalize');
      expect(verifyIdx).toBeGreaterThanOrEqual(0);
      expect(criticIdx).toBeGreaterThan(verifyIdx);
      expect(walkIdx).toBeGreaterThan(criticIdx);
      expect(finalizeIdx).toBeGreaterThan(walkIdx);

      // The critic phase actually ran (not skipped) — proves BLOCKER 3 chained verify_fixes → critic.
      expect(critiqueSpy).toHaveBeenCalled();

      // The critic result was persisted (BLOCKER 3 evidence: the critic passed the verify_fixes
      // gate, which is the chain the audit identified as missing).
      const criticResult = await readCriticResult(job.id);
      expect(criticResult).not.toBeNull();
      expect(criticResult?.skipped).toBe(false);

      // The job reached 'done' — the finalize step ran successfully.
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('g'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Phase 20.1 (BLOCKER 4): the verify-fixes idempotency guard + review-rest guard used to
    // `return` without scheduling a successor. A crash between the terminal write and the throw
    // left the job non-terminal indefinitely -- the queue message was acked with no next-phase
    // message and finalize never ran. The fix: both guards now schedule a successor via
    // markJobContinuationQueued + NextPhaseError(nextPhaseAfterVerifyFixes(config)). These three
    // integration tests pin the end-to-end behavior at the runReviewJob level.
    //
    //   Test 11: a verify_fixes job whose durable state is 'completed' (simulating the post-
    //            terminal-write crash) recovers: the idempotency guard fires, schedules the
    //            successor, and the chain reaches finalize.
    //   Test 12: a review-rest job with verify_fixes enabled sees the review-rest guard fire and
    //            schedules the successor (no-op on the verify-fixes work, but the chain continues).
    //   Test 13: a double-enqueue (two consecutive runVerifyFixesPhase calls both scheduling the
    //            same successor) is absorbed by the runFinalizePhase idempotency: the finalize
    //            phase runs exactly once.
    it('BLOCKER 4: a verify_fixes job with terminal durable state schedules successor + chain reaches finalize', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-blocker4-crash`;

      // v1.2 toggles: verify_fixes + critic on, walkthrough off. The chain is
      // review → verify_fixes (idempotency guard) → critic → finalize. With verify_fixes
      // terminal state pre-loaded, the idempotency guard fires and schedules critic.
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true, skip_threshold: 1 },
          },
        },
      };

      // Insert a job that already has review files counted + prepare done so verify_fixes is the
      // next phase. Pre-load thread_verifications = completed to simulate the post-terminal-write
      // crash state: the verify-fixes phase will see status='completed' and the BLOCKER 4 fix
      // will fire on the idempotency guard.
      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'BLOCKER 4 crash recovery test',
        prAuthor: 'author',
        commitSha: sha('h'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      // Insert a 'done' file_review so the finalize phase does not fail-closed on the
      // 'all files failed' gate (review.ts:2182). The BLOCKER 4 chain assertion only needs the
      // chain to reach finalize, not to assert the review quality.
      await upsertFileReview(env, job.id, {
        filePath: 'src/app.ts',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: [],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'approve',
        fileSummary: 'ok',
        errorMessage: null,
      });

      const terminalState: ThreadVerifications = {
        version: 1,
        status: 'completed',
        entries: [],
        totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
      };
      await setJobThreadVerifications(env, job.id, terminalState);

      // Spy on markJobContinuationQueued so we can verify it was called by the BLOCKER 4 guard.
      // Use the static-imported module reference (line 5) so the spy wraps the SAME instance the
      // production code uses; dynamic `await import('@server/db/jobs')` would create a separate
      // module instance under vitest's vi.mock and the spy would never see the production calls.
      const continuationSpy = vi.spyOn(
        jobsModule,
        'markJobContinuationQueued',
      );

      // Drain the chain starting from verify_fixes. The BLOCKER 4 fix schedules the successor
      // (critic), then the chain continues critic → finalize.
      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker4-crash', phase: 'verify_fixes' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // The idempotency guard fired and scheduled critic. The chain reached finalize.
      expect(phasesObserved[0]).toBe('critic');
      expect(phasesObserved).toContain('finalize');

      // markJobContinuationQueued was called by the BLOCKER 4 fix (the success path also calls
      // it, so we just confirm it was called at least once during the verify_fixes phase).
      expect(continuationSpy).toHaveBeenCalled();

      // The job reached 'done' — the chain completed after the simulated crash recovery.
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('h'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      continuationSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 4: a review-rest job with verify_fixes enabled schedules successor via review-rest guard', async () => {
      // A review-rest job with verify_fixes enabled hits the review-rest guard (verify-fixes.ts:449).
      // The BLOCKER 4 fix schedules the successor so the chain reaches finalize. The verify_fixes
      // work itself is skipped (D-03), but the chain MUST continue.
      const repo = `test-repo-${Date.now()}-blocker4-rest`;

      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
        },
      };

      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'BLOCKER 4 review-rest test',
        prAuthor: 'author',
        commitSha: sha('r'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
        reviewScope: 'rest',
        scopeSourceJobId: null,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      // Insert a 'done' file_review so the finalize phase does not fail-closed on the
      // 'all files failed' gate (review.ts:2182).
      await upsertFileReview(env, job.id, {
        filePath: 'src/app.ts',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: [],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'approve',
        fileSummary: 'ok',
        errorMessage: null,
      });

      // Spy on markJobContinuationQueued to confirm the BLOCKER 4 review-rest guard calls it.
      const continuationSpy = vi.spyOn(
        jobsModule,
        'markJobContinuationQueued',
      );

      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker4-rest', phase: 'verify_fixes' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // The review-rest guard fired and scheduled finalize (no critic, no walkthrough).
      // The chain reaches finalize.
      expect(phasesObserved).toContain('finalize');
      expect(continuationSpy).toHaveBeenCalled();

      // The job reached 'done'.
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');

      continuationSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 4: a double-enqueue (two consecutive guard fires) is absorbed by runFinalizePhase idempotency', async () => {
      // The D-17 idempotent counter is markJobContinuationQueued. The next-phase guards in
      // runCriticPhase / runWalkthroughEnrichmentPhase / runFinalizePhase absorb any double-enqueue.
      // This test simulates the worst case: TWO consecutive verify_fixes invocations both hit the
      // idempotency guard and both schedule 'finalize'. The first one drives the chain; the
      // second is absorbed (runFinalizePhase is idempotent on the already-done job).
      const repo = `test-repo-${Date.now()}-blocker4-double`;

      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
        },
      };

      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'BLOCKER 4 double-enqueue test',
        prAuthor: 'author',
        commitSha: sha('d'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      // Insert a 'done' file_review so the finalize phase does not fail-closed on the
      // 'all files failed' gate (review.ts:2182).
      await upsertFileReview(env, job.id, {
        filePath: 'src/app.ts',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: [],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'approve',
        fileSummary: 'ok',
        errorMessage: null,
      });

      const terminalState: ThreadVerifications = {
        version: 1,
        status: 'completed',
        entries: [],
        totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
      };
      await setJobThreadVerifications(env, job.id, terminalState);

      const continuationSpy = vi.spyOn(
        jobsModule,
        'markJobContinuationQueued',
      );

      // First verify_fixes invocation: BLOCKER 4 guard fires → schedules finalize.
      // The runReviewJob result must be { action: 'next_phase', phase: 'finalize' }.
      const firstResult = await runWithDb(env, async () =>
        runReviewJob(env, {
          jobId: job.id,
          deliveryId: 'delivery-blocker4-double-1',
          phase: 'verify_fixes',
        }),
      );
      expect(firstResult.action).toBe('next_phase');
      if (firstResult.action === 'next_phase') {
        expect(firstResult.phase).toBe('finalize');
      }

      // markJobContinuationQueued stamps last_queue_message_at = now() + 60s, which would cause
      // the next claim to report 'busy' and return 'retry'. Backdate it so the second invocation
      // can actually claim the job (mirrors the drain-loop backdate in the existing tests).
      await runWithDb(env, async () => {
        await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
      });

      // The job is now in a state where finalize is queued. Before finalize runs, a SECOND
      // verify_fixes message arrives (simulating the queue replaying the message). The guard
      // fires again and schedules finalize again. The markJobContinuationQueued counter is
      // incremented a second time (D-17 idempotent).
      const secondResult = await runWithDb(env, async () =>
        runReviewJob(env, {
          jobId: job.id,
          deliveryId: 'delivery-blocker4-double-2',
          phase: 'verify_fixes',
        }),
      );
      expect(secondResult.action).toBe('next_phase');
      if (secondResult.action === 'next_phase') {
        expect(secondResult.phase).toBe('finalize');
      }

      // markJobContinuationQueued was called at least twice (once per guard fire).
      expect(continuationSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Backdate last_queue_message_at so the finalize claim doesn't see a fresh lease.
      await runWithDb(env, async () => {
        await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
      });

      // The runFinalizePhase idempotency absorbs the double-enqueue (it checks job.checkRunId +
      // the bot review idempotency, so a second finalize on a done job is a no-op). Calling
      // finalize with the real implementation: the first call acks after the work is done; a
      // second call also acks because the job is already 'done' / has a check_run_id.
      const firstFinalize = await runWithDb(env, async () =>
        runReviewJob(env, {
          jobId: job.id,
          deliveryId: 'delivery-blocker4-double-finalize-1',
          phase: 'finalize',
        }),
      );
      expect(firstFinalize.action).toBe('ack');

      // Backdate again for the second finalize.
      await runWithDb(env, async () => {
        await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
      });

      const secondFinalize = await runWithDb(env, async () =>
        runReviewJob(env, {
          jobId: job.id,
          deliveryId: 'delivery-blocker4-double-finalize-2',
          phase: 'finalize',
        }),
      );
      // Second finalize is absorbed: the job is already 'done', so the runReviewJob claim
      // returns no job and the runReviewJob top-level returns { action: 'ack' } via the
      // "job already terminal" path.
      expect(secondFinalize.action).toBe('ack');

      // The job stays 'done' after both finalize calls.
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');

      continuationSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Phase 20.1 (BLOCKER 5): the skip branch at review.ts:2803-2856 (empty input, explicit
    // skip_threshold, over-char-budget) used to persist the skipped ledger and return directly
    // to finalize, bypassing the audit emission and the walkthrough enrichment hop. The fix
    // hand-crafts a critic.decisions audit event with status='skipped' + reason + count=0 +
    // sample=[] and routes through verify_fixes (when enabled) then walkthrough_enrichment
    // (when enabled) then finalize — matching the no-skip path's chain at line 2945.
    //
    // These four integration tests pin the end-to-end behavior at the runReviewJob level:
    //   Test 11: empty candidates + walkthrough enabled → audit + walkthrough_enrichment
    //   Test 12: explicit skip_threshold hit + verify_fixes enabled → audit + verify_fixes
    //   Test 13: over-char-budget + all-off → audit + finalize
    //   Test 14: skip_threshold + verify_fixes + walkthrough enabled → audit + verify_fixes
    //            (chain order: verify_fixes first, walkthrough LAST before finalize)
    it('BLOCKER 5: empty candidates + walkthrough enabled emits audit + routes to walkthrough_enrichment', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-blocker5-empty`;

      // No diff at all — zero files, zero candidates. The review phase finds no files to
      // review and the critic's candidate set is empty.
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      // v1.2 toggles: critic ON, verify_fixes OFF, walkthrough ON. The skip path emits the
      // audit event, then routes to walkthrough_enrichment (skip path mirrors no-skip path).
      // skip_threshold is intentionally NOT set so the empty-candidates case fires reason
      // 'empty-input' (not 'below-skip-threshold' — see review.ts:2804-2808).
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true },
          },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertCriticJob(repo, config, 'a');
      await updateJobFileCount(env, job.id, 0);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      // Drain the chain, capturing every `next_phase` action so the chain order is asserted.
      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker5-empty', phase: 'review' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // The skip branch fired: the critic phase ran but never called the model (empty candidates).
      expect(critiqueSpy).not.toHaveBeenCalled();

      // The skip branch persisted the skipped ledger with status='skipped' + reason='empty-input'.
      const criticResult = await readCriticResult(job.id);
      expect(criticResult).not.toBeNull();
      expect(criticResult?.skipped).toBe(true);
      expect(criticResult?.status).toBe('skipped');
      expect(criticResult?.reason).toBe('empty-input');

      // The chain reached walkthrough_enrichment (skip path mirrors the no-skip path's chain at
      // line 2945: verify_fixes OFF → walkthrough_enrichment when enabled).
      expect(phasesObserved).toContain('walkthrough_enrichment');
      expect(phasesObserved).toContain('finalize');
      // Walkthrough_enrichment comes BEFORE finalize (it's the last hop before finalize).
      expect(phasesObserved.indexOf('walkthrough_enrichment')).toBeLessThan(phasesObserved.indexOf('finalize'));

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 5: explicit skip_threshold hit + verify_fixes enabled emits audit + does NOT re-enter verify_fixes', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-blocker5-skip-threshold`;

      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      // v1.2 toggles: critic ON with skip_threshold=1, verify_fixes ON, walkthrough OFF.
      // The single-finding candidate set is BELOW the skip_threshold, so the skip branch fires
      // with reason='below-skip-threshold'. The verify_fixes phase MUST have already run before
      // critic (chain order: review → verify_fixes → critic). The skip path's hand-off must NOT
      // route back to verify_fixes (that would recreate the critic → verify_fixes loop Plan
      // 20.1-02 fixed). The skip path routes via nextPhaseAfterCritic → finalize (walkthrough OFF).
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true, skip_threshold: 1 },
          },
        },
      };

      const job = await insertCriticJob(repo, config, 'b');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      // The chain is: review → verify_fixes (no threads, routes to critic) → critic (skip) → finalize.
      // The skip path's hand-off is via nextPhaseAfterCritic(config); with walkthrough OFF, that
      // returns 'finalize'. The verify_fixes phase already ran BEFORE the critic — the skip
      // terminal must NOT re-enter it.
      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker5-skip-threshold', phase: 'review' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // The skip branch fired: the critic phase ran but never called the model.
      expect(critiqueSpy).not.toHaveBeenCalled();

      // The skip branch persisted the skipped ledger with reason='below-skip-threshold'.
      const criticResult = await readCriticResult(job.id);
      expect(criticResult).not.toBeNull();
      expect(criticResult?.skipped).toBe(true);
      expect(criticResult?.status).toBe('skipped');
      expect(criticResult?.reason).toBe('below-skip-threshold');

      // Chain correctness: verify_fixes was visited at most once (BEFORE the critic skip).
      // The skip terminal must NOT re-enter verify_fixes — that would loop.
      const verifyFixesCount = phasesObserved.filter((p) => p === 'verify_fixes').length;
      expect(verifyFixesCount).toBeLessThanOrEqual(1);

      // The chain reached finalize (the skip path → walkthrough_enrichment (OFF) → finalize).
      expect(phasesObserved).toContain('finalize');

      // The critic skip terminal's hand-off is the next phase AFTER the critic in the observed
      // sequence. The phase immediately AFTER the 'critic' hand-off must be 'finalize' (or
      // 'walkthrough_enrichment' when walkthrough is on, but in this test walkthrough is OFF).
      // It MUST NOT be 'verify_fixes' — that's the loop.
      const criticIdx = phasesObserved.indexOf('critic');
      if (criticIdx >= 0 && criticIdx < phasesObserved.length - 1) {
        // The critic's hand-off is the next phase the runReviewJob sees after the critic phase
        // runs. Actually, the chain emits the hand-off via `next_phase` action from runReviewJob
        // and the message is then re-routed. The observed phase after critic is the hand-off.
        const phaseAfterCritic = phasesObserved[criticIdx + 1];
        expect(phaseAfterCritic).not.toBe('verify_fixes');
      }

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 5: over-char-budget + all-off emits audit + routes to finalize', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-blocker5-overbudget`;

      // A single long finding whose serialized JSON exceeds the input_char_budget of 100 chars.
      const longBody = 'x'.repeat(500);
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(
        (params: any) => ({
          parsed: {
            comments: [{
              path: params.file.path,
              line: 1,
              position: 1,
              severity: 'P2',
              category: 'quality',
              title: 'Long finding',
              body: longBody,
            }],
            verdict: 'comment' as const,
            fileSummary: `Reviewed ${params.file.path}`,
            overallCorrectness: 'issues found',
            confidenceScore: 0.9,
          },
          modelUsed: 'test-model',
          provider: 'test-provider',
          inputTokens: 10,
          outputTokens: 5,
          rawText: '{}',
          userPrompt: '',
        }),
      );
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      // v1.2 toggles: critic ON with input_char_budget=100, verify_fixes OFF, walkthrough OFF.
      // The single long finding's serialized JSON exceeds 100 chars, so the skip branch fires
      // with reason='over-char-budget'. The skip path then routes to finalize (NREG-01 default).
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true, input_char_budget: 100 },
          },
        },
      };

      const job = await insertCriticJob(repo, config, 'c');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker5-overbudget', phase: 'review' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // The skip branch fired: the critic phase ran but never called the model.
      expect(critiqueSpy).not.toHaveBeenCalled();

      // The skip branch persisted the skipped ledger with reason='over-char-budget'.
      const criticResult = await readCriticResult(job.id);
      expect(criticResult).not.toBeNull();
      expect(criticResult?.skipped).toBe(true);
      expect(criticResult?.status).toBe('skipped');
      expect(criticResult?.reason).toBe('over-char-budget');

      // The chain reached finalize (NREG-01: all-off → finalize).
      expect(phasesObserved).toContain('finalize');
      // The skip path does NOT route to verify_fixes or walkthrough_enrichment (both off).
      expect(phasesObserved).not.toContain('verify_fixes');
      expect(phasesObserved).not.toContain('walkthrough_enrichment');

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 5: skip_threshold + verify_fixes + walkthrough all on — chain has no second verify_fixes hop after critic', async () => {
      // Phase 20.1 (BLOCKER 5 chain correctness): when verify_fixes + critic + walkthrough are
      // all enabled, the chain order is review → verify_fixes (BEFORE critic) → critic (skip)
      // → walkthrough_enrichment (AFTER critic) → finalize. The skip path MUST NOT re-enter
      // verify_fixes — that would recreate the critic → verify_fixes loop Plan 20.1-02 fixed.
      // Test 14 proves the skip path's hand-off is to walkthrough_enrichment (NOT verify_fixes)
      // and that verify_fixes appears exactly once in the chain (before the critic, not after).
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-blocker5-chain`;

      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      const reviewSpy = vi.spyOn(ModelService.prototype as any, 'reviewFile').mockImplementation(findingReview);
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      // All v1.2 toggles ON: critic + verify_fixes + walkthrough. The candidate set is at the
      // skip_threshold (single finding), so the critic skip path fires with reason
      // 'below-skip-threshold'. The skip path's hand-off is via nextPhaseAfterCritic(config),
      // which returns 'walkthrough_enrichment' (walkthrough ON) → 'finalize'.
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true, skip_threshold: 1 },
          },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertCriticJob(repo, config, 'd');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

      const phasesObserved: string[] = [];
      await runWithDb(env, async () => {
        let currentMessage: any = { jobId: job.id, deliveryId: 'delivery-blocker5-chain', phase: 'review' };
        let retries = 0;
        while (currentMessage) {
          const result = await runReviewJob(env, currentMessage);
          if (result.action === 'next_phase') {
            phasesObserved.push(result.phase);
            currentMessage = { ...currentMessage, phase: result.phase };
            retries = 0;
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
          } else if (result.action === 'retry') {
            if (++retries > 5) throw new Error('Max retries exceeded');
            break;
          } else {
            currentMessage = null;
          }
        }
      });

      // The skip branch fired: the critic phase ran but never called the model.
      expect(critiqueSpy).not.toHaveBeenCalled();

      // The skip branch persisted the skipped ledger with reason='below-skip-threshold'.
      const criticResult = await readCriticResult(job.id);
      expect(criticResult).not.toBeNull();
      expect(criticResult?.skipped).toBe(true);
      expect(criticResult?.status).toBe('skipped');
      expect(criticResult?.reason).toBe('below-skip-threshold');

      // CHAIN CORRECTNESS ASSERTION: verify_fixes appears BEFORE the critic phase (it is the
      // hop after review, not the hop after critic). The skip path's hand-off does NOT re-enter
      // verify_fixes — verify_fixes is observed EXACTLY ONCE in the chain, and that observation
      // occurs BEFORE the critic. This is the loop-prevention invariant.
      const verifyIndices = phasesObserved
        .map((p, i) => (p === 'verify_fixes' ? i : -1))
        .filter((i) => i >= 0);
      const criticIdx = phasesObserved.indexOf('critic');
      expect(verifyIndices).toHaveLength(1);
      expect(verifyIndices[0]).toBeLessThan(criticIdx);

      // The skip path's hand-off is walkthrough_enrichment (walkthrough ON), then finalize.
      const walkIdx = phasesObserved.indexOf('walkthrough_enrichment');
      const finalizeIdx = phasesObserved.indexOf('finalize');
      expect(walkIdx).toBeGreaterThan(criticIdx);
      expect(finalizeIdx).toBeGreaterThan(walkIdx);

      // The phase immediately after the critic (the skip path's hand-off) is walkthrough_enrichment,
      // NOT verify_fixes. This is the load-bearing assertion: the skip terminal routes through
      // walkthrough, never back to verify_fixes.
      const phaseAfterCritic = phasesObserved[criticIdx + 1];
      expect(phaseAfterCritic).toBe('walkthrough_enrichment');
      expect(phaseAfterCritic).not.toBe('verify_fixes');

      // The chain terminates — the job reaches 'done'.
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('d'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      critiqueSpy.mockRestore();
      reviewSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Phase 20.1 (GAP-02 / BLOCKER 2 + 3 ceiling routing): the critic and verify_fixes
    // continuation-ceiling branches at review.ts:659-696 used to hardcode 'finalize' as the
    // successor, silently bypassing configured downstream passes. The fix replaces them with
    // the canonical selectors so the chain stays symmetric under healthy and degraded
    // completion. These tests force every tested toggle combination with continuation_count
    // already at the ceiling and assert the configured successor.
    //
    // Plan 20.1-08 Task 1: critic ceiling handoff uses nextPhaseAfterCritic.
    it('BLOCKER 2 + 3 ceiling: wedged critic with walkthrough ON routes to walkthrough_enrichment (not raw finalize)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-ceiling-walk`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      // Force a subrequest-budget error inside the critic so continueOrFailWedgedJob runs.
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      // critic + walkthrough ON. The ceiling handoff must reach walkthrough_enrichment via
      // nextPhaseAfterCritic — NOT bypass it straight to finalize.
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true },
          },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertCriticJob(repo, config, 'ce');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      // Insert a 'done' file_review with non-empty parsed_comments so the critic phase has
      // candidates to grade (the skip branch at review.ts:2803 fires on empty candidates and
      // does NOT call critiqueFindings — its hand-off is via enqueueJobPhase + NextPhaseError,
      // which never reaches the ceiling branch).
      await upsertFileReview(env, job.id, {
        filePath: 'src/one.ts',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: [{
          path: 'src/one.ts',
          line: 1,
          position: 1,
          severity: 'P2',
          category: 'quality',
          title: 'Test finding for ceiling',
          body: 'Body for ceiling test',
        }],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'comment',
        fileSummary: 'ok',
        errorMessage: null,
      });
      // Pre-set the continuation counter to MAX_FINALIZE_CONTINUATIONS so the next bump (via
      // markJobContinuationQueued) trips the ceiling branch.
      await queryRows(env, `UPDATE jobs SET continuation_count = 3 WHERE id = $1`, [job.id]);

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-critic-ceiling-walk', phase: 'critic' });
        expect(result.action).toBe('next_phase');
        if (result.action === 'next_phase') {
          expect(result.phase).toBe('walkthrough_enrichment');
          expect(result.freshInstance).toBe(true);
          expect(result.delaySeconds).toEqual(expect.any(Number));
          expect(result.jobId).toBe(job.id);
        }
      });

      // Continuation count was reset to 0 by the ceiling branch (release-once fresh budget).
      const updated = await queryRows<{ continuation_count: number }>(env, `SELECT continuation_count FROM jobs WHERE id = $1`, [job.id]);
      expect(updated[0].continuation_count).toBe(0);

      // The job is NOT failed; the lease is released; the runReviewJob returned a next_phase.
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('ce'), trigger: 'auto' });
      expect(finalJob?.status).not.toBe('failed');

      critiqueSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 2 + 3 ceiling: wedged critic with walkthrough OFF routes to finalize (selector default)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-ceiling-no-walk`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      // critic ON, walkthrough OFF. The ceiling handoff must reach finalize directly via
      // nextPhaseAfterCritic.
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true },
          },
        },
      };

      const job = await insertCriticJob(repo, config, 'cf');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await upsertFileReview(env, job.id, {
        filePath: 'src/one.ts',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: [{
          path: 'src/one.ts',
          line: 1,
          position: 1,
          severity: 'P2',
          category: 'quality',
          title: 'Test finding for ceiling',
          body: 'Body for ceiling test',
        }],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'comment',
        fileSummary: 'ok',
        errorMessage: null,
      });
      await queryRows(env, `UPDATE jobs SET continuation_count = 3 WHERE id = $1`, [job.id]);

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-critic-ceiling-no-walk', phase: 'critic' });
        expect(result.action).toBe('next_phase');
        if (result.action === 'next_phase') {
          expect(result.phase).toBe('finalize');
          expect(result.freshInstance).toBe(true);
        }
      });

      const updated = await queryRows<{ continuation_count: number }>(env, `SELECT continuation_count FROM jobs WHERE id = $1`, [job.id]);
      expect(updated[0].continuation_count).toBe(0);

      critiqueSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Loop-prevention invariant: the critic ceiling handoff uses nextPhaseAfterCritic, which
    // never returns 'verify_fixes'. Even when verify_fixes is enabled, the post-critic ceiling
    // handoff must skip past it (verify_fixes is the FIRST hop after review, not a hop after
    // critic — re-entering verify_fixes would recreate the loop Plan 20.1-02 fixed).
    it('BLOCKER 2 + 3 ceiling: wedged critic never routes to verify_fixes (loop-prevention invariant)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-critic-ceiling-noverify`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/one.ts', content: 'console.log(1);' }]),
      );
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      // All v1.2 toggles ON: verify_fixes + critic + walkthrough.
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true },
          },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertCriticJob(repo, config, 'cl');
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await upsertFileReview(env, job.id, {
        filePath: 'src/one.ts',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: [{
          path: 'src/one.ts',
          line: 1,
          position: 1,
          severity: 'P2',
          category: 'quality',
          title: 'Test finding for ceiling',
          body: 'Body for ceiling test',
        }],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'comment',
        fileSummary: 'ok',
        errorMessage: null,
      });
      await queryRows(env, `UPDATE jobs SET continuation_count = 3 WHERE id = $1`, [job.id]);

      await runWithDb(env, async () => {
        const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-critic-ceiling-noverify', phase: 'critic' });
        expect(result.action).toBe('next_phase');
        if (result.action === 'next_phase') {
          // MUST route to walkthrough_enrichment (nextPhaseAfterCritic), NOT verify_fixes.
          expect(result.phase).toBe('walkthrough_enrichment');
          expect(result.phase).not.toBe('verify_fixes');
          expect(result.phase).not.toBe('finalize');
        }
      });

      critiqueSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Plan 20.1-08 Task 2: verify_fixes ceiling handoff uses nextPhaseAfterVerifyFixes.
    it('BLOCKER 2 + 3 ceiling: wedged verify_fixes with critic + walkthrough ON routes to critic', async () => {
      const repo = `test-repo-${Date.now()}-verifyfixes-ceiling-critic`;

      // All v1.2 toggles ON: verify_fixes + critic + walkthrough. The verify_fixes ceiling must
      // route to critic (nextPhaseAfterVerifyFixes) — NOT raw finalize.
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true },
          },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'verify_fixes ceiling critic test',
        prAuthor: 'author',
        commitSha: sha('ve'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      await queryRows(env, `UPDATE jobs SET continuation_count = 3 WHERE id = $1`, [job.id]);

      // The verify_fixes phase reads vcs.getUnresolvedBotThreads(...) which delegates to
      // GitHubService.getReviewThreads inside an adapter try/catch. The adapter's silent-degradation
      // catch (D-02 in vcs/github.ts:166-170) swallows the error so the phase never reaches
      // continueOrFailWedgedJob. To force a propagating subrequest-budget path, spy on the ADAPTER's
      // getUnresolvedBotThreads directly: the spy replaces the whole method (including the catch),
      // so the rejection surfaces to runReviewJob's catch.
      const { GithubAdapter } = await import('@server/vcs/github');
      const getThreadsSpy = vi.spyOn(GithubAdapter.prototype, 'getUnresolvedBotThreads').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      try {
        await runWithDb(env, async () => {
          const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-verifyfixes-ceiling-critic', phase: 'verify_fixes' });
          expect(result.action).toBe('next_phase');
          if (result.action === 'next_phase') {
            expect(result.phase).toBe('critic');
            expect(result.freshInstance).toBe(true);
            expect(result.delaySeconds).toEqual(expect.any(Number));
            expect(result.jobId).toBe(job.id);
          }
        });

        // Continuation count was reset to 0 by the ceiling branch.
        const updated = await queryRows<{ continuation_count: number }>(env, `SELECT continuation_count FROM jobs WHERE id = $1`, [job.id]);
        expect(updated[0].continuation_count).toBe(0);

        // The job is NOT failed.
        const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 8, commitSha: sha('ve'), trigger: 'auto' });
        expect(finalJob?.status).not.toBe('failed');
      } finally {
        getThreadsSpy.mockRestore();
      }
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('BLOCKER 2 + 3 ceiling: wedged verify_fixes with critic OFF + walkthrough ON routes to walkthrough_enrichment', async () => {
      const repo = `test-repo-${Date.now()}-verifyfixes-ceiling-walk`;

      // verify_fixes + walkthrough ON, critic OFF. The verify_fixes ceiling must route to
      // walkthrough_enrichment, proving the caller uses nextPhaseAfterVerifyFixes (not raw finalize).
      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
        },
      };

      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'verify_fixes ceiling walkthrough test',
        prAuthor: 'author',
        commitSha: sha('vw'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      await queryRows(env, `UPDATE jobs SET continuation_count = 3 WHERE id = $1`, [job.id]);

      const { GithubAdapter } = await import('@server/vcs/github');
      const getThreadsSpy = vi.spyOn(GithubAdapter.prototype, 'getUnresolvedBotThreads').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      try {
        await runWithDb(env, async () => {
          const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-verifyfixes-ceiling-walk', phase: 'verify_fixes' });
          expect(result.action).toBe('next_phase');
          if (result.action === 'next_phase') {
            expect(result.phase).toBe('walkthrough_enrichment');
            expect(result.freshInstance).toBe(true);
          }
        });

        const updated = await queryRows<{ continuation_count: number }>(env, `SELECT continuation_count FROM jobs WHERE id = $1`, [job.id]);
        expect(updated[0].continuation_count).toBe(0);
      } finally {
        getThreadsSpy.mockRestore();
      }
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Loop-prevention invariant: the verify_fixes ceiling handoff uses nextPhaseAfterVerifyFixes,
    // which returns 'critic' when critic is enabled. The chain order is already proven by the
    // healthy-drain tests (BLOCKER 3 chain integration at line 1302). This ceiling test pins
    // that the DEGRADED path preserves the same order — verify_fixes -> critic, not verify_fixes
    // -> walkthrough -> finalize.
    it('BLOCKER 2 + 3 ceiling: wedged verify_fixes preserves the chain order verify_fixes -> critic', async () => {
      const repo = `test-repo-${Date.now()}-verifyfixes-ceiling-order`;

      const config: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          threads: { verify_fixes: true, auto_resolve: false },
          passes: {
            ...defaultRepoConfig.review.passes,
            critic: { enabled: true },
          },
        },
      };

      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber: 8,
        prTitle: 'verify_fixes ceiling chain-order test',
        prAuthor: 'author',
        commitSha: sha('vo'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: config,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      await queryRows(env, `UPDATE jobs SET continuation_count = 3 WHERE id = $1`, [job.id]);

      const { GithubAdapter } = await import('@server/vcs/github');
      const getThreadsSpy = vi.spyOn(GithubAdapter.prototype, 'getUnresolvedBotThreads').mockRejectedValue(
        new Error('Too many subrequests'),
      );

      try {
        await runWithDb(env, async () => {
          const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-verifyfixes-ceiling-order', phase: 'verify_fixes' });
          expect(result.action).toBe('next_phase');
          if (result.action === 'next_phase') {
            // Chain order: verify_fixes -> critic (not walkthrough, not finalize).
            expect(result.phase).toBe('critic');
            expect(result.phase).not.toBe('walkthrough_enrichment');
            expect(result.phase).not.toBe('finalize');
          }
        });
      } finally {
        getThreadsSpy.mockRestore();
      }
    }, REVIEW_FLOW_TIMEOUT_MS);
  });

  it('marks completed jobs with skipped files as partial reviews', async () => {
    const { GitHubService } = await import('@server/services/github');
    const { ModelService } = await import('@server/services/model');
    const repo = `test-repo-${Date.now()}-partial`;
    const headSha = sha('e');
    const baseSha = sha('f');
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([
        { path: 'src/app.ts', content: 'console.log(1);' },
        { path: 'src/failed.ts', content: 'console.log(2);' },
      ]),
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Partial Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    const summarySpy = vi.spyOn(ModelService.prototype as any, 'generateSummary');
    await updateJobFileCount(env, job.id, 2);
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
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });
    await upsertFileReview(env, job.id, {
      filePath: 'src/failed.ts',
      fileStatus: 'failed',
      modelUsed: 'gemma-4-31b-it',
      modelProvider: 'google',
      diffLineCount: 1,
      diffInput: '',
      rawAiOutput: null,
      parsedComments: [],
      inputTokens: null,
      outputTokens: null,
      durationMs: 1,
      verdict: null,
      fileSummary: null,
      errorMessage: 'Review skipped after 3 repeated model provider outages.',
    });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-partial',
        phase: 'finalize',
      });
      expect(result).toEqual({ action: 'ack' });
    });

    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');
    expect(finalJob?.error_msg).toContain('Partial review: 1 of 2 files');
    const steps = typeof finalJob?.steps === 'string' ? JSON.parse(finalJob.steps) : finalJob?.steps;
    expect(steps?.find((step: { name: string }) => step.name === 'Completing')?.status).toBe('done');
    expect(finalJob?.summary_markdown).toMatch(/^### OpenCodra Review/);
    // Best-effort AI narrative is now always attempted at finalize (previously never called --
    // the latent bug this plan fixes).
    expect(finalJob?.summary_model).toBe('sum-model');
    expect(summarySpy).toHaveBeenCalled();
    summarySpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('populates summary_markdown/summary_model/overall_confidence_score/overall_correctness on a successful finalize', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-summary-success`;
    const headSha = sha('1');
    const baseSha = sha('2');
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([
        { path: 'src/app.ts', content: 'console.log(1);' },
        { path: 'src/util.ts', content: 'console.log(2);' },
      ]),
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 8,
      prTitle: 'Summary Success Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 2);
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
      parsedComments: [],
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      overallCorrectness: 'patch is correct',
      confidenceScore: 0.8,
      errorMessage: null,
    });
    await upsertFileReview(env, job.id, {
      filePath: 'src/util.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok too',
      overallCorrectness: 'patch is correct',
      confidenceScore: 0.6,
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-summary-success',
        phase: 'finalize',
      });
      expect(result).toEqual({ action: 'ack' });
    });

    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');
    expect(finalJob?.summary_markdown).toContain('test');
    expect(finalJob?.summary_model).toBe('sum-model');
    expect(finalJob?.overall_confidence_score).toBeCloseTo(0.7, 5);
    expect(finalJob?.overall_correctness).toBe('patch is correct');
    expect(finalJob?.total_input_tokens ?? 0).toBeGreaterThanOrEqual(20 + 3);
    expect(finalJob?.total_output_tokens ?? 0).toBeGreaterThanOrEqual(10 + 2);

    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('falls back to a recap-only overview and never fails the job when generateSummary throws a RetryableModelError', async () => {
    const { GitHubService } = await import('@server/services/github');
    const { ModelService, RetryableModelError } = await import('@server/services/model');
    const repo = `test-repo-${Date.now()}-summary-failure`;
    const headSha = sha('3');
    const baseSha = sha('4');
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );
    const summarySpy = vi.spyOn(ModelService.prototype as any, 'generateSummary').mockRejectedValue(
      new (RetryableModelError as any)('summary provider down'),
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 9,
      prTitle: 'Summary Failure Test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha,
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
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
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      (env.REVIEW_QUEUE as any).sent.length = 0;
      const result = await runReviewJob(env, {
        jobId: job.id,
        deliveryId: 'delivery-summary-failure',
        phase: 'finalize',
      });
      expect(result).toEqual({ action: 'ack' });
    });

    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');
    expect(finalJob?.review_id).not.toBeNull();
    expect(finalJob?.summary_model).toBeNull();
    // Falls back to recap-only: the narrative (which the mock would emit as the word "test") is
    // never inserted, so the heading is immediately followed by the deterministic recap with no
    // narrative text sandwiched in between.
    expect(finalJob?.summary_markdown).toMatch(/^### OpenCodra Review\n\n\*\*No issues found\*\*/);

    summarySpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('reuses an already-posted review instead of double-posting when finalize re-runs past the posting stage', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-doublepost`;
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );
    // A prior finalize attempt already posted this review (id 999) but died before recording it, so
    // the GitHub lookup finds it. Finalize must reuse it, not post a second review.
    const findSpy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue({ id: 999 });
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview');

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 8,
      prTitle: 'Double Post Test',
      prAuthor: 'author',
      commitSha: sha('a1'),
      baseSha: sha('b1'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // A prior finalize attempt reached the posting stage -- this is the marker the guard keys on.
    await updateJobStep(env, job.id, 'Completing', { status: 'running' });
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-doublepost', phase: 'finalize' });
      expect(result).toEqual({ action: 'ack' });
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');
    expect(Number(finalJob?.review_id)).toBe(999);

    findSpy.mockRestore();
    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('does not pay the existing-review lookup on a first-pass finalize', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-firstpass`;
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );
    const findSpy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit');
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview');

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 9,
      prTitle: 'First Pass Test',
      prAuthor: 'author',
      commitSha: sha('c1'),
      baseSha: sha('d1'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // 'Completing' has never been started -> this is a first-pass finalize, no re-post risk.
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [],
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      verdict: 'approve',
      fileSummary: 'ok',
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const result = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-firstpass', phase: 'finalize' });
      expect(result).toEqual({ action: 'ack' });
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const finalJob = await getJobForProcessing(env, job.id);
    expect(finalJob?.status).toBe('done');

    findSpy.mockRestore();
    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  // --- Phase 9 streaming walkthrough (WT-01/WT-02/WT-05, NREG-01/02) ------------------------------
  describe('streaming walkthrough', () => {
    const walkthroughConfig = (): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        walkthrough: { enabled: true, sequence_diagram: { enabled: true } },
      },
    });

    const baseJob = (repo: string, prNumber: number) => ({
      installationId: '123',
      owner: 'test-owner',
      repo,
      prAuthor: 'author',
      baseSha: sha('b'),
      trigger: 'auto' as const,
      headRef: 'feature',
      baseRef: 'main',
      prNumber,
      prTitle: `WT ${prNumber}`,
      commitSha: sha('a'),
    });

    const mainComment = (
      severity: ParsedReviewComment['severity'],
      path = 'src/app.ts',
    ): ParsedReviewComment => ({
      path,
      line: 1,
      position: 1,
      severity,
      category: 'quality',
      title: 'Finding',
      body: 'finding body',
      confidence: 0.95,
    });

    async function seedFinalizeJob(
      repo: string,
      prNumber: number,
      opts: { ref?: string; comments?: ParsedReviewComment[]; config?: RepoConfig } = {},
    ) {
      const job = await insertJob(env, { ...baseJob(repo, prNumber), configSnapshot: opts.config ?? walkthroughConfig() });
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
        parsedComments: opts.comments ?? [],
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        verdict: 'comment',
        fileSummary: 'one-line file summary',
        errorMessage: null,
      });
      if (opts.ref) await updateJobWalkthroughCommentRef(env, job.id, opts.ref);
      return job;
    }

    it('WT-01: posts the placeholder once in prepare and edits it once in finalize (github)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment');
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment');
      const repo = `test-repo-${Date.now()}-wt-happy`;
      const job = await insertJob(env, { ...baseJob(repo, 40), configSnapshot: walkthroughConfig() });

      await runAndDrain({ jobId: job.id, deliveryId: 'delivery-wt-happy', phase: 'prepare' });

      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      expect(createSpy).toHaveBeenCalledTimes(1); // placeholder posted once in prepare
      expect(editSpy).toHaveBeenCalledTimes(1); // single edit in finalize, never re-posted
      expect(finalJob?.walkthrough_comment_ref).toBe('700');

      createSpy.mockRestore();
      editSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-05 idempotent create: a prepare with a ref already set does NOT re-post', async () => {
      const { GitHubService } = await import('@server/services/github');
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment');
      const repo = `test-repo-${Date.now()}-wt-idem`;
      const job = await insertJob(env, { ...baseJob(repo, 44), configSnapshot: walkthroughConfig() });
      // Simulate a prior prepare that already posted the placeholder.
      await updateJobWalkthroughCommentRef(env, job.id, '4242');

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-idem', phase: 'prepare' });
        // prepare enqueues the review phase (next_phase) -- it does not re-post the placeholder.
        expect(res.action).toBe('next_phase');
      });

      expect(createSpy).not.toHaveBeenCalled();
      const row = await getJobForProcessing(env, job.id);
      expect(row?.walkthrough_comment_ref).toBe('4242'); // unchanged

      createSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-05 delete-recovery: a null edit re-posts + updates the ref; the job still completes', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockResolvedValue(null);
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment').mockResolvedValue({ id: 808, user: { id: 1, login: 'bot' } });
      const repo = `test-repo-${Date.now()}-wt-del`;
      const job = await seedFinalizeJob(repo, 41, { ref: '555', comments: [mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-del', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      const finalJob = await getJobForProcessing(env, job.id);
      expect(editSpy).toHaveBeenCalledTimes(1); // attempted the edit -> null
      expect(createSpy).toHaveBeenCalledTimes(1); // re-posted
      expect(finalJob?.status).toBe('done'); // job still completes
      expect(finalJob?.walkthrough_comment_ref).toBe('808'); // ref re-pointed

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      createSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('D-11: a job with zero reviewable files posts NO placeholder and NO edit', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue('');
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment');
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment');
      const repo = `test-repo-${Date.now()}-wt-nofiles`;
      const job = await insertJob(env, { ...baseJob(repo, 45), configSnapshot: walkthroughConfig() });

      await runAndDrain({ jobId: job.id, deliveryId: 'delivery-wt-nofiles', phase: 'prepare' });

      expect(createSpy).not.toHaveBeenCalled(); // D-11: no placeholder
      expect(editSpy).not.toHaveBeenCalled(); // and no defensive finalize create either
      const row = await getJobForProcessing(env, job.id);
      expect(row?.walkthrough_comment_ref).toBeNull();

      getDiffSpy.mockRestore();
      createSpy.mockRestore();
      editSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('D-06: a superseded job skips the walkthrough edit yet the posted review still completes', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment');
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment');
      const repo = `test-repo-${Date.now()}-wt-sup`;
      const job = await seedFinalizeJob(repo, 42, { ref: '321', comments: [mainComment('P2')] });
      // Flip to superseded DURING submitReview (after the pre-submit supersede check, before the
      // walkthrough re-check) so the review posts but the walkthrough edit is skipped.
      const createReviewSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementationOnce(async () => {
        await queryRows(env, `UPDATE jobs SET status = 'superseded' WHERE id = $1`, [job.id]);
        return { id: 456 };
      });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-sup', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      const finalJob = await getJobForProcessing(env, job.id);
      expect(createReviewSpy).toHaveBeenCalledTimes(1); // review posted
      expect(editSpy).not.toHaveBeenCalled(); // walkthrough edit skipped (superseded)
      expect(createSpy).not.toHaveBeenCalled(); // no re-post
      expect(finalJob?.status).toBe('done'); // completeJob still ran; walkthrough did not fail the job
      expect(Number(finalJob?.review_id)).toBe(456);

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      createSpy.mockRestore();
      createReviewSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('ordering: the finalize walkthrough edit runs BEFORE completeJob (job still running)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const jobsMod = await import('@server/db/jobs');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      const repo = `test-repo-${Date.now()}-wt-order`;
      const job = await seedFinalizeJob(repo, 43, { ref: '321', comments: [mainComment('P2')] });
      let statusAtEdit: string | null = null;
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(async () => {
        const row = await getJobForProcessing(env, job.id);
        statusAtEdit = row?.status ?? null;
        return { id: 700 };
      });
      const completeSpy = vi.spyOn(jobsMod, 'completeJob');

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-order', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // The edit observed the job still 'running' -> it ran before completeJob marked it done.
      expect(statusAtEdit).toBe('running');
      expect(editSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(editSpy.mock.invocationCallOrder[0]).toBeLessThan(completeSpy.mock.invocationCallOrder[0]);

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      completeSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('recovery: a transient edit failure is retried within the invocation, then succeeds', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment')
        .mockRejectedValueOnce(new Error('transient blip'))
        .mockResolvedValue({ id: 700 });
      const repo = `test-repo-${Date.now()}-wt-retry`;
      const job = await seedFinalizeJob(repo, 46, { ref: '777', comments: [mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-retry', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(editSpy).toHaveBeenCalledTimes(2); // first throw retried, second succeeds
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      expect(finalJob?.review_id).not.toBeNull();

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('best-effort: a persistently-failing edit never fails the job (review still posted)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockRejectedValue(new Error('provider down'));
      const repo = `test-repo-${Date.now()}-wt-persist`;
      const job = await seedFinalizeJob(repo, 47, { ref: '888', comments: [mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-persist', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(editSpy).toHaveBeenCalledTimes(2); // bounded in-invocation retry (EDIT_MAX_ATTEMPTS)
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done'); // best-effort: the job is not failed
      expect(finalJob?.review_id).not.toBeNull(); // the review is posted

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-02: the finalize edit body carries per-severity counts and a coverage row per file', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      let capturedBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_owner: string, _repo: string, _id: number, body: string) => {
          capturedBody = body;
          return { id: 700 };
        },
      );
      const repo = `test-repo-${Date.now()}-wt-body`;
      const job = await seedFinalizeJob(repo, 48, { ref: '901', comments: [mainComment('P0'), mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-body', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(capturedBody).toContain('OpenCodra Walkthrough');
      expect(capturedBody).toContain('src/app.ts'); // coverage row for the reviewed file
      expect(capturedBody).toMatch(/×2|×1/); // per-severity counts rendered
      expect(capturedBody).toContain('1 file reviewed');

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-03 (github): mermaid fence + diagram fed the REAL diff + exactly one call + tokens folded', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      let capturedBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_owner: string, _repo: string, _id: number, body: string) => {
          capturedBody = body;
          return { id: 700 };
        },
      );
      const diagramSpy = vi.spyOn(ModelService.prototype as any, 'generateWalkthroughDiagram');
      const repo = `test-repo-${Date.now()}-wt03-gh`;
      const job = await seedFinalizeJob(repo, 60, { ref: '910', comments: [mainComment('P1')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt03-gh', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // GitHub (supportsMermaid true) + sequence_diagram on + a valid diagram response -> fenced block.
      expect(capturedBody).toContain('```mermaid');
      expect(capturedBody).toContain('sequenceDiagram');
      // Exactly ONE diagram inference request on the enabled GitHub path (no fallback fan-out).
      expect(diagramSpy).toHaveBeenCalledTimes(1);
      // Fed the ACTUAL parsed diff (FileDiff[] with hunks), not only the {path,summary,verdict} rows.
      const diagramArg = diagramSpy.mock.calls[0][0] as any;
      expect(Array.isArray(diagramArg.files)).toBe(true);
      expect(diagramArg.files.length).toBeGreaterThan(0);
      expect(diagramArg.files[0].path).toBe('src/app.ts');
      expect(diagramArg.files[0]).toHaveProperty('hunks');
      // The diagram call's tokens are folded into the persisted job totals (file + summary + diagram).
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.total_input_tokens).toBe(1 + 3 + 7);
      expect(finalJob?.total_output_tokens).toBe(1 + 2 + 4);

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      diagramSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-03 (github): sub-toggle OFF makes no diagram call and emits no mermaid fence (D-09)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      let capturedBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_o: string, _r: string, _id: number, body: string) => { capturedBody = body; return { id: 700 }; },
      );
      const diagramSpy = vi.spyOn(ModelService.prototype as any, 'generateWalkthroughDiagram');
      const subToggleOff: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          walkthrough: { enabled: true, sequence_diagram: { enabled: false } },
        },
      };
      const repo = `test-repo-${Date.now()}-wt03-off`;
      const job = await seedFinalizeJob(repo, 61, { ref: '911', comments: [mainComment('P2')], config: subToggleOff });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt03-off', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(diagramSpy).not.toHaveBeenCalled(); // sub-toggle off -> the call is skipped entirely
      expect(capturedBody).toContain('OpenCodra Walkthrough'); // walkthrough still posts
      expect(capturedBody).not.toContain('```mermaid'); // but no diagram
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.total_input_tokens).toBe(1 + 3); // no diagram tokens folded

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      diagramSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-03 (bitbucket): supportsMermaid false skips the diagram call and emits no fence (Pitfall #7)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const { VcsService } = await import('@server/services/vcs');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      let capturedBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_o: string, _r: string, _id: number, body: string) => { capturedBody = body; return { id: 700 }; },
      );
      const diagramSpy = vi.spyOn(ModelService.prototype as any, 'generateWalkthroughDiagram');
      // Drive the finalize path against a provider whose capabilities.supportsMermaid is false. Full
      // Bitbucket client fixtures aren't needed to prove the capability gate: reuse the GitHub adapter
      // (so all the mocked service plumbing works) but override name + capabilities to Bitbucket's.
      const forRepoSpy = vi.spyOn(VcsService, 'forRepo').mockImplementation(async (e: any, j: any, t: any) => {
        const { GithubAdapter } = await import('@server/vcs/github');
        const adapter = new GithubAdapter(e, j.installationId ?? '', t);
        Object.defineProperty(adapter, 'name', { value: 'bitbucket', configurable: true });
        Object.defineProperty(adapter, 'capabilities', { value: { supportsMermaid: false }, configurable: true });
        return adapter;
      });
      const repo = `test-repo-${Date.now()}-wt03-bb`;
      const job = await seedFinalizeJob(repo, 62, { ref: '912', comments: [mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt03-bb', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(diagramSpy).not.toHaveBeenCalled(); // capability gate: the diagram call is NOT made
      expect(capturedBody).not.toContain('```mermaid'); // no raw mermaid fence ever reaches Bitbucket
      expect(capturedBody).toContain('OpenCodra Walkthrough'); // the rest of the walkthrough is intact
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      diagramSpy.mockRestore();
      forRepoSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-03/WT-04 (github): a THROWN diagram call omits the diagram; the walkthrough still posts and the job completes', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      let capturedBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_o: string, _r: string, _id: number, body: string) => { capturedBody = body; return { id: 700 }; },
      );
      const diagramSpy = vi.spyOn(ModelService.prototype as any, 'generateWalkthroughDiagram')
        .mockRejectedValue(new Error('diagram model down'));
      const repo = `test-repo-${Date.now()}-wt03-throw`;
      const job = await seedFinalizeJob(repo, 63, { ref: '913', comments: [mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt03-throw', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(diagramSpy).toHaveBeenCalledTimes(1);
      expect(capturedBody).not.toContain('```mermaid'); // best-effort omit
      expect(capturedBody).toContain('OpenCodra Walkthrough');
      expect(editSpy).toHaveBeenCalledTimes(1); // the walkthrough still posts
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done'); // the job completes
      expect(finalJob?.review_id).not.toBeNull();
      expect(finalJob?.total_input_tokens).toBe(1 + 3); // no diagram tokens folded on failure

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      diagramSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-03/WT-04 (github): unparseable diagram output omits the diagram but folds the spent tokens', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'x' }]),
      );
      let capturedBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_o: string, _r: string, _id: number, body: string) => { capturedBody = body; return { id: 700 }; },
      );
      const diagramSpy = vi.spyOn(ModelService.prototype as any, 'generateWalkthroughDiagram')
        .mockResolvedValue({ modelUsed: 'diagram-model', provider: 'google', rawText: 'this is not a diagram', inputTokens: 5, outputTokens: 2 });
      const repo = `test-repo-${Date.now()}-wt03-garbage`;
      const job = await seedFinalizeJob(repo, 64, { ref: '914', comments: [mainComment('P2')] });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt03-garbage', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(capturedBody).not.toContain('```mermaid'); // parseWalkthroughDiagram returned null -> omitted
      expect(capturedBody).toContain('OpenCodra Walkthrough');
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      // The call succeeded (tokens were spent) even though the parse returned null, so they're folded.
      expect(finalJob?.total_input_tokens).toBe(1 + 3 + 5);

      getDiffSpy.mockRestore();
      editSpy.mockRestore();
      diagramSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('NREG-01: with the walkthrough OFF there are zero comment side effects and no ref write', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment');
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment');
      const diagramSpy = vi.spyOn(ModelService.prototype as any, 'generateWalkthroughDiagram');
      const repo = `test-repo-${Date.now()}-wt-off`;
      // defaultRepoConfig has walkthrough.enabled === false.
      const job = await insertJob(env, { ...baseJob(repo, 49), configSnapshot: defaultRepoConfig });

      await runAndDrain({ jobId: job.id, deliveryId: 'delivery-wt-off', phase: 'prepare' });

      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      expect(createSpy).not.toHaveBeenCalled();
      expect(editSpy).not.toHaveBeenCalled();
      expect(diagramSpy).not.toHaveBeenCalled(); // walkthrough off -> no diagram model call either
      expect(finalJob?.walkthrough_comment_ref).toBeNull();

      createSpy.mockRestore();
      editSpy.mockRestore();
      diagramSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('WT-05 handoff: prepare + finalize as SEPARATE runReviewJob calls edit the SAME ref (DB-backed)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      const createSpy = vi.spyOn(GitHubService.prototype, 'createIssueComment').mockResolvedValue({ id: 1234, user: { id: 1, login: 'bot' } });
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockResolvedValue({ id: 1234 });
      const repo = `test-repo-${Date.now()}-wt-handoff`;
      const job = await insertJob(env, { ...baseJob(repo, 51), configSnapshot: walkthroughConfig() });

      // Drive prepare + review to completion (placeholder posts + ref persists in prepare).
      await runWithDb(env, async () => {
        let msg: any = { jobId: job.id, deliveryId: 'delivery-wt-handoff', phase: 'prepare' };
        while (msg && msg.phase !== 'finalize') {
          const res = await runReviewJob(env, msg);
          if (res.action === 'next_phase') {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job.id]);
            if (res.phase === 'finalize') { msg = null; break; }
            msg = { ...msg, phase: res.phase };
          } else {
            msg = null;
          }
        }
      });

      // The placeholder ref is now durable in Postgres.
      const afterPrepare = await getJobForProcessing(env, job.id);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(afterPrepare?.walkthrough_comment_ref).toBe('1234');

      // A FRESH finalize invocation re-reads the job row from the DB and edits the SAME comment.
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-wt-handoff-final', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      expect(createSpy).toHaveBeenCalledTimes(1); // NO second placeholder across the handoff
      expect(editSpy).toHaveBeenCalledTimes(1); // the same comment edited once
      // The GitHub adapter converts the opaque ref '1234' -> numeric commentId before the service
      // call, so the service-level spy sees the number; the durable ref (asserted below) is '1234'.
      expect(editSpy.mock.calls[0][2]).toBe(1234); // edited by the ref read from the DB
      expect(finalJob?.walkthrough_comment_ref).toBe('1234');

      getDiffSpy.mockRestore();
      createSpy.mockRestore();
      editSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    // NREG-02: the placeholder create, single edit, and delete-recovery are asserted directly on the
    // provider-agnostic core/walkthrough helpers for BOTH provider names (opaque ref, D-13). Driving a
    // full Bitbucket runReviewJob would require the Bitbucket client fixtures; the core helpers are the
    // provider seam, so a hand-rolled VcsProvider per name is the precise both-provider proof.
    describe.each(['github', 'bitbucket'] as const)('NREG-02 core helpers (%s)', (providerName) => {
      const makeVcs = (createRef: string, editResult: { ref: string } | null | 'throw' = { ref: createRef }) => {
        const create = vi.fn(async () => ({ ref: createRef }));
        const edit = vi.fn(async (_o: string, _r: string, ref: string) => {
          if (editResult === 'throw') throw new Error('transient');
          return editResult === null ? null : { ref };
        });
        const vcs = {
          name: providerName,
          capabilities: { supportsMermaid: providerName === 'github' },
          createPrComment: create,
          editPrComment: edit,
        } as unknown as VcsProvider;
        return { vcs, create, edit };
      };

      it('posts the placeholder once, persists the ref, and edits in place', async () => {
        const ref = providerName === 'bitbucket' ? '10:20' : '700';
        const { vcs, create, edit } = makeVcs(ref);
        const repo = `test-repo-${Date.now()}-nreg2-${providerName}`;
        const job = await insertJob(env, { ...baseJob(repo, 52), configSnapshot: walkthroughConfig() });
        const formatter = new FormatterService(env.APP_URL);

        await runWithDb(env, async () => {
          await postWalkthroughPlaceholder({ env, job: { ...job, walkthroughCommentRef: null }, config: walkthroughConfig(), fileCount: 2, vcs });
        });
        expect(create).toHaveBeenCalledTimes(1);
        const afterCreate = await getJobForProcessing(env, job.id);
        expect(afterCreate?.walkthrough_comment_ref).toBe(ref);

        // Idempotent: a second placeholder call with the ref set does not re-create.
        await runWithDb(env, async () => {
          await postWalkthroughPlaceholder({ env, job: { ...job, walkthroughCommentRef: ref }, config: walkthroughConfig(), fileCount: 2, vcs });
        });
        expect(create).toHaveBeenCalledTimes(1);

        // Single in-place edit.
        const data = buildWalkthroughData({
          reviews: [{ file_path: 'src/app.ts', file_summary: 'ok', file_status: 'done', error_msg: null, verdict: 'comment', diff_line_count: 3, pass: 'main' }],
          finalComments: [mainComment('P2')],
        });
        await runWithDb(env, async () => {
          await editWalkthroughComment({ env, job: { ...job, walkthroughCommentRef: ref }, config: walkthroughConfig(), vcs, formatter, data, mermaid: null });
        });
        expect(edit).toHaveBeenCalledTimes(1);
        expect(edit.mock.calls[0][2]).toBe(ref);
      });

      it('delete-recovery: a null edit re-posts and re-points the ref', async () => {
        const oldRef = providerName === 'bitbucket' ? '10:20' : '700';
        const newRef = providerName === 'bitbucket' ? '10:99' : '999';
        const { vcs, create, edit } = makeVcs(newRef, null);
        const repo = `test-repo-${Date.now()}-nreg2del-${providerName}`;
        const job = await insertJob(env, { ...baseJob(repo, 53), configSnapshot: walkthroughConfig() });
        await updateJobWalkthroughCommentRef(env, job.id, oldRef);
        const formatter = new FormatterService(env.APP_URL);
        const data = buildWalkthroughData({
          reviews: [{ file_path: 'src/app.ts', file_summary: 'ok', file_status: 'done', error_msg: null, verdict: 'comment', diff_line_count: 3, pass: 'main' }],
          finalComments: [mainComment('P2')],
        });

        await runWithDb(env, async () => {
          await editWalkthroughComment({ env, job: { ...job, walkthroughCommentRef: oldRef }, config: walkthroughConfig(), vcs, formatter, data, mermaid: null });
        });

        expect(edit).toHaveBeenCalledTimes(1); // attempted the edit -> null
        expect(create).toHaveBeenCalledTimes(1); // re-posted
        const row = await getJobForProcessing(env, job.id);
        expect(row?.walkthrough_comment_ref).toBe(newRef);
      });
    });

    // Pure aggregation invariants (WT-04): pass filter, sort order, deterministic fallback.
    describe('buildWalkthroughData (pure)', () => {
      const row = (over: Partial<WalkthroughReviewRow>): WalkthroughReviewRow => ({
        file_path: 'f',
        file_summary: 'summary',
        file_status: 'done',
        error_msg: null,
        verdict: 'comment',
        diff_line_count: 0,
        pass: 'main',
        ...over,
      });

      it('excludes non-main-pass rows (forward-compat with Phase 10 security pass)', () => {
        const data = buildWalkthroughData({
          reviews: [
            row({ file_path: 'main.ts', pass: 'main' }),
            row({ file_path: 'sec.ts', pass: 'security' }),
          ],
          finalComments: [],
        });
        expect(data.filesReviewed).toBe(1);
        expect(data.files.map((f) => f.path)).toEqual(['main.ts']);
      });

      it('sorts by highest severity present then most-changed (diff_line_count ?? 0)', () => {
        const data = buildWalkthroughData({
          reviews: [
            row({ file_path: 'low.ts', diff_line_count: 5 }),
            row({ file_path: 'high.ts', diff_line_count: 1 }),
            row({ file_path: 'big.ts', diff_line_count: 100 }),
          ],
          finalComments: [
            mainComment('nit', 'low.ts'),
            mainComment('P0', 'high.ts'),
            // big.ts has no findings -> sorts last despite the largest diff.
          ],
        });
        expect(data.files.map((f) => f.path)).toEqual(['high.ts', 'low.ts', 'big.ts']);
      });

      it('renders a coverage row with a deterministic summary even when file_summary is empty', () => {
        const data = buildWalkthroughData({
          reviews: [row({ file_path: 'empty.ts', file_summary: '' })],
          finalComments: [],
        });
        expect(data.files).toHaveLength(1);
        expect(data.files[0].path).toBe('empty.ts');
        expect(data.files[0].summary).toBe('');
      });

      it('uses the Review-failed fallback text for a failed row', () => {
        const data = buildWalkthroughData({
          reviews: [row({ file_path: 'boom.ts', file_status: 'failed', error_msg: 'kaboom', file_summary: null })],
          finalComments: [],
        });
        expect(data.files[0].summary).toBe('Review failed: kaboom');
      });
    });
  });

  // --- Phase 10 finalize multi-pass pipeline (MP-02 / MP-04 / NREG-01 / NREG-02) -------------------
  describe('finalize multi-pass pipeline (MP-02 / MP-04 / NREG)', () => {
    const finding = (over: Partial<ParsedReviewComment>): ParsedReviewComment => ({
      path: 'src/app.ts',
      line: 1,
      position: 1,
      severity: 'P1',
      category: 'security',
      title: 'Finding',
      body: 'Finding body',
      confidence: 0.9,
      ...over,
    });

    // security on, critic off
    const securityConfig = (): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        passes: { ...defaultRepoConfig.review.passes, security: { enabled: true, cross_file: false }, critic: { enabled: false } },
      },
    });

    // critic on (security optionally on)
    const criticEnabledConfig = (security: boolean): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        passes: { ...defaultRepoConfig.review.passes, security: { enabled: security, cross_file: false }, critic: { enabled: true } },
      },
    });

    // walkthrough on, diagram off (deterministic body), security optionally on
    const walkthroughSecurityConfig = (security: boolean): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        walkthrough: { enabled: true, sequence_diagram: { enabled: false } },
        passes: { ...defaultRepoConfig.review.passes, security: { enabled: security, cross_file: false }, critic: { enabled: false } },
      },
    });

    async function seedReadyJob(
      repo: string,
      prNumber: number,
      opts: {
        config: RepoConfig;
        mainComments?: ParsedReviewComment[];
        securityComments?: ParsedReviewComment[];
        criticResult?: Parameters<typeof updateJobCriticResult>[2];
        completingStarted?: boolean;
        ref?: string;
        commitChar?: string;
      },
    ) {
      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo,
        prNumber,
        prTitle: 'MP finalize',
        prAuthor: 'author',
        commitSha: sha(opts.commitChar ?? 'a'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
        configSnapshot: opts.config,
      });
      await updateJobFileCount(env, job.id, 1);
      await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      // The (file,'main') row is always present.
      await upsertFileReview(env, job.id, {
        filePath: 'src/app.ts',
        pass: 'main',
        fileStatus: 'done',
        modelUsed: 'test-model',
        modelProvider: 'test-provider',
        diffLineCount: 1,
        diffInput: 'diff',
        rawAiOutput: '{}',
        parsedComments: opts.mainComments ?? [],
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 1,
        verdict: 'comment',
        fileSummary: 'main summary',
        overallCorrectness: 'issues found',
        confidenceScore: 0.9,
        errorMessage: null,
      });
      // The (file,'security') row exists only when the security pass ran.
      if (opts.securityComments) {
        await upsertFileReview(env, job.id, {
          filePath: 'src/app.ts',
          pass: 'security',
          fileStatus: 'done',
          modelUsed: 'test-model',
          modelProvider: 'test-provider',
          diffLineCount: 1,
          diffInput: 'diff',
          rawAiOutput: '{}',
          parsedComments: opts.securityComments,
          inputTokens: 8,
          outputTokens: 4,
          durationMs: 1,
          verdict: 'comment',
          fileSummary: 'security summary',
          overallCorrectness: 'issues found',
          confidenceScore: 0.9,
          errorMessage: null,
        });
      }
      if (opts.criticResult) await updateJobCriticResult(env, job.id, opts.criticResult);
      if (opts.ref) await updateJobWalkthroughCommentRef(env, job.id, opts.ref);
      // Marks a prior finalize attempt that reached the posting stage (finalizeRetriedPastPost).
      if (opts.completingStarted) await updateJobStep(env, job.id, 'Completing', { status: 'running' });
      return job;
    }

    it('MP-02: a finding duplicated across the main and security passes posts exactly once', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-mp02-dedup`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      let captured: any[] = [];
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
      );

      const dupBody = 'User input flows into the SQL query without sanitization.';
      // Phase 14 (always-on FILT-03 dedup): the duplicate shares the main finding's line (composite
      // rule1 collapses same-path/same-line/same-category), while the genuinely-distinct XSS finding
      // sits on a DIFFERENT line so it is not swept up by rule1's no-title-check same-line merge.
      const job = await seedReadyJob(repo, 70, {
        config: securityConfig(),
        mainComments: [finding({ title: 'SQL injection in query', body: dupBody, line: 1, position: 1 })],
        securityComments: [
          finding({ title: 'SQL injection in query', body: dupBody, line: 1, position: 1 }), // duplicate of the main finding
          finding({ title: 'XSS in template render', body: 'Unescaped user data rendered into HTML.', line: 2, position: 2 }), // distinct (different line)
        ],
        commitChar: 'a',
      });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-mp02', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // union = [SQL(main), SQL(security-dup), XSS(security)] = 3; dedup collapses the two SQL findings
      // to one while keeping the distinct XSS finding.
      expect(captured).toHaveLength(2);
      expect(captured.filter((c: any) => c.body.includes('SQL injection in query'))).toHaveLength(1);
      expect(captured.filter((c: any) => c.body.includes('XSS in template render'))).toHaveLength(1);

      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('MP-04: finalize consumes criticResult.kept (not the raw union) and folds critic tokens', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-mp04-consume`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      let captured: any[] = [];
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
      );
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      const kept = finding({ title: 'Kept finding', body: 'This one survives the critic.' });
      const pruned = finding({ title: 'Pruned finding', body: 'This one was dropped by the critic.' });
      // The main row carries BOTH findings; the persisted critic result keeps only one. If finalize
      // re-derived the set from the rows it would post 2 — so posting exactly `kept` proves consumption.
      const job = await seedReadyJob(repo, 71, {
        config: criticEnabledConfig(false),
        mainComments: [kept, pruned],
        criticResult: {
          kept: [kept],
          pruned: [{ finding: pruned, reason: 'duplicate' }],
          model: 'critic-model',
          inputTokens: 11,
          outputTokens: 7,
          skipped: false,
          dedupedCount: 2,
        },
        commitChar: 'a',
      });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-mp04-consume', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // Posts ONLY the critic's kept set; the pruned finding never re-surfaces (D-08).
      expect(captured).toHaveLength(1);
      expect(captured[0].body).toContain('Kept finding');
      expect(captured.some((c: any) => c.body.includes('Pruned finding'))).toBe(false);
      // Finalize NEVER calls the critic model (D-07); it only READS the persisted result.
      expect(critiqueSpy).not.toHaveBeenCalled();

      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      // Critic tokens folded in: file(10) + summary(3) + critic(11) in; file(5) + summary(2) + critic(7) out.
      expect(finalJob?.total_input_tokens).toBe(10 + 3 + 11);
      expect(finalJob?.total_output_tokens).toBe(5 + 2 + 7);

      critiqueSpy.mockRestore();
      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('MP-04: a finalize retry past the posting stage reuses the review and issues ZERO critic calls (non-vacuous)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { ModelService } = await import('@server/services/model');
      const repo = `test-repo-${Date.now()}-mp04-retry`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      // A prior finalize attempt already posted this review (id 999) but died before recording it.
      const findSpy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue({ id: 999 });
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview');
      const critiqueSpy = vi.spyOn(ModelService.prototype as any, 'critiqueFindings');

      const kept = finding({ title: 'Kept finding', body: 'survives' });
      // Seed a RUNNING job (NOT completed) with the 'Completing' step already started and a persisted
      // critic result — so finalize actually EXECUTES its body (a completed job would be acked before
      // phase execution, making the assertion vacuous).
      const job = await seedReadyJob(repo, 72, {
        config: criticEnabledConfig(true),
        mainComments: [kept],
        securityComments: [finding({ title: 'Security finding', body: 'sec' })],
        criticResult: {
          kept: [kept],
          pruned: [],
          model: 'critic-model',
          inputTokens: 11,
          outputTokens: 7,
          skipped: false,
          dedupedCount: 2,
        },
        completingStarted: true,
        commitChar: 'a',
      });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-mp04-retry', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // D-07: finalize never calls the critic model. The existing review is reused, not double-posted.
      expect(critiqueSpy).not.toHaveBeenCalled();
      expect(findSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();
      const finalJob = await getJobForProcessing(env, job.id);
      expect(finalJob?.status).toBe('done');
      expect(Number(finalJob?.review_id)).toBe(999);
      // Critic tokens are still folded on the reuse path: main(10) + security(8) + summary(3) + critic(11).
      expect(finalJob?.total_input_tokens).toBe(10 + 8 + 3 + 11);

      critiqueSpy.mockRestore();
      findSpy.mockRestore();
      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('NREG: toggling passes.security never changes the Phase-9 walkthrough (coverage/counts/ordering)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-wt-invariance`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      const walkBodies: string[] = [];
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_o: any, _r: any, _id: any, body: string) => { walkBodies.push(body); return { id: 700 }; },
      );
      const reviewCommentCounts: number[] = [];
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { reviewCommentCounts.push(input.comments.length); return { id: 456 }; },
      );

      const mainFinding = finding({ title: 'Main finding', body: 'main body', line: 1, position: 1 });

      // Run 1: security OFF, main finding only.
      const jobOff = await seedReadyJob(repo, 73, {
        config: walkthroughSecurityConfig(false),
        mainComments: [mainFinding],
        ref: '801',
        commitChar: 'a',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: jobOff.id, deliveryId: 'delivery-wt-inv-off', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // Run 2: security ON, same main finding + an extra distinct security finding. The security
      // finding sits on a DIFFERENT line so always-on FILT-03 dedup (composite rule1) does not merge it
      // into the main finding — preserving the non-vacuous [1, 2] posted-count invariant.
      const jobOn = await seedReadyJob(`${repo}-2`, 74, {
        config: walkthroughSecurityConfig(true),
        mainComments: [mainFinding],
        securityComments: [finding({ title: 'Security finding', body: 'sec body', line: 2, position: 2 })],
        ref: '802',
        commitChar: 'b',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: jobOn.id, deliveryId: 'delivery-wt-inv-on', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // The walkthrough body is byte-identical whether or not the security pass ran (Pitfall 3, corrected).
      expect(walkBodies).toHaveLength(2);
      expect(walkBodies[0]).toBe(walkBodies[1]);
      // Non-vacuous: the security pass really did add a posted comment, so the invariance is meaningful.
      expect(reviewCommentCounts).toEqual([1, 2]);

      editSpy.mockRestore();
      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('NREG-01: with security AND critic both off, finalize posts the main-only set and folds no critic tokens', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-nreg01-finalize`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      let captured: any[] = [];
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
      );

      // Distinct findings on DISTINCT lines so always-on FILT-03 dedup (composite rule1 = same
      // path/line/category, no title check) does not merge them — this test asserts the main-only set
      // posts both, byte-identical to v1.0 modulo the now-always-on dedup of true same-line duplicates.
      const a = finding({ title: 'Alpha finding', body: 'alpha', line: 1, position: 1 });
      const b = finding({ title: 'Beta finding', body: 'beta', line: 2, position: 2 });
      const job = await seedReadyJob(repo, 75, {
        config: defaultRepoConfig, // security off, critic off, walkthrough off
        mainComments: [a, b],
        commitChar: 'a',
      });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-nreg01-finalize', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // Posted set == the main-only flatMap (no dedup, no critic consumption) — byte-identical to v1.0.
      expect(captured).toHaveLength(2);
      expect(captured.map((c: any) => c.path)).toEqual(['src/app.ts', 'src/app.ts']);
      expect(captured.some((c: any) => c.body.includes('Alpha finding'))).toBe(true);
      expect(captured.some((c: any) => c.body.includes('Beta finding'))).toBe(true);

      const reviews = await getFileReviewsForJobs(env, [job.id]);
      expect(reviews.filter((r) => r.pass === 'security')).toHaveLength(0);
      const finalJob = await getJobForProcessing(env, job.id);
      expect(mapJob(finalJob!).criticResult).toBeNull();
      // No critic tokens folded (critic off -> +0): main(10) + summary(3) in, main(5) + summary(2) out.
      expect(finalJob?.total_input_tokens).toBe(10 + 3);
      expect(finalJob?.total_output_tokens).toBe(5 + 2);

      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('NREG-02: the same deduped candidate set posts the same comments on GitHub and Bitbucket', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { VcsService } = await import('@server/services/vcs');

      const dupBody = 'user input flows into the query';
      // The duplicate shares the main finding's line (collapses under always-on FILT-03 rule1); the
      // distinct authz finding sits on a DIFFERENT line so it survives on BOTH providers identically.
      const seed = {
        mainComments: [finding({ title: 'SQL injection', body: dupBody, line: 1, position: 1 })],
        securityComments: [
          finding({ title: 'SQL injection', body: dupBody, line: 1, position: 1 }), // dup of the main finding -> collapses
          finding({ title: 'Missing authz check', body: 'no permission check on the route', line: 2, position: 2 }), // distinct (different line)
        ],
      };

      const capture = async (repo: string, prNumber: number, commitChar: string, asBitbucket: boolean) => {
        const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
          generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
        );
        let captured: any[] = [];
        const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
          async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
        );
        let forRepoSpy: any = null;
        if (asBitbucket) {
          // Explicit provider mock: reuse the GitHub adapter plumbing but present as Bitbucket, so
          // finalize formats through the Bitbucket branch and posts via the same submitReview seam.
          forRepoSpy = vi.spyOn(VcsService, 'forRepo').mockImplementation(async (e: any, j: any, t: any) => {
            const { GithubAdapter } = await import('@server/vcs/github');
            const adapter = new GithubAdapter(e, j.installationId ?? '', t);
            Object.defineProperty(adapter, 'name', { value: 'bitbucket', configurable: true });
            Object.defineProperty(adapter, 'capabilities', { value: { supportsMermaid: false }, configurable: true });
            return adapter;
          });
        }
        const job = await seedReadyJob(repo, prNumber, { config: securityConfig(), ...seed, commitChar });
        await runWithDb(env, async () => {
          const res = await runReviewJob(env, { jobId: job.id, deliveryId: `delivery-nreg02-${asBitbucket ? 'bb' : 'gh'}`, phase: 'finalize' });
          expect(res).toEqual({ action: 'ack' });
        });
        createSpy.mockRestore();
        getDiffSpy.mockRestore();
        if (forRepoSpy) forRepoSpy.mockRestore();
        return captured;
      };

      const gh = await capture(`test-repo-${Date.now()}-nreg02-gh`, 76, 'a', false);
      const bb = await capture(`test-repo-${Date.now()}-nreg02-bb`, 77, 'b', true);

      // Same candidate set -> same count, paths, and positions on both providers (D-11 / NREG-02).
      expect(gh).toHaveLength(2);
      expect(bb).toHaveLength(2);
      expect(bb.map((c: any) => c.path)).toEqual(gh.map((c: any) => c.path));
      expect(bb.map((c: any) => c.position)).toEqual(gh.map((c: any) => c.position));
      // The same findings surface on both (only the provider-specific severity icon differs).
      for (const title of ['SQL injection', 'Missing authz check']) {
        expect(gh.filter((c: any) => c.body.includes(title))).toHaveLength(1);
        expect(bb.filter((c: any) => c.body.includes(title))).toHaveLength(1);
      }
      // Non-vacuous: bitbucket really went through the provider override (emoji icon, not the GitHub <img>).
      expect(gh.some((c: any) => c.body.includes('<img'))).toBe(true);
      expect(bb.some((c: any) => c.body.includes('<img'))).toBe(false);
    }, REVIEW_FLOW_TIMEOUT_MS);

    // Phase 14 (14-03) finalize-wiring cases A-F. Each seeds a ready job and runs the finalize phase
    // through the reworked applyNoiseFilter wiring in runFinalizePhase.
    const withDedup = (config: RepoConfig, enabled: boolean): RepoConfig => ({
      ...config,
      review: { ...config.review, dedup: { enabled } },
    });
    // security OFF, critic OFF, walkthrough OFF; dedup toggled per-case.
    const mainOnlyConfig = (dedupEnabled: boolean, over: Partial<RepoConfig['review']> = {}): RepoConfig => ({
      ...defaultRepoConfig,
      review: {
        ...defaultRepoConfig.review,
        dedup: { enabled: dedupEnabled },
        passes: { ...defaultRepoConfig.review.passes, security: { enabled: false, cross_file: false }, critic: { enabled: false } },
        ...over,
      },
    });

    it('Case A (FILT-03 always-on main-only): two near-dup main-pass findings post ONCE with dedup default-on', async () => {
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-14-03-A`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      let captured: any[] = [];
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
      );

      // Same path + equal non-null line + same category -> composite rule1 merges regardless of title
      // (titles also overlap, word-Jaccard >= 0.2). Today (pre-v1.2, security-off) these post twice.
      const job = await seedReadyJob(repo, 140, {
        config: mainOnlyConfig(true),
        mainComments: [
          finding({ title: 'SQL injection here', body: 'user input reaches the query', line: 5, position: 5 }),
          finding({ title: 'SQL injection found', body: 'unsanitized input in the query', line: 5, position: 5 }),
        ],
        commitChar: 'a',
      });

      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-14-03-A', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      expect(captured).toHaveLength(1);

      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('Case B (NREG-01 DEDUP revert + always-on cap/sort still applied under dedup.enabled:false)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );

      // B1: two near-dup MAIN findings, dedup.enabled:false, security OFF -> posts TWO (main-only dedup
      // did not run — pre-v1.2 behavior). dedup.enabled:false is a DEDUP-dimension revert (SC3), NOT a
      // whole-finalize pre-v1.2 revert.
      let b1captured: any[] = [];
      const b1create = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { b1captured = input.comments; return { id: 456 }; },
      );
      const b1job = await seedReadyJob(`test-repo-${Date.now()}-14-03-B1`, 141, {
        config: mainOnlyConfig(false),
        mainComments: [
          finding({ title: 'SQL injection here', body: 'user input reaches the query', line: 5, position: 5 }),
          finding({ title: 'SQL injection found', body: 'unsanitized input in the query', line: 5, position: 5 }),
        ],
        commitChar: 'a',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: b1job.id, deliveryId: 'delivery-14-03-B1', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });
      expect(b1captured).toHaveLength(2);
      b1create.mockRestore();

      // B2: security-ON legacy companion — two identical findings across main+security with
      // dedup.enabled:false collapse via the legacy pre-chain dedupeFindings exactly as pre-v1.2.
      let b2captured: any[] = [];
      const b2create = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { b2captured = input.comments; return { id: 456 }; },
      );
      const dupBody = 'user input flows into the SQL query without sanitization.';
      const b2job = await seedReadyJob(`test-repo-${Date.now()}-14-03-B2`, 142, {
        config: withDedup(securityConfig(), false),
        mainComments: [finding({ title: 'SQL injection in query', body: dupBody, line: 5, position: 5 })],
        securityComments: [finding({ title: 'SQL injection in query', body: dupBody, line: 5, position: 5 })],
        commitChar: 'b',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: b2job.id, deliveryId: 'delivery-14-03-B2', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });
      expect(b2captured).toHaveLength(1); // legacy dedupeFindings collapsed the cross-pass duplicate.
      b2create.mockRestore();

      // B3: cap-exceeding + mixed-severity + varied-confidence, dedup.enabled:false. Proves the always-on
      // FILT-01 tiered cap AND the FR-180 confidence-desc sort STILL apply under the flag (review #5), and
      // the footer trimmed-count equals dropped.cap.length only (review #3).
      let b3captured: any[] = [];
      let b3body = '';
      const b3create = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { b3captured = input.comments; b3body = input.body; return { id: 456 }; },
      );
      const p0s = [0, 1, 2].map((i) =>
        finding({ severity: 'P0', category: 'security', confidence: 0.9, title: `P0 crit ${i}`, line: 10 + i, position: 10 + i }),
      );
      const p3s = [
        finding({ severity: 'P3', category: 'bugs', confidence: 0.95, title: 'P3 high', line: 20, position: 20 }),
        finding({ severity: 'P3', category: 'bugs', confidence: 0.9, title: 'P3 mid1', line: 21, position: 21 }),
        finding({ severity: 'P3', category: 'bugs', confidence: 0.88, title: 'P3 mid2', line: 22, position: 22 }),
        finding({ severity: 'P3', category: 'bugs', confidence: 0.75, title: 'P3 low', line: 23, position: 23 }),
      ];
      const nits = [0, 1, 2, 3, 4, 5].map((i) =>
        finding({ severity: 'nit', category: 'quality', confidence: 0.9, title: `nit ${i}`, line: 30 + i, position: 30 + i }),
      );
      const b3job = await seedReadyJob(`test-repo-${Date.now()}-14-03-B3`, 143, {
        config: mainOnlyConfig(false, { max_comments: 3 }), // effectiveMaxComments = min(3, 10) = 3
        mainComments: [...p0s, ...p3s, ...nits],
        commitChar: 'c',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: b3job.id, deliveryId: 'delivery-14-03-B3', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });
      // (a) all 3 P0 post — the tiered cap exempts P0/P1/P2 EVEN under dedup.enabled:false.
      expect(b3captured.filter((c: any) => c.body.includes('P0 crit'))).toHaveLength(3);
      // (b) the highest-confidence P3 is kept and the lowest-confidence P3 is trimmed — the FR-180
      // confidence-desc sort applies under the flag. Capped list = 4 P3 + 6 nit, cap 3 keeps the 3
      // highest-confidence P3 (0.95/0.90/0.88), drops P3-low (0.75) + all nit.
      expect(b3captured.some((c: any) => c.body.includes('P3 high'))).toBe(true);
      expect(b3captured.some((c: any) => c.body.includes('P3 low'))).toBe(false);
      expect(b3captured.some((c: any) => c.body.includes('nit '))).toBe(false);
      expect(b3captured).toHaveLength(6); // 3 P0 (exempt) + 3 P3 (capped kept)
      // (c) footer trimmed-count == dropped.cap.length (7 = 1 P3 + 6 nit), NOT the P0s or floor drops.
      expect(b3body).toContain('7 comments trimmed to 3');
      b3create.mockRestore();

      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('Case C (FILT-04 audit round-trip + per-effective-floor + retry idempotency)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockResolvedValue({ id: 456 } as any);

      // security ON, dedup ON, category_confidence.security 0.85, global min_confidence 0.7,
      // min_severity P3 (drops nit), max_comments 2 (forces a P3 cap drop).
      const cConfig: RepoConfig = {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          min_confidence: 0.7,
          min_severity: 'P3',
          max_comments: 2,
          category_confidence: { security: 0.85 },
          dedup: { enabled: true },
          passes: { ...defaultRepoConfig.review.passes, security: { enabled: true, cross_file: false }, critic: { enabled: false } },
        },
      };
      const secDrop = finding({ category: 'security', severity: 'P1', confidence: 0.8, title: 'Auth bypass sec', line: 10, position: 10, body: 'auth check missing' });
      const mainFindings = [
        finding({ category: 'bugs', severity: 'P1', confidence: 0.65, title: 'Low conf bug', line: 11, position: 11, body: 'possibly a bug' }),
        finding({ category: 'bugs', severity: 'P1', confidence: 0.75, title: 'Null deref bug', line: 12, position: 12, body: 'null pointer' }),
        finding({ category: 'quality', severity: 'nit', confidence: 0.9, title: 'Rename var nit', line: 13, position: 13, body: 'naming' }),
        finding({ category: 'bugs', severity: 'P3', confidence: 0.9, title: 'Magic alpha', line: 14, position: 14, body: 'magic number a' }),
        finding({ category: 'bugs', severity: 'P3', confidence: 0.9, title: 'Magic beta', line: 15, position: 15, body: 'magic number b' }),
        finding({ category: 'bugs', severity: 'P3', confidence: 0.9, title: 'Magic gamma', line: 16, position: 16, body: 'magic number c' }),
        // equal-line + different category + title word-Jaccard >= 0.2 -> composite rule2 (non-null sims).
        finding({ category: 'security', severity: 'P2', confidence: 0.95, title: 'Race condition here', line: 17, position: 17, body: 'data race' }),
        finding({ category: 'bugs', severity: 'P2', confidence: 0.95, title: 'Race condition found', line: 17, position: 17, body: 'data race too' }),
      ];

      const cJob = await seedReadyJob(`test-repo-${Date.now()}-14-03-C`, 144, {
        config: cConfig,
        mainComments: mainFindings,
        securityComments: [secDrop],
        commitChar: 'a',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: cJob.id, deliveryId: 'delivery-14-03-C', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      const detail = await getJobDetail(env, cJob.id);
      const audit: any[] = detail!.audit;
      const filtered: any[] = audit.filter((e: any) => e.stage === 'filtered');
      const deduped: any[] = audit.filter((e: any) => e.stage === 'deduped');
      const confFloor: any[] = filtered.filter((e: any) => e.rule === 'confidence_floor');
      const sevFloor: any[] = filtered.filter((e: any) => e.rule === 'severity_floor');
      const cap: any[] = filtered.filter((e: any) => e.rule === 'cap');

      // Two DISTINCT effective floors -> TWO confidence_floor events (review finding #2): the security
      // drop is audited at 0.85 (the category floor), NOT the 0.7 global floor.
      expect(confFloor).toHaveLength(2);
      const floorThresholds = confFloor.map((e: any) => e.threshold).sort();
      expect(floorThresholds).toEqual([0.7, 0.85]);
      const secFloorEvent = confFloor.find((e: any) => e.threshold === 0.85);
      expect(secFloorEvent.sample.some((s: any) => s.title === '[title-redacted]' && s.category === 'security')).toBe(true);
      const globalFloorEvent = confFloor.find((e: any) => e.threshold === 0.7);
      expect(globalFloorEvent.sample.some((s: any) => s.title === '[title-redacted]')).toBe(true);

      // one severity_floor event (nit below min_severity P3) + one cap event (1 P3 over max_comments 2).
      expect(sevFloor).toHaveLength(1);
      expect(sevFloor[0].threshold).toBe('P3');
      expect(sevFloor[0].sample.some((s: any) => s.title === '[title-redacted]' && s.severity === 'nit')).toBe(true);
      expect(cap).toHaveLength(1);
      expect(cap[0].threshold).toBe(2);
      expect(cap[0].sample.every((s: any) => s.severity === 'P3')).toBe(true);

      // one deduped event (rule2 merge) carrying non-null similarity scores.
      expect(deduped).toHaveLength(1);
      expect(deduped[0].rule).toBe('rule2');
      expect(typeof deduped[0].titleSimilarity).toBe('number');
      expect(deduped[0].survivor).toBeDefined();
      expect(deduped[0].suppressed).toBeDefined();

      // Privacy: no event leaks a raw finding body / diff / code field. Every sample entry admits only
      // { path, line, title } + non-sensitive metric scalars.
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain('auth check missing');
      expect(serialized).not.toContain('null pointer');
      for (const e of filtered) {
        for (const s of e.sample) {
          expect(s).not.toHaveProperty('body');
          expect(s).not.toHaveProperty('existingCode');
          expect(s).not.toHaveProperty('codeSuggestion');
        }
      }

      // Walkthrough path (walkthrough off here) records nothing: the ONLY finalize drop events are the
      // 5 posting-path events (2 confidence + 1 severity + 1 cap + 1 dedup).
      expect(filtered.length + deduped.length).toBe(5);

      // Retry idempotency (review finding #7): a finalize retry PAST the posting stage
      // (completingStarted -> finalizeRetriedPastPost) must NOT re-append drop events.
      const retryJob = await seedReadyJob(`test-repo-${Date.now()}-14-03-C-retry`, 145, {
        config: cConfig,
        mainComments: mainFindings,
        securityComments: [secDrop],
        completingStarted: true,
        commitChar: 'a',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: retryJob.id, deliveryId: 'delivery-14-03-C-retry', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });
      const retryDetail = await getJobDetail(env, retryJob.id);
      const retryDrops = retryDetail!.audit.filter((e: any) => e.stage === 'filtered' || e.stage === 'deduped');
      expect(retryDrops).toHaveLength(0); // gate skipped emission -> at-most-once holds.

      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('Case D (SC5 both-paths-agree on the main-pass subset — same transformation over different sets)', async () => {
      // SC5 = both finalize paths run the SAME applyNoiseFilter over their respective candidate sets;
      // it does NOT mean identical totals (the walkthrough is intentionally main-only, the posted set
      // includes security). We assert agreement on the MAIN-PASS SUBSET: the walkthrough (main-only)
      // keeps exactly the main-pass findings, while the posted union additionally includes the security
      // finding.
      const { GitHubService } = await import('@server/services/github');
      const repo = `test-repo-${Date.now()}-14-03-D`;
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );
      let posted: any[] = [];
      const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { posted = input.comments; return { id: 456 }; },
      );
      let walkBody = '';
      const editSpy = vi.spyOn(GitHubService.prototype, 'updateIssueComment').mockImplementation(
        async (_o: any, _r: any, _id: any, body: string) => { walkBody = body; return { id: 700 }; },
      );

      const job = await seedReadyJob(repo, 146, {
        config: walkthroughSecurityConfig(true), // walkthrough on, security on, dedup default on
        mainComments: [
          finding({ severity: 'P1', title: 'Main P1 finding', body: 'main one', line: 1, position: 1 }),
          finding({ severity: 'P3', title: 'Main P3 finding', body: 'main two', line: 2, position: 2 }),
        ],
        securityComments: [
          finding({ severity: 'P0', title: 'Security P0 finding', body: 'sec crit', line: 3, position: 3 }),
        ],
        ref: '810',
        commitChar: 'a',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-14-03-D', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });

      // Posted union includes the security P0 (total counts include security).
      expect(posted).toHaveLength(3);
      expect(posted.some((c: any) => c.body.includes('Security P0 finding'))).toBe(true);
      // Main-pass subset severities among the posted set: {P1, P3}.
      const mainPosted = posted.filter((c: any) => c.body.includes('Main P'));
      expect(mainPosted).toHaveLength(2);
      // The walkthrough (main-only, SAME filter) severity totals line agrees on the main-pass subset:
      // it shows P1 ×1 and P3 ×1 and does NOT show the security-only P0.
      expect(walkBody).toContain('P1 ×1');
      expect(walkBody).toContain('P3 ×1');
      expect(walkBody).not.toContain('P0 ×');

      editSpy.mockRestore();
      createSpy.mockRestore();
      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('Case E (NREG-02 provider-agnostic filter output + Bitbucket per-comment posting-budget visibility)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const { VcsService } = await import('@server/services/vcs');

      // E1 — filter-output parity: run the SAME finalize fixture under github and a bitbucket-presenting
      // provider and assert the posted inline-comment SET is identical (the pure FR-180 chain is
      // provider-agnostic). E1 uses the renamed-adapter shim only to flip the provider name/formatting;
      // the genuine per-comment posting loop is exercised directly in E2 below (review finding #10a).
      const seed = {
        mainComments: [
          finding({ title: 'SQL injection', body: 'user input flows into the query', line: 5, position: 5 }),
          finding({ title: 'Missing authz check', body: 'no permission check on the route', line: 6, position: 6 }),
        ],
      };
      const capture = async (repo: string, prNumber: number, commitChar: string, asBitbucket: boolean) => {
        const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
          generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
        );
        let captured: any[] = [];
        const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
          async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
        );
        let forRepoSpy: any = null;
        if (asBitbucket) {
          forRepoSpy = vi.spyOn(VcsService, 'forRepo').mockImplementation(async (e: any, j: any, t: any) => {
            const { GithubAdapter } = await import('@server/vcs/github');
            const adapter = new GithubAdapter(e, j.installationId ?? '', t);
            Object.defineProperty(adapter, 'name', { value: 'bitbucket', configurable: true });
            Object.defineProperty(adapter, 'capabilities', { value: { supportsMermaid: false }, configurable: true });
            return adapter;
          });
        }
        const job = await seedReadyJob(repo, prNumber, { config: mainOnlyConfig(true), ...seed, commitChar });
        await runWithDb(env, async () => {
          const res = await runReviewJob(env, { jobId: job.id, deliveryId: `delivery-14-03-E-${asBitbucket ? 'bb' : 'gh'}`, phase: 'finalize' });
          expect(res).toEqual({ action: 'ack' });
        });
        createSpy.mockRestore();
        getDiffSpy.mockRestore();
        if (forRepoSpy) forRepoSpy.mockRestore();
        return captured;
      };
      const gh = await capture(`test-repo-${Date.now()}-14-03-E-gh`, 147, 'a', false);
      const bb = await capture(`test-repo-${Date.now()}-14-03-E-bb`, 148, 'b', true);
      expect(gh).toHaveLength(2);
      expect(bb.map((c: any) => c.path)).toEqual(gh.map((c: any) => c.path));
      for (const title of ['SQL injection', 'Missing authz check']) {
        expect(gh.filter((c: any) => c.body.includes(title))).toHaveLength(1);
        expect(bb.filter((c: any) => c.body.includes(title))).toHaveLength(1);
      }

      // E2 — Bitbucket posting-budget visibility (review finding #6). Construct a REAL BitbucketAdapter
      // against a mocked Bitbucket REST client so its genuine per-comment posting loop
      // (bitbucket.ts:261-281) is exercised — NOT the E1 rename shim. A high-severity-heavy review
      // (>50 P0/P1, all above the floors) posts ONE postPullRequestComment per inline comment, which
      // can exceed the Cloudflare 50-subrequest/invocation budget. The mitigation (chunked/continuation-
      // safe Bitbucket posting) is DEFERRED to the VcsProvider-seam scope (Phase 17/18) — threat
      // T-14-03-04. FILT-01's always-post-P0/P1/P2 is authoritative and NOT weakened here.
      let postCalls = 0;
      const mockClient: any = {
        async listPullRequestComments() { return []; },
        async getPullRequestDiff() {
          return generateMockDiff([{ path: 'src/app.ts', content: 'a\nb\nc' }]);
        },
        async postPullRequestComment() { postCalls += 1; return { id: postCalls }; },
        async approvePullRequest() { /* not called for verdict 'comment' */ },
      };
      const bbJob = {
        id: 'bb-budget-job',
        owner: 'ws',
        repo: 'repo',
        prNumber: 1,
        repositoryWorkspace: 'ws',
      };
      // Private constructor is a compile-time guard only; Reflect.construct builds a genuine instance.
      const adapter = Reflect.construct(BitbucketAdapter as any, [env, mockClient, bbJob]) as BitbucketAdapter;
      const inlineComments = Array.from({ length: 55 }, (_v, i) => ({
        path: 'src/app.ts',
        position: 1, // resolves to the first added diff line; distinct bodies keep them all un-dedup'd.
        body: `high-severity finding ${i}`,
      }));
      const ref = await adapter.submitReview('ws', 'repo', 1, {
        commitSha: sha('a'),
        verdict: 'comment',
        summaryBody: 'summary',
        jobIdHint: bbJob.id,
        comments: inlineComments,
      });
      expect(ref.ref).toBeDefined();
      // One post per inline comment (55) + one summary post = 56 > 50 -> exceeds the Cloudflare
      // per-invocation subrequest budget on Bitbucket (deferred to Phase 17/18, T-14-03-04).
      expect(postCalls).toBe(56);
      expect(postCalls).toBeGreaterThan(50);
    }, REVIEW_FLOW_TIMEOUT_MS);

    it('Case F (FILT-03 critic-branch: critic-kept set gets in-chain composite dedup when enabled)', async () => {
      const { GitHubService } = await import('@server/services/github');
      const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
        generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
      );

      // Two near-duplicate critic-KEPT findings (same path, equal line, same category -> rule1).
      const keptDup = [
        finding({ title: 'SQL injection here', body: 'user input reaches the query', line: 5, position: 5 }),
        finding({ title: 'SQL injection found', body: 'unsanitized input in the query', line: 5, position: 5 }),
      ];
      const criticResult = {
        kept: keptDup,
        pruned: [],
        model: 'critic-model',
        inputTokens: 11,
        outputTokens: 7,
        skipped: false,
        dedupedCount: 2,
      };

      // F1: dedup.enabled default true -> the critic-kept set gets composite dedup IN-CHAIN: posts ONE
      // comment and emits one deduped audit event (review finding #1).
      let f1captured: any[] = [];
      const f1create = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { f1captured = input.comments; return { id: 456 }; },
      );
      const f1job = await seedReadyJob(`test-repo-${Date.now()}-14-03-F1`, 149, {
        config: criticEnabledConfig(false),
        mainComments: keptDup,
        criticResult,
        commitChar: 'a',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: f1job.id, deliveryId: 'delivery-14-03-F1', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });
      expect(f1captured).toHaveLength(1);
      const f1detail = await getJobDetail(env, f1job.id);
      expect(f1detail!.audit.filter((e: any) => e.stage === 'deduped')).toHaveLength(1);
      f1create.mockRestore();

      // F2: dedup.enabled:false -> the critic-kept set is consumed as-is (byte-identical to today's
      // direct criticResult.kept consumption): posts TWO. Known accepted gap: legacy critic-STAGE merges
      // (security+critic, review.ts:2020) are not Phase-14-audited (out of scope, Phase 19).
      let f2captured: any[] = [];
      const f2create = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
        async (_o: any, _r: any, _p: any, input: any) => { f2captured = input.comments; return { id: 456 }; },
      );
      const f2job = await seedReadyJob(`test-repo-${Date.now()}-14-03-F2`, 150, {
        config: withDedup(criticEnabledConfig(false), false),
        mainComments: keptDup,
        criticResult,
        commitChar: 'b',
      });
      await runWithDb(env, async () => {
        const res = await runReviewJob(env, { jobId: f2job.id, deliveryId: 'delivery-14-03-F2', phase: 'finalize' });
        expect(res).toEqual({ action: 'ack' });
      });
      expect(f2captured).toHaveLength(2);
      f2create.mockRestore();

      getDiffSpy.mockRestore();
    }, REVIEW_FLOW_TIMEOUT_MS);
  });
});

/**
 * modelLineCap persistence integration test — verifies the full submit-poll roundtrip
 * persists model_line_cap and that it survives persistCompletedReview despite a change
 * in transient_error_count between submit and poll.
 */
dbDescribe('modelLineCap persistence across submit-poll roundtrip', () => {
  const env = createTestEnv();

  it('uses persisted model_line_cap in poll path even when transient_error_count changes between submit and poll', async () => {
    const { GitHubService } = await import('@server/services/github');
    const { ModelService } = await import('@server/services/model');

    const repo = `mlc-persistence-${Date.now()}`;
    const headSha = sha('m');

    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );

    // Spy on submitReviewBatch to return a defined modelLineCap
    const submitSpy = vi
      .spyOn(ModelService.prototype as any, 'submitReviewBatch')
      .mockResolvedValue({ requestId: 'req-mlc', model: '@cf/moonshotai/kimi-k2.6', modelLineCap: 800 });

    // pollReviewBatch: first call returns pending, second call returns done
    let pollCallCount = 0;
    const pollSpy = vi
      .spyOn(ModelService.prototype as any, 'pollReviewBatch')
      .mockImplementation(async () => {
        pollCallCount += 1;
        if (pollCallCount < 2) return { status: 'pending' as const };
        return {
          status: 'done' as const,
          response: {
            modelUsed: '@cf/moonshotai/kimi-k2.6',
            provider: 'Cloudflare',
            inputTokens: 10,
            outputTokens: 5,
            rawText: '{"findings":[]}',
            userPrompt: '',
            parsed: { comments: [], verdict: 'approve' as const, fileSummary: 'ok', overallCorrectness: 'patch is correct', confidenceScore: 0.9 },
          },
        };
      });

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 1,
      prTitle: 'MLC persistence test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha: sha('n'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });

    // (1) Run the review phase — submits async batch, creates 'pending' file_review row
    await runWithDb(env, async () => {
      const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-mlc-1', phase: 'review' });
      expect(res).toBeDefined();
    });

    // (2) Manually mutate transient_error_count on the pending row to simulate compact-mode activation
    await queryRows(
      env,
      `UPDATE file_reviews SET transient_error_count = 1 WHERE async_request_id = $1`,
      ['req-mlc'],
    );

    // (3) Run the review phase again — polls the async batch, completes via persistCompletedReview
    await runWithDb(env, async () => {
      const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-mlc-2', phase: 'review' });
      expect(res).toBeDefined();
    });

    // (4) Assert model_line_cap survived persistCompletedReview at 800 (NOT null, NOT clobbered)
    await runWithDb(env, async () => {
      const rows = await queryRows<{ model_line_cap: number | null }>(
        env,
        `SELECT model_line_cap FROM file_reviews WHERE async_request_id = $1`,
        ['req-mlc'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].model_line_cap).toBe(800);
    });

    submitSpy.mockRestore();
    pollSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);
});

// --- Phase 26 (EVID-02) evidence hard-drop gate ------------------------------------------------
dbDescribe('evidence hard-drop', () => {
  const env = createTestEnv();

  // Helper to create a ParsedReviewComment with optional existingCode.
  const comment = (over: Partial<ParsedReviewComment>): ParsedReviewComment => ({
    path: 'src/app.ts',
    line: 1,
    position: 1,
    severity: 'P3',
    category: 'quality',
    title: 'Test finding',
    body: 'test body',
    confidence: 0.9,
    ...over,
  });

  it('drops findings with hallucinated existing_code when hard_drop=true', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-evid02-drop`;
    const headSha = sha('d');

    // Diff contains 'console.log(1);' — findings that reference this text should be kept.
    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );

    let captured: any[] = [];
    let createReviewArgs: any[] = [];
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
      async (...args: any[]) => { createReviewArgs = args; captured = args[3]?.comments ?? []; return { id: 456 }; },
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 1,
      prTitle: 'Evidence hard-drop test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          evidence: { hard_drop: true, hard_drop_exempt_categories: [] },
        },
      },
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });

    // Finding A: genuine existingCode matching diff content -> should survive
    // Finding B: hallucinated existingCode not in diff -> should be dropped
    // Finding C: null existingCode -> should be dropped (absent)
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      pass: 'main',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 1,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [
        comment({ title: 'Genuine finding', existingCode: 'console.log(1);' }),
        comment({ title: 'Hallucinated finding', existingCode: 'nonexistent.code.here' }),
        comment({ title: 'Null evidence', existingCode: null }),
      ],
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'summary',
      overallCorrectness: 'issues found',
      confidenceScore: 0.9,
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-evid02-1', phase: 'finalize' });
      expect(res).toEqual({ action: 'ack' });
    });

    // Only the genuine finding should have been posted
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toContain('Genuine finding');
    expect(captured[0].body).not.toContain('Hallucinated finding');
    expect(captured[0].body).not.toContain('Null evidence');

    // Verify audit trail contains evidence_hard_dropped event
    const detail = await getJobDetail(env, job.id);
    const audit: any[] = detail!.audit;
    const hardDropEvents = audit.filter((e: any) => e.stage === 'evidence_hard_dropped');
    expect(hardDropEvents).toHaveLength(1);
    expect(hardDropEvents[0].droppedCount).toBe(2);
    expect(hardDropEvents[0].file).toBe('src/app.ts');

    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('exempt categories bypass hard-drop', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-evid02-exempt`;
    const headSha = sha('e');

    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );

    let captured: any[] = [];
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
      async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 2,
      prTitle: 'Evidence exempt test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: {
        ...defaultRepoConfig,
        review: {
          ...defaultRepoConfig.review,
          // 'security' is the default exempt category; 'quality' is NOT exempt
          evidence: { hard_drop: true, hard_drop_exempt_categories: ['security'] },
        },
      },
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });

    // Finding A: quality category with hallucinated evidence -> dropped (not exempt)
    // Finding B: security category with hallucinated evidence -> kept (exempt)
    // Finding C: security category with genuine evidence -> kept
    // Each finding uses a different line so dedup does not collapse them (rule1 fires on same-path +
    // same-line + same-category, which would suppress the second security finding).
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      pass: 'main',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 3,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [
        comment({ category: 'quality', title: 'Quality bad evidence', existingCode: 'fake.code', line: 1, position: 1 }),
        comment({ category: 'security', title: 'Security bad evidence', existingCode: 'fake.code', line: 2, position: 2 }),
        comment({ category: 'security', title: 'Security good evidence', existingCode: 'console.log(1);', line: 3, position: 3 }),
      ],
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'summary',
      overallCorrectness: 'issues found',
      confidenceScore: 0.9,
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-evid02-2', phase: 'finalize' });
      expect(res).toEqual({ action: 'ack' });
    });

    // Both security findings should survive (exempt + genuine); quality finding dropped
    expect(captured).toHaveLength(2);
    const capturedBodies = captured.map((c: any) => c.body).join(' ');
    expect(capturedBodies).toContain('Security bad evidence');
    expect(capturedBodies).toContain('Security good evidence');
    expect(capturedBodies).not.toContain('Quality bad evidence');

    // Verify audit trail: only 1 dropped (the quality finding)
    const detail = await getJobDetail(env, job.id);
    const audit: any[] = detail!.audit;
    const hardDropEvents = audit.filter((e: any) => e.stage === 'evidence_hard_dropped');
    expect(hardDropEvents).toHaveLength(1);
    expect(hardDropEvents[0].droppedCount).toBe(1);

    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);

  it('byte-identical output when hard_drop=false (NREG-01)', async () => {
    const { GitHubService } = await import('@server/services/github');
    const repo = `test-repo-${Date.now()}-evid02-nreg`;
    const headSha = sha('f');

    const getDiffSpy = vi.spyOn(GitHubService.prototype, 'getPullRequestDiff').mockResolvedValue(
      generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]),
    );

    let captured: any[] = [];
    const createSpy = vi.spyOn(GitHubService.prototype, 'createReview').mockImplementation(
      async (_o: any, _r: any, _p: any, input: any) => { captured = input.comments; return { id: 456 }; },
    );

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 3,
      prTitle: 'Evidence NREG-01 test',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      // Use default config — hard_drop defaults to false, evidence key may not even be present
      configSnapshot: defaultRepoConfig,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });

    // All three findings have bad evidence, but hard_drop is false so ALL should post.
    // Each finding uses a different line so dedup does not collapse them (rule1 fires on same-path +
    // same-line + same-category).
    await upsertFileReview(env, job.id, {
      filePath: 'src/app.ts',
      pass: 'main',
      fileStatus: 'done',
      modelUsed: 'test-model',
      modelProvider: 'test-provider',
      diffLineCount: 3,
      diffInput: 'diff',
      rawAiOutput: '{}',
      parsedComments: [
        comment({ title: 'Finding A', existingCode: 'fake.code', line: 1, position: 1 }),
        comment({ title: 'Finding B', existingCode: 'another.fake', line: 2, position: 2 }),
        comment({ title: 'Finding C', existingCode: null, line: 3, position: 3 }),
      ],
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 1,
      verdict: 'comment',
      fileSummary: 'summary',
      overallCorrectness: 'issues found',
      confidenceScore: 0.9,
      errorMessage: null,
    });

    await runWithDb(env, async () => {
      const res = await runReviewJob(env, { jobId: job.id, deliveryId: 'delivery-evid02-3', phase: 'finalize' });
      expect(res).toEqual({ action: 'ack' });
    });

    // All three findings still post (hard_drop is false)
    expect(captured).toHaveLength(3);
    expect(captured[0].body).toContain('Finding');

    // Verify NO evidence_hard_dropped audit events
    const detail = await getJobDetail(env, job.id);
    const audit: any[] = detail!.audit;
    const hardDropEvents = audit.filter((e: any) => e.stage === 'evidence_hard_dropped');
    expect(hardDropEvents).toHaveLength(0);

    createSpy.mockRestore();
    getDiffSpy.mockRestore();
  }, REVIEW_FLOW_TIMEOUT_MS);
});
