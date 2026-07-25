import { describe, it, expect, vi } from 'vitest';
import { insertJob, getJobDetail, appendJobAuditEvents } from '@server/db/jobs';
import * as jobsModule from '@server/db/jobs';
import { buildFileSkipEvents, recordFileSkips, recordUnitAudit, buildEvidenceMissingSummary } from '@server/core/audit';
import type { FileDiff } from '@server/core/diff';
import { queryRows } from '@server/db/client';
import { defaultRepoConfig, type JobAuditEvent } from '@shared/schema';
import { jobAuditEventSchema } from '@shared/schema';
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

dbDescribe('recordUnitAudit best-effort recorder (AUD-01, T-13-03-04)', () => {
  const env = createTestEnv();

  it('(8) FAILED-WRITE: recordUnitAudit resolves (never throws) and warns when appendJobAuditEvents rejects', async () => {
    const job = await freshJob(env, 'failed-write');

    // Force the single append to reject, proving the recorder swallows the failure (best-effort):
    // a broken/slow audit write must never propagate to the caller's review-persist path.
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(recordUnitAudit(env, job.id, 'a.ts', 'main')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('(8b) SUCCESS: recordUnitAudit issues exactly one combined append (drafted + severity events)', async () => {
    const job = await freshJob(env, 'combined');

    await recordUnitAudit(env, job.id, 'b.ts', 'security', [
      {
        stage: 'severity_adjusted',
        rule: 'sql-injection',
        matched: 'string-concat-query',
        from: 'P2',
        to: 'P0',
        timestamp: new Date().toISOString(),
      },
    ]);

    const detail = await getJobDetail(env, job.id);
    expect(detail!.audit).toHaveLength(2);
    expect(detail!.audit[0].stage).toBe('drafted');
    expect((detail!.audit[0] as { file: string; pass: string }).file).toBe('b.ts');
    expect((detail!.audit[0] as { pass: string }).pass).toBe('security');
    expect(detail!.audit[1].stage).toBe('severity_adjusted');
  });
});

// PRIO-03 / D-11 / D-12: buildFileSkipEvents is a PURE builder (no I/O) mapping selectReviewableFiles'
// drop metadata into `file_skipped` audit events — per-file for `generated`, one bounded aggregate for
// `over_cap`, `skip_glob` NEVER emitted. These cases need no DB (plain describe).
const fileDiff = (path: string): FileDiff => ({
  path,
  previousPath: null,
  isNew: true,
  isDeleted: false,
  isBinary: false,
  lineCount: 1,
  hunks: [],
});

describe('buildFileSkipEvents pure drop-event builder (PRIO-03, D-11/D-12)', () => {
  it('emits ONE per-file generated event (count:1, sample:[{path}]) for each generated file', () => {
    const events = buildFileSkipEvents({ generated: [fileDiff('a.ts'), fileDiff('b.ts')], overCap: [] });

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.stage).toBe('file_skipped');
      expect((event as { reason: string }).reason).toBe('generated');
      expect((event as { count: number }).count).toBe(1);
      expect((event as { sample: unknown[] }).sample).toHaveLength(1);
    }
    expect((events[0] as { sample: { path: string }[] }).sample[0].path).toBe('a.ts');
    expect((events[1] as { sample: { path: string }[] }).sample[0].path).toBe('b.ts');
  });

  it('emits exactly ONE over_cap aggregate: count === full overCap length, sample.length === min(20,count) in overCap order', () => {
    const overCap = Array.from({ length: 30 }, (_, i) => fileDiff(`over-${String(i).padStart(2, '0')}.ts`));
    const events = buildFileSkipEvents({ generated: [], overCap });

    expect(events).toHaveLength(1);
    const event = events[0] as { reason: string; count: number; sample: { path: string }[] };
    expect(event.reason).toBe('over_cap');
    // count carries the COMPLETE overCap length — no dropped file is invisible in the aggregate.
    expect(event.count).toBe(30);
    // sample bounded to ≤20 (FILT-04 reuse), drawn from the FIRST 20 of overCap in its existing
    // descending-priority order (highest-priority OMITTED named first, RESEARCH Open-Q1).
    expect(event.sample).toHaveLength(20);
    expect(event.sample.map((s) => s.path)).toEqual(overCap.slice(0, 20).map((f) => f.path));
  });

  it('emits generated per-file AND one over_cap aggregate together', () => {
    const events = buildFileSkipEvents({ generated: [fileDiff('g.ts')], overCap: [fileDiff('o1.ts'), fileDiff('o2.ts')] });

    expect(events).toHaveLength(2);
    expect((events[0] as { reason: string }).reason).toBe('generated');
    expect((events[1] as { reason: string; count: number }).reason).toBe('over_cap');
    expect((events[1] as { count: number }).count).toBe(2);
  });

  it('emits [] for empty dropped (no generated, no overCap) — empty-input edge', () => {
    expect(buildFileSkipEvents({ generated: [], overCap: [] })).toEqual([]);
  });

  it('never emits a skip_glob event (D-12 — glob skips are intentionally silent)', () => {
    const events = buildFileSkipEvents({
      generated: [fileDiff('gen.ts')],
      overCap: [fileDiff('cap.ts')],
    });
    for (const event of events) {
      expect((event as { reason: string }).reason).not.toBe('skip_glob');
    }
  });

  it('PRODUCER-PRIVACY: every emitted sample entry has ONLY the `path` key — no body/diff/existingCode/codeSuggestion', () => {
    const overCap = Array.from({ length: 3 }, (_, i) => fileDiff(`c-${i}.ts`));
    const events = buildFileSkipEvents({ generated: [fileDiff('gen.ts')], overCap });

    for (const event of events) {
      for (const entry of (event as { sample: Record<string, unknown>[] }).sample) {
        expect(Object.keys(entry)).toEqual(['path']);
        expect(entry).not.toHaveProperty('body');
        expect(entry).not.toHaveProperty('diff');
        expect(entry).not.toHaveProperty('existingCode');
        expect(entry).not.toHaveProperty('codeSuggestion');
      }
    }
  });
});

describe('buildEvidenceMissingSummary (EVID-03, D-05/D-06/D-07)', () => {
  it('empty input returns null (D-05)', () => {
    expect(buildEvidenceMissingSummary('a.ts', 'main', [])).toBeNull();
  });

  it('single entry still produces one aggregate (D-06)', () => {
    const event = buildEvidenceMissingSummary('a.ts', 'main', [
      { path: 'src/x.ts', line: 10, title: 'finding one', reason: 'absent' },
    ])!;

    expect(event.stage).toBe('evidence_missing_summary');
    expect(event.absentCount).toBe(1);
    expect(event.notInHunkCount).toBe(0);
    expect(event.sample).toHaveLength(1);
  });

  it('mixed reasons produce correct counts', () => {
    const event = buildEvidenceMissingSummary('a.ts', 'main', [
      { path: 'src/x.ts', line: 10, title: 'finding one', reason: 'absent' },
      { path: 'src/y.ts', line: 20, title: 'finding two', reason: 'not_in_hunk' },
    ])!;

    expect(event.absentCount).toBe(1);
    expect(event.notInHunkCount).toBe(1);
  });

  it('sample capped at 20, counts reflect full total', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      path: `src/x/${i}.ts`,
      line: i,
      title: `finding ${i}`,
      reason: (i < 15 ? 'absent' : 'not_in_hunk') as 'absent' | 'not_in_hunk',
    }));

    const event = buildEvidenceMissingSummary('a.ts', 'main', entries)!;

    expect(event.sample).toHaveLength(20);
    expect(event.absentCount).toBe(15);
    expect(event.notInHunkCount).toBe(10);
  });

  it('model emission order preserved (D-07)', () => {
    const event = buildEvidenceMissingSummary('a.ts', 'main', [
      { path: 'src/a.ts', line: 1, title: 'first', reason: 'absent' },
      { path: 'src/b.ts', line: 2, title: 'second', reason: 'not_in_hunk' },
      { path: 'src/c.ts', line: 3, title: 'third', reason: 'absent' },
    ])!;

    expect(event.sample).toHaveLength(3);
    expect(event.sample[0].reason).toBe('absent');
    expect(event.sample[1].reason).toBe('not_in_hunk');
    expect(event.sample[2].reason).toBe('absent');
  });

  it('title redacted via redactFindingTitle', () => {
    const event = buildEvidenceMissingSummary('a.ts', 'main', [
      { path: 'src/x.ts', line: 10, title: 'secret-finding', reason: 'absent' },
    ])!;

    expect(event.sample[0].title).toBe('[title-redacted]');
  });

  it('file+pass identity correct', () => {
    const event = buildEvidenceMissingSummary('src/test.ts', 'main', [
      { path: 'src/x.ts', line: 10, title: 'finding', reason: 'absent' },
    ])!;

    expect(event.file).toBe('src/test.ts');
    expect(event.pass).toBe('main');
  });

  it('both main and security passes accepted', () => {
    const mainEvent = buildEvidenceMissingSummary('a.ts', 'main', [
      { path: 'src/x.ts', line: 10, title: 'finding', reason: 'absent' },
    ])!;
    const secEvent = buildEvidenceMissingSummary('a.ts', 'security', [
      { path: 'src/x.ts', line: 10, title: 'finding', reason: 'absent' },
    ])!;

    expect(mainEvent.pass).toBe('main');
    expect(secEvent.pass).toBe('security');
  });

  it('builder output round-trips through jobAuditEventSchema', () => {
    const event = buildEvidenceMissingSummary('src/test.ts', 'main', [
      { path: 'src/a.ts', line: 10, title: 'first', reason: 'absent' },
      { path: 'src/b.ts', line: null, title: 'second', reason: 'not_in_hunk' },
    ])!;

    const result = jobAuditEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});

