-- Phase 18 (v1.2 Review Engine Quality & Re-review Lifecycle) / incremental-re-review-rounds:
-- provision the additive, re-run-safe storage substrate the round/anchor state machine (RND-01,
-- RND-05) builds on. EVERY change here is INERT for the existing review pipeline (NREG-01):
--   * the three new pr_review_state columns are NULL-able so every existing pause-only row remains
--     valid without backfill, and no writer is wired until Plan 18-01's accessor widening.
--   * the three new jobs columns are NULL-able (review_round, review_mode) or defaulted to false
--     (rounds_incremental) -- insertJob's explicit column list omits them, so every existing
--     insert reads them back at the inert default, and rounds_incremental's NOT NULL DEFAULT false
--     materializes on every existing row at ALTER time.
-- Additive and re-run safe: only IF NOT EXISTS / existence-guarded verbs -- no drop, rename,
-- backfill, or destructive rewrite. Applied under the advisory lock in a single BEGIN/COMMIT by
-- scripts/migrate.mjs (schema_migrations tracked). The highest previously-applied migration is 010.
-- Re-run safety is TESTED by test/migration-011-idempotency.spec.ts (raw SQL executed twice), not
-- merely asserted.

-- 1. pr_review_state anchor columns (D-16, RND-05). last_reviewed_sha is the head SHA written by
--    finalize completion; last_review_round is the integer round counter (>= 1); last_reviewed_at is
--    the timestamp of the last successful finalize. NULL on every existing row until Plan 18-02's
--    anchor writer lands. The pause columns (paused, paused_by, paused_at) stay untouched -- anchor
--    writers must preserve them (Phase 18 Plan 02 D-13; migration alone does not introduce the writer).
ALTER TABLE pr_review_state ADD COLUMN IF NOT EXISTS last_reviewed_sha TEXT;
ALTER TABLE pr_review_state ADD COLUMN IF NOT EXISTS last_review_round INTEGER;
ALTER TABLE pr_review_state ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;

-- 2. jobs review_round / review_mode / rounds_incremental (RND-01 / D-02 / D-16 widened). review_round
--    and review_mode are NULL-able because they are populated by prepare-time round detection in
--    Plan 18-02 and not every existing job has been re-prepared. rounds_incremental is NOT NULL with
--    a false default so the prepared-rounds signal is durable from insert time onwards; insertJob's
--    explicit column list omits it, so every existing insert reads back as false (NREG-01).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review_round INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review_mode TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS rounds_incremental BOOLEAN NOT NULL DEFAULT false;

-- 3. Database CHECK constraints (Codex MEDIUM; mirror migration-001's trigger/status/verdict CHECK
--    precedent). Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each constraint is guarded with a
--    pg_constraint existence check on the canonical conname. Re-running the migration short-circuits
--    the ALTER cleanly -- the FIRST apply installs the constraint, the SECOND apply sees it already
--    exists and skips. The conname and ADD CONSTRAINT name below MUST stay byte-identical.
--
--    review_round >= 1: every persisted round number is at least 1. No negative or zero rounds. NULL
--    is allowed (existing rows pre-Plan-18-02 are NULL), so the check is a positive-integer lower
--    bound, not a NOT NULL.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_review_round_positive_check'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_review_round_positive_check
      CHECK (review_round IS NULL OR review_round >= 1);
  END IF;
END $$;

--    review_mode in the finite Phase 18 set: full | incremental | fallback | no_changes | rest.
--    Mirrors the schema-side value-set locked in src/shared/schema.ts (Plan 01's reviewModeSchema).
--    Any other value fails the constraint at write time, so a future-mode producer cannot silently
--    bypass the contract.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_review_mode_check'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_review_mode_check
      CHECK (
        review_mode IS NULL
        OR review_mode IN ('full', 'incremental', 'fallback', 'no_changes', 'rest')
      );
  END IF;
END $$;