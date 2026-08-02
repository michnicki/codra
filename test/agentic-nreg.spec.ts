// Phase 35 (PRD-06 / NREG-01 / D-13): the toggle-off non-regression spec.
//
// The guarantee this file exists to hold: AN OPERATOR WHO UPGRADES AND CHANGES NOTHING GETS EXACTLY
// THE REVIEW THEY GOT BEFORE — byte-identical prompts, zero extra KV reads, zero extra model calls,
// zero extra phase hops. `agentic_tools` ships OFF (D-13/D-15), so that default path is the one almost
// every instance runs, and it is the one a purely additive feature is most likely to perturb invisibly.
//
// IT IS MODELLED LINE-FOR-LINE ON `test/file-history-nreg.spec.ts` and extended with the I/O half,
// because Phase 34's WR-05 defect is the exact regression it guards (35-RESEARCH.md Pitfall 3): the
// Phase-34 NREG spec asserted only that the KV VALUE was null when the toggle was off, never that no
// READ occurred, so an ungated `runReviewPhase` KV read — one wasted round trip PER CHUNK, PER
// fresh-instance HANDOFF, PER RETRY, always a guaranteed miss — shipped unnoticed. Asserting the
// absence of the read itself is the whole point of the second half below.
//
// TWO HALVES, DELIBERATELY DIFFERENT COSTS:
//   - The PROMPT half is pure: no database, no bindings, no fetch. It sits OUTSIDE `dbDescribe` and
//     still asserts under a bare `npx vitest run test/agentic-nreg.spec.ts`, so the byte-identity
//     guarantee stays cheap to re-check on any host (the 29-02 precedent — gating pure schema
//     assertions behind a DB check silently skips the entire default-off proof).
//   - The I/O half drives a real job and IS database-backed. A bare `npx vitest run` does not load
//     `.env.test`, so it skips; run it as
//     `set -a && . ./.env.test && set +a && DATABASE_URL="$TEST_DATABASE_URL" npx vitest run --project node test/agentic-nreg.spec.ts`
//     and require a non-zero passed count with zero skipped suites. (`npm test -- <spec>` does not
//     filter — `scripts/test.mjs` ignores `process.argv` — so it runs the whole node suite instead.)
//     Confirm migrations are current on the CONNECTED database by content
//     (`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1` = newest file in
//     `db/migrations/`), never by port.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFileReviewPrompts,
  UNTRUSTED_AGENTIC_BEGIN,
  UNTRUSTED_AGENTIC_END,
} from '@server/prompts/file-review';
import type { FileDiff } from '@server/core/diff';
import { agenticContextCacheKey, runReviewJob } from '@server/core/review';
import { queryRows } from '@server/db/client';
import { findExistingJobForHead } from '@server/db/jobs';
import { getOrCreateRepository } from '@server/db/repositories';
import { upsertRepoConfig } from '@server/db/repo-configs';
import type { AppBindings } from '@server/env';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl, MemoryKV } from './helpers';
import { defaultRepoConfig, repoConfigSchema, type RepoConfig } from '@shared/schema';

const file: FileDiff = {
  path: 'src/example.ts',
  previousPath: null,
  isNew: false,
  isDeleted: false,
  isBinary: false,
  lineCount: 3,
  hunks: [
    {
      header: '@@ -1,2 +1,3 @@',
      lines: [
        { kind: 'context', content: 'const a = 1;', newLineNumber: 1, position: 1 },
        { kind: 'add', content: 'const b = a + 1;', newLineNumber: 2, position: 2 },
      ],
    },
  ],
};

// The DEFAULT config — what every instance that has not opted in runs.
const configToggleOff = repoConfigSchema.parse({}).review;
const configToggleOn = repoConfigSchema.parse({ review: { agentic_tools: { enabled: true } } }).review;

