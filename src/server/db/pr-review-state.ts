import type { AppBindings } from '@server/env';
import type { VcsProvider } from '@shared/schema';
import { queryRows, queryTransaction } from './client';

/**
 * D-01/D-02 (Phase 11 enabler) + D-16 (Phase 18 anchor substrate): typed accessors for the
 * `pr_review_state` table (migration 007, widened in migration 011). DB-backed, provider-agnostic
 * storage for two related PR lifecycles: the "pause/resume this PR's review" directive
 * (Phase 11) and the last-reviewed SHA anchor / round counter (Phase 18 RND-05).
 *
 * One module per domain (D-03). The pause + anchor columns coexist on the same one-row-per-PR row
 * (locked D-16) and are managed by independent setters. Anchor writes deliberately DO NOT touch
 * the pause columns (`paused` / `paused_by` / `paused_at`) so a concurrent pause / resume action
 * is never overwritten by an anchor advance (NREG-02 + Phase 18 Plan 02 D-13).
 *
 * Every statement is parameterized via queryRows / queryTransaction -- NO string interpolation of
 * values (V5 Input Validation / SQLi mitigation, T-07-07), mirroring updateJobStatusCheckRef.
 */

/**
 * The one-row-per-PR identity tuple. `workspace` is a REQUIRED non-null string (Codex HIGH #2): it
 * is the canonical per-provider value the migration-007 `workspace TEXT NOT NULL` column expects --
 * GitHub callers pass the repo owner/login, Bitbucket callers pass the workspace slug. This
 * DELIBERATELY differs from the `repositories` table's GitHub-workspace-NULL convention: because
 * Postgres treats NULLs as distinct under a default UNIQUE, a nullable workspace would let a GitHub
 * PR accumulate duplicate pause rows and break D-01. A non-null workspace makes
 * UNIQUE(vcs_provider, workspace, repo_slug, pr_number) enforce one pause row per PR for GitHub too,
 * and keeps `workspace = $N` equality lookups from ever binding NULL.
 */
export type PrReviewStateKey = {
  // IN-01: narrowed from `string` to the shared `VcsProvider` union ('github' | 'bitbucket') so a
  // typo'd provider ('GitHub', 'bitbucket') is a compile-time error rather than silently creating a
  // distinct, orphaned pause row that no correctly-spelled lookup will ever match. The
  // `pr_review_state` table itself still has no DB-level CHECK on `vcs_provider`; adding
  // `CHECK (vcs_provider IN ('github','bitbucket'))` is a DEFERRED follow-up migration decision --
  // migration 007 is already applied to the test/dev databases, so this fix is TS-tightening only.
  vcsProvider: VcsProvider;
  workspace: string;
  repoSlug: string;
  prNumber: number;
};

export type PrReviewStateRow = {
  id: string;
  // IN-01: tightened to the shared union to match the key type. The accessors only ever write a
  // VcsProvider value (via PrReviewStateKey), so rows produced through this module carry a valid
  // provider. (A DB-level CHECK is the deferred follow-up noted above; this type is not a guarantee
  // about arbitrary externally-inserted rows.)
  vcs_provider: VcsProvider;
  workspace: string;
  repo_slug: string;
  pr_number: number;
  paused: boolean;
  // NREG-02 (T-07-08): stores the actor's IMMUTABLE account_id, never a mutable username/handle.
  paused_by: string | null;
  paused_at: string | null;
  created_at: string;
  // Phase 18 (migration 011, D-16 / RND-05): the last-reviewed SHA anchor. NULL on every existing
  // pause-only row (no writer wired until Plan 02's setLastReviewedSha lands). last_review_round is
  // the round counter from the last successful finalize (integer >= 1). last_reviewed_at is the
  // timestamp of the last successful finalize. All three are NULL-able so an existing row that
  // pre-dates migration 011 reads back as null without throwing.
  last_reviewed_sha: string | null;
  last_review_round: number | null;
  last_reviewed_at: string | null;
};

