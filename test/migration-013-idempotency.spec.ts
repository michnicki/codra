import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDb } from '@server/db/client';
import * as sharedSchema from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

type SchemaLike = {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown };
};

function getPhase19Schema(name: string): SchemaLike {
  const candidate = (sharedSchema as unknown as Record<string, unknown>)[name];
  if (
    typeof candidate !== 'object'
    || candidate === null
    || typeof (candidate as SchemaLike).parse !== 'function'
    || typeof (candidate as SchemaLike).safeParse !== 'function'
  ) {
    throw new Error(`Missing Phase-19 schema export: ${name}`);
  }
  return candidate as SchemaLike;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/013_phase19_durable_results.sql',
);

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const threadEntries = [
  {
    threadRef: 'thread-fixed',
    path: 'src/fixed.ts',
    lineStart: 12,
    lineEnd: 12,
    verdict: 'fixed',
    reason: 'model_confirmed_fix',
    resolved: true,
  },
  {
    threadRef: 'thread-unfixed',
    path: 'src/open.ts',
    lineStart: 22,
    lineEnd: 24,
    verdict: 'unfixed',
    reason: 'issue_still_present',
    resolved: false,
  },
  {
    threadRef: 'thread-unverifiable',
    path: 'src/deleted.ts',
    lineStart: null,
    lineEnd: null,
    verdict: 'unverifiable',
    reason: 'file_deleted_at_head',
    resolved: false,
  },
] as const;

const canonicalThreadVerification = {
  version: 1,
  status: 'completed',
  entries: threadEntries,
  totals: {
    fixed: 1,
    unfixed: 1,
    unverifiable: 1,
    resolved: 1,
  },
} as const;

describe('Phase-19 additive durable contracts', () => {
  it('accepts canonical fixed, unfixed, and unverifiable thread rows with separate resolved totals', () => {
    const result = getPhase19Schema('threadVerificationsSchema').safeParse(canonicalThreadVerification);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject(canonicalThreadVerification);
  });

  it('requires a non-empty bounded machine reason on every thread verdict', () => {
    const schema = getPhase19Schema('threadVerificationEntrySchema');

    for (const verdict of ['fixed', 'unfixed', 'unverifiable']) {
      expect(schema.safeParse({
        threadRef: `thread-${verdict}`,
        path: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        verdict,
        resolved: false,
      }).success).toBe(false);

      expect(schema.safeParse({
        threadRef: `thread-${verdict}`,
        path: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        verdict,
        reason: '',
        resolved: false,
      }).success).toBe(false);

      expect(schema.safeParse({
        threadRef: `thread-${verdict}`,
        path: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        verdict,
        reason: 'x'.repeat(201),
        resolved: false,
      }).success).toBe(false);
    }
  });

  it('requires a bounded reason on every thread-verdict audit event, including verified fixed', () => {
    for (const stage of ['threads.verified_fixed', 'threads.unfixed', 'threads.unverifiable']) {
      const baseEvent = {
        stage,
        threadRef: 'opaque-thread-ref',
        path: 'src/a.ts',
        line: 4,
        timestamp: '2026-07-24T08:00:00.000Z',
      };

      expect(sharedSchema.jobAuditEventSchema.safeParse(baseEvent).success).toBe(false);
      expect(sharedSchema.jobAuditEventSchema.safeParse({ ...baseEvent, reason: '' }).success).toBe(false);
      expect(sharedSchema.jobAuditEventSchema.safeParse({ ...baseEvent, reason: 'x'.repeat(201) }).success).toBe(false);
      expect(sharedSchema.jobAuditEventSchema.safeParse({ ...baseEvent, reason: 'model_confirmed_fix' }).success).toBe(true);
    }
  });

  it('provides additive critic-v2, ensemble, and walkthrough-enrichment schemas', () => {
    const criticDecision = {
      id: 0,
      path: 'src/a.ts',
      line: 8,
      severity: 'P2',
      category: 'correctness',
      title: 'Guard the edge case',
      body: 'The branch remains reachable.',
      confidence: 0.91,
      verdict: 'proven',
      outcome: 'kept',
      reason: 'evidence_proven',
    };
    expect(getPhase19Schema('criticDecisionSchema').safeParse(criticDecision).success).toBe(true);

    const historicalCritic = sharedSchema.criticResultSchema.parse({ kept: [], pruned: [] });
    expect(historicalCritic).toMatchObject({ kept: [], pruned: [] });
    expect(sharedSchema.criticResultSchema.safeParse({
      kept: [],
      pruned: [],
      version: 2,
      status: 'completed',
      decisions: [criticDecision],
    }).success).toBe(true);

    expect(getPhase19Schema('ensembleResultSchema').safeParse({
      version: 1,
      status: 'partial',
      requestedRuns: 3,
      successfulRuns: 2,
      failedRuns: 1,
      winnerCount: 1,
      droppedClusterCount: 1,
      runOutcomes: [
        { run: 0, status: 'succeeded', inputTokens: 10, outputTokens: 5 },
        { run: 1, status: 'failed', reason: 'provider_timeout' },
        { run: 2, status: 'succeeded', inputTokens: 12, outputTokens: 6 },
      ],
    }).success).toBe(true);

    expect(getPhase19Schema('walkthroughEnrichmentSchema').safeParse({
      version: 1,
      status: 'completed',
      groups: [{ label: 'Runtime safety', paths: ['src/a.ts'] }],
      confidence: { score: 3, label: 'Needs review', reason: 'Three P2 findings remain' },
      effort: { level: 2, label: 'Small', minutes: 20 },
    }).success).toBe(true);
  });

  it('accepts new durable phases while preserving historical job payloads without Phase-19 fields', () => {
    const queueBase = {
      jobId: '11111111-1111-4111-8111-111111111111',
      deliveryId: 'delivery-19',
    };
    expect(sharedSchema.reviewJobMessageSchema.safeParse({ ...queueBase, phase: 'verify_fixes' }).success).toBe(true);
    expect(sharedSchema.reviewJobMessageSchema.safeParse({ ...queueBase, phase: 'walkthrough_enrichment' }).success).toBe(true);

    const historicalSummary = {
      id: '22222222-2222-4222-8222-222222222222',
      owner: 'open-codra',
      repo: 'engine',
      installationId: '123',
      prNumber: 19,
      prTitle: 'Historical job',
      prAuthor: 'author',
      commitSha: 'a'.repeat(40),
      trigger: 'auto',
      status: 'done',
      verdict: 'approve',
      fileCount: 1,
      commentCount: 0,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      createdAt: '2026-07-24T08:00:00.000Z',
      updatedAt: '2026-07-24T08:00:01.000Z',
      startedAt: '2026-07-24T08:00:00.000Z',
      finishedAt: '2026-07-24T08:00:01.000Z',
      errorMessage: null,
    };

    expect(sharedSchema.jobSummarySchema.safeParse(historicalSummary).success).toBe(true);
    expect(sharedSchema.jobSummarySchema.safeParse({
      ...historicalSummary,
      threadVerification: canonicalThreadVerification,
      walkthroughEnrichment: {
        version: 1,
        status: 'failed',
        reason: 'model_unavailable',
      },
    }).success).toBe(true);
  });
});

