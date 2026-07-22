import { describe, it, expect } from 'vitest';
import {
  barPercent,
  formatPerfDuration,
  formatConfidencePercent,
  normalizeSeverityCounts,
  normalizeCategoryCounts,
} from '@client/lib/stats-metrics';
import { reviewSeverities, reviewCategories } from '@shared/schema';

// UI-03 stats bar/percent + performance formatting (Plan 16-02, Task 3). Pure helpers consumed by
// MetricsGrid + KPI tiles in Plan 16-05. Cases pin the REVIEW LOW clamp (0..100), the null -> '—'
// perf edges, and the REVIEW #1 zero-fill (db/stats.ts omits zero-count bands from the payload).

describe('barPercent', () => {
  it('rounds value/max to an integer percent', () => {
    expect(barPercent(3, 12)).toBe(25);
    expect(barPercent(12, 12)).toBe(100);
  });

  it('returns 0 for a zero-count value or a zero denominator (never a hidden row / NaN)', () => {
    expect(barPercent(0, 12)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
  });

  it('REVIEW LOW: clamps negatives to 0 and over-max to 100', () => {
    expect(barPercent(-4, 12)).toBe(0);
    expect(barPercent(20, 12)).toBe(100);
  });
});

describe('formatPerfDuration', () => {
  it('delegates to formatDuration for a real value', () => {
    expect(formatPerfDuration(5000)).toBe('5.0s');
  });

  it('renders the em-dash on null (formatDuration alone returns "")', () => {
    expect(formatPerfDuration(null)).toBe('—');
  });
});

describe('formatConfidencePercent', () => {
  it('renders a rounded percent for a 0..1 value', () => {
    expect(formatConfidencePercent(0.82)).toBe('82%');
    expect(formatConfidencePercent(1)).toBe('100%');
  });

  it('renders the em-dash on null', () => {
    expect(formatConfidencePercent(null)).toBe('—');
  });
});

describe('normalizeSeverityCounts', () => {
  it('REVIEW #1: returns all five bands at 0 on an empty payload (order = reviewSeverities)', () => {
    expect(normalizeSeverityCounts([])).toEqual(
      reviewSeverities.map((severity) => ({ severity, count: 0 })),
    );
  });

  it('zero-fills the bands absent from a sparse payload', () => {
    const result = normalizeSeverityCounts([{ severity: 'P0', count: 8 }]);
    expect(result).toEqual([
      { severity: 'P0', count: 8 },
      { severity: 'P1', count: 0 },
      { severity: 'P2', count: 0 },
      { severity: 'P3', count: 0 },
      { severity: 'nit', count: 0 },
    ]);
  });
});

describe('normalizeCategoryCounts', () => {
  it('REVIEW #1: returns all categories at 0 on an empty payload (order = reviewCategories)', () => {
    expect(normalizeCategoryCounts([])).toEqual(
      reviewCategories.map((category) => ({ category, count: 0 })),
    );
  });

  it('zero-fills the categories absent from a sparse payload', () => {
    const result = normalizeCategoryCounts([{ category: 'security', count: 3 }]);
    expect(result.find((r) => r.category === 'security')).toEqual({ category: 'security', count: 3 });
    for (const category of reviewCategories) {
      if (category === 'security') continue;
      expect(result.find((r) => r.category === category)).toEqual({ category, count: 0 });
    }
  });
});
