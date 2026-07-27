// Phase 29 / QA-IDX-01, plan 29-04 — the DB-backed guarantees of src/server/db/code-index.ts.
//
// test/code-index-splitter.spec.ts, -chunker and -query prove the PURE core. This file covers what
// those unit tests structurally cannot: whether the accessors actually change Postgres. Every
// correctness property the rest of the phase assumes is a property of this module, not of the build
// Workflow that loops over it — a resumed build skips finished files, a second build press does not
// race, a push refresh leaves no stale chunks for a deleted path, and one repository's source never
// reaches another repository's answer.
//
// INVARIANT FOR EVERY CASE HERE: the assertion re-reads the state from Postgres rather than trusting
// the accessor's return value. The defect class these tests exist to catch is "the accessor returned
// without error but nothing persisted" — and under D-15's fail-open retrieval policy that defect is
// completely SILENT in production.
//
// Gated on hasConfiguredTestDatabaseUrl() the way the migration specs are. Migration 018 is applied to
// TEST_DATABASE_URL by `npm test` (scripts/test.mjs sets DATABASE_URL = TEST_DATABASE_URL and runs
// scripts/migrate.mjs), so a "relation does not exist" failure here is an un-migrated database rather
// than a code defect.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildIndexTokens } from '@server/core/code-index';
import {
  deleteCodeIndexChunksForPaths,
  listIndexedPathsForSha,
  markCodeIndexBuildStarted,
  markCodeIndexFileIndexed,
  truncateCodeIndexForRepo,
  upsertCodeIndexChunks,
} from '@server/db/code-index';
import { getOrCreateRepository } from '@server/db/repositories';
import { queryRows } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

