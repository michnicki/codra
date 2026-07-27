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
  claimCodeIndexBuildLease,
  deleteCodeIndexChunksForPaths,
  listIndexedPathsForSha,
  markCodeIndexBuildCompleted,
  markCodeIndexBuildFailed,
  markCodeIndexBuildStarted,
  markCodeIndexFileIndexed,
  releaseCodeIndexBuildLease,
  renewCodeIndexBuildLease,
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
});
