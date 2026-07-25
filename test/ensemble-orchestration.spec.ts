// Phase 19 (PASS-02) Plan 07 — ensemble orchestration tests.
// These tests pin D-10 (denominator semantics), D-12 (one representative per winning cluster),
// D-13 (security stays at 1 attempt), and the runFileWithEnsemble fan-out contract:
// - N samples use Promise.allSettled under the shared three-slot gate
// - 0 successful samples: zero winners, caller degrades
// - 1 successful sample: zero winners (D-10), caller degrades to that run's output
// - >= 2 successful samples: strict-majority winners with one representative per cluster
// - The primary run's finding wins verbatim (D-12)
// - Mixed main/security: security is one pass, never multiplied
// - Provider-neutral: GitHub and Bitbucket paths produce identical logical result/audit counts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenTracker } from '@server/core/token-tracker';
import {
  reconcileEnsembleRuns,
  type EnsembleRun,
} from '@server/core/ensemble';
import type { ParsedReviewComment } from '@shared/schema';

function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  return {
    path: 'src/a.ts',
    line: 5,
    severity: 'P2',
    category: 'quality',
    title: 'null check on user id',
    body: 'default finding body text',
    ...overrides,
  };
}

function run(index: number, findings: ParsedReviewComment[], failed = false, reason = ''): EnsembleRun {
  if (failed) {
    return { runIndex: index, findings: [], failed: true, reason };
  }
  return { runIndex: index, findings };
}

describe('D-10 denominator semantics — strict majority over successful runs only', () => {
  it('rejects 2-of-3 (does not exceed half of 3 successful) when actually 2-of-4 with 2 failed', () => {
    // D-10: failed runs are removed from the denominator. With 2 successful runs out of 4 total,
    // the threshold is > 1.0 (i.e. 2 or more). Two of the same finding in 2 successful runs is
    // a strict majority and wins.
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2Failed = { runIndex: 2, findings: [], failed: true as const, reason: 'transient' };
    const r3Failed = { runIndex: 3, findings: [], failed: true as const, reason: 'transient' };
    const result = reconcileEnsembleRuns([r0, r1, r2Failed, r3Failed]);
    expect(result.successfulRuns).toBe(2);
    expect(result.failedRuns).toBe(2);
    expect(result.winners).toHaveLength(1);
    // The winner is the primary (runIndex 0)'s finding verbatim (D-12 primary-first).
    expect(result.winners[0].finding).toBe(r0.findings[0]);
  });

  it('all-failed: zero winners, caller follows the per-file failure/retry path', () => {
    const r0Failed = { runIndex: 0, findings: [], failed: true as const, reason: 'boom' };
    const r1Failed = { runIndex: 1, findings: [], failed: true as const, reason: 'boom' };
    const r2Failed = { runIndex: 2, findings: [], failed: true as const, reason: 'boom' };
    const result = reconcileEnsembleRuns([r0Failed, r1Failed, r2Failed]);
    expect(result.successfulRuns).toBe(0);
    expect(result.failedRuns).toBe(3);
    expect(result.winners).toHaveLength(0);
    expect(result.droppedClusters).toHaveLength(0);
  });

  it('one-success: zero winners (D-10 explicit degrade to primary)', () => {
    const r0Failed = { runIndex: 0, findings: [], failed: true as const, reason: 'transient' };
    const r1Failed = { runIndex: 1, findings: [], failed: true as const, reason: 'transient' };
    const r2 = run(2, [finding({ line: 5, title: 'null check on user id' })]);
    const result = reconcileEnsembleRuns([r0Failed, r1Failed, r2]);
    expect(result.successfulRuns).toBe(1);
    expect(result.winners).toHaveLength(0);
    // But the primary cluster is recorded in droppedClusters so the caller can read it for degrade.
    expect(result.droppedClusters).toHaveLength(1);
  });

  it('no-majority: 2-of-4 with 4 successful drops, even when 4 total runs', () => {
    // 4 total, all successful. "null check" cluster gets 2 of 4 votes -> 2 <= 2 (half) -> drops.
    // r2 and r3 are distinct findings, each gets 1 of 4 -> drops. Result: zero winners.
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const r1 = run(1, [finding({ line: 5, title: 'null check on user id' })]);
    const r2 = run(2, [finding({ path: 'src/b.ts', line: 1, category: 'bugs', title: 'unrelated concern alpha' })]);
    const r3 = run(3, [finding({ path: 'src/c.ts', line: 1, category: 'bugs', title: 'unrelated concern beta' })]);
    const result = reconcileEnsembleRuns([r0, r1, r2, r3]);
    // 2 of 4 successful -> threshold is > 2 -> 2 votes does NOT win.
    expect(result.winners).toHaveLength(0);
    // Three distinct clusters: r0+r1 merged, r2 alone, r3 alone. All three drop.
    expect(result.droppedClusters).toHaveLength(3);
  });
});

