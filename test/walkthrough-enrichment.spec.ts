// Phase 19 Plan 19-08 (PASS-03, D-14..D-19): the walkthrough enrichment projection tests.
// These pin the pure / deterministic projection invariants (no DB, no fetch, no model call):
//   - D-14: every reviewed path appears exactly once after malformed / invented / duplicate grouping.
//   - D-16: invented / duplicate paths drop; unassigned paths enter "Other changes".
//   - D-17: independent parse of groups / confidence / effort; tolerant of malformed optional fields.
//   - D-18: confidence clamp is downward-only and keyed off the final main-pass finding set
//            (P0 forces at most score=2; 3+ P2 with no P0 forces at most score=3).

import { describe, expect, it } from 'vitest';
import {
  buildWalkthroughData,
  type WalkthroughReviewRow,
} from '@server/core/walkthrough';
import {
  parseWalkthroughEnrichmentResponse,
} from '@server/core/model-output';
import { reviewSeverities } from '@shared/schema';
import type { ParsedReviewComment, WalkthroughChangeGroup, WalkthroughConfidence, WalkthroughEffort } from '@shared/schema';

function emptyCounts() {
  const counts = {} as Record<ParsedReviewComment['severity'], number>;
  for (const sev of reviewSeverities) counts[sev] = 0;
  return counts;
}

function makeRow(path: string, summary = 'Some change.', counts?: Record<string, number>): WalkthroughReviewRow {
  return {
    file_path: path,
    file_summary: summary,
    file_status: 'done',
    error_msg: null,
    verdict: counts && Object.values(counts).some((n) => n > 0) ? 'comment' : 'approve',
    diff_line_count: 10,
    pass: 'main',
  };
}

function makeComment(path: string, severity: ParsedReviewComment['severity']): ParsedReviewComment {
  return {
    path,
    line: 1,
    position: 1,
    severity,
    category: 'quality',
    title: 't',
    body: 'b',
    codeSuggestion: null,
    existingCode: null,
  };
}

describe('D-14 walkthrough enrichment known-path grouping', () => {
  it('drops invented paths and routes only known paths into model groups', () => {
    const reviews = [makeRow('src/a.ts'), makeRow('src/b.ts')];
    const finalComments = [makeComment('src/a.ts', 'P2')];

    const groups: WalkthroughChangeGroup[] = [
      { label: 'Auth', paths: ['src/a.ts', 'invented/path.ts'] },
    ];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups, confidence: null, effort: null },
    });

    expect(data.groups).toBeDefined();
    // Auth group keeps only the known path
    const auth = data.groups!.find((g) => g.label === 'Auth');
    expect(auth).toBeDefined();
    expect(auth!.files.map((f) => f.path)).toEqual(['src/a.ts']);
    // Other changes bucket carries every unassigned reviewed file
    const other = data.groups!.find((g) => g.label === 'Other changes');
    expect(other).toBeDefined();
    expect(other!.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('first assignment wins for duplicate paths', () => {
    const reviews = [makeRow('src/a.ts'), makeRow('src/b.ts')];
    const finalComments = [makeComment('src/a.ts', 'P1')];

    const groups: WalkthroughChangeGroup[] = [
      { label: 'Group A', paths: ['src/a.ts'] },
      { label: 'Group B', paths: ['src/a.ts', 'src/b.ts'] },
    ];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups, confidence: null, effort: null },
    });

    // Group A keeps src/a.ts (first valid claim); Group B keeps only src/b.ts (a.ts dropped).
    const groupA = data.groups!.find((g) => g.label === 'Group A');
    const groupB = data.groups!.find((g) => g.label === 'Group B');
    expect(groupA).toBeDefined();
    expect(groupA!.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(groupB!.files.map((f) => f.path)).toEqual(['src/b.ts']);
    expect(data.groups!.find((g) => g.label === 'Other changes')).toBeUndefined();
  });

  it('appends "Other changes" when the model emits zero groups but every path is reviewed', () => {
    const reviews = [makeRow('src/a.ts'), makeRow('src/b.ts')];
    const finalComments: ParsedReviewComment[] = [];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence: null, effort: null },
    });

    expect(data.groups).toBeDefined();
    expect(data.groups!.length).toBe(1);
    expect(data.groups![0].label).toBe('Other changes');
    expect(data.groups![0].files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('drops groups whose every path was invented or duplicated', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments: ParsedReviewComment[] = [];

    const groups: WalkthroughChangeGroup[] = [
      { label: 'Hallucinated', paths: ['does/not/exist.ts'] },
      { label: 'Empty', paths: [] },
    ];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups, confidence: null, effort: null },
    });

    // Neither group retains a valid path; the file lands in Other changes.
    expect(data.groups!.find((g) => g.label === 'Hallucinated')).toBeUndefined();
    expect(data.groups!.find((g) => g.label === 'Empty')).toBeUndefined();
    expect(data.groups!.find((g) => g.label === 'Other changes')!.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('preserves one-line summaries and per-file counts inside grouped sections', () => {
    const reviews = [makeRow('src/a.ts', 'Adds new endpoint.')];
    const finalComments = [makeComment('src/a.ts', 'P2')];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [{ label: 'API', paths: ['src/a.ts'] }], confidence: null, effort: null },
    });

    const api = data.groups!.find((g) => g.label === 'API')!;
    expect(api.files[0].summary).toBe('Adds new endpoint.');
    expect(api.files[0].counts.P2).toBe(1);
  });
});

