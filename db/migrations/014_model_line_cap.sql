-- Phase 23 (v1.3 Bounded Evidence Audit Telemetry): persist the modelLineCap value used at
-- async submit time into file_reviews so pollReviewBatch can reconstruct the exact evidence
-- haystack the model saw, fixing a race condition where a mutable transient_error_count between
-- submit and poll caused incorrect not_in_hunk evidence classification.
--
-- The column is a nullable INTEGER (set-once at submit time, preserved through subsequent upserts
-- via COALESCE in the DO UPDATE SET clause). Unlike async_request_id/async_model which are
-- explicitly cleared by persistCompletedReview, model_line_cap is never nulled after being set.
--
-- Re-run safe: ALTER TABLE ... ADD COLUMN IF NOT EXISTS. scripts/migrate.mjs applies this file
-- under the existing advisory lock, while the dedicated migration test executes the raw SQL twice.

ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS model_line_cap INTEGER;
