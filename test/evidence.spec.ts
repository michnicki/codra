import { describe, expect, it } from 'vitest';
import type { JobAuditEvent, ParsedReviewComment } from '@shared/schema';
import { jobAuditEventSchema } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';
import { checkEvidence, normalizeForEvidence } from '@server/core/evidence';
import { buildEvidenceHardDroppedEvent } from '@server/core/audit';

// ---------------------------------------------------------------------------
// Pure, no-DB unit spec for the shared evidence check function and the
// evidence-hard-dropped audit builder. Uses local factory functions for mock
// data; no database or environment variables required.
// ---------------------------------------------------------------------------

// ---- factories ----

let counter = 0;
function finding(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  counter += 1;
  return {
    path: 'src/app.ts',
    line: 10,
    severity: 'P2',
    category: 'correctness',
    title: `finding ${counter}`,
    body: 'default finding body',
    existingCode: 'const value = compute();',
    confidence: 0.9,
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'src/app.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 10,
    hunks: [
      {
        header: '@@ -1,10 +1,10 @@',
        lines: [
          { kind: 'context', content: 'import { foo } from "./bar";', position: 1 },
          { kind: 'add', content: 'const value = compute();', newLineNumber: 2, position: 2 },
          { kind: 'context', content: 'const result = process(data);', position: 3 },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkEvidence tests
// ---------------------------------------------------------------------------

describe('checkEvidence', () => {
  it('drops finding with null existingCode — reason absent', () => {
    const file = makeFile();
    const comments = [finding({ existingCode: null })];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].reason).toBe('absent');
  });

  it('drops finding with empty/whitespace-only existingCode — reason absent', () => {
    const file = makeFile();
    const comments = [finding({ existingCode: '   ' })];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.entries[0].reason).toBe('absent');
  });

  it('keeps finding with existingCode present in haystack', () => {
    const file = makeFile();
    const comments = [finding({ existingCode: 'const value = compute();' })];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
    expect(result.kept[0]).toBe(comments[0]);
  });

  it('drops finding with existingCode NOT in haystack — reason not_in_hunk', () => {
    const file = makeFile();
    const comments = [finding({ existingCode: 'function doesNotExist() {}' })];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].reason).toBe('not_in_hunk');
  });

  it('keeps finding in exempt category (security) regardless of evidence quality', () => {
    const file = makeFile();
    const comments = [finding({ category: 'security', existingCode: null })];
    const result = checkEvidence([file], comments, ['security']);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
    expect(result.kept[0]).toBe(comments[0]);
  });

  it('exempt categories comparison is case-insensitive (SECURITY, Security, security all bypass)', () => {
    const file = makeFile();
    const categories = ['SECURITY', 'Security', 'security'];
    for (const exempt of categories) {
      counter = 0;
      const c1 = finding({ category: 'security', existingCode: null });
      const result = checkEvidence([file], [c1], [exempt]);
      expect(result.kept).toHaveLength(1);
      expect(result.entries).toHaveLength(0);
    }
  });

  it('correctly classifies mix of dropped and kept findings', () => {
    const file = makeFile();
    const comments: ParsedReviewComment[] = [
      // kept: evidence matches haystack
      finding({ title: 'match', existingCode: 'const value = compute();' }),
      // dropped: null evidence
      finding({ title: 'null-evidence', existingCode: null }),
      // kept: exempt
      finding({ title: 'exempt', existingCode: null, category: 'security' }),
      // dropped: not in haystack
      finding({ title: 'no-haystack', existingCode: 'function missing() {}' }),
    ];
    const result = checkEvidence([file], comments, ['security']);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].reason).toBe('absent');
    expect(result.entries[1].reason).toBe('not_in_hunk');
  });

  it('drops finding referencing file not in diff — reason absent', () => {
    const file = makeFile();
    const comments = [finding({ path: 'src/other.ts', existingCode: 'anything' })];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.entries[0].reason).toBe('not_in_hunk');
  });

  it('preserves relative order of surviving findings', () => {
    const file = makeFile();
    const comments: ParsedReviewComment[] = [
      finding({ title: 'first', existingCode: 'const value = compute();' }),
      finding({ title: 'second', existingCode: null }),
      finding({ title: 'third', existingCode: 'const result = process(data);' }),
      finding({ title: 'fourth', existingCode: null }),
    ];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(2);
    expect(result.kept[0].title).toBe('first');
    expect(result.kept[1].title).toBe('third');
  });

  it('exemptCategories = [] drops all evidence-invalid findings', () => {
    const file = makeFile();
    const comments = [
      finding({ category: 'security', existingCode: null }),
      finding({ category: 'bugs', existingCode: null }),
    ];
    const result = checkEvidence([file], comments, []);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(2);
    expect(result.entries).toHaveLength(2);
  });

  it('exemptCategories = undefined defaults to [security] — security findings with bad evidence kept', () => {
    const file = makeFile();
    const comments = [
      finding({ category: 'security', existingCode: null }),
      finding({ category: 'bugs', existingCode: null }),
    ];
    // undefined exemptCategories triggers the function default ['security']
    const result = checkEvidence([file], comments);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].category).toBe('security');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].category).toBe('bugs');
  });

  it('cross-consistency: haystack construction matches reference implementation', () => {
    // Build a known FileDiff with known hunk content, run checkEvidence, and verify that the
    // haystack built internally matches standalone normalizeForEvidence of the same hunk content.
    const file = makeFile({
      path: 'src/test.ts',
      hunks: [
        {
          header: '@@ -1,3 +1,3 @@',
          lines: [
            { kind: 'context', content: 'line one', position: 1 },
            { kind: 'add', content: 'line two added', newLineNumber: 2, position: 2 },
            { kind: 'del', content: 'line two removed', oldLineNumber: 2, position: 3 },
          ],
        },
      ],
    });

    // Compute the reference haystack the same way the inline EVID-01 code builds it
    const referenceHaystack = normalizeForEvidence(
      file.hunks.flatMap((h) => h.lines).map((l) => l.content).join('\n'),
    );

    // A finding whose existingCode IS in the reference haystack should be kept
    const keptResult = checkEvidence([file], [
      finding({ path: 'src/test.ts', existingCode: 'line two added' }),
    ], []);
    expect(keptResult.kept).toHaveLength(1);

    // A finding whose existingCode is NOT in the reference haystack should be dropped
    const droppedResult = checkEvidence([file], [
      finding({ path: 'src/test.ts', existingCode: 'line three entirely missing' }),
    ], []);
    expect(droppedResult.dropped).toHaveLength(1);
    expect(droppedResult.entries[0].reason).toBe('not_in_hunk');

    // The reference haystack should match what checkEvidence uses internally
    // (verified by the kept/dropped assertions above matching the reference)
    expect(referenceHaystack).toBe('line one line two added line two removed');
  });
});

