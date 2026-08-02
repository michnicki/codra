// Phase 35 (PRD-06 / FR-131 / FR-132): the agentic-context PIPELINE integration spec.
//
// 35-01 pinned the pure executor (`test/agentic-tools.spec.ts`, 53 cases) and the prompt fencing
// (`test/agentic-prompt.spec.ts`, 29 cases). Neither can see the behaviours that only exist once the
// REAL phase state machine drives the loop, which is what this file covers by calling `runReviewJob`
// itself rather than `runAgenticContextPhase`:
//
//   - D-09  routing: `prepare -> agentic_context -> review` with the toggle on, `prepare -> review`
//           with it off, and the hand-off INTO `agentic_context` carrying `freshInstance: true`
//           (review.ts's ROUTING ANCHOR 4 — a plain boolean disjunction `tsc` cannot check).
//   - T-35-06: a `phase: 'agentic_context'` queue message with no `jobId` is rejected at the boundary
//           (ROUTING ANCHOR 9 — also not a `tsc` site).
//   - D-06  `read_file` resolves at the PULL REQUEST HEAD SHA, asserted on the `ref` argument that
//           reaches the provider and compared against the head sha VALUE, never "some non-empty sha".
//   - D-14  a repository whose `code_index_state.status` is `ready` skips the pass entirely; a
//           `building` row, a `failed` row and NO row all let the loop run. Needs a real Postgres row,
//           so it is structurally invisible to a unit test.
//   - D-11  fail-open on BOTH a `callVerifierRaw` rejection mid-loop and a drained subrequest budget:
//           whatever was gathered is persisted, the job advances to `review`, nothing terminal-fails.
//   - D-12  the `agentic-context:<jobId>` blob is written with `expirationTtl: 3600`, and a second
//           entry into the phase for the same job hands off with zero model calls and zero fetches.
//   - FR-131 fallback (ROADMAP success criterion 4): a loop that gathers nothing leaves NO KV key and
//           the review proceeds as an ordinary single review call whose prompt has no agentic section.
//
// WHY IT MOCKS `@server/services/github` RATHER THAN INSTALLING THE FETCH MOCK: this is the
// `test/file-history-pipeline.spec.ts` technique verbatim (the direct Phase-34 analog). `GithubAdapter`
// constructs `GitHubService` from '@server/services/github' and forwards the runReviewJob-built
// `TokenTracker` as the 3rd constructor argument, so mocking that module gives BOTH a recorded
// `getRepoFileContent(owner, repo, path, ref)` — which is exactly the `ref` D-06 is about — and a
// tracker whose budget can be spent deterministically without issuing 25 real subrequests.
//
// SHARED-DATABASE DISCIPLINE (T-35-09). The node vitest project runs `fileParallelism: false` against
// a Postgres that is NEVER reset and accumulates rows across runs. Every assertion below is scoped to
// the job id under test; none depends on a global job count or on a `LIMIT`-bounded query returning
// this spec's row (the documented cause of the existing review-flow check-run flake).
//
// ENVIRONMENT HAZARDS — recorded so a future reader does not misdiagnose one as a code defect:
//   - A bare `npx vitest run` does NOT load `.env.test`, so `hasConfiguredTestDatabaseUrl()` is false
//     and this whole suite SKIPS SILENTLY while reporting green. Run it as
//     `set -a && . ./.env.test && set +a && DATABASE_URL="$TEST_DATABASE_URL" npx vitest run --project node test/agentic-pipeline.spec.ts`
//     and require a non-zero passed count with zero skipped suites.
//   - `npm test -- <spec>` does not filter: `scripts/test.mjs` runs `vitest run --project node` with
//     fixed arguments and ignores `process.argv`.
//   - The D-14 case reads `code_index_state`, created by migration 018. A "relation does not exist"
//     failure is an un-migrated database, not a code defect. Identify the connected database by
//     content (`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1` must equal the newest
//     file in `db/migrations/`), never by port.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { agenticContextCacheKey, runReviewJob } from '@server/core/review';
import { agenticContextBlobSchema } from '@server/core/agentic-tools';
import { UNTRUSTED_AGENTIC_BEGIN, UNTRUSTED_AGENTIC_END } from '@server/prompts/file-review';
import { queryRows } from '@server/db/client';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { findExistingJobForHead, getJobDetail } from '@server/db/jobs';
// Namespace import so the T-35-19 case can spy on `appendJobAuditEvents` and force the audit write
// to reject. The module is already partially mocked above (`getOtherRunningJobsCount`), and the
// factory spreads the original, so the spy lands on the real function the recorder calls.
import * as jobsModule from '@server/db/jobs';
import { findRepositoryIdByIdentity, getOrCreateRepository } from '@server/db/repositories';
import {
  markCodeIndexBuildCompleted,
  markCodeIndexBuildFailed,
  markCodeIndexBuildStarted,
} from '@server/db/code-index';
import { upsertRepoConfig } from '@server/db/repo-configs';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';

const sha = (char: string) => char.repeat(40);
const OWNER = 'agentic-owner';
const INSTALLATION_ID = '123';
const PR_NUMBER = 1;
const HEAD_SHA = sha('c');
const BASE_SHA = sha('0');

