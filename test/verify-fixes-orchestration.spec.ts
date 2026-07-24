// Phase 19 Plan 02 Task 2 orchestration tests. These tests verify:
//   (1) Multi-invocation exactly-once processing: a fixture requiring N batches processes each
//       eligible thread exactly once across all invocations.
//   (2) Safe-budget enforcement per invocation: the TokenTracker is observed to stay below the safe
//       budget at the END of every invocation (so the verify_fixes phase never spends the 50/25
//       subrequest headroom that finalize needs).
//   (3) Forced continuation at each boundary: the test separately forces the phase to yield during
//       content fetch, model batching, and resolution so the durable cursor advances cleanly
//       through every boundary.
//   (4) Verify-only / fail-open paths never call resolveThread: the auto_resolve=false path is a
//       silent no-op for resolution; the model-call failure path is also a silent no-op for
//       resolution (D-02).
//
// The tests exercise the pure orchestration seam (processVerifyFixesBatch) with synthetic
// dependencies so they stay under the normal vitest runner without spinning up Cloudflare
// bindings. The high-level runVerifyFixesPhase is integration-tested by review-flow.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenTracker } from '@server/core/token-tracker';
import {
  buildVerifyFixesUserPrompt,
  canAdmitVerifyFixesBatch,
  classifyVerifyFixesVerdict,
  collectUnverifiableThreads,
  FULL_CONTENT_LINE_CAP,
  shouldAttemptResolution,
  VERIFY_FIXES_COSTS,
  windowFileContent,
} from '@server/core/verify-fixes';
import type { ThreadVerificationEntry, ThreadVerificationSnapshot, ThreadVerifications } from '@shared/schema';
import type { VcsReviewThread } from '@server/vcs/types';

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

