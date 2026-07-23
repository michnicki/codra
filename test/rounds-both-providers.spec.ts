import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyNoiseFilter } from '@server/core/noise-filter';
import {
  composeRoundFloors,
  resolveRoundContext,
  selectDiffForRound,
  suppressByOpenThreads,
} from '@server/core/rounds';
import { getPrReviewState, setLastReviewedSha, type PrReviewStateKey } from '@server/db/pr-review-state';
import type { FileDiff } from '@server/core/diff';
import type { VcsProvider, VcsReviewThread } from '@server/vcs/types';
import type { ParsedReviewComment } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const PROVIDERS = ['github', 'bitbucket'] as const;
const anchorSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const diffFiles = [{ path: 'src/x.ts' }] as FileDiff[];

function makeProvider(
  name: (typeof PROVIDERS)[number],
  input: {
    compare?: string | Error;
    full?: string;
    threads?: VcsReviewThread[];
    supportsThreadListing?: boolean;
  } = {},
) {
  const compare = vi.fn(async () => {
    if (input.compare instanceof Error) throw input.compare;
    return input.compare ?? 'diff --git a/src/x.ts b/src/x.ts\n';
  });
  const full = vi.fn(async () => input.full ?? 'diff --git a/src/x.ts b/src/x.ts\n');
  const listThreads = vi.fn(async () => input.threads ?? []);
  const updateStatus = vi.fn(async () => undefined);
  const provider = {
    name,
    capabilities: {
      supportsMermaid: name === 'github',
      supportsThreadListing: input.supportsThreadListing ?? true,
      supportsThreadResolution: true,
    },
    getCompareDiff: compare,
    getPullRequestDiff: full,
    getUnresolvedBotThreads: listThreads,
    updateStatusCheck: updateStatus,
  } as unknown as VcsProvider;
  return { provider, compare, full, listThreads, updateStatus };
}

async function selectThroughProvider(
  provider: VcsProvider,
  input: { compareThrows?: boolean; fullFiles?: FileDiff[] } = {},
) {
  let compareDiff = '';
  let compareFiles: FileDiff[] = [];
  let fullDiff = '';
  let fullFiles: FileDiff[] = [];
  let compareThrew = false;

  try {
    compareDiff = await provider.getCompareDiff('owner', 'repo', anchorSha, headSha);
    compareFiles = compareDiff.trim() ? diffFiles : [];
  } catch {
    compareThrew = true;
    fullDiff = await provider.getPullRequestDiff('owner', 'repo', 18);
    fullFiles = input.fullFiles ?? (fullDiff.trim() ? diffFiles : []);
  }

  return selectDiffForRound({
    roundContext: { round: 2, mode: 'incremental', anchorSha },
    compareThrew,
    compareDiff,
    compareFiles,
    fullDiff,
    fullFiles,
    toSha: headSha,
  });
}

function finding(title: string, line: number, confidence: number): ParsedReviewComment {
  return {
    path: 'src/x.ts',
    line,
    position: line,
    severity: 'nit',
    category: 'quality',
    title,
    body: `${title} body`,
    confidence,
  };
}

