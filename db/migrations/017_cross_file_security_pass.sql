-- Migration 017: widen file_reviews_pass_check to admit 'cross_file_security'.
--
-- Phase 27 (SEC-XDIFF-01) added 'cross_file_security' to fileReviewPassSchema
-- (src/shared/schema.ts) and runCrossFileSecurityPhase persists its rows with that pass, but the
-- DB CHECK created in migration 007 still admitted only ('main','security'). Migration 007's own
-- comment states the constraint exists "to match fileReviewPassSchema" -- this migration repairs
-- that drift.
--
-- Impact this fixes: on any repo with passes.security.cross_file = true, the cross-file phase's
-- first INSERT violated the CHECK and hard-failed the job. That included the phase's OWN fail-open
-- writes (the 'skipped' and 'failed' sentinel rows), so a phase explicitly designed to degrade
-- gracefully instead terminal-failed the review.
--
-- Idempotency: migration 007 guards its ADD CONSTRAINT on pg_constraint existence, so a bare
-- re-ADD here would be a silent no-op against the already-present narrow constraint. DROP first,
-- then ADD unconditionally -- the pair is safe on re-run. No backfill is needed: the new value set
-- is a strict superset of the old one, so every existing row already satisfies it.
ALTER TABLE file_reviews DROP CONSTRAINT IF EXISTS file_reviews_pass_check;

ALTER TABLE file_reviews
  ADD CONSTRAINT file_reviews_pass_check CHECK (pass IN ('main', 'security', 'cross_file_security'));
