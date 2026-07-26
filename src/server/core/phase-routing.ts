// Phase 20.1 (BLOCKER 2 + BLOCKER 3): the four cross-phase selectors live here so review.ts and
// verify-fixes.ts can both consume them without an import cycle. The selectors are pure functions
// over `RepoConfig` — no DB, no I/O, no shared mutable state — so the test layer can pin every
// toggle combination without spinning up Cloudflare bindings.
//
// Chain order (all-v1.2-toggles-on + SEC-XDIFF-01):
//   review → cross_file_security → verify_fixes → critic → walkthrough_enrichment → finalize.
// The walkthrough enrichment sits AT THE END (wraps the post-filter summary per Phase 19's intent),
// so every selector that can hand off to it routes there ONLY after the upstream LLM phases have
// either run or their toggles are off.
//
// NREG-01 (default byte-identity): at v1.2 defaults (all toggles off), every selector returns
// 'finalize' exactly as it did before — the walkthrough branch is a no-op when
// `walkthrough.enabled === false`, the verify_fixes branch is a no-op when `threads.verify_fixes`
// is false, the critic branch is a no-op when `passes.critic.enabled` is false, and the
// cross_file_security branch is a no-op when `passes.security.cross_file` is false.

import type { RepoConfig } from '@shared/schema';

/**
 * Phase 19 (THR-01/THR-02) + Phase 20.1 (BLOCKER 2) + SEC-XDIFF-01: post-review hand-off.
 * Routes to:
 *  - `cross_file_security` when `passes.security.cross_file` is on (SEC-XDIFF-01's whole-diff
 *    security reasoning pass runs on its own fresh budget BEFORE verify_fixes),
 *  - `verify_fixes` when cross_file is off and `threads.verify_fixes` is on,
 *  - `critic` when both upstream are off and `passes.critic.enabled` is on,
 *  - `walkthrough_enrichment` when all upstream LLM phases are off and `walkthrough.enabled` is on,
 *  - `finalize` otherwise (NREG-01 default).
 *
 * Chain order: review → cross_file_security → verify_fixes → critic → walkthrough_enrichment → finalize.
 * NREG-01: cross_file defaults to false, so the default path is byte-identical to before.
 */
export function nextPhaseAfterReview(
  config: RepoConfig,
): 'critic' | 'finalize' | 'verify_fixes' | 'walkthrough_enrichment' | 'cross_file_security' {
  // SEC-XDIFF-01: cross_file_security is the FIRST hop after review when enabled. It runs before
  // verify_fixes so its cross-file findings are available for the finalize pass to merge.
  if (config.review.passes?.security?.cross_file) {
    return 'cross_file_security';
  }
  if (config.review.threads?.verify_fixes) {
    return 'verify_fixes';
  }
  if (config.review.passes?.critic?.enabled) {
    return 'critic';
  }
  // BLOCKER 2: walkthrough-only config (walkthrough.enabled on, verify_fixes + critic off) routes
  // review DIRECTLY to walkthrough_enrichment without bypassing the enrichment phase.
  if (config.review.walkthrough?.enabled) {
    return 'walkthrough_enrichment';
  }
  return 'finalize';
}

/**
 * Phase 19 (THR-01/THR-02) + Phase 20.1 (BLOCKER 3): post-verify_fixes hand-off. Routes to:
 *  - `critic` when `passes.critic.enabled` is on (Phase 20.1 BLOCKER 3 — the verify_fixes + critic
 *    combined config now chains verify_fixes INTO the critic instead of bypassing it),
 *  - `walkthrough_enrichment` when critic is off and `walkthrough.enabled` is on,
 *  - `finalize` otherwise (NREG-01 default).
 *
 * BLOCKER 3 fix: the caller at verify-fixes.ts:runVerifyFixesPhase wraps the result in
 * `NextPhaseError` so runReviewJob's catch translates it into a `{action:'next_phase'}` result.
 */
export function nextPhaseAfterVerifyFixes(
  config: RepoConfig,
): 'critic' | 'walkthrough_enrichment' | 'finalize' {
  if (config.review.passes?.critic?.enabled) {
    return 'critic';
  }
  return maybeRouteToWalkthroughEnrichment(config);
}

/**
 * Phase 19 Plan 19-08 (PASS-03, D-13): the durable walkthrough enrichment sits between the last LLM
 * phase (critic or verify_fixes) and finalize. Walkthrough enrichment runs ONLY when
 * `review.walkthrough.enabled` is on — otherwise the chain skips it and goes straight to finalize
 * (NREG-01). This selector is shared by `nextPhaseAfterCritic` and `nextPhaseAfterVerifyFixes` so
 * the durable chain always inserts the enrichment phase exactly once.
 */
export function maybeRouteToWalkthroughEnrichment(config: RepoConfig): 'walkthrough_enrichment' | 'finalize' {
  return config.review.walkthrough?.enabled ? 'walkthrough_enrichment' : 'finalize';
}

/**
 * Phase 19 Plan 19-08 (PASS-03): post-critic hand-off. Routes through the walkthrough enrichment
 * phase when the walkthrough is enabled, otherwise straight to finalize.
 */
export function nextPhaseAfterCritic(config: RepoConfig): 'walkthrough_enrichment' | 'finalize' {
  return maybeRouteToWalkthroughEnrichment(config);
}

/**
 * SEC-XDIFF-01: post-cross_file_security hand-off. Routes to the SAME chain as a review that
 * has cross_file OFF — i.e. verify_fixes → critic → walkthrough_enrichment → finalize. The
 * cross_file_security phase does NOT re-check the cross_file toggle (Pitfall 1 from the plan):
 * it unconditionally hands off to the next phase in the chain. This is correct because the
 * cross_file toggle only gates ENTRY into the phase (nextPhaseAfterReview), not EXIT from it.
 */
export function nextPhaseAfterCrossFileSecurity(
  config: RepoConfig,
): 'verify_fixes' | 'critic' | 'walkthrough_enrichment' | 'finalize' {
  if (config.review.threads?.verify_fixes) {
    return 'verify_fixes';
  }
  if (config.review.passes?.critic?.enabled) {
    return 'critic';
  }
  if (config.review.walkthrough?.enabled) {
    return 'walkthrough_enrichment';
  }
  return 'finalize';
}
