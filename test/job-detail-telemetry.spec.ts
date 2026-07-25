import { describe, it, expect } from 'vitest';
import {
  countSeverities,
  jobDurationMs,
  confidencePercent,
  displayCategory,
  hasCriticResult,
  isCriticSkipped,
} from '@client/lib/job-telemetry';
import type { ParsedReviewComment } from '@shared/schema';

// UI-02 fail-open display transforms (Plan 16-02, Task 1). These are pure helpers consumed by the
// job-detail JSX in Plan 16-04. Every case here pins a fail-open landmine: null confidence omitted,
// absent category -> 'correctness', absent/skipped criticResult, and NaN/reversed-date duration.

const finding = (severity: ParsedReviewComment['severity']): ParsedReviewComment =>
  ({ path: 'a.ts', severity, category: 'correctness', title: 't', body: 'b' } as ParsedReviewComment);

describe('countSeverities', () => {
  it('tallies each band and zero-fills the absent ones (all five keys present)', () => {
    const result = countSeverities([finding('P0'), finding('P0'), finding('nit')]);
    expect(result).toEqual({ P0: 2, P1: 0, P2: 0, P3: 0, nit: 1 });
  });

  it('returns every band at 0 for an empty candidate set', () => {
    expect(countSeverities([])).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0, nit: 0 });
  });
});

describe('jobDurationMs', () => {
  it('returns the elapsed milliseconds for a valid ordered pair', () => {
    expect(jobDurationMs('2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z')).toBe(5000);
  });

  it('returns null when either timestamp is null/undefined', () => {
    expect(jobDurationMs(null, '2026-01-01T00:00:05Z')).toBeNull();
    expect(jobDurationMs('2026-01-01T00:00:05Z', null)).toBeNull();
    expect(jobDurationMs(undefined, undefined)).toBeNull();
  });

  it('REVIEW #7: returns null on a non-finite parse instead of NaN', () => {
    expect(jobDurationMs('not-a-date', '2026-01-01T00:00:05Z')).toBeNull();
  });

  it('REVIEW #7: returns null when finishedAt < startedAt (reversed) instead of a negative duration', () => {
    expect(jobDurationMs('2026-01-01T00:00:05Z', '2026-01-01T00:00:00Z')).toBeNull();
  });
});

describe('confidencePercent', () => {
  it('rounds a 0..1 confidence to a 0..100 integer', () => {
    expect(confidencePercent(0.824)).toBe(82);
    expect(confidencePercent(1)).toBe(100);
    expect(confidencePercent(0)).toBe(0);
  });

  it('passes null/undefined through as null so the chip is omitted', () => {
    expect(confidencePercent(null)).toBeNull();
    expect(confidencePercent(undefined)).toBeNull();
  });
});

describe('displayCategory', () => {
  it('falls back to correctness when absent', () => {
    expect(displayCategory(undefined)).toBe('correctness');
    expect(displayCategory(null)).toBe('correctness');
  });

  it('passes a known category through', () => {
    expect(displayCategory('security')).toBe('security');
  });

  it('falls back to correctness on an unknown string', () => {
    expect(displayCategory('made-up')).toBe('correctness');
  });
});

describe('hasCriticResult', () => {
  it('is false for null/undefined so the Critic panel is not rendered', () => {
    expect(hasCriticResult(null)).toBe(false);
    expect(hasCriticResult(undefined)).toBe(false);
  });

  it('is true when a critic result object is present', () => {
    expect(hasCriticResult({ kept: [], pruned: [] })).toBe(true);
  });
});

describe('isCriticSkipped', () => {
  it('REVIEW #6: is true when the critic was skipped (kept-all / fail-open bypass)', () => {
    expect(isCriticSkipped({ kept: [], pruned: [], skipped: true })).toBe(true);
  });

  it('is false for a genuine evaluation and for null/undefined', () => {
    expect(isCriticSkipped({ kept: [], pruned: [] })).toBe(false);
    expect(isCriticSkipped(null)).toBe(false);
    expect(isCriticSkipped(undefined)).toBe(false);
  });
});
