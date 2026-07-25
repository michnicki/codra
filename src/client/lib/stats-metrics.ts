// UI-03 stats bar/percent + performance formatting (Plan 16-02, Task 3).
//
// Pure helpers consumed by MetricsGrid severity/category bars + KPI tiles in Plan 16-05. No
// React/DOM imports so the clamp, null -> '—', and zero-fill contracts are node-testable.
import { formatDuration } from '@client/lib/utils';
import {
  reviewSeverities,
  reviewCategories,
  type ReviewSeverity,
  type ReviewCategory,
} from '@shared/schema';

// Bar width as an integer percent, generalizing the local `percent` helper at stats.tsx:47-50.
// Returns 0 when max is falsy (zero denominator -> 0%-width track, never a hidden row / NaN) and
// clamps the result to the inclusive 0..100 range so a negative or value>max input never escapes the
// declared contract (REVIEW LOW clamp).
export function barPercent(value: number, max: number): number {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

// Perf-duration display: delegate to the shared formatDuration and supply the em-dash it lacks
// (formatDuration returns '' — not '—' — on null; utils.ts:14).
export function formatPerfDuration(ms: number | null): string {
  return formatDuration(ms) || '—';
}

// Confidence display: a rounded percent for a 0..1 value, the em-dash on null.
export function formatConfidencePercent(v: number | null): string {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

// REVIEW #1 zero-fill: db/stats.ts (stats.ts:91-113) GROUP BYs and omits zero-count bands from the
// payload entirely, so an empty or sparse severities array still must yield all five bands at 0.
// Build a lookup from the payload rows, then map over the static enum returning `count ?? 0` per
// band (order = reviewSeverities).
export function normalizeSeverityCounts(
  rows: { severity: ReviewSeverity; count: number }[],
): { severity: ReviewSeverity; count: number }[] {
  const lookup = new Map(rows.map((row) => [row.severity, row.count]));
  return reviewSeverities.map((severity) => ({ severity, count: lookup.get(severity) ?? 0 }));
}

// REVIEW #1 zero-fill, same as normalizeSeverityCounts but over the reviewCategories enum.
export function normalizeCategoryCounts(
  rows: { category: ReviewCategory; count: number }[],
): { category: ReviewCategory; count: number }[] {
  const lookup = new Map(rows.map((row) => [row.category, row.count]));
  return reviewCategories.map((category) => ({ category, count: lookup.get(category) ?? 0 }));
}
