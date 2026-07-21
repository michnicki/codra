import { describe, expect, it } from 'vitest';
import type { ParsedReviewComment, ReviewCategory, ReviewSeverity } from '@shared/schema';
import type { MergeRecord } from '@server/core/dedup';
import {
  applyNoiseFilter,
  type NoiseFilterOptions,
} from '@server/core/noise-filter';

// Pure, no-DB unit spec (mirrors test/dedup.spec.ts): applyNoiseFilter is a zero-cost deterministic
// function, so every FR-180 chain edge the plan pins is asserted here against the real export with a
// local finding() factory and an injected no-op dedup for the pure-chain cases.

let counter = 0;
function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  counter += 1;
  return {
    path: 'src/a.ts',
    line: 5,
    severity: 'P2',
    category: 'correctness',
    title: `finding ${counter}`,
    body: 'default finding body text',
    confidence: 0.9,
    ...overrides,
  };
}

// A no-op dedup keeps every survivor and reports no merges — used for the pure-chain cases so the
// chain behavior is isolated from any dedup logic.
const noopDedup = (comments: ParsedReviewComment[]): { survivors: ParsedReviewComment[]; merges: MergeRecord[] } => ({
  survivors: comments,
  merges: [],
});

function baseOpts(overrides: Partial<NoiseFilterOptions> = {}): NoiseFilterOptions {
  return {
    minConfidence: 0.7,
    categoryConfidence: {},
    minSeverity: 'nit',
    effectiveMaxComments: 100,
    dedup: noopDedup,
    ...overrides,
  };
}

describe('applyNoiseFilter — empty & trivial', () => {
  it('empty input yields empty kept and empty dropped buckets with no throw', () => {
    const result = applyNoiseFilter([], baseOpts());
    expect(result.kept).toEqual([]);
    expect(result.dropped.confidenceFloor).toEqual([]);
    expect(result.dropped.severityFloor).toEqual([]);
    expect(result.dropped.cap).toEqual([]);
    expect(result.dropped.merges).toEqual([]);
  });

  it('a single comment passing the floors is kept', () => {
    const c = finding({ confidence: 0.9, severity: 'P2' });
    const result = applyNoiseFilter([c], baseOpts());
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toBe(c);
  });
});

describe('applyNoiseFilter — effective per-category confidence floor (FILT-02)', () => {
  it('tightens: a security finding below the category floor is dropped, a bugs finding at the same confidence is kept', () => {
    const security = finding({ category: 'security', confidence: 0.8, title: 'sec' });
    const bugs = finding({ category: 'bugs', confidence: 0.8, title: 'bug' });
    const result = applyNoiseFilter([security, bugs], baseOpts({ categoryConfidence: { security: 0.85 } }));

    expect(result.kept).toContain(bugs);
    expect(result.kept).not.toContain(security);
    expect(result.dropped.confidenceFloor).toHaveLength(1);
    const rec = result.dropped.confidenceFloor[0];
    expect(rec.title).toBe('sec');
    // Review finding #2: the record carries the EFFECTIVE floor that dropped it (0.85), not global 0.7.
    expect(rec.effectiveFloor).toBe(0.85);
    expect(rec.category).toBe('security');
    expect(rec.confidence).toBe(0.8);
  });

  it('never loosens: a category floor below the global is ignored (max wins)', () => {
    const security = finding({ category: 'security', confidence: 0.6 });
    const result = applyNoiseFilter([security], baseOpts({ categoryConfidence: { security: 0.5 } }));
    // max(0.7, 0.5) = 0.7 -> 0.6 still dropped.
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.confidenceFloor).toHaveLength(1);
    expect(result.dropped.confidenceFloor[0].effectiveFloor).toBe(0.7);
  });

  it('empty category_confidence {} -> global governs every category', () => {
    const security = finding({ category: 'security', confidence: 0.8 });
    const result = applyNoiseFilter([security], baseOpts({ categoryConfidence: {} }));
    expect(result.kept).toHaveLength(1);
    expect(result.dropped.confidenceFloor).toHaveLength(0);
  });

  it('null/undefined confidence is always kept (fail-open) and never recorded', () => {
    const nullConf = finding({ confidence: null, title: 'null-conf' });
    const undefConf = finding({ confidence: undefined, title: 'undef-conf' });
    const result = applyNoiseFilter([nullConf, undefConf], baseOpts({ minConfidence: 0.99 }));
    expect(result.kept).toHaveLength(2);
    expect(result.dropped.confidenceFloor).toHaveLength(0);
  });

  it('confidence exactly at the effective floor is kept (>= comparison)', () => {
    const c = finding({ confidence: 0.7 });
    const result = applyNoiseFilter([c], baseOpts({ minConfidence: 0.7 }));
    expect(result.kept).toHaveLength(1);
    expect(result.dropped.confidenceFloor).toHaveLength(0);
  });
});

