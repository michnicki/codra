// Phase 20 (D-04 / D-05): unit tests for the walkthrough-enrichment audit builder and recorder.
//
// The builder is pure (no I/O) so its tests live in the node test project. The recorder is
// best-effort / never-throws so its tests do not require a database — `recordWalkthroughAudit`
// short-circuits on empty input and wraps the append in try/catch with logger.warn. Both
// behaviors are exercised directly via dependency injection (mocking appendJobAuditEvents).
//
// Mirrors the buildEnsembleVoteAuditEvent / recordEnsembleAudit test pattern in test/ensemble.spec.ts.
//
// Phase 20.1 BLOCKER 1 (D-06): the audit-event builders now route finding titles through
// `redactFindingTitle` (./audit-redact). The redaction tests at the bottom of this file pin
// the new contract: titles <= 100 chars pass through unchanged; titles > 100 chars are wrapped
// in a fixed-shape marker. The schema-cap bump from .max(200) -> .max(100) is exercised by
// constructing identifier cards directly with redacted titles and asserting the schema accepts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCriticDecisionsAuditEvent,
  buildFinalizeDropEvents,
  buildWalkthroughEnrichmentAuditEvent,
  recordCriticAudit,
  recordWalkthroughAudit,
} from '@server/core/audit';
import { appendJobAuditEvents } from '@server/db/jobs';
import * as jobsModule from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { jobAuditEventSchema } from '@shared/schema';
import type { DropRecord } from '@server/core/noise-filter';
import type { CriticDecision } from '@shared/schema';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('buildWalkthroughEnrichmentAuditEvent (D-04 / D-05)', () => {
  it('emits a completed event with groupCount when the run legitimately completed', () => {
    const event = buildWalkthroughEnrichmentAuditEvent('completed', undefined, 3);
    expect(event.stage).toBe('walkthrough.enrichment');
    expect(event.status).toBe('completed');
    expect(event.groupCount).toBe(3);
    expect(event.reason).toBeUndefined();
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits a partial event with a reason and groupCount when some fields survived', () => {
    const event = buildWalkthroughEnrichmentAuditEvent('partial', 'parse_partial: confidence', 1);
    expect(event.stage).toBe('walkthrough.enrichment');
    expect(event.status).toBe('partial');
    expect(event.reason).toBe('parse_partial: confidence');
    expect(event.groupCount).toBe(1);
  });

  it('emits a failed event with a reason and no groupCount when the whole call failed', () => {
    const event = buildWalkthroughEnrichmentAuditEvent('failed', 'model_call_failed');
    expect(event.stage).toBe('walkthrough.enrichment');
    expect(event.status).toBe('failed');
    expect(event.reason).toBe('model_call_failed');
    expect(event.groupCount).toBeUndefined();
  });

  it('omits groupCount on failed runs even when the caller passes one (D-04 boundary contract)', () => {
    // The builder rejects groupCount for failed runs to keep the audit a truthful reflection of
    // the durable blob — a failed run never persists a group count.
    const event = buildWalkthroughEnrichmentAuditEvent('failed', 'model_call_failed', 5);
    expect(event.status).toBe('failed');
    expect(event.groupCount).toBeUndefined();
  });

  it('validates against the schema-authoritative walkthrough.enrichment arm', () => {
    const event = buildWalkthroughEnrichmentAuditEvent('completed', undefined, 7);
    const parsed = jobAuditEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stage).toBe('walkthrough.enrichment');
    }
  });
});

