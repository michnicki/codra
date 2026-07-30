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
// THE THREE MEASURED POSTGRES FACTS THE RETRIEVAL CASES GUARD. Each was measured on the live test
// database during phase 29 research, and each failure mode is silent:
//
//   1. A raw slash path tokenizes to ONE unsearchable lexeme. to_tsvector('english',
//      'src/server/core/code-index.ts') produces exactly the single lexeme
//      'src/server/core/code-index.ts', so a question about "code index" never matches it. The path
//      half of the vector must therefore be fed PRE-SPLIT tokens from buildIndexTokens. (Postgres's
//      own path tokenization is also unpredictable: 'a_b/c-d/e.f' silently DROPS the leading 'a_'.)
//      The path-tokenization case below is the regression guard — if raw paths are ever fed to the
//      vector again, it is the only thing that fails.
//   2. The 'A' and 'D' weight labels produce the path-over-body ordering with NO post-processing.
//      ts_rank_cd's weight array is ordered {D, C, B, A}, so the defaults {0.1, 0.2, 0.4, 1.0} make a
//      path-token hit outrank a body-only hit by 10x (2.0 vs 0.2) for the same query.
//   3. to_tsvector RAISES above roughly 1 MB of RESULTING vector, and the vector is LARGER than its
//      input (a 1 088 889-byte input produced a 1 477 980-byte vector against the 1 048 575-byte
//      ceiling). That is why CODE_INDEX_MAX_CHUNK_BYTES is enforced in JS BEFORE the insert rather
//      than by a generated column — the pathological-input case asserts the insert RESOLVES.
//
// Gated on hasConfiguredTestDatabaseUrl() the way the migration specs are. Migration 018 is applied to
// TEST_DATABASE_URL by `npm test` (scripts/test.mjs sets DATABASE_URL = TEST_DATABASE_URL and runs
// scripts/migrate.mjs), so a "relation does not exist" failure here is an un-migrated database rather
// than a code defect.
//
// ENVIRONMENT HAZARDS — recorded so a future reader does not misdiagnose one as a code defect:
//   - The live local test Postgres does NOT answer on the port written in `.env.test` (5432). It has
//     been observed on 5433 and on 5455 depending on the local data directory, so an ECONNREFUSED
//     here is an ENVIRONMENT problem: point TEST_DATABASE_URL at the running instance. Do not
//     "fix" it by changing production code or by hardcoding a port anywhere.
//   - The test database is NEVER reset, so it accumulates rows across runs and any LIMIT-bounded
//     query can start flaking. The fix is TRUNCATE ... CASCADE on the offending table, never a
//     production code change. This spec removes its own rows in beforeEach and afterAll for exactly
//     that reason.
//   - A bare `npx vitest run` skips the env files entirely, so createTestEnv() throws on a missing
//     BITBUCKET_CLIENT_ID before any case runs. Use `npm test`, or load the env files first.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_INDEX_MAX_CHUNK_BYTES,
  buildIndexTokens,
  buildQueryExpression,
  buildQueryTerms,
  chunkLines,
} from '@server/core/code-index';
import {
  claimCodeIndexBuildLease,
  deleteCodeIndexChunksForPaths,
  listIndexedPathsForSha,
  markCodeIndexBuildCompleted,
  markCodeIndexBuildFailed,
  markCodeIndexBuildStarted,
  markCodeIndexFileIndexed,
  releaseCodeIndexBuildLease,
  renewCodeIndexBuildLease,
  retrieveCodeIndexChunks,
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

  // =============================================================================================
  // Group 4 — the build lease: the concurrency guard (T-29-04-04)
  // =============================================================================================

  describe('build lease', () => {
    const OWNER = 'index-instance-1';
    const RIVAL = 'index-instance-2';

    /** Force the stored lease into the past without touching status or instance id. */
    async function expireLease(repositoryId: number) {
      await queryRows(
        env,
        "UPDATE code_index_state SET lease_expires_at = now() - interval '1 minute' WHERE repository_id = $1",
        [repositoryId],
      );
    }

    it('claims when there is no state row at all, and records the owner and a future expiry', async () => {
      expect(await readStateRow(repoA)).toBeNull();

      await expect(
        claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 120 }),
      ).resolves.toBe(true);

      const state = await readStateRow(repoA);
      expect(state?.status).toBe('building');
      expect(state?.workflow_instance_id).toBe(OWNER);
      expect(new Date(state!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());
    });

    it('runs all four transitions: first claim true, foreign claim false, same-instance re-claim true, post-release foreign claim true', async () => {
      expect(
        await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 300 }),
      ).toBe(true);

      // A second build press while the lease is live is REFUSED, and it must not have stolen the row.
      expect(
        await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: RIVAL, leaseSeconds: 300 }),
      ).toBe(false);
      expect((await readStateRow(repoA))?.workflow_instance_id).toBe(OWNER);

      // The owning instance re-enters after a hibernation — it must NOT lock itself out.
      expect(
        await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 300 }),
      ).toBe(true);
      expect((await readStateRow(repoA))?.workflow_instance_id).toBe(OWNER);

      await releaseCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER });

      expect(
        await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: RIVAL, leaseSeconds: 300 }),
      ).toBe(true);
      expect((await readStateRow(repoA))?.workflow_instance_id).toBe(RIVAL);
    });

    it('claims over an EXPIRED lease, so a crashed build cannot hold it forever', async () => {
      await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 300 });
      await expireLease(repoA);

      expect(
        await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: RIVAL, leaseSeconds: 300 }),
      ).toBe(true);
      const state = await readStateRow(repoA);
      expect(state?.workflow_instance_id).toBe(RIVAL);
      expect(new Date(state!.lease_expires_at!).getTime()).toBeGreaterThan(Date.now());
    });

    it('is scoped per repository: one repository\'s live lease never blocks another\'s claim', async () => {
      await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 300 });

      expect(
        await claimCodeIndexBuildLease(env, { repositoryId: repoB, workflowInstanceId: OWNER, leaseSeconds: 300 }),
      ).toBe(true);
      expect((await readStateRow(repoA))?.workflow_instance_id).toBe(OWNER);
      expect((await readStateRow(repoB))?.workflow_instance_id).toBe(OWNER);
    });

    it('renews only for the instance that owns the lease', async () => {
      await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 60 });
      const before = new Date((await readStateRow(repoA))!.lease_expires_at!).getTime();

      // A heartbeat from a build that does not hold the lease must not extend the owner's window.
      expect(
        await renewCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: RIVAL, leaseSeconds: 3600 }),
      ).toBe(false);
      expect(new Date((await readStateRow(repoA))!.lease_expires_at!).getTime()).toBe(before);

      expect(
        await renewCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 3600 }),
      ).toBe(true);
      expect(new Date((await readStateRow(repoA))!.lease_expires_at!).getTime()).toBeGreaterThan(before);
    });

    it('release from `building` clears the lease AND lands on `idle`, so no released row reads as a live build', async () => {
      await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 300 });
      expect((await readStateRow(repoA))?.status).toBe('building');

      await releaseCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER });

      const state = await readStateRow(repoA);
      expect(state?.status).toBe('idle');
      expect(state?.lease_expires_at).toBeNull();
      expect(state?.workflow_instance_id).toBeNull();
    });

    it.each([
      ['ready', 'markCodeIndexBuildCompleted'],
      ['failed', 'markCodeIndexBuildFailed'],
    ] as const)(
      'release after a terminal transition leaves `%s` intact rather than erasing the recorded outcome',
      async (terminalStatus, _accessor) => {
        await claimCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER, leaseSeconds: 300 });

        if (terminalStatus === 'ready') {
          await markCodeIndexBuildCompleted(env, {
            repositoryId: repoA,
            indexedRef: 'main',
            indexedSha: SHA_A,
            fileCount: 3,
            chunkCount: 9,
            truncated: false,
          });
        } else {
          await markCodeIndexBuildFailed(env, { repositoryId: repoA, message: 'provider_5xx' });
        }
        expect((await readStateRow(repoA))?.status).toBe(terminalStatus);

        // Both terminal accessors already clear workflow_instance_id, so the ordinary release that
        // follows them matches no row. Restoring the instance id drives the CASE branch directly, so
        // this asserts the statement's behavior and not just the WHERE clause's.
        await queryRows(env, 'UPDATE code_index_state SET workflow_instance_id = $2 WHERE repository_id = $1', [
          repoA,
          OWNER,
        ]);

        await releaseCodeIndexBuildLease(env, { repositoryId: repoA, workflowInstanceId: OWNER });

        const state = await readStateRow(repoA);
        expect(state?.status).toBe(terminalStatus);
        expect(state?.lease_expires_at).toBeNull();
        expect(state?.workflow_instance_id).toBeNull();
      },
    );
  });

  // =============================================================================================
  // Group 5 — terminal state
  // =============================================================================================

  describe('terminal state', () => {
    it('markCodeIndexBuildCompleted advances indexed_sha, writes the counts, and clears the lease', async () => {
      await markCodeIndexBuildStarted(env, {
        repositoryId: repoA,
        mode: 'full',
        indexedRef: 'main',
        buildingSha: SHA_A,
        workflowInstanceId: 'index-instance-1',
        leaseSeconds: 300,
      });
      // A previous failure must not survive a good build.
      await markCodeIndexBuildFailed(env, { repositoryId: repoA, message: 'model_timeout' });
      expect((await readStateRow(repoA))?.last_error).toBe('model_timeout');

      await markCodeIndexBuildCompleted(env, {
        repositoryId: repoA,
        indexedRef: 'refs/heads/main',
        indexedSha: SHA_A,
        fileCount: 501,
        chunkCount: 4812,
        truncated: true,
      });

      const state = await readStateRow(repoA);
      expect(state?.status).toBe('ready');
      expect(state?.indexed_sha).toBe(SHA_A);
      expect(state?.indexed_ref).toBe('refs/heads/main');
      expect(state?.indexed_at).not.toBeNull();
      expect(Number(state?.file_count)).toBe(501);
      expect(Number(state?.chunk_count)).toBe(4812);
      expect(state?.truncated).toBe(true);
      // The in-progress commit and the lease are gone; the continuation budget is reset.
      expect(state?.building_sha).toBeNull();
      expect(state?.lease_expires_at).toBeNull();
      expect(state?.workflow_instance_id).toBeNull();
      expect(Number(state?.continuation_count)).toBe(0);
      expect(state?.last_error).toBeNull();
      // mode is written at build START and survives completion, so the panel can still say what ran.
      expect(state?.mode).toBe('full');
    });

    it('markCodeIndexBuildFailed stores the supplied (already-redacted) message and clears the lease', async () => {
      await markCodeIndexBuildStarted(env, {
        repositoryId: repoA,
        mode: 'incremental',
        indexedRef: 'main',
        buildingSha: SHA_B,
        workflowInstanceId: 'index-instance-1',
        leaseSeconds: 300,
      });

      // 'provider_5xx' is a MachineErrorReason token — the shape the caller's redactErrorMessage
      // produces (AUD-01). This module cannot redact, so the token arriving intact is the contract.
      await markCodeIndexBuildFailed(env, { repositoryId: repoA, message: 'provider_5xx' });

      const state = await readStateRow(repoA);
      expect(state?.status).toBe('failed');
      expect(state?.last_error).toBe('provider_5xx');
      expect(state?.lease_expires_at).toBeNull();
      expect(state?.workflow_instance_id).toBeNull();
    });

    it('a failed refresh leaves the previously-completed index readable (D-15 fail-open)', async () => {
      await markCodeIndexBuildStarted(env, {
        repositoryId: repoA,
        mode: 'full',
        indexedRef: 'main',
        buildingSha: SHA_A,
        workflowInstanceId: 'index-instance-1',
        leaseSeconds: 300,
      });
      await markCodeIndexBuildCompleted(env, {
        repositoryId: repoA,
        indexedRef: 'main',
        indexedSha: SHA_A,
        fileCount: 2,
        chunkCount: 5,
        truncated: false,
      });

      await markCodeIndexBuildFailed(env, { repositoryId: repoA, message: 'network_reset' });

      const state = await readStateRow(repoA);
      expect(state?.status).toBe('failed');
      // The completed sha and counts are untouched — Q&A can still retrieve from the standing index.
      expect(state?.indexed_sha).toBe(SHA_A);
      expect(Number(state?.chunk_count)).toBe(5);
    });

    it('terminal transitions are scoped to one repository', async () => {
      for (const id of [repoA, repoB]) {
        await markCodeIndexBuildStarted(env, {
          repositoryId: id,
          mode: 'full',
          indexedRef: 'main',
          buildingSha: SHA_A,
          workflowInstanceId: `inst-${id}`,
          leaseSeconds: 300,
        });
      }

      await markCodeIndexBuildFailed(env, { repositoryId: repoA, message: 'unknown' });

      expect((await readStateRow(repoA))?.status).toBe('failed');
      expect((await readStateRow(repoB))?.status).toBe('building');
      expect((await readStateRow(repoB))?.last_error).toBeNull();
    });
  });

  /** Run a real question through the shared splitter and the real ranked retrieval. */
  async function retrieve(repositoryId: number, question: string, limit = 50) {
    return retrieveCodeIndexChunks(env, {
      repositoryId,
      queryExpression: buildQueryExpression(buildQueryTerms(question)),
      limit,
    });
  }

  // =============================================================================================
  // Group 6 — ranking (D-04): a path-token match outranks an incidental body mention
  // =============================================================================================

  describe('ranking (D-04)', () => {
    it('ranks a path-token match ABOVE a body-only match for the same query', async () => {
      const pathMatch = 'src/server/db/widget-registry-table.ts';
      const bodyMatch = 'src/client/panel-glue.ts';

      // The path-match chunk's BODY says nothing about the query; the body-match chunk's PATH says
      // nothing about it. Only the weight labels can produce the ordering.
      await seedChunk(repoA, pathMatch, 'export const unrelatedBodyText = 1;');
      await seedChunk(repoA, bodyMatch, 'incidental mention of widget registry inside a comment');

      const hits = await retrieve(repoA, 'where is the widget registry defined');

      const rankOf = (p: string) => hits.find((hit) => hit.path === p)?.rank ?? -1;
      // Both must actually match, or the comparison would be vacuous.
      expect(rankOf(pathMatch)).toBeGreaterThan(0);
      expect(rankOf(bodyMatch)).toBeGreaterThan(0);
      expect(rankOf(pathMatch)).toBeGreaterThan(rankOf(bodyMatch));
      // And the accessor's own ordering puts it first, so the top-K cut keeps the right one.
      expect(hits[0]?.path).toBe(pathMatch);
    });

    // 29-09 UAT regression guard: a real Bitbucket Q&A session asked three natural-language
    // questions containing "function"/"return" and got wrong answers from unrelated chunks, because
    // those near-universal reserved words survived into the query and outranked the one chunk
    // containing the actually-distinctive identifier. Fixed by adding CODE_VOCABULARY_STOPWORDS.
    it('a distinctive identifier outranks generic-code-heavy chunks for a natural-language question', async () => {
      const relevant = 'src/lib/utils/formatters.ts';
      const noisyA = 'src/lib/utils/vault.ts';
      const noisyB = 'src/lib/utils/ansible.ts';

      await seedChunk(repoA, relevant, 'export function zephyrTruncate(str) { return str.slice(0, 5); }');
      // Dense in the exact reserved words the question uses, but never the distinctive identifier --
      // this is what let a generic-code-heavy chunk outrank the relevant one before the fix.
      await seedChunk(
        repoA,
        noisyA,
        'function encrypt(value) { return value; } function decrypt(value) { return value; } function rotate(value) { return value; }',
      );
      await seedChunk(
        repoA,
        noisyB,
        'function runPlaybook(value) { return value; } function applyRole(value) { return value; } function checkStatus(value) { return value; }',
      );

      const hits = await retrieve(repoA, 'what does the zephyrTruncate function return');

      expect(hits[0]?.path).toBe(relevant);
      // The noisy chunks share no OTHER surviving term with the question, so once "function"/"return"
      // are filtered they must not match at all -- proving the fix removes their ranking signal
      // entirely rather than merely reordering it.
      expect(hits.map((hit) => hit.path)).not.toContain(noisyA);
      expect(hits.map((hit) => hit.path)).not.toContain(noisyB);
    });
  });

  // =============================================================================================
  // Group 7 — path tokenization: the Pitfall-1 regression guard
  // =============================================================================================

  describe('path tokenization', () => {
    it('matches a query word that appears ONLY inside the stored chunk\'s slash-separated path', async () => {
      const chunkPath = 'src/server/core/zephyrBeacon.ts';
      const content = 'export const value = 1;';

      // The guarantee is only meaningful if the word is absent from the content.
      expect(content.toLowerCase()).not.toContain('zephyr');
      await seedChunk(repoA, chunkPath, content);

      const hits = await retrieve(repoA, 'zephyr');

      expect(hits.map((hit) => hit.path)).toEqual([chunkPath]);
      // Re-read the stored row: the pre-split tokens are what makes this reachable, and the raw path
      // alone would tokenize to one unsearchable lexeme.
      const [row] = await queryRows<{ path_tokens: string }>(
        env,
        'SELECT path_tokens FROM code_index_chunks WHERE repository_id = $1 AND path = $2',
        [repoA, chunkPath],
      );
      expect(row?.path_tokens).toContain(chunkPath);
      expect(row?.path_tokens.split(/\s+/)).toContain('zephyr');
    });
  });

  // =============================================================================================
  // Group 8 — cross-repository isolation (T-29-04-01): the information-disclosure control
  // =============================================================================================

  describe('cross-repository isolation (T-29-04-01)', () => {
    it('returns only the queried repository\'s rows when both repositories match the same query', async () => {
      const aPaths = ['src/a/alpha-isolationprobe.ts', 'src/a/beta-isolationprobe.ts'];
      const bPaths = ['src/b/gamma-isolationprobe.ts'];

      for (const p of aPaths) await seedChunk(repoA, p, 'export const tenantA = 1;');
      for (const p of bPaths) await seedChunk(repoB, p, 'export const tenantB = 2;');

      // Both tenants' rows really are in the table, so a passing isolation assertion is not vacuous.
      const [total] = await queryRows<{ n: number | string }>(
        env,
        "SELECT count(*)::int AS n FROM code_index_chunks WHERE repository_id = ANY($1::int[]) AND path LIKE '%isolationprobe%'",
        [[repoA, repoB]],
      );
      expect(Number(total?.n)).toBe(3);

      const hitsA = await retrieve(repoA, 'isolationprobe');
      const hitsB = await retrieve(repoB, 'isolationprobe');

      // Assert the PATH SET, not the count: a count alone cannot distinguish "returned the right
      // repository's two rows" from "returned one row from each".
      expect([...hitsA.map((hit) => hit.path)].sort()).toEqual([...aPaths].sort());
      expect([...hitsB.map((hit) => hit.path)].sort()).toEqual([...bPaths].sort());
      for (const hit of hitsA) expect(bPaths).not.toContain(hit.path);
      for (const hit of hitsB) expect(aPaths).not.toContain(hit.path);
      // Neither tenant's CONTENT crosses over either — the content column is what reaches the prompt.
      expect(hitsA.every((hit) => !hit.content.includes('tenantB'))).toBe(true);
      expect(hitsB.every((hit) => !hit.content.includes('tenantA'))).toBe(true);
    });
  });

  // =============================================================================================
  // Group 9 — pathological input (T-29-04-05): the JS cap runs before the insert
  // =============================================================================================

  describe('pathological input (T-29-04-05)', () => {
    /** Store every window chunkLines produced, exactly the way the build path will. */
    async function seedWindows(repositoryId: number, chunkPath: string, content: string) {
      const windows = chunkLines(content);
      const { pathTokens } = buildIndexTokens(chunkPath, content);
      return upsertCodeIndexChunks(env, {
        repositoryId,
        path: chunkPath,
        indexedSha: SHA_A,
        pathTokens,
        chunks: windows.map((w) => ({
          chunkStart: w.start,
          chunkEnd: w.end,
          content: w.content,
          contentTokens: buildIndexTokens(chunkPath, w.content).contentTokens,
        })),
      });
    }

    it('inserts a window far over CODE_INDEX_MAX_CHUNK_BYTES after the JS cap, without raising', async () => {
      const chunkPath = 'src/generated/dense-bundle.ts';
      // 60 dense lines of ~1.9 kB each: the first 50-line window is ~95 kB before the cap, roughly 3x
      // CODE_INDEX_MAX_CHUNK_BYTES, and the trailing 10-line window is under it. Both paths exercised.
      const content = Array.from({ length: 60 }, (_, i) =>
        Array.from({ length: 60 }, (_, j) => `const denseIdentifier${i}x${j} = ${i * j};`).join(' '),
      ).join('\n');
      expect(new TextEncoder().encode(content).length).toBeGreaterThan(CODE_INDEX_MAX_CHUNK_BYTES * 3);

      // The guarantee is that this RESOLVES — not that it throws a caught error.
      await expect(seedWindows(repoA, chunkPath, content)).resolves.toBeUndefined();

      const rows = await readChunkRows(repoA);
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(Number(row.octets)).toBeLessThanOrEqual(CODE_INDEX_MAX_CHUNK_BYTES);
      }
      // The stored line range is still the file's REAL range, so a retrieved hit cites lines that exist.
      expect(rows.map((row) => Number(row.chunk_start))).toEqual([1, 51]);
    });

    it('inserts a chunk that is ONE unbroken lexeme past the Postgres lexeme limit, without raising', async () => {
      const chunkPath = 'src/generated/single-token.min.js';
      // One line, one token, 2 MB — far past both CODE_INDEX_MAX_CHUNK_BYTES and Postgres's ~2047-byte
      // lexeme limit. to_tsvector emits a NOTICE and ignores the overlong word (postgres.js suppresses
      // notices via onnotice); it must not ERROR, or the build step would burn its whole retry budget
      // re-throwing the same deterministic failure.
      const content = 'q'.repeat(2_000_000);

      await expect(seedWindows(repoA, chunkPath, content)).resolves.toBeUndefined();

      const rows = await readChunkRows(repoA);
      expect(rows.length).toBe(1);
      expect(Number(rows[0]!.octets)).toBeLessThanOrEqual(CODE_INDEX_MAX_CHUNK_BYTES);
      // The row is real and readable — re-read the vector rather than trusting the insert returned.
      const [vector] = await queryRows<{ lexemes: number | string }>(
        env,
        'SELECT length(search_vector) AS lexemes FROM code_index_chunks WHERE repository_id = $1 AND path = $2',
        [repoA, chunkPath],
      );
      expect(Number(vector?.lexemes)).toBeGreaterThanOrEqual(0);
    });
  });
});
