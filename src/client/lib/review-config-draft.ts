import type { RepoConfig, ReviewCategory } from '@shared/schema';

// Pure, node-testable config-editing transforms for the UI-01 repo-config editor.
// This module MUST NOT import React, DOM, or motion — it loads in the node vitest
// project so the load-bearing NREG-02 round-trip invariant can be unit-tested
// without the blocked headless-browser environment.

type ReviewConfig = RepoConfig['review'];

// The controlled-sub-editor draft shape the ReviewSettingsPanel (Plan 16-03) reports
// up to the modal: the full review object it would PATCH, plus dirty/valid flags.
export interface ReviewSettingsDraft {
  review: ReviewConfig;
  dirty: boolean;
  valid: boolean;
}

/**
 * NREG-02 shallow-merge-preservation reducer. Builds the single review object the
 * modal PATCHes on one Apply. Spreads the FULL current review FIRST so every
 * untouched nested key (mention_trigger, category_confidence, threads, rounds, …)
 * survives a partial edit, then overlays the settings-fields object, then applies
 * the fresh interactive draft LAST.
 *
 * The interactive-last ordering is the REVIEW #4 fix: when `settingsFields` is a
 * full review object that carries its own (stale) `interactive` block, a
 * simultaneously-edited fresh interactive draft must still win — so `interactive`
 * is spread after `settingsFields`, never before it.
 */
export function mergeReviewPatch(
  currentReview: ReviewConfig,
  interactive: ReviewConfig['interactive'] | null,
  settingsFields: Partial<ReviewConfig> | null,
): ReviewConfig {
  return {
    ...currentReview,
    ...(settingsFields ?? {}),
    ...(interactive ? { interactive } : {}),
  };
}

/**
 * Sparse `z.partialRecord` builder for the per-category confidence overrides
 * (category_confidence, schema.ts:236). For each raw string input: trim, skip when
 * empty/whitespace (inherit the global min_confidence), parse with Number(), and
 * keep only when the value is finite and within 0..1 inclusive. Out-of-range and
 * non-numeric inputs are DROPPED (never clamped to 0). Absent categories are never
 * back-filled — a sparse edit stays sparse (Zod 4 z.partialRecord contract).
 */
export function buildCategoryConfidence(
  inputs: Record<string, string>,
): Partial<Record<ReviewCategory, number>> {
  const out: Partial<Record<ReviewCategory, number>> = {};
  for (const [category, raw] of Object.entries(inputs)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      out[category as ReviewCategory] = n;
    }
  }
  return out;
}

/**
 * Order-insensitive, deduped set comparator for string arrays. Replaces the
 * order-sensitive stringArraysEqual (repos.tsx:81) for `on`/`focus` dirty tracking
 * so reordering the selected triggers/categories does NOT read as dirty (REVIEW #8).
 */
export function stringSetEqual(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const value of setA) {
    if (!setB.has(value)) return false;
  }
  return true;
}

/**
 * Nested comparator for the sparse category_confidence override map (REVIEW #8).
 * Treats undefined as the empty override map, unions the keys of both, and returns
 * false if any key's value differs — so a no-op category-confidence edit does not
 * mark the draft dirty and key order is irrelevant.
 */
export function categoryConfidenceEqual(
  a: Partial<Record<ReviewCategory, number>> | undefined,
  b: Partial<Record<ReviewCategory, number>> | undefined,
): boolean {
  const objA = a ?? {};
  const objB = b ?? {};
  const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
  for (const key of keys) {
    if (objA[key as ReviewCategory] !== objB[key as ReviewCategory]) return false;
  }
  return true;
}