/**
 * Return the pause row for a PR, or null when the PR has never been paused (lazy creation means no
 * row exists until the first pause). Parameterized equality lookup on the full non-null identity
 * tuple, so it never binds a NULL workspace.
 */
export async function getPrReviewState(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
): Promise<PrReviewStateRow | null> {
  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      SELECT *
      FROM pr_review_state
      WHERE vcs_provider = $1
        AND workspace = $2
        AND repo_slug = $3
        AND pr_number = $4
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber],
  );
  return rows[0] ?? null;
}

/**
 * Lazily create-or-update the single pause row for a PR (D-01). On first call the row is INSERTed;
 * on subsequent calls ON CONFLICT DO UPDATE mutates the SAME row in place, so both pause and resume
 * flow through this one setter and never create a duplicate row. `pausedBy` receives the actor's
 * immutable account_id (NREG-02), never a username. `paused_at` records the time of the last
 * state change. Fully parameterized; no string interpolation.
 */
export async function upsertPrReviewState(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  state: { paused: boolean; pausedBy: string | null },
): Promise<PrReviewStateRow> {
  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      INSERT INTO pr_review_state (vcs_provider, workspace, repo_slug, pr_number, paused, paused_by, paused_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (vcs_provider, workspace, repo_slug, pr_number) DO UPDATE SET
        paused = EXCLUDED.paused,
        paused_by = EXCLUDED.paused_by,
        paused_at = EXCLUDED.paused_at
      RETURNING *
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber, state.paused, state.pausedBy],
  );
  return rows[0];
}

/**
 * Convenience wrapper: pause a PR's review, attributing it to the actor's immutable account_id.
 * Lazily creates the row on first pause (via upsertPrReviewState).
 */
export async function markPrPaused(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  pausedByAccountId: string,
): Promise<PrReviewStateRow> {
  return upsertPrReviewState(env, key, { paused: true, pausedBy: pausedByAccountId });
}

/**
 * Convenience wrapper: resume a PR's review.
 *
 * IN-02: this is an UPDATE-ONLY operation, deliberately NOT routed through upsertPrReviewState.
 * Routing resume through the upsert INSERTed a spurious `paused=false` row for a never-paused PR
 * (breaking the "no row until the first pause" lazy-creation invariant, and materializing a
 * `paused=false` row where callers expect `null`), and overwrote `paused_by` with the RESUMER --
 * leaving the column named `paused_by` holding the actor who un-paused rather than the pauser.
 *
 * Corrected behavior:
 *   - No existing row  -> no-op, returns `null` (never creates a row).
 *   - Existing row     -> clears `paused` in place WITHOUT clobbering `paused_by`, which by the
 *                         module's NREG-02 intent records the immutable account_id of the PAUSER.
 *
 * `resumedByAccountId` is accepted for call-site symmetry with `markPrPaused` and forward
 * compatibility, but is intentionally NOT persisted: preserving the resumer's identity through a
 * resume would require a separate `resumed_by`/`last_actor` column (a deferred follow-up migration),
 * not overwriting the pauser's `paused_by`. Fully parameterized; no string interpolation.
 */
export async function markPrResumed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  resumedByAccountId: string,
): Promise<PrReviewStateRow | null> {
  void resumedByAccountId;
  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      UPDATE pr_review_state
      SET paused = false,
          paused_at = now()
      WHERE vcs_provider = $1
        AND workspace = $2
        AND repo_slug = $3
        AND pr_number = $4
      RETURNING *
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber],
  );
  return rows[0] ?? null;
}

