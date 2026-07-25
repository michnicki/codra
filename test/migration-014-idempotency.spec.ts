import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/014_model_line_cap.sql',
);

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('migration 014_model_line_cap is idempotent', () => {
  const env = createTestEnv();

  it('applies twice and creates a nullable INTEGER column on file_reviews', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql.match(/^ALTER TABLE.*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/im)).toHaveLength(1);

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
         AND table_name = 'file_reviews'
         AND column_name = 'model_line_cap'
       ORDER BY table_name, column_name`,
    );

    expect(columns).toHaveLength(1);
    expect(columns[0]).toEqual({
      table_name: 'file_reviews',
      column_name: 'model_line_cap',
      is_nullable: 'YES',
      data_type: 'integer',
    });
  });
});
