// Phase 19 verify-fixes (THR-01/THR-02) — pure unit coverage for the windowing, prompt construction,
// and conservative reconciliation helpers. Mirrors the Phase 10 / 14 / 17 plan-level test pattern:
// all helpers are pure, no DB, no fetch, so this file stays under the normal test runner and pins
// every D-01..D-04 edge the cross-AI review surfaced.

import { describe, expect, it, vi } from 'vitest';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { nextPhaseAfterVerifyFixes } from '@server/core/phase-routing';
import type {
  ThreadVerificationEntry,
  ThreadVerificationSnapshot,
  ThreadVerifications,
} from '@shared/schema';
import type { VcsReviewThread } from '@server/vcs/types';
import { NextPhaseError } from '@server/core/next-phase-error';
import {
  buildVerifyFixesUserPrompt,
  classifyVerifyFixesVerdict,
  collectUnverifiableThreads,
  FULL_CONTENT_LINE_CAP,
  runVerifyFixesPhase,
  SAFE_HUNK_LINE_LIMIT,
  shouldAttemptResolution,
  VERIFY_FIXES_UNVERIFIABLE_REASONS,
  WINDOW_LINE_COUNT,
  windowFileContent,
} from '@server/core/verify-fixes';

// The verify-fixes phase's fresh-invocation yield constant (60s) is intentionally not exported
// from core/verify-fixes.ts (it is a private module-level constant). The tests below pin the
// exact value to mirror the runtime behavior -- if the constant is ever retuned, these
// assertions must be updated in lockstep with the constant.
const VERIFY_FIXES_FRESH_INVOCATION_YIELD_SECONDS = 60;

