import type { AppBindings } from '@server/env';
import type { VcsProvider } from '@shared/schema';
import { queryRows } from './client';

/**
 * D-09 / CMD-05 (Phase 11): typed accessor for the `reject_feedback` table (migration 009) --
 * capture-only storage of a structured negative-feedback signal when a user replies `reject` under an
 * inline finding. Feeds the future v2 LRN-01 learned-rule synthesis; this milestone captures the
 * input only, no synthesis.
 *
 * One module per domain (mirrors db/pr-review-state.ts). No consumer is wired this plan; the command
 * dispatcher writer lands in a later Phase 11 plan.
 *
 * Every statement is parameterized via queryRows -- NO string interpolation of values (V5 Input
 * Validation / SQLi mitigation, T-11-01-1). `rejected_by` stores the actor's IMMUTABLE account_id /
 * numeric id, NEVER a mutable username/handle (NREG-02, T-11-01-2).
 */

export type RejectFeedbackRow = {
  id: string;
  vcs_provider: VcsProvider;
  workspace: string;
  repo_slug: string;
  pr_number: number;
  finding_ref: string;
  reason: string | null;
  rejected_by: string;
  source_comment_ref: string;
  created_at: string;
  // Phase 28 (LRN-01): denormalized finding metadata for learned-rule clustering.
  // All nullable — existing rows get NULLs; edge cases where metadata can't be resolved
  // (deleted comment, provider error, orphan ref) also get NULLs. Clustering only considers
  // rows with non-null finding_category and finding_file_path (D-02).
  finding_title: string | null;
  finding_category: string | null;
  finding_file_path: string | null;
  finding_severity: string | null;
};

/**
 * Write one reject-feedback row, idempotent on (vcs_provider, source_comment_ref) via ON CONFLICT DO
 * NOTHING -- a crash-before-ack queue replay of the same reject reply comment does NOT double-insert
 * (REVIEW: Codex 11-01 MED). Returns the inserted row, or null when the insert was a no-op (either a
 * duplicate source_comment_ref, or a capture-skip because finding_ref / source_comment_ref is empty).
 *
 * A missing finding_ref (no resolvable parent finding, CMD-05 edge) or source_comment_ref is a
 * capture-SKIP, not an error: the caller gets null and no row is written. `reason` (the reply body)
 * may be null.
 */
export async function insertRejectFeedback(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    vcsProvider: VcsProvider;
    workspace: string;
    repoSlug: string;
    prNumber: number;
    findingRef: string;
    reason: string | null;
    rejectedBy: string;
    sourceCommentRef: string;
    // Phase 28 (LRN-01): optional denormalized finding metadata for learned-rule clustering.
    // All nullable — populated from provider API + review_comments join at reject time.
    // NULLs are safe: clustering skips rows with null finding_category or finding_file_path (D-02).
    findingTitle?: string | null;
    findingCategory?: string | null;
    findingFilePath?: string | null;
    findingSeverity?: string | null;
  },
): Promise<RejectFeedbackRow | null> {
  // CMD-05 edge: a reject with no resolvable finding_ref (no parent comment) -- or no source comment
  // ref to key idempotency on -- is a capture-skip, not a throw.
  if (!input.findingRef || !input.sourceCommentRef) {
    return null;
  }

  const rows = await queryRows<RejectFeedbackRow>(
    env,
    `
      INSERT INTO reject_feedback
        (vcs_provider, workspace, repo_slug, pr_number, finding_ref, reason, rejected_by, source_comment_ref,
         finding_title, finding_category, finding_file_path, finding_severity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (vcs_provider, source_comment_ref) DO NOTHING
      RETURNING *
    `,
    [
      input.vcsProvider,
      input.workspace,
      input.repoSlug,
      input.prNumber,
      input.findingRef,
      input.reason,
      input.rejectedBy,
      input.sourceCommentRef,
      input.findingTitle ?? null,
      input.findingCategory ?? null,
      input.findingFilePath ?? null,
      input.findingSeverity ?? null,
    ],
  );

  return rows[0] ?? null;
}

/**
 * Phase 28 (LRN-01): Look up a review_comment by (path, line) for the most recent completed job
 * matching the given PR identity. Returns the finding's title, category, and severity, or null if
 * no matching review_comment is found. Used by the reject handler to denormalize finding metadata
 * onto reject_feedback rows (D-01).
 *
 * Joins review_comments → file_reviews → jobs → repositories. The (path, line) match is unambiguous
 * for most PRs; if multiple Codra comments exist on the same (path, line), the most recent completed
 * job's comment is returned (ORDER BY jobs.created_at DESC, LIMIT 1).
 *
 * The vcs_provider filter ensures we don't cross-match between GitHub and Bitbucket repos that
 * share the same owner/workspace + repo slug.
 */
export async function findReviewCommentByPathLine(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    workspace: string;
    repoSlug: string;
    vcsProvider: VcsProvider;
    prNumber: number;
    path: string;
    line: number | null;
  },
): Promise<{ title: string; category: string; severity: string } | null> {
  // Line must be non-null to match — a comment with null line is a general PR comment, not an
  // inline finding, so there's no meaningful review_comment to join against.
  if (input.line == null) {
    return null;
  }

  const rows = await queryRows<{ title: string; category: string; severity: string }>(
    env,
    `
      SELECT rc.title, rc.category, rc.severity
      FROM review_comments rc
      JOIN file_reviews fr ON fr.id = rc.file_review_id
      JOIN jobs j ON j.id = fr.job_id
      JOIN repositories r ON r.id = j.repository_id
      WHERE r.vcs_provider = $1
        AND (r.owner = $2 OR r.workspace = $2)
        AND r.repo = $3
        AND j.pr_number = $4
        AND j.status = 'done'
        AND rc.path = $5
        AND rc.line = $6
      ORDER BY j.created_at DESC
      LIMIT 1
    `,
    [
      input.vcsProvider,
      input.workspace,
      input.repoSlug,
      input.prNumber,
      input.path,
      input.line,
    ],
  );

  return rows[0] ?? null;
}
