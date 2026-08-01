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
//     `fileHistory === undefined` (byte-identical to today).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { findExistingJobForHead } from '@server/db/jobs';
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
// tests can assert what the model actually received.
const mocks = vi.hoisted(() => ({
  getFileHistory: vi.fn(),
  reviewFileCalls: [] as any[],
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
});
