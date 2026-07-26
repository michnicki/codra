-- Phase 28 (LRN-01): Add denormalized finding metadata columns to reject_feedback for
-- learned-rule synthesis clustering. These 4 nullable TEXT columns are populated at reject time
-- by resolving the rejected finding's metadata from the provider API + review_comments join.
-- All columns are nullable — existing rows (pre-migration) get NULLs, and edge cases where
-- metadata cannot be resolved (deleted comment, provider error, orphan ref) also get NULLs.
-- Clustering only considers rows with non-null finding_category and finding_file_path (D-02).
--
-- Re-run safe: ALTER TABLE ... ADD COLUMN IF NOT EXISTS. scripts/migrate.mjs applies this file
-- under the existing advisory lock, while the dedicated migration test executes the raw SQL twice.

ALTER TABLE reject_feedback ADD COLUMN IF NOT EXISTS finding_title TEXT;
ALTER TABLE reject_feedback ADD COLUMN IF NOT EXISTS finding_category TEXT;
ALTER TABLE reject_feedback ADD COLUMN IF NOT EXISTS finding_file_path TEXT;
ALTER TABLE reject_feedback ADD COLUMN IF NOT EXISTS finding_severity TEXT;
