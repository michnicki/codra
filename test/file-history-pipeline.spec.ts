// Phase 34 (PRD-04 / FR-114): prepare/review file-history pipeline integration tests.
//
// Drives the REAL runReviewJob prepare + review phases against a mocked GitHubService and a
// controllable ModelService. Proves the 34-03 Task 2 integration contract:
//   - prepare fetches history ONCE (budget-capped, KV-read-first) and persists the map under
//     `file-history:<jobId>` — EMPTY ARRAYS PRESERVED (D-08: a zero-history file persists as []),
//     so the review phase can render "(no prior history — new file)" end-to-end;
//   - the review phase loads from KV only — `getFileHistory` is NEVER re-issued on chunk/retry
//     invocations (review HIGH-3) and the model receives `fileHistory` per file;
//   - toggle off (NREG-01): zero `getFileHistory` calls, zero KV writes, model receives
//     `fileHistory === undefined` (byte-identical to today);
//   - D-05 budget-cap loop-stop: once `tracker.hasRemainingSafeBudget(1)` is false the prepare
//     fetch loop stops; the remaining files get no history and still review diff-only;
//   - D-06 fetch-failure fail-open: a provider `getFileHistory` rejection logs a warning and the
//     prepare phase CONTINUES to the other files — no terminal failure, no history entry, no
//     audit event for the failure.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runReviewJob } from '@server/core/review';
import { logger } from '@server/core/logger';
import { queryRows } from '@server/db/client';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { findExistingJobForHead, getJobDetail } from '@server/db/jobs';
import { getOrCreateRepository } from '@server/db/repositories';
import { upsertRepoConfig } from '@server/db/repo-configs';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';

const sha = (char: string) => char.repeat(40);
const OWNER = 'test-owner';
const INSTALLATION_ID = '123';
const PR_NUMBER = 1;
const HEAD_SHA = sha('c');

