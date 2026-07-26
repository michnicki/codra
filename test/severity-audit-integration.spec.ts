import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi, expect, describe, it } from 'vitest';
import {
  appendJobAuditEvents,
  findExistingJobForHead,
  getJobDetail,
  insertJob,
  updateJobFileCount,
  updateJobStep,
} from '@server/db/jobs';
import { runWithDb, queryRows } from '@server/db/client';
import { parseFileReviewResponse } from '@server/core/model-output';
import { defaultRepoConfig, type JobAuditEvent, type RepoConfig } from '@shared/schema';

// -------------------------------------------------------------------------------------------------
// Phase 13 Plan 04 CAPSTONE: end-to-end proof that a completed review persists a REAL audit trail.
//
// These cases drive a full job through core/review.ts and read the audit trail back via the DETAIL
// contract (getJobDetail(...).audit) -- i.e. the FULL write-then-read round trip:
//   core/review.ts (persist site) -> core/audit.ts recordUnitAudit -> db/jobs.ts appendJobAuditEvents
//   -> Postgres jsonb ring buffer -> db/jobs.ts getJobDetail fail-soft read.
//
// Crucially, the severity + severity_adjusted events are produced by the REAL parseFileReviewResponse
// severity engine on a raw model-JSON fixture -- NOT hand-fabricated by the mock (review fix, Codex
// MEDIUM). The mock only supplies the raw JSON string; the engine decides severity/category/events.
// This keeps the "audit propagation" concern and the "engine correctness" concern distinct while
// still proving they compose in a real run.
// -------------------------------------------------------------------------------------------------

const sha = (char: string) => char.repeat(40);

// A raw model-JSON fixture whose single finding trips SEV-01 (SQL injection exploit keyword). The
// REAL engine promotes priority 2 (P2) -> P0 with a `keyword_promotion` audit event. Line 1 is the
// only added line in the generateMockDiff below, so the finding survives the orphan check and its
// audit event is emitted (dropped off-diff findings contribute no events).
const SQL_INJECTION_RAW_JSON = JSON.stringify({
  findings: [
    {
      title: 'SQL injection vulnerability',
      body: 'User input is concatenated directly into the SQL query string, enabling SQL injection.',
      priority: 2,
      category: 'security',
      code_location: { line: 1 },
    },
  ],
  overall_explanation: 'Found a security issue.',
  overall_correctness: 'issues found',
  overall_confidence_score: 0.9,
});

const MOCK_DIFF = generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]);

