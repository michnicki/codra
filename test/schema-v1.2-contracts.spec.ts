import { describe, it, expect } from 'vitest';
import {
  repoConfigSchema,
  reviewConfigSchema,
  parsedReviewCommentSchema,
  fileReviewModelOutputSchema,
  jobAuditEventSchema,
  jobSummarySchema,
  jobDetailSchema,
  severityBandMap,
} from '@shared/schema';

// Phase 13 Plan 01: prove every v1.2 contract shape lands at its documented inert default and that a
// pre-v1.2 fixture still parses byte-identically (NREG-01 / ROADMAP SC5). Pure Zod-parse test — no
// database required (unlike the DB-gated jobs-columns-inertness.spec.ts it otherwise mirrors).

describe('v1.2 schema contracts (Phase 13 Plan 01)', () => {
  it('(a) repoConfigSchema.parse({}).review carries every new key at its documented default', () => {
    const review = repoConfigSchema.parse({}).review;
    expect(review.severity_engine.enabled).toBe(true);
    expect(review.dedup.enabled).toBe(true);
    // Phase 15 PRIO-01/PRIO-02: file_selection is the third documented default-ON exception (D-01/D-02).
    expect(review.file_selection.enabled).toBe(true);
    expect(review.passes.ensemble.runs).toBe(1);
    expect(review.passes.ensemble.temperature).toBe(0.7);
    expect(review.threads.verify_fixes).toBe(false);
    expect(review.threads.auto_resolve).toBe(false);
    expect(review.rounds.incremental).toBe(false);
    expect(review.rounds.escalate_floors).toBe(true);
    expect(review.category_confidence).toEqual({});
  });

  it('(b) parsedReviewCommentSchema.category defaults to correctness (D-05)', () => {
    const parsed = parsedReviewCommentSchema.parse({ path: 'a', severity: 'P2', title: 't', body: 'b' });
    expect(parsed.category).toBe('correctness');
  });

  it('(c) jobAuditEventSchema accepts drafted + severity_adjusted, rejects an unknown stage', () => {
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'drafted',
        file: 'a.ts',
        pass: 'main',
        timestamp: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'severity_adjusted',
        rule: 'keyword_promotion',
        matched: 'sql injection',
        from: 'P2',
        to: 'P0',
        timestamp: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(jobAuditEventSchema.safeParse({ stage: 'unknown_stage' }).success).toBe(false);
  });

  it('(c2) jobAuditEventSchema accepts file_skipped + evidence_missing; still rejects an unknown stage (Phase 15 D-11/D-17)', () => {
    const ts = new Date().toISOString();
    // file_skipped: generated (minimal sample — path only)
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'file_skipped',
        reason: 'generated',
        count: 1,
        sample: [{ path: 'a.ts' }],
        timestamp: ts,
      }).success,
    ).toBe(true);
    // file_skipped: over_cap (sample carries the consistency-only line/title fields)
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'file_skipped',
        reason: 'over_cap',
        count: 5,
        sample: [{ path: 'b.ts', line: 3, title: 'x' }],
        timestamp: ts,
      }).success,
    ).toBe(true);
    // evidence_missing: both reason discriminators parse
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'evidence_missing',
        reason: 'not_in_hunk',
        path: 'c.ts',
        line: 4,
        title: 't',
        timestamp: ts,
      }).success,
    ).toBe(true);
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'evidence_missing',
        reason: 'absent',
        path: 'd.ts',
        title: 't2',
        timestamp: ts,
      }).success,
    ).toBe(true);
    // The union stays a discriminatedUnion — an unknown stage is still rejected per-event.
    expect(jobAuditEventSchema.safeParse({ stage: 'nonexistent_stage' }).success).toBe(false);
    // The four pre-existing variants remain unchanged (drafted/severity_adjusted/filtered/deduped).
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'filtered',
        rule: 'confidence_floor',
        count: 2,
        threshold: 0.7,
        sample: [{ path: 'e.ts', title: 't' }],
        timestamp: ts,
      }).success,
    ).toBe(true);
    expect(
      jobAuditEventSchema.safeParse({
        stage: 'deduped',
        rule: 'rule1',
        survivor: { path: 'f.ts', title: 's' },
        suppressed: { path: 'f.ts', title: 'd' },
        timestamp: ts,
      }).success,
    ).toBe(true);
  });

  it('(c3) fileReviewModelOutputSchema.existing_code parses fail-open: string, null, AND omission (D-15, Codex HIGH)', () => {
    const base = {
      title: 't',
      body: 'b',
      code_location: { absolute_file_path: 'a', line: 1 },
    };
    // A string value parses.
    expect(
      fileReviewModelOutputSchema.parse({
        findings: [{ ...base, existing_code: 'x' }],
        overall_correctness: 'patch is correct',
      }).findings[0].existing_code,
    ).toBe('x');
    // JSON `null` parses (the load-bearing Codex 15-01 HIGH case — bare .optional() would throw here).
    expect(
      fileReviewModelOutputSchema.parse({
        findings: [{ ...base, existing_code: null }],
        overall_correctness: 'patch is correct',
      }).findings[0].existing_code,
    ).toBeNull();
    // Omission parses (fail-open).
    expect(() =>
      fileReviewModelOutputSchema.parse({
        findings: [base],
        overall_correctness: 'patch is correct',
      }),
    ).not.toThrow();
  });

  it('(d) a pre-v1.2 config fixture (no v1.2 keys) still parses without throwing (NREG-01)', () => {
    expect(() => reviewConfigSchema.parse({})).not.toThrow();
    // Fixture carrying ONLY pre-existing keys — no v1.2 key present anywhere.
    expect(() =>
      reviewConfigSchema.parse({ max_comments: 5, min_severity: 'P2', focus: ['security'] }),
    ).not.toThrow();
  });

  it('(e) category_confidence parses a SPARSE override with absent categories staying absent (review fix)', () => {
    const cc = reviewConfigSchema.parse({ category_confidence: { security: 0.85 } }).category_confidence;
    expect(cc).toEqual({ security: 0.85 });
    // The four unspecified categories are genuinely ABSENT, not defaulted — this FAILS under z.record.
    expect('bugs' in cc).toBe(false);
    expect('quality' in cc).toBe(false);
  });

  it('(f) severityBandMap: P0 and P1 both resolve to the identical blocker band (review fix)', () => {
    expect(severityBandMap.P0).toBe('blocker');
    expect(severityBandMap.P1).toBe('blocker');
    expect(severityBandMap.P2).toBe('warning');
    expect(severityBandMap.P3).toBe('suggestion');
    expect(severityBandMap.nit).toBe('nitpick');
  });

  it('(g) audit/auditTruncated live on jobDetailSchema only, never on jobSummarySchema (review fix)', () => {
    expect('audit' in jobSummarySchema.shape).toBe(false);
    expect('auditTruncated' in jobSummarySchema.shape).toBe(false);
    expect('audit' in jobDetailSchema.shape).toBe(true);
    expect('auditTruncated' in jobDetailSchema.shape).toBe(true);

    // A pre-Phase-13 job-detail object (no audit / auditTruncated keys) still parses, defaulting them.
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      prTitle: null,
      prAuthor: null,
      commitSha: 'abc',
      trigger: 'auto',
      status: 'done',
      verdict: null,
      fileCount: 0,
      commentCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      baseSha: 'def',
      headRef: null,
      baseRef: null,
      summaryMarkdown: null,
      configSnapshot: null,
      reviewId: null,
      retryOfJobId: null,
      summaryModel: null,
      files: [],
    };
    const detail = jobDetailSchema.parse(base);
    expect(detail.audit).toEqual([]);
    expect(detail.auditTruncated).toBe(false);
  });
});