describe('D-18 confidence clamp', () => {
  it('forces at most score=2 when at least one P0 finding posts', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments = [makeComment('src/a.ts', 'P0')];

    const confidence: WalkthroughConfidence = { score: 4, label: 'Looks good', reason: 'r' };

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence, effort: null },
    });

    expect(data.assessment?.confidence?.score).toBe(2);
  });

  it('forces at most score=3 when three or more P2 findings post and no P0', () => {
    const reviews = [makeRow('src/a.ts'), makeRow('src/b.ts')];
    const finalComments = [
      makeComment('src/a.ts', 'P2'),
      makeComment('src/b.ts', 'P2'),
      makeComment('src/a.ts', 'P2'),
    ];

    const confidence: WalkthroughConfidence = { score: 5, label: 'Ship it', reason: 'r' };

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence, effort: null },
    });

    expect(data.assessment?.confidence?.score).toBe(3);
  });

  it('does not raise the model score when no clamp applies', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments = [makeComment('src/a.ts', 'P3')];

    const confidence: WalkthroughConfidence = { score: 4, label: 'Looks good', reason: 'r' };

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence, effort: null },
    });

    expect(data.assessment?.confidence?.score).toBe(4);
  });

  it('keeps a model score already at or below the clamp', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments = [makeComment('src/a.ts', 'P0')];

    const confidence: WalkthroughConfidence = { score: 1, label: 'Do not merge', reason: 'r' };

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence, effort: null },
    });

    // P0 forces at most 2 — model score of 1 stays.
    expect(data.assessment?.confidence?.score).toBe(1);
  });

  it('does not clamp when confidence is null', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments = [makeComment('src/a.ts', 'P0')];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence: null, effort: null },
    });

    expect(data.assessment?.confidence).toBeNull();
  });
});

