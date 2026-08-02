-- WS-01: workspace-level Bitbucket bot credential + webhook secret. This is a SEPARATE table
-- from `vcs_credentials` on purpose (D-01/D-02, 31-RESEARCH.md): a workspace-level Bitbucket
-- Access Token + webhook subscription can be configured ONCE for an entire workspace, independent
-- of (and additive to) any per-repo credential a repo already has in `vcs_credentials`
-- (migration 004). Mirrors that table's proven per-entity-row convention exactly rather than
-- overloading an existing column's semantics (e.g. a nullable repo_slug on vcs_credentials would
-- conflate two different identity shapes in one UNIQUE constraint). `repositories.workspace`
-- stays a plain-text column with NO foreign key to this table -- a repo can exist, be discovered,
-- and be reviewed with no workspace-level credential ever having been stored (D-02).
--
-- `CREATE TABLE IF NOT EXISTS` keeps this migration re-run safe under the advisory lock in
-- scripts/migrate.mjs (Pitfall 4, mirrored from 004). vcs_provider uses TEXT + CHECK rather than a
-- native ENUM, matching the jobs.status / repositories.vcs_provider / vcs_credentials.vcs_provider
-- precedent (D-01 of Phase 4) -- ENUMs need ALTER TYPE ... ADD VALUE for a future provider, which
-- cannot run in a transaction block alongside other DDL. Only 'bitbucket' is accepted (this phase
-- does not need a workspace-level concept for GitHub).
CREATE TABLE IF NOT EXISTS vcs_workspace_credentials (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vcs_provider             TEXT        NOT NULL CHECK (vcs_provider = 'bitbucket'),
  workspace                TEXT        NOT NULL,
  -- Secrets at rest: ciphertext only (mirrors vcs_credentials D-10 / T-04-01, T-04-05). Nullable so
  -- a credential row can exist with one secret rotated/cleared independently of the other.
  encrypted_access_token   TEXT,
  encrypted_webhook_secret TEXT,
  -- Nullable: NULL means "no expiry recorded" (mirrors vcs_credentials D-04). Server computes the
  -- four-state status from this value via the SAME computeCredentialStatus date-math
  -- vcs_credentials already uses (src/server/db/vcs-credentials.ts) -- no duplicated threshold
  -- logic; no live Bitbucket call.
  token_expires_at         TIMESTAMPTZ,
  label                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The upsert key: UNIQUE (vcs_provider, workspace) is what makes upsertVcsWorkspaceCredential a
-- rotate-in-place `INSERT ... ON CONFLICT DO UPDATE`, re-submitting the same (vcs_provider,
-- workspace) never creates a second row. Added via the pg_constraint-existence guard copied from
-- 003_vcs_provider_foundation.sql:25-32 / 004_vcs_credentials.sql:41-48 -- NOT
-- `DO $$ ... EXCEPTION WHEN duplicate_object`, which this codebase reserves for `CREATE TYPE`.
-- The guard's `conname` check and the `ADD CONSTRAINT` name below MUST stay byte-identical: any
-- divergence would make the guard silently no-op or raise a duplicate-constraint error on re-run.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vcs_workspace_credentials_provider_workspace_key'
  ) THEN
    ALTER TABLE vcs_workspace_credentials
      ADD CONSTRAINT vcs_workspace_credentials_provider_workspace_key UNIQUE (vcs_provider, workspace);
  END IF;
END $$;

-- Deliberate omission, not a gap: unlike `vcs_credentials` (which needs a dedicated
-- `idx_vcs_credentials_workspace_slug` index because the Bitbucket webhook route looks up by
-- (workspace, repo_slug) WITHOUT the provider column as a leading prefix), every reader of THIS
-- table -- listVcsWorkspaceCredentials, getVcsWorkspaceCredentialSecrets,
-- upsertVcsWorkspaceCredential, deleteVcsWorkspaceCredential -- filters on (vcs_provider,
-- workspace) TOGETHER, which is exactly the UNIQUE constraint's own leading-column index above.
-- No secondary index is added here.