// Build a reviewFile/pollReviewBatch return by running the REAL engine on the raw fixture, honoring
// the per-repo severity_engine.enabled flag threaded via `config`. This is the whole point of the
// review fix: the mock never fabricates severity or severityAuditEvents.
function realEngineResult(params: { file: unknown; pass?: 'main' | 'security'; config: RepoConfig }) {
  const parsed = parseFileReviewResponse(SQL_INJECTION_RAW_JSON, params.file as any, {
    pass: params.pass ?? 'main',
    severityEngineEnabled: params.config.review.severity_engine.enabled,
  });
  return {
    parsed,
    modelUsed: 'test-model',
    provider: 'test-provider',
    inputTokens: 10,
    outputTokens: 5,
    rawText: SQL_INJECTION_RAW_JSON,
    userPrompt: '',
  };
}

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
    // Wrap the REAL append so cases 1-4 genuinely write to (and read back from) Postgres. Case 5
    // flips this to reject ONCE to prove the best-effort posture (finding #7).
    appendJobAuditEvents: vi.fn((...args: unknown[]) => (mod.appendJobAuditEvents as any)(...args)),
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
    // Default = synchronous path (submit returns null so the main pass uses reviewFile). The async
    // cases override submitReviewBatch/pollReviewBatch per-test via vi.spyOn on the prototype.
    async submitReviewBatch() {
      return null;
    }
    async pollReviewBatch() {
      return { status: 'pending' as const };
    }
    async reviewFile(params: any) {
      // Default synchronous review: run the REAL engine on the fixture, honoring the repo's
      // severity_engine.enabled flag threaded through `config`.
      return realEngineResult(params);
    }
    async generateSummary() {
      return { modelUsed: 'sum-model', provider: 'google', rawText: '{"summary": "test"}', inputTokens: 3, outputTokens: 2 };
    }
    async generateWalkthroughDiagram() {
      return {
        modelUsed: 'diagram-model',
        provider: 'google',
        rawText: 'sequenceDiagram\n  participant A\n  A->>B: call()',
        inputTokens: 7,
        outputTokens: 4,
      };
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

dbDescribe('Severity + audit trail through a REAL job run (engine + DB round trip)', () => {
  const env = createTestEnv();

  // Copied verbatim from review-flow.spec.ts: drives runReviewJob through its phase transitions,
  // backdating last_queue_message_at so a delayed reschedule can be re-claimed immediately in-process.
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
          const repo = (currentMessage as any).payload?.repository?.name;
          if (jobId) {
            await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
          } else if (repo) {
            await queryRows(
              env,
              `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE repository_id IN (SELECT id FROM repositories WHERE repo = $1)`,
              [repo],
            );
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

  const severityConfig = (enabled: boolean): RepoConfig => ({
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      severity_engine: { enabled },
    },
  });

  const securityPassConfig = (): RepoConfig => ({
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      passes: { ...defaultRepoConfig.review.passes, security: { enabled: true, cross_file: false } },
    },
  });

  // Insert a review job with an injected configSnapshot and mark Preparation done + file count set,
  // so runReviewJob drives the review->finalize path WITHOUT re-loading (and clobbering) the config.
  // Mirrors review-flow.spec.ts's multi-pass scheduling setup.
  async function insertReadyJob(repo: string, config: RepoConfig, commitChar: string) {
    const job = await insertJob(env, {
      installationId: '123',
      owner: 'test-owner',
      repo,
      prNumber: 7,
      prTitle: 'Severity + Audit Integration',
      prAuthor: 'author',
      commitSha: sha(commitChar),
      baseSha: sha('0'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: config,
    });
    await updateJobFileCount(env, job.id, 1);
    await updateJobStep(env, job.id, 'Preparation', { status: 'done' });
    return job;
  }

  it('SYNC path, engine ENABLED: persists a drafted event AND the REAL engine keyword_promotion event', async () => {
    const { ModelService } = await import('@server/services/model');
    const repo = `sev-audit-${Date.now()}-sync-on`;
    const reviewSpy = vi
      .spyOn(ModelService.prototype as any, 'reviewFile')
      .mockImplementation(async (params: any) => realEngineResult(params));

    const job = await insertReadyJob(repo, severityConfig(true), 'a');
    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-sync-on' } as any);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('a'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      const detail = await getJobDetail(env, finalJob!.id);
      expect(detail).not.toBeNull();
      expect(detail!.audit.length).toBeGreaterThan(0);
      expect(detail!.auditTruncated).toBe(false);

      const drafted = detail!.audit.filter((e): e is Extract<JobAuditEvent, { stage: 'drafted' }> => e.stage === 'drafted');
      expect(drafted.some((e) => e.file === 'src/app.ts' && e.pass === 'main')).toBe(true);

      const adjusted = detail!.audit.filter((e): e is Extract<JobAuditEvent, { stage: 'severity_adjusted' }> => e.stage === 'severity_adjusted');
      expect(adjusted.some((e) => e.rule === 'keyword_promotion' && e.from === 'P2' && e.to === 'P0')).toBe(true);
    });

    reviewSpy.mockRestore();
  }, TIMEOUT_MS);

  it('ASYNC-BATCH path, engine ENABLED: the poll persist site also records a drafted event', async () => {
    const { ModelService } = await import('@server/services/model');
    const repo = `sev-audit-${Date.now()}-async-on`;

    const submitSpy = vi
      .spyOn(ModelService.prototype as any, 'submitReviewBatch')
      .mockResolvedValue({ requestId: 'req-async-on', model: 'test-model', modelLineCap: 800 });
    // pollReviewBatch receives `config` ONLY because review.ts:994 threads it (Task 1). Building the
    // parsed result off params.config proves config reached the async parse path (config-reaches-code).
    const pollSpy = vi.spyOn(ModelService.prototype as any, 'pollReviewBatch').mockImplementation(async (params: any) => {
      const { parsed, ...rest } = realEngineResult({ file: params.file, pass: 'main', config: params.config });
      return {
        status: 'done' as const,
        response: { ...rest, parsed, reviewedLineCount: params.file.lineCount, wasPromptTruncated: false },
      };
    });

    const job = await insertReadyJob(repo, severityConfig(true), 'b');
    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-async-on' } as any);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('b'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      const detail = await getJobDetail(env, finalJob!.id);
      const drafted = detail!.audit.filter((e): e is Extract<JobAuditEvent, { stage: 'drafted' }> => e.stage === 'drafted');
      expect(drafted.some((e) => e.file === 'src/app.ts' && e.pass === 'main')).toBe(true);
    });

    submitSpy.mockRestore();
    pollSpy.mockRestore();
  }, TIMEOUT_MS);

  it('SECURITY pass: records a drafted event with pass="security" alongside the main pass', async () => {
    const { ModelService } = await import('@server/services/model');
    const repo = `sev-audit-${Date.now()}-secpass`;
    const reviewSpy = vi
      .spyOn(ModelService.prototype as any, 'reviewFile')
      .mockImplementation(async (params: any) => realEngineResult(params));

    const job = await insertReadyJob(repo, securityPassConfig(), 'c');
    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-secpass' } as any);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('c'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      const detail = await getJobDetail(env, finalJob!.id);
      const drafted = detail!.audit.filter((e): e is Extract<JobAuditEvent, { stage: 'drafted' }> => e.stage === 'drafted');
      const passes = drafted.filter((e) => e.file === 'src/app.ts').map((e) => e.pass).sort();
      expect(passes).toContain('main');
      expect(passes).toContain('security');
    });

    reviewSpy.mockRestore();
  }, TIMEOUT_MS);

  it('engine DISABLED (SYNC): severity passes through unchanged, no severity_adjusted event', async () => {
    const { ModelService } = await import('@server/services/model');
    const repo = `sev-audit-${Date.now()}-sync-off`;
    const reviewSpy = vi
      .spyOn(ModelService.prototype as any, 'reviewFile')
      .mockImplementation(async (params: any) => realEngineResult(params));

    const job = await insertReadyJob(repo, severityConfig(false), 'd');
    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-sync-off' } as any);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('d'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      const detail = await getJobDetail(env, finalJob!.id);
      // No promotion: the SQL-injection finding stays at its raw priority-mapped severity (P2).
      const comment = detail!.files.flatMap((f) => f.parsedComments).find((c) => c.path === 'src/app.ts');
      expect(comment?.severity).toBe('P2');
      // And no severity_adjusted event was emitted -- only drafted.
      expect(detail!.audit.some((e) => e.stage === 'severity_adjusted')).toBe(false);
      expect(detail!.audit.some((e) => e.stage === 'drafted')).toBe(true);
    });

    reviewSpy.mockRestore();
  }, TIMEOUT_MS);

  it('engine DISABLED (ASYNC): escape hatch reaches pollReviewBatch -> no promotion, no severity_adjusted', async () => {
    const { ModelService } = await import('@server/services/model');
    const repo = `sev-audit-${Date.now()}-async-off`;

    const submitSpy = vi
      .spyOn(ModelService.prototype as any, 'submitReviewBatch')
      .mockResolvedValue({ requestId: 'req-async-off', model: 'test-model', modelLineCap: 800 });
    const pollSpy = vi.spyOn(ModelService.prototype as any, 'pollReviewBatch').mockImplementation(async (params: any) => {
      // params.config.review.severity_engine.enabled === false MUST reach the engine here (not merely
      // compile) -- this is the D-02 escape hatch on the async path (finding #1, config-reaches-code).
      const { parsed, ...rest } = realEngineResult({ file: params.file, pass: 'main', config: params.config });
      return {
        status: 'done' as const,
        response: { ...rest, parsed, reviewedLineCount: params.file.lineCount, wasPromptTruncated: false },
      };
    });

    const job = await insertReadyJob(repo, severityConfig(false), 'e');
    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-async-off' } as any);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('e'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');

      const detail = await getJobDetail(env, finalJob!.id);
      const comment = detail!.files.flatMap((f) => f.parsedComments).find((c) => c.path === 'src/app.ts');
      expect(comment?.severity).toBe('P2');
      expect(detail!.audit.some((e) => e.stage === 'severity_adjusted')).toBe(false);
      expect(detail!.audit.some((e) => e.stage === 'drafted')).toBe(true);
    });

    submitSpy.mockRestore();
    pollSpy.mockRestore();
  }, TIMEOUT_MS);

  it('BEST-EFFORT: a forced audit-write failure never fails the review (job still reaches done)', async () => {
    const { ModelService } = await import('@server/services/model');
    const repo = `sev-audit-${Date.now()}-besteffort`;
    const reviewSpy = vi
      .spyOn(ModelService.prototype as any, 'reviewFile')
      .mockImplementation(async (params: any) => realEngineResult(params));

    // Force the very next audit append (this job's single main-pass unit) to reject. recordUnitAudit
    // swallows it (best-effort, finding #7) -- the review must still complete.
    vi.mocked(appendJobAuditEvents).mockRejectedValueOnce(new Error('forced audit-write failure'));

    const job = await insertReadyJob(repo, severityConfig(true), 'f');
    await runAndDrain({ jobId: job.id, deliveryId: 'delivery-besteffort' } as any);

    await runWithDb(env, async () => {
      const finalJob = await findExistingJobForHead(env, { owner: 'test-owner', repo, prNumber: 7, commitSha: sha('f'), trigger: 'auto' });
      expect(finalJob?.status).toBe('done');
    });

    reviewSpy.mockRestore();
  }, TIMEOUT_MS);
});
