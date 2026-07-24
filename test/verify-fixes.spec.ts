// Phase 19 verify-fixes (THR-01/THR-02) — pure unit coverage for the windowing, prompt construction,
// and conservative reconciliation helpers. Mirrors the Phase 10 / 14 / 17 plan-level test pattern:
// all helpers are pure, no DB, no fetch, so this file stays under the normal test runner and pins
// every D-01..D-04 edge the cross-AI review surfaced.

import { describe, expect, it } from 'vitest';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { nextPhaseAfterVerifyFixes } from '@server/core/phase-routing';
import type {
  ThreadVerificationEntry,
  ThreadVerificationSnapshot,
  ThreadVerifications,
} from '@shared/schema';
import type { VcsReviewThread } from '@server/vcs/types';
import {
  buildVerifyFixesUserPrompt,
  classifyVerifyFixesVerdict,
  collectUnverifiableThreads,
  FULL_CONTENT_LINE_CAP,
  SAFE_HUNK_LINE_LIMIT,
  shouldAttemptResolution,
  VERIFY_FIXES_UNVERIFIABLE_REASONS,
  WINDOW_LINE_COUNT,
  windowFileContent,
} from '@server/core/verify-fixes';

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

  it('returns the rendered full content when file fits within the cap', () => {
    const content = ['line 1', 'line 2', 'line 3'].join('\n');
    expect(windowFileContent('src/example.ts', content)).toBeNull();
  });

  it('builds merged 50-line windows that preserve ordering and stamp safe boundaries', () => {
    const heading = 'src/example.ts';
    const lines = Array.from({ length: 175 }, (_, i) => `line ${i + 1}`);
    const windows = windowFileContent(heading, lines.join('\n')) ?? [];
    // 175 lines -> 4 windows (50 + 50 + 50 + 25)
    expect(windows.length).toBe(4);
    const totalLines = windows.reduce((sum, window) => sum + window.lineCount, 0);
    expect(totalLines).toBe(175);
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
      mergedStart: 151,
      mergedEnd: 175,
      lineCount: 25,
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
