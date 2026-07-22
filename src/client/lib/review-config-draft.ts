import type { RepoConfig } from '@shared/schema';

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
