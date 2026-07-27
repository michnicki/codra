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
 * Phase 28 (LRN-01) / G-28-3: the coordinate each provider ACTUALLY anchors its inline comments by.
 *
 * The fragment is selected by the provider KEY only and is a fixed literal SQL string — it is never
 * assembled from, or concatenated with, any caller-supplied value. The coordinate VALUE always stays
 * bound as `$6` through `queryRows` (ASVS V5 / the module-header rule T-11-01-1, threat T-28-06).
 */
const COORDINATE_PREDICATE_BY_PROVIDER: Record<VcsProvider, string> = {
  github: 'rc.position = $6',
  bitbucket: 'rc.line = $6',
};

/**
 * Phase 28 (LRN-01): Look up a review_comment by (path, provider-appropriate coordinate) for the
 * most recent completed job matching the given PR identity. Returns the finding's title, category
 * and severity, or null when nothing matches. Used by the reject handler to denormalize finding
 * metadata onto reject_feedback rows (D-01).
 *
 * TWO COORDINATE SYSTEMS, NOT ONE (this is the G-28-3 fix). Codra POSTs GitHub inline comments by
 * diff `position` (`core/github.ts createReview` sends `{ path, position, body }` and never `line`),
 * so the GitHub predicate reads `review_comments.position`. GitHub's own reported `line` is
 * re-derived from that position against the current diff and drifts from the line the model reported
 * and Codra persisted: on live PR michnicki/opencodra#9 `position` matched on both sampled comments
 * and `line` matched on NEITHER (GitHub line 56/position 16 vs stored line 57; GitHub line 364/
 * position 32 vs stored line 366). Bitbucket has no diff offset — it anchors by `inline.to ??
 * inline.from` on both the post and the read path — so it keeps matching on `review_comments.line`
 * (NREG-02: each provider matches on the coordinate it actually anchors by).
 *
 * There is deliberately NO cross-provider fallback. When the provider's own coordinate is null or
 * matches nothing, the lookup returns null and the caller writes NULL enrichment columns (D-02
 * excludes those rows from clustering). Falling back to the other provider's coordinate would
 * silently re-attach the WRONG finding — precisely the defect being fixed.
 *
 * Joins review_comments → file_reviews → jobs → repositories. `ORDER BY j.created_at DESC, rc.id
 * ASC` makes the ordering TOTAL: the colliding rows observed on PR#9 belong to the SAME job, so
 * `created_at` alone leaves a tie the database may break arbitrarily.
 *
 * The vcs_provider filter ensures we don't cross-match between GitHub and Bitbucket repos that
 * share the same owner/workspace + repo slug.
 */
export async function findReviewCommentByCoordinate(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    workspace: string;
    repoSlug: string;
    vcsProvider: VcsProvider;
    prNumber: number;
    path: string;
    line: number | null;
    position: number | null;
  },
): Promise<{ title: string; category: string; severity: string } | null> {
  // Pick the coordinate the provider anchors by — GitHub the diff offset, Bitbucket the line.
  const coordinate = input.vcsProvider === 'github' ? input.position : input.line;

  // A null coordinate has nothing to match: a GitHub comment on an outdated diff has
  // position: null, and a non-inline comment has no line. Return null rather than borrowing the
  // other provider's coordinate (see the no-fallback note above).
  if (coordinate == null) {
    return null;
  }

  const coordinatePredicate = COORDINATE_PREDICATE_BY_PROVIDER[input.vcsProvider];

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
        AND ${coordinatePredicate}
      ORDER BY j.created_at DESC, rc.id ASC
      LIMIT 1
    `,
    [
      input.vcsProvider,
      input.workspace,
      input.repoSlug,
      input.prNumber,
      input.path,
      coordinate,
    ],
  );

  // Task 2 replaces this LIMIT 1 with a bounded candidate fetch plus a body-based tiebreak so an
  // ambiguous coordinate resolves to the finding the user actually rejected.
  return rows[0] ?? null;
}

/**
 * Phase 28 (LRN-01): Query all reject_feedback rows for a repository, identified by
 * (vcs_provider, workspace, repo_slug). Used by the POST /api/repos/:id/learned-rules/synthesize
 * endpoint to feed the clustering algorithm.
 *
 * Returns rows ordered by created_at DESC (most recent first). The caller filters to
 * non-null finding_category + finding_file_path in clusterRejectFeedback.
 */
export async function getRejectFeedbackForRepo(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    vcsProvider: VcsProvider;
    workspace: string;
    repoSlug: string;
  },
): Promise<RejectFeedbackRow[]> {
  return queryRows<RejectFeedbackRow>(
    env,
    `
      SELECT *
      FROM reject_feedback
      WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3
      ORDER BY created_at DESC
    `,
    [input.vcsProvider, input.workspace, input.repoSlug],
  );
}