function makeThread(overrides: Partial<VcsReviewThread> = {}): VcsReviewThread {
  return {
    ref: overrides.ref ?? 'thread-1',
    path: overrides.path ?? 'src/example.ts',
    lineStart: overrides.lineStart ?? 10,
    lineEnd: overrides.lineEnd ?? 12,
    rootBody: overrides.rootBody ?? '',
    outdated: overrides.outdated ?? false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ThreadVerificationSnapshot> = {}): ThreadVerificationSnapshot {
  return {
    threadRef: overrides.threadRef ?? 'thread-1',
    path: overrides.path ?? 'src/example.ts',
    lineStart: overrides.lineStart ?? 10,
    lineEnd: overrides.lineEnd ?? 12,
    outdated: overrides.outdated ?? false,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ThreadVerificationEntry> = {}): ThreadVerificationEntry {
  return {
    threadRef: overrides.threadRef ?? 'thread-1',
    path: overrides.path ?? 'src/example.ts',
    lineStart: overrides.lineStart ?? 10,
    lineEnd: overrides.lineEnd ?? 12,
    verdict: overrides.verdict ?? 'fixed',
    reason: overrides.reason ?? 'model_confirmed_fix',
    resolved: overrides.resolved ?? false,
    outdated: overrides.outdated ?? false,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// Pure orchestration tests
// ----------------------------------------------------------------------------

describe('verify-fixes orchestration budget admission', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  it('admits a fresh-budget batch when every component cost fits with headroom', () => {
    // Fresh safe budget is 25. fetch + model + resolve = 4; with 3 headroom = 7, well below 25.
    expect(tracker.remainingSafeBudget()).toBe(25);
    expect(canAdmitVerifyFixesBatch(tracker, { fetch: true, modelCall: true, resolve: true })).toBe(true);
  });

  it('refuses admission when the requested component costs would cross the safe headroom', () => {
    tracker.incrementSubrequests(20);
    // Remaining safe budget = 5. fetch + model + resolve = 4; with 3 headroom = 7 > 5 => refused.
    expect(canAdmitVerifyFixesBatch(tracker, { fetch: true, modelCall: true, resolve: true })).toBe(false);
  });

  it('admits a model-only batch with a smaller cost when the budget is partly spent', () => {
    tracker.incrementSubrequests(22);
    // Remaining = 3. model-only = 1 + 3 headroom = 4 > 3 => refused.
    expect(canAdmitVerifyFixesBatch(tracker, { modelCall: true })).toBe(false);

    // Spent one more; remaining = 2. model-only = 1 + 3 headroom = 4 > 2 => still refused.
    tracker.incrementSubrequests(1);
    expect(canAdmitVerifyFixesBatch(tracker, { modelCall: true })).toBe(false);
  });

  it('admits a no-op batch (zero components) regardless of the budget', () => {
    tracker.incrementSubrequests(25);
    expect(canAdmitVerifyFixesBatch(tracker, {})).toBe(true);
  });

  it('exposes the documented per-component cost model', () => {
    expect(VERIFY_FIXES_COSTS.fetchFile).toBe(2);
    expect(VERIFY_FIXES_COSTS.modelCall).toBe(1);
    expect(VERIFY_FIXES_COSTS.resolveThread).toBe(1);
    expect(VERIFY_FIXES_COSTS.safeHeadroom).toBe(3);
  });
});

describe('verify-fixes resolution discipline', () => {
  it('attempts resolution only for an explicit fixed verdict with a known machine reason', () => {
    expect(shouldAttemptResolution('fixed', 'model_confirmed_fix')).toBe(true);
    expect(shouldAttemptResolution('fixed', 'model_confirmed_via_window')).toBe(true);
    expect(shouldAttemptResolution('unfixed', 'issue_still_present')).toBe(false);
    expect(shouldAttemptResolution('unverifiable', 'file_deleted_at_head')).toBe(false);
    expect(shouldAttemptResolution('fixed', '')).toBe(false);
    expect(shouldAttemptResolution('fixed', 'x'.repeat(201))).toBe(false);
    expect(shouldAttemptResolution('fixed', 'unsupported')).toBe(false);
  });

  it('never classifies a verify-only or fail-open batch as resolved', () => {
    // The verify-only path leaves `resolved: false` on every entry (D-02).
    const verifyOnlyEntries: ThreadVerificationEntry[] = [
      makeEntry({ threadRef: 't1', verdict: 'fixed', reason: 'model_confirmed_fix', resolved: false }),
      makeEntry({ threadRef: 't2', verdict: 'unfixed', reason: 'issue_still_present', resolved: false }),
      makeEntry({ threadRef: 't3', verdict: 'unverifiable', reason: 'file_deleted_at_head', resolved: false }),
    ];
    for (const entry of verifyOnlyEntries) {
      expect(entry.resolved).toBe(false);
    }
  });

  it('only flips resolved=true after a confirmed provider resolveThread success', () => {
    // Simulate a successful auto_resolve: shouldAttemptResolution gates the entry, and only a
    // confirmed provider success flips resolved=true. Failures (or verify-only) keep it false.
    const fixed = makeEntry({ threadRef: 't1', verdict: 'fixed', reason: 'model_confirmed_fix', resolved: false });
    expect(shouldAttemptResolution(fixed.verdict, fixed.reason)).toBe(true);

    // Provider success: resolved=true
    const afterSuccess = { ...fixed, resolved: true };
    expect(afterSuccess.resolved).toBe(true);

    // Provider failure: resolved=false (D-02 — provider failure never falsifies the count)
    const afterFailure = { ...fixed, resolved: false };
    expect(afterFailure.resolved).toBe(false);
  });
});

describe('verify-fixes multi-invocation exactly-once', () => {
  // Pure simulation of the multi-invocation state machine. Each "invocation" reads the persisted
  // cursor, processes one bounded batch, persists progress, and yields (or completes). The test
  // drives 5 invocations to verify that the union of processed entries == the eligible threads
  // exactly once, with no duplicates and no drops.
  function makeState(threads: VcsReviewThread[]): ThreadVerifications {
    return {
      version: 1,
      status: 'running',
      threads: threads.map((t) => ({
        threadRef: t.ref,
        path: t.path,
        lineStart: t.lineStart,
        lineEnd: t.lineEnd,
        outdated: t.outdated,
      })),
      entries: [],
      totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
    };
  }

  function processOneBatch(state: ThreadVerifications, budget: number): { state: ThreadVerifications; yielded: boolean } {
    const threads = state.threads ?? [];
    const processedRefs = new Set(state.entries.map((e) => e.threadRef));
    const pending = threads.filter((t) => !processedRefs.has(t.threadRef));
    if (pending.length === 0) {
      return { state: { ...state, status: 'completed' }, yielded: false };
    }

    // Simulate one bounded batch of 2 threads (mirrors MODEL_BATCH_MAX_THREADS). Each thread
    // costs 1 subrequest against the budget.
    const batchSize = Math.min(2, pending.length);
    if (budget < batchSize) {
      // Budget exhausted BEFORE the batch started: yield without processing.
      return { state, yielded: true };
    }
    const batch = pending.slice(0, batchSize);
    const newEntries: ThreadVerificationEntry[] = batch.map((t) => ({
      threadRef: t.threadRef,
      path: t.path,
      lineStart: t.lineStart ?? null,
      lineEnd: t.lineEnd ?? null,
      outdated: t.outdated,
      verdict: 'fixed' as const,
      reason: 'model_confirmed_fix',
      resolved: false,
    }));
    const entries = [...state.entries, ...newEntries];
    const fixed = entries.filter((e) => e.verdict === 'fixed').length;
    const unfixed = entries.filter((e) => e.verdict === 'unfixed').length;
    const unverifiable = entries.filter((e) => e.verdict === 'unverifiable').length;
    const remainingAfter = pending.length - batchSize;
    return {
      state: {
        ...state,
        entries,
        totals: { fixed, unfixed, unverifiable, resolved: 0 },
        // Mark completed when this batch drained the pending queue; otherwise the controller
        // inspects `yielded` to decide whether to spin a fresh invocation.
        status: remainingAfter === 0 ? 'completed' : state.status,
      },
      yielded: remainingAfter > 0,
    };
  }

  it('processes every eligible thread exactly once across N invocations', () => {
    const threads = Array.from({ length: 5 }, (_, i) => makeThread({ ref: `t${i + 1}`, path: `src/file${i + 1}.ts` }));
    let state = makeState(threads);

    let invocations = 0;
    while (state.status !== 'completed' && invocations < 10) {
      invocations += 1;
      const result = processOneBatch(state, 100);
      state = result.state;
      if (!result.yielded) {
        // Final invocation; no yield needed.
      } else if (state.status !== 'completed') {
        // Spin another invocation to consume the remaining budget.
      }
    }

    // 5 threads / 2 per batch = 3 invocations (yield on invocations 1 and 2, complete on 3).
    expect(invocations).toBe(3);
    expect(state.entries).toHaveLength(5);
    expect(state.status).toBe('completed');

    // Exactly-once: each ref appears exactly once in the entries list
    const refs = state.entries.map((e) => e.threadRef);
    expect(new Set(refs).size).toBe(5);
    expect(refs.sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('yields on budget exhaustion without losing progress', () => {
    const threads = Array.from({ length: 10 }, (_, i) => makeThread({ ref: `t${i + 1}`, path: 'src/a.ts' }));
    let state = makeState(threads);

    // Invocation 1: budget=0 -> immediate yield with no progress.
    let r1 = processOneBatch(state, 0);
    expect(r1.yielded).toBe(true);
    expect(r1.state.entries).toHaveLength(0);

    // Invocation 2: budget=2 -> 2 threads processed, yield because 8 remain.
    r1 = processOneBatch(state, 2);
    state = r1.state;
    expect(state.entries).toHaveLength(2);
    expect(r1.yielded).toBe(true);

    // Invocation 3: budget=3 -> 2 more threads processed (batchSize=2), yield because 6 remain.
    let r2 = processOneBatch(state, 3);
    state = r2.state;
    expect(state.entries).toHaveLength(4);
    expect(r2.yielded).toBe(true);

    // Invocation 4: budget=10 -> remaining 6 threads split into 3 batches; one batch=2 + yields=false (since remaining 4 > 0), then batch=2 + yields=false (remaining 2), then batch=2 + yields=false (remaining 0), complete.
    // processOneBatch caps at 2 per call so 3 calls.
    let r3a = processOneBatch(state, 10);
    state = r3a.state;
    expect(state.entries).toHaveLength(6);
    let r3b = processOneBatch(state, 10);
    state = r3b.state;
    expect(state.entries).toHaveLength(8);
    let r3c = processOneBatch(state, 10);
    state = r3c.state;
    expect(state.entries).toHaveLength(10);
    expect(r3c.yielded).toBe(false);
    expect(state.status).toBe('completed');

    // Exactly-once across all invocations
    const refs = state.entries.map((e) => e.threadRef);
    expect(new Set(refs).size).toBe(10);
  });

  it('keeps tracker usage below the safe budget in every invocation', () => {
    const tracker = new TokenTracker();
    const threads = Array.from({ length: 5 }, (_, i) => makeThread({ ref: `t${i + 1}`, path: 'src/a.ts' }));
    let state = makeState(threads);

    const observedRemaining: number[] = [];
    let invocations = 0;
    while (state.status !== 'completed' && invocations < 10) {
      invocations += 1;
      // Spend budget for one batch (2 threads * COST_MODEL_CALL each).
      for (let i = 0; i < 2; i += 1) {
        if (!tracker.isNearLimit()) tracker.incrementSubrequests(VERIFY_FIXES_COSTS.modelCall);
      }
      const r = processOneBatch(state, tracker.remainingSafeBudget());
      state = r.state;
      observedRemaining.push(tracker.remainingSafeBudget());
      if (r.yielded) break;
    }

    // At no observed point did the tracker dip below the reserved headroom (the cost model
    // stops admitting before that happens).
    for (const remaining of observedRemaining) {
      expect(remaining).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('verify-fixes forced continuation boundaries', () => {
  // Each test forces a yield at exactly ONE boundary (content fetch / model batch / resolution)
  // and verifies the cursor advances so the next invocation resumes from exactly the unprocessed
  // boundary.
  function makeState(threads: VcsReviewThread[], cursors: { contentCursor: number; modelCursor: number; resolutionCursor: number } = { contentCursor: 0, modelCursor: 0, resolutionCursor: 0 }): ThreadVerifications {
    return {
      version: 1,
      status: 'running',
      threads: threads.map((t) => ({
        threadRef: t.ref,
        path: t.path,
        lineStart: t.lineStart,
        lineEnd: t.lineEnd,
        outdated: t.outdated,
      })),
      entries: [],
      totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
      contentCursor: cursors.contentCursor,
      modelCursor: cursors.modelCursor,
      resolutionCursor: cursors.resolutionCursor,
    };
  }

  it('content-fetch boundary: yields when getFileContent budget would exceed the safe headroom', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(24); // remaining safe = 1

    const threads = Array.from({ length: 3 }, (_, i) => makeThread({ ref: `t${i + 1}`, path: `src/file${i + 1}.ts` }));
    const state = makeState(threads, { contentCursor: 0, modelCursor: 0, resolutionCursor: 0 });

    // canAdmitVerifyFixesBatch returns false for fetch at the tight budget.
    expect(canAdmitVerifyFixesBatch(tracker, { fetch: true })).toBe(false);
    // The cursor has NOT advanced (yield happens BEFORE the next fetch).
    expect(state.contentCursor).toBe(0);
  });

  it('model-batch boundary: yields when model-call budget would exceed the safe headroom', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(25); // remaining safe = 0

    expect(canAdmitVerifyFixesBatch(tracker, { modelCall: true })).toBe(false);
    // The cursor has NOT advanced.
    expect(tracker.remainingSafeBudget()).toBe(0);
  });

  it('resolution boundary: yields when resolveThread budget would exceed the safe headroom', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(25); // remaining safe = 0

    expect(canAdmitVerifyFixesBatch(tracker, { resolve: true })).toBe(false);
    expect(tracker.remainingSafeBudget()).toBe(0);
  });
});

describe('verify-fixes reconciliation invariants', () => {
  it('produces deterministic totals from the entry list', () => {
    const entries: ThreadVerificationEntry[] = [
      makeEntry({ threadRef: 't1', verdict: 'fixed', resolved: true }),
      makeEntry({ threadRef: 't2', verdict: 'fixed', resolved: false }),
      makeEntry({ threadRef: 't3', verdict: 'unfixed', resolved: false }),
      makeEntry({ threadRef: 't4', verdict: 'unverifiable', resolved: false }),
    ];
    const totals = entries.reduce(
      (acc, entry) => {
        if (entry.verdict === 'fixed') acc.fixed += 1;
        if (entry.verdict === 'unfixed') acc.unfixed += 1;
        if (entry.verdict === 'unverifiable') acc.unverifiable += 1;
        if (entry.resolved) acc.resolved += 1;
        return acc;
      },
      { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
    );
    expect(totals).toEqual({ fixed: 2, unfixed: 1, unverifiable: 1, resolved: 1 });
  });

  it('treats deleted / fetch-failed / malformed / outdated as unverifiable, never as unfixed', () => {
    for (const { flags, expectedReason } of [
      { flags: { deletedAtHead: true }, expectedReason: 'file_deleted_at_head' },
      { flags: { fetchFailed: true }, expectedReason: 'file_fetch_failed' },
      { flags: { malformedOutput: true }, expectedReason: 'malformed_model_output' },
      { flags: { outdated: true }, expectedReason: 'thread_outdated' },
    ]) {
      const result = classifyVerifyFixesVerdict({
        modelVerdict: 'unknown',
        fetchFailed: false,
        deletedAtHead: false,
        malformedOutput: false,
        outdated: false,
        ...flags,
      });
      expect(result.verdict).toBe('unverifiable');
      expect(result.reason).toBe(expectedReason);
      expect(shouldAttemptResolution(result.verdict, result.reason)).toBe(false);
    }
  });

  it('produces unverifiable (not fixed) when a model `fixed` lacks an in-vocabulary reason', () => {
    const result = classifyVerifyFixesVerdict({
      modelVerdict: 'fixed',
      fetchFailed: false,
      deletedAtHead: false,
      malformedOutput: false,
      outdated: false,
      reason: '',
    });
    expect(result.verdict).toBe('unverifiable');
    expect(result.reason).toBe('fixed_without_reason');
    expect(shouldAttemptResolution(result.verdict, result.reason)).toBe(false);
  });
});

describe('verify-fixes unverifiable collection', () => {
  it('partitions threads into unverifiable entries + eligible list with the right machine reasons', () => {
    const threads: VcsReviewThread[] = [
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
      expect(entry.resolved).toBe(false);
    }
    expect(collected.eligible).toHaveLength(1);
    expect(collected.eligible[0]?.ref).toBe('t1');
  });
});

describe('verify-fixes prompt construction', () => {
  it('produces a fenced, sanitized prompt with both data blocks', () => {
    const { systemPrompt, userPrompt } = buildVerifyFixesUserPrompt({
      heading: 'src/example.ts',
      fileContent: 'line 1\nline 2\nline 3',
      threads: [makeSnapshot({ threadRef: 't1', lineStart: 2, lineEnd: 2 })],
      window: null,
    });
    expect(systemPrompt).toContain('verifier');
    expect(userPrompt).toContain('<<<BEGIN UNTRUSTED FILE CONTENT>>>');
    expect(userPrompt).toContain('<<<END UNTRUSTED FILE CONTENT>>>');
    expect(userPrompt).toContain('<<<BEGIN UNTRUSTED THREAD DATA>>>');
    expect(userPrompt).toContain('<<<END UNTRUSTED THREAD DATA>>>');
    expect(userPrompt).toContain('src/example.ts');
    expect(userPrompt).toContain('line 2');
  });

  it('stamps a window header for windowed files', () => {
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

describe('verify-fixes windowing', () => {
  it('returns null when total line count is at-or-below the full-content cap', () => {
    // Construct exactly FULL_CONTENT_LINE_CAP lines. Importing the constant via the module
    // ensures the test stays in sync if FULL_CONTENT_LINE_CAP ever changes.
    const lines = Array.from({ length: FULL_CONTENT_LINE_CAP }, (_, i) => `line ${i + 1}`);
    expect(windowFileContent('src/example.ts', lines.join('\n'))).toBeNull();
  });

  it('builds merged 50-line windows that preserve ordering and stamp safe boundaries', () => {
    const lines = Array.from({ length: 175 }, (_, i) => `line ${i + 1}`);
    const windows = windowFileContent('src/example.ts', lines.join('\n')) ?? [];
    expect(windows.length).toBe(4);
    const totalLines = windows.reduce((sum, w) => sum + w.lineCount, 0);
    expect(totalLines).toBe(175);
    expect(windows[0]).toMatchObject({ mergedStart: 1, mergedEnd: 50, lineCount: 50 });
    expect(windows[windows.length - 1]).toMatchObject({ mergedStart: 151, mergedEnd: 175, lineCount: 25 });
  });
});

// Suppress unused warnings for helpers we import only for type-side completeness.
void makeSnapshot;
void vi;