// vi.hoisted so the vi.mock factories below can reference these (vitest hoists mock factories above
// the imports).
//
// `verifierScript` is the scripted `callVerifierRaw` queue — the `test/cross-file-security.spec.ts`
// idiom, extended so an entry can be an Error to be THROWN (the D-11 mid-loop rejection case).
// `subrequestsPerGetPullRequest` mirrors the real client's per-request `tracker.incrementSubrequests`
// so the loop's `hasBudget(AGENTIC_BUDGET_RESERVE)` guard is reachable deterministically without 25
// real fetches (the `file-history-pipeline.spec.ts:38-42` precedent).
const mocks = vi.hoisted(() => ({
  verifierScript: [] as Array<string | Error>,
  verifierCalls: [] as Array<{ systemPrompt: string; userPrompt: string }>,
  fileContents: new Map<string, string>(),
  // CR-02 (IN-07): before this the mock could only RESOLVE, so no test in the suite could drive a
  // provider throw through the phase and the defect was invisible. A path in this map makes
  // `getRepoFileContent` reject with that message, exactly as `GitHubClient.getRepoFileOrNull` does
  // on any non-404 status.
  fileContentErrors: new Map<string, string>(),
  fileContentCalls: [] as Array<{ owner: string; repo: string; path: string; ref: string }>,
  reviewFileCalls: [] as Array<{ path: string; agenticContext?: string; userPrompt: string }>,
  getPullRequestDiff: vi.fn(),
  subrequestsPerGetPullRequest: 1,
  trackers: [] as Array<{ remainingSafeBudget(): number }>,
  // D-05 three-valued code search: null = the capability is unavailable for this repository or
  // credential, [] = it ran and found nothing, entries = matches.
  searchCodeResult: null as Array<{ path: string; line: number; fragment: string; ref: string }> | null,
  searchCodeCalls: [] as number[],
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    // Concurrency admission in runReviewJob returns 'retry' when the shared test DB has too many
    // running jobs; force the count to 0 so prepare actually runs.
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('@server/services/github', () => {
  return {
    GitHubService: class MockGitHubService {
      // The runReviewJob-built TokenTracker, forwarded by GithubAdapter as the 3rd ctor argument.
      private readonly tracker?: { incrementSubrequests(count?: number): void };

      constructor(
        _env: unknown,
        _installationId: string,
        tracker?: { incrementSubrequests(count?: number): void },
      ) {
        this.tracker = tracker;
      }
      async getPullRequest() {
        // Mirror GitHubClient.request's per-request accounting. Raising
        // `subrequestsPerGetPullRequest` is how the budget-exhaustion case drains the tracker BEFORE
        // the loop's first reserve check, with no real subrequests spent.
        this.tracker?.incrementSubrequests(mocks.subrequestsPerGetPullRequest);
        return {
          title: 'Agentic PR',
          body: 'Agentic Body',
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: BASE_SHA, ref: 'main' },
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
      // THE D-06 OBSERVATION POINT. GithubAdapter.getFileContent delegates straight here, so the 4th
      // argument IS the `ref` the agentic loop's `readFile` callback resolved against.
      async getRepoFileContent(owner: string, repo: string, path: string, ref: string) {
        this.tracker?.incrementSubrequests(1);
        mocks.fileContentCalls.push({ owner, repo, path, ref });
        const failure = mocks.fileContentErrors.get(path);
        if (failure !== undefined) throw new Error(failure);
        return mocks.fileContents.get(path) ?? null;
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
      // 35-03 added GithubAdapter.searchCode, which delegates straight here. Returning null is the
      // D-05 capability downgrade — the shape the Bitbucket arm is permanently in (35-04).
      async searchCode() {
        this.tracker?.incrementSubrequests(1);
        mocks.searchCodeCalls.push(1);
        return mocks.searchCodeResult;
      }
    },
  };
});

vi.mock('@server/services/model', () => {
  return {
    ModelService: class MockModelService {
      constructor(
        _env: unknown,
        tracker?: { remainingSafeBudget(): number },
        _options?: unknown,
      ) {
        // ModelService's tracker is its SECOND constructor argument (`new ModelService(env, tracker,
        // { jobId })` at review.ts:549) — NOT the third, which is GitHubService's position. Captured
        // so a case can read the budget the loop actually saw.
        if (tracker) mocks.trackers.push(tracker);
      }
      // The agentic loop's single model seam. Scripted: each hop shifts one entry; an Error entry is
      // THROWN so the D-11 mid-loop rejection path runs for real.
      async callVerifierRaw(params: { systemPrompt: string; userPrompt: string }) {
        mocks.verifierCalls.push({ systemPrompt: params.systemPrompt, userPrompt: params.userPrompt });
        const next = mocks.verifierScript.shift();
        if (next === undefined) {
          throw new Error('agentic-pipeline.spec: callVerifierRaw called more times than the script provides');
        }
        if (next instanceof Error) throw next;
        return { rawText: next, modelUsed: 'test-model', inputTokens: 1, outputTokens: 1 };
      }
      async submitReviewBatch() {
        // Async batch unavailable -> the review phase falls through to the sync reviewFile path.
        return null;
      }
      async reviewFile(params: any) {
        // Build the prompt with the REAL builder on the REAL captured arguments (the same expression
        // `ModelService.reviewFileChunk` uses at services/model.ts:765-769), so the "does the gathered
        // context reach the review prompt" assertions are about the prompt the job actually produced
        // rather than about a value merely passed along.
        const { buildFileReviewPrompts } = await import('@server/prompts/file-review');
        const { userPrompt } = buildFileReviewPrompts({ ...params, config: params.config.review });
        mocks.reviewFileCalls.push({
          path: params.file.path,
          agenticContext: params.agenticContext,
          userPrompt,
        });
        return {
          modelUsed: 'test-model',
          provider: 'test-provider',
          rawText: '{"findings":[]}',
          userPrompt,
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

dbDescribe('Phase 35 (35-02): agentic-context pipeline', () => {
  const env = createTestEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.verifierScript.length = 0;
    mocks.verifierCalls.length = 0;
    mocks.fileContentCalls.length = 0;
    mocks.reviewFileCalls.length = 0;
    mocks.trackers.length = 0;
    mocks.fileContents.clear();
    mocks.fileContentErrors.clear();
    mocks.searchCodeCalls.length = 0;
    mocks.searchCodeResult = null;
    mocks.subrequestsPerGetPullRequest = 1;
    mocks.getPullRequestDiff.mockReset();
    mocks.getPullRequestDiff.mockImplementation(() => generateMockDiff([{ path: 'src/x.ts', content: 'x' }]));
  });

  async function seedRepoWithAgenticToggle(repo: string, enabled: boolean) {
    await getOrCreateRepository(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      vcsProvider: 'github',
    });
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.agentic_tools = { enabled };
    await upsertRepoConfig(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      parsedJson,
    });
  }

  async function runPrepare(repo: string) {
    return runReviewJob(env, {
      deliveryId: `delivery-agentic-${repo}-${Date.now()}`,
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: INSTALLATION_ID },
        repository: { owner: { login: OWNER }, name: repo },
        pull_request: {
          number: PR_NUMBER,
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: BASE_SHA, ref: 'main' },
          title: 'Agentic PR',
          user: { login: 'author' },
          draft: false,
        },
      },
    } as any);
  }

  async function findJob(repo: string) {
    const job = await findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
    if (!job) throw new Error(`agentic-pipeline.spec: no job row for ${repo}`);
    return job;
  }

  // Drives ONE explicit phase invocation the way the durable orchestrator would. A phase that hands
  // off with FRESH_INVOCATION_YIELD_SECONDS stamps `last_queue_message_at` in the future, and
  // claimJobLease treats that as a fresh lease and returns 'busy'; the in-process driver backdates it
  // between invocations (the established pattern across review-flow.spec.ts / file-history-pipeline
  // .spec.ts — the real queue simply delivers after the delay). Scoped to THIS job's id.
  async function runPhase(repo: string, phase: 'agentic_context' | 'review') {
    const job = await findJob(repo);
    await queryRows(
      env,
      `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`,
      [job.id],
    );
    return { job, result: await runReviewJob(env, { jobId: job.id, phase } as any) };
  }

  async function runReviewUntilFinalize(repo: string) {
    let result: { action: string; phase?: string } = { action: 'none' };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const outcome = await runPhase(repo, 'review');
      result = outcome.result as { action: string; phase?: string };
      if (result.action !== 'next_phase' || result.phase !== 'review') return result;
    }
    throw new Error('review phase did not reach finalize within 12 chunk invocations');
  }

  async function readBlob(jobId: string) {
    const raw = await env.APP_KV.get(agenticContextCacheKey(jobId), 'text');
    if (raw === null) return null;
    const parsed = agenticContextBlobSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('agentic-pipeline.spec: persisted blob does not match the contract');
    return parsed.data;
  }

  const readFileAction = (path: string) => JSON.stringify({ action: 'read_file', path });
  const grepAction = (query: string) => JSON.stringify({ action: 'grep_repo', query });
  const doneAction = (reason = 'enough context') => JSON.stringify({ action: 'done', reason });

  // ── 35-06: the operator-visible audit trace ─────────────────────────────────────────────────
  //
  // Read back through the same job-detail path the dashboard uses, so an event that fails the
  // per-element schema parse on the read side is INVISIBLE here too — exactly as it would be to an
  // operator. Asserting on the append call instead would pass for an event nobody can ever see.
  type AgenticAuditEvent = {
    stage: 'agentic_context';
    status: string;
    reason?: string;
    hops_used?: number;
    files_read?: number;
    greps_run?: number;
    bytes_gathered?: number;
    truncated?: boolean;
    grep_supported?: boolean;
    budget_headroom?: number;
  };

  async function agenticAuditEvents(jobId: string): Promise<AgenticAuditEvent[]> {
    const detail = await getJobDetail(env, jobId);
    return ((detail?.audit ?? []) as Array<{ stage: string }>).filter(
      (event) => event.stage === 'agentic_context',
    ) as AgenticAuditEvent[];
  }

  /**
   * The single event a non-silent exit must leave. Fails loudly on 0 or 2+.
   *
   * `budget_headroom` is asserted on EVERY path including the pre-loop gates, because
   * `tracker.remainingSafeBudget()` is knowable at any point and §7 alerts on `< 2`.
   * `grep_supported` deliberately is NOT — see `theLoopExitAuditEvent`.
   */
  async function theAgenticAuditEvent(jobId: string): Promise<AgenticAuditEvent> {
    const events = await agenticAuditEvents(jobId);
    expect(events).toHaveLength(1);
    expect(typeof events[0].budget_headroom).toBe('number');
    expect(events[0].budget_headroom).toBeGreaterThanOrEqual(0);
    return events[0];
  }

  /**
   * The single event a run that actually REACHED the loop must leave. Adds the `grep_supported`
   * assertion, which only a loop exit can honestly answer: a pre-loop gate (D-14 index present)
   * never consulted the search capability, and fabricating `false` there would fire §7's
   * "grep_supported: false on GitHub — any occurrence" alert for a repository where nothing was even
   * attempted. Absent means unknown, and the viewer omits the line entirely.
   */
  async function theLoopExitAuditEvent(jobId: string): Promise<AgenticAuditEvent> {
    const event = await theAgenticAuditEvent(jobId);
    expect(typeof event.grep_supported).toBe('boolean');
    return event;
  }

  // ── D-09 routing + ROUTING ANCHOR 4 (freshInstance) ──────────────────────────────────────────

  it('D-09: toggle ON inserts agentic_context between prepare and review, and the hand-off INTO it carries freshInstance: true (ROUTING ANCHOR 4)', async () => {
    const repo = `repo-ag-route-on-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.fileContents.set('src/helper.ts', 'export const HELPER = 1;\n');
    mocks.verifierScript.push(readFileAction('src/helper.ts'), doneAction());

    const prep = await runPrepare(repo);
    // The prepare hand-off routes to agentic_context, NOT straight to review.
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'agentic_context' });
    // ROUTING ANCHOR 4 is a plain boolean disjunction on the DESTINATION phase (review.ts:616), so
    // this is the flag that decides whether the agentic phase gets its own fresh subrequest budget.
    // Omitting 'agentic_context' from that disjunction compiles cleanly and then runs the loop on an
    // already-spent budget — a source assertion cannot distinguish the two, this can.
    expect((prep as { freshInstance?: boolean }).freshInstance).toBe(true);

    const { result: agentic } = await runPhase(repo, 'agentic_context');
    // The phase's ONLY exit (D-11) is a hand-off to review. `review` is a shared-budget phase, so it
    // is deliberately NOT in the fresh-instance disjunction — asserted explicitly so a future change
    // that adds it has to justify itself here.
    expect(agentic).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect((agentic as { freshInstance?: boolean }).freshInstance).toBe(false);

    const result = await runReviewUntilFinalize(repo);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    // 35-06: a successful run leaves exactly ONE event, and it is the whole field set — this is the
    // row the operator reads next to the findings the gathered context produced.
    const job = await findJob(repo);
    const event = await theLoopExitAuditEvent(job.id);
    expect(event.status).toBe('completed');
    expect(event.reason).toBe('done');
    expect(event.hops_used).toBeGreaterThan(0);
    expect(event.files_read).toBe(1);
    expect(event.greps_run).toBe(0);
    expect(event.bytes_gathered).toBeGreaterThan(0);
    expect(event.truncated).toBe(false);
  });

  it('D-09 / NREG-01: toggle OFF routes prepare straight to review and never produces an agentic_context hand-off', async () => {
    const repo = `repo-ag-route-off-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, false);

    const phases: Array<string | undefined> = [];
    const prep = await runPrepare(repo);
    phases.push((prep as { phase?: string }).phase);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    const result = await runReviewUntilFinalize(repo);
    phases.push((result as { phase?: string }).phase);
    expect(result).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    // No hand-off anywhere in the job names the agentic phase, so the orchestrator never enqueues an
    // `agentic_context` message: the toggle-off path costs zero extra phase hops.
    expect(phases).not.toContain('agentic_context');
    expect(mocks.verifierCalls).toEqual([]);
    expect(mocks.fileContentCalls).toEqual([]);
    const job = await findJob(repo);
    expect(await env.APP_KV.get(agenticContextCacheKey(job.id), 'text')).toBeNull();

    // 35-06 / NREG-01: the toggle-off branch must stay COMPLETELY silent. An audit row is
    // observable behaviour, so a single event here breaks the byte-identity promise just as surely
    // as a KV read would. Asserted as a COUNT OF ZERO, not as "some other event also exists".
    expect(await agenticAuditEvents(job.id)).toHaveLength(0);
  });

  it('T-35-06 (ROUTING ANCHOR 9): a phase:"agentic_context" queue message with NO jobId is rejected before the phase runs', async () => {
    const repo = `repo-ag-spoof-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    // A real job exists for this repo/head, so the ONLY thing standing between the spoofed message
    // and a tool loop running against that job is the jobId guard.
    await runPrepare(repo);
    const job = await findJob(repo);
    mocks.verifierCalls.length = 0;
    mocks.fileContentCalls.length = 0;

    const result = await runReviewJob(env, {
      deliveryId: `delivery-agentic-spoof-${Date.now()}`,
      phase: 'agentic_context',
      eventName: 'pull_request',
      payload: {
        action: 'synchronize',
        installation: { id: INSTALLATION_ID },
        repository: { owner: { login: OWNER }, name: repo },
        pull_request: {
          number: PR_NUMBER,
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: BASE_SHA, ref: 'main' },
          title: 'Agentic PR',
          user: { login: 'author' },
          draft: false,
        },
      },
    } as any);

    // Acked and dropped: no phase ran, so no model call, no fetch and no blob.
    expect(result).toEqual({ action: 'ack' });
    expect(mocks.verifierCalls).toEqual([]);
    expect(mocks.fileContentCalls).toEqual([]);
    expect(await env.APP_KV.get(agenticContextCacheKey(job.id), 'text')).toBeNull();
  });

  // ── D-06 head-SHA resolution ─────────────────────────────────────────────────────────────────

  it('D-06: read_file resolves at the PULL REQUEST HEAD SHA — the ref argument equals pr.headSha and is not the base SHA', async () => {
    const repo = `repo-ag-headsha-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.fileContents.set('src/target.ts', 'export const TARGET = 1;\n');
    mocks.verifierScript.push(readFileAction('src/target.ts'), doneAction());

    await runPrepare(repo);
    const { result } = await runPhase(repo, 'agentic_context');
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });

    expect(mocks.fileContentCalls).toHaveLength(1);
    const [call] = mocks.fileContentCalls;
    expect(call.path).toBe('src/target.ts');
    // Compared against the head sha VALUE. Deliberately NOT weakened to "a non-empty sha": the whole
    // point of D-06 is WHICH sha, and the base sha is the plausible wrong answer.
    expect(call.ref).toBe(HEAD_SHA);
    expect(call.ref).not.toBe(BASE_SHA);
  });

  // ── D-14 code-index gate (needs a real Postgres row) ─────────────────────────────────────────

  it('D-14: a code_index_state row with status "ready" skips the pass — zero callVerifierRaw calls, zero getFileContent calls, still advances to review', async () => {
    const repo = `repo-ag-idx-ready-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    const repositoryId = await findRepositoryIdByIdentity(env, {
      vcsProvider: 'github',
      ownerOrWorkspace: OWNER,
      repo,
    });
    expect(repositoryId).not.toBeNull();
    await markCodeIndexBuildStarted(env, {
      repositoryId: repositoryId!,
      mode: 'full',
      indexedRef: 'main',
      buildingSha: HEAD_SHA,
      workflowInstanceId: null,
      leaseSeconds: 60,
    });
    await markCodeIndexBuildCompleted(env, {
      repositoryId: repositoryId!,
      indexedRef: 'main',
      indexedSha: HEAD_SHA,
      fileCount: 3,
      chunkCount: 9,
      truncated: false,
    });
    // Deliberately NO script: if the gate leaks, callVerifierRaw throws "called more times than the
    // script provides" and this case fails loudly rather than silently gathering context.

    await runPrepare(repo);
    const { job, result } = await runPhase(repo, 'agentic_context');
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.verifierCalls).toEqual([]);
    expect(mocks.fileContentCalls).toEqual([]);
    expect(await env.APP_KV.get(agenticContextCacheKey(job.id), 'text')).toBeNull();

    // 35-06 / D-14: the gate is a DECISION and must be visible. Without this row an operator seeing
    // a toggle-on job that spent nothing cannot tell "the index made this unnecessary" from "the
    // feature is broken".
    const event = await theAgenticAuditEvent(job.id);
    expect(event.status).toBe('skipped');
    expect(event.reason).toBe('index_present');
    // The gate fires BEFORE the loop, so there are no loop counts to report — absent, not zero.
    expect(event.hops_used).toBeUndefined();
    expect(event.bytes_gathered).toBeUndefined();
  });

  it('D-14: a "building" row, a "failed" row and NO row at all each let the loop run', async () => {
    // Three sibling repositories rather than three mutations of one row, so each sub-case is
    // independently scoped and no ordering dependency exists between them.
    const cases: Array<{ label: string; seed: (repositoryId: number) => Promise<void> }> = [
      {
        label: 'building',
        seed: async (repositoryId) => {
          await markCodeIndexBuildStarted(env, {
            repositoryId,
            mode: 'full',
            indexedRef: 'main',
            buildingSha: HEAD_SHA,
            workflowInstanceId: null,
            leaseSeconds: 60,
          });
        },
      },
      {
        label: 'failed',
        seed: async (repositoryId) => {
          await markCodeIndexBuildStarted(env, {
            repositoryId,
            mode: 'full',
            indexedRef: 'main',
            buildingSha: HEAD_SHA,
            workflowInstanceId: null,
            leaseSeconds: 60,
          });
          await markCodeIndexBuildFailed(env, { repositoryId, message: 'transient' });
        },
      },
      { label: 'absent', seed: async () => {} },
    ];

    for (const testCase of cases) {
      mocks.verifierCalls.length = 0;
      mocks.fileContentCalls.length = 0;
      mocks.verifierScript.length = 0;
      mocks.fileContents.clear();

      const repo = `repo-ag-idx-${testCase.label}-${Date.now()}`;
      await seedRepoWithAgenticToggle(repo, true);
      const repositoryId = await findRepositoryIdByIdentity(env, {
        vcsProvider: 'github',
        ownerOrWorkspace: OWNER,
        repo,
      });
      expect(repositoryId).not.toBeNull();
      await testCase.seed(repositoryId!);

      mocks.fileContents.set('src/probe.ts', `// probe for ${testCase.label}\n`);
      mocks.verifierScript.push(readFileAction('src/probe.ts'), doneAction());

      await runPrepare(repo);
      const { result } = await runPhase(repo, 'agentic_context');
      expect(result, testCase.label).toMatchObject({ action: 'next_phase', phase: 'review' });
      // 'ready' is the ONLY status that means a queryable index, so all three of these RUN the loop.
      expect(mocks.verifierCalls.length, testCase.label).toBeGreaterThan(0);
      expect(mocks.fileContentCalls.map((call) => call.path), testCase.label).toEqual(['src/probe.ts']);
    }
  });

  // ── D-12 KV persistence, TTL, and idempotent re-entry ───────────────────────────────────────

  it('D-12: a successful loop writes agentic-context:<jobId> with expirationTtl 3600', async () => {
    const repo = `repo-ag-kv-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.fileContents.set('src/kv.ts', 'export const KV_MARKER = "kv-marker";\n');
    mocks.verifierScript.push(readFileAction('src/kv.ts'), doneAction());

    await runPrepare(repo);
    const putSpy = vi.spyOn(env.APP_KV, 'put');
    const { job, result } = await runPhase(repo, 'agentic_context');
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });

    const key = agenticContextCacheKey(job.id);
    const blob = await readBlob(job.id);
    expect(blob).not.toBeNull();
    expect(blob!.context).toContain('KV_MARKER');
    expect(blob!.stopReason).toBe('done');
    expect(blob!.filesRead).toBe(1);
    // The 1-hour TTL is part of the D-12 contract: the gathered context is bounded to this job's
    // lifespan, so an operator's KV namespace never accumulates review transcripts.
    const agenticPuts = putSpy.mock.calls.filter(([putKey]) => putKey === key);
    expect(agenticPuts).toHaveLength(1);
    expect(agenticPuts[0][2]).toMatchObject({ expirationTtl: 3600 });
    putSpy.mockRestore();

    // 35-06: the audit event's counts agree with the persisted blob's, field for field. Two
    // independent records of the same run that disagree would make both untrustworthy.
    const event = await theLoopExitAuditEvent(job.id);
    expect(event.status).toBe('completed');
    expect(event.reason).toBe('done');
    expect(event.hops_used).toBe(blob!.hopsUsed);
    expect(event.files_read).toBe(blob!.filesRead);
    expect(event.greps_run).toBe(blob!.grepsRun);
    expect(event.bytes_gathered).toBe(blob!.bytesGathered);
    expect(event.truncated).toBe(blob!.truncated);
    expect(event.grep_supported).toBe(blob!.grepSupported);
  });

  it('D-12: re-entering the phase with the blob already in KV performs zero model calls and zero fetches and still advances to review', async () => {
    const repo = `repo-ag-idem-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.fileContents.set('src/idem.ts', 'export const IDEM = 1;\n');
    mocks.verifierScript.push(readFileAction('src/idem.ts'), doneAction());

    await runPrepare(repo);
    const first = await runPhase(repo, 'agentic_context');
    expect(first.result).toMatchObject({ action: 'next_phase', phase: 'review' });
    const callsAfterFirst = mocks.verifierCalls.length;
    const fetchesAfterFirst = mocks.fileContentCalls.length;
    expect(callsAfterFirst).toBe(2);
    expect(fetchesAfterFirst).toBe(1);
    const blobAfterFirst = await env.APP_KV.get(agenticContextCacheKey(first.job.id), 'text');
    expect(blobAfterFirst).not.toBeNull();

    // A lease-recovery retry, a fresh-instance handoff and a redelivered queue message all look like
    // this. The script is now empty, so a leak of the idempotency gate would throw.
    // 35-06: the first entry left exactly one event, and the count is captured BEFORE re-entry so
    // the assertion after it is about a delta rather than an absolute.
    const eventsAfterFirst = await agenticAuditEvents(first.job.id);
    expect(eventsAfterFirst).toHaveLength(1);

    const second = await runPhase(repo, 'agentic_context');
    expect(second.result).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.verifierCalls.length).toBe(callsAfterFirst);
    expect(mocks.fileContentCalls.length).toBe(fetchesAfterFirst);
    // Byte-identical blob: re-entry neither re-gathers nor rewrites.
    expect(await env.APP_KV.get(agenticContextCacheKey(second.job.id), 'text')).toBe(blobAfterFirst);

    // 35-06: re-entry emits ZERO additional events. A second event would double-count every metric
    // the flywheel reads — hops, files, greps and bytes would all report roughly twice the truth for
    // any job that was ever redelivered, retried or handed a fresh instance.
    const eventsAfterSecond = await agenticAuditEvents(second.job.id);
    expect(eventsAfterSecond).toHaveLength(1);
    expect(eventsAfterSecond).toEqual(eventsAfterFirst);
  });

  // ── D-11 fail-open ──────────────────────────────────────────────────────────────────────────

  it('D-11: a callVerifierRaw rejection on hop 3 still advances to review, does not fail the job, and persists what hops 1-2 gathered', async () => {
    const repo = `repo-ag-failopen-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.fileContents.set('src/a.ts', 'export const AAA_MARKER = 1;\n');
    mocks.fileContents.set('src/b.ts', 'export const BBB_MARKER = 2;\n');
    mocks.verifierScript.push(
      readFileAction('src/a.ts'),
      readFileAction('src/b.ts'),
      new Error('provider exploded on hop 3'),
    );

    await runPrepare(repo);
    const { job, result } = await runPhase(repo, 'agentic_context');

    // Fail OPEN: the pass is advisory, so a provider failure hands off to the review that does the
    // actual work rather than terminal-failing it.
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.verifierCalls).toHaveLength(3);
    const detail = await getJobDetail(env, job.id);
    expect(detail?.status).not.toBe('failed');

    const blob = await readBlob(job.id);
    expect(blob).not.toBeNull();
    expect(blob!.stopReason).toBe('model_call_failed');
    // Everything gathered BEFORE the failure survives — a transient provider failure costs the
    // remaining hops, never the context already in hand.
    expect(blob!.context).toContain('AAA_MARKER');
    expect(blob!.context).toContain('BBB_MARKER');
    expect(blob!.filesRead).toBe(2);
    expect(blob!.hopsUsed).toBe(2);

    // 35-06: `partial`, NOT `failed`. The distinction is the whole point of the status axis —
    // 35-AI-SPEC.md §7 alerts on `status: 'failed' > 5%` and deliberately does not alert on
    // `partial`, because fail-open that still delivered context is the design working.
    const event = await theLoopExitAuditEvent(job.id);
    expect(event.status).toBe('partial');
    expect(event.reason).toBe('model_call_failed');
    expect(event.hops_used).toBe(2);
    expect(event.files_read).toBe(2);
    expect(event.bytes_gathered).toBeGreaterThan(0);
  });

  // CR-02 (35-REVIEW.md) + IN-07. `GitHubClient.getRepoFileOrNull` returns null ONLY on 404 and
  // THROWS on everything else — including a 200 whose payload has no string `content`, which is what
  // the contents API returns for a DIRECTORY. A GitHubError is not a NextPhaseError, not
  // `isRetryableModelError` and not `isSubrequestBudgetError`, so before the fix it fell through
  // `runReviewJob`'s outer catch to `failJobAndCheckRun`: the model asking to read a directory —
  // ordinary exploratory behaviour — terminally failed the review and marked the check run failed,
  // which is strictly a regression against the same PR with the toggle OFF.
  it('CR-02 / D-11: a read_file provider throw is reported to the model, the loop continues, and the job still advances to review', async () => {
    const repo = `repo-ag-toolthrow-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    // The directory case, verbatim from core/github.ts:500-507.
    mocks.fileContentErrors.set('src/server/core', 'GitHub repo file fetch succeeded but content is not a string');
    mocks.fileContents.set('src/after.ts', 'export const AFTER_MARKER = 1;\n');
    mocks.verifierScript.push(
      readFileAction('src/server/core'),
      readFileAction('src/after.ts'),
      doneAction(),
    );

    await runPrepare(repo);
    const { job, result } = await runPhase(repo, 'agentic_context');

    // The phase is ADVISORY: it hands off, it does not fail the job or the check run.
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    const detail = await getJobDetail(env, job.id);
    expect(detail?.status).not.toBe('failed');

    // The failure consumed its hop and the loop KEPT GOING, so the later read still happened.
    expect(mocks.verifierCalls).toHaveLength(3);
    expect(mocks.fileContentCalls.map((call) => call.path)).toEqual(['src/server/core', 'src/after.ts']);

    const blob = await readBlob(job.id);
    expect(blob).not.toBeNull();
    expect(blob!.stopReason).toBe('done');
    expect(blob!.context).toContain('this read_file call failed');
    expect(blob!.context).toContain('AFTER_MARKER');

    // Gathered context plus a clean exit is `completed`, not `failed`: nothing about this run is an
    // incident, and 35-AI-SPEC.md §7 alerts on `status: 'failed' > 5%`.
    const event = await theLoopExitAuditEvent(job.id);
    expect(event.status).toBe('completed');
    expect(event.bytes_gathered).toBeGreaterThan(0);
  });

  it('CR-02 / D-11: a seed-read failure records a REDACTED failed audit event and still advances to review', async () => {
    // The other half of CR-02: `vcs.getPullRequest` / `getJobDiffFiles` run BEFORE the loop and were
    // also unguarded. This drives the phase-level handler in review.ts rather than the loop's own.
    const repo = `repo-ag-seedthrow-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    await runPrepare(repo);
    mocks.getPullRequestDiff.mockImplementation(() => {
      throw new Error('GitHub diff fetch failed with 502: upstream connect error');
    });

    const { job, result } = await runPhase(repo, 'agentic_context');

    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    const detail = await getJobDetail(env, job.id);
    expect(detail?.status).not.toBe('failed');
    // Nothing was gathered, so nothing is persisted — an empty blob would satisfy the D-12 gate on
    // re-entry while carrying no context.
    expect(await readBlob(job.id)).toBeNull();
    expect(mocks.verifierCalls).toHaveLength(0);

    // The reason is a CLOSED machine token from redactErrorMessage, never the provider's message —
    // this is the first error-driven producer for the event and the reason MACHINE_ERROR_REASONS is
    // part of AGENTIC_CONTEXT_AUDIT_REASONS at all.
    const event = await theAgenticAuditEvent(job.id);
    expect(event.status).toBe('failed');
    expect(['provider_5xx', 'model_transient', 'model_timeout', 'network_reset', 'unknown']).toContain(event.reason);
    expect(JSON.stringify(event)).not.toContain('upstream connect error');
  });

  it('D-11 / T-35-04: a drained subrequest budget stops the loop before hop 1 — zero model calls, zero fetches, no thrown error, still advances to review', async () => {
    const repo = `repo-ag-budget-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);

    await runPrepare(repo);
    // The phase's seed calls vcs.getPullRequest BEFORE the loop. Charging that one call 30
    // subrequests drives remainingSafeBudget() (25 on a fresh invocation) to 0, so the loop's very
    // first `hasBudget(AGENTIC_BUDGET_RESERVE)` check fails. No script is provided: a leak throws.
    mocks.subrequestsPerGetPullRequest = 30;
    const { job, result } = await runPhase(repo, 'agentic_context');
    mocks.subrequestsPerGetPullRequest = 1;

    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.verifierCalls).toEqual([]);
    expect(mocks.fileContentCalls).toEqual([]);
    // The tracker the loop consulted really was drained — this is the mechanism, not a coincidence.
    expect(mocks.trackers.length).toBeGreaterThan(0);
    expect(mocks.trackers[mocks.trackers.length - 1].remainingSafeBudget()).toBe(0);
    // Nothing gathered, so nothing is persisted: an empty blob would satisfy the idempotency gate on
    // re-entry while carrying nothing, permanently stranding this job on a context-free review.
    expect(await env.APP_KV.get(agenticContextCacheKey(job.id), 'text')).toBeNull();

    // 35-06: `failed` — a fail-open exit that yielded NOTHING. §7 alerts on `budget_exhausted` above
    // 10% of enabled runs because it means AGENTIC_BUDGET_RESERVE is mis-sized or the phase is not
    // getting a fresh invocation, and the reason token is what that query matches on.
    const event = await theLoopExitAuditEvent(job.id);
    expect(event.status).toBe('failed');
    expect(event.reason).toBe('budget_exhausted');
    expect(event.hops_used).toBe(0);
    expect(event.bytes_gathered).toBe(0);
    // The headroom really is on the floor — the number §7's `< 2` alert reads, at its worst value,
    // and a present zero rather than an omitted field.
    expect(event.budget_headroom).toBe(0);
  });

  // ── FR-131 no-content fallback (ROADMAP success criterion 4) + the positive control ──────────

  it('FR-131 fallback: a loop that gathers nothing leaves no KV key, and the review proceeds as a single call per file with NO agentic section in the prompt', async () => {
    const repo = `repo-ag-nocontent-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    // The model terminates on hop 1 having gathered nothing.
    mocks.verifierScript.push(doneAction('nothing needed'));

    await runPrepare(repo);
    const { job, result } = await runPhase(repo, 'agentic_context');
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.verifierCalls).toHaveLength(1);
    expect(mocks.fileContentCalls).toEqual([]);
    // No blob at all: FR-131's own documented fallback is "review the diff alone".
    expect(await env.APP_KV.get(agenticContextCacheKey(job.id), 'text')).toBeNull();

    const reviewResult = await runReviewUntilFinalize(repo);
    expect(reviewResult).toMatchObject({ action: 'next_phase', phase: 'finalize' });
    // One review call for the one reviewable file — no extra pass, no retry.
    expect(mocks.reviewFileCalls.map((call) => call.path)).toEqual(['src/x.ts']);
    expect(mocks.reviewFileCalls[0].agenticContext).toBeUndefined();
    expect(mocks.reviewFileCalls[0].userPrompt).not.toContain(UNTRUSTED_AGENTIC_BEGIN);
    expect(mocks.reviewFileCalls[0].userPrompt).not.toContain(UNTRUSTED_AGENTIC_END);

    // 35-06: `skipped` with the no-content token. The model terminated by its own decision, so this
    // is NOT a fail-open — FR-131's documented fallback ("review the diff alone") working, not a
    // malfunction, and `failed` here would put the run in §7's page-worthy bucket.
    const event = await theLoopExitAuditEvent(job.id);
    expect(event.status).toBe('skipped');
    expect(event.reason).toBe('no_content');
    // The counts are PRESENT zeroes, not omitted: `bytes_gathered == 0 && hops_used >= 2` is the
    // FM-5 detector §7 samples at 100%, and it cannot fire on a field that was never written.
    expect(event.hops_used).toBe(1);
    expect(event.files_read).toBe(0);
    expect(event.greps_run).toBe(0);
    expect(event.bytes_gathered).toBe(0);
  });

  // ── 35-06: the D-05 capability signal and the T-35-19 never-fail-the-job contract ────────────

  it('35-06 / D-05: a run whose code search returns null records grep_supported: false', async () => {
    const repo = `repo-ag-grepnull-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    // The three-valued seam's null arm: rate-limited on GitHub (35-03), and the permanent steady
    // state on Bitbucket (35-04, where the token class cannot call the endpoint at all).
    mocks.searchCodeResult = null;
    mocks.fileContents.set('src/after-grep.ts', 'export const AFTER_GREP = 1;\n');
    mocks.verifierScript.push(
      grepAction('authenticateUser'),
      readFileAction('src/after-grep.ts'),
      doneAction(),
    );

    await runPrepare(repo);
    const { job, result } = await runPhase(repo, 'agentic_context');
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.searchCodeCalls).toHaveLength(1);

    const event = await theLoopExitAuditEvent(job.id);
    // FALSE, and rendered as such — this single boolean is the entire D-05 degradation signal, and
    // §7 reads it with a provider split: any occurrence on GitHub is a real signal, while on
    // Bitbucket it is the documented expected steady state that must NOT alert.
    expect(event.grep_supported).toBe(false);
    expect(event.greps_run).toBe(1);
    // The run still succeeded via read_file: a lost capability degrades the pass, it does not end it.
    expect(event.status).toBe('completed');
    expect(event.files_read).toBe(1);
  });

  it('35-06 / T-35-19: a failing audit append does not fail the job — the phase still hands off', async () => {
    const repo = `repo-ag-auditfail-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.fileContents.set('src/audit-fail.ts', 'export const AUDIT_FAIL = 1;\n');
    mocks.verifierScript.push(readFileAction('src/audit-fail.ts'), doneAction());

    await runPrepare(repo);
    // The recorder is best-effort by contract. This forces the exact failure the contract is about:
    // a phase whose entire promise is that it cannot fail the job must not be broken by the
    // telemetry added to watch it.
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));

    const { job, result } = await runPhase(repo, 'agentic_context');
    expect(appendSpy).toHaveBeenCalled();
    appendSpy.mockRestore();

    // Handed off normally, and the gathered context still reached KV — the audit failure cost the
    // trace and nothing else.
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    const detail = await getJobDetail(env, job.id);
    expect(detail?.status).not.toBe('failed');
    const blob = await readBlob(job.id);
    expect(blob).not.toBeNull();
    expect(blob!.context).toContain('AUDIT_FAIL');
    // The event genuinely did not land, so this is not a vacuous pass.
    expect(await agenticAuditEvents(job.id)).toHaveLength(0);

    const reviewResult = await runReviewUntilFinalize(repo);
    expect(reviewResult).toMatchObject({ action: 'next_phase', phase: 'finalize' });
  });

  it('D-10: a successful loop’s gathered content reaches the review prompt for every reviewed file, between the agentic-context sentinels', async () => {
    const repo = `repo-ag-prompt-${Date.now()}`;
    await seedRepoWithAgenticToggle(repo, true);
    mocks.getPullRequestDiff.mockImplementation(() =>
      generateMockDiff([
        { path: 'src/one.ts', content: 'one' },
        { path: 'src/two.ts', content: 'two' },
      ]),
    );
    mocks.fileContents.set('src/context.ts', 'export const GATHERED_MARKER = "gathered-marker";\n');
    mocks.verifierScript.push(readFileAction('src/context.ts'), doneAction());

    await runPrepare(repo);
    const { job, result } = await runPhase(repo, 'agentic_context');
    expect(result).toMatchObject({ action: 'next_phase', phase: 'review' });
    const blob = await readBlob(job.id);
    expect(blob).not.toBeNull();

    const reviewResult = await runReviewUntilFinalize(repo);
    expect(reviewResult).toMatchObject({ action: 'next_phase', phase: 'finalize' });

    const reviewedPaths = mocks.reviewFileCalls.map((call) => call.path).sort();
    expect(reviewedPaths).toEqual(['src/one.ts', 'src/two.ts']);
    for (const call of mocks.reviewFileCalls) {
      // ONE job-scoped blob, identical for every file (not a per-path map).
      expect(call.agenticContext).toBe(blob!.context);
      const begin = call.userPrompt.indexOf(UNTRUSTED_AGENTIC_BEGIN);
      const end = call.userPrompt.indexOf(UNTRUSTED_AGENTIC_END);
      expect(begin).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(begin);
      const fenced = call.userPrompt.slice(begin, end);
      expect(fenced).toContain('GATHERED_MARKER');
      expect(fenced).toContain(HEAD_SHA);
    }
  });
});
