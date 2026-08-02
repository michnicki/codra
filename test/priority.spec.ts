import {
  scoreFile,
  SENSITIVE_KEYWORDS,
  LOW_PRIORITY_KEYWORDS,
  NEVER_REVIEW_KEYWORDS,
} from '@server/core/priority';
import type { FileDiff, DiffLine } from '@server/core/diff';

// Build a FileDiff with `adds` added lines, `dels` deleted lines, and `contexts` context lines
// packed into a single hunk. Only add|del lines count toward countChanges (the size-bonus numerator);
// context lines inflate file.lineCount but MUST NOT feed the size bonus.
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

describe('scoreFile — locked additive weights (PRIO-01/SC1, D-06/D-07/D-08)', () => {
  it('sensitive + modified, 0 changed lines → +5 +0 +0.5 = 5.5', () => {
    expect(scoreFile(makeFile({ path: 'src/auth/login.ts' }))).toBe(5.5);
  });

  it('nets out a path matching BOTH sensitive and low-priority (additive): docs/oauth-notes.md → +5 -5 +0.5 = 0.5', () => {
    expect(scoreFile(makeFile({ path: 'docs/oauth-notes.md' }))).toBe(0.5);
  });

  it('new file, size saturates at 250 changed lines → 0 +5 +1 = 6', () => {
    expect(scoreFile(makeFile({ path: 'src/util.ts', isNew: true }, 250))).toBe(6);
  });

  it('deleted file, 0 changed lines → 0 +0 -1 = -1', () => {
    expect(scoreFile(makeFile({ path: 'src/util.ts', isDeleted: true }))).toBe(-1);
  });

  it('never-review dominates: assets/app.min.js.map with 100 add lines → -100 +min(5,2) +0.5 = -97.5', () => {
    expect(scoreFile(makeFile({ path: 'assets/app.min.js.map' }, 100))).toBe(-97.5);
  });

  it('changes-vs-context: 5 add + 300 context → size = min(5, 5/50) = 0.1, NOT +5 (context excluded)', () => {
    // modified, no keyword: 0 + 0.1 (size) + 0.5 (modified) = 0.6
    expect(scoreFile(makeFile({ path: 'src/util.ts' }, 5, 0, 300))).toBe(0.6);
  });

  it('size-bonus min-cap boundaries at 1/249/250/251 changed lines → 0.02 / 4.98 / 5 / 5', () => {
    // modified (+0.5) added on top of the size bonus
    expect(scoreFile(makeFile({ path: 'src/util.ts' }, 1))).toBeCloseTo(0.52, 10); // 0.02 + 0.5
    expect(scoreFile(makeFile({ path: 'src/util.ts' }, 249))).toBeCloseTo(5.48, 10); // 4.98 + 0.5
    expect(scoreFile(makeFile({ path: 'src/util.ts' }, 250))).toBe(5.5); // 5 + 0.5
    expect(scoreFile(makeFile({ path: 'src/util.ts' }, 251))).toBe(5.5); // 5 + 0.5
  });

  it('the raw size bonus is 0 at 0 changed lines and exactly 5 at >=250 (isolating changeType via deletion)', () => {
    // deleted (-1) so score = sizeBonus - 1; 0 changes → -1, 250 changes → 4
    expect(scoreFile(makeFile({ path: 'src/util.ts', isDeleted: true }))).toBe(-1);
    expect(scoreFile(makeFile({ path: 'src/util.ts', isDeleted: true }, 0, 250))).toBe(4);
  });

  it('TIE: two distinct files with identical shape produce an identical score (tie is reachable; ordering asserted in 15-03)', () => {
    const a = scoreFile(makeFile({ path: 'src/a.ts' }));
    const b = scoreFile(makeFile({ path: 'src/b.ts' }));
    expect(a).toBe(b);
    expect(a).toBe(0.5);
  });

  it('substring false-positive is accepted (low-harm, D-08): src/author.ts matches "auth" → +5, returns a number and does not throw', () => {
    const score = scoreFile(makeFile({ path: 'src/author.ts' }));
    expect(typeof score).toBe('number');
    expect(score).toBe(5.5); // +5 (auth) + 0.5 (modified)
  });

  it('is case-insensitive on the path (Dockerfile / TERRAFORM match)', () => {
    expect(scoreFile(makeFile({ path: 'ops/Dockerfile' }))).toBe(5.5);
    expect(scoreFile(makeFile({ path: 'infra/MAIN.TERRAFORM' }))).toBe(5.5); // 'infra' + 'terraform' both sensitive → still one +5
  });

  it('plurals match via singular stems: "tests/foo.spec.ts" and "examples/x.ts" are low-priority', () => {
    expect(scoreFile(makeFile({ path: 'tests/foo.spec.ts' }))).toBe(-4.5); // -5 (test) + 0.5
    expect(scoreFile(makeFile({ path: 'examples/x.ts' }))).toBe(-4.5); // -5 (example) + 0.5
  });

  it('never drops/filters: always returns a finite number for a plain source file', () => {
    const score = scoreFile(makeFile({ path: 'src/index.ts' }, 10));
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe('priority keyword constants (D-07: hardcoded, not config-extensible)', () => {
  it('exposes the exact locked keyword lists', () => {
    expect(SENSITIVE_KEYWORDS).toEqual([
      'auth',
      'payment',
      'admin',
      'secret',
      'crypto',
      'migration',
      'dockerfile',
      'deploy',
      'infra',
      'terraform',
      // Appended by SEC-XDIFF-01 (D-14) in Phase 27 for cross-file security prioritization.
      'middleware',
      'routes',
      'session',
    ]);
    expect(LOW_PRIORITY_KEYWORDS).toEqual(['test', 'docs', 'example', 'generated', 'dist', 'build']);
    expect(NEVER_REVIEW_KEYWORDS).toEqual(['.lock', 'package-lock', '-lock.', '.min.', '.map']);
  });
});