dbDescribe('code index DB accessors (QA-IDX-01, plan 29-04)', () => {
  const env = createTestEnv();

  // TWO repositories, seeded once. The second exists specifically so the cross-repository isolation
  // and full-rebuild cases have a real neighbour whose rows must survive — a single-repository fixture
  // cannot distinguish "scoped correctly" from "the table only ever held one tenant".
  let repoA = 0;
  let repoB = 0;

  async function seedRepositories() {
    if (repoA && repoB) return;
    repoA = await getOrCreateRepository(env, {
      installationId: '99000294',
      owner: 'codra-idxdb-owner',
      repo: 'codra-idxdb-29-04-a',
      vcsProvider: 'github',
    });
    repoB = await getOrCreateRepository(env, {
      installationId: '99000295',
      owner: 'codra-idxdb-owner',
      repo: 'codra-idxdb-29-04-b',
      vcsProvider: 'github',
    });
  }

  /**
   * Remove only THIS spec's rows. The test database is never reset, so a spec that leaves rows behind
   * makes later suites flake (row accumulation is fixed by truncating, never by changing production
   * code). Deliberately raw SQL rather than truncateCodeIndexForRepo: teardown must not depend on the
   * accessor under test.
   */
  async function clearIndexRows() {
    if (!repoA || !repoB) return;
    const ids = [repoA, repoB];
    await queryRows(env, 'DELETE FROM code_index_chunks WHERE repository_id = ANY($1::int[])', [ids]);
    await queryRows(env, 'DELETE FROM code_index_files WHERE repository_id = ANY($1::int[])', [ids]);
    await queryRows(env, 'DELETE FROM code_index_state WHERE repository_id = ANY($1::int[])', [ids]);
  }

  beforeEach(async () => {
    await seedRepositories();
    await clearIndexRows();
  });

  afterAll(async () => {
    await clearIndexRows();
  });

  // ---- raw re-read helpers: every assertion goes through one of these ----

  async function readChunkRows(repositoryId: number) {
    return queryRows<{ path: string; chunk_start: number | string; octets: number | string }>(
      env,
      `
        SELECT path, chunk_start, octet_length(content) AS octets
        FROM code_index_chunks
        WHERE repository_id = $1
        ORDER BY path ASC, chunk_start ASC
      `,
      [repositoryId],
    );
  }

  async function readFileRows(repositoryId: number) {
    return queryRows<{
      path: string;
      indexed_sha: string;
      chunk_count: number | string;
      skip_reason: string | null;
    }>(
      env,
      `
        SELECT path, indexed_sha, chunk_count, skip_reason
        FROM code_index_files
        WHERE repository_id = $1
        ORDER BY path ASC
      `,
      [repositoryId],
    );
  }

  async function readStateRow(repositoryId: number) {
    const [row] = await queryRows<{
      status: string;
      mode: string | null;
      indexed_ref: string | null;
      indexed_sha: string | null;
      building_sha: string | null;
      indexed_at: string | null;
      file_count: number | string;
      chunk_count: number | string;
      truncated: boolean;
      workflow_instance_id: string | null;
      lease_expires_at: string | null;
      continuation_count: number | string;
      last_error: string | null;
    }>(
      env,
      `
        SELECT status, mode, indexed_ref, indexed_sha, building_sha, indexed_at, file_count,
               chunk_count, truncated, workflow_instance_id, lease_expires_at, continuation_count,
               last_error
        FROM code_index_state
        WHERE repository_id = $1
      `,
      [repositoryId],
    );
    return row ?? null;
  }

  /** Store one single-line window for a path, deriving both token strings from the shared splitter. */
  async function seedChunk(
    repositoryId: number,
    chunkPath: string,
    content: string,
    indexedSha = SHA_A,
    chunkStart = 1,
  ) {
    const tokens = buildIndexTokens(chunkPath, content);
    await upsertCodeIndexChunks(env, {
      repositoryId,
      path: chunkPath,
      indexedSha,
      pathTokens: tokens.pathTokens,
      chunks: [
        { chunkStart, chunkEnd: chunkStart, content, contentTokens: tokens.contentTokens },
      ],
    });
  }

  // =============================================================================================
  // Group 1 — incremental refresh (D-12): a deleted path leaves NO orphan in either table
  // =============================================================================================

  describe('incremental refresh (D-12)', () => {
    it('deletes chunk AND progress rows for the changed path only, leaving other paths intact', async () => {
      const changed = 'src/server/core/changed-module.ts';
      const untouched = 'src/server/core/untouched-module.ts';

      await seedChunk(repoA, changed, 'export const changed = 1;', SHA_A, 1);
      await seedChunk(repoA, changed, 'export const changedTwo = 2;', SHA_A, 51);
      await seedChunk(repoA, untouched, 'export const untouched = 3;', SHA_A, 1);
      await markCodeIndexFileIndexed(env, {
        repositoryId: repoA,
        path: changed,
        indexedSha: SHA_A,
        chunkCount: 2,
      });
      await markCodeIndexFileIndexed(env, {
        repositoryId: repoA,
        path: untouched,
        indexedSha: SHA_A,
        chunkCount: 1,
      });

      // Precondition, re-read from Postgres: three chunk rows, two progress rows.
      expect((await readChunkRows(repoA)).length).toBe(3);
      expect((await readFileRows(repoA)).length).toBe(2);

      await deleteCodeIndexChunksForPaths(env, { repositoryId: repoA, paths: [changed] });

      const chunkRows = await readChunkRows(repoA);
      const fileRows = await readFileRows(repoA);
      expect(chunkRows.map((row) => row.path)).toEqual([untouched]);
      expect(fileRows.map((row) => row.path)).toEqual([untouched]);
      // The orphan case explicitly: no progress row may survive a path whose chunks are gone, or a
      // resumed build would skip a file it has no chunks for.
      expect(chunkRows.some((row) => row.path === changed)).toBe(false);
      expect(fileRows.some((row) => row.path === changed)).toBe(false);
    });

    it('is a no-op for an empty path set and never touches another repository', async () => {
      const shared = 'src/shared/schema.ts';
      await seedChunk(repoA, shared, 'export const a = 1;');
      await seedChunk(repoB, shared, 'export const b = 2;');

      await deleteCodeIndexChunksForPaths(env, { repositoryId: repoA, paths: [] });
      expect((await readChunkRows(repoA)).length).toBe(1);

      // Same path string in both repositories: the delete is bounded by the bound repository_id.
      await deleteCodeIndexChunksForPaths(env, { repositoryId: repoA, paths: [shared] });
      expect(await readChunkRows(repoA)).toEqual([]);
      expect((await readChunkRows(repoB)).map((row) => row.path)).toEqual([shared]);
    });
  });

  // =============================================================================================
  // Group 2 — full rebuild (D-12): scoped to one repository, atomic, and it reports what it removed
  // =============================================================================================

  describe('full rebuild (D-12)', () => {
    it('removes only that repository\'s rows, resets its counters, and returns the deleted counts', async () => {
      // repoA: two paths, three chunks. repoB: one path, one chunk.
      await seedChunk(repoA, 'src/a/one.ts', 'export const one = 1;', SHA_A, 1);
      await seedChunk(repoA, 'src/a/one.ts', 'export const oneB = 2;', SHA_A, 51);
      await seedChunk(repoA, 'src/a/two.ts', 'export const two = 3;', SHA_A, 1);
      await markCodeIndexFileIndexed(env, { repositoryId: repoA, path: 'src/a/one.ts', indexedSha: SHA_A, chunkCount: 2 });
      await markCodeIndexFileIndexed(env, { repositoryId: repoA, path: 'src/a/two.ts', indexedSha: SHA_A, chunkCount: 1 });

      await seedChunk(repoB, 'src/b/keep.ts', 'export const keep = 4;', SHA_B, 1);
      await markCodeIndexFileIndexed(env, { repositoryId: repoB, path: 'src/b/keep.ts', indexedSha: SHA_B, chunkCount: 1 });

      // Give both repositories a populated state row so "counters reset" is observable. The counters
      // are set with raw SQL rather than through markCodeIndexBuildCompleted so this case depends on
      // exactly one accessor — the truncate under test.
      for (const [id, sha, files, chunks] of [
        [repoA, SHA_A, 2, 3],
        [repoB, SHA_B, 1, 1],
      ] as const) {
        await markCodeIndexBuildStarted(env, {
          repositoryId: id,
          mode: 'full',
          indexedRef: 'main',
          buildingSha: sha,
          workflowInstanceId: `seed-${id}`,
          leaseSeconds: 120,
        });
        await queryRows(
          env,
          `
            UPDATE code_index_state
            SET status = 'ready', indexed_sha = $2, indexed_at = now(), file_count = $3,
                chunk_count = $4, truncated = true
            WHERE repository_id = $1
          `,
          [id, sha, files, chunks],
        );
      }

      const result = await truncateCodeIndexForRepo(env, { repositoryId: repoA });

      // The returned counts match what was seeded (observability only — no caller branches on them).
      expect(result).toEqual({ deletedChunks: 3, deletedFiles: 2 });

      // repoA is empty and its counters are reset, re-read from Postgres.
      expect(await readChunkRows(repoA)).toEqual([]);
      expect(await readFileRows(repoA)).toEqual([]);
      const stateA = await readStateRow(repoA);
      expect(Number(stateA?.file_count)).toBe(0);
      expect(Number(stateA?.chunk_count)).toBe(0);
      expect(stateA?.truncated).toBe(false);
      expect(stateA?.indexed_sha).toBeNull();
      expect(stateA?.indexed_at).toBeNull();
      // indexed_ref belongs to the build, not to the delete.
      expect(stateA?.indexed_ref).toBe('main');

      // repoB is untouched: chunk count, progress rows AND state counters.
      expect((await readChunkRows(repoB)).map((row) => row.path)).toEqual(['src/b/keep.ts']);
      expect((await readFileRows(repoB)).map((row) => row.path)).toEqual(['src/b/keep.ts']);
      const stateB = await readStateRow(repoB);
      expect(Number(stateB?.file_count)).toBe(1);
      expect(Number(stateB?.chunk_count)).toBe(1);
      expect(stateB?.indexed_sha).toBe(SHA_B);
    });

    it('reports zero counts for a repository that has nothing indexed', async () => {
      const result = await truncateCodeIndexForRepo(env, { repositoryId: repoA });
      expect(result).toEqual({ deletedChunks: 0, deletedFiles: 0 });
      expect(await readChunkRows(repoA)).toEqual([]);
    });
  });

  // =============================================================================================
  // Group 3 — resumability (D-05): per-file progress is what a retried build reads
  // =============================================================================================

  describe('resumability (D-05)', () => {
    it('returns exactly the paths recorded at the in-progress sha, and [] for a different sha', async () => {
      const done = 'src/server/core/done.ts';
      const skipped = 'src/generated/bundle.js';
      const older = 'src/server/core/older.ts';

      await markCodeIndexFileIndexed(env, { repositoryId: repoA, path: done, indexedSha: SHA_A, chunkCount: 4 });
      await markCodeIndexFileIndexed(env, {
        repositoryId: repoA,
        path: skipped,
        indexedSha: SHA_A,
        chunkCount: 0,
        skipReason: 'generated',
      });
      // A path recorded at a DIFFERENT sha must not leak into the in-progress build's skip set.
      await markCodeIndexFileIndexed(env, { repositoryId: repoA, path: older, indexedSha: SHA_B, chunkCount: 2 });

      // ORDER BY path ASC: 'src/generated/...' sorts before 'src/server/...'.
      expect(await listIndexedPathsForSha(env, { repositoryId: repoA, indexedSha: SHA_A })).toEqual([
        skipped,
        done,
      ]);
      expect(await listIndexedPathsForSha(env, { repositoryId: repoA, indexedSha: SHA_B })).toEqual([older]);
      expect(
        await listIndexedPathsForSha(env, { repositoryId: repoA, indexedSha: 'c'.repeat(40) }),
      ).toEqual([]);
    });

    it('records a zero-chunk skip so a resumed build does not re-fetch it forever', async () => {
      const skipped = 'src/generated/huge-bundle.js';
      await markCodeIndexFileIndexed(env, {
        repositoryId: repoA,
        path: skipped,
        indexedSha: SHA_A,
        chunkCount: 0,
        skipReason: 'oversized',
      });

      // Re-read the row itself: the skip reason and the zero count must be persisted, not just the path.
      const rows = await readFileRows(repoA);
      expect(rows).toEqual([
        { path: skipped, indexed_sha: SHA_A, chunk_count: 0, skip_reason: 'oversized' },
      ]);
      // And it IS returned by the resumability read, which is the whole point of recording it.
      expect(await listIndexedPathsForSha(env, { repositoryId: repoA, indexedSha: SHA_A })).toEqual([skipped]);
    });

    it('upserts on (repository_id, path) rather than accumulating a row per build', async () => {
      const path = 'src/server/core/rebuilt.ts';
      await markCodeIndexFileIndexed(env, {
        repositoryId: repoA,
        path,
        indexedSha: SHA_A,
        chunkCount: 0,
        skipReason: 'empty',
      });
      await markCodeIndexFileIndexed(env, { repositoryId: repoA, path, indexedSha: SHA_B, chunkCount: 7 });

      expect(await readFileRows(repoA)).toEqual([
        { path, indexed_sha: SHA_B, chunk_count: 7, skip_reason: null },
      ]);
    });

    it('scopes the resumability read to one repository', async () => {
      const shared = 'src/shared/schema.ts';
      await markCodeIndexFileIndexed(env, { repositoryId: repoA, path: shared, indexedSha: SHA_A, chunkCount: 1 });

      expect(await listIndexedPathsForSha(env, { repositoryId: repoB, indexedSha: SHA_A })).toEqual([]);
      expect(await listIndexedPathsForSha(env, { repositoryId: repoA, indexedSha: SHA_A })).toEqual([shared]);
    });
  });
});
