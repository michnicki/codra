// Phase 29 / QA-IDX-01: typed accessors for the codebase index tables created by migration 018
// (code_index_chunks, code_index_files, code_index_state).
//
// One module per domain (mirrors db/skipped-files.ts). Every statement is parameterized through
// queryRows -- the ONLY string construction anywhere in this file is positional `$N` placeholder
// assembly for the multi-row insert, NEVER a value. In particular the reviewer's question never
// reaches SQL as text: it arrives here already normalized into a single query expression that travels
// as one bound parameter (T-29-01-02).
//
// This module NEVER swallows errors. The D-15 fail-open policy -- "any retrieval problem degrades the
// answer to diff-only, silently" -- lives in the Q&A handler, which is the only place that knows a
// degraded answer is still a useful answer. A DB module that quietly returned [] on error would make
// a real outage indistinguishable from an empty index for every future caller.
//
// SURFACE COMPLETE for both consumers. The write path, the ranked read path, the build-state read,
// the build lifecycle (start / claim / renew / release / complete / fail), the incremental-refresh and
// full-rebuild deletes, and the per-file resumability pair are all here. A new accessor should be
// needed only by a genuinely new consumer, not to finish an existing one.
//
// THIS MODULE IMPORTS NOTHING FROM core/ EXCEPT the pure code-index splitter and its weight labels.
// The codebase's dependency direction is routes -> core -> services -> models/db, so a db/ module
// reaching back into core/ inverts it. The load-bearing consequence is markCodeIndexBuildFailed:
// redaction (AUD-01) cannot be performed here, so it is the CALLER's contract -- see that accessor.

import type { AppBindings } from '@server/env';
import {
  CODE_INDEX_CONTENT_WEIGHT,
  CODE_INDEX_PATH_WEIGHT,
  buildIndexTokens,
} from '@server/core/code-index';
import { queryRows, queryTransaction } from './client';

/**
 * One window to store. `contentTokens` is the pre-split content token string the 'D'-weighted half of
 * the vector is built from; when omitted it is derived here from buildIndexTokens(path, content) so
 * the write path can never accidentally store a vector built by a DIFFERENT splitter than the query
 * path uses (Pitfall 8 -- two splitters means a silent total retrieval miss under fail-open).
 */
export type CodeIndexChunkInput = {
  chunkStart: number;
  chunkEnd: number;
  content: string;
  contentTokens?: string;
};

export type CodeIndexChunkHit = {
  path: string;
  chunkStart: number;
  chunkEnd: number;
  content: string;
  rank: number;
};

/**
 * The documented `code_index_files.skip_reason` vocabulary from migration 018. Deliberately a TS union
 * rather than a Postgres CHECK constraint (migration 018 records why: a CHECK would turn adding a
 * reason into a schema migration on a column whose only writer is markCodeIndexFileIndexed). This type
 * is that single writer's contract -- a SHORT MACHINE TOKEN, never provider text and never file
 * content, so the column can be surfaced to an operator without a redaction pass.
 */
export type CodeIndexSkipReason = 'empty' | 'generated' | 'oversized' | 'unreadable';

export type CodeIndexStateRow = {
  repository_id: number;
  status: string;
  mode: string | null;
  indexed_ref: string | null;
  indexed_sha: string | null;
  building_sha: string | null;
  indexed_at: string | null;
  file_count: number;
  chunk_count: number;
  truncated: boolean;
  lease_expires_at: string | null;
  workflow_instance_id: string | null;
  continuation_count: number;
  last_error: string | null;
  updated_at: string;
};

