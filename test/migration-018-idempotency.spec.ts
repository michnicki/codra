// Phase 29 / QA-IDX-01, Plan 29-01 Task 2 — migration 018 re-run safety and SHAPE.
//
// Why this spec exists: migration 018's own header block claims it is additive and re-run safe. A
// comment cannot be wrong loudly. This spec executes the raw SQL TWICE against the live test database
// and then asserts the resulting shape from the CATALOG VIEWS rather than from the SQL text, so a
// future edit that keeps the text plausible but changes the effect (a primary key narrowed to two
// columns, a foreign key that stops cascading, a GIN index quietly turned into a btree) is caught.
//
// Pattern taken verbatim from test/migration-016-idempotency.spec.ts. Gated on
// hasConfiguredTestDatabaseUrl(); migration 018 reaches TEST_DATABASE_URL via `npm test`
// (scripts/test.mjs sets DATABASE_URL = TEST_DATABASE_URL, then runs scripts/migrate.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/018_code_index.sql',
);

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('migration 018_code_index is idempotent and has the pinned shape', () => {
  const env = createTestEnv();
  const sql = readFileSync(migrationPath, 'utf8');
  // The executable statements only. The migration's rationale comments legitimately MENTION the verbs
  // and constraints this migration deliberately does not use ("NOT a CHECK (skip_reason IN (...))",
  // "the per-repo truncate/refresh accessors"), so the statement-level assertions below must not read
  // prose as SQL. The documentation assertions in the next case read the raw text on purpose.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('uses only existence-guarded verbs and no destructive or extension statements', () => {
    const tables = statements.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi) ?? [];
    const indexes = statements.match(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/gi) ?? [];
    expect(tables).toHaveLength(3);
    expect(indexes).toHaveLength(3);
    // Every CREATE in the file is one of the six guarded verbs above -- no unguarded CREATE survives.
    expect(statements.match(/CREATE\s+/gi) ?? []).toHaveLength(6);

    // Destructive verbs, ignoring the guarded `IF NOT EXISTS` forms above.
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bUPDATE\b|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b/i);

    // D-01: Postgres NATIVE full-text search only. No extension, no vector type -- the local test
    // Postgres 17.10 has no `vector` available, so either would break `npm test` on this host.
    expect(statements).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(statements).not.toMatch(/\bVECTOR\s*\(/i);
    expect(statements).not.toMatch(/\bpgvector\b/i);
    expect(statements).toMatch(/search_vector\s+TSVECTOR\s+NOT\s+NULL/i);
    expect(statements).toContain('USING GIN (search_vector)');
    expect(statements).toContain('PRIMARY KEY (repository_id, path, chunk_start)');
  });

  it('documents the skip_reason vocabulary and the mode values without a CHECK constraint', () => {
    for (const token of ["'empty'", "'generated'", "'oversized'", "'unreadable'"]) {
      expect(sql).toContain(token);
    }
    expect(sql).toMatch(/NULL means the file was indexed normally/i);

    for (const token of ["'full'", "'incremental'"]) {
      expect(sql).toContain(token);
    }

    // The vocabulary is deliberately documentation, not a constraint (29-REVIEWS.md disposition).
    // Asserted against the STATEMENTS: the rationale comment says the words "NOT a
    // CHECK (skip_reason IN (...)) constraint", which is exactly the text this guards against.
    expect(statements).not.toMatch(/\bCHECK\s*\(/i);
  });

  it('applies twice against the same database without error', async () => {
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
  });

  it('creates all three tables with search_vector typed tsvector', async () => {
    const tables = await getDb(env).query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('code_index_chunks', 'code_index_files', 'code_index_state')
        ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'code_index_chunks',
      'code_index_files',
      'code_index_state',
    ]);

    const [vector] = await getDb(env).query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'code_index_chunks'
          AND column_name = 'search_vector'`,
    );
    expect(vector).toBeDefined();
    expect(vector!.data_type).toBe('tsvector');
    expect(vector!.is_nullable).toBe('NO');
  });

  it('creates the GIN vector index and the narrow repository btree', async () => {
    const indexes = await getDb(env).query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('code_index_chunks_vector_idx', 'code_index_chunks_repo_idx', 'code_index_files_sha_idx')
        ORDER BY indexname`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      'code_index_chunks_repo_idx',
      'code_index_chunks_vector_idx',
      'code_index_files_sha_idx',
    ]);

    // The vector index MUST be GIN: a btree on a tsvector would create the index and silently never
    // serve a `@@` lookup.
    const vectorIdx = indexes.find((i) => i.indexname === 'code_index_chunks_vector_idx')!;
    expect(vectorIdx.indexdef).toMatch(/USING gin/i);
    // The narrow repository btree exists IN ADDITION to the primary key because the planner was
    // measured to ignore the primary key and seq-scan when one repository dominates the table.
    const repoIdx = indexes.find((i) => i.indexname === 'code_index_chunks_repo_idx')!;
    expect(repoIdx.indexdef).toMatch(/USING btree \(repository_id\)/i);
  });

  it("pins code_index_chunks' primary key to exactly (repository_id, path, chunk_start)", async () => {
    const columns = await getDb(env).query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.constraint_schema = tc.constraint_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'code_index_chunks'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['repository_id', 'path', 'chunk_start']);
  });

  it('pins the repositories foreign key to ON DELETE CASCADE on all three tables', async () => {
    const rules = await getDb(env).query<{ table_name: string; delete_rule: string }>(
      `SELECT tc.table_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name
          AND rc.constraint_schema = tc.constraint_schema
        WHERE tc.table_schema = 'public'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN ('code_index_chunks', 'code_index_files', 'code_index_state')
        ORDER BY tc.table_name`,
    );

    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      // Deliberate departure from 001_initial.sql's non-cascading repository_id references: the index
      // must be deleted WITH the repository, or a removed repository's source stays in Postgres.
      expect(rule.delete_rule).toBe('CASCADE');
    }
  });
});