dbDescribe('recordFileSkips best-effort recorder (PRIO-03, D-12)', () => {
  const env = createTestEnv();

  it('(9) FAILED-WRITE: recordFileSkips resolves (never throws) and warns when appendJobAuditEvents rejects', async () => {
    const events = buildFileSkipEvents({ generated: [fileDiff('gen.ts')], overCap: [] });

    // Mirror case (8): force the single append to reject and prove the recorder swallows it (best-effort).
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(recordFileSkips(env, 'job-does-not-matter', events)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('(9b) TIMESTAMP-STAMP: recordFileSkips stamps a timestamp on any event lacking one before appending', async () => {
    // An event deliberately missing `timestamp` (cast around the schema) must be stamped defensively.
    const eventMissingTimestamp = {
      stage: 'file_skipped',
      reason: 'over_cap',
      count: 1,
      sample: [{ path: 'x.ts' }],
    } as unknown as JobAuditEvent;

    let appended: JobAuditEvent[] | undefined;
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockImplementation(async (_env, _jobId, evs) => {
        appended = evs;
      });

    await recordFileSkips(env, 'job-does-not-matter', [eventMissingTimestamp]);

    expect(appended).toBeDefined();
    expect(appended).toHaveLength(1);
    expect(appended![0].timestamp).toBeTruthy();

    appendSpy.mockRestore();
  });
});