/**
 * Persist every window of ONE file for ONE repository in a single parameterized multi-row INSERT.
 * An empty `chunks` array is a no-op (no statement issued).
 *
 * The stored vector is composed IN SQL as
 *   setweight(to_tsvector('english', <pathTokens>), 'A') || setweight(to_tsvector('english', <contentTokens>), 'D')
 * with BOTH token strings bound as parameters (D-04). Computing it in SQL rather than in a generated
 * column is deliberate -- see migration 018's KEY DESIGN 3: the JS per-chunk byte cap must run before
 * the insert, because to_tsvector raises above ~1 MB of resulting vector.
 *
 * ON CONFLICT (repository_id, path, chunk_start) DO UPDATE implements D-12's mutable current state: a
 * re-index of the same file overwrites its windows in place rather than accumulating history.
 */
export async function upsertCodeIndexChunks(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    repositoryId: number;
    path: string;
    indexedSha: string;
    pathTokens: string;
    chunks: CodeIndexChunkInput[];
  },
): Promise<void> {
  if (input.chunks.length === 0) return;

  const params: unknown[] = [];
  const tuples: string[] = [];

  for (const chunk of input.chunks) {
    const contentTokens = chunk.contentTokens ?? buildIndexTokens(input.path, chunk.content).contentTokens;
    const base = params.length;
    // Positional placeholders only -- every VALUE below is bound, never interpolated. The two
    // setweight() calls read bound parameters ($n+6 = pathTokens, $n+8 = contentTokens), so no token
    // text is ever part of the SQL string. The only interpolated non-placeholder text is the two
    // weight LABELS, which are `as const` 'A'/'D' literals from the pure core module and can never
    // carry input.
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, ` +
        `setweight(to_tsvector('english', $${base + 6}), '${CODE_INDEX_PATH_WEIGHT}') || ` +
        `setweight(to_tsvector('english', $${base + 8}), '${CODE_INDEX_CONTENT_WEIGHT}'), now())`,
    );
    params.push(
      input.repositoryId,
      input.path,
      chunk.chunkStart,
      chunk.chunkEnd,
      chunk.content,
      input.pathTokens,
      input.indexedSha,
      contentTokens,
    );
  }

  await queryRows(
    env,
    `
      INSERT INTO code_index_chunks
        (repository_id, path, chunk_start, chunk_end, content, path_tokens, indexed_sha,
         search_vector, updated_at)
      VALUES ${tuples.join(', ')}
      ON CONFLICT (repository_id, path, chunk_start) DO UPDATE SET
        chunk_end = EXCLUDED.chunk_end,
        content = EXCLUDED.content,
        path_tokens = EXCLUDED.path_tokens,
        indexed_sha = EXCLUDED.indexed_sha,
        search_vector = EXCLUDED.search_vector,
        updated_at = now()
    `,
    params,
  );
}

/**
 * Ranked, repository-scoped retrieval (D-03/D-04).
 *
 * `queryExpression` is the ' OR '-joined term string from buildQueryExpression and travels as EXACTLY
 * ONE bound parameter to websearch_to_tsquery. websearch_to_tsquery was chosen because it NEVER threw
 * on any measured input, including `foo & (`, `foo!!bad` and `');drop table x;--`; to_tsquery RAISES
 * on all three and is therefore not used anywhere in this module.
 *
 * `WHERE repository_id = $1` is MANDATORY and is the cross-repository isolation control
 * (T-29-01-03) -- the narrow code_index_chunks_repo_idx btree exists so this filter also drives the
 * plan instead of being a post-filter.
 *
 * A null or empty `queryExpression` resolves to [] WITHOUT issuing a statement. The accessor is
 * exported and callable from any future site, so relying on one caller's guard would be a
 * single-point-of-failure defense (29-REVIEWS.md, OpenCode 29-07). buildQueryExpression returns null
 * when no usable terms survive normalization and the Q&A caller guards as well: this early return is
 * deliberate defense in depth, not duplicated logic. A query built from no terms cannot match
 * anything, so the cheapest correct behavior is to skip Postgres entirely.
 */
export async function retrieveCodeIndexChunks(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    repositoryId: number;
    queryExpression: string | null;
    limit: number;
  },
): Promise<CodeIndexChunkHit[]> {
  if (input.queryExpression === null || input.queryExpression.length === 0) return [];

  const limit = Math.max(1, Math.floor(input.limit));
  const rows = await queryRows<{
    path: string;
    chunk_start: number | string;
    chunk_end: number | string;
    content: string;
    rank: number | string;
  }>(
    env,
    `
      SELECT c.path, c.chunk_start, c.chunk_end, c.content,
             ts_rank_cd(c.search_vector, q) AS rank
      FROM code_index_chunks c,
           websearch_to_tsquery('english', $2) AS q
      WHERE c.repository_id = $1
        AND c.search_vector @@ q
      ORDER BY ts_rank_cd(c.search_vector, q) DESC, c.path ASC, c.chunk_start ASC
      LIMIT $3
    `,
    [input.repositoryId, input.queryExpression, limit],
  );

  return rows.map((row) => ({
    path: row.path,
    chunkStart: Number(row.chunk_start),
    chunkEnd: Number(row.chunk_end),
    content: row.content,
    rank: Number(row.rank),
  }));
}

/** The per-repository build-state row (D-12), or null when no build has ever been started. */
export async function getCodeIndexState(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number },
): Promise<CodeIndexStateRow | null> {
  const [row] = await queryRows<CodeIndexStateRow>(
    env,
    `
      SELECT repository_id, status, mode, indexed_ref, indexed_sha, building_sha, indexed_at,
             file_count, chunk_count, truncated, lease_expires_at, workflow_instance_id,
             continuation_count, last_error, updated_at
      FROM code_index_state
      WHERE repository_id = $1
    `,
    [input.repositoryId],
  );
  return row ?? null;
}

