/**
 * Unit tests for src/server/core/learned-rules.ts — the LRN-01 learned-rule synthesis
 * algorithm: clustering reject_feedback rows, synthesizing pending rules, and suppressing
 * findings matching active rules in finalize.
 *
 * Tests cover:
 *   - clusterRejectFeedback: groups by (category, file_path), skips nulls, enforces min size 2
 *   - synthesizeRules: produces pending rules, deduplicates across all statuses, generates UUIDs
 *   - suppressByLearnedRules: drops matching findings (category + glob), handles edge cases
 */

import { describe, it, expect, vi } from 'vitest';
import type { ParsedReviewComment } from '@shared/schema';
import {
  clusterRejectFeedback,
  synthesizeRules,
  suppressByLearnedRules,
} from '@server/core/learned-rules';

// ---------------------------------------------------------------------------
// clusterRejectFeedback
// ---------------------------------------------------------------------------

describe('clusterRejectFeedback', () => {
  it('groups rows by exact (finding_category, finding_file_path) and returns clusters with >= 2 rejections', () => {
    const rows = [
      { id: '1', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: '2', finding_category: 'quality', finding_file_path: 'src/a.ts' },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      category: 'quality',
      filePath: 'src/a.ts',
      rejectionIds: ['1', '2'],
    });
  });

  it('returns empty array when only 1 rejection exists (min size 2)', () => {
    const rows = [
      { id: '1', finding_category: 'quality', finding_file_path: 'src/a.ts' },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toEqual([]);
  });

  it('skips rows with null finding_category', () => {
    const rows = [
      { id: '1', finding_category: null, finding_file_path: 'src/a.ts' },
      { id: '2', finding_category: null, finding_file_path: 'src/a.ts' },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toEqual([]);
  });

  it('skips rows with null finding_file_path', () => {
    const rows = [
      { id: '1', finding_category: 'quality', finding_file_path: null },
      { id: '2', finding_category: 'quality', finding_file_path: null },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toEqual([]);
  });

  it('skips rows with both null fields', () => {
    const rows = [
      { id: '1', finding_category: null, finding_file_path: null },
      { id: '2', finding_category: null, finding_file_path: null },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(clusterRejectFeedback([])).toEqual([]);
  });

  it('creates separate clusters for different categories on same file', () => {
    const rows = [
      { id: '1', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: '2', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: '3', finding_category: 'security', finding_file_path: 'src/a.ts' },
      { id: '4', finding_category: 'security', finding_file_path: 'src/a.ts' },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toHaveLength(2);
    const categories = result.map((c) => c.category).sort();
    expect(categories).toEqual(['quality', 'security']);
  });

  it('creates separate clusters for different files with same category', () => {
    const rows = [
      { id: '1', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: '2', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: '3', finding_category: 'quality', finding_file_path: 'src/b.ts' },
      { id: '4', finding_category: 'quality', finding_file_path: 'src/b.ts' },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toHaveLength(2);
    const paths = result.map((c) => c.filePath).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('collects all rejection IDs in a cluster', () => {
    const rows = [
      { id: 'a', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: 'b', finding_category: 'quality', finding_file_path: 'src/a.ts' },
      { id: 'c', finding_category: 'quality', finding_file_path: 'src/a.ts' },
    ];
    const result = clusterRejectFeedback(rows);
    expect(result).toHaveLength(1);
    expect(result[0].rejectionIds).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// synthesizeRules
// ---------------------------------------------------------------------------

describe('synthesizeRules', () => {
  it('produces new pending rules from clusters', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/a.ts', rejectionIds: ['1', '2'] },
    ];
    const result = synthesizeRules(clusters, []);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('quality');
    expect(result[0].file_pattern).toBe('src/a.ts');
    expect(result[0].status).toBe('pending');
    expect(result[0].source_rejection_ids).toEqual(['1', '2']);
    expect(result[0].id).toBeDefined();
    expect(result[0].created_at).toBeDefined();
  });

  it('skips clusters whose (category, file_pattern) already exists in any status', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/a.ts', rejectionIds: ['1', '2'] },
    ];
    const existingRules = [
      {
        id: 'existing-1',
        category: 'quality',
        file_pattern: 'src/a.ts',
        status: 'active' as const,
        source_rejection_ids: ['0'],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const result = synthesizeRules(clusters, existingRules);
    expect(result).toEqual([]);
  });

  it('skips clusters matching pending rules (not just active)', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/a.ts', rejectionIds: ['1', '2'] },
    ];
    const existingRules = [
      {
        id: 'existing-1',
        category: 'quality',
        file_pattern: 'src/a.ts',
        status: 'pending' as const,
        source_rejection_ids: ['0'],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const result = synthesizeRules(clusters, existingRules);
    expect(result).toEqual([]);
  });

  it('skips clusters matching disabled rules', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/a.ts', rejectionIds: ['1', '2'] },
    ];
    const existingRules = [
      {
        id: 'existing-1',
        category: 'quality',
        file_pattern: 'src/a.ts',
        status: 'disabled' as const,
        source_rejection_ids: ['0'],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const result = synthesizeRules(clusters, existingRules);
    expect(result).toEqual([]);
  });

  it('generates unique UUIDs for each new rule', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/a.ts', rejectionIds: ['1', '2'] },
      { category: 'security', filePath: 'src/b.ts', rejectionIds: ['3', '4'] },
    ];
    const result = synthesizeRules(clusters, []);
    expect(result).toHaveLength(2);
    expect(result[0].id).not.toBe(result[1].id);
    // UUID format check
    expect(result[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('does not mutate existing rules array', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/c.ts', rejectionIds: ['5', '6'] },
    ];
    const existingRules = [
      {
        id: 'existing-1',
        category: 'quality',
        file_pattern: 'src/a.ts',
        status: 'active' as const,
        source_rejection_ids: ['0'],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const before = [...existingRules];
    synthesizeRules(clusters, existingRules);
    expect(existingRules).toEqual(before);
  });

  it('returns empty array for empty clusters', () => {
    expect(synthesizeRules([], [])).toEqual([]);
  });

  it('returns empty array when all clusters are duplicates', () => {
    const clusters = [
      { category: 'quality', filePath: 'src/a.ts', rejectionIds: ['1', '2'] },
    ];
    const existing = [
      {
        id: 'x',
        category: 'quality',
        file_pattern: 'src/a.ts',
        status: 'active' as const,
        source_rejection_ids: ['0'],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    expect(synthesizeRules(clusters, existing)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suppressByLearnedRules
// ---------------------------------------------------------------------------

describe('suppressByLearnedRules', () => {
  const makeFinding = (overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment => ({
    path: 'src/a.ts',
    line: 10,
    title: 'Some finding',
    body: 'body',
    category: 'quality',
    severity: 'P2',
    confidence: 0.8,
    existingCode: null,
    ...overrides,
  });

  it('drops findings matching active rules (category + file_pattern)', () => {
    const findings = [makeFinding({ category: 'quality', path: 'src/a.ts' })];
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/a.ts' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.kept).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].matched_rule).toBe('rule-1');
    expect(result.entries[0].path).toBe('src/a.ts');
  });

  it('keeps non-matching findings', () => {
    const findings = [
      makeFinding({ category: 'quality', path: 'src/a.ts' }),
      makeFinding({ category: 'security', path: 'src/b.ts' }),
    ];
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/a.ts' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].category).toBe('security');
    expect(result.entries).toHaveLength(1);
  });

  it('handles case-insensitive category match', () => {
    // Rule has uppercase category — should still match finding's lowercase 'quality'
    const findings = [makeFinding({ category: 'quality', path: 'src/a.ts' })];
    const activeRules = [
      { id: 'rule-1', category: 'Quality', file_pattern: 'src/a.ts' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.kept).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('returns all findings kept and empty entries when no active rules', () => {
    const findings = [makeFinding()];
    const result = suppressByLearnedRules(findings, []);
    expect(result.kept).toEqual(findings);
    expect(result.entries).toEqual([]);
  });

  it('uses picomatch glob matching for file_pattern', () => {
    const findings = [makeFinding({ category: 'quality', path: 'src/utils/helper.ts' })];
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/utils/**' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.kept).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('does not match when glob does not apply', () => {
    const findings = [makeFinding({ category: 'quality', path: 'src/other/a.ts' })];
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/utils/**' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.kept).toHaveLength(1);
    expect(result.entries).toEqual([]);
  });

  it('handles invalid picomatch pattern gracefully (C8)', () => {
    const findings = [makeFinding({ category: 'quality', path: 'src/a.ts' })];
    const activeRules = [
      { id: 'rule-bad', category: 'quality', file_pattern: 'src/{invalid' },
    ];
    // Should not throw — logs warning and skips the rule
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.kept).toEqual(findings);
    expect(result.entries).toEqual([]);
  });

  it('preserves entry shape with path, line, title, matched_rule', () => {
    const findings = [
      makeFinding({ path: 'src/a.ts', line: 42, title: 'Fix this', category: 'quality' }),
    ];
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/a.ts' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.entries[0]).toEqual({
      path: 'src/a.ts',
      line: 42,
      title: 'Fix this',
      matched_rule: 'rule-1',
    });
  });

  it('matches first matching rule when multiple rules could match', () => {
    const findings = [makeFinding({ category: 'quality', path: 'src/a.ts' })];
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/a.ts' },
      { id: 'rule-2', category: 'quality', file_pattern: 'src/**' },
    ];
    const result = suppressByLearnedRules(findings, activeRules);
    expect(result.entries[0].matched_rule).toBe('rule-1');
  });

  it('returns empty entries for empty findings input', () => {
    const activeRules = [
      { id: 'rule-1', category: 'quality', file_pattern: 'src/a.ts' },
    ];
    const result = suppressByLearnedRules([], activeRules);
    expect(result.kept).toEqual([]);
    expect(result.entries).toEqual([]);
  });
});