// vi.hoisted so the vi.mock factories below can reference the spies (vitest hoists mock
// factories above the imports). `reviewFileCalls` captures every reviewFile params object so
// tests can assert what the model actually received. `getPullRequestDiff` lets tests swap in a
// multi-file diff for the D-05/D-06 loop tests (default: the single-file diff the rest of the
// file uses). `fileHistoryIncrementPerCall` simulates the real GitHubClient's per-request
// `incrementSubrequests(1)` so the prepare loop's `hasRemainingSafeBudget(1)` guard (D-05) is
// reachable end-to-end.
const mocks = vi.hoisted(() => ({
  getFileHistory: vi.fn(),
  reviewFileCalls: [] as any[],
  getPullRequestDiff: vi.fn(),
  fileHistoryIncrementPerCall: 1,
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    // Concurrency admission in runReviewJob returns 'retry' when the shared test DB has too
    // many running jobs; force the count to 0 so prepare actually runs.
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('@server/services/github', () => {
  return {
    GitHubService: class MockGitHubService {
      // 34-03 (D-05): capture the runReviewJob-built TokenTracker (3rd ctor arg) so the mocked
      // getFileHistory can spend budget the way the real GitHubClient.request does — the prepare
      // loop's `hasRemainingSafeBudget(1)` guard only trips when the tracker actually counts each
      // history fetch as one subrequest.
      private readonly tracker?: { incrementSubrequests(count?: number): void };

      constructor(
        _env: unknown,
        _installationId: string,
        tracker?: { incrementSubrequests(count?: number): void },
      ) {
        this.tracker = tracker;
      }
      async getPullRequest() {
        return {
          title: 'Test PR',
          body: 'Test Body',
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: sha('0'), ref: 'main' },
          user: { login: 'author' },
        };
      }
      async getPullRequestDiff() {
        return mocks.getPullRequestDiff();
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
      async createReview() {
        return { id: 999 };
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
      async getFileHistory(...args: any[]) {
        // Mirror GitHubClient.request's tracker.incrementSubrequests(1) (core/github.ts:378) so
        // the D-05 budget guard sees real per-fetch consumption. A rejection propagates to the
        // prepare loop's catch block (fail-open, D-06).
        this.tracker?.incrementSubrequests(mocks.fileHistoryIncrementPerCall);
        return mocks.getFileHistory(...args);
      }
    },
  };
});

vi.mock('@server/services/model', () => {
  return {
    ModelService: class MockModelService {
      async submitReviewBatch() {
        // Async batch unavailable -> the review phase falls through to the sync reviewFile path.
        return null;
      }
      async reviewFile(params: any) {
        mocks.reviewFileCalls.push(params);
        return {
          modelUsed: 'test-model',
          provider: 'test-provider',
          rawText: '{"findings":[]}',
          userPrompt: 'prompt',
          inputTokens: 1,
          outputTokens: 1,
          parsed: {
            comments: [],
            verdict: 'approve',
            fileSummary: 'ok',
            overallCorrectness: 'ok',
            confidenceScore: 0.9,
            severityAuditEvents: [],
          },
        };
      }
      async generateSummary() {
        return { modelUsed: 'm', provider: 'p', rawText: '{"summary":"s"}', inputTokens: 1, outputTokens: 1 };
      }
    },
    isRetryableModelError: () => false,
    getRetryableModelFailureDelaySeconds: () => 30,
  };
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('Phase 34 (34-03): prepare/review file-history pipeline', () => {
  const env = createTestEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getFileHistory.mockReset();
    mocks.reviewFileCalls.length = 0;
    // Default diff: the single reviewable file used by the base tests. The D-05/D-06 loop tests
    // override this with a multi-file diff.
    mocks.getPullRequestDiff.mockReset();
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff([{ path: 'src/x.ts', content: 'x' }]));
    mocks.fileHistoryIncrementPerCall = 1;
  });

  async function seedRepoWithFileHistoryToggle(repo: string, enabled: boolean) {
    await getOrCreateRepository(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      vcsProvider: 'github',
    });
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.file_history = { enabled };
    await upsertRepoConfig(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      parsedJson,
    });
  }

  async function runPrepare(repo: string) {
    return runReviewJob(env, {
      deliveryId: `delivery-fh-${Date.now()}`,
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: INSTALLATION_ID },
        repository: { owner: { login: OWNER }, name: repo },
        pull_request: {
          number: PR_NUMBER,
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: sha('0'), ref: 'main' },
          title: 'Test PR',
          user: { login: 'author' },
          draft: false,
        },
      },
    } as any);
  }

  async function runReview(repo: string) {
    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    return { job, result: await runReviewJob(env, { jobId: job!.id, phase: 'review' } as any) };
  }

  // Drives the review phase across however many chunks the shared DB's concurrency level needs
  // (the multi-file tests cannot assume one chunk covers every file). Mirrors the durable
  // orchestrator: keep re-entering phase 'review' until it advances to finalize. A chunk that
  // yields re-enqueues with FRESH_INVOCATION_YIELD_SECONDS (60), stamping last_queue_message_at
  // 60s in the future; claimJobLease treats that as a fresh lease and returns 'busy', so the
  // in-process driver backdates it between invocations (the established pattern across
  // review-flow.spec.ts / async-batch-review.spec.ts — the real queue delivers after the delay).
  async function runReviewUntilFinalize(repo: string) {
    let result: { action: string; phase?: string };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const job = await findExistingJobForHead(env, {
        owner: OWNER,
        repo,
        prNumber: PR_NUMBER,
        commitSha: HEAD_SHA,
        trigger: 'auto',
      });
      result = await runReviewJob(env, { jobId: job!.id, phase: 'review' } as any);
      if (result.action !== 'next_phase' || result.phase !== 'review') return result;
      await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [job!.id]);
    }
    throw new Error('review phase did not reach finalize within 12 chunk invocations');
  }

  it('toggle ON: prepare fetches history per reviewable file and persists the map to KV ([] preserved for new files)', async () => {
    const repo = `repo-fh-on-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    // Zero-history file: the provider returns [] and the prepare phase MUST keep it in the map
    // (D-08 — a dropped [] would silently downgrade new files to no-appendix).
    mocks.getFileHistory.mockResolvedValue([]);

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    // Exactly one fetch, for the single reviewable file, with the PR head SHA as the ref (review HIGH-1).
    expect(mocks.getFileHistory).toHaveBeenCalledTimes(1);
    expect(mocks.getFileHistory).toHaveBeenCalledWith(OWNER, repo, 'src/x.ts', HEAD_SHA, 5);

    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    const raw = await env.APP_KV.get(`file-history:${job!.id}`, 'text');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    // [] IS preserved at the KV boundary — the D-08 new-file block is reachable end-to-end.
    expect(persisted).toEqual({ 'src/x.ts': [] });
  });

  it('toggle ON: review phase loads from KV only — getFileHistory is never re-issued and the model receives fileHistory', async () => {
    const repo = `repo-fh-review-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    mocks.getFileHistory.mockResolvedValue([]);

    await runPrepare(repo);
    const fetchCountAfterPrepare = mocks.getFileHistory.mock.calls.length;
    expect(fetchCountAfterPrepare).toBe(1);

    const { result } = await runReview(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    // review HIGH-3: the review phase never re-fetches over REST.
    expect(mocks.getFileHistory).toHaveBeenCalledTimes(1);
    // The model received the persisted [] for the file (D-08 — the builder renders the new-file block).
    expect(mocks.reviewFileCalls.length).toBeGreaterThan(0);
    expect(mocks.reviewFileCalls[0].fileHistory).toEqual([]);
  });

  it('toggle OFF (NREG-01): zero getFileHistory calls, zero KV writes, model receives no fileHistory', async () => {
    const repo = `repo-fh-off-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, false);

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.getFileHistory).not.toHaveBeenCalled();

    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    expect(await env.APP_KV.get(`file-history:${job!.id}`, 'text')).toBeNull();

    const { result } = await runReview(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });
    expect(mocks.getFileHistory).not.toHaveBeenCalled();
    expect(mocks.reviewFileCalls.length).toBeGreaterThan(0);
    expect(mocks.reviewFileCalls[0].fileHistory).toBeUndefined();
  });

  // WR-05 (34-REVIEW): the previous NREG-01 test asserted only that the KV VALUE was null when the
  // toggle is off — it never asserted that no READ occurred, so the ungated review-phase
  // `APP_KV.get` (one per chunk / fresh-instance handoff / retry, always a guaranteed miss) went
  // unnoticed. This asserts the absence of the read itself.
  it('WR-05 (NREG-01): toggle OFF issues ZERO file-history KV reads in either phase', async () => {
    const repo = `repo-fh-kvoff-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, false);
    const kvGetSpy = vi.spyOn(env.APP_KV, 'get');

    await runPrepare(repo);
    const { result } = await runReview(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    const historyReads = kvGetSpy.mock.calls.filter(([key]) => String(key).startsWith('file-history:'));
    expect(historyReads).toEqual([]);
    kvGetSpy.mockRestore();
  });

  // WR-09 (34-REVIEW): the KV round-trip used to be an unchecked `JSON.parse(raw) as
  // Record<string, VcsCommitEntry[]>`. A map persisted by an earlier deploy (entries live for the
  // 1-hour TTL) whose shape drifted surfaced as a TypeError inside buildFileHistoryBlock during
  // prompt construction. It is now validated and drops non-conforming entries fail-open.
  it('WR-09: drifted entries in the persisted KV map are dropped fail-open, not thrown on', async () => {
    const repo = `repo-fh-drift-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    mocks.getFileHistory.mockResolvedValue([]);

    await runPrepare(repo);
    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    // Simulate a cross-deploy drift: one valid entry, one missing `files`, one outright garbage.
    await env.APP_KV.put(
      `file-history:${job!.id}`,
      JSON.stringify({
        'src/x.ts': [
          { hash: 'abc1234', message: 'fix: real', files: ['src/other.ts'], filesAvailable: true },
          { hash: 'def4567', message: 'drifted — no files field' },
          'not-an-entry',
        ],
      }),
    );

    const { result } = await runReview(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });
    expect(mocks.reviewFileCalls.length).toBeGreaterThan(0);
    // Only the conforming entry survived; the review completed normally.
    expect(mocks.reviewFileCalls[0].fileHistory).toEqual([
      { hash: 'abc1234', message: 'fix: real', files: ['src/other.ts'], filesAvailable: true },
    ]);
  });

  // The positive control for the assertion above: with the toggle ON the review phase DOES read
  // the map from KV (and only from KV — review HIGH-3 forbids re-fetching over REST).
  it('WR-05: toggle ON still issues the file-history KV read in the review phase', async () => {
    const repo = `repo-fh-kvon-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    mocks.getFileHistory.mockResolvedValue([]);

    await runPrepare(repo);
    const kvGetSpy = vi.spyOn(env.APP_KV, 'get');
    const { result } = await runReview(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    const historyReads = kvGetSpy.mock.calls.filter(([key]) => String(key).startsWith('file-history:'));
    expect(historyReads.length).toBeGreaterThan(0);
    kvGetSpy.mockRestore();
  });

  it('D-05 / WR-04: the prepare fetch loop stops while FILE_HISTORY_BUDGET_RESERVE safe budget remains — remaining files get no history and still review diff-only', async () => {
    const repo = `repo-fh-budget-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    // 4 reviewable files so the loop has work left AFTER the budget boundary trips.
    const diffFiles = [
      { path: 'src/a.ts', content: 'a' },
      { path: 'src/b.ts', content: 'b' },
      { path: 'src/c.ts', content: 'c' },
      { path: 'src/d.ts', content: 'd' },
    ];
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff(diffFiles));
    // Each history fetch spends 12 subrequests (the real client spends 1; 12 makes the boundary
    // deterministic). Safe budget starts at 25 = MAX 50 - SAFE_MARGIN 25.
    //
    // WR-04 (34-REVIEW): the guard is now `hasRemainingSafeBudget(FILE_HISTORY_BUDGET_RESERVE)`
    // (reserve 8), not `(1)`. So: call 1 (25 >= 8) spends 12 -> 13 left; call 2 (13 >= 8) spends
    // 12 -> 1 left; the third file trips the guard (1 < 8). The loop now STOPS WITH BUDGET LEFT
    // for the rest of prepare — postWalkthroughPlaceholder, the check-run update and
    // enqueueJobPhase — instead of consuming the entire SAFE_MARGIN that exists for the untracked
    // Hyperdrive traffic the tracker cannot see. Under the old `(1)` guard this test allowed 3
    // fetches and left the invocation with nothing.
    mocks.fileHistoryIncrementPerCall = 12;
    mocks.getFileHistory.mockResolvedValue([]);

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    // Exactly the 2 budget-allowable files were fetched; the loop broke before src/c.ts.
    expect(mocks.getFileHistory).toHaveBeenCalledTimes(2);
    expect(mocks.getFileHistory.mock.calls.map((call) => call[2])).toEqual(['src/a.ts', 'src/b.ts']);

    // The skipped files are absent from the persisted map — D-05: remaining files get no history.
    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    const persisted = JSON.parse((await env.APP_KV.get(`file-history:${job!.id}`, 'text'))!);
    expect(persisted).toEqual({ 'src/a.ts': [], 'src/b.ts': [] });

    // The job still proceeds: the review phase completes every file, the budget-skipped ones
    // diff-only (fileHistory undefined = no appendix), the fetched ones with history ([]).
    const result = await runReviewUntilFinalize(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });
    expect(mocks.getFileHistory).toHaveBeenCalledTimes(2); // review HIGH-3: no re-fetch
    const callsByPath = new Map(
      mocks.reviewFileCalls.map((params: any) => [params.file.path, params.fileHistory] as const),
    );
    expect(callsByPath.get('src/a.ts')).toEqual([]);
    expect(callsByPath.get('src/b.ts')).toEqual([]);
    expect(callsByPath.get('src/c.ts')).toBeUndefined();
    expect(callsByPath.get('src/d.ts')).toBeUndefined();
  });

  // WR-04 (34-REVIEW): the absolute per-invocation ceiling, independent of the tracker. With the
  // REAL per-fetch cost (1 subrequest) the reserve alone would permit ~17 fetches; this cap is the
  // bound that holds if the per-request cost is ever mis-estimated.
  it('WR-04: at most MAX_FILE_HISTORY_FETCHES_PER_PREPARE (10) fetches happen in one prepare invocation', async () => {
    const repo = `repo-fh-cap-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    const diffFiles = Array.from({ length: 14 }, (_, i) => ({ path: `src/f${i}.ts`, content: `f${i}` }));
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff(diffFiles));
    mocks.fileHistoryIncrementPerCall = 1; // the REAL client cost — the budget guard never trips here
    mocks.getFileHistory.mockResolvedValue([]);

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    expect(mocks.getFileHistory).toHaveBeenCalledTimes(10);
    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    const persisted = JSON.parse((await env.APP_KV.get(`file-history:${job!.id}`, 'text'))!);
    expect(Object.keys(persisted)).toHaveLength(10);
  });

  it('D-06: a provider getFileHistory rejection logs a warning, skips that file only, and the review proceeds diff-only with no audit event', async () => {
    const repo = `repo-fh-failopen-${Date.now()}`;
    await seedRepoWithFileHistoryToggle(repo, true);
    const diffFiles = [
      { path: 'src/a.ts', content: 'a' },
      { path: 'src/b.ts', content: 'b' },
    ];
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff(diffFiles));
    // The GitHub/Bitbucket client rejects for the first file (404-style) but succeeds for the rest.
    mocks.getFileHistory.mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path === 'src/a.ts') throw Object.assign(new Error('Not Found'), { status: 404 });
      return [];
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    // Fail-open: the failure is logged as a warning and the loop CONTINUED to the other file.
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes('Failed to fetch history for src/a.ts'))).toBe(true);
    expect(mocks.getFileHistory).toHaveBeenCalledTimes(2);
    expect(mocks.getFileHistory.mock.calls.map((call) => call[2])).toEqual(['src/a.ts', 'src/b.ts']);

    // No history entry for the failed file; the healthy file persisted its [].
    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    const persisted = JSON.parse((await env.APP_KV.get(`file-history:${job!.id}`, 'text'))!);
    expect(persisted).toEqual({ 'src/b.ts': [] });

    // No audit event for the failure (the catch block only warns; no file-history audit stage exists).
    const detail = await getJobDetail(env, job!.id);
    const stages = ((detail?.audit as Array<{ stage: string }>) ?? []).map((event) => event.stage);
    expect(stages.some((stage) => stage.includes('history'))).toBe(false);

    // The job is NOT terminal-failed: the review phase completes all files — the failed file
    // diff-only (fileHistory undefined), the healthy one with its persisted [].
    const result = await runReviewUntilFinalize(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });
    const callsByPath = new Map(
      mocks.reviewFileCalls.map((params: any) => [params.file.path, params.fileHistory] as const),
    );
    expect(callsByPath.get('src/a.ts')).toBeUndefined();
    expect(callsByPath.get('src/b.ts')).toEqual([]);
  });
});