function makeThread(overrides: Partial<VcsReviewThread> = {}): VcsReviewThread {
  return {
    ref: 'thread-ref-1',
    path: 'src/example.ts',
    lineStart: 10,
    lineEnd: 12,
    rootBody: 'Original bot comment',
    outdated: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ThreadVerificationSnapshot> = {}): ThreadVerificationSnapshot {
  return {
    threadRef: 'thread-ref-1',
    path: 'src/example.ts',
    lineStart: 10,
    lineEnd: 12,
    outdated: false,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ThreadVerificationEntry> = {}): ThreadVerificationEntry {
  return {
    threadRef: 'thread-ref-1',
    path: 'src/example.ts',
    lineStart: 10,
    lineEnd: 12,
    verdict: 'fixed',
    reason: 'model_confirmed_fix',
    resolved: false,
    ...overrides,
  };
}

describe('verify-fixes windowing', () => {
  it('returns null when total line count is at-or-below the full-content cap', () => {
    const heading = 'src/example.ts';
    const lines = Array.from({ length: FULL_CONTENT_LINE_CAP }, (_, i) => `line ${i + 1}`);
    expect(windowFileContent(heading, lines.join('\n'))).toBeNull();
  });

  it('returns null when total line count is one below the full-content cap (locked <cap boundary)', () => {
    // Phase 19 Plan 10 (THR-01): the locked requirement is "files at or below 500 lines use full
    // content". This pin captures the strict less-than-cap branch: even at FULL_CONTENT_LINE_CAP - 1
    // lines the verifier sees a single null slice (one full-content pass), not a windowed array.
    const heading = 'src/example.ts';
    const lines = Array.from({ length: FULL_CONTENT_LINE_CAP - 1 }, (_, i) => `line ${i + 1}`);
    expect(windowFileContent(heading, lines.join('\n'))).toBeNull();
  });

  it('returns the rendered full content when file fits within the cap', () => {
    const content = ['line 1', 'line 2', 'line 3'].join('\n');
    expect(windowFileContent('src/example.ts', content)).toBeNull();
  });

  it('builds merged 50-line windows that preserve ordering and stamp safe boundaries', () => {
    const heading = 'src/example.ts';
    // Phase 19 Plan 10 (THR-01): the locked boundary is "<=500 lines full content; larger files
    // windowed into 50-line slices". Build exactly FULL_CONTENT_LINE_CAP + 1 lines so the fixture
    // stays in sync with the constant if it ever changes again; under the locked 500 boundary this
    // yields 11 windows of 50/50/50/50/50/50/50/50/50/50/1 (501 lines total).
    const lines = Array.from({ length: FULL_CONTENT_LINE_CAP + 1 }, (_, i) => `line ${i + 1}`);
    const windows = windowFileContent(heading, lines.join('\n')) ?? [];
    expect(windows.length).toBe(11);
    const totalLines = windows.reduce((sum, window) => sum + window.lineCount, 0);
    expect(totalLines).toBe(FULL_CONTENT_LINE_CAP + 1);
    for (const window of windows) {
      expect(window.lineCount).toBeLessThanOrEqual(WINDOW_LINE_COUNT);
      expect(window.mergedStart).toBeLessThanOrEqual(window.mergedEnd);
    }
    expect(windows[0]).toMatchObject({
      mergedStart: 1,
      mergedEnd: 50,
      lineCount: 50,
    });
    expect(windows[windows.length - 1]).toMatchObject({
      mergedStart: FULL_CONTENT_LINE_CAP + 1,
      mergedEnd: FULL_CONTENT_LINE_CAP + 1,
      lineCount: 1,
    });
  });

  it('caps the size of any single window to SAFE_HUNK_LINE_LIMIT', () => {
    expect(SAFE_HUNK_LINE_LIMIT).toBeGreaterThanOrEqual(WINDOW_LINE_COUNT);
    expect(WINDOW_LINE_COUNT).toBe(50);
  });
});

describe('verify-fixes verdict classification', () => {
  it('treats explicit fixed verdicts as eligible for resolution', () => {
    expect(shouldAttemptResolution('fixed', 'model_confirmed_fix')).toBe(true);
  });

  it('treats unfixed verdicts as ineligible for resolution', () => {
    expect(shouldAttemptResolution('unfixed', 'issue_still_present')).toBe(false);
  });

  it('treats unverifiable verdicts as ineligible for resolution', () => {
    expect(shouldAttemptResolution('unverifiable', 'file_deleted_at_head')).toBe(false);
  });

  it('rejects fixed verdicts with a missing/empty reason', () => {
    expect(shouldAttemptResolution('fixed', '')).toBe(false);
  });

  it('rejects fixed verdicts whose reason is over 200 chars', () => {
    expect(shouldAttemptResolution('fixed', 'x'.repeat(201))).toBe(false);
  });

  it('rejects fixed verdicts whose reason is not a known machine reason', () => {
    expect(shouldAttemptResolution('fixed', 'totally unsupported explanation')).toBe(false);
  });
});

describe('verify-fixes unverifiable reasons', () => {
  it('exposes a bounded, non-empty unverifiable reason vocabulary', () => {
    expect(VERIFY_FIXES_UNVERIFIABLE_REASONS.length).toBeGreaterThan(0);
    for (const reason of VERIFY_FIXES_UNVERIFIABLE_REASONS) {
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.length).toBeLessThanOrEqual(200);
    }
  });

  it('classifies deleted, malformed, fetch-failed, and outdated as unverifiable', () => {
    // Each data-quality flag produces a SPECIFIC machine reason (D-01/D-04). A loop with constant
    // input cannot satisfy `.toEqual({ verdict, reason })` across a multi-element vocabulary -- the
    // function is pure and returns one reason per call. Test each condition with the expected reason
    // and assert the vocabulary contains every emitted reason.
    const cases = [
      { flags: { deletedAtHead: true }, expectedReason: 'file_deleted_at_head' },
      { flags: { fetchFailed: true }, expectedReason: 'file_fetch_failed' },
      { flags: { malformedOutput: true }, expectedReason: 'malformed_model_output' },
      { flags: { outdated: true }, expectedReason: 'thread_outdated' },
    ];
    for (const { flags, expectedReason } of cases) {
      const result = classifyVerifyFixesVerdict({
        modelVerdict: 'unknown',
        fetchFailed: false,
        deletedAtHead: false,
        malformedOutput: false,
        outdated: false,
        ...flags,
      });
      expect(result).toEqual({ verdict: 'unverifiable', reason: expectedReason });
      expect(VERIFY_FIXES_UNVERIFIABLE_REASONS).toContain(result.reason);
    }
  });

  it('uses the explicit fixed verdict when the model returns fixed and the data is sound', () => {
    expect(classifyVerifyFixesVerdict({
      modelVerdict: 'fixed',
      fetchFailed: false,
      deletedAtHead: false,
      malformedOutput: false,
      outdated: false,
      reason: 'model_confirmed_fix',
    })).toEqual({ verdict: 'fixed', reason: 'model_confirmed_fix' });
  });

  it('uses the explicit unfixed verdict when the model returns unfixed and the data is sound', () => {
    expect(classifyVerifyFixesVerdict({
      modelVerdict: 'unfixed',
      fetchFailed: false,
      deletedAtHead: false,
      malformedOutput: false,
      outdated: false,
      reason: 'issue_still_present',
    })).toEqual({ verdict: 'unfixed', reason: 'issue_still_present' });
  });

  it('forces unverifiable when the model fixed verdict lacks a usable reason', () => {
    const result = classifyVerifyFixesVerdict({
      modelVerdict: 'fixed',
      fetchFailed: false,
      deletedAtHead: false,
      malformedOutput: false,
      outdated: false,
      reason: '',
    });
    expect(result.verdict).toBe('unverifiable');
    expect(VERIFY_FIXES_UNVERIFIABLE_REASONS).toContain(result.reason);
  });
});

describe('verify-fixes unverifiable collection', () => {
  it('returns the unverifiable subsets plus machine reasons for each', () => {
    const threads = [
      makeThread({ ref: 't1', path: 'src/a.ts', outdated: false }),
      makeThread({ ref: 't2', path: 'src/deleted.ts', outdated: false }),
      makeThread({ ref: 't3', path: 'src/outdated.ts', outdated: true }),
      makeThread({ ref: 't4', path: 'src/b.ts', outdated: false }),
    ];
    const collected = collectUnverifiableThreads(threads, {
      fetchFailures: new Set(['t4']),
      deletions: new Set(['t2']),
      outdated: new Set(['t3']),
    });
    expect(collected.unverifiable).toHaveLength(3);
    const refs = collected.unverifiable.map((entry) => entry.threadRef).sort();
    expect(refs).toEqual(['t2', 't3', 't4']);
    for (const entry of collected.unverifiable) {
      expect(entry.verdict).toBe('unverifiable');
      expect(VERIFY_FIXES_UNVERIFIABLE_REASONS).toContain(entry.reason);
    }
    expect(collected.eligible).toHaveLength(1);
    expect(collected.eligible[0]?.ref).toBe('t1');
  });

  it('returns all threads as eligible when no threads are unverifiable', () => {
    const threads = [makeThread({ ref: 't1' }), makeThread({ ref: 't2' })];
    const collected = collectUnverifiableThreads(threads, {
      fetchFailures: new Set(),
      deletions: new Set(),
      outdated: new Set(),
    });
    expect(collected.unverifiable).toHaveLength(0);
    expect(collected.eligible).toHaveLength(2);
  });
});

describe('verify-fixes prompt construction', () => {
  it('contains a fenced untrusted file content block and a guard zone explaining the sentinel', () => {
    const { systemPrompt, userPrompt } = buildVerifyFixesUserPrompt({
      heading: 'src/example.ts',
      fileContent: 'line 1\nline 2\nline 3',
      threads: [makeSnapshot({ threadRef: 't1', lineStart: 2, lineEnd: 2 })],
      window: null,
    });
    expect(systemPrompt).toContain('verifier');
    expect(userPrompt).toContain('<<<BEGIN UNTRUSTED FILE CONTENT');
    expect(userPrompt).toContain('<<<END UNTRUSTED FILE CONTENT');
    expect(userPrompt).toContain('<<<BEGIN UNTRUSTED THREAD DATA');
    expect(userPrompt).toContain('<<<END UNTRUSTED THREAD DATA');
    expect(userPrompt).toContain('src/example.ts');
    expect(userPrompt).toContain('line 2');
  });

  it('stamps a window header when given a windowed file', () => {
    const { userPrompt } = buildVerifyFixesUserPrompt({
      heading: 'src/big.ts',
      fileContent: 'line 1\nline 2',
      threads: [makeSnapshot({ threadRef: 't1', lineStart: 1, lineEnd: 1 })],
      window: { mergedStart: 1, mergedEnd: 2, lineCount: 2 },
    });
    expect(userPrompt).toContain('window');
    expect(userPrompt).toContain('lines 1-2');
  });
});

describe('verify-fixes totals reconciliation', () => {
  it('sums verdicts and resolved counts deterministically', () => {
    const entries: ThreadVerificationEntry[] = [
      makeEntry({ threadRef: 't1', verdict: 'fixed', resolved: true }),
      makeEntry({ threadRef: 't2', verdict: 'fixed', resolved: false }),
      makeEntry({ threadRef: 't3', verdict: 'unfixed', resolved: false }),
      makeEntry({ threadRef: 't4', verdict: 'unverifiable', resolved: false }),
    ];
    const totals = entries.reduce((acc, entry) => {
      if (entry.verdict === 'fixed') acc.fixed += 1;
      if (entry.verdict === 'unfixed') acc.unfixed += 1;
      if (entry.verdict === 'unverifiable') acc.unverifiable += 1;
      if (entry.resolved) acc.resolved += 1;
      return acc;
    }, { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 });
    expect(totals).toEqual({ fixed: 2, unfixed: 1, unverifiable: 1, resolved: 1 });
  });
});

describe('verify-fixes cursor shape', () => {
  it('exposes a stable cursor field set with status pending and no entries at creation', () => {
    const cursor: ThreadVerifications = {
      version: 1,
      status: 'pending',
      entries: [],
      totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
    };
    expect(cursor.version).toBe(1);
    expect(cursor.status).toBe('pending');
    expect(cursor.entries).toEqual([]);
    expect(cursor.totals).toEqual({ fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 });
  });
});

// Phase 20.1 (BLOCKER 3): the verify-fixes phase terminal hand-off now routes through the
// `nextPhaseAfterVerifyFixes` selector in `core/phase-routing.ts`. The pure selector is fully
// covered by `test/phase-routing.spec.ts`; this describe block is the smoke evidence that the
// import in `core/verify-fixes.ts` is wired correctly and the four toggle combinations reach
// the expected terminal phase.
describe('verify-fixes terminal hand-off (BLOCKER 3 chain)', () => {
  // Inline copy of the minimal-withToggle helper used in phase-routing.spec.ts — kept here so
  // this file stays self-contained and the review can read each describe block independently.
  const withT = <K extends keyof RepoConfig['review']>(
    config: RepoConfig,
    key: K,
    value: NonNullable<RepoConfig['review'][K]>,
  ): RepoConfig => ({
    ...config,
    review: { ...config.review, [key]: value },
  });
  const verifyFixesOn = (c: RepoConfig) =>
    withT(c, 'threads', { verify_fixes: true, auto_resolve: false });
  const criticOn = (c: RepoConfig) =>
    withT(c, 'passes', { ...c.review.passes, critic: { enabled: true } });
  const walkthroughOn = (c: RepoConfig) =>
    withT(c, 'walkthrough', { enabled: true, sequence_diagram: { enabled: true } });

  it('chains verify_fixes → critic when verify_fixes + critic are on (BLOCKER 3 primary)', () => {
    const config = verifyFixesOn(criticOn(defaultRepoConfig));
    expect(nextPhaseAfterVerifyFixes(config)).toBe('critic');
  });

  it('chains verify_fixes → walkthrough_enrichment when verify_fixes + walkthrough are on (critic off)', () => {
    const config = verifyFixesOn(walkthroughOn(defaultRepoConfig));
    expect(nextPhaseAfterVerifyFixes(config)).toBe('walkthrough_enrichment');
  });

  it('chains verify_fixes → finalize when verify_fixes is on but critic + walkthrough are off', () => {
    const config = verifyFixesOn(defaultRepoConfig);
    expect(nextPhaseAfterVerifyFixes(config)).toBe('finalize');
  });

  it('chains verify_fixes → critic when all three toggles are on (chain order: critic first)', () => {
    const config = verifyFixesOn(criticOn(walkthroughOn(defaultRepoConfig)));
    expect(nextPhaseAfterVerifyFixes(config)).toBe('critic');
  });
});

// Phase 20.1 (BLOCKER 4): the verify-fixes idempotency guard AND the review-rest guard used to
// `return` without scheduling a successor. A crash between the terminal write and the throw left
// the job non-terminal indefinitely. The fix: both guards now schedule a successor via
// markJobContinuationQueued + NextPhaseError, mirroring the canonical successor scheduler at
// core/review.ts:2976-2984 (`enqueueJobPhase`). These tests pin the guard wiring at the
// runVerifyFixesPhase level: they mock markJobContinuationQueued + drive the guard with the
// minimum inputs needed to trigger it, then assert the mark was called + the throw carries the
// expected phase.
//
// The guards fire BEFORE any other DB call, so mocking only markJobContinuationQueued is enough
// to isolate the guard behavior. The other DB writers (setJobThreadVerifications,
// appendJobAuditEvents) are NEVER reached on either guard path -- if a future refactor moves a
// guard after one of those calls, these tests will start failing and the refactor will be
// required to preserve the guard semantics.
const block4Mock = vi.hoisted(() => ({
  markJobContinuationQueued: vi.fn(async () => 1),
}));
vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@server/db/jobs')>();
  return {
    ...mod,
    markJobContinuationQueued: block4Mock.markJobContinuationQueued,
  };
});