describe('applyNoiseFilter — severity floor', () => {
  it('drops findings whose severity rank is below min_severity into dropped.severityFloor', () => {
    const p3 = finding({ severity: 'P3', title: 'p3' });
    const p1 = finding({ severity: 'P1', title: 'p1' });
    const result = applyNoiseFilter([p3, p1], baseOpts({ minSeverity: 'P2' }));
    expect(result.kept).toContain(p1);
    expect(result.kept).not.toContain(p3);
    expect(result.dropped.severityFloor).toHaveLength(1);
    expect(result.dropped.severityFloor[0].title).toBe('p3');
    expect(result.dropped.severityFloor[0].severity).toBe('P3');
  });

  it('severity exactly at min_severity rank passes (<= minRank)', () => {
    const p2 = finding({ severity: 'P2' });
    const result = applyNoiseFilter([p2], baseOpts({ minSeverity: 'P2' }));
    expect(result.kept).toHaveLength(1);
    expect(result.dropped.severityFloor).toHaveLength(0);
  });
});

describe('applyNoiseFilter — tiered cap (FILT-01, D-13)', () => {
  it('SC1 canonical: 8 P0 + 5 P2 + 10 nit with cap 3 -> 16 kept (all P0 + all P2 + 3 nit)', () => {
    const p0s = Array.from({ length: 8 }, () => finding({ severity: 'P0' }));
    const p2s = Array.from({ length: 5 }, () => finding({ severity: 'P2' }));
    const nits = Array.from({ length: 10 }, () => finding({ severity: 'nit' }));
    const result = applyNoiseFilter([...p0s, ...p2s, ...nits], baseOpts({ effectiveMaxComments: 3 }));

    expect(result.kept).toHaveLength(16);
    expect(result.kept.filter((c) => c.severity === 'P0')).toHaveLength(8);
    expect(result.kept.filter((c) => c.severity === 'P2')).toHaveLength(5);
    expect(result.kept.filter((c) => c.severity === 'nit')).toHaveLength(3);
    // The 7 trimmed nit land in dropped.cap.
    expect(result.dropped.cap).toHaveLength(7);
    expect(result.dropped.cap.every((r) => r.severity === 'nit')).toBe(true);
  });

  it('boundary: 4 P3/nit candidates with cap 3 -> exactly 3 kept, 1 in dropped.cap', () => {
    const cands = Array.from({ length: 4 }, () => finding({ severity: 'P3' }));
    const result = applyNoiseFilter(cands, baseOpts({ effectiveMaxComments: 3 }));
    expect(result.kept).toHaveLength(3);
    expect(result.dropped.cap).toHaveLength(1);
  });

  it('adjacency: a P2 (rank 2) is always kept while a P3 (rank 3) is subject to the cap', () => {
    const p2 = finding({ severity: 'P2', title: 'p2' });
    const p3a = finding({ severity: 'P3', title: 'p3a' });
    const p3b = finding({ severity: 'P3', title: 'p3b' });
    const result = applyNoiseFilter([p2, p3a, p3b], baseOpts({ effectiveMaxComments: 1 }));
    expect(result.kept).toContain(p2);
    expect(result.kept.filter((c) => c.severity === 'P3')).toHaveLength(1);
    expect(result.dropped.cap).toHaveLength(1);
    // No P0/P1/P2 is ever placed in the cap bucket.
    expect(result.dropped.cap.every((r) => r.severity === 'P3' || r.severity === 'nit')).toBe(true);
  });

  it('P0/P1/P2 never appear in dropped.cap even under a tiny cap', () => {
    const highs = [
      finding({ severity: 'P0' }),
      finding({ severity: 'P1' }),
      finding({ severity: 'P2' }),
    ];
    const result = applyNoiseFilter(highs, baseOpts({ effectiveMaxComments: 0 }));
    expect(result.kept).toHaveLength(3);
    expect(result.dropped.cap).toHaveLength(0);
  });
});

