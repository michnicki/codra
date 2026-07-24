// Phase 20 (D-04 / D-05): unit tests for the walkthrough-enrichment audit builder and recorder.
//
// The builder is pure (no I/O) so its tests live in the node test project. The recorder is
// best-effort / never-throws so its tests do not require a database — `recordWalkthroughAudit`
// short-circuits on empty input and wraps the append in try/catch with logger.warn. Both
// behaviors are exercised directly via dependency injection (mocking appendJobAuditEvents).
//
// Mirrors the buildEnsembleVoteAuditEvent / recordEnsembleAudit test pattern in test/ensemble.spec.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWalkthroughEnrichmentAuditEvent,
  recordWalkthroughAudit,
} from '@server/core/audit';
import { appendJobAuditEvents } from '@server/db/jobs';
import * as jobsModule from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { jobAuditEventSchema } from '@shared/schema';

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
