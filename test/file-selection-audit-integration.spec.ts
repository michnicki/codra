import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi, expect, describe, it, beforeAll } from 'vitest';
import { findExistingJobForHead, getJobDetail, insertJob } from '@server/db/jobs';
import { runWithDb, queryRows } from '@server/db/client';
import { parseUnifiedDiff, selectReviewableFiles } from '@server/core/diff';
import { defaultRepoConfig, type JobAuditEvent, type RepoConfig } from '@shared/schema';

// -------------------------------------------------------------------------------------------------
// PRIO-03 SC3 CAPSTONE: end-to-end proof that the prepare phase persists file_skipped audit events
// that reach getJobDetail(...).audit.
//
// This drives a full job through core/review.ts starting at the PREPARE phase (NOT pre-marking
// Preparation done — the file_skipped events are emitted there) and reads the trail back via the
// DETAIL contract (getJobDetail(...).audit):
//   core/review.ts runPreparePhase -> buildFileSkipEvents(selectReviewableFiles(...).dropped)
//   -> core/audit.ts recordFileSkips -> db/jobs.ts appendJobAuditEvents -> jsonb ring buffer
//   -> db/jobs.ts getJobDetail fail-soft read.
//
// The diff carries (i) one generated file (first hunk starts with a `DO NOT EDIT` marker) and
// (ii) more reviewable files than a low `max_files` cap, so BOTH drop classes this phase owns fire:
// a per-file `generated` event and one bounded aggregate `over_cap` event. The disabled case proves
// the emission gate (file_selection.enabled) suppresses events even though the selector still
// preserves dropped.overCap for review-rest (Codex 15-03 HIGH — suppress emission, not data).
// -------------------------------------------------------------------------------------------------

const sha = (char: string) => char.repeat(40);

// One generated file (marker in the first hunk) + six normal reviewable files. With max_files=2 the
// enabled selector keeps 2, drops the generated file into dropped.generated, and puts the remaining
// four normal files into dropped.overCap.
const GENERATED_PATH = 'src/generated-client.ts';
const NORMAL_PATHS = ['src/aaa.ts', 'src/bbb.ts', 'src/ccc.ts', 'src/ddd.ts', 'src/eee.ts', 'src/fff.ts'];
const MOCK_DIFF = generateMockDiff([
  { path: GENERATED_PATH, content: '// DO NOT EDIT — this file is generated\nexport const client = 1;' },
  ...NORMAL_PATHS.map((path) => ({ path, content: `export const value = '${path}';\nconsole.log(value);` })),
]);

const MAX_FILES = 2;

const fileSelectionConfig = (enabled: boolean): RepoConfig => ({
  ...defaultRepoConfig,
  review: {
    ...defaultRepoConfig.review,
    max_files: MAX_FILES,
    file_selection: { enabled },
  },
});

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

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
      return MOCK_DIFF;
    }
    async createCheckRun() {
      return { id: 123 };
    }
    async updateCheckRun() {
      return {};
    }
    async createReview() {
      return { id: 456 };
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
    async removeIssueLabel() {
      return {};
    }
  }
  return { GitHubService: MockGitHubService };
});

