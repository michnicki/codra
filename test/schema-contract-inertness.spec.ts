import { describe, expect, it } from 'vitest';
import {
  reviewJobMessageSchema,
  repoConfigSchema,
  criticResultSchema,
  fileReviewPassSchema,
  fileReviewRecordSchema,
  defaultRepoConfig,
} from '@shared/schema';
import { runReviewJob } from '@server/core/review';
import { createTestEnv } from './helpers';

// Phase 7 contract-inertness spec. Pins the SC2 CONTRACT half (a pre-widening ReviewJobMessage still
// validates; the widened fields resolve to `undefined`) and the SC3 toggle-off defaults, plus the
// D-07 pass value-set default, the D-08 criticResult passthrough tolerance, and the boundary
// rejection of a stray phase:'critic' message. Modeled on test/schema-provider-default.spec.ts.
//
// SC2 ROUTING half (review -> finalize) is guaranteed by the UNTOUCHED dispatch switch
// (review.ts:412-417) and is verified end-to-end by test/review-flow.spec.ts (the "reviews files in
// a chunk concurrently" case, :730-741, drives a pre-widening { jobId, deliveryId, phase: 'review' }
// message through runReviewJob and asserts { action: 'next_phase', phase: 'finalize', ... }), which
// runs inside Plan 04's SC5 `npm test` gate. This spec asserts the contract-level inertness that
// unlocks it — it does NOT stand up a workflow/dispatch harness for the review->finalize case.

describe('SC2: reviewJobMessageSchema widening is inert for pre-widening producers', () => {
  it('safeParses a pre-widening { jobId, deliveryId, phase: "review" } message with kind AND reviewScope undefined', () => {
    const preWidening = {
      jobId: '11111111-1111-4111-8111-111111111111',
      deliveryId: 'd1',
      phase: 'review' as const,
    };

    const result = reviewJobMessageSchema.safeParse(preWidening);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBeUndefined();
      expect(result.data.reviewScope).toBeUndefined();
    }
  });

  it('safeParses an event-only pre-widening { deliveryId, eventName } message', () => {
    const eventOnly = {
      deliveryId: 'd-event-only-1',
      eventName: 'pull_request',
    };

    const result = reviewJobMessageSchema.safeParse(eventOnly);

    expect(result.success).toBe(true);
  });

  it('rejects an out-of-vocabulary phase value (closed vocabulary)', () => {
    const bogus = {
      jobId: '22222222-2222-4222-8222-222222222222',
      deliveryId: 'd2',
      phase: 'bogus',
    };

    const result = reviewJobMessageSchema.safeParse(bogus);

    expect(result.success).toBe(false);
  });
});

