import { describe, expect, it } from 'vitest';
import {
  scoreFile,
  scorePath,
  SENSITIVE_KEYWORDS,
  LOW_PRIORITY_KEYWORDS,
  NEVER_REVIEW_KEYWORDS,
} from '@server/core/priority';
import { isGeneratedContent, isGeneratedFile, GENERATION_MARKERS } from '@server/core/diff';
import type { DiffLine, FileDiff } from '@server/core/diff';

/**
 * QA-IDX-01 (D-09) — the two Phase 15 selection helpers, extracted ADDITIVELY into the path-shaped
 * and content-shaped forms the codebase index build can actually call.
 *
 * The delegation cases are the POINT of this spec, not the new helpers. `scoreFile` and
 * `isGeneratedFile` are on the live review path; the extraction must not move a single number or
 * boolean. They are therefore asserted against explicit expected values, so a future refactor of the
 * extraction cannot silently change review-path behavior. Pure module, no database, no network.
 */

// Same fixture builder as test/priority.spec.ts: only add|del lines feed countChanges (the size-bonus
// numerator); context lines inflate lineCount and MUST NOT feed the bonus.
function makeFile(overrides: Partial<FileDiff> & { path: string }, adds = 0, dels = 0, contexts = 0): FileDiff {
  const lines: DiffLine[] = [];
  let position = 0;
  for (let i = 0; i < adds; i++) lines.push({ kind: 'add', content: `add ${i}`, newLineNumber: i + 1, position: ++position });
  for (let i = 0; i < dels; i++) lines.push({ kind: 'del', content: `del ${i}`, oldLineNumber: i + 1, position: ++position });
  for (let i = 0; i < contexts; i++)
    lines.push({ kind: 'context', content: `ctx ${i}`, oldLineNumber: i + 1, newLineNumber: i + 1, position: ++position });
  return {
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: adds + dels + contexts,
    hunks: lines.length ? [{ header: '@@', lines }] : [],
    ...overrides,
  };
}

function makeFileWithHunks(path: string, hunkContents: string[][]): FileDiff {
  let position = 0;
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: hunkContents.reduce((n, hunk) => n + hunk.length, 0),
    hunks: hunkContents.map((contents) => ({
      header: '@@',
      lines: contents.map((content) => ({ kind: 'context' as const, content, oldLineNumber: 1, newLineNumber: 1, position: ++position })),
    })),
  };
}

describe('scorePath — the path-derived tiers, callable without a diff (QA-IDX-01, D-09)', () => {
  it('returns the sensitive-keyword bonus for a sensitive path: src/server/core/auth.ts → +5', () => {
    expect(scorePath('src/server/core/auth.ts')).toBe(5);
  });

  it('returns the low-priority penalty for a test path: test/foo.spec.ts → -5', () => {
    expect(scorePath('test/foo.spec.ts')).toBe(-5);
  });

  it('returns the never-review penalty for a lockfile: package-lock.json → -100', () => {
    expect(scorePath('package-lock.json')).toBe(-100);
  });

  it('applies each tier AT MOST ONCE regardless of how many of its keywords hit', () => {
    // Three sensitive keywords (auth, admin, secret) — still exactly +5, not +15.
    expect(scorePath('src/auth/admin/secret.ts')).toBe(5);
    // Two never-review keywords ('package-lock' and '-lock.') — still exactly -100, not -200.
    expect(scorePath('package-lock.json')).toBe(-100);
    // Two low-priority keywords (docs, example) — still exactly -5.
    expect(scorePath('docs/example.md')).toBe(-5);
  });

  it('is ADDITIVE across tiers: a sensitive + low-priority path nets out to 0', () => {
    expect(scorePath('test/auth/login.spec.ts')).toBe(0);
  });

  it('is case-insensitive (the path is lower-cased once)', () => {
    expect(scorePath('SRC/Server/Core/AUTH.ts')).toBe(5);
  });

  it('scores an unremarkable path at exactly 0 (no diff-derived components leak in)', () => {
    expect(scorePath('src/util.ts')).toBe(0);
    // The two FileDiff-only components (size bonus, change-type nudge) are ABSENT by construction —
    // that absence is the whole reason scorePath exists rather than a fabricated FileDiff shim.
    expect(scorePath('src/util.ts')).not.toBe(scoreFile(makeFile({ path: 'src/util.ts' })));
  });

  it('matches every keyword array member without modifying any of them', () => {
    for (const keyword of SENSITIVE_KEYWORDS) expect(scorePath(`src/${keyword}/x.ts`)).toBeGreaterThanOrEqual(0);
    for (const keyword of LOW_PRIORITY_KEYWORDS) expect(scorePath(`x/${keyword}/y.ts`)).toBeLessThanOrEqual(0);
    for (const keyword of NEVER_REVIEW_KEYWORDS) expect(scorePath(`bundle${keyword}js`)).toBeLessThanOrEqual(-100);
  });
});

