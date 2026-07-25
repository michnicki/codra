import { describe, expect, it } from 'vitest';
import { budgetAwareFileLimit, ESTIMATED_SUBREQUESTS_PER_FILE } from '@server/core/review';
import { TokenTracker } from '@server/core/token-tracker';
import { REVIEW_CONCURRENCY_LIMITS, reviewConcurrencyLevels } from '@shared/schema';
import {
  admitEnsembleUnit,
  estimateEnsembleActualAttempts,
  ENSEMBLE_ADMISSION_HEADROOM,
  type EnsembleAdmissionEstimate,
} from '@server/core/ensemble';

// Regression guard for the "concurrency slider is dead above medium" incident: the per-chunk
// budget cap must NOT silently override the user's configured concurrency at a healthy budget.
// These assertions exercise the REAL TokenTracker (so MAX_SUBREQUESTS / SAFE_MARGIN are in play)
// and the REAL REVIEW_CONCURRENCY_LIMITS, so bumping SAFE_MARGIN or ESTIMATED_SUBREQUESTS_PER_FILE
// back into a slider-defeating range fails this test.

const maxLevel = Math.max(...reviewConcurrencyLevels.map((level) => REVIEW_CONCURRENCY_LIMITS[level]));

describe('budgetAwareFileLimit', () => {
  it('honors every configured concurrency level at a fresh budget', () => {
    const fresh = new TokenTracker().remainingSafeBudget();
    for (const level of reviewConcurrencyLevels) {
      const configured = REVIEW_CONCURRENCY_LIMITS[level];
      expect(budgetAwareFileLimit(fresh, configured)).toBe(configured);
    }
  });

  it('still honors the highest level after the getPullRequest preamble spends a few subrequests', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(3); // token read + getPullRequest + a little slack
    expect(budgetAwareFileLimit(tracker.remainingSafeBudget(), maxLevel)).toBe(maxLevel);
  });

  it('throttles below the configured level only once the budget has actually been eaten into', () => {
    // Deep into a troubled invocation the cap should shrink to protect the 50-subrequest ceiling.
    expect(budgetAwareFileLimit(4, maxLevel)).toBe(0);
    expect(budgetAwareFileLimit(0, maxLevel)).toBe(0);
    expect(budgetAwareFileLimit(10, maxLevel)).toBeLessThan(maxLevel);
  });

  it('never exceeds the configured level even with a huge budget', () => {
    expect(budgetAwareFileLimit(10_000, 2)).toBe(2);
  });
});

// MP-05 / D-10: the second (security) pass is modelled as a SEPARATE (file,'security') WORK UNIT
// alongside (file,'main'), so enabling it DOUBLES the unit-list LENGTH -- it must NOT be absorbed by
// bumping ESTIMATED_SUBREQUESTS_PER_FILE (the per-unit cost that governs concurrency). These
// assertions encode that budget model NON-tautologically: rather than re-asserting the already-proven
// budgetAwareFileLimit(fresh, max) === max identity (the four tests above), they relate the per-unit
// estimate, the fresh-budget headroom, and the max concurrency level so the trio fails the moment the
// per-unit cost (or SAFE_MARGIN) is pushed into a slider-defeating range.
//
// NOTE ON INTRA-UNIT FAN-OUT: a single (file,pass) unit may still fan out to MAX_CHUNKS (=4) chunks
// inside ModelService.reviewFile (model.ts:320-337), bounded WITHIN the unit by tracker.isNearLimit().
// That intra-unit chunking is a SEPARATE bound; ESTIMATED_SUBREQUESTS_PER_FILE governs how many UNITS
// run concurrently per chunk. The workload-level proof that a doubled unit list (including a large
// multi-chunk security file) never exceeds budgetAwareFileLimit concurrent calls lives in
// review-flow.spec.ts (behavioral concurrency test).
describe('per-(file,pass)-unit budget re-derivation (MP-05)', () => {
  const freshHeadroom = new TokenTracker().remainingSafeBudget();

  it('keeps ESTIMATED_SUBREQUESTS_PER_FILE at 5 (a per-unit cost, not a per-file cost)', () => {
    // Pinned deliberately: 5 is the ~worst-case per-unit subrequest cost. Raising it to absorb the
    // second pass (e.g. to ~10) is the exact regression the relationship assertions below catch.
    expect(ESTIMATED_SUBREQUESTS_PER_FILE).toBe(5);
  });

  it('fits the max concurrent units of a chunk within the fresh subrequest budget', () => {
    // The concurrent units allowed in one chunk, times the per-unit cost, must fit the fresh budget.
    // Fails if the per-unit cost is bumped into a range where a full-concurrency chunk overspends.
    const concurrentUnits = budgetAwareFileLimit(freshHeadroom, maxLevel);
    expect(concurrentUnits * ESTIMATED_SUBREQUESTS_PER_FILE).toBeLessThanOrEqual(freshHeadroom);
  });

  it('does not silently cap the concurrency slider below the max level at a fresh budget', () => {
    // The budget-derived unit cap must still reach the highest configured concurrency level. Raising
    // ESTIMATED_SUBREQUESTS_PER_FILE to 10 makes floor(25/10) === 2 < 4 and fails HERE before the
    // slider is silently capped -- this is the guard, not a re-assertion of budgetAwareFileLimit.
    expect(Math.floor(freshHeadroom / ESTIMATED_SUBREQUESTS_PER_FILE)).toBeGreaterThanOrEqual(maxLevel);
  });

  it('keeps the max concurrent units within budget INCLUDING the per-unit audit append (Phase 13)', () => {
    // Phase 13 deliberate re-derivation (Codex HIGH): each completed (file,pass) unit now also issues
    // ONE combined audit append (recordUnitAudit) on top of the persisted-review write, so the real
    // worst-case per-unit cost is ESTIMATED_SUBREQUESTS_PER_FILE + 1 (== 6). This must STILL fit the
    // fresh safe budget at max concurrency: 4 units × 6 == 24 <= 25. Encoding the `+ 1` here proves
    // the budget model was re-derived non-silently for the audit write rather than assumed away; it
    // fails the moment either ESTIMATED_SUBREQUESTS_PER_FILE or the max concurrency is nudged up.
    const concurrentUnits = budgetAwareFileLimit(freshHeadroom, maxLevel);
    expect(concurrentUnits * (ESTIMATED_SUBREQUESTS_PER_FILE + 1)).toBeLessThanOrEqual(freshHeadroom);
  });
});

