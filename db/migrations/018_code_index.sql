-- Phase 29 (v1.4 Deferred Candidates) / QA-IDX-01 codebase-index-backed Q&A: provision the additive,
-- re-run-safe storage substrate for the per-repository codebase index. EVERY table here is created
-- EMPTY with NO writer until later plans wire the producers (the tree walk, the durable build
-- Workflow, the push refresh), so nothing in this migration changes runtime behavior for a GitHub or
-- Bitbucket review or Q&A that runs today (NREG-01).
-- Additive and re-run safe: only IF NOT EXISTS / existence-guarded verbs -- no drop, rename,
-- backfill, or destructive rewrite. Applied under the advisory lock in a single BEGIN/COMMIT by
-- scripts/migrate.mjs (schema_migrations tracked). The highest previously-applied migration is 017.
-- Re-run safety is TESTED by test/migration-018-idempotency.spec.ts (raw SQL executed twice, then
-- table / primary-key / index / foreign-key shape asserted from the catalog views), not merely
-- asserted in this comment.
--
-- D-01: the index is Postgres NATIVE full-text search -- a TSVECTOR column with a GIN index. There is
-- deliberately NO `CREATE EXTENSION` and no vector column type anywhere in this migration: the local
-- test Postgres 17.10 lists pg_trgm only (no `vector`), so a pgvector migration would break
-- `npm test` on this host. Embeddings are explicitly out of scope for this phase.

-- 1. code_index_chunks (D-10 / D-11 / D-12): one row is a FIXED 50-line window of one file, holding
--    the window's content alongside the weighted search vector so retrieval is a single DB query that
--    costs ZERO provider subrequests at question time (D-11) -- which matters because the Q&A path is
--    the tightest subrequest budget in the system.
--
--    KEY DESIGN 1 -- composite PRIMARY KEY (repository_id, path, chunk_start) instead of the house
--    `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` + UNIQUE(...) shape used by skipped_files /
--    reject_feedback. This is a deliberate departure: the table is MUTABLE CURRENT STATE (D-12), not
--    an append-only log, and (repository_id, path, chunk_start) is exactly the index the
--    delete-changed-paths incremental refresh scans (`DELETE ... WHERE repository_id = $1 AND
--    path = $2` plans as an Index Scan on this primary key). A surrogate id would add a second index
--    to maintain and buy nothing -- no row here is ever referenced by another table.
--
--    KEY DESIGN 2 -- ON DELETE CASCADE from repositories(id). Another deliberate departure: the
--    `repository_id` references in 001_initial.sql do NOT cascade. Here the index must be deleted
--    WITH the repository -- an orphaned index would keep a copy of a removed repository's source in
--    Postgres, which is precisely the retention the D-11 storage decision was accepted on. No
--    `DELETE FROM repositories` path exists in src/ today, so the cascade is defensive.
--
--    KEY DESIGN 3 -- search_vector is written by the APPLICATION, not `GENERATED ALWAYS AS ... STORED`.
--    A generated column would compute to_tsvector inside Postgres AFTER the row arrives, which is too
--    late: to_tsvector raises above roughly 1 MB of resulting vector (a 1 088 889-byte input produced
--    a 1 477 980-byte vector against the 1 048 575-byte ceiling), so the JS per-chunk byte cap
--    (CODE_INDEX_MAX_CHUNK_BYTES, src/server/core/code-index.ts) must run BEFORE the insert. It also
--    lets the writer feed the pre-split identifier tokens the raw column text does not contain (D-02).
--
--    path_tokens stores the pre-split path token string the 'A'-weighted half of the vector was built
--    from, so a re-weight or a diagnostic re-derivation never has to re-split the path.
--    indexed_sha is the commit the window's content was read at -- retrieval never filters by it
--    (D-12: the table holds current state only); it is provenance for the operator-facing status row.
CREATE TABLE IF NOT EXISTS code_index_chunks (
  repository_id INTEGER     NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path          TEXT        NOT NULL,
  chunk_start   INTEGER     NOT NULL,
  chunk_end     INTEGER     NOT NULL,
  content       TEXT        NOT NULL,
  path_tokens   TEXT        NOT NULL,
  indexed_sha   TEXT        NOT NULL,
  search_vector TSVECTOR    NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, path, chunk_start)
);

-- Serves retrieveCodeIndexChunks (src/server/db/code-index.ts): the `search_vector @@ q` half of the
-- ranked retrieval. GIN cannot supply ordering, so the ORDER BY ts_rank_cd(...) DESC LIMIT K is
-- always a top-N heapsort above this scan -- measured at 25 kB of sort memory over 60 000 chunks,
-- which is fine at these row counts.
CREATE INDEX IF NOT EXISTS code_index_chunks_vector_idx
  ON code_index_chunks USING GIN (search_vector);

