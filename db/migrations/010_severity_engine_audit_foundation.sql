-- Phase 13 (v1.2 Review Engine Quality & Re-review Lifecycle) / contracts-severity-engine-audit-
-- foundation: provision the additive, re-run-safe storage substrate the audit trail (AUD-01) builds
-- on. EVERY change here is INERT for the existing review pipeline (NREG-01) -- both new `jobs` columns
-- have NO writer until core/audit.ts's appendJobAuditEvents (Plan 13-03) is wired, and neither is
-- backfilled: an existing job reads `audit` back as NULL and `audit_truncated` as false. Nothing in
-- this migration changes runtime behavior for a GitHub or Bitbucket review that runs today.
-- Additive and re-run safe: only IF NOT EXISTS verbs -- no drop, rename, backfill, or destructive
-- rewrite. Applied under the advisory lock in a single BEGIN/COMMIT by scripts/migrate.mjs
-- (schema_migrations tracked). The highest previously-applied migration is 009.

-- 1. jobs.audit / jobs.audit_truncated (AUD-01, D-12/D-14): durable per-job audit trail storage.
--    `audit` is a NULLABLE JSONB array (jobAuditEventSchema[] shape) -- NOT backfilled, so an existing
--    job reads back NULL until appendJobAuditEvents (Plan 13-03) writes to it. `audit_truncated` is
--    the ring-buffer-eviction tracking flag Plan 13-03 sets when the audit array is capped; it
--    defaults false so no backfill is needed and every existing row materializes the default at ALTER
--    time. Mirrors the migration-007 jobs.walkthrough_comment_ref / jobs.critic_result additive
--    nullable-column precedent. No index, no constraint, no backfill.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS audit JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS audit_truncated BOOLEAN NOT NULL DEFAULT false;