/**
 * Phase 18 (RND-05 / D-14): advance the last-reviewed SHA anchor and round counter on a successful
 * finalize. The setter is INSERT-on-conflict-DO-UPDATE so the row lazy-creates on a never-paused
 * PR's first review (mirrors the pause setter's lazy-creation invariant). Anchor columns are
 * written ONLY -- the pause columns (`paused`, `paused_by`, `paused_at`) are deliberately NOT
 * touched, so a concurrent pause / resume action is never overwritten by an anchor advance
 * (Phase 18 Plan 02 D-13).
 *
 * Monotonicity guard (D-15 / RND-05): the new anchor is only written when the row's existing
 * `last_reviewed_sha` is NULL OR equal to `headSha` (the prepare-time head captured before the
 * review started). A stale redelivery carrying an OLDER head cannot regress the anchor below a
 * newer one -- the update is skipped (returns `null` because `RETURNING` is empty). The round
 * counter advances similarly (current round is NULL OR strictly less than the new round).
 *
 * Fully parameterized; no string interpolation. Returns the resulting row (or `null` if the row
 * did not exist AND `null` was passed for the head SHA / round -- a NULL anchor write is a no-op
 * defensive guard and never creates an empty row).
 */
export async function setLastReviewedSha(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  state: {
    headSha: string | null;
    reviewRound: number;
  },
): Promise<PrReviewStateRow | null> {
  // Defensive guard: empty head SHA is the D-15 skip path. The caller is responsible for emitting
  // the `rounds.anchor_skipped` audit event; this setter simply refuses to write a NULL anchor.
  const headSha = state.headSha?.trim() ?? '';
  if (headSha.length === 0) return null;

  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      INSERT INTO pr_review_state (vcs_provider, workspace, repo_slug, pr_number, last_reviewed_sha, last_review_round, last_reviewed_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (vcs_provider, workspace, repo_slug, pr_number) DO UPDATE SET
        last_reviewed_sha = EXCLUDED.last_reviewed_sha,
        last_review_round = EXCLUDED.last_review_round,
        last_reviewed_at = EXCLUDED.last_reviewed_at
      WHERE pr_review_state.last_reviewed_sha IS NULL
         OR pr_review_state.last_reviewed_round IS NULL
         OR pr_review_state.last_review_round < EXCLUDED.last_review_round
      RETURNING *
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber, headSha, state.reviewRound],
  );
  return rows[0] ?? null;
}

/**
 * Phase 18 Plan 02 (RND-05 / D-14): transaction-compatible advance that runs alongside completeJob
 * so the job's terminal `done` transition and the anchor's monotonic advancement either BOTH commit
 * or BOTH roll back. The helper wraps a single `queryTransaction` (postgres.js `BEGIN/COMMIT`)
 * that calls `completeJob` (jobs.ts) then conditionally `setLastReviewedSha` (above) so a partial
 * failure leaves both sides unchanged.
 *
 * Pause fields are PRESERVED: `setLastReviewedSha` does not touch `paused` / `paused_by` /
 * `paused_at`. A concurrent pause / resume action that lands inside this transaction is unaffected
 * (the transaction takes its row lock for the duration; a pause UPDATE that arrives after the
 * transaction's anchor write commits will simply overwrite the anchor as the next statement --
 * which is the desired "pause always wins the next call" semantics).
 *
 * Imported lazily (and only at call-time) to avoid a jobs.ts -> pr-review-state.ts import cycle:
 * jobs.ts already imports nothing from this module, and the cycle would surface only here.
 */
export async function completeReviewAndAdvanceAnchor(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    jobId: string;
    key: PrReviewStateKey;
    completion: Parameters<typeof import('./jobs').completeJob>[2];
    reviewRound: number;
    advanceAnchor: { headSha: string | null } | null;
  },
): Promise<void> {
  await queryTransaction(env, async () => {
    const { completeJob } = await import('./jobs');
    await completeJob(env, input.jobId, input.completion);
    if (input.advanceAnchor) {
      await setLastReviewedSha(env, input.key, {
        headSha: input.advanceAnchor.headSha,
        reviewRound: input.reviewRound,
      });
    }
  });
}