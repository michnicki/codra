// Phase 20.1 (BLOCKER 2 + BLOCKER 3): pure unit coverage for the four phase selectors that
// previously lived inline in core/review.ts. Every selector is a pure function over `RepoConfig`,
// so the test layer can pin every toggle combination without spinning up Cloudflare bindings.
//
// The selectors are:
//   - nextPhaseAfterReview:        review → verify_fixes | critic | walkthrough_enrichment | finalize
//   - nextPhaseAfterVerifyFixes:   verify_fixes → critic | walkthrough_enrichment | finalize
//   - nextPhaseAfterCritic:        critic → walkthrough_enrichment | finalize
//   - maybeRouteToWalkthroughEnrichment: walkthrough_enrichment | finalize
//
// Chain order (all-v1.2-toggles-on): review → verify_fixes → critic → walkthrough_enrichment → finalize.

import { describe, expect, it } from 'vitest';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import {
  maybeRouteToWalkthroughEnrichment,
  nextPhaseAfterCritic,
  nextPhaseAfterReview,
  nextPhaseAfterVerifyFixes,
} from '@server/core/phase-routing';

/**
 * Override a single toggle on a default config. Builders stay minimal so the tests read at the
 * toggle-combination level rather than the whole-config shape.
 */
function withToggle<K extends keyof RepoConfig['review']>(
  config: RepoConfig,
  key: K,
  value: NonNullable<RepoConfig['review'][K]>,
): RepoConfig {
  return {
    ...config,
    review: {
      ...config.review,
      [key]: value,
    },
  };
}

const verifyFixesOn = (c: RepoConfig) => withToggle(c, 'threads', { verify_fixes: true, auto_resolve: false });
const criticOn = (c: RepoConfig) =>
  withToggle(c, 'passes', {
    ...c.review.passes,
    critic: { enabled: true },
  });
const walkthroughOn = (c: RepoConfig) =>
  withToggle(c, 'walkthrough', { enabled: true, sequence_diagram: { enabled: true } });

describe('phase-routing: nextPhaseAfterReview', () => {
  it('returns finalize at v1.2 defaults (NREG-01 byte-identity)', () => {
    expect(nextPhaseAfterReview(defaultRepoConfig)).toBe('finalize');
  });

  it('returns verify_fixes when only verify_fixes is on', () => {
    expect(nextPhaseAfterReview(verifyFixesOn(defaultRepoConfig))).toBe('verify_fixes');
  });

  it('returns critic when only critic is on', () => {
    expect(nextPhaseAfterReview(criticOn(defaultRepoConfig))).toBe('critic');
  });

  // BLOCKER 2 primary: the walkthrough-only config (walkthrough enabled, verify_fixes + critic
  // both off) used to route review DIRECTLY to finalize, skipping the enrichment phase. The
  // selector now adds a walkthrough-presence check as the last branch.
  it('returns walkthrough_enrichment when only walkthrough is on (BLOCKER 2 primary)', () => {
    expect(nextPhaseAfterReview(walkthroughOn(defaultRepoConfig))).toBe('walkthrough_enrichment');
  });

  it('returns verify_fixes when verify_fixes + critic are both on (chain order: verify_fixes first)', () => {
    expect(nextPhaseAfterReview(verifyFixesOn(criticOn(defaultRepoConfig)))).toBe('verify_fixes');
  });

  it('returns verify_fixes when verify_fixes + walkthrough are both on', () => {
    expect(nextPhaseAfterReview(verifyFixesOn(walkthroughOn(defaultRepoConfig)))).toBe('verify_fixes');
  });

  it('returns critic when critic + walkthrough are both on (chain order: critic before walkthrough)', () => {
    expect(nextPhaseAfterReview(criticOn(walkthroughOn(defaultRepoConfig)))).toBe('critic');
  });

  it('returns verify_fixes at all-v1.2-toggles-on (review → verify_fixes is the first hop)', () => {
    expect(
      nextPhaseAfterReview(verifyFixesOn(criticOn(walkthroughOn(defaultRepoConfig)))),
    ).toBe('verify_fixes');
  });
});