describe('SC3: Phase-7 reviewConfig toggles default off; the three v1.2 always-on exceptions default on (NREG-01 inertness)', () => {
  it('repoConfigSchema.parse({}) yields every opt-in toggle false and the documented default-ON exceptions true', () => {
    const cfg = repoConfigSchema.parse({});

    expect(cfg.review.passes.security.enabled).toBe(false);
    expect(cfg.review.passes.critic.enabled).toBe(false);
    expect(cfg.review.walkthrough.enabled).toBe(false);
    // D-09: the walkthrough sequence_diagram sub-toggle defaults ON, but is inert while the parent
    // walkthrough.enabled is false. Pin the default here so a future flip is caught by a named test.
    expect(cfg.review.walkthrough.sequence_diagram.enabled).toBe(true);
    expect(cfg.review.interactive.commands.enabled).toBe(false);
    expect(cfg.review.interactive.qa.enabled).toBe(false);
    // CMD-07 (Layer 2): the config-based Bitbucket bot account_id defaults to null so an unconfigured
    // repo is byte-identical to today (NREG-01) and the resolver falls back to live discovery.
    expect(cfg.review.interactive.commands.bitbucket_bot_account_id).toBeNull();
    // DOCUMENTED DEFAULT-ON EXCEPTIONS (D-01/D-02): severity_engine, dedup, and file_selection are
    // framed as correctness fixes / always-on behavior, each with a single-key escape hatch — NOT
    // opt-in features. They deliberately default TRUE, so this spec no longer implies "all off".
    expect(cfg.review.severity_engine.enabled).toBe(true);
    expect(cfg.review.dedup.enabled).toBe(true);
    expect(cfg.review.file_selection.enabled).toBe(true);
    // Phase 30 (ANNO-01, NREG-01): the Bitbucket Code Insights annotations toggle defaults off.
    expect(cfg.review.bitbucket.annotations_enabled).toBe(false);
  });

  it('the exported defaultRepoConfig yields the same all-off values', () => {
    expect(defaultRepoConfig.review.passes.security.enabled).toBe(false);
    expect(defaultRepoConfig.review.passes.critic.enabled).toBe(false);
    expect(defaultRepoConfig.review.walkthrough.enabled).toBe(false);
    expect(defaultRepoConfig.review.walkthrough.sequence_diagram.enabled).toBe(true);
    expect(defaultRepoConfig.review.interactive.commands.enabled).toBe(false);
    expect(defaultRepoConfig.review.interactive.qa.enabled).toBe(false);
    expect(defaultRepoConfig.review.interactive.commands.bitbucket_bot_account_id).toBeNull();
    expect(defaultRepoConfig.review.bitbucket.annotations_enabled).toBe(false);
  });

  it('CMD-07: bitbucket_bot_account_id round-trips a configured value', () => {
    const cfg = repoConfigSchema.parse({
      review: { interactive: { commands: { bitbucket_bot_account_id: 'acct-xyz' } } },
    });

    expect(cfg.review.interactive.commands.bitbucket_bot_account_id).toBe('acct-xyz');
    // Other commands defaults remain inert alongside the configured id.
    expect(cfg.review.interactive.commands.enabled).toBe(false);
    expect(cfg.review.interactive.commands.bitbucket_allowed_account_ids).toEqual([]);
  });

  it('ANNO-01: bitbucket.annotations_enabled round-trips true while every other review field stays at its own default', () => {
    const cfg = repoConfigSchema.parse({
      review: { bitbucket: { annotations_enabled: true } },
    });

    expect(cfg.review.bitbucket.annotations_enabled).toBe(true);
    // Every other review field remains at its own independent default.
    expect(cfg.review.passes.security.enabled).toBe(false);
    expect(cfg.review.passes.critic.enabled).toBe(false);
    expect(cfg.review.walkthrough.enabled).toBe(false);
    expect(cfg.review.interactive.commands.enabled).toBe(false);
    expect(cfg.review.interactive.qa.enabled).toBe(false);
    expect(cfg.review.severity_engine.enabled).toBe(true);
    expect(cfg.review.dedup.enabled).toBe(true);
    expect(cfg.review.file_selection.enabled).toBe(true);
    expect(cfg.review.learning.enabled).toBe(false);
  });
});

describe('D-08: criticResultSchema is tolerant (passthrough) and metadata-optional', () => {
  it('parses a minimal { kept: [], pruned: [] } result (metadata optional)', () => {
    const result = criticResultSchema.safeParse({ kept: [], pruned: [] });
    expect(result.success).toBe(true);
  });

  it('accepts an unknown extra metadata key (.passthrough() so Phase 10 can extend)', () => {
    const result = criticResultSchema.safeParse({ kept: [], pruned: [], somethingNew: 1 });
    expect(result.success).toBe(true);
  });
});

describe('D-07: fileReviewPassSchema value-set and fileReviewRecordSchema.pass default', () => {
  it('fileReviewPassSchema accepts main/security and rejects anything else', () => {
    expect(fileReviewPassSchema.safeParse('main').success).toBe(true);
    expect(fileReviewPassSchema.safeParse('security').success).toBe(true);
    expect(fileReviewPassSchema.safeParse('bogus').success).toBe(false);
  });

  it('fileReviewRecordSchema defaults pass to "main" when omitted (job-detail read path stays inert)', () => {
    const recordWithoutPass = {
      id: '33333333-3333-4333-8333-333333333333',
      jobId: '44444444-4444-4444-8444-444444444444',
      filePath: 'src/index.ts',
      fileStatus: 'done',
      modelUsed: 'gpt-4o-mini',
      diffLineCount: 12,
      diffInput: null,
      rawAiOutput: null,
      parsedComments: [],
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
      verdict: null,
      fileSummary: null,
      errorMessage: null,
      createdAt: '2026-07-19T00:00:00.000Z',
    };

    const result = fileReviewRecordSchema.parse(recordWithoutPass);

    expect(result.pass).toBe('main');
  });
});

describe('SC2 review-fix: a stray phase:"critic" message is rejected at the boundary, never run', () => {
  it('runReviewJob acks a phase:"critic" message before any DB access', async () => {
    // DB-free: resolveQueuedJob rejects requestedPhase === 'critic' (warn + return null) BEFORE
    // getJobForProcessing, so runReviewJob returns { action: 'ack' } without touching the env DB.
    // This proves a premature/spoofed critic message can never silently run main review — Phase 10
    // owns critic dispatch; the internal dispatch switch stays prepare|review|finalize.
    const env = createTestEnv();

    const result = await runReviewJob(env, {
      jobId: crypto.randomUUID(),
      deliveryId: 'd1',
      phase: 'critic',
    });

    expect(result).toEqual({ action: 'ack' });
  });
});