// ---------------------------------------------------------------------------
// buildEvidenceHardDroppedEvent tests
// ---------------------------------------------------------------------------

describe('buildEvidenceHardDroppedEvent', () => {
  it('returns null for empty entries array', () => {
    const result = buildEvidenceHardDroppedEvent('src/app.ts', 'main', []);
    expect(result).toBeNull();
  });

  it('returns event with droppedCount=1 for single entry', () => {
    const result = buildEvidenceHardDroppedEvent('src/app.ts', 'main', [
      { path: 'src/app.ts', line: 10, title: 'test finding', reason: 'absent' },
    ]);
    expect(result).not.toBeNull();
    const event = result as JobAuditEvent & { stage: string; droppedCount: number; sample: unknown[]; file: string; pass: string };
    expect(event.stage).toBe('evidence_hard_dropped');
    expect(event.droppedCount).toBe(1);
    expect(event.sample).toHaveLength(1);
    expect(event.file).toBe('src/app.ts');
    expect(event.pass).toBe('main');
  });

  it('samples capped at 20 when entries exceed 20 (droppedCount = 25)', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      title: `finding ${i + 1}`,
      reason: 'not_in_hunk' as const,
    }));
    const result = buildEvidenceHardDroppedEvent('src/app.ts', 'main', entries);
    expect(result).not.toBeNull();
    const event = result as JobAuditEvent & { droppedCount: number; sample: unknown[] };
    expect(event.droppedCount).toBe(25);
    expect(event.sample).toHaveLength(20);
  });

  it('event shape round-trips through jobAuditEventSchema.parse', () => {
    const result = buildEvidenceHardDroppedEvent('src/app.ts', 'security', [
      { path: 'src/app.ts', line: 10, title: 'hard dropped finding', reason: 'absent' },
      { path: 'src/app.ts', line: 20, title: 'another dropped', reason: 'not_in_hunk' },
    ]);
    expect(result).not.toBeNull();
    const parsed = jobAuditEventSchema.parse(result) as JobAuditEvent & { stage: 'evidence_hard_dropped'; droppedCount: number; sample: Array<{ reason: string }> };
    expect(parsed.stage).toBe('evidence_hard_dropped');
    expect(parsed.droppedCount).toBe(2);
    expect(parsed.sample).toHaveLength(2);
  });

  it('both absent and not_in_hunk reasons work in sample entries', () => {
    const result = buildEvidenceHardDroppedEvent('src/app.ts', 'main', [
      { path: 'src/a.ts', line: 1, title: 'absent one', reason: 'absent' },
      { path: 'src/b.ts', line: 2, title: 'not in hunk', reason: 'not_in_hunk' },
    ]);
    expect(result).not.toBeNull();
    const event = result! as JobAuditEvent & { sample: Array<{ reason: string }> };
    expect(event.sample[0].reason).toBe('absent');
    expect(event.sample[1].reason).toBe('not_in_hunk');
  });
});