describe('phase-routing: nextPhaseAfterVerifyFixes', () => {
  it('returns finalize at v1.2 defaults (NREG-01 byte-identity)', () => {
    expect(nextPhaseAfterVerifyFixes(defaultRepoConfig)).toBe('finalize');
  });

  // BLOCKER 3 primary: the verify_fixes + critic combined config now chains verify_fixes INTO
  // the critic instead of bypassing it. The previous inline terminal routed verify_fixes
  // directly to walkthrough or finalize.
  it('returns critic when only critic is on (BLOCKER 3 primary)', () => {
    expect(nextPhaseAfterVerifyFixes(criticOn(defaultRepoConfig))).toBe('critic');
  });

  it('returns walkthrough_enrichment when only walkthrough is on', () => {
    expect(nextPhaseAfterVerifyFixes(walkthroughOn(defaultRepoConfig))).toBe('walkthrough_enrichment');
  });

  it('returns critic when critic + walkthrough are both on (chain order: critic before walkthrough)', () => {
    expect(nextPhaseAfterVerifyFixes(criticOn(walkthroughOn(defaultRepoConfig)))).toBe('critic');
  });

  it('returns critic at all-v1.2-toggles-on (verify_fixes → critic is the first hop)', () => {
    expect(
      nextPhaseAfterVerifyFixes(verifyFixesOn(criticOn(walkthroughOn(defaultRepoConfig)))),
    ).toBe('critic');
  });

  it('returns finalize when both critic and walkthrough are off', () => {
    expect(nextPhaseAfterVerifyFixes(defaultRepoConfig)).toBe('finalize');
  });
});

describe('phase-routing: nextPhaseAfterCritic', () => {
  it('returns finalize at v1.2 defaults (NREG-01 byte-identity)', () => {
    expect(nextPhaseAfterCritic(defaultRepoConfig)).toBe('finalize');
  });

  it('returns walkthrough_enrichment when walkthrough is on', () => {
    expect(nextPhaseAfterCritic(walkthroughOn(defaultRepoConfig))).toBe('walkthrough_enrichment');
  });

  it('returns finalize when walkthrough is off', () => {
    expect(nextPhaseAfterCritic(criticOn(defaultRepoConfig))).toBe('finalize');
  });

  it('returns walkthrough_enrichment when both critic and walkthrough are on', () => {
    expect(nextPhaseAfterCritic(criticOn(walkthroughOn(defaultRepoConfig)))).toBe('walkthrough_enrichment');
  });
});

describe('phase-routing: maybeRouteToWalkthroughEnrichment', () => {
  it('returns finalize at v1.2 defaults (NREG-01 byte-identity)', () => {
    expect(maybeRouteToWalkthroughEnrichment(defaultRepoConfig)).toBe('finalize');
  });

  it('returns walkthrough_enrichment when walkthrough is on', () => {
    expect(maybeRouteToWalkthroughEnrichment(walkthroughOn(defaultRepoConfig))).toBe('walkthrough_enrichment');
  });

  it('returns finalize when walkthrough is off', () => {
    expect(maybeRouteToWalkthroughEnrichment(defaultRepoConfig)).toBe('finalize');
  });
});

describe('phase-routing: full chain at all-v1.2-toggles-on', () => {
  // Pins the chain order: review → verify_fixes → critic → walkthrough_enrichment → finalize.
  // The walkthrough_enrichment step itself ends with an internal hand-off to finalize (handled
  // inside walkthrough-enrichment.ts); these selectors cover the hops UP TO the enrichment phase.
  it('chains review → verify_fixes → critic → walkthrough_enrichment', () => {
    const allOn = verifyFixesOn(criticOn(walkthroughOn(defaultRepoConfig)));
    expect(nextPhaseAfterReview(allOn)).toBe('verify_fixes');
    expect(nextPhaseAfterVerifyFixes(allOn)).toBe('critic');
    expect(nextPhaseAfterCritic(allOn)).toBe('walkthrough_enrichment');
  });
});
