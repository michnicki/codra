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
  // SEC-XDIFF-01 (D-14): additional security-adjacent paths for cross-file diff prioritization.
  // These keywords catch middleware, route definitions, and session handling files that are
  // high-signal for cross-file security reasoning (auth boundaries, access control, session lifecycle).
  'middleware',
  'routes',
  'session',
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
 * The PATH-DERIVED half of `scoreFile`, callable with nothing but a path (QA-IDX-01, D-09).
 *
 * This exists because the codebase index build has a path and NO diff. The obvious alternative --
 * fabricating a `FileDiff` from full file content so `scoreFile` can be reused directly -- type-checks
 * and runs, but silently collapses the ranking to keyword tiers only: `countChanges` counts only
 * `add`/`del` hunk lines, so an all-`context` shim always scores 0 on the size bonus, and the
 * new/deleted/modified nudge degenerates to the same constant for every file. The result looks like a
 * priority ordering and is not one. Extracting the path tiers makes the honest half reusable and the
 * missing half obviously absent.
 *
 * Same tier semantics as `scoreFile`: lower-cased once, plain `String.includes` (non-backtracking,
 * linear -- threat T-15-02-01), each tier applying AT MOST ONCE regardless of how many of its
 * keywords hit, and additive across tiers (+5 -5 = 0). Weights are locked verbatim by PRIO-01/SC1.
 */
export function scorePath(path: string): number {
  const lowerCasedPath = path.toLowerCase();

  let score = 0;

  // Additive keyword tiers (each tier applies at most once, regardless of how many of its keywords hit).
  if (SENSITIVE_KEYWORDS.some((kw) => lowerCasedPath.includes(kw))) score += 5;
  if (LOW_PRIORITY_KEYWORDS.some((kw) => lowerCasedPath.includes(kw))) score -= 5;
  if (NEVER_REVIEW_KEYWORDS.some((kw) => lowerCasedPath.includes(kw))) score -= 100;

  return score;
}

/**
 * Score a single file for review priority (PRIO-01). Pure, deterministic, I/O-free. Higher = higher
 * priority. Additive (D-08): keyword tiers stack, so a path matching both a sensitive and a
 * low-priority keyword nets out (+5 -5 = 0). Weights are locked verbatim by PRIO-01/SC1 (D-06).
 *
 * Returns a number ONLY — never drops, filters, or excludes a file (priority is a soft ordering).
 *
 * QA-IDX-01: the keyword tiers now live in `scorePath` and this function ADDS the two components
 * that genuinely need a `FileDiff`. Signature and numeric results are unchanged (NREG-01) and
 * test/code-index-selection.spec.ts pins them against explicit expected numbers.
 */
export function scoreFile(file: FileDiff): number {
  let score = scorePath(file.path);

  // Size bonus: saturates at 5 once >=250 lines changed, 0 at no changes.
  score += Math.min(5, countChanges(file) / 50);

  // Change-type nudge: new files reviewed first, deletions last, plain modifications in the middle.
  score += file.isNew ? 1 : file.isDeleted ? -1 : 0.5;

  return score;
}