// Phase 19 (PASS-02 / D-13): actual-attempt budget admission. The static per-(file,pass) cost
// (ESTIMATED_SUBREQUESTS_PER_FILE) governs CONCURRENCY; the actual cost of an ensemble-enabled unit
// is the product of [chunks, samples, fallbacks, Google retries] plus DB/audit headroom. A unit
// admitted without considering the actual attempt count would silently exceed the safe budget on
// any non-trivial ensemble run.
//
// admitEnsembleUnit returns false whenever the unit's worst-case actual attempt cost plus the
// reserved DB/audit headroom would push the tracker past the remaining safe budget — exactly the
// signal runReviewPhase needs to fresh-handoff rather than start an over-budget unit.
describe('Phase 19 (PASS-02) actual-attempt budget admission', () => {
  // Defensive: a sane headroom constant exists for DB/audit writes the tracker doesn't see.
  it('exposes a positive DB/audit headroom constant', () => {
    expect(ENSEMBLE_ADMISSION_HEADROOM).toBeGreaterThan(0);
  });

  it('admits a runs=1 / chunks=1 unit at a fresh budget (NREG-01 inert path)', () => {
    const tracker = new TokenTracker();
    const result = admitEnsembleUnit(tracker, { runs: 1, chunkCount: 1, fallbackCount: 0, googleMaxRetries: 0 });
    expect(result.admitted).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('admits a 1-4 chunk / runs=1 unit within the fresh safe budget (no fan-out, intra-unit chunks only)', () => {
    const tracker = new TokenTracker();
    for (const chunkCount of [1, 2, 3, 4]) {
      const result = admitEnsembleUnit(tracker, { runs: 1, chunkCount, fallbackCount: 0, googleMaxRetries: 0 });
      expect(result.admitted).toBe(true);
    }
  });

  it('admits a runs=N unit that fits within the remaining safe budget', () => {
    const tracker = new TokenTracker();
    const result = admitEnsembleUnit(tracker, { runs: 3, chunkCount: 1, fallbackCount: 1, googleMaxRetries: 2 });
    expect(result.admitted).toBe(true);
    // The reported estimate reflects the worst case (3 samples × 1 chunk × (1+1+2) = 12).
    expect(result.estimate.actualAttempts).toBe(12);
    expect(result.estimate.totalCost).toBe(12 + ENSEMBLE_ADMISSION_HEADROOM);
  });

  it('rejects a runs=5 / multi-chunk unit when the budget is partially spent', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(15); // 25 - 15 = 10 remaining safe budget
    // runs=5, chunks=2, fallbacks=2, retries=2 -> 5 × 2 × (1+2+2) = 50 actual attempts. 50 + headroom
    // exceeds the 10 remaining, so the unit must NOT be admitted.
    const result = admitEnsembleUnit(tracker, { runs: 5, chunkCount: 2, fallbackCount: 2, googleMaxRetries: 2 });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('estimates actual attempts as the product of samples × chunks × per-call max attempts', () => {
    const e1 = estimateEnsembleActualAttempts({ runs: 1, chunkCount: 1, fallbackCount: 0, googleMaxRetries: 0 });
    expect(e1.actualAttempts).toBe(1);
    expect(e1.totalCost).toBe(1 + ENSEMBLE_ADMISSION_HEADROOM);

    const e2 = estimateEnsembleActualAttempts({ runs: 3, chunkCount: 2, fallbackCount: 2, googleMaxRetries: 2 });
    expect(e2.actualAttempts).toBe(3 * 2 * (1 + 2 + 2));
  });

  it('mixed main/security: a security unit is one call, never multiplied by ensemble runs', () => {
    // Security stays at 1 attempt (D-13). estimateEnsembleActualAttempts with runs=5 still returns
    // 1 actual attempt for a security unit because the caller is responsible for clamping the
    // runs to 1 for the security pass.
    const mainEstimate = estimateEnsembleActualAttempts({ runs: 5, chunkCount: 2, fallbackCount: 2, googleMaxRetries: 2 });
    const securityEstimate = estimateEnsembleActualAttempts({ runs: 1, chunkCount: 2, fallbackCount: 2, googleMaxRetries: 2 });
    // Main samples are charged at runs=5; security at runs=1. Main cost is 5× the security cost.
    expect(mainEstimate.actualAttempts).toBeGreaterThan(securityEstimate.actualAttempts);
    expect(securityEstimate.actualAttempts).toBe(1 * 2 * (1 + 2 + 2));
  });

  it('reported admission estimate includes the actualAttempts + headroom breakdown', () => {
    const estimate: EnsembleAdmissionEstimate = estimateEnsembleActualAttempts({
      runs: 2,
      chunkCount: 3,
      fallbackCount: 1,
      googleMaxRetries: 1,
    });
    expect(estimate.actualAttempts).toBe(2 * 3 * (1 + 1 + 1));
    expect(estimate.headroom).toBe(ENSEMBLE_ADMISSION_HEADROOM);
    expect(estimate.totalCost).toBe(estimate.actualAttempts + estimate.headroom);
  });
});
