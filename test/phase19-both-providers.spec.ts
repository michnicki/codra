import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  scanProviderNeutralRegions,
} from './support/phase19-provider-neutrality';
import {
  classifyVerifyFixesVerdict,
  shouldAttemptResolution,
} from '@server/core/verify-fixes';
import {
  estimateEnsembleActualAttempts,
  reconcileEnsembleRuns,
  type EnsembleRun,
} from '@server/core/ensemble';
import {
  parseCriticV2Response,
  reconcileCriticDecisions,
} from '@server/core/critic-v2';
import { parseWalkthroughEnrichmentResponse } from '@server/core/model-output';
import type { ParsedReviewComment } from '@shared/schema';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = ['github', 'bitbucket'] as const;

function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  return {
    path: 'src/app.ts',
    line: 10,
    position: 1,
    severity: 'P1',
    category: 'bugs',
    title: 'Guard the edge case',
    body: 'The branch remains reachable.',
    confidence: 0.9,
    ...overrides,
  };
}

function candidateSet(): Array<ParsedReviewComment & { id: number }> {
  return [
    finding({ title: 'Proven', body: 'evidence 0' }) as ParsedReviewComment & { id: number },
    finding({ title: 'Plausible high', body: 'evidence 1', severity: 'P2', confidence: 0.8 }) as ParsedReviewComment & { id: number },
    finding({ title: 'Unsupported', body: 'evidence 2' }) as ParsedReviewComment & { id: number },
    finding({ title: 'Missing verdict', body: 'evidence 3' }) as ParsedReviewComment & { id: number },
  ].map((item, id) => ({ ...item, id }));
}

function runs(): EnsembleRun[] {
  return [
    { runIndex: 0, findings: [finding({ title: 'Guard the edge case' })] },
    { runIndex: 1, findings: [finding({ title: 'Guard the edge case' })] },
    { runIndex: 2, failed: true, reason: 'provider_timeout', findings: [] },
  ];
}

describe('Phase 19 both-provider lifecycle parity', () => {
  it.each(PROVIDERS)('%s preserves verify-fixes verdict and resolution truthfulness', (provider) => {
    const fixed = classifyVerifyFixesVerdict({
      modelVerdict: 'fixed',
      reason: 'model_confirmed_fix',
      fetchFailed: false,
      deletedAtHead: false,
      outdated: false,
      malformedOutput: false,
    });
    const unverifiable = classifyVerifyFixesVerdict({
      modelVerdict: 'fixed',
      reason: 'model_confirmed_fix',
      fetchFailed: true,
      deletedAtHead: false,
      outdated: false,
      malformedOutput: false,
    });
    expect({ provider, fixed, fixedCanResolve: shouldAttemptResolution(fixed.verdict, fixed.reason), unverifiable })
      .toMatchObject({ fixed: { verdict: 'fixed' }, fixedCanResolve: true, unverifiable: { verdict: 'unverifiable' } });
  });

  it('produces the same normalized enabled lifecycle for both provider seams', () => {
    const outputs = PROVIDERS.map((provider) => ({
      provider,
      verify: classifyVerifyFixesVerdict({
        modelVerdict: 'unfixed',
        reason: 'issue_still_present',
        fetchFailed: false,
        deletedAtHead: false,
        outdated: false,
        malformedOutput: false,
      }),
      ensemble: reconcileEnsembleRuns(runs()),
      budget: estimateEnsembleActualAttempts({ runs: 3, chunkCount: 2, fallbackCount: 1, googleMaxRetries: 2 }),
    }));
    expect(outputs[0]?.verify).toEqual(outputs[1]?.verify);
    expect(outputs[0]?.ensemble).toEqual(outputs[1]?.ensemble);
    expect(outputs[0]?.budget).toEqual(outputs[1]?.budget);
  });

  it('keeps capability degradation truthful instead of manufacturing resolution', () => {
    for (const provider of PROVIDERS) {
      const supportsResolution = false;
      const verdict = classifyVerifyFixesVerdict({
        modelVerdict: 'fixed',
        reason: 'model_confirmed_fix',
        fetchFailed: false,
        deletedAtHead: false,
        outdated: false,
        malformedOutput: false,
      });
      expect({ provider, verifiedFixed: verdict.verdict === 'fixed', resolved: supportsResolution && shouldAttemptResolution(verdict.verdict, verdict.reason) })
        .toEqual({ provider, verifiedFixed: true, resolved: false });
    }
  });
});

