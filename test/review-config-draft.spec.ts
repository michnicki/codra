import { describe, it, expect } from 'vitest';
import { defaultRepoConfig } from '@shared/schema';
import { mergeReviewPatch, buildCategoryConfidence } from '@client/lib/review-config-draft';

describe('mergeReviewPatch', () => {
  const current = defaultRepoConfig.review;

  it('applies a settings scalar while preserving every untouched nested key (NREG-02)', () => {
    const result = mergeReviewPatch(current, null, { min_severity: 'P1' });
    expect(result.min_severity).toBe('P1');
    // Untouched nested/scalar/array keys all survive.
    expect(result.mention_trigger).toEqual(current.mention_trigger);
    expect(result.max_files).toBe(current.max_files);
    expect(result.category_confidence).toEqual(current.category_confidence);
    expect(result.threads).toEqual(current.threads);
    expect(result.rounds).toEqual(current.rounds);
    // No key dropped: every current key still present.
    for (const key of Object.keys(current)) {
      expect(result).toHaveProperty(key);
    }
  });

  it('replaces only interactive when settingsFields is null', () => {
    const freshInteractive = {
      ...current.interactive,
      qa: { ...current.interactive.qa, enabled: true },
    };
    const result = mergeReviewPatch(current, freshInteractive, null);
    expect(result.interactive).toEqual(freshInteractive);
    expect(result.interactive.qa.enabled).toBe(true);
    // Every other review key preserved.
    expect(result.min_severity).toBe(current.min_severity);
    expect(result.skip_files).toEqual(current.skip_files);
  });

  it('applies both interactive and settingsFields in one object', () => {
    const freshInteractive = {
      ...current.interactive,
      commands: { ...current.interactive.commands, enabled: true },
    };
    const result = mergeReviewPatch(current, freshInteractive, { max_comments: 5 });
    expect(result.max_comments).toBe(5);
    expect(result.interactive.commands.enabled).toBe(true);
  });

  it('REVIEW #4: a fresh interactive draft wins over a stale interactive inside settingsFields', () => {
    const staleInteractive = {
      ...current.interactive,
      qa: { ...current.interactive.qa, enabled: false, rate_limit_per_hour: 1 },
    };
    const freshInteractive = {
      ...current.interactive,
      qa: { ...current.interactive.qa, enabled: true, rate_limit_per_hour: 99 },
    };
    // settingsFields is a FULL review object carrying a STALE interactive.
    const settingsFields = { ...current, min_severity: 'P1' as const, interactive: staleInteractive };
    const result = mergeReviewPatch(current, freshInteractive, settingsFields);
    // Fresh interactive wins (interactive applied LAST) AND the settings scalar also applies.
    expect(result.interactive).toEqual(freshInteractive);
    expect(result.interactive.qa.rate_limit_per_hour).toBe(99);
    expect(result.min_severity).toBe('P1');
  });

  it('is idempotent — applying twice deeply equals applying once', () => {
    const freshInteractive = {
      ...current.interactive,
      commands: { ...current.interactive.commands, enabled: true },
    };
    const settingsFields = { min_severity: 'P2' as const };
    const once = mergeReviewPatch(current, freshInteractive, settingsFields);
    const twice = mergeReviewPatch(once, freshInteractive, settingsFields);
    expect(twice).toEqual(once);
  });

  it('is a no-op safe shallow copy when both drafts are null/undefined', () => {
    const result = mergeReviewPatch(current, null, null);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
    const result2 = mergeReviewPatch(current, undefined as never, undefined as never);
    expect(result2).toEqual(current);
  });
});

describe('buildCategoryConfidence', () => {
  it('omits an empty-string category (inherit global min_confidence)', () => {
    expect(buildCategoryConfidence({ security: '0.85', bugs: '' })).toEqual({ security: 0.85 });
    // never emits the empty key
    expect(Object.keys(buildCategoryConfidence({ security: '0.85', bugs: '' }))).toEqual(['security']);
  });

  it('omits a whitespace-only category', () => {
    expect(buildCategoryConfidence({ security: '  ' })).toEqual({});
  });

  it('keeps 0 and 1 inclusive bounds', () => {
    expect(buildCategoryConfidence({ performance: '1', correctness: '0' })).toEqual({
      performance: 1,
      correctness: 0,
    });
  });

  it('drops an out-of-range value (not clamped)', () => {
    expect(buildCategoryConfidence({ quality: '1.5' })).toEqual({});
  });

  it('drops a non-numeric value', () => {
    expect(buildCategoryConfidence({ security: 'abc' })).toEqual({});
  });

  it('empty input yields empty; a full five-key input keeps all five without backfilling on sparse', () => {
    expect(buildCategoryConfidence({})).toEqual({});
    const full = buildCategoryConfidence({
      security: '0.1',
      bugs: '0.2',
      performance: '0.3',
      correctness: '0.4',
      quality: '0.5',
    });
    expect(full).toEqual({ security: 0.1, bugs: 0.2, performance: 0.3, correctness: 0.4, quality: 0.5 });
    // a sparse edit never back-fills absent categories
    expect(Object.keys(buildCategoryConfidence({ bugs: '0.5' }))).toEqual(['bugs']);
  });
});