vi.mock('@server/services/model', () => {
  class MockModelService {
    async submitReviewBatch() {
      return null;
    }
    async pollReviewBatch() {
      return { status: 'pending' as const };
    }
    async reviewFile() {
      // Trivial approve — this test cares about prepare-phase file_skipped events, not findings.
      return {
        parsed: {
          comments: [],
          verdict: 'approve' as const,
          fileSummary: 'ok',
          overallCorrectness: 'looks good',
          confidenceScore: 0.9,
        },
        modelUsed: 'test-model',
        provider: 'test-provider',
        inputTokens: 1,
        outputTokens: 1,
        rawText: '{}',
        userPrompt: '',
      };
    }
    async generateSummary() {
      return { modelUsed: 'sum-model', provider: 'google', rawText: '{"summary": "test"}', inputTokens: 3, outputTokens: 2 };
    }
    async generateWalkthroughDiagram() {
      return { modelUsed: 'diagram-model', provider: 'google', rawText: 'sequenceDiagram\n  participant A\n  A->>B: call()', inputTokens: 7, outputTokens: 4 };
    }
    async critiqueFindings() {
      return { rawText: '{"prune": []}', modelUsed: 'critic-model', inputTokens: 5, outputTokens: 2 };
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
const TIMEOUT_MS = 60_000;

const isFileSkipped = (e: JobAuditEvent): e is Extract<JobAuditEvent, { stage: 'file_skipped' }> => e.stage === 'file_skipped';

dbDescribe('file_skipped audit events reach getJobDetail().audit through a REAL prepare run (SC3)', () => {
  const env = createTestEnv();

  beforeAll(async () => {
    // The shared test DB accumulates terminal jobs; the check-run reconciliation queries in the review
    // flow have a LIMIT 500, so purge before this DB-backed spec to avoid the documented flake.
    await runWithDb(env, async () => {
      await queryRows(env, 'TRUNCATE jobs CASCADE');
    });
  });

  // Drives runReviewJob through its phase transitions from PREPARE (mirrors review-flow.spec.ts).
  async function runAndDrain(message: Parameters<typeof runReviewJob>[1]) {
    await runWithDb(env, async () => {
      let currentMessage: typeof message | null = message;
      let retries = 0;
      const MAX_RETRIES = 6;
      while (currentMessage) {
        const result = await runReviewJob(env, currentMessage);
        if (result.action === 'next_phase') {
          currentMessage = { ...currentMessage, phase: result.phase } as typeof message;
          retries = 0;
          const jobId = (currentMessage as any).jobId;
          if (jobId) {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
          }
        } else if (result.action === 'retry') {
          if (++retries > MAX_RETRIES) throw new Error('Max retries exceeded');
          break;
        } else {
          currentMessage = null;
        }
      }
    });
  }

  // Insert a job WITHOUT marking Preparation done, so runReviewJob runs the prepare phase (which emits
  // the file_skipped events) before review -> finalize. Config is threaded via the injected snapshot,
  // which runPreparePhase reads directly (review.ts:777).
  async function insertPrepareJob(repo: string, config: RepoConfig, commitChar: string) {
    return insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'File-selection audit integration',
      prAuthor: 'author',
      commitSha: sha(commitChar),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });
  }

  it('ENABLED: emits one per-file generated event + one over_cap aggregate (complete count, ≤20 priority-ordered sample)', async () => {
    const repo = `fsel-audit-${Date.now()}-on`;
    const config = fileSelectionConfig(true);
    const job = await insertPrepareJob(repo, config, 'a');

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-fsel-on', phase: 'prepare' } as any);

    // Authoritative expected drop metadata: run the SAME selector on the SAME parsed diff + config.
    const { dropped } = selectReviewableFiles(parseUnifiedDiff(MOCK_DIFF, config.review), config.review);
    expect(dropped.generated.map((f) => f.path)).toContain(GENERATED_PATH);
    expect(dropped.overCap.length).toBeGreaterThan(0);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('a'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      const detail = await getJobDetail(env, finalJob!.id);
      expect(detail).not.toBeNull();
      const skips = detail!.audit.filter(isFileSkipped);

      const generated = skips.filter((e) => (e as { reason: string }).reason === 'generated');
      // Exactly one per-file generated event per generated file, naming the generated path.
      expect(generated).toHaveLength(dropped.generated.length);
      expect(generated.every((e) => (e as { count: number }).count === 1)).toBe(true);
      expect(generated.map((e) => (e as { sample: { path: string }[] }).sample[0].path)).toEqual(
        dropped.generated.map((f) => f.path),
      );

      const overCap = skips.filter((e) => (e as { reason: string }).reason === 'over_cap');
      // Exactly ONE aggregate; count === the FULL omitted count; sample bounded ≤20 in the selector's
      // descending-priority order (highest-priority OMITTED named first).
      expect(overCap).toHaveLength(1);
      const agg = overCap[0] as { count: number; sample: { path: string }[] };
      expect(agg.count).toBe(dropped.overCap.length);
      expect(agg.sample.length).toBeLessThanOrEqual(20);
      expect(agg.sample.map((s) => s.path)).toEqual(dropped.overCap.slice(0, 20).map((f) => f.path));

      // PRIVACY: every file_skipped sample entry carries ONLY { path }.
      for (const event of skips) {
        for (const entry of (event as { sample: Record<string, unknown>[] }).sample) {
          expect(Object.keys(entry)).toEqual(['path']);
        }
      }
    });
  }, TIMEOUT_MS);

  it('DISABLED: ZERO file_skipped events even though the selector still preserves dropped.overCap (revert proof)', async () => {
    const repo = `fsel-audit-${Date.now()}-off`;
    const config = fileSelectionConfig(false);
    const job = await insertPrepareJob(repo, config, 'b');

    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-fsel-off', phase: 'prepare' } as any);

    // The disabled selector still preserves the legacy overCap remainder (data NOT erased) ...
    const { dropped } = selectReviewableFiles(parseUnifiedDiff(MOCK_DIFF, config.review), config.review);
    expect(dropped.overCap.length).toBeGreaterThan(0);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('b'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      // ... yet the emission gate (file_selection.enabled=false) suppresses ALL file_skipped events.
      const detail = await getJobDetail(env, finalJob!.id);
      expect(detail!.audit.filter(isFileSkipped)).toHaveLength(0);
    });
  }, TIMEOUT_MS);
});