-- Serves the mandatory `repository_id = $1` filter in retrieveCodeIndexChunks -- the cross-repository
-- isolation control -- and the per-repo truncate/refresh accessors. This narrow btree exists IN
-- ADDITION to the composite primary key on purpose: with one repository dominating the table the
-- planner was measured to IGNORE the primary key and sequentially scan, and adding this index
-- demonstrably changed the plan (selective queries BitmapAnd both indexes; broad queries scan only
-- the one repository's rows instead of the whole table).
CREATE INDEX IF NOT EXISTS code_index_chunks_repo_idx
  ON code_index_chunks (repository_id);

-- 2. code_index_files (D-05 resumability): per-file bookkeeping so a retried or continued build skips
--    files already indexed at the same sha -- the file_reviews per-unit-progress convention. Created
--    EMPTY; markCodeIndexFileIndexed / listIndexedPathsForSha land in plan 29-04.
--
--    skip_reason TOKEN VOCABULARY: the writer emits exactly one of
--      'empty'      -- the file had no content to window
--      'generated'  -- content-based generated-file detection dropped it (D-09)
--      'oversized'  -- the file exceeded CODE_INDEX_MAX_FILE_BYTES before chunking
--      'unreadable' -- the provider fetch failed or returned non-text
--    and NULL means the file was indexed normally (chunk_count > 0).
--
--    This is deliberately a DOCUMENTED vocabulary and NOT a `CHECK (skip_reason IN (...))` constraint.
--    Recorded because cross-AI review raised it (29-REVIEWS.md, OpenCode 29-01): a CHECK would turn
--    adding a future skip reason into a schema migration on a column whose only consumer is the
--    resumability read, and the column is written from exactly ONE accessor
--    (markCodeIndexFileIndexed) whose own contract already restricts it to a short machine token --
--    so a constraint would buy enforcement the single writer already provides while costing a
--    migration per vocabulary change. Do not "harden" this into a CHECK without a second writer.
CREATE TABLE IF NOT EXISTS code_index_files (
  repository_id INTEGER     NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path          TEXT        NOT NULL,
  indexed_sha   TEXT        NOT NULL,
  chunk_count   INTEGER     NOT NULL DEFAULT 0,
  skip_reason   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, path)
);

-- Serves listIndexedPathsForSha (plan 29-04): "which paths are already done at THIS sha", the read a
-- resumed build makes before it fetches anything.
CREATE INDEX IF NOT EXISTS code_index_files_sha_idx
  ON code_index_files (repository_id, indexed_sha);

-- 3. code_index_state (D-12): ONE row per repository carrying the build lifecycle and the operator
--    facing answer to "what is in the index right now". Created EMPTY; markCodeIndexBuildStarted is
--    wired in this plan, the lease/completion accessors in plan 29-04.
--
--    status values: 'idle'     -- no build has ever run (or the row was reset)
--                   'building' -- a build holds the lease (see lease_expires_at)
--                   'ready'    -- indexed_sha / counts describe a usable index
--                   'failed'   -- the last build failed; last_error carries a REDACTED reason (AUD-01)
--
--    mode values:   'full'        -- a dashboard-triggered rebuild (D-07)
--                   'incremental' -- a push-triggered refresh of changed paths only (D-08)
--                   NULL          -- before the first build
--    mode is the operator-facing answer to "what produced the current index": it is read by the
--    status endpoint and rendered by the dashboard panel, so it MUST be written on every build START,
--    not only on completion -- otherwise a build that is still running, or one that failed, shows no
--    mode at all and the panel cannot explain what is happening.
--
--    truncated records that the provider's tree listing was itself truncated (GitHub returns
--    truncated: true above ~100k entries), so the panel can say "partial tree" rather than implying
--    the whole repository is indexed. lease_expires_at / workflow_instance_id / continuation_count
--    mirror the jobs-table lease + continuation vocabulary so a stuck build is recoverable.
CREATE TABLE IF NOT EXISTS code_index_state (
  repository_id        INTEGER     PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  status               TEXT        NOT NULL DEFAULT 'idle',
  mode                 TEXT,
  indexed_ref          TEXT,
  indexed_sha          TEXT,
  building_sha         TEXT,
  indexed_at           TIMESTAMPTZ,
  file_count           INTEGER     NOT NULL DEFAULT 0,
  chunk_count          INTEGER     NOT NULL DEFAULT 0,
  truncated            BOOLEAN     NOT NULL DEFAULT false,
  lease_expires_at     TIMESTAMPTZ,
  workflow_instance_id TEXT,
  continuation_count   INTEGER     NOT NULL DEFAULT 0,
  last_error           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
