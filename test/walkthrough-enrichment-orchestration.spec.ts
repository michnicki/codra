// Phase 19 Plan 19-08 (PASS-03): orchestration tests for the walkthrough enrichment phase.
//
// These pin the durable-orchestration invariants without spinning up a full DB / Workflow stack:
//   - The phase is idempotent on a persisted walkthrough_enrichment blob (re-entry after
//     hibernation skips the model call and hands off to finalize).
//   - The phase degrades fail-soft on a whole-call model exception (status='failed' blob, hand-off
//     to finalize, no thrown exception out of the phase).
//   - The phase routes through finalize on `walkthrough.enabled=false` (NREG-01 — no model call,
//     no DB write, no audit event).
//   - The phase skips the model call when there are no main-pass reviews (status='failed', hand-off
//     to finalize, deterministic coverage walkthrough can still post).
//   - The phase persists a `status: 'completed' | 'partial'` blob when the model emits valid groups
//     (independently per field — D-17).
//
// The formatter tests pin the GROUPED renderer (D-14) and the bottom assessment block (D-15) and
// the monotonic body-cap truncation (T-19-08-03), on both GitHub and Bitbucket (Bitbucket must
// never receive a Mermaid fence — D-13).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWalkthroughEnrichmentPhase } from '@server/core/walkthrough-enrichment';
import { buildWalkthroughData } from '@server/core/walkthrough';
import { FormatterService } from '@server/services/formatter';
import { NextPhaseError } from '@server/core/next-phase-error';
import { parseWalkthroughEnrichmentResponse } from '@server/core/model-output';
import {
  reviewSeverities,
  walkthroughEnrichmentSchema,
  type ParsedReviewComment,
  type RepoConfig,
  type WalkthroughEnrichment,
} from '@shared/schema';
import { setJobWalkthroughEnrichment } from '@server/db/jobs';
import { recordWalkthroughAudit } from '@server/core/audit';
import { z } from 'zod';
import type { ModelService } from '@server/services/model';

function defaultRepoConfig(): RepoConfig {
  return {
    review: {
      walkthrough: { enabled: true, sequence_diagram: { enabled: false } },
      threads: { verify_fixes: false, auto_resolve: false },
      passes: { critic: { enabled: false } },
    },
    model: { main: 'test-model', fallbacks: [], size_overrides: [] },
  } as unknown as RepoConfig;
}

function makeJob(overrides: Partial<{
  walkthroughEnrichment: WalkthroughEnrichment | null;
  walkthroughCommentRef: string | null;
  prTitle: string | null;
}> = {}) {
  return {
    id: 'job-id',
    owner: 'owner',
    repo: 'repo',
    prNumber: 1,
    prTitle: overrides.prTitle ?? null,
    walkthroughEnrichment: overrides.walkthroughEnrichment ?? null,
    walkthroughCommentRef: overrides.walkthroughCommentRef ?? null,
  };
}

function makeEnv() {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
  } as any;
}

function makeModel(overrides: Partial<{
  rawText: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  throwError: Error;
}> = {}) {
  return {
    generateWalkthroughEnrichment: vi.fn(async () => {
      if (overrides.throwError) throw overrides.throwError;
      return {
        rawText: overrides.rawText ?? '',
        modelUsed: overrides.modelUsed ?? 'test-model',
        inputTokens: overrides.inputTokens ?? 0,
        outputTokens: overrides.outputTokens ?? 0,
      };
    }),
  } as unknown as ModelService;
}

// Stub getFileReviewsForJobs to return a deterministic main-pass review set. The phase consumes
// only `pass === 'main'` rows; security rows are filtered out by the phase itself, mirroring
// buildWalkthroughData's contract.
let stubReviews: Array<{
  file_path: string;
  file_summary: string | null;
  file_status: 'pending' | 'done' | 'skipped' | 'failed';
  error_msg: string | null;
  verdict: 'approve' | 'comment' | null;
  pass: 'main' | 'security';
}> = [];

vi.mock('@server/db/file-reviews', async () => {
  const actual = await vi.importActual<typeof import('@server/db/file-reviews')>('@server/db/file-reviews');
  return {
    ...actual,
    getFileReviewsForJobs: vi.fn(async () => stubReviews),
  };
});

