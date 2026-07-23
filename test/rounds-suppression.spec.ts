import { describe, expect, it } from 'vitest';
import type { ParsedReviewComment } from '@shared/schema';
import type { MergeRecord } from '@server/core/dedup';
import { applyNoiseFilter, type NoiseFilterOptions } from '@server/core/noise-filter';
import {
  buildRoundsSuppressedEvent,
  overlapsOpenThread,
  suppressByOpenThreads,
} from '@server/core/rounds';
import type { VcsReviewThread } from '@server/vcs/types';

function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  return {
    path: 'src/a.ts',
    line: 10,
    severity: 'P3',
    category: 'correctness',
    title: 'candidate',
    body: 'bounded test body',
    confidence: 0.9,
    ...overrides,
  };
}

function thread(overrides: Partial<VcsReviewThread> = {}): VcsReviewThread {
  return {
    ref: 'provider-opaque-ref',
    path: 'src/a.ts',
    lineStart: 10,
    lineEnd: 20,
    rootBody: 'PRIVATE THREAD BODY',
    outdated: false,
    ...overrides,
  };
}

const noopDedup = (
  comments: ParsedReviewComment[],
): { survivors: ParsedReviewComment[]; merges: MergeRecord[] } => ({ survivors: comments, merges: [] });

function filterOptions(
  openThreads: ReadonlyArray<VcsReviewThread>,
  overrides: Partial<NoiseFilterOptions> = {},
): NoiseFilterOptions {
  return {
    minConfidence: 0,
    categoryConfidence: {},
    minSeverity: 'nit',
    effectiveMaxComments: 1,
    dedup: noopDedup,
    preCapSuppress: (comments) => {
      const result = suppressByOpenThreads(comments, openThreads);
      return {
        survivors: result.survivors,
        suppressed: result.suppressed.map(({ finding: suppressedFinding }) => suppressedFinding),
      };
    },
    ...overrides,
  };
}

describe('overlapsOpenThread', () => {
  it('matches a finding point at either inclusive range boundary', () => {
    const open = thread({ lineStart: 10, lineEnd: 20 });
    expect(overlapsOpenThread(finding({ line: 10 }), open)).toBe(true);
    expect(overlapsOpenThread(finding({ line: 20 }), open)).toBe(true);
  });

  it('rejects points outside the range and exact-path mismatches', () => {
    const open = thread({ lineStart: 10, lineEnd: 20 });
    expect(overlapsOpenThread(finding({ line: 9 }), open)).toBe(false);
    expect(overlapsOpenThread(finding({ line: 21 }), open)).toBe(false);
    expect(overlapsOpenThread(finding({ path: 'src/renamed.ts', line: 10 }), open)).toBe(false);
  });

  it('rejects null finding lines, invalid ranges, and reversed ranges', () => {
    expect(overlapsOpenThread(finding({ line: null }), thread())).toBe(false);
    expect(overlapsOpenThread(finding(), thread({ lineStart: 0, lineEnd: 20 }))).toBe(false);
    expect(overlapsOpenThread(finding(), thread({ lineStart: -1, lineEnd: 20 }))).toBe(false);
    expect(overlapsOpenThread(finding(), thread({ lineStart: 20, lineEnd: 10 }))).toBe(false);
  });

  it('consumes the adapter-provided outdated boolean without reinterpretation', () => {
    expect(overlapsOpenThread(finding(), thread({ outdated: true }))).toBe(false);
    expect(overlapsOpenThread(finding(), thread({ outdated: false }))).toBe(true);
  });
});

describe('pre-cap open-thread suppression', () => {
  it('removes overlaps before cap consumption so the next eligible candidate backfills', () => {
    const suppressed = finding({ title: 'already-open', confidence: 0.99 });
    const backfill = finding({ title: 'new-candidate', line: 30, confidence: 0.8 });

    const result = applyNoiseFilter(
      [suppressed, backfill],
      filterOptions([thread({ lineStart: 10, lineEnd: 20 })]),
    );

    expect(result.kept).toEqual([backfill]);
    expect(result.suppressed).toEqual([suppressed]);
    expect(result.dropped.cap).toEqual([]);
  });

  it('runs floors before suppression and preserves existing drop categories', () => {
    const belowFloor = finding({ title: 'below-floor', confidence: 0.2 });
    const result = applyNoiseFilter(
      [belowFloor],
      filterOptions([thread()], { minConfidence: 0.8 }),
    );

    expect(result.suppressed).toEqual([]);
    expect(result.dropped.confidenceFloor.map((drop) => drop.title)).toEqual(['below-floor']);
  });

  it('fails open for outdated, invalid, and renamed-path thread data', () => {
    const candidates = [
      finding({ title: 'outdated', line: 10 }),
      finding({ title: 'invalid', line: 30 }),
      finding({ title: 'renamed', path: 'src/renamed.ts', line: 40 }),
    ];
    const openThreads = [
      thread({ outdated: true, lineStart: 10, lineEnd: 10 }),
      thread({ lineStart: 40, lineEnd: 30 }),
      thread({ path: 'src/old-name.ts', lineStart: 40, lineEnd: 40 }),
    ];

    const result = applyNoiseFilter(
      candidates,
      filterOptions(openThreads, { effectiveMaxComments: 3 }),
    );

    expect(result.kept).toEqual(candidates);
    expect(result.suppressed).toEqual([]);
  });

  it('keeps suppression audit privacy-bounded and excludes thread body/ref', () => {
    const candidate = finding({ title: 'already reported' });
    const open = thread();
    const event = buildRoundsSuppressedEvent({ finding: candidate, threadPath: open.path });
    const serialized = JSON.stringify(event);

    expect(event).toMatchObject({
      stage: 'rounds.suppressed',
      path: 'src/a.ts',
      line: 10,
      title: 'already reported',
      threadPath: 'src/a.ts',
    });
    expect(serialized).not.toContain(open.rootBody);
    expect(serialized).not.toContain(open.ref);
  });
});
