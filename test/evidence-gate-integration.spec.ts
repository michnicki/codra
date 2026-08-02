import { describe, it, expect } from 'vitest';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';
import { runWithDb } from '@server/db/client';
import { getJobDetail, insertJob } from '@server/db/jobs';
import { recordUnitAudit } from '@server/core/audit';
import { parseFileReviewResponse } from '@server/core/model-output';
import type { FileDiff } from '@server/core/diff';
import type { JobAuditEvent } from '@shared/schema';

// -------------------------------------------------------------------------------------------------
// Phase 15 Plan 04 — EVID-01 SC4 DB round-trip: an evidence_missing event produced by the REAL
// parseFileReviewResponse evidence gate survives the EXISTING recordUnitAudit path end-to-end with
// zero new plumbing (D-18):
//   parseFileReviewResponse (producer) -> severityAuditEvents accumulator -> recordUnitAudit ->
//   appendJobAuditEvents -> Postgres jsonb ring buffer -> getJobDetail(...).audit (fail-soft read).
//
// Plus a PRODUCER-LEVEL privacy assertion (Codex 15-01 MEDIUM): the emitted event carries only
// { stage, reason, path, line, title, timestamp } — never body/diff/existingCode/codeSuggestion —
// proving privacy is enforced by producer CONSTRUCTION, not merely the .passthrough() schema.
//
// Test-env quirks (project memory): requires `.env.test` BITBUCKET_* dummies + migrations applied once
// via `npm test` (the DB is never reset — TRUNCATE jobs CASCADE if the LIMIT-500 flake appears). NOTE
// (Codex 15-04 LOW): the verify command `npm test` runs the FULL node suite — scripts/test.mjs ignores
// a trailing `-- <file>` arg — so this spec runs as part of a full-suite gate.
// -------------------------------------------------------------------------------------------------

const sha = (char: string) => char.repeat(40);

// A FileDiff whose only added line does NOT contain the finding's evidence string, so the REAL gate
// emits evidence_missing{reason:'not_in_hunk'}. Line 1 is a valid diff line, so the finding survives
// the orphan check and becomes a persisted comment (a dropped off-diff finding emits no event).
const EVIDENCE_FILE: FileDiff = {
  path: 'src/evidence.ts',
  previousPath: null,
  isNew: false,
  isDeleted: false,
  isBinary: false,
  lineCount: 1,
  hunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      lines: [{ kind: 'add', content: 'const value = compute();', newLineNumber: 1, position: 1 }],
    },
  ],
};

const RAW_JSON = JSON.stringify({
  findings: [
    {
      title: 'Unvalidated computed value',
      body: 'The computed value is used without validation.',
      priority: 1,
      category: 'correctness',
      code_location: { absolute_file_path: 'src/evidence.ts', line: 1 },
      // Evidence text that appears NOWHERE in the hunk -> not_in_hunk.
      existing_code: 'const somethingEntirelyDifferent = elsewhere();',
    },
  ],
  overall_correctness: 'patch is incorrect',
  overall_explanation: 'Found an issue.',
  overall_confidence_score: 0.85,
});

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
const TIMEOUT_MS = 60_000;

dbDescribe('EVID-01/EVID-03 evidence_missing_summary DB round-trip (recordUnitAudit -> getJobDetail)', () => {
  const env = createTestEnv();

  it('produces a not_in_hunk event carrying NO code/body keys (producer-level privacy)', () => {
    const parsed = parseFileReviewResponse(RAW_JSON, EVIDENCE_FILE);
    // The finding ALWAYS still posts (soft gate, D-14).
    expect(parsed.comments).toHaveLength(1);

    const evidenceEvents = parsed.severityAuditEvents.filter((e) => e.stage === 'evidence_missing_summary');
    expect(evidenceEvents).toHaveLength(1);
    const event = evidenceEvents[0];
    expect(event).toMatchObject({ stage: 'evidence_missing_summary', notInHunkCount: 1, file: 'src/evidence.ts' });

    // Producer-level privacy: the serialized event's keys are EXACTLY the bounded set.
    const keys = Object.keys(JSON.parse(JSON.stringify(event)));
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('diff');
    expect(keys).not.toContain('existingCode');
    expect(keys).not.toContain('codeSuggestion');
    expect(keys.sort()).toEqual(['absentCount', 'file', 'notInHunkCount', 'pass', 'sample', 'stage', 'timestamp']);
  });

  it('the not_in_hunk event survives recordUnitAudit and is readable from getJobDetail().audit', async () => {
    await runWithDb(env, async () => {
      const parsed = parseFileReviewResponse(RAW_JSON, EVIDENCE_FILE);

      const job = await insertJob(env, {
        installationId: '123',
        owner: 'test-owner',
        repo: `evid-gate-${Date.now()}`,
        prNumber: 11,
        prTitle: 'Evidence gate round-trip',
        prAuthor: 'author',
        commitSha: sha('a'),
        baseSha: sha('0'),
        trigger: 'auto',
        headRef: 'feature',
        baseRef: 'main',
      });

      // The EXISTING per-unit recorder — zero new plumbing (D-18). It carries the severityAuditEvents
      // accumulator (drafted + any evidence_missing_summary) to jobs.audit in a single append.
      await recordUnitAudit(env, job.id, EVIDENCE_FILE.path, 'main', parsed.severityAuditEvents);

      const detail = await getJobDetail(env, job.id);
      expect(detail).not.toBeNull();

      const evidence = detail!.audit.filter(
        (e): e is Extract<JobAuditEvent, { stage: 'evidence_missing_summary' }> => e.stage === 'evidence_missing_summary',
      );
      expect(evidence.some((e) => e.notInHunkCount > 0 && e.stage === 'evidence_missing_summary' && e.file === EVIDENCE_FILE.path)).toBe(true);
    });
  }, TIMEOUT_MS);
});