describe('verify-fixes terminal guards schedule successor (BLOCKER 4)', () => {
  // Inline withToggle helpers (mirror the BLOCKER 3 block above) so this describe stays self-
  // contained. The combined config builders are reused below.
  const withT = <K extends keyof RepoConfig['review']>(
    config: RepoConfig,
    key: K,
    value: NonNullable<RepoConfig['review'][K]>,
  ): RepoConfig => ({
    ...config,
    review: { ...config.review, [key]: value },
  });
  const verifyFixesOn = (c: RepoConfig) =>
    withT(c, 'threads', { verify_fixes: true, auto_resolve: false });
  const criticOn = (c: RepoConfig) =>
    withT(c, 'passes', { ...c.review.passes, critic: { enabled: true } });
  const walkthroughOn = (c: RepoConfig) =>
    withT(c, 'walkthrough', { enabled: true, sequence_diagram: { enabled: true } });

  // Minimal env stub: only HYPERDRIVE is read by markJobContinuationQueued (and we mock that).
  // The other bindings (REVIEW_QUEUE / APP_KV / etc.) are never touched on a guard path.
  const envStub = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;

  // Lightweight VcsProvider stub: the guards fire before any vcs call, so the methods below are
  // NEVER invoked. If a future refactor moves a guard past the vcs boundary, the vcs stubs would
  // surface a clear failure rather than silently passing.
  const vcsStub = {
    capabilities: { supportsThreadResolution: false },
    async getUnresolvedBotThreads() { return []; },
    async getFileContent() { return null; },
    async resolveThread() { return false; },
  } as any;

  // Lightweight ModelService stub: never invoked on a guard path.
  const modelStub = {
    async callVerifierRaw() {
      throw new Error('verify-fixes guards must not reach the model adapter');
    },
  } as any;

  // Lightweight TokenTracker stub: never invoked on a guard path.
  const trackerStub = {
    remainingSafeBudget() { return 100; },
    incrementSubrequests() { /* no-op */ },
  } as any;

  const makeTerminalJob = (config: RepoConfig, status: 'completed' | 'fail_open'): any => ({
    id: 'job-blocker4-test',
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 1,
    commitSha: 'a'.repeat(40),
    configSnapshot: config,
    reviewScope: 'all' as const,
    threadVerification: {
      version: 1,
      status,
      entries: [],
      totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
    },
  });

  const makeReviewRestJob = (config: RepoConfig): any => ({
    id: 'job-blocker4-test',
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 1,
    commitSha: 'a'.repeat(40),
    configSnapshot: config,
    reviewScope: 'rest' as const,
    threadVerification: null,
  });

  beforeEach(() => {
    block4Mock.markJobContinuationQueued.mockClear();
  });

  it('idempotency guard (status=completed, no critic, no walkthrough) schedules successor=finalize', async () => {
    const config = verifyFixesOn(defaultRepoConfig);
    const job = makeTerminalJob(config, 'completed');

    await expect(
      runVerifyFixesPhase(envStub, job, 'lease-owner', vcsStub, modelStub, trackerStub),
    ).rejects.toBeInstanceOf(NextPhaseError);

    expect(block4Mock.markJobContinuationQueued).toHaveBeenCalledTimes(1);
    expect(block4Mock.markJobContinuationQueued).toHaveBeenCalledWith(
      envStub,
      'job-blocker4-test',
      VERIFY_FIXES_FRESH_INVOCATION_YIELD_SECONDS,
    );

    // The throw's phase must match nextPhaseAfterVerifyFixes(config): with no critic and no
    // walkthrough, the successor is 'finalize'.
    let thrownPhase: string | undefined;
    try {
      await runVerifyFixesPhase(envStub, makeTerminalJob(config, 'completed'), 'lease-owner', vcsStub, modelStub, trackerStub);
    } catch (error) {
      if (error instanceof NextPhaseError) thrownPhase = error.phase;
    }
    expect(thrownPhase).toBe('finalize');
  });

  it('idempotency guard (status=fail_open, critic on) schedules successor=critic', async () => {
    const config = verifyFixesOn(criticOn(defaultRepoConfig));
    const job = makeTerminalJob(config, 'fail_open');

    let thrownPhase: string | undefined;
    try {
      await runVerifyFixesPhase(envStub, job, 'lease-owner', vcsStub, modelStub, trackerStub);
    } catch (error) {
      if (error instanceof NextPhaseError) thrownPhase = error.phase;
    }

    expect(thrownPhase).toBe('critic');
    expect(block4Mock.markJobContinuationQueued).toHaveBeenCalledTimes(1);
  });

  it('idempotency guard (status=completed, critic + walkthrough on) schedules successor=critic (chain order)', async () => {
    const config = verifyFixesOn(criticOn(walkthroughOn(defaultRepoConfig)));
    const job = makeTerminalJob(config, 'completed');

    let thrownPhase: string | undefined;
    try {
      await runVerifyFixesPhase(envStub, job, 'lease-owner', vcsStub, modelStub, trackerStub);
    } catch (error) {
      if (error instanceof NextPhaseError) thrownPhase = error.phase;
    }

    // Chain order: critic runs BEFORE walkthrough, so the successor is critic (not walkthrough).
    expect(thrownPhase).toBe('critic');
    expect(block4Mock.markJobContinuationQueued).toHaveBeenCalledTimes(1);
  });

  it('review-rest guard (verify_fixes on, reviewScope=rest) schedules successor via nextPhaseAfterVerifyFixes', async () => {
    const config = verifyFixesOn(defaultRepoConfig);
    const job = makeReviewRestJob(config);

    let thrownPhase: string | undefined;
    try {
      await runVerifyFixesPhase(envStub, job, 'lease-owner', vcsStub, modelStub, trackerStub);
    } catch (error) {
      if (error instanceof NextPhaseError) thrownPhase = error.phase;
    }

    expect(thrownPhase).toBe('finalize');
    expect(block4Mock.markJobContinuationQueued).toHaveBeenCalledTimes(1);
    expect(block4Mock.markJobContinuationQueued).toHaveBeenCalledWith(
      envStub,
      'job-blocker4-test',
      VERIFY_FIXES_FRESH_INVOCATION_YIELD_SECONDS,
    );
  });

  it('default config (verify_fixes off) returns early without scheduling a successor', async () => {
    // NREG-01 byte-identity: at the v1.2 default config the verify_fixes toggle is OFF, so the
    // verifyEnabled guard at the top of runVerifyFixesPhase returns early. The BLOCKER 4 fix is
    // never exercised -- markJobContinuationQueued is never called and no throw happens.
    const job = makeTerminalJob(defaultRepoConfig, 'completed');

    await expect(
      runVerifyFixesPhase(envStub, job, 'lease-owner', vcsStub, modelStub, trackerStub),
    ).resolves.toBeUndefined();

    expect(block4Mock.markJobContinuationQueued).not.toHaveBeenCalled();
  });

  it('idempotency guard calls markJobContinuationQueued BEFORE throwing NextPhaseError (call order)', async () => {
    // Pin the ordering: the canonical successor scheduler at review.ts:2976-2984 calls
    // markJobContinuationQueued FIRST, then throws NextPhaseError. A future refactor that
    // throws first would risk an unscheduled successor -- this test catches that.
    const config = verifyFixesOn(defaultRepoConfig);
    const callOrder: string[] = [];

    block4Mock.markJobContinuationQueued.mockImplementationOnce(async () => {
      callOrder.push('markJobContinuationQueued');
      return 1;
    });

    const throwingJob = makeTerminalJob(config, 'completed');
    try {
      await runVerifyFixesPhase(envStub, throwingJob, 'lease-owner', vcsStub, modelStub, trackerStub);
    } catch (error) {
      if (error instanceof NextPhaseError) callOrder.push('NextPhaseError');
    }

    expect(callOrder).toEqual(['markJobContinuationQueued', 'NextPhaseError']);
  });
});