dbDescribe('migration 013_phase19_durable_results is idempotent', () => {
  const env = createTestEnv();

  it('applies twice and owns exactly three nullable JSONB columns', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    expect(sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi)).toHaveLength(3);
    expect(sql).not.toMatch(/threads_verify_fixes/i);
    expect(sql).not.toMatch(/\bCHECK\b/i);

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
         AND (
           (table_name = 'jobs' AND column_name IN ('thread_verifications', 'walkthrough_enrichment'))
           OR (table_name = 'file_reviews' AND column_name = 'ensemble_result')
         )
       ORDER BY table_name, column_name`,
    );

    expect(columns).toEqual([
      {
        table_name: 'file_reviews',
        column_name: 'ensemble_result',
        is_nullable: 'YES',
        data_type: 'jsonb',
      },
      {
        table_name: 'jobs',
        column_name: 'thread_verifications',
        is_nullable: 'YES',
        data_type: 'jsonb',
      },
      {
        table_name: 'jobs',
        column_name: 'walkthrough_enrichment',
        is_nullable: 'YES',
        data_type: 'jsonb',
      },
    ]);
  });
});

describe('Phase-19 durable-result ownership and read-path closure', () => {
  it('keeps migration 013 singular after all Phase-19 plans', () => {
    const migrationsDir = path.resolve(rootDir, 'db/migrations');
    const phase19Migrations = readdirSync(migrationsDir)
      .filter((name) => /^013_.*\.sql$/.test(name));
    expect(phase19Migrations).toEqual(['013_phase19_durable_results.sql']);
  });

  it('keeps all three nullable JSONB columns mapped through fail-soft read paths', () => {
    const jobsSource = readFileSync(path.resolve(rootDir, 'src/server/db/jobs.ts'), 'utf8');
    const fileReviewsSource = readFileSync(path.resolve(rootDir, 'src/server/db/file-reviews.ts'), 'utf8');

    expect(jobsSource).toContain('thread_verifications');
    expect(jobsSource).toContain('walkthrough_enrichment');
    expect(jobsSource).toMatch(/threadVerificationsSchema\.safeParse/);
    expect(jobsSource).toMatch(/walkthroughEnrichmentSchema\.safeParse/);
    expect(fileReviewsSource).toContain('ensemble_result');
    expect(fileReviewsSource).toMatch(/ensembleResultSchema\.safeParse/);
  });
});