describe('applyNoiseFilter — ordering', () => {
  it('kept is sorted severity desc then confidence desc; P3 sorts before nit', () => {
    const nit = finding({ severity: 'nit', confidence: 0.95, title: 'nit' });
    const p3 = finding({ severity: 'P3', confidence: 0.8, title: 'p3' });
    const p0 = finding({ severity: 'P0', confidence: 0.75, title: 'p0' });
    const result = applyNoiseFilter([nit, p3, p0], baseOpts({ effectiveMaxComments: 100 }));
    expect(result.kept.map((c) => c.title)).toEqual(['p0', 'p3', 'nit']);
  });

  it('equal severity sorts by confidence desc', () => {
    const low = finding({ severity: 'P2', confidence: 0.75, title: 'low' });
    const high = finding({ severity: 'P2', confidence: 0.95, title: 'high' });
    const result = applyNoiseFilter([low, high], baseOpts());
    expect(result.kept.map((c) => c.title)).toEqual(['high', 'low']);
  });

  it('full severity+confidence tie is stable (earlier input finding sorts first) so cap trimming is deterministic', () => {
    const a = finding({ severity: 'nit', confidence: 0.9, title: 'a' });
    const b = finding({ severity: 'nit', confidence: 0.9, title: 'b' });
    const c = finding({ severity: 'nit', confidence: 0.9, title: 'c' });
    const result = applyNoiseFilter([a, b, c], baseOpts({ effectiveMaxComments: 2 }));
    expect(result.kept.map((x) => x.title)).toEqual(['a', 'b']);
    expect(result.dropped.cap.map((x) => x.title)).toEqual(['c']);
  });
});

describe('applyNoiseFilter — dedup injection (step 4)', () => {
  it('invokes opts.dedup on the sorted survivors and surfaces its merges in dropped.merges', () => {
    const a = finding({ severity: 'P1', title: 'survivor' });
    const b = finding({ severity: 'P2', title: 'suppressed' });
    const merge: MergeRecord = { survivor: a, suppressed: b, rule: 'rule2', titleSimilarity: 0.5, bodySimilarity: null };
    const dedup = (comments: ParsedReviewComment[]) => ({
      survivors: comments.filter((c) => c !== b),
      merges: [merge],
    });
    const result = applyNoiseFilter([a, b], baseOpts({ dedup }));
    expect(result.kept).toContain(a);
    expect(result.kept).not.toContain(b);
    expect(result.dropped.merges).toEqual([merge]);
  });

  it('dedup receives comments already sorted severity desc', () => {
    let received: ReviewSeverity[] = [];
    const dedup = (comments: ParsedReviewComment[]) => {
      received = comments.map((c) => c.severity);
      return { survivors: comments, merges: [] as MergeRecord[] };
    };
    const nit = finding({ severity: 'nit' });
    const p0 = finding({ severity: 'P0' });
    applyNoiseFilter([nit, p0], baseOpts({ dedup }));
    expect(received).toEqual(['P0', 'nit']);
  });
});

describe('applyNoiseFilter — DropRecord privacy', () => {
  it('records carry only the identifier + non-sensitive metrics, never body/diff/existingCode/codeSuggestion', () => {
    const c = finding({
      confidence: 0.1,
      body: 'SECRET BODY',
      existingCode: 'SECRET CODE',
      codeSuggestion: 'SECRET SUGGESTION',
      category: 'security' as ReviewCategory,
    });
    const result = applyNoiseFilter([c], baseOpts({ minConfidence: 0.9 }));
    const rec = result.dropped.confidenceFloor[0];
    expect(rec).toBeDefined();
    expect(Object.keys(rec).sort()).toEqual(
      ['category', 'confidence', 'effectiveFloor', 'line', 'path', 'severity', 'title'].sort(),
    );
    expect(JSON.stringify(rec)).not.toContain('SECRET');
  });
});
