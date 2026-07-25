-- Phase 19 (v1.2 Review Engine Quality & Re-review Lifecycle): durable storage for the
-- verify-fixes result, walkthrough enrichment metadata, and per-file ensemble result.
--
-- This is the sole owner of Phase 19's additive database columns. All three values are nullable
-- JSONB so historical rows remain readable and later phase workers can persist versioned,
-- fail-soft payloads without a destructive backfill. Configuration remains authoritative in
-- jobs.config_snapshot; no redundant toggle snapshot is stored here.
--
-- Re-run safe: every addition uses IF NOT EXISTS. scripts/migrate.mjs applies this file under the
-- existing advisory lock, while the dedicated migration test executes the raw SQL twice.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS thread_verifications JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS walkthrough_enrichment JSONB;
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS ensemble_result JSONB;