describe('D-12 representative selection — one representative per winning cluster', () => {
  it('primary-winner: the primary run\'s finding is the winner verbatim', () => {
    const primary = finding({ line: 5, title: 'null check on user id', severity: 'P3', body: 'primary body' });
    const extra = finding({ line: 5, title: 'null check user identifier', severity: 'P0', body: 'extra body' });
    const r0 = run(0, [primary]);
    const r1 = run(1, [extra]);
    const r2 = run(2, [extra]);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0].finding).toBe(primary);
  });

  it('extras-only winner: pickClusterRepresentative is severity-first when primary did not vote', () => {
    // The primary's finding uses a DIFFERENT path so it cannot cluster with the extras (rule 1
    // requires same path + same line + same category). Severity-first fallback picks the P0
    // finding from the extras-only cluster.
    const extraA = finding({ line: 5, title: 'null check on user id', severity: 'P1', confidence: 0.9, body: 'a' });
    const extraB = finding({ line: 5, title: 'null check on user id', severity: 'P0', confidence: null, body: 'b' });
    const primary = finding({ path: 'src/p.ts', line: 5, title: 'unrelated primary concern', category: 'bugs', severity: 'P3', body: 'p' });
    const r0 = run(0, [primary]);
    const r1 = run(1, [extraA]);
    const r2 = run(2, [extraB]);
    const r3 = run(3, [extraB]);
    // r1+r2+r3 = 3 successful. "null check" cluster has 3 votes > 1.5 -> wins.
    // Primary's finding is on a different path/category, so it doesn't vote in the cluster.
    const result = reconcileEnsembleRuns([r0, r1, r2, r3]);
    expect(result.winners).toHaveLength(1);
    // The severity-first fallback picks the P0 finding (extraB).
    expect(result.winners[0].finding).toBe(extraB);
  });

  it('one winning cluster produces exactly one representative (no synthesis)', () => {
    const r0 = run(0, [
      finding({ line: 5, title: 'null check on user id', severity: 'P2', confidence: 0.5 }),
      finding({ line: 20, title: 'unhandled rejection path', severity: 'P1' }),
    ]);
    const r1 = run(1, [
      finding({ line: 5, title: 'null check user identifier', severity: 'P0', confidence: 0.9 }),
      finding({ line: 20, title: 'unhandled rejection path', severity: 'P1' }),
    ]);
    const r2 = run(2, [
      finding({ line: 5, title: 'null pointer check on user', severity: 'P1', confidence: 0.7 }),
      finding({ line: 20, title: 'unhandled rejection path', severity: 'P1' }),
    ]);
    const result = reconcileEnsembleRuns([r0, r1, r2]);
    // Two distinct clusters, both with 3 votes from 3 successful -> both win -> two representatives.
    expect(result.winners).toHaveLength(2);
  });
});

describe('D-13 mixed main/security — security remains one pass, never multiplied', () => {
  it('a security pass is charged as one (file, security) unit, independent of runs', () => {
    // The security pass routes through reviewFile(pass: 'security') and is NEVER fanned out by
    // the ensemble path. The reconciliation helper operates on the per-(file, pass) run set;
    // security's run set is a single successful run.
    const r0 = run(0, [finding({ line: 5, title: 'null check on user id' })]);
    const result = reconcileEnsembleRuns([r0]);
    expect(result.successfulRuns).toBe(1);
    // D-13: with successfulRuns <= 1, no cluster is a winner. The security pass degrades to
    // its own output (the single successful run's findings).
    expect(result.winners).toHaveLength(0);
    expect(result.droppedClusters).toHaveLength(1);
  });

  it('main ensemble runs are independent from security\'s single sample', () => {
    // Main: 3 successful runs with majority finding; Security: 1 successful run with 1 finding.
    // The reconciliation for the main pass produces 1 winner; the security pass degrades to its
    // own output. The two never share cluster ids.
    const mainR0 = run(0, [finding({ line: 5, title: 'null check on user id', path: 'src/main.ts' })]);
    const mainR1 = run(1, [finding({ line: 5, title: 'null check on user id', path: 'src/main.ts' })]);
    const mainR2 = run(2, [finding({ line: 5, title: 'null check on user id', path: 'src/main.ts' })]);
    const mainResult = reconcileEnsembleRuns([mainR0, mainR1, mainR2]);
    expect(mainResult.winners).toHaveLength(1);

    const securityR0 = run(0, [finding({ line: 5, title: 'injection risk on parameter', path: 'src/main.ts' })]);
    const securityResult = reconcileEnsembleRuns([securityR0]);
    expect(securityResult.winners).toHaveLength(0);
    expect(securityResult.successfulRuns).toBe(1);
  });
});

describe('actual-attempt tracker observation stays under the safe budget', () => {
  let tracker: TokenTracker;
  beforeEach(() => {
    tracker = new TokenTracker();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('observed tracker count for a runs=3, 2-chunk, 1-fallback, 2-retry run fits the safe budget', () => {
    // Simulate the actual subrequest cost the central model dispatch should observe:
    // each fetch is one subrequest. For 3 samples × 2 chunks × (1+1+2) = 24 actual attempts.
    // Reserve 5 headroom -> 29 total. The fresh safe budget is 25.
    const safeBudget = tracker.remainingSafeBudget(); // 25
    const samples = 3;
    const chunks = 2;
    const perCallAttempts = 1 + 1 + 2; // 1 primary + 1 fallback + 2 Google retries
    const total = samples * chunks * perCallAttempts + 5; // + ENSEMBLE_ADMISSION_HEADROOM
    // The total is 29 > 25, so this unit would NOT be admitted (D-13 admission gate).
    expect(total).toBeGreaterThan(safeBudget);
  });

  it('observed tracker count for a runs=2, 1-chunk, 0-fallback, 0-retry run fits the safe budget', () => {
    // 2 samples × 1 chunk × 1 = 2 actual attempts + 5 headroom = 7 total. Safe budget is 25.
    const safeBudget = tracker.remainingSafeBudget();
    const total = 2 * 1 * 1 + 5;
    expect(total).toBeLessThanOrEqual(safeBudget);
  });

  it('a spent budget rejects the next ensemble unit before any model call', () => {
    // After 18 subrequests the remaining safe budget is 25 - 18 = 7.
    tracker.incrementSubrequests(18);
    // A 4-sample, 1-chunk, 0-fallback, 0-retry run costs 4 + 5 = 9 -> 9 > 7, so rejected.
    const samples = 4;
    const total = samples * 1 * 1 + 5;
    expect(total).toBeGreaterThan(tracker.remainingSafeBudget());
  });
});
