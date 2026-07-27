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
// SURFACE IS DELIBERATELY PARTIAL. This plan wires the write path, the ranked read path, and the
// build-start upsert. The remaining lease, incremental-refresh and completion accessors
// (claimCodeIndexBuildLease, renewCodeIndexBuildLease, releaseCodeIndexBuildLease,
// markCodeIndexBuildCompleted, markCodeIndexBuildFailed, listIndexedPathsForSha,
// markCodeIndexFileIndexed, deleteCodeIndexChunksForPaths, truncateCodeIndexForRepo) land in plan
// 29-04. Do not read this file as the complete accessor set.

import type { AppBindings } from '@server/env';
import {
  CODE_INDEX_CONTENT_WEIGHT,
  CODE_INDEX_PATH_WEIGHT,
  buildIndexTokens,
} from '@server/core/code-index';
import { queryRows } from './client';

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
