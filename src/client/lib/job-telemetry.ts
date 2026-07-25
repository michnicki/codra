// UI-02 job-detail telemetry transforms (Plan 16-02, Task 1).
//
// Pure, fail-open display helpers consumed by the job-detail JSX in Plan 16-04 (comment-card,
// JobSeveritySummary, CriticPanel). No React/DOM imports — every function is node-testable so the
// fail-open landmines (null confidence omitted, absent category -> 'correctness', absent/skipped
// criticResult, malformed/reversed dates) are Nyquist-verifiable without the blocked browser env.
import {
  reviewSeverities,
  reviewCategories,
  type ParsedReviewComment,
  type ReviewSeverity,
  type ReviewCategory,
  type CriticResult,
} from '@shared/schema';

// Tally every finding into its severity band, zero-filling absent bands so the summary strip always
// renders all five bands (an all-zero job still shows P0..nit at 0). Scope note (D-05): the input is
// the SAME candidate set the finding cards display (persisted drafted candidates), NOT the posted
// comment count (job.commentCount).
export function countSeverities(comments: ParsedReviewComment[]): Record<ReviewSeverity, number> {
  const counts = Object.fromEntries(reviewSeverities.map((s) => [s, 0])) as Record<ReviewSeverity, number>;
  for (const comment of comments) {
    counts[comment.severity] += 1;
  }
  return counts;
}

// finishedAt − startedAt in ms. Returns null (never NaN, never negative, never throws) when either
// timestamp is null/undefined, either parse is non-finite, or the pair is reversed — mirroring the
// existing Number.isFinite guard idiom at job-meta-cards.tsx:13-20 (REVIEW #7).
export function jobDurationMs(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): number | null {
  if (startedAt == null || finishedAt == null) return null;
  const started = new Date(startedAt).getTime();
  const finished = new Date(finishedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  if (finished < started) return null;
  return finished - started;
}

// Round a 0..1 model confidence to a 0..100 integer; pass null/undefined through as null so the
// consumer omits the chip entirely (never 'N/A', never a misleading 0%).
export function confidencePercent(confidence: number | null | undefined): number | null {
  if (confidence == null) return null;
  return Math.round(confidence * 100);
}

// Return the persisted category when it is a known band, else fall back to the schema default
// 'correctness' (D-07) so the card never blanks on an absent/unknown category.
export function displayCategory(category: string | null | undefined): ReviewCategory {
  if (category != null && (reviewCategories as readonly string[]).includes(category)) {
    return category as ReviewCategory;
  }
  return 'correctness';
}

// D-06: false for null/undefined so the Critic panel is not rendered at all (no empty placeholder).
export function hasCriticResult(criticResult: CriticResult | null | undefined): boolean {
  return criticResult != null;
}

// D-06 (REVIEW #6): true when the critic bypassed its model call (skip-threshold / char-budget /
// fail-open) — the panel distinguishes 'skipped (kept all)' from a genuine 0-pruned evaluation.
export function isCriticSkipped(criticResult: CriticResult | null | undefined): boolean {
  return criticResult?.skipped === true;
}