describe('D-17 independent parse of groups / confidence / effort', () => {
  it('returns fail_open on empty input', () => {
    expect(parseWalkthroughEnrichmentResponse('')).toEqual({ kind: 'fail_open', reason: 'empty_response' });
  });

  it('keeps valid groups even when confidence / effort are malformed', () => {
    const raw = JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      confidence: { score: 'high', label: '' }, // invalid score type + empty label
      effort: 'not-an-object',
    });

    const result = parseWalkthroughEnrichmentResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.groups).toEqual([{ label: 'API', paths: ['src/a.ts'] }]);
      expect(result.confidence).toBeNull();
      expect(result.effort).toBeNull();
    }
  });

  it('returns fail_open when all three fields are invalid', () => {
    const raw = JSON.stringify({
      groups: 'not-an-array',
      confidence: 42,
      effort: { level: 99 }, // out of range
    });
    expect(parseWalkthroughEnrichmentResponse(raw)).toEqual({ kind: 'fail_open', reason: 'all_fields_invalid' });
  });

  it('tolerates a missing groups array when confidence and effort are valid', () => {
    const raw = JSON.stringify({
      confidence: { score: 3, label: 'Needs review', reason: 'r' },
      effort: { level: 2, label: 'Small', minutes: 30 },
    });
    const result = parseWalkthroughEnrichmentResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.groups).toEqual([]);
      expect(result.confidence?.score).toBe(3);
      expect(result.effort?.minutes).toBe(30);
    }
  });

  it('drops individual group entries with malformed paths arrays', () => {
    const raw = JSON.stringify({
      groups: [
        { label: 'Good', paths: ['src/a.ts'] },
        { label: 'Bad', paths: 'not-an-array' },
        { label: 'Also good', paths: ['src/b.ts'] },
      ],
    });
    const result = parseWalkthroughEnrichmentResponse(raw);
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      // Two groups survive (Good, Also good); the malformed non-array group drops silently.
      expect(result.groups.length).toBe(2);
      const labels = result.groups.map((g) => g.label).sort();
      expect(labels).toEqual(['Also good', 'Good']);
    }
  });
});

describe('enrichment absent path stays byte-identical (NREG-01)', () => {
  it('omits groups + assessment when enrichment is null', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments = [makeComment('src/a.ts', 'P2')];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: null,
    });

    expect(data.groups).toBeUndefined();
    expect(data.assessment).toBeUndefined();
    // flat path still populated
    expect(data.files.length).toBe(1);
    expect(data.files[0].path).toBe('src/a.ts');
  });

  it('omits groups + assessment when enrichment argument is undefined', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments = [makeComment('src/a.ts', 'P2')];

    const data = buildWalkthroughData({ reviews, finalComments });

    expect(data.groups).toBeUndefined();
    expect(data.assessment).toBeUndefined();
  });
});

describe('D-04 thread totals survive enriched projection unchanged', () => {
  it('severityCounts are computed from finalComments regardless of enrichment', () => {
    const reviews = [makeRow('src/a.ts'), makeRow('src/b.ts')];
    const finalComments = [
      makeComment('src/a.ts', 'P0'),
      makeComment('src/b.ts', 'P2'),
      makeComment('src/b.ts', 'P2'),
    ];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [{ label: 'Auth', paths: ['src/a.ts'] }], confidence: null, effort: null },
    });

    expect(data.severityCounts.P0).toBe(1);
    expect(data.severityCounts.P2).toBe(2);
  });

  it('filesReviewed mirrors mainReviews length, not groups length', () => {
    const reviews = [makeRow('src/a.ts'), makeRow('src/b.ts'), makeRow('src/c.ts')];
    const finalComments: ParsedReviewComment[] = [];

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [{ label: 'All', paths: ['src/a.ts'] }], confidence: null, effort: null },
    });

    expect(data.filesReviewed).toBe(3);
  });
});

describe('D-15 effort field is preserved verbatim through projection', () => {
  it('preserves effort label and minutes exactly', () => {
    const reviews = [makeRow('src/a.ts')];
    const finalComments: ParsedReviewComment[] = [];

    const effort: WalkthroughEffort = { level: 3, label: 'Medium', minutes: 120 };

    const data = buildWalkthroughData({
      reviews,
      finalComments,
      enrichment: { groups: [], confidence: null, effort },
    });

    expect(data.assessment?.effort).toEqual(effort);
  });
});
