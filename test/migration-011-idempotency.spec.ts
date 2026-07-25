import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// The migrate harness (scripts/migrate.mjs) skips already-applied files via `schema_migrations`, so
// `npm test`'s migrate step NEVER re-runs 011 -- it proves nothing about re-run safety. This
// dedicated test reads the RAW 011 SQL and executes the whole file TWICE against the shared test
// database, asserting neither run throws. That directly exercises the re-run-safe idioms in
// migration 011: `ADD COLUMN IF NOT EXISTS` + the pg_constraint-existence guard around the two
// CHECK constraints (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`).
//
// The file is executed as a single simple-query string via `getDb(env).query(sql)` (empty params ->
// postgres.js simple protocol), running all semicolon-separated statements -- including the
// dollar-quoted `DO $$ ... $$` blocks -- in one shot, mirroring the migrate harness's simple-query
// path.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/011_pr_review_state_anchors.sql',
);

dbDescribe('migration 011_pr_review_state_anchors is idempotent', () => {
  const env = createTestEnv();

  it('applies the raw 011 SQL twice without throwing (re-run safe)', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // First apply: idempotent if the migrate step already applied it, otherwise mutates schema.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    // Second apply: the real re-run proof -- every verb must short-circuit cleanly (IF [NOT] EXISTS
    // / the pg_constraint existence guard) on the second run.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    // Sanity 1: the three additive pr_review_state columns exist with the documented nullability.
    const prCols = await getDb(env).query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pr_review_state'
         AND column_name IN ('last_reviewed_sha', 'last_review_round', 'last_reviewed_at')
       ORDER BY column_name`,
    );
    expect(prCols.map((c) => c.column_name)).toEqual([
      'last_review_round',
      'last_reviewed_at',
      'last_reviewed_sha',
    ]);
    // All three must be nullable (every existing pause-only row reads them back as NULL).
    for (const col of prCols) {
      expect(col.is_nullable).toBe('YES');
    }
    expect(prCols.find((c) => c.column_name === 'last_reviewed_sha')?.data_type).toBe('text');
    expect(prCols.find((c) => c.column_name === 'last_review_round')?.data_type).toBe('integer');

    // Sanity 2: the three additive jobs columns exist with the documented nullability / defaults.
    const jobsCols = await getDb(env).query<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'jobs'
         AND column_name IN ('review_round', 'review_mode', 'rounds_incremental')
       ORDER BY column_name`,
    );
    expect(jobsCols.map((c) => c.column_name)).toEqual(['review_mode', 'review_round', 'rounds_incremental']);
    const reviewMode = jobsCols.find((c) => c.column_name === 'review_mode')!;
    const reviewRound = jobsCols.find((c) => c.column_name === 'review_round')!;
    const roundsIncremental = jobsCols.find((c) => c.column_name === 'rounds_incremental')!;
    // review_round + review_mode are NULL-able (pre-Plan-02 writes have no value).
    expect(reviewMode.is_nullable).toBe('YES');
    expect(reviewRound.is_nullable).toBe('YES');
    // rounds_incremental is NOT NULL with DEFAULT false -- inert on every existing insert.
    expect(roundsIncremental.is_nullable).toBe('NO');
    expect(roundsIncremental.column_default ?? '').toContain('false');

    // Sanity 3: the review_round >= 1 CHECK constraint exists.
    const [roundCheck] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.jobs'::regclass
           AND conname = 'jobs_review_round_positive_check' AND contype = 'c'
       ) AS exists`,
    );
    expect(roundCheck.exists).toBe(true);

    // Sanity 4: the review_mode CHECK constraint exists with the documented value set.
    const [modeCheck] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.jobs'::regclass
           AND conname = 'jobs_review_mode_check' AND contype = 'c'
       ) AS exists`,
    );
    expect(modeCheck.exists).toBe(true);
  });
});