vi.mock('@server/db/jobs', async () => {
  const actual = await vi.importActual<typeof import('@server/db/jobs')>('@server/db/jobs');
  return {
    ...actual,
    setJobWalkthroughEnrichment: vi.fn(async () => {}),
  };
});

// Phase 20 (D-04): the walkthrough-enrichment phase imports the best-effort recorder from
// core/audit. Mock it so the orchestration tests can verify each terminal branch emits EXACTLY
// ONE bounded `walkthrough.enrichment` event after the durable setJobWalkthroughEnrichment call.
vi.mock('@server/core/audit', async () => {
  const actual = await vi.importActual<typeof import('@server/core/audit')>('@server/core/audit');
  return {
    ...actual,
    recordWalkthroughAudit: vi.fn(async () => {}),
  };
});

beforeEach(() => {
  stubReviews = [];
  vi.mocked(setJobWalkthroughEnrichment).mockClear();
  vi.mocked(setJobWalkthroughEnrichment).mockResolvedValue(undefined);
  vi.mocked(recordWalkthroughAudit).mockClear();
  vi.mocked(recordWalkthroughAudit).mockResolvedValue(undefined);
});

describe('walkthrough-enrichment phase orchestration', () => {
  it('skips the model call and hands off to finalize when walkthrough.enabled is false (NREG-01)', async () => {
    const config = {
      ...defaultRepoConfig(),
      review: { ...defaultRepoConfig().review, walkthrough: { enabled: false, sequence_diagram: { enabled: false } } },
    } as RepoConfig;
    const model = makeModel();
    const job = makeJob();

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job,
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(model.generateWalkthroughEnrichment).not.toHaveBeenCalled();
    expect(setJobWalkthroughEnrichment).not.toHaveBeenCalled();
    expect(recordWalkthroughAudit).not.toHaveBeenCalled();
  });

  it('skips the model call on idempotent re-entry when blob is already persisted', async () => {
    const config = defaultRepoConfig();
    const model = makeModel();
    const job = makeJob({
      walkthroughEnrichment: { version: 1, status: 'completed' },
    });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job,
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(model.generateWalkthroughEnrichment).not.toHaveBeenCalled();
    expect(setJobWalkthroughEnrichment).not.toHaveBeenCalled();
    expect(recordWalkthroughAudit).not.toHaveBeenCalled();
  });

  it('persists a failed blob and hands off when there are no main-pass reviews', async () => {
    stubReviews = []; // empty — phase should short-circuit
    const config = defaultRepoConfig();
    const model = makeModel({ rawText: '{}' });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(model.generateWalkthroughEnrichment).not.toHaveBeenCalled();
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      expect.objectContaining({ status: 'failed', reason: 'no_files_to_enrich' }),
    );
    // Phase 20 (D-04): exactly one audit event after the persist call.
    expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
    expect(recordWalkthroughAudit).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      [
        expect.objectContaining({
          stage: 'walkthrough.enrichment',
          status: 'failed',
          reason: 'no_files_to_enrich',
        }),
      ],
    );
  });

  it('persists a failed blob and hands off when the model call throws', async () => {
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'Adds endpoint.', file_status: 'done', error_msg: null, verdict: 'comment', pass: 'main' },
    ];
    const config = defaultRepoConfig();
    const model = makeModel({ throwError: new Error('boom') });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      expect.objectContaining({ status: 'failed', reason: 'model_call_failed' }),
    );
    expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
    expect(recordWalkthroughAudit).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      [expect.objectContaining({ stage: 'walkthrough.enrichment', status: 'failed', reason: 'model_call_failed' })],
    );
  });

  it('persists a failed blob and hands off when the parser returns fail_open', async () => {
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'Adds endpoint.', file_status: 'done', error_msg: null, verdict: 'comment', pass: 'main' },
    ];
    const config = defaultRepoConfig();
    const model = makeModel({ rawText: '' });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      expect.objectContaining({ status: 'failed', reason: 'empty_response' }),
    );
    expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
    expect(recordWalkthroughAudit).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      [expect.objectContaining({ stage: 'walkthrough.enrichment', status: 'failed', reason: 'empty_response' })],
    );
  });

  it('persists a completed blob when the model emits valid groups', async () => {
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'Adds endpoint.', file_status: 'done', error_msg: null, verdict: 'comment', pass: 'main' },
      { file_path: 'src/b.ts', file_summary: 'Renames variable.', file_status: 'done', error_msg: null, verdict: 'approve', pass: 'main' },
    ];
    const config = defaultRepoConfig();
    const model = makeModel({
      rawText: JSON.stringify({
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: { score: 4, label: 'Looks good', reason: 'r' },
        effort: { level: 2, label: 'Small', minutes: 30 },
      }),
    });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      expect.objectContaining({
        status: 'completed',
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: { score: 4, label: 'Looks good', reason: 'r' },
        effort: { level: 2, label: 'Small', minutes: 30 },
      }),
    );
    // Phase 20 (D-04): completed run emits one audit event with the durable groupCount.
    expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
    expect(recordWalkthroughAudit).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      [
        expect.objectContaining({
          stage: 'walkthrough.enrichment',
          status: 'completed',
          groupCount: 1,
        }),
      ],
    );
  });

  it('persists a partial blob when only some fields validate', async () => {
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'Adds endpoint.', file_status: 'done', error_msg: null, verdict: 'comment', pass: 'main' },
    ];
    const config = defaultRepoConfig();
    const model = makeModel({
      rawText: JSON.stringify({
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: { score: 99, label: 'bad' }, // out-of-range score
      }),
    });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      expect.objectContaining({
        // Phase 20 (D-05): a supplied-but-invalid field is malformed, so the durable status
        // is now 'partial' instead of the (incorrect) 'completed' the previous test asserted.
        status: 'partial',
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: null,
      }),
    );
    // Phase 20 (D-04): partial run emits one audit event with a parse_partial reason and
    // the durable groupCount (the surviving groups count, not zero).
    expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
    expect(recordWalkthroughAudit).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      [
        expect.objectContaining({
          stage: 'walkthrough.enrichment',
          status: 'partial',
          reason: 'parse_partial: confidence',
          groupCount: 1,
        }),
      ],
    );
  });

  it('never throws out of the phase on any failure mode', async () => {
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'x', file_status: 'done', error_msg: null, verdict: 'approve', pass: 'main' },
    ];
    const config = defaultRepoConfig();

    // Model returns non-JSON garbage
    const model = makeModel({ rawText: 'this is not json {{{' });
    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);
    // Either fail_open path or partial path — never a raw re-throw of the parse error
  });

  it('persists a failed blob and a single audit event when the parser returns fail_open on empty input', async () => {
    // WR-02: empty input `{}` causes the parser to short-circuit to `fail_open` (all_fields_invalid),
    // which exercises the parsed.kind === 'fail_open' branch (line 185-194) — NOT the defensive
    // schema_validation_failed branch (line 222-234). The schema-validation-failed branch is
    // unreachable from the parser's happy-path and is covered by the next test via an explicit
    // walkthroughEnrichmentSchema.safeParse intercept.
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'Adds endpoint.', file_status: 'done', error_msg: null, verdict: 'comment', pass: 'main' },
    ];
    const config = defaultRepoConfig();
    const model = makeModel({ rawText: '{}' });

    await expect(runWalkthroughEnrichmentPhase({
      env: makeEnv(),
      job: makeJob(),
      config,
      model,
    })).rejects.toThrow(NextPhaseError);

    expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
    expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      expect.objectContaining({ status: 'failed', reason: 'all_fields_invalid' }),
    );
    expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
    expect(recordWalkthroughAudit).toHaveBeenCalledWith(
      expect.anything(),
      'job-id',
      [expect.objectContaining({ stage: 'walkthrough.enrichment', status: 'failed', reason: 'all_fields_invalid' })],
    );
  });

  it('persists a failed blob and a single audit event when the assembled payload fails Zod validation', async () => {
    // WR-02: direct coverage of the defensive schema_validation_failed branch. The branch is
    // unreachable from the parser's happy-path (the parser only emits schema-valid fields), so we
    // intercept walkthroughEnrichmentSchema.safeParse to force a failure. This pins the branch
    // against future regressions that might let a non-validated field into the envelope.
    stubReviews = [
      { file_path: 'src/a.ts', file_summary: 'Adds endpoint.', file_status: 'done', error_msg: null, verdict: 'comment', pass: 'main' },
    ];
    const config = defaultRepoConfig();
    // Emit a payload that the parser accepts as 'parsed' (groups non-empty + valid confidence +
    // effort) so the code reaches the walkthroughEnrichmentSchema.safeParse defensive branch.
    const model = makeModel({
      rawText: JSON.stringify({
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: { score: 4, label: 'OK', reason: 'r' },
        effort: { level: 2, label: 'Small', minutes: 30 },
      }),
    });

    // Force the assembled payload to fail schema validation so the defensive branch is exercised.
    const safeParseSpy = vi.spyOn(walkthroughEnrichmentSchema, 'safeParse').mockReturnValue({
      success: false,
      error: new z.ZodError([{ code: 'custom', path: [], message: 'forced schema failure' }]),
    } as unknown as ReturnType<typeof walkthroughEnrichmentSchema.safeParse>);

    try {
      await expect(runWalkthroughEnrichmentPhase({
        env: makeEnv(),
        job: makeJob(),
        config,
        model,
      })).rejects.toThrow(NextPhaseError);

      expect(safeParseSpy).toHaveBeenCalled();
      expect(setJobWalkthroughEnrichment).toHaveBeenCalledTimes(1);
      expect(setJobWalkthroughEnrichment).toHaveBeenCalledWith(
        expect.anything(),
        'job-id',
        expect.objectContaining({ status: 'failed', reason: 'schema_validation_failed' }),
      );
      expect(recordWalkthroughAudit).toHaveBeenCalledTimes(1);
      expect(recordWalkthroughAudit).toHaveBeenCalledWith(
        expect.anything(),
        'job-id',
        [expect.objectContaining({ stage: 'walkthrough.enrichment', status: 'failed', reason: 'schema_validation_failed' })],
      );
    } finally {
      safeParseSpy.mockRestore();
    }
  });
});

describe('parseWalkthroughEnrichmentResponse contract', () => {
  it('returns fail_open on empty input', () => {
    expect(parseWalkthroughEnrichmentResponse('')).toEqual({ kind: 'fail_open', reason: 'empty_response' });
  });

  it('returns fail_open on garbage non-JSON', () => {
    const result = parseWalkthroughEnrichmentResponse('asdf');
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      // Accept any of the parser's fail_open reasons — the exact code depends on which gate
      // caught the input. The parser always returns kind: 'fail_open' for non-JSON input.
      expect(['json_extract_failed', 'json_parse_failed', 'json_not_object', 'all_fields_invalid']).toContain(result.reason);
    }
  });

  it('returns empty malformedFields when every supplied field validates (Phase 20 D-05)', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      confidence: { score: 4, label: 'OK', reason: 'r' },
      effort: { level: 2, label: 'Small', minutes: 30 },
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual([]);
    }
  });

  it('marks a supplied-but-invalid field as malformed while valid fields survive (Phase 20 D-05)', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
      confidence: { score: 99, label: 'bad' }, // out-of-range score
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual(['confidence']);
      expect(result.groups).toHaveLength(1);
      expect(result.confidence).toBeNull();
    }
  });

  it('does NOT mark absent fields as malformed when other fields validate', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }],
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual([]);
    }
  });

  it('marks groups as malformed when the array was supplied but EVERY item was invalid', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: '' }, 'not-an-object', null], // all invalid per the schema
    }));
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      expect(result.reason).toBe('all_fields_invalid');
    }
  });

  it('keeps groups non-malformed when the array was supplied AND at least one item survived', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      groups: [{ label: 'API', paths: ['src/a.ts'] }, { label: '', paths: [] }], // mix of valid + invalid
    }));
    expect(result.kind).toBe('parsed');
    if (result.kind === 'parsed') {
      expect(result.malformedFields).toEqual([]);
      expect(result.groups).toHaveLength(1);
    }
  });

  it('marks a wrong-shape confidence (non-object) as malformed', () => {
    const result = parseWalkthroughEnrichmentResponse(JSON.stringify({
      confidence: 42, // wrong shape — must be object
    }));
    expect(result.kind).toBe('fail_open');
    if (result.kind === 'fail_open') {
      expect(result.reason).toBe('all_fields_invalid');
    }
  });
});

// =====================================================================
// Grouped renderer / assessment / monotonic body-cap (D-14, D-15, T-19-08-03)
// =====================================================================

function emptyCounts() {
  const counts = {} as Record<ParsedReviewComment['severity'], number>;
  for (const sev of reviewSeverities) counts[sev] = 0;
  return counts;
}

// Typed review-row helper for the renderer tests. The orchestration stubs use a looser shape.
function makeReviewRow(overrides: Partial<{
  file_path: string;
  file_summary: string;
  file_status: 'pending' | 'done' | 'skipped' | 'failed';
  error_msg: string | null;
  verdict: 'approve' | 'comment' | null;
  diff_line_count: number;
  pass: 'main' | 'security';
}> = {}) {
  return {
    file_path: overrides.file_path ?? 'src/a.ts',
    file_summary: overrides.file_summary ?? 'A',
    file_status: overrides.file_status ?? 'done',
    error_msg: overrides.error_msg ?? null,
    verdict: overrides.verdict ?? 'approve',
    diff_line_count: overrides.diff_line_count ?? 10,
    pass: overrides.pass ?? 'main',
  };
}

const formatter = new FormatterService('https://open-codra.example.com');

describe('formatWalkthrough grouped renderer (D-14)', () => {
  it('renders grouped sections instead of the flat table when groups are supplied', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A', verdict: 'comment' }),
      makeReviewRow({ file_path: 'src/b.ts', file_summary: 'B', diff_line_count: 5 }),
    ];
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: {
        groups: [
          { label: 'API', paths: ['src/a.ts'] },
          { label: 'Cleanup', paths: ['src/b.ts'] },
        ],
        confidence: null,
        effort: null,
      },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    expect(body).toContain('**API**');
    expect(body).toContain('**Cleanup**');
    // Both grouped files appear in the rendered body
    expect(body).toContain('src/a.ts');
    expect(body).toContain('src/b.ts');
  });

  it('appends a deterministic "Other changes" bucket for unassigned reviewed paths', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A' }),
      makeReviewRow({ file_path: 'src/b.ts', file_summary: 'B', diff_line_count: 5 }),
    ];
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: {
        groups: [{ label: 'API', paths: ['src/a.ts'] }], // b.ts not claimed
        confidence: null,
        effort: null,
      },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    expect(body).toContain('Other changes');
    expect(body).toContain('src/b.ts');
  });

  it('renders the bottom assessment block when confidence + effort are present (D-15)', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A' }),
    ];
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: {
        groups: [],
        confidence: { score: 4, label: 'Looks good', reason: 'r' },
        effort: { level: 2, label: 'Small', minutes: 30 },
      },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    expect(body).toContain('**Confidence 4/5 — Looks good** · r');
    expect(body).toContain('**Effort 2/5 — Small · ~30 minutes**');
  });

  it('emits an Unavailable bottom block when confidence/effort are null', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A' }),
    ];
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: { groups: [], confidence: null, effort: null },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    expect(body).toContain('**Confidence:** Unavailable');
    expect(body).toContain('**Effort:** Unavailable');
  });

  it('preserves the historical flat rendering when no groups / assessment are supplied (NREG-01)', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A', verdict: 'comment' }),
    ];
    const finalComments = [
      { path: 'src/a.ts', line: 1, position: 1, severity: 'P2', category: 'quality', title: 't', body: 'b', codeSuggestion: null, existingCode: null } as ParsedReviewComment,
    ];
    const data = buildWalkthroughData({ reviews, finalComments });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    // No grouped headings in the flat branch
    expect(body).not.toContain('**API**');
    expect(body).not.toContain('**Other changes**');
    // Assessment block absent
    expect(body).not.toContain('**Confidence');
    expect(body).not.toContain('**Effort');
  });

  it('Bitbucket never receives a Mermaid fence (D-13)', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A' }),
    ];
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: {
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: null,
        effort: null,
      },
    });

    const mermaid = 'sequenceDiagram\n  Reviewer->>PR: review';
    const ghBody = formatter.formatWalkthrough({ ...data, mermaid }, { provider: 'github' });
    const bbBody = formatter.formatWalkthrough({ ...data, mermaid }, { provider: 'bitbucket' });

    expect(ghBody).toContain('```mermaid');
    expect(bbBody).not.toContain('```mermaid');
  });

  it('preserves D-04 thread totals when groups are present', () => {
    const reviews = [
      makeReviewRow({ file_path: 'src/a.ts', file_summary: 'A', verdict: 'comment' }),
    ];
    const finalComments = [
      { path: 'src/a.ts', line: 1, position: 1, severity: 'P0', category: 'security', title: 't', body: 'b', codeSuggestion: null, existingCode: null } as ParsedReviewComment,
    ];
    const verification = {
      version: 1 as const,
      status: 'completed' as const,
      totals: { fixed: 1, unfixed: 0, unverifiable: 0, resolved: 1 },
      entries: [],
    };
    const data = buildWalkthroughData({
      reviews,
      finalComments,
      threadVerification: verification,
      enrichment: {
        groups: [{ label: 'API', paths: ['src/a.ts'] }],
        confidence: null,
        effort: null,
      },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    expect(body).toContain('**Thread verification:** Fixed 1 · Unfixed 0 · Unverifiable 0 · Resolved 1');
  });
});

describe('formatWalkthrough monotonic body-cap (T-19-08-03)', () => {
  it('shrinks the row counter monotonically until the body fits WALKTHROUGH_BODY_MAX', () => {
    // Build enough large-summary rows that the body exceeds WALKTHROUGH_BODY_MAX and the cap loop
    // shrinks rowCount. The result body must be present and not have a partial trailing row.
    const longSummary = 'x'.repeat(500);
    const reviews = Array.from({ length: 50 }, (_, idx) => ({
      file_path: `src/file-${idx}.ts`,
      file_summary: longSummary,
      file_status: 'done' as const,
      error_msg: null,
      verdict: 'approve' as const,
      diff_line_count: 10,
      pass: 'main' as const,
    }));
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: {
        groups: reviews.map((r) => ({ label: `Group ${r.file_path}`, paths: [r.file_path] })),
        confidence: null,
        effort: null,
      },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    // The body is bounded — total cap enforced.
    expect(body.length).toBeLessThanOrEqual(60_000 + 1024); // small slack for the body-cap boundary
    // Truncation indicator appears when the cap is hit.
    expect(body).toMatch(/more files reviewed|…walkthrough truncated/);
  });

  it('preserves complete coverage — every reviewed path either renders or collapses to "+N more"', () => {
    const reviews = Array.from({ length: 80 }, (_, idx) => ({
      file_path: `src/file-${idx}.ts`,
      file_summary: 'short',
      file_status: 'done' as const,
      error_msg: null,
      verdict: 'approve' as const,
      diff_line_count: 10,
      pass: 'main' as const,
    })) as Array<{
      file_path: string;
      file_summary: string | null;
      file_status: 'pending' | 'done' | 'skipped' | 'failed';
      error_msg: string | null;
      verdict: 'approve' | 'comment' | null;
      diff_line_count: number | null;
      pass: 'main' | 'security';
    }>;
    const data = buildWalkthroughData({
      reviews,
      finalComments: [],
      enrichment: {
        groups: reviews.map((r) => ({ label: `Group ${r.file_path}`, paths: [r.file_path] })),
        confidence: null,
        effort: null,
      },
    });

    const body = formatter.formatWalkthrough(data, { provider: 'github' });
    // Either every file renders OR the overflow marker indicates how many were dropped.
    const rendered = reviews.filter((r) => body.includes(r.file_path)).length;
    const overflowMatch = body.match(/\+(\d+) more files reviewed/);
    const overflow = overflowMatch ? parseInt(overflowMatch[1], 10) : 0;
    expect(rendered + overflow).toBe(reviews.length);
  });
});

describe('empty counts helper', () => {
  it('seeds all severities at zero', () => {
    const counts = emptyCounts();
    for (const sev of reviewSeverities) {
      expect(counts[sev]).toBe(0);
    }
  });
});
