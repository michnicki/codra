import { describe, it, expect, vi } from 'vitest';
import { insertJob, getJobDetail, appendJobAuditEvents } from '@server/db/jobs';
import { queryRows } from '@server/db/client';
import { defaultRepoConfig, type JobAuditEvent } from '@shared/schema';
import { logger } from '@server/core/logger';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// AUD-01: audit-trail write/read infrastructure. Proves appendJobAuditEvents is atomic, parameterized,
// order-preserving, and ring-buffer-capped at 500 (drop-oldest, tracked via audit_truncated); that the
// fail-soft PER-ELEMENT audit read lives on getJobDetail (never mapJob); and that recordUnitAudit is
// best-effort (never throws into the caller — case 8, Task 2). DB-gated, mirroring
// test/jobs-columns-inertness.spec.ts's harness (migrated TEST_DATABASE_URL via `npm test`).
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const baseJob = {
  installationId: '123',
  owner: 'test-owner',
  prTitle: 'Audit trail',
  prAuthor: 'author',
  trigger: 'auto' as const,
  headRef: 'feature',
  baseRef: 'main',
  configSnapshot: defaultRepoConfig,
};

const sha = (char: string) => char.repeat(40);

const draftedEvent = (file: string): JobAuditEvent => ({
  stage: 'drafted',
  file,
  pass: 'main',
  timestamp: new Date().toISOString(),
});

let prCounter = 0;
async function freshJob(env: ReturnType<typeof createTestEnv>, label: string) {
  prCounter += 1;
  return insertJob(env, {
    ...baseJob,
    repo: `test-repo-${Date.now()}-audit-${label}-${prCounter}`,
    prNumber: prCounter,
    commitSha: sha('a'),
    baseSha: sha('0'),
  });
}

dbDescribe('appendJobAuditEvents / getJobDetail audit read (AUD-01)', () => {
  const env = createTestEnv();

  it('(1) a freshly-inserted job exposes audit === [] and auditTruncated === false (column is NULL until a writer runs)', async () => {
    const job = await freshJob(env, 'empty');

    const detail = await getJobDetail(env, job.id);
    expect(detail).not.toBeNull();
    expect(detail!.audit).toEqual([]);
    expect(detail!.auditTruncated).toBe(false);
  });

  it('(2) one call with a drafted + severity_adjusted event round-trips both in append order', async () => {
    const job = await freshJob(env, 'roundtrip');

    const events: JobAuditEvent[] = [
      draftedEvent('a.ts'),
      {
        stage: 'severity_adjusted',
        rule: 'hardcoded-secret',
        matched: 'api-key-pattern',
        from: 'P2',
        to: 'P0',
        timestamp: new Date().toISOString(),
      },
    ];
    await appendJobAuditEvents(env, job.id, events);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.audit).toHaveLength(2);
    expect(detail!.audit[0].stage).toBe('drafted');
    expect(detail!.audit[1].stage).toBe('severity_adjusted');
    expect(detail!.auditTruncated).toBe(false);
  });

  it('(3) a single call with 505 events caps at the most-recent 500, sets auditTruncated, preserves ascending order', async () => {
    const job = await freshJob(env, 'cap505');

    const events = Array.from({ length: 505 }, (_, i) => draftedEvent(`file-${i}`));
    await appendJobAuditEvents(env, job.id, events);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.audit).toHaveLength(500);
    expect(detail!.auditTruncated).toBe(true);
    // Earliest 5 (file-0..file-4) evicted; the first retained event is the 6th pushed (file-5).
    expect((detail!.audit[0] as { file: string }).file).toBe('file-5');
    // Ascending chronological (insertion) order preserved through the trim.
    expect((detail!.audit[499] as { file: string }).file).toBe('file-504');
  });

  it('(4) EXACT-500 boundary: appending exactly 500 events keeps all 500 with auditTruncated === false (no eviction at the boundary)', async () => {
    const job = await freshJob(env, 'exact500');

    const events = Array.from({ length: 500 }, (_, i) => draftedEvent(`file-${i}`));
    await appendJobAuditEvents(env, job.id, events);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.audit).toHaveLength(500);
    expect(detail!.auditTruncated).toBe(false);
    expect((detail!.audit[0] as { file: string }).file).toBe('file-0');
    expect((detail!.audit[499] as { file: string }).file).toBe('file-499');
  });

  it('(5) DUPLICATE (file,pass): two drafted events for the identical tuple append as separate entries (no merge/dedupe)', async () => {
    const job = await freshJob(env, 'dup');

    await appendJobAuditEvents(env, job.id, [draftedEvent('a.ts'), draftedEvent('a.ts')]);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.audit).toHaveLength(2);
    expect((detail!.audit[0] as { file: string }).file).toBe('a.ts');
    expect((detail!.audit[1] as { file: string }).file).toBe('a.ts');
  });

  it('(6) CONCURRENT append: 5 Promise.all calls against the same job all survive (no lost update)', async () => {
    const job = await freshJob(env, 'concurrent');

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => appendJobAuditEvents(env, job.id, [draftedEvent(`concurrent-${i}.ts`)])),
    );

    const detail = await getJobDetail(env, job.id);
    expect(detail!.audit).toHaveLength(5);
    const files = new Set(detail!.audit.map((e) => (e as { file: string }).file));
    for (let i = 0; i < 5; i += 1) {
      expect(files.has(`concurrent-${i}.ts`)).toBe(true);
    }
  });

  it('(7) MALFORMED event: a stored array with one valid + one unknown-stage event still returns the valid event (per-element parse)', async () => {
    const job = await freshJob(env, 'malformed');

    // Write a hand-crafted array directly (bypassing appendJobAuditEvents' schema-shaped events) to
    // simulate a future-phase writer or corruption: one valid `drafted` event and one unknown-stage
    // event. Per-element safeParse must retain the valid one and drop only the bad one — the whole
    // trail is NOT erased.
    await queryRows(
      env,
      // $2::text::jsonb (not $2::jsonb): store a REAL jsonb array. postgres.js double-encodes a
      // ::jsonb-cast string param into a jsonb string scalar (see appendJobAuditEvents' note); the
      // ::text::jsonb form forces the raw array text so getJobDetail's Array.isArray branch sees a
      // genuine array — matching how appendJobAuditEvents stores the column.
      `UPDATE jobs SET audit = $2::text::jsonb WHERE id = $1`,
      [
        job.id,
        JSON.stringify([
          draftedEvent('valid.ts'),
          { stage: 'unknown_future_stage', whatever: true },
        ]),
      ],
    );

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const detail = await getJobDetail(env, job.id);
    warnSpy.mockRestore();

    expect(detail!.audit).toHaveLength(1);
    expect(detail!.audit[0].stage).toBe('drafted');
    expect((detail!.audit[0] as { file: string }).file).toBe('valid.ts');
  });
});
