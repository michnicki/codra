import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/016_learned_rules.sql',
);

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('migration 016_learned_rules is idempotent', () => {
  const env = createTestEnv();

  it('applies twice and creates 4 nullable TEXT columns on reject_feedback', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // Verify the SQL contains at least 4 ALTER TABLE ADD COLUMN IF NOT EXISTS statements.
    const alterMatches = sql.match(/^ALTER TABLE.*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gim);
    expect(alterMatches).toBeDefined();
    expect(alterMatches!.length).toBeGreaterThanOrEqual(4);

    // Apply twice — idempotent.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    const columns = await getDb(env).query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'reject_feedback'
         AND column_name IN ('finding_title', 'finding_category', 'finding_file_path', 'finding_severity')
       ORDER BY column_name`,
    );

    expect(columns).toHaveLength(4);

    for (const col of columns) {
      expect(col.table_name).toBe('reject_feedback');
      expect(col.is_nullable).toBe('YES');
      expect(col.data_type).toBe('text');
    }

    expect(columns.map((c) => c.column_name)).toEqual([
      'finding_category',
      'finding_file_path',
      'finding_severity',
      'finding_title',
    ]);
  });
});
