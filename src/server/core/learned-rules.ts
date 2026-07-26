/**
 * Phase 28 (LRN-01): Learned-rule synthesis from reject feedback.
 *
 * Three pure functions — no I/O, never throws for valid inputs:
 *   1. clusterRejectFeedback — groups reject_feedback rows by exact (category, file_path), min size 2
 *   2. synthesizeRules — produces new pending rules from clusters, skipping duplicates across all statuses
 *   3. suppressByLearnedRules — drops findings matching active rules, returns kept + entries for audit
 *
 * The suppression pass runs in finalize AFTER EVID-02 hard-drop but BEFORE dedup (D-14).
 * All behavior is gated on config.review.learning.enabled (NREG-01 — default off).
 *
 * Zero new npm dependencies: uses picomatch (already in deps, used in core/diff.ts) for glob matching.
 */

import picomatch from 'picomatch';
import type { ParsedReviewComment } from '@shared/schema';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cluster of reject_feedback rows grouped by exact (category, file_path). */
export interface RejectCluster {
  category: string;
  filePath: string;
  rejectionIds: string[];
}

/** Entry for a finding suppressed by a learned rule. Used to build audit events. */
export interface LearnedRuleSuppressionEntry {
  path: string;
  line: number | null;
  title: string;
  matched_rule: string;
}

// ---------------------------------------------------------------------------
// clusterRejectFeedback
// ---------------------------------------------------------------------------

/**
 * Cluster reject_feedback rows by exact (finding_category, finding_file_path).
 * Only considers rows with non-null category and file_path (D-02).
 * Returns clusters with >= 2 rejections (D-04, hardcoded threshold).
 *
 * Pure function, no I/O. Uses denormalized values from reject_feedback directly
 * (populated at reject time in Plan 01 — no re-read from file_reviews.output).
 */
export function clusterRejectFeedback(
  rows: Array<{ id: string; finding_category: string | null; finding_file_path: string | null }>,
): RejectCluster[] {
  const clusters = new Map<string, { category: string; filePath: string; ids: string[] }>();

  for (const row of rows) {
    if (!row.finding_category || !row.finding_file_path) continue;
    const key = `${row.finding_category}\0${row.finding_file_path}`;
    const existing = clusters.get(key);
    if (existing) {
      existing.ids.push(row.id);
    } else {
      clusters.set(key, {
        category: row.finding_category,
        filePath: row.finding_file_path,
        ids: [row.id],
      });
    }
  }

  return [...clusters.values()]
    .filter((c) => c.ids.length >= 2)
    .map((c) => ({
      category: c.category,
      filePath: c.filePath,
      rejectionIds: c.ids,
    }));
}

// ---------------------------------------------------------------------------
// synthesizeRules
// ---------------------------------------------------------------------------

/**
 * Synthesize new pending rules from clusters, skipping duplicates.
 * A duplicate is an existing rule with the same (category, file_pattern) in ANY status
 * (pending, active, disabled) — this preserves operator decisions on re-synthesis
 * (Antigravity 1.1 — state-preserving merge).
 *
 * Each new rule gets: id (crypto.randomUUID), category, file_pattern, status='pending',
 * source_rejection_ids, created_at (ISO timestamp).
 *
 * Returns ONLY the new rules — caller appends to existing rules, never replaces.
 * Pure function, no I/O.
 */
export function synthesizeRules(
  clusters: RejectCluster[],
  existingRules: ReadonlyArray<{
    id: string;
    category: string;
    file_pattern: string;
    status: 'pending' | 'active' | 'disabled';
    source_rejection_ids: string[];
    created_at: string;
  }>,
): Array<{
  id: string;
  category: string;
  file_pattern: string;
  status: 'pending';
  source_rejection_ids: string[];
  created_at: string;
}> {
  const existingKeys = new Set(
    existingRules.map((r) => `${r.category}\0${r.file_pattern}`),
  );

  return clusters
    .filter((c) => !existingKeys.has(`${c.category}\0${c.filePath}`))
    .map((c) => ({
      id: crypto.randomUUID(),
      category: c.category,
      file_pattern: c.filePath,
      status: 'pending' as const,
      source_rejection_ids: c.rejectionIds,
      created_at: new Date().toISOString(),
    }));
}

// ---------------------------------------------------------------------------
// suppressByLearnedRules
// ---------------------------------------------------------------------------

/**
 * Suppress findings matching active learned rules.
 * Match criteria (D-07): category case-insensitive equals AND picomatch(rule.file_pattern)(finding.path).
 * No title matching, no severity threshold.
 *
 * C8 — BLOCKING: Wraps picomatch(rule.file_pattern) in try-catch. If picomatch throws
 * (invalid glob pattern, e.g. unbalanced braces), logs a warning with the rule ID and
 * pattern, and skips that rule (treats as non-matching). Does not let an invalid rule
 * pattern crash the finalize pipeline.
 *
 * Since D-03 clusters by exact finding_file_path, synthesized file_pattern values are
 * always exact file paths (not globs). picomatch handles exact paths as a subset of
 * glob patterns, so the infrastructure is ready for future operator generalization.
 *
 * Returns { kept, entries } where:
 *   - kept: findings that did NOT match any active rule
 *   - entries: suppression entries for audit event construction
 *
 * Pure function, no I/O.
 */
export function suppressByLearnedRules(
  findings: ParsedReviewComment[],
  activeRules: ReadonlyArray<{ id: string; category: string; file_pattern: string }>,
): { kept: ParsedReviewComment[]; entries: LearnedRuleSuppressionEntry[] } {
  if (activeRules.length === 0) {
    return { kept: findings, entries: [] };
  }

  // Pre-compile matchers with try-catch for invalid glob patterns (C8).
  // Cache matchers per rule to avoid re-compilation per finding.
  const matchers = new Map<string, ((path: string) => boolean) | null>();
  for (const rule of activeRules) {
    try {
      matchers.set(rule.id, picomatch(rule.file_pattern, { dot: true }));
    } catch {
      logger.warn(
        `Invalid picomatch pattern in learned rule ${rule.id}: "${rule.file_pattern}" — skipping rule`,
      );
      matchers.set(rule.id, null);
    }
  }

  const kept: ParsedReviewComment[] = [];
  const entries: LearnedRuleSuppressionEntry[] = [];

  for (const finding of findings) {
    let matched = false;
    for (const rule of activeRules) {
      const matcher = matchers.get(rule.id);
      if (!matcher) continue; // invalid pattern, skip rule
      if (
        rule.category.toLowerCase() === (finding.category ?? '').toLowerCase() &&
        matcher(finding.path)
      ) {
        entries.push({
          path: finding.path,
          line: finding.line ?? null,
          title: finding.title,
          matched_rule: rule.id,
        });
        matched = true;
        break; // first match wins
      }
    }
    if (!matched) {
      kept.push(finding);
    }
  }

  return { kept, entries };
}