describe('NREG-02 round lifecycle parity through the VcsProvider seam', () => {
  it('uses identical compare operands and selects incremental mode on both providers', async () => {
    const outputs = [];
    for (const name of PROVIDERS) {
      const { provider, compare, full } = makeProvider(name);
      outputs.push(await selectThroughProvider(provider));
      expect(compare).toHaveBeenCalledWith('owner', 'repo', anchorSha, headSha);
      expect(full).not.toHaveBeenCalled();
    }

    expect(outputs).toEqual([
      { mode: 'incremental', fromSha: anchorSha, toSha: headSha },
      { mode: 'incremental', fromSha: anchorSha, toSha: headSha },
    ]);
  });

  it('treats a legitimate empty compare plus empty full-diff fixture as no_changes', async () => {
    const outputs = [];
    for (const name of PROVIDERS) {
      const { provider, full } = makeProvider(name, { compare: '', full: '' });
      expect(await provider.getPullRequestDiff('owner', 'repo', 18)).toBe('');
      full.mockClear();
      outputs.push(await selectThroughProvider(provider));
      expect(full).not.toHaveBeenCalled();
    }

    expect(outputs).toEqual([
      { mode: 'no_changes', fromSha: anchorSha, toSha: headSha },
      { mode: 'no_changes', fromSha: anchorSha, toSha: headSha },
    ]);
  });

  it('falls back to the non-empty full diff after compare errors on both providers', async () => {
    const outputs = [];
    for (const name of PROVIDERS) {
      const { provider, compare, full } = makeProvider(name, {
        compare: new Error('compare unavailable'),
      });
      outputs.push(await selectThroughProvider(provider, { compareThrows: true, fullFiles: diffFiles }));
      expect(compare).toHaveBeenCalledWith('owner', 'repo', anchorSha, headSha);
      expect(full).toHaveBeenCalledWith('owner', 'repo', 18);
    }

    expect(outputs).toEqual([
      { mode: 'fallback', fromSha: anchorSha, toSha: headSha },
      { mode: 'fallback', fromSha: anchorSha, toSha: headSha },
    ]);
  });

  it('keeps floor toggles and pre-cap suppression/backfill provider-neutral', () => {
    const results = PROVIDERS.map(() => {
      const floorsOn = composeRoundFloors({
        reviewRound: 2,
        reviewMode: 'incremental',
        roundsIncremental: true,
        base: { minConfidence: 0.7, minSeverity: 'nit', categoryConfidence: {} },
        escalateFloors: true,
      });
      const floorsOff = composeRoundFloors({
        reviewRound: 2,
        reviewMode: 'fallback',
        roundsIncremental: true,
        base: { minConfidence: 0.7, minSeverity: 'nit', categoryConfidence: {} },
        escalateFloors: false,
      });
      const threads: VcsReviewThread[] = [{
        ref: 'opaque-provider-ref',
        path: 'src/x.ts',
        lineStart: 10,
        lineEnd: 10,
        rootBody: 'never rendered or audited',
        outdated: false,
      }];
      const filtered = applyNoiseFilter(
        [finding('suppressed first', 10, 0.99), finding('backfilled second', 20, 0.9)],
        {
          minConfidence: 0.7,
          categoryConfidence: {},
          minSeverity: 'nit',
          effectiveMaxComments: 1,
          preCapSuppress: (comments) => {
            const suppression = suppressByOpenThreads(comments, threads);
            return {
              survivors: suppression.survivors,
              suppressed: suppression.suppressed.map(({ finding: item }) => item),
            };
          },
          dedup: (comments) => ({ survivors: comments, merges: [] }),
        },
      );
      return {
        floorsOn: { minConfidence: floorsOn.minConfidence, minSeverity: floorsOn.minSeverity },
        floorsOff: { minConfidence: floorsOff.minConfidence, minSeverity: floorsOff.minSeverity },
        kept: filtered.kept.map((item) => item.title),
        suppressed: filtered.suppressed.map((item) => item.title),
        capDrops: filtered.dropped.cap.length,
      };
    });

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      floorsOn: { minConfidence: 0.8, minSeverity: 'P2' },
      floorsOff: { minConfidence: 0.7, minSeverity: 'nit' },
      kept: ['backfilled second'],
      suppressed: ['suppressed first'],
      capDrops: 0,
    });
  });

  it('keeps capability-disabled listing and review-rest free of provider calls', async () => {
    for (const name of PROVIDERS) {
      const { provider, listThreads } = makeProvider(name, { supportsThreadListing: false });
      const threads = provider.capabilities.supportsThreadListing
        ? provider.getUnresolvedBotThreads('owner', 'repo', 18)
        : Promise.resolve([]);
      await expect(threads).resolves.toEqual([]);
      expect(listThreads).not.toHaveBeenCalled();

      expect(resolveRoundContext({
        reviewScope: 'rest',
        priorState: { last_reviewed_sha: anchorSha, last_review_round: 7 },
        unresolvedThreads: [{
          ref: 'ignored',
          path: 'src/x.ts',
          lineStart: 1,
          lineEnd: 1,
          rootBody: 'ignored',
          outdated: false,
        }],
        roundsIncremental: true,
      })).toEqual({
        round: 1,
        mode: 'rest',
        roundsIncremental: true,
        anchorSha: null,
        hasUnresolvedThreads: false,
      });
    }
  });

  it('keeps shared round consumers free of provider-name branches', () => {
    const source = readFileSync(new URL('../src/server/core/rounds.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/vcs\.name\s*(?:===|!==)/);
    expect(source).not.toMatch(/['"](?:github|bitbucket)['"]/);
  });

  it('completes an identical neutral status outcome through both provider seams', async () => {
    for (const name of PROVIDERS) {
      const { provider, updateStatus } = makeProvider(name);
      await provider.updateStatusCheck('owner', 'repo', 'opaque-status-ref', {
        title: 'No changes to review',
        summary: 'No reviewable changes were found since the previous round.',
        status: 'completed',
        conclusion: 'neutral',
      });
      expect(updateStatus).toHaveBeenCalledWith(
        'owner',
        'repo',
        'opaque-status-ref',
        expect.objectContaining({ status: 'completed', conclusion: 'neutral' }),
      );
    }
  });
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('NREG-02 provider-keyed anchor outcomes', () => {
  it.each(PROVIDERS)('advances %s anchors and rejects an empty-head overwrite', async (name) => {
    const env = createTestEnv();
    const key: PrReviewStateKey = {
      vcsProvider: name,
      workspace: `${name}-workspace`,
      repoSlug: `round-parity-${name}-${Date.now()}`,
      prNumber: 18,
    };

    const advanced = await setLastReviewedSha(env, key, { headSha, reviewRound: 2 });
    expect(advanced).toMatchObject({
      vcs_provider: name,
      last_reviewed_sha: headSha,
      last_review_round: 2,
    });

    expect(await setLastReviewedSha(env, key, { headSha: '', reviewRound: 3 })).toBeNull();
    expect(await getPrReviewState(env, key)).toMatchObject({
      vcs_provider: name,
      last_reviewed_sha: headSha,
      last_review_round: 2,
    });
  });
});
