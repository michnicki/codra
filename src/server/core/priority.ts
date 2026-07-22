import type { FileDiff } from './diff';

// Pure, deterministic priority scorer (PRIO-01). No I/O, no DB, no config, no logging —
// trivially unit-testable (test/priority.spec.ts). Style mirrors core/severity.ts: plain named
// exports, no class, `as const` keyword arrays. The scorer produces a SOFT ordering only — it
// returns a number and NEVER drops/filters a file (the sole content-based drop this phase adds is
// the generated detector in Plan 15-03). The only input is the (attacker-influenced) file.path,
// lower-cased once and matched with plain `String.includes` (non-backtracking, linear — threat
// T-15-02-01); a false-positive substring costs at most one review slot for the ±5 tiers (D-08).

// SENSITIVE (+5): security/infra-adjacent paths that deserve an earlier review slot. Hardcoded and
// NOT config-extensible (D-07). Singular stems so plurals also match ('secret' matches 'secrets').
// Weights are locked verbatim by PRIO-01/SC1 — do not re-decide (D-06).
export const SENSITIVE_KEYWORDS = [
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
] as const;

// LOW_PRIORITY (-5): tests/docs/generated-adjacent paths that can cede a slot. Hardcoded, NOT
// config-extensible (D-07). Singular stems match plurals ('test' matches 'tests', 'example'
// matches 'examples').
export const LOW_PRIORITY_KEYWORDS = ['test', 'docs', 'example', 'generated', 'dist', 'build'] as const;

// NEVER_REVIEW (-100): lockfiles / minified bundles / sourcemaps. Mostly belt-and-suspenders since
// the glob filter (diff.ts isReviewableFile) removes these before scoring. Hardcoded, NOT
// config-extensible (D-07). The bare 'lock' stem is INTENTIONALLY excluded: a bare 'lock' substring
// would score genuine source paths (src/lock-manager.ts, clock.ts, blocklist.ts,
// deadlock-detector.ts) at -100 and near-guarantee their exclusion on a max_files-capped PR. The
// -100 blast radius is therefore anchored to the lockfile noun only: '.lock' covers *.lock
// (yarn.lock), 'package-lock' and '-lock.' anchor package-lock.json / composer.lock / bun.lockb /
// hyphenated lockfiles. D-08's low-harm substring-FP tolerance applies ONLY to the ±5 tiers, where a
// false match costs one slot — NOT to the -100 tier, where a false match is a near-certain exclusion.
export const NEVER_REVIEW_KEYWORDS = ['.lock', 'package-lock', '-lock.', '.min.', '.map'] as const;

// The size-bonus numerator: the count of ADDED + DELETED hunk lines — NOT file.lineCount.
// parseUnifiedDiff increments lineCount for context lines too (diff.ts:191/203/214), so lineCount/50
// would grant the full +5 to a large-but-mostly-context diff with few real changes. 'changes' per
// PRIO-01 means additions+deletions (conventional diff meaning) — resolves the cross-AI lineCount
// finding (Codex MEDIUM / OpenCode C6 / Antigravity LOW).
function countChanges(file: FileDiff): number {
  return file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add' || l.kind === 'del').length, 0);
}

/**
 * Score a single file for review priority (PRIO-01). Pure, deterministic, I/O-free. Higher = higher
 * priority. Additive (D-08): keyword tiers stack, so a path matching both a sensitive and a
 * low-priority keyword nets out (+5 -5 = 0). Weights are locked verbatim by PRIO-01/SC1 (D-06).
 *
 * Returns a number ONLY — never drops, filters, or excludes a file (priority is a soft ordering).
 */
export function scoreFile(file: FileDiff): number {
  const path = file.path.toLowerCase();

  let score = 0;

  // Additive keyword tiers (each tier applies at most once, regardless of how many of its keywords hit).
  if (SENSITIVE_KEYWORDS.some((kw) => path.includes(kw))) score += 5;
  if (LOW_PRIORITY_KEYWORDS.some((kw) => path.includes(kw))) score -= 5;
  if (NEVER_REVIEW_KEYWORDS.some((kw) => path.includes(kw))) score -= 100;

  // Size bonus: saturates at 5 once >=250 lines changed, 0 at no changes.
  score += Math.min(5, countChanges(file) / 50);

  // Change-type nudge: new files reviewed first, deletions last, plain modifications in the middle.
  score += file.isNew ? 1 : file.isDeleted ? -1 : 0.5;

  return score;
}
