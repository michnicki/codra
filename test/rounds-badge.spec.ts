import { describe, expect, it } from 'vitest';
import { groupAuditByStage } from '@client/lib/audit-grouping';
import { formatRoundBadge } from '@client/lib/rounds-badge';
import { jobAuditEventSchema, type JobAuditEvent } from '@shared/schema';

describe('formatRoundBadge', () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1])(
    'hides an invalid or first-round value (%s)',
    (round) => {
      expect(formatRoundBadge({ round })).toBeNull();
    },
  );

  it('shows neutral round metadata when incremental consumers were disabled', () => {
    expect(
      formatRoundBadge({
        round: 2,
        mode: 'full',
        incrementalEnabled: false,
        escalateFloors: false,
      }),
    ).toBe('Round 2');
  });

  it.each([
    ['incremental', 'Round 2 · incremental'],
    ['fallback', 'Round 2 · full-diff fallback'],
    ['no_changes', 'Round 2 · no changes'],
  ] as const)('formats round 2 %s copy with middle dots', (mode, expected) => {
    expect(
      formatRoundBadge({
        round: 2,
        mode,
        incrementalEnabled: true,
        escalateFloors: true,
      }),
    ).toBe(expected);
  });

  it.each([
    ['incremental', 'Round 3 · incremental · floors not escalated'],
    ['fallback', 'Round 3 · full-diff fallback · floors not escalated'],
    ['no_changes', 'Round 3 · no changes · floors not escalated'],
    ['full', 'Round 3 · full diff · floors not escalated'],
  ] as const)('appends the disabled-floor suffix for %s mode', (mode, expected) => {
    expect(
      formatRoundBadge({
        round: 3,
        mode,
        incrementalEnabled: true,
        escalateFloors: false,
      }),
    ).toBe(expected);
  });

  it('uses the fail-open round 3+ summary when mode detail is unavailable', () => {
    expect(formatRoundBadge({ round: 4, incrementalEnabled: true })).toBe('Round 3+');
  });

  it('preserves the exact round when a known mode is available', () => {
    expect(
      formatRoundBadge({
        round: 4,
        mode: 'incremental',
        incrementalEnabled: true,
        escalateFloors: true,
      }),
    ).toBe('Round 4 · incremental');
  });
});

describe('round audit display contract', () => {
  it('parses and groups every known rounds event in insertion order', () => {
    const timestamp = '2026-07-23T12:00:00.000Z';
    const events = [
      {
        stage: 'rounds.detected',
        mode: 'incremental',
        round: 2,
        incremental: true,
        anchorSha: 'a'.repeat(40),
        hasUnresolvedThreads: true,
        timestamp,
      },
      {
        stage: 'rounds.no_changes',
        from: 'a'.repeat(40),
        to: 'b'.repeat(40),
        round: 3,
        incremental: true,
        timestamp,
      },
      {
        stage: 'rounds.anchor_skipped',
        reason: 'empty_head',
        round: 3,
        timestamp,
      },
      {
        stage: 'rounds.escalated',
        from: { minConfidence: 0.7, minSeverity: 'P3' },
        to: { minConfidence: 0.8, minSeverity: 'P2' },
        effective: { minConfidence: 0.9, minSeverity: 'P2' },
        round: 2,
        timestamp,
      },
      {
        stage: 'rounds.suppressed',
        path: 'src/review.ts',
        line: 42,
        title: 'Existing open finding',
        threadPath: 'src/review.ts',
        timestamp,
      },
    ].map((event) => jobAuditEventSchema.parse(event)) as JobAuditEvent[];

    expect(groupAuditByStage(events)).toEqual([
      {
        stage: 'rounds',
        count: 5,
        events,
      },
    ]);
  });

  it('rounds.escalated carries droppedAtEffectiveFloor through jobAuditEventSchema passthrough (defined and undefined both round-trip)', () => {
    const timestamp = '2026-07-23T12:00:00.000Z';
    const baseEscalated = {
      stage: 'rounds.escalated',
      from: { minConfidence: 0.7, minSeverity: 'P3' },
      to: { minConfidence: 0.8, minSeverity: 'P2' },
      effective: { minConfidence: 0.9, minSeverity: 'P2' },
      round: 2,
      timestamp,
    };

    // (a) When the producer wrote droppedAtEffectiveFloor, the parsed event exposes it
    // (proves the .passthrough() carries the field end-to-end through the schema).
    const parsedWithDropped = jobAuditEventSchema.parse({ ...baseEscalated, droppedAtEffectiveFloor: 3 });
    expect((parsedWithDropped as JobAuditEvent & { droppedAtEffectiveFloor?: number }).droppedAtEffectiveFloor).toBe(3);

    // (b) When the producer omitted droppedAtEffectiveFloor (legacy producer case), the parsed
    // event leaves the field undefined — matches rounds.ts:363-365 conditional spread.
    const parsedWithoutDropped = jobAuditEventSchema.parse(baseEscalated);
    expect((parsedWithoutDropped as JobAuditEvent & { droppedAtEffectiveFloor?: number }).droppedAtEffectiveFloor).toBeUndefined();

    // Both events flow through groupAuditByStage and the resulting group is unchanged:
    // adding the field does NOT alter the display-stage grouping (still single 'rounds' group).
    const grouped = groupAuditByStage([parsedWithDropped, parsedWithoutDropped]);
    expect(grouped).toEqual([
      {
        stage: 'rounds',
        count: 2,
        events: [parsedWithDropped, parsedWithoutDropped],
      },
    ]);
  });

  it('omits the rounds group when no rounds events exist', () => {
    expect(groupAuditByStage([])).toEqual([]);
  });
});