/**
 * Move a repository's build state to 'building' and take a lease.
 *
 * `mode` is written HERE, at build START, not on completion: it is the operator-facing answer to "what
 * produced the index you are looking at", so a build that is still running or one that failed must
 * still be able to say whether it was a full rebuild or a push-triggered refresh (migration 018's
 * mode comment). `last_error` is cleared so a previous failure does not haunt the panel.
 */
export async function markCodeIndexBuildStarted(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    repositoryId: number;
    mode: 'full' | 'incremental';
    indexedRef: string | null;
    buildingSha: string | null;
    workflowInstanceId: string | null;
    leaseSeconds: number;
  },
): Promise<void> {
  await queryRows(
    env,
    `
      INSERT INTO code_index_state
        (repository_id, status, mode, indexed_ref, building_sha, workflow_instance_id,
         lease_expires_at, last_error, updated_at)
      VALUES ($1, 'building', $2, $3, $4, $5,
              now() + make_interval(secs => $6::double precision), NULL, now())
      ON CONFLICT (repository_id) DO UPDATE SET
        status = 'building',
        mode = EXCLUDED.mode,
        indexed_ref = EXCLUDED.indexed_ref,
        building_sha = EXCLUDED.building_sha,
        workflow_instance_id = EXCLUDED.workflow_instance_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        last_error = NULL,
        updated_at = now()
    `,
    [
      input.repositoryId,
      input.mode,
      input.indexedRef,
      input.buildingSha,
      input.workflowInstanceId,
      Math.max(1, Math.floor(input.leaseSeconds)),
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Incremental refresh / full rebuild (D-12)
//
// LEASE-AGNOSTIC PRIMITIVES. Neither deleteCodeIndexChunksForPaths nor truncateCodeIndexForRepo
// checks or acquires the build lease, because the SAME delete is needed by a full rebuild, by a push
// refresh, and by any future repair path -- three callers with three different lease stories. Making
// the delete claim a lease itself would either double-claim under the build Workflow (which already
// holds one) or silently steal it.
//
// The consequence is a CALLER CONTRACT, stated here so a future caller does not assume this module
// protects it: sequencing a destructive delete AFTER a successful claimCodeIndexBuildLease is the
// caller's responsibility. The enforcing half lives in the build Workflow (plan 29-05), which is the
// only caller: it must truncate only after the claim returned true, and must log a failed claim as a
// coalesced build rather than returning silently.
// ---------------------------------------------------------------------------------------------

/**
 * D-12's INCREMENTAL-REFRESH half: drop every stored window for a changed path set so the caller can
 * reinsert the current content. An empty `paths` array is a no-op (no statement issued).
 *
 * Both index tables are cleared for those paths. Deleting from code_index_files too is not optional
 * bookkeeping: a path whose chunks are gone but whose progress row survives reads as "already indexed
 * at this sha" to listIndexedPathsForSha, so a resumed build would skip a file it no longer has any
 * chunks for -- a silent, permanent retrieval hole for that path.
 *
 * The measured plan for this is an Index Scan on code_index_chunks_pkey, which is exactly why that
 * primary key is ordered (repository_id, path, chunk_start) -- see migration 018's KEY DESIGN 1.
 * `repository_id = $1` is bound and mandatory (T-29-04-01): a refresh for one repository can never
 * touch another's rows.
 */
export async function deleteCodeIndexChunksForPaths(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; paths: readonly string[] },
): Promise<void> {
  if (input.paths.length === 0) return;

  const params = [input.repositoryId, [...input.paths]];
  await queryRows(
    env,
    'DELETE FROM code_index_chunks WHERE repository_id = $1 AND path = ANY($2::text[])',
    params,
  );
  await queryRows(
    env,
    'DELETE FROM code_index_files WHERE repository_id = $1 AND path = ANY($2::text[])',
    params,
  );
}

/**
 * D-12's FULL-REBUILD half: remove one repository's entire index and reset its state counters.
 *
 * Runs inside queryTransaction, not as two or three queryRows calls, because D-12 requires the
 * truncate-and-reinsert to be atomic: a crash between the chunk delete and the file delete would leave
 * progress rows claiming paths whose chunks are gone, and a resumed build would skip every one of them.
 *
 * Every statement is bounded to one BOUND `repository_id`. This is deliberately NOT a table-level
 * TRUNCATE (T-29-04-01): a single table holds every tenant's indexed source, so an unscoped delete
 * would destroy other repositories' indexes -- and under D-15's fail-open policy those repositories'
 * Q&A would silently degrade to diff-only with nothing anywhere reporting why.
 *
 * `indexed_sha` / `indexed_at` are cleared alongside the counters because after this returns the
 * repository genuinely has no chunks; a surviving `indexed_sha` would tell the operator panel an index
 * exists at that commit. Clearing to NULL is not "writing a completed value" -- only
 * markCodeIndexBuildCompleted does that. `indexed_ref`, `mode`, `status` and the lease are left alone:
 * they belong to the build that is running, and this accessor is not that build.
 *
 * Returns the deleted row counts (29-REVIEWS.md, Antigravity S-03). The deletes already know them, and
 * an operator reading Worker logs after a rebuild needs "removed 4 812 chunks across 501 files" rather
 * than "reset done". The counts are FOR OBSERVABILITY ONLY -- no caller may branch on them, because a
 * legitimately empty index and a repository that was never indexed both report zero.
 */
export async function truncateCodeIndexForRepo(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number },
): Promise<{ deletedChunks: number; deletedFiles: number }> {
  return queryTransaction(env, async (tx) => {
    // DELETE ... RETURNING wrapped in a CTE is how the row count is obtained: postgres.js surfaces
    // rows, not a command tag, through this client's query() shape.
    const [chunks] = await tx.query<{ n: number | string }>(
      `
        WITH removed AS (
          DELETE FROM code_index_chunks WHERE repository_id = $1 RETURNING 1
        )
        SELECT count(*)::int AS n FROM removed
      `,
      [input.repositoryId],
    );
    const [files] = await tx.query<{ n: number | string }>(
      `
        WITH removed AS (
          DELETE FROM code_index_files WHERE repository_id = $1 RETURNING 1
        )
        SELECT count(*)::int AS n FROM removed
      `,
      [input.repositoryId],
    );
    await tx.query(
      `
        UPDATE code_index_state
        SET file_count = 0,
            chunk_count = 0,
            truncated = false,
            indexed_sha = NULL,
            indexed_at = NULL,
            updated_at = now()
        WHERE repository_id = $1
      `,
      [input.repositoryId],
    );

    return {
      deletedChunks: Number(chunks?.n ?? 0),
      deletedFiles: Number(files?.n ?? 0),
    };
  });
}

/**
 * D-05's RESUMABILITY read: which paths this repository has already recorded at `indexedSha`. Empty
 * array when none. This is the per-unit-progress convention the review path already uses for per-file
 * review results (db/file-reviews.ts) -- persist what is done so a retried run skips it.
 *
 * It MUST be read at the IN-PROGRESS build sha (`code_index_state.building_sha`), never at
 * `indexed_sha`. At the in-progress sha it answers "what did this build already fetch"; at the last
 * completed sha it would answer "what did the PREVIOUS build fetch", so a resumed build would skip
 * files whose content has since changed and quietly keep serving stale windows for them.
 *
 * code_index_files is keyed (repository_id, path) and holds CURRENT STATE only (D-12), so this returns
 * empty for any older sha. That is correct, not a gap: only the in-progress sha matters for
 * resumability, and auditing "what was indexed three commits ago" is not something D-12's mutable
 * table is meant to answer (29-REVIEWS.md, OpenCode 29-04 LOW -- accepted as designed).
 */
export async function listIndexedPathsForSha(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; indexedSha: string },
): Promise<string[]> {
  const rows = await queryRows<{ path: string }>(
    env,
    `
      SELECT path
      FROM code_index_files
      WHERE repository_id = $1
        AND indexed_sha = $2
      ORDER BY path ASC
    `,
    [input.repositoryId, input.indexedSha],
  );
  return rows.map((row) => row.path);
}