// A blob shaped like a real gathered transcript (the outer sentinels are added by the builder).
const gatheredContext = [
  '--- read_file result (pull request head abc1234) ---',
  '```',
  'export const GATHERED = 1;',
  '```',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HALF 1 — the prompt. Pure; no database, no bindings.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('NREG-01 / D-13: agentic-context toggle-off byte identity (pure)', () => {
  it('ships OFF: repoConfigSchema.parse({}).review.agentic_tools.enabled is false', () => {
    expect(configToggleOff.agentic_tools.enabled).toBe(false);
  });

  it('produces a byte-identical prompt when agenticContext is omitted vs explicitly undefined', () => {
    const withoutKey = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOff,
    });
    const withUndefined = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOff,
      agenticContext: undefined,
    });
    // Full-string equality, never a substring check: the guarantee is byte identity.
    expect(withUndefined.userPrompt).toBe(withoutKey.userPrompt);
    expect(withUndefined.systemPrompt).toBe(withoutKey.systemPrompt);
  });

  it('T-34-02-04 pattern: a provided-but-DISABLED blob is byte-identically suppressed by the builder’s own gate', () => {
    const withoutContext = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOff,
    });
    const withContext = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOff,
      agenticContext: gatheredContext,
    });
    // The DEFENSE-IN-DEPTH half of the WR-05 / T-34-02-04 pattern: the primary gate is caller-level
    // (the phase never runs and the KV read never happens when the toggle is off), but a blob that
    // reaches the builder anyway — a stale KV entry inside its 1-hour TTL after an operator toggled
    // the feature back off mid-flight — must STILL not reach the prompt. Asserted as full-string
    // equality rather than "does not contain the sentinel", so a partial leak of the framing lines
    // above the sentinel cannot pass.
    expect(withContext.userPrompt).toBe(withoutContext.userPrompt);
    expect(withContext.systemPrompt).toBe(withoutContext.systemPrompt);
    expect(withContext.userPrompt).not.toContain(UNTRUSTED_AGENTIC_BEGIN);
    expect(withContext.userPrompt).not.toContain(UNTRUSTED_AGENTIC_END);
  });

  it('POSITIVE CONTROL: with the toggle ON the same blob DOES change the prompt and is fenced by both sentinels', () => {
    const withoutContext = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOn,
    });
    const withContext = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOn,
      agenticContext: gatheredContext,
    });
    // Without this case every assertion above would also pass against a builder that had no
    // agentic-context appendix at all.
    expect(withContext.userPrompt).not.toBe(withoutContext.userPrompt);
    expect(withContext.userPrompt).toContain(UNTRUSTED_AGENTIC_BEGIN);
    expect(withContext.userPrompt).toContain(UNTRUSTED_AGENTIC_END);
    const begin = withContext.userPrompt.indexOf(UNTRUSTED_AGENTIC_BEGIN);
    const end = withContext.userPrompt.indexOf(UNTRUSTED_AGENTIC_END);
    expect(withContext.userPrompt.slice(begin, end)).toContain('export const GATHERED = 1;');
    // The toggle governs the appendix only — the system prompt is unaffected either way.
    expect(withContext.systemPrompt).toBe(withoutContext.systemPrompt);
  });

  it('an EMPTY blob is treated as no blob (byte-identical) even with the toggle ON', () => {
    const withoutContext = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOn,
    });
    const withEmpty = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOn,
      agenticContext: '',
    });
    // An empty-string blob would otherwise render an empty fenced section — three framing lines and
    // two sentinels of pure noise on every file of every review.
    expect(withEmpty.userPrompt).toBe(withoutContext.userPrompt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// HALF 2 — the I/O. Drives a real job with an instrumented KV. Database-backed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  verifierCalls: [] as string[],
  reviewFileCalls: [] as Array<{ path: string; agenticContext?: string }>,
  getPullRequestDiff: vi.fn(),
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('@server/services/github', () => {
  return {
    GitHubService: class MockGitHubService {
      private readonly tracker?: { incrementSubrequests(count?: number): void };
      constructor(_env: unknown, _installationId: string, tracker?: { incrementSubrequests(count?: number): void }) {
        this.tracker = tracker;
      }
      async getPullRequest() {
        this.tracker?.incrementSubrequests(1);
        return {
          title: 'NREG PR',
          body: 'NREG Body',
          head: { sha: 'c'.repeat(40), ref: 'feature' },
          base: { sha: '0'.repeat(40), ref: 'main' },
          user: { login: 'author' },
        };
      }
      async getPullRequestDiff() {
        this.tracker?.incrementSubrequests(1);
        return mocks.getPullRequestDiff();
      }
      async getCompareDiff() {
        return '';
      }
      async getRepoFileContent() {
        return null;
      }
      async getRepoFileOrNull() {
        return null;
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
      async getFileHistory() {
        return [];
      }
    },
  };
});

vi.mock('@server/services/model', () => {
  return {
    ModelService: class MockModelService {
      async callVerifierRaw(params: { systemPrompt: string }) {
        // Any call at all on the default config is a regression — recorded rather than thrown so the
        // assertion reports WHICH prompt leaked.
        mocks.verifierCalls.push(params.systemPrompt.slice(0, 80));
        return { rawText: '{"action":"done"}', modelUsed: 'test-model', inputTokens: 1, outputTokens: 1 };
      }
      async submitReviewBatch() {
        return null;
      }
      async reviewFile(params: any) {
        mocks.reviewFileCalls.push({ path: params.file.path, agenticContext: params.agenticContext });
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

/**
 * MemoryKV that records EVERY `get` key, so the assertion can count reads by prefix across the whole
 * job rather than inside one `runReviewPhase` call. Counting per-call is what let WR-05 through: the
 * wasted read was one per chunk, per handoff, per retry, and any single-invocation assertion sees at
 * most one of them.
 */
class RecordingKV extends MemoryKV {
  public readonly getKeys: string[] = [];

  override async get(key: string, type?: any) {
    this.getKeys.push(key);
    return super.get(key, type);
  }
}

const OWNER = 'nreg-owner';
const INSTALLATION_ID = '123';
const PR_NUMBER = 1;
const HEAD_SHA = 'c'.repeat(40);
const BASE_SHA = '0'.repeat(40);
const AGENTIC_KEY_PREFIX = 'agentic-context:';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const kv = new RecordingKV();
let cachedEnv: AppBindings | null = null;

/**
 * MEMOIZED AND CALLED ONLY FROM TEST BODIES. `createTestEnv()` throws on a host without the test env
 * vars, and vitest executes a SKIPPED suite's `beforeAll`/`beforeEach` hooks, so constructing the env
 * in either place fails the whole FILE — taking the pure half above down with it. Reaching it through
 * a function called inside the (never-executed) test bodies is what keeps a bare
 * `npx vitest run test/agentic-nreg.spec.ts` at "5 passed | 3 skipped, 0 failed".
 */
function testEnv(): AppBindings {
  cachedEnv ??= createTestEnv({ APP_KV: kv as unknown as KVNamespace });
  return cachedEnv;
}

dbDescribe('NREG-01 / WR-05: agentic-context toggle-off pays zero extra I/O (real job)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.verifierCalls.length = 0;
    mocks.reviewFileCalls.length = 0;
    mocks.getPullRequestDiff.mockReset();
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff([{ path: 'src/x.ts', content: 'x' }]));
  });

  async function seedRepoWithDefaultConfig(repo: string) {
    await getOrCreateRepository(testEnv(), {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      vcsProvider: 'github',
    });
    // The DEFAULT config, written verbatim — this is the upgrade-and-change-nothing state.
    await upsertRepoConfig(testEnv(), {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      parsedJson: structuredClone(defaultRepoConfig) as RepoConfig,
    });
  }

  async function runPrepare(repo: string) {
    return runReviewJob(testEnv(), {
      deliveryId: `delivery-nreg-${repo}-${Date.now()}`,
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: INSTALLATION_ID },
        repository: { owner: { login: OWNER }, name: repo },
        pull_request: {
          number: PR_NUMBER,
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: BASE_SHA, ref: 'main' },
          title: 'NREG PR',
          user: { login: 'author' },
          draft: false,
        },
      },
    } as any);
  }

  async function findJob(repo: string) {
    const job = await findExistingJobForHead(testEnv(), {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    if (!job) throw new Error(`agentic-nreg.spec: no job row for ${repo}`);
    return job;
  }

  // Drives the review phase to completion, however many chunks the shared DB's concurrency level
  // needs, and reports how many separate `runReviewPhase` invocations it took. Backdating
  // last_queue_message_at between invocations is the established in-process driver pattern (the real
  // queue simply delivers after the hand-off delay).
  async function runReviewUntilFinalize(repo: string) {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const job = await findJob(repo);
      await queryRows(
        testEnv(),
        `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`,
        [job.id],
      );
      const result = (await runReviewJob(testEnv(), { jobId: job.id, phase: 'review' } as any)) as {
        action: string;
        phase?: string;
      };
      if (result.action !== 'next_phase' || result.phase !== 'review') {
        return { result, invocations: attempt, jobId: job.id };
      }
    }
    throw new Error('review phase did not reach finalize within 12 chunk invocations');
  }

  it('a full job on the default config performs ZERO agentic-context KV reads, zero model calls and zero agentic_context hops (single chunk)', async () => {
    const repo = `repo-nreg-single-${Date.now()}`;
    await seedRepoWithDefaultConfig(repo);
    kv.getKeys.length = 0;

    const prep = (await runPrepare(repo)) as { action: string; phase?: string };
    // No extra phase hop: prepare hands off straight to review, exactly as it did before Phase 35.
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    const { result, jobId } = await runReviewUntilFinalize(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    // THE WR-05 ASSERTION: the absence of the READ, not merely a null value. Counted over the whole
    // job — prepare plus every review invocation.
    const agenticReads = kv.getKeys.filter((key) => key.startsWith(AGENTIC_KEY_PREFIX));
    expect(agenticReads).toEqual([]);
    // Zero model calls attributable to the agentic phase (the phase never ran at all).
    expect(mocks.verifierCalls).toEqual([]);
    // The model saw no gathered context, so the prompt it received is the pre-Phase-35 prompt.
    expect(mocks.reviewFileCalls.length).toBeGreaterThan(0);
    for (const call of mocks.reviewFileCalls) {
      expect(call.agenticContext).toBeUndefined();
    }
    // And nothing was written either — the key genuinely does not exist.
    expect(await testEnv().APP_KV.get(agenticContextCacheKey(jobId), 'text')).toBeNull();
  });

  it('WR-05: still ZERO agentic-context KV reads across a review split into MORE THAN ONE chunk', async () => {
    const repo = `repo-nreg-chunked-${Date.now()}`;
    await seedRepoWithDefaultConfig(repo);
    // 9 reviewable files against a configured chunk limit of at most 4
    // (REVIEW_CONCURRENCY_LIMITS.max), so the review phase MUST re-enter at least twice regardless of
    // the shared database's current concurrency setting. The WR-05 defect was one wasted read PER
    // CHUNK, so a single-chunk job cannot distinguish "gated" from "read once".
    const diffFiles = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, content: `f${i}` }));
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff(diffFiles));
    kv.getKeys.length = 0;

    const prep = (await runPrepare(repo)) as { action: string; phase?: string };
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    const { result, invocations } = await runReviewUntilFinalize(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });
    // The premise of this case: the review really did span multiple invocations.
    expect(invocations).toBeGreaterThan(1);

    const agenticReads = kv.getKeys.filter((key) => key.startsWith(AGENTIC_KEY_PREFIX));
    expect(agenticReads).toEqual([]);
    expect(mocks.verifierCalls).toEqual([]);
    expect(mocks.reviewFileCalls.map((call) => call.path).sort()).toEqual(diffFiles.map((f) => f.path).sort());
    for (const call of mocks.reviewFileCalls) {
      expect(call.agenticContext).toBeUndefined();
    }
  });

  it('POSITIVE CONTROL: with the toggle ON the review phase DOES read the agentic-context key', async () => {
    const repo = `repo-nreg-on-${Date.now()}`;
    await getOrCreateRepository(testEnv(), {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      vcsProvider: 'github',
    });
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.agentic_tools = { enabled: true };
    await upsertRepoConfig(testEnv(), { installationId: INSTALLATION_ID, owner: OWNER, repo, parsedJson });

    const prep = (await runPrepare(repo)) as { action: string; phase?: string };
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'agentic_context' });

    // Skip the agentic phase entirely and enter review directly: the toggle-gated read is the subject,
    // and this proves the gate is the toggle rather than the blob's presence.
    kv.getKeys.length = 0;
    const { result } = await runReviewUntilFinalize(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    // Without this case, a builder/phase pair that never read the key at all would satisfy every
    // assertion above.
    const agenticReads = kv.getKeys.filter((key) => key.startsWith(AGENTIC_KEY_PREFIX));
    expect(agenticReads.length).toBeGreaterThan(0);
  });
});