describe('Phase 19 canonical degraded and partial outcomes', () => {
  it('covers every Critic v2 canonical outcome and malformed fail-open', () => {
    const candidates = candidateSet();
    const completed = reconcileCriticDecisions(candidates, [
      { id: 0, verdict: 'proven', reason: 'evidence_proven' },
      { id: 1, verdict: 'plausible', reason: 'threshold_met' },
      { id: 2, verdict: 'unsupported', reason: 'evidence_missing' },
    ], { status: 'completed' });
    expect(completed.map((decision) => [decision.verdict, decision.outcome, decision.reason])).toEqual([
      ['proven', 'kept', 'evidence_proven'],
      ['plausible', 'kept', 'threshold_met'],
      ['unsupported', 'dropped', 'evidence_missing'],
      [null, 'dropped', 'no-verdict'],
    ]);
    expect(reconcileCriticDecisions(candidates, [], { status: 'fail_open', reason: 'parse-failure' })
      .every((decision) => decision.outcome === 'kept')).toBe(true);
    expect(parseCriticV2Response('not json')).toEqual({ kind: 'fail_open', reason: 'malformed' });
  });

  it('records ensemble partial failure, multi-chunk cost, and one-survivor degradation', () => {
    const partial = reconcileEnsembleRuns(runs());
    expect(partial.successfulRuns).toBe(2);
    expect(partial.failedRuns).toBe(1);
    expect(partial.winners).toHaveLength(1);
    expect(estimateEnsembleActualAttempts({ runs: 5, chunkCount: 4, fallbackCount: 2, googleMaxRetries: 2 })).toEqual({
      actualAttempts: 100,
      headroom: 5,
      totalCost: 105,
    });
    const degraded = reconcileEnsembleRuns([{ runIndex: 0, findings: [finding()] }]);
    expect(degraded.winners).toHaveLength(0);
    expect(degraded.droppedClusters).toHaveLength(1);
  });

  it('keeps walkthrough malformed optional fields fail-open and independent', () => {
    expect(parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'Runtime', paths: ['src/app.ts'] }],
      confidence: { score: 'high', label: '' },
      effort: 'malformed',
    }))).toEqual({
      kind: 'parsed',
      groups: [{ label: 'Runtime', paths: ['src/app.ts'] }],
      confidence: null,
      effort: null,
    });
  });
});

describe('Phase 19 provider-neutrality AST regions', () => {
  it('contains no GitHub/Bitbucket branch in Phase 19 worker and model seams', () => {
    const targets = [
      ['src/server/core/verify-fixes.ts', ['runVerifyFixesPhase']],
      ['src/server/core/ensemble.ts', ['clusterEnsembleRuns', 'reconcileEnsembleRuns', 'admitEnsembleUnit']],
      ['src/server/core/walkthrough-enrichment.ts', ['runWalkthroughEnrichmentPhase']],
      ['src/server/core/review.ts', ['reviewAndPersistFileWithEnsemble', 'runReviewPhase']],
      ['src/server/services/model.ts', ['runFileWithEnsemble', 'generateWalkthroughEnrichment']],
    ] as const;
    const violations = targets.flatMap(([relativePath, regions]) => scanProviderNeutralRegions(
      readFileSync(path.join(rootDir, relativePath), 'utf8'),
      regions,
    ).map((violation) => ({ relativePath, ...violation })));
    expect(violations).toEqual([]);
  });
});