describe('scoreFile — delegates to scorePath with UNCHANGED numeric results (NREG-01)', () => {
  it('sensitive + modified, 0 changed lines → +5 +0 +0.5 = 5.5', () => {
    expect(scoreFile(makeFile({ path: 'src/auth/login.ts' }))).toBe(5.5);
  });

  it('sensitive + modified, 100 changed lines → +5 +min(5,2) +0.5 = 7.5 (size bonus survives the extraction)', () => {
    expect(scoreFile(makeFile({ path: 'src/server/core/auth.ts' }, 100))).toBe(7.5);
  });

  it('sensitive + NEW file, 300 changed lines → +5 +5 (saturated) +1 = 11', () => {
    expect(scoreFile(makeFile({ path: 'src/server/core/auth.ts', isNew: true }, 300))).toBe(11);
  });

  it('sensitive + DELETED file, 0 changed lines → +5 +0 -1 = 4 (the nudge survives the extraction)', () => {
    expect(scoreFile(makeFile({ path: 'src/server/core/auth.ts', isDeleted: true }))).toBe(4);
  });

  it('low-priority + modified, 50 changed lines → -5 +1 +0.5 = -3.5', () => {
    expect(scoreFile(makeFile({ path: 'test/foo.spec.ts' }, 50))).toBe(-3.5);
  });

  it('never-review dominates: assets/app.min.js.map with 100 add lines → -100 +2 +0.5 = -97.5', () => {
    expect(scoreFile(makeFile({ path: 'assets/app.min.js.map' }, 100))).toBe(-97.5);
  });

  it('context lines still do NOT feed the size bonus: 5 add + 300 context → 0 +0.1 +0.5 = 0.6', () => {
    expect(scoreFile(makeFile({ path: 'src/util.ts' }, 5, 0, 300))).toBe(0.6);
  });

  it('equals scorePath(path) plus the two FileDiff-only components, for every representative fixture', () => {
    const fixtures: Array<{ file: FileDiff; sizeBonus: number; nudge: number }> = [
      { file: makeFile({ path: 'src/auth/login.ts' }), sizeBonus: 0, nudge: 0.5 },
      { file: makeFile({ path: 'test/foo.spec.ts' }, 50), sizeBonus: 1, nudge: 0.5 },
      { file: makeFile({ path: 'package-lock.json', isNew: true }, 250), sizeBonus: 5, nudge: 1 },
      { file: makeFile({ path: 'src/util.ts', isDeleted: true }, 100), sizeBonus: 2, nudge: -1 },
    ];
    for (const { file, sizeBonus, nudge } of fixtures) {
      expect(scoreFile(file)).toBe(scorePath(file.path) + sizeBonus + nudge);
    }
  });
});

describe('isGeneratedContent — the content-shaped detector (QA-IDX-01, D-09)', () => {
  it('is true for text whose first 500 characters contain a marker', () => {
    expect(isGeneratedContent('// DO NOT EDIT\nexport const x = 1;')).toBe(true);
  });

  it('is case-insensitive (the candidate window is upper-cased once)', () => {
    expect(isGeneratedContent('// do not edit — this file is managed')).toBe(true);
    expect(isGeneratedContent('// Auto-Generated by the codegen step')).toBe(true);
  });

  it('recognizes every GENERATION_MARKER without modifying the array', () => {
    for (const marker of GENERATION_MARKERS) {
      expect(isGeneratedContent(`prefix ${marker.toLowerCase()} suffix`)).toBe(true);
    }
  });

  it('is false for ordinary source text', () => {
    expect(isGeneratedContent('export function add(a: number, b: number) {\n  return a + b;\n}')).toBe(false);
  });

  it('is false when the marker appears PAST character 500 (the window is bounded)', () => {
    expect(isGeneratedContent(`${'x'.repeat(501)}DO NOT EDIT`)).toBe(false);
    // ...and true when it lands just inside the window, proving 500 is the real boundary.
    expect(isGeneratedContent(`${'x'.repeat(400)}DO NOT EDIT`)).toBe(true);
  });

  it('is total: empty text returns false rather than throwing', () => {
    expect(isGeneratedContent('')).toBe(false);
  });
});

describe('isGeneratedFile — delegates to isGeneratedContent with UNCHANGED results (NREG-01)', () => {
  it('is true when a marker appears in the first hunk', () => {
    expect(isGeneratedFile(makeFileWithHunks('src/gen.ts', [['// DO NOT EDIT', 'const a = 1;']]))).toBe(true);
  });

  it('is true when a marker appears in the SECOND hunk (the window spans the first two)', () => {
    expect(isGeneratedFile(makeFileWithHunks('src/gen.ts', [['const a = 1;'], ['// @generated']]))).toBe(true);
  });

  it('is FALSE when the marker appears only AFTER the first two hunks', () => {
    expect(
      isGeneratedFile(
        makeFileWithHunks('src/gen.ts', [['const a = 1;'], ['const b = 2;'], ['// AUTO-GENERATED']]),
      ),
    ).toBe(false);
  });

  it('is FALSE when the marker appears past character 500 of the joined window', () => {
    expect(isGeneratedFile(makeFileWithHunks('src/gen.ts', [['x'.repeat(501), 'DO NOT EDIT']]))).toBe(false);
  });

  it('is total: a zero-hunk file returns false rather than throwing', () => {
    expect(isGeneratedFile(makeFileWithHunks('src/empty.ts', []))).toBe(false);
  });

  it('agrees with isGeneratedContent over the exact window it builds', () => {
    const file = makeFileWithHunks('src/gen.ts', [['const a = 1;'], ['// GENERATED BY codegen']]);
    const window = file.hunks
      .slice(0, 2)
      .flatMap((hunk) => hunk.lines)
      .map((line) => line.content)
      .join('\n');
    expect(isGeneratedFile(file)).toBe(isGeneratedContent(window));
  });
});