/**
 * Record one file's per-build progress (D-05). Upserts on (repository_id, path) so a re-index
 * overwrites the row in place rather than accumulating history -- the same mutable-current-state rule
 * the chunk table follows.
 *
 * A file that produced ZERO chunks -- empty, generated, or over CODE_INDEX_MAX_FILE_BYTES -- MUST
 * still be recorded here, with `skipReason` set. Skipping the write for a zero-chunk file is the
 * failure mode this contract exists to prevent: listIndexedPathsForSha would never return that path,
 * so every continuation of the build re-fetches it, spends a subrequest on it, drops it again, and
 * makes no progress -- forever, until the continuation ceiling kills the build.
 *
 * `skipReason` is a short machine token from the documented CodeIndexSkipReason vocabulary. It is
 * NEVER provider text, an error message, or file content: the column is operator-visible and this
 * module cannot redact (see markCodeIndexBuildFailed's note on the core/ import direction).
 */
export async function markCodeIndexFileIndexed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    repositoryId: number;
    path: string;
    indexedSha: string;
    chunkCount: number;
    skipReason?: CodeIndexSkipReason | null;
  },
): Promise<void> {
  await queryRows(
    env,
    `
      INSERT INTO code_index_files
        (repository_id, path, indexed_sha, chunk_count, skip_reason, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (repository_id, path) DO UPDATE SET
        indexed_sha = EXCLUDED.indexed_sha,
        chunk_count = EXCLUDED.chunk_count,
        skip_reason = EXCLUDED.skip_reason,
        updated_at = now()
    `,
    [
      input.repositoryId,
      input.path,
      input.indexedSha,
      Math.max(0, Math.floor(input.chunkCount)),
      input.skipReason ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------------------------
// Build lease + terminal state
//
// The lease vocabulary mirrors the jobs table's (db/jobs.ts claimJobLease / heartbeatJobLease /
// releaseJobLease): a claim is a SINGLE conditional statement whose WHERE clause encodes the entire
// precondition, and success is read off the returned row count -- never from a preceding SELECT, which
// would open a check-then-act window two concurrent build triggers can both pass through.
// ---------------------------------------------------------------------------------------------

/** Clamp a caller-supplied lease/renewal window to a whole positive number of seconds. */
function normalizeLeaseSeconds(leaseSeconds: number): number {
  return Math.max(1, Math.floor(leaseSeconds));
}

/**
 * Take the exclusive build lease for one repository. Returns true when this instance now owns it.
 *
 * This is the concurrency guard for a second build start (T-29-04-04): a dashboard press and a push
 * event can race, and two builds writing the same (repository_id, path, chunk_start) rows at two
 * different shas produce an index that is half of each commit.
 *
 * WHY A LEASE AND NOT JUST WORKFLOW INSTANCE-ID DEDUP: `instance.already_exists` is already treated as
 * a benign duplicate elsewhere in this codebase, which handles the double-press case -- but a DEAD
 * instance's id ALSO collides, which is precisely why the review path has to set a fresh-instance flag
 * during recovery. Instance-id dedup alone therefore turns a crashed build into a permanently
 * un-restartable one. The durable lease with an expiry is the authoritative guard; the instance-id
 * dedup is defense in depth on top of it.
 *
 * The whole precondition lives in one statement: the INSERT branch covers "no state row at all", and
 * the ON CONFLICT ... WHERE covers "not building", "the lease has expired", and "this same instance is
 * re-entering". The last of those is not a convenience -- a Workflow that hibernates and resumes
 * re-enters with the same instance id, so without it a build would lock ITSELF out of its own lease
 * and stall until expiry on every single continuation.
 *
 * `make_interval(secs => $3::double precision)` is deliberate and VERIFIED, not accidental: cross-AI
 * review asked whether it is portable, and it was executed against the live test database
 * (PostgreSQL 17.10) during that review. Do NOT rewrite it to `now() + ($3 || ' seconds')::interval` --
 * that form builds an interval LITERAL out of a value, where make_interval takes typed seconds.
 */
export async function claimCodeIndexBuildLease(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; workflowInstanceId: string; leaseSeconds: number },
): Promise<boolean> {
  const rows = await queryRows<{ repository_id: number }>(
    env,
    `
      INSERT INTO code_index_state
        (repository_id, status, workflow_instance_id, lease_expires_at, updated_at)
      VALUES ($1, 'building', $2, now() + make_interval(secs => $3::double precision), now())
      ON CONFLICT (repository_id) DO UPDATE SET
        status = 'building',
        workflow_instance_id = EXCLUDED.workflow_instance_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = now()
      WHERE code_index_state.status <> 'building'
         OR code_index_state.lease_expires_at IS NULL
         OR code_index_state.lease_expires_at <= now()
         OR code_index_state.workflow_instance_id = $2
      RETURNING repository_id
    `,
    [input.repositoryId, input.workflowInstanceId, normalizeLeaseSeconds(input.leaseSeconds)],
  );
  return rows.length > 0;
}

/**
 * Extend the lease, but ONLY for the instance that holds it. Returns whether it did.
 *
 * The instance match is the whole point: a heartbeat from a build that already lost the lease (because
 * it stalled past expiry and another build claimed it) must NOT extend the new owner's window.
 */
export async function renewCodeIndexBuildLease(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; workflowInstanceId: string; leaseSeconds: number },
): Promise<boolean> {
  const rows = await queryRows<{ repository_id: number }>(
    env,
    `
      UPDATE code_index_state
      SET lease_expires_at = now() + make_interval(secs => $3::double precision),
          updated_at = now()
      WHERE repository_id = $1
        AND workflow_instance_id = $2
      RETURNING repository_id
    `,
    [input.repositoryId, input.workflowInstanceId, normalizeLeaseSeconds(input.leaseSeconds)],
  );
  return rows.length > 0;
}

/**
 * Release the lease AND resolve the status, in one statement, for the owning instance only.
 *
 * BOTH halves are needed (29-REVIEWS.md, OpenCode 29-04 #11). Clearing only the lease leaves a row
 * reading `status = 'building'` with no live lease -- which is exactly the state the operator panel
 * renders as "a build is running", for as long as nobody rebuilds. The lease expiry guards
 * CORRECTNESS (a new build can claim), but nothing repairs the DISPLAY. So a row still marked
 * `building` at release time becomes `idle`.
 *
 * The status is forced ONLY from `building`, never from `ready` or `failed`. The terminal accessors run
 * BEFORE release in the happy and unhappy paths respectively, and their status is the authoritative
 * outcome; clobbering it to `idle` here would erase a success or failure that was just recorded.
 */
export async function releaseCodeIndexBuildLease(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; workflowInstanceId: string },
): Promise<void> {
  await queryRows(
    env,
    `
      UPDATE code_index_state
      SET lease_expires_at = NULL,
          workflow_instance_id = NULL,
          status = CASE WHEN status = 'building' THEN 'idle' ELSE status END,
          updated_at = now()
      WHERE repository_id = $1
        AND workflow_instance_id = $2
    `,
    [input.repositoryId, input.workflowInstanceId],
  );
}