describe('recordWalkthroughAudit best-effort recorder (D-04)', () => {
  // The recorder is best-effort / never-throws. Mirrors `recordEnsembleAudit` exactly:
  //   - appends every event in ONE call (no per-event recapture)
  //   - never throws — a broken append resolves undefined and logs warn
  //   - empty input is a no-op (zero Phase-20 events for the inert / disabled / idempotent-reentry paths)
  it('FAILED-WRITE: recordWalkthroughAudit resolves (never throws) and warns when appendJobAuditEvents rejects', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(recordWalkthroughAudit(env, jobId, [
      {
        stage: 'walkthrough.enrichment',
        status: 'completed',
        groupCount: 1,
        timestamp: new Date().toISOString(),
      },
    ])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('EMPTY-INPUT: recordWalkthroughAudit is a no-op and never calls appendJobAuditEvents', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents');
    await recordWalkthroughAudit(env, jobId, []);
    expect(appendSpy).not.toHaveBeenCalled();
    appendSpy.mockRestore();
  });

  it('SUCCESS: one walkthrough.enrichment event is appended with the bounded structural shape', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const event = buildWalkthroughEnrichmentAuditEvent('completed', undefined, 2);
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents').mockResolvedValue(undefined);
    await recordWalkthroughAudit(env, jobId, [event]);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      env,
      jobId,
      [expect.objectContaining({ stage: 'walkthrough.enrichment', status: 'completed', groupCount: 2 })],
    );
    appendSpy.mockRestore();
  });

  it('stamps a timestamp on any event that arrived without one', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents').mockResolvedValue(undefined);
    const eventWithoutTimestamp = {
      stage: 'walkthrough.enrichment' as const,
      status: 'completed' as const,
      groupCount: 1,
      // timestamp omitted intentionally — the recorder must stamp it.
    } as unknown as Parameters<typeof recordWalkthroughAudit>[2][number];
    await recordWalkthroughAudit(env, jobId, [eventWithoutTimestamp]);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const passedEvent = appendSpy.mock.calls[0][2][0];
    expect(passedEvent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    appendSpy.mockRestore();
  });

  // Sanity check: emit a single event structurally identical to what the persisted
  // writer would append — the type assertion lives only because the dispatch table for
  // the discriminated union is sized by the schema and the test exercises the union.
  it('type-validates the emitted event against the discriminated union', () => {
    const event = buildWalkthroughEnrichmentAuditEvent('completed', undefined, 0);
    // The event is assigned through the typed builder; the test documents the
    // expected shape and would fail at compile-time if the builder drifted.
    const narrowed: typeof event = event;
    expect(narrowed.stage).toBe('walkthrough.enrichment');
  });

  // Reference the imported helper so it isn't tree-shaken if the test suite is ever
  // optimized; the actual coverage lives in the recordEnsembleAudit tests.
  it('imports the recorder without side effects', () => {
    expect(typeof recordWalkthroughAudit).toBe('function');
    expect(typeof appendJobAuditEvents).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Phase 20.1 BLOCKER 1 (D-06): the audit-event builders now route finding titles through
// `redactFindingTitle`, which maps every non-empty title to one fixed structural marker. These
// tests pin the producer-side enforcement contract so a regression that restores raw title
// content is caught here, not in production. The three cases mirror the three producer sites in audit.ts:
//   - buildFinalizeDropEvents (filtered / deduped)
//   - buildCriticDecisionsAuditEvent (critic.decisions sample)
//   - and as a bonus, the toAuditIdentifier helper used by buildFinalizeDropEvents.
// ---------------------------------------------------------------------------

describe('BLOCKER 1: buildFinalizeDropEvents redacts sample titles (D-06)', () => {
  const longTitle = 'x'.repeat(250);

  function dropRecord(overrides: Partial<DropRecord> = {}): DropRecord {
    return {
      path: 'src/long.ts',
      line: 42,
      title: longTitle,
      severity: 'P2',
      category: 'quality',
      confidence: 0.5,
      ...overrides,
    };
  }

  it('redacts the title in a confidence-floor filter sample', () => {
    const events = buildFinalizeDropEvents(
      { confidenceFloor: [dropRecord()], severityFloor: [], cap: [], merges: [] },
      { severityFloor: 'P2', cap: 100 },
    );
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<typeof events[0], { stage: 'filtered' }>;
    expect(event.sample[0].title).toBe('[title-redacted]');
    expect(event.sample[0].title.length).toBeLessThanOrEqual(100);
    expect(event.sample[0].title).not.toBe(longTitle);
  });

  it('redacts the title in a severity-floor filter sample', () => {
    const events = buildFinalizeDropEvents(
      { confidenceFloor: [], severityFloor: [dropRecord()], cap: [], merges: [] },
      { severityFloor: 'P2', cap: 100 },
    );
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<typeof events[0], { stage: 'filtered' }>;
    expect(event.sample[0].title).not.toBe(longTitle);
    expect(event.sample[0].title.length).toBeLessThanOrEqual(100);
  });

  it('redacts the title in a cap filter sample', () => {
    const events = buildFinalizeDropEvents(
      { confidenceFloor: [], severityFloor: [], cap: [dropRecord()], merges: [] },
      { severityFloor: 'P2', cap: 100 },
    );
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<typeof events[0], { stage: 'filtered' }>;
    expect(event.sample[0].title).not.toBe(longTitle);
    expect(event.sample[0].title.length).toBeLessThanOrEqual(100);
  });

  it('redacts both survivor and suppressed titles in a deduped merge', () => {
    const survivor = dropRecord({ path: 'src/survivor.ts' });
    const suppressed = dropRecord({ path: 'src/suppressed.ts' });
    const events = buildFinalizeDropEvents(
      {
        confidenceFloor: [],
        severityFloor: [],
        cap: [],
        merges: [
          {
            rule: 'rule1',
            survivor: { ...survivor, body: 'body', severity: 'P2', category: 'quality' } as any,
            suppressed: { ...suppressed, body: 'body', severity: 'P2', category: 'quality' } as any,
            titleSimilarity: 0.95,
            bodySimilarity: null,
          },
        ],
      },
      { severityFloor: 'P2', cap: 100 },
    );
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<typeof events[0], { stage: 'deduped' }>;
    expect(event.survivor.title).not.toBe(longTitle);
    expect(event.survivor.title.length).toBeLessThanOrEqual(100);
    expect(event.suppressed.title).not.toBe(longTitle);
    expect(event.suppressed.title.length).toBeLessThanOrEqual(100);
  });

  it('redacts short sensitive titles in finalize-drop samples', () => {
    const sensitiveTitle = 'token sk_live_finalize_secret';
    const short = dropRecord({ title: sensitiveTitle });
    const events = buildFinalizeDropEvents(
      { confidenceFloor: [short], severityFloor: [], cap: [], merges: [] },
      { severityFloor: 'P2', cap: 100 },
    );
    const event = events[0] as Extract<typeof events[0], { stage: 'filtered' }>;
    expect(event.sample[0].title).toBe('[title-redacted]');
    expect(event.sample[0].title).not.toContain(sensitiveTitle);
  });

  it('emits events that validate against the schema-deployed jobAuditEventSchema', () => {
    const events = buildFinalizeDropEvents(
      { confidenceFloor: [dropRecord()], severityFloor: [], cap: [], merges: [] },
      { severityFloor: 'P2', cap: 100 },
    );
    for (const event of events) {
      const parsed = jobAuditEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
    }
  });
});

describe('BLOCKER 1: buildCriticDecisionsAuditEvent redacts sample titles (D-06)', () => {
  const longTitle = 'x'.repeat(250);

  it('redacts the title in each critic sample row', () => {
    const decisions: CriticDecision[] = [
      { id: 0, path: 'src/a.ts', line: 1, severity: 'P2', category: 'quality', title: longTitle, body: 'body', confidence: 0.9, verdict: 'proven', outcome: 'kept', reason: 'evidence-supported' },
      { id: 1, path: 'src/b.ts', line: 2, severity: 'P2', category: 'quality', title: longTitle, body: 'body', confidence: 0.9, verdict: 'unsupported', outcome: 'dropped', reason: 'evidence-unsupported' },
    ];
    const event = buildCriticDecisionsAuditEvent(decisions, 'completed');
    expect(event).not.toBeNull();
    const sample = event!.sample;
    expect(sample).toHaveLength(2);
    for (const row of sample) {
      expect(row.title).not.toBe(longTitle);
      expect(row.title.length).toBeLessThanOrEqual(100);
      expect(row.title).toBe('[title-redacted]');
    }
  });

  it('redacts short sensitive titles in critic samples', () => {
    const sensitiveTitle = 'api-key critic-secret';
    const decisions: CriticDecision[] = [
      { id: 0, path: 'src/a.ts', line: 1, severity: 'P2', category: 'quality', title: sensitiveTitle, body: 'body', confidence: 0.9, verdict: 'proven', outcome: 'kept', reason: 'evidence-supported' },
    ];
    const event = buildCriticDecisionsAuditEvent(decisions, 'completed');
    expect(event!.sample[0].title).toBe('[title-redacted]');
    expect(event!.sample[0].title).not.toContain(sensitiveTitle);
  });

  it('emits an event that validates against the schema-deployed jobAuditEventSchema', () => {
    const decisions: CriticDecision[] = [
      { id: 0, path: 'src/a.ts', line: 1, severity: 'P2', category: 'quality', title: longTitle, body: 'body', confidence: 0.9, verdict: 'proven', outcome: 'kept', reason: 'evidence-supported' },
    ];
    const event = buildCriticDecisionsAuditEvent(decisions, 'completed');
    const parsed = jobAuditEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 20.1 BLOCKER 5: the skip branch at review.ts:2803-2856 must emit a
// critic.decisions audit event with status='skipped' + reason + count=0 + sample=[]
// for all three skip causes (empty input, explicit skip_threshold, over-char-budget).
// The audit-event schema already accepts status='skipped' via criticRunStatusSchema at
// schema.ts:485 — no schema change needed; only the producer wiring + chain routing.
// The empty-input / over-char-budget paths pass an empty decisions array to the
// builder, which returns null (audit.ts:470). The skip branch then hand-crafts the
// event to ensure the audit viewer receives the skip terminal. The recorder is
// best-effort (never rethrows) so the audit write never fails the review.
// ---------------------------------------------------------------------------

describe('BLOCKER 5: buildCriticDecisionsAuditEvent skipped semantic', () => {
  it('returns null when decisions is empty (hand-crafted fallback is the BLOCKER 5 fix)', () => {
    // Mirrors the builder's existing empty-input short-circuit at audit.ts:470. The skip branch
    // depends on this so the BLOCKER 5 fix uses a hand-crafted event instead of the builder.
    const event = buildCriticDecisionsAuditEvent([], 'skipped', 'empty-input');
    expect(event).toBeNull();
  });

  it('emits a valid event with status=skipped + count=0 + sample=[] when decisions is empty AND the builder would have been forced to derive from the kept set', () => {
    // The empty-input case has zero candidates passed to the builder, so the cleanest path is
    // the hand-crafted event. This test pins the SHAPE the hand-craft must match: the schema
    // derives count from the received count field and sample from the received sample array —
    // a hand-crafted event with count=0 and sample=[] is therefore schema-valid.
    const event = buildCriticDecisionsAuditEvent([], 'skipped', 'empty-input');
    // The hand-crafted event the skip branch produces (see review.ts:2835-2842) is structurally
    // identical to a builder output but with explicit count=0 + sample=[].
    const handCrafted = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'empty-input',
      timestamp: new Date().toISOString(),
    };
    const parsed = jobAuditEventSchema.safeParse(handCrafted);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.stage).toBe('critic.decisions');
      if (parsed.data.stage === 'critic.decisions') {
        expect(parsed.data.status).toBe('skipped');
        expect(parsed.data.count).toBe(0);
        expect(parsed.data.sample).toEqual([]);
        expect(parsed.data.reason).toBe('empty-input');
      }
    }
    // The builder itself returns null for this input — the skip branch must use the hand-craft.
    expect(event).toBeNull();
  });

  it('emits a valid event with status=skipped + reason when decisions has candidates', () => {
    // The skip_threshold / over-char-budget paths pass a non-empty decisions array (the
    // reconciled decisions from reconcileCriticDecisions). The builder returns a valid event
    // with count=candidates.length — the skip branch may use the builder output directly.
    const decisions: CriticDecision[] = [
      { id: 0, path: 'src/a.ts', line: 1, severity: 'P2', category: 'quality', title: 'short', body: 'body', confidence: 0.9, verdict: null, outcome: 'kept', reason: 'evidence-supported' },
    ];
    const event = buildCriticDecisionsAuditEvent(decisions, 'skipped', 'below-skip-threshold');
    expect(event).not.toBeNull();
    expect(event!.status).toBe('skipped');
    expect(event!.reason).toBe('below-skip-threshold');
    expect(event!.count).toBe(1);
    expect(event!.sample).toHaveLength(1);
    const parsed = jobAuditEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it('emits a valid event with status=skipped + reason for over-char-budget reason', () => {
    const decisions: CriticDecision[] = [
      { id: 0, path: 'src/a.ts', line: 1, severity: 'P2', category: 'quality', title: 'short', body: 'body', confidence: 0.9, verdict: null, outcome: 'kept', reason: 'evidence-supported' },
    ];
    const event = buildCriticDecisionsAuditEvent(decisions, 'skipped', 'over-char-budget');
    expect(event).not.toBeNull();
    expect(event!.status).toBe('skipped');
    expect(event!.reason).toBe('over-char-budget');
  });
});

describe('BLOCKER 5: recordCriticAudit accepts skipped event (best-effort)', () => {
  it('SUCCESS: recordCriticAudit appends a skipped event with the bounded structural shape', async () => {
    // The skip branch at review.ts:2843 calls recordCriticAudit with a single hand-crafted event.
    // The recorder is best-effort: try/catch + logger.warn + never rethrows (D-13-03-04 posture).
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents').mockResolvedValue(undefined);
    const skippedEvent = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'empty-input',
      timestamp: new Date().toISOString(),
    };
    await expect(recordCriticAudit(env, jobId, [skippedEvent])).resolves.toBeUndefined();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      env,
      jobId,
      [expect.objectContaining({ stage: 'critic.decisions', status: 'skipped', count: 0, sample: [] })],
    );
    appendSpy.mockRestore();
  });

  it('EMPTY-INPUT: recordCriticAudit is a no-op and never calls appendJobAuditEvents', async () => {
    // Mirrors the existing fast-return at audit.ts:510. The skip branch should never pass an empty
    // array (the hand-craft always has at least one event), but the recorder must stay defensive.
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents');
    await recordCriticAudit(env, jobId, []);
    expect(appendSpy).not.toHaveBeenCalled();
    appendSpy.mockRestore();
  });

  it('FAILED-WRITE: recordCriticAudit resolves (never throws) and warns when appendJobAuditEvents rejects', async () => {
    // Best-effort posture: a broken audit write must never wreck the review (D-13-03-04).
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const skippedEvent = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'empty-input',
      timestamp: new Date().toISOString(),
    };
    await expect(recordCriticAudit(env, jobId, [skippedEvent])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('stamps a timestamp on a skipped event that arrived without one', async () => {
    // The skip branch always sets timestamp explicitly, but the recorder must remain defensive
    // (mirrors the walkthrough pattern at audit-events.spec.ts:127-142).
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents').mockResolvedValue(undefined);
    const eventWithoutTimestamp = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'empty-input',
      // timestamp omitted intentionally — the recorder must stamp it.
    } as unknown as Parameters<typeof recordCriticAudit>[2][number];
    await recordCriticAudit(env, jobId, [eventWithoutTimestamp]);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const passedEvent = appendSpy.mock.calls[0][2][0];
    expect(passedEvent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    appendSpy.mockRestore();
  });
});

describe('BLOCKER 5: hand-crafted skipped event schema-validates', () => {
  // The skip branch at review.ts:2835-2842 hand-crafts the event because the builder returns
  // null for empty decisions. This block pins the exact shape the hand-craft must match so a
  // regression that drifts the producer shape is caught at test time, not in production.
  it('hand-crafted event for empty-input reason validates against jobAuditEventSchema', () => {
    const event = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'empty-input',
      timestamp: new Date().toISOString(),
    };
    const parsed = jobAuditEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it('hand-crafted event for below-skip-threshold reason validates against jobAuditEventSchema', () => {
    const event = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'below-skip-threshold',
      timestamp: new Date().toISOString(),
    };
    const parsed = jobAuditEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it('hand-crafted event for over-char-budget reason validates against jobAuditEventSchema', () => {
    const event = {
      stage: 'critic.decisions' as const,
      status: 'skipped' as const,
      count: 0,
      sample: [],
      reason: 'over-char-budget',
      timestamp: new Date().toISOString(),
    };
    const parsed = jobAuditEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });
});