/**
 * Record a successful build: the index now describes `indexedSha` at `indexedRef`.
 *
 * This is the ONLY accessor that advances `indexed_sha` to a completed value, and it runs only on
 * success. An interrupted build therefore never leaves the row claiming a commit it did not finish --
 * the in-progress commit lives in `building_sha`, which is cleared here, and D-12's "retrieval never
 * filters by ref" only holds because `indexed_sha` is provenance rather than a query key.
 *
 * `continuation_count` is reset so the next build starts with a full continuation budget, and
 * `last_error` is cleared so a previous failure does not haunt the operator panel after a good build.
 */
export async function markCodeIndexBuildCompleted(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    repositoryId: number;
    indexedRef: string | null;
    indexedSha: string;
    fileCount: number;
    chunkCount: number;
    truncated: boolean;
  },
): Promise<void> {
  await queryRows(
    env,
    `
      UPDATE code_index_state
      SET status = 'ready',
          indexed_ref = $2,
          indexed_sha = $3,
          indexed_at = now(),
          file_count = $4,
          chunk_count = $5,
          truncated = $6::boolean,
          building_sha = NULL,
          lease_expires_at = NULL,
          workflow_instance_id = NULL,
          continuation_count = 0,
          last_error = NULL,
          updated_at = now()
      WHERE repository_id = $1
    `,
    [
      input.repositoryId,
      input.indexedRef,
      input.indexedSha,
      Math.max(0, Math.floor(input.fileCount)),
      Math.max(0, Math.floor(input.chunkCount)),
      input.truncated,
    ],
  );
}

/**
 * Record a failed build and clear the lease so the failure is not mistaken for a live build.
 *
 * `message` MUST ARRIVE ALREADY REDACTED. AUD-01 requires operator-visible error text to be routed
 * through `redactErrorMessage` (src/server/core/audit-redact.ts), and that is the CALLER's
 * responsibility, not this module's: `db/` modules must not import `core/` (the dependency direction is
 * routes -> core -> services -> models/db), so redaction cannot happen here. Stating the contract at
 * the boundary is what keeps it from being silently skipped -- if this layer quietly took redaction
 * over, `last_error` would become the one operator surface where a raw provider response body or a
 * stack frame could land.
 *
 * `indexed_sha` is deliberately NOT touched: a failed refresh leaves the previously-completed index in
 * place and still usable, which is what D-15's fail-open Q&A reads.
 */
export async function markCodeIndexBuildFailed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { repositoryId: number; message: string },
): Promise<void> {
  await queryRows(
    env,
    `
      UPDATE code_index_state
      SET status = 'failed',
          last_error = $2,
          lease_expires_at = NULL,
          workflow_instance_id = NULL,
          updated_at = now()
      WHERE repository_id = $1
    `,
    [input.repositoryId, input.message],
  );
}
