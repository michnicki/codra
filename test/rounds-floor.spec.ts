import { describe, expect, it } from 'vitest';
import { buildRoundsEscalatedEvent, composeRoundFloors } from '@server/core/rounds';
import type { ReviewMode } from '@shared/schema';

const categoryConfidence = { security: 0.9 } as const;
const base = {
  minConfidence: 0.7,
  minSeverity: 'nit' as const,
  categoryConfidence,
};

function compose(overrides: {
  reviewRound?: number;
  reviewMode?: ReviewMode;
  roundsIncremental?: boolean;
  escalateFloors?: boolean;
  minConfidence?: number;
  minSeverity?: 'P0' | 'P1' | 'P2' | 'P3' | 'nit';
} = {}) {
  return composeRoundFloors({
    reviewRound: overrides.reviewRound ?? 2,
    reviewMode: overrides.reviewMode ?? 'incremental',
    roundsIncremental: overrides.roundsIncremental ?? true,
    escalateFloors: overrides.escalateFloors ?? true,
    base: {
      ...base,
      minConfidence: overrides.minConfidence ?? base.minConfidence,
      minSeverity: overrides.minSeverity ?? base.minSeverity,
    },
  });
}

describe('composeRoundFloors', () => {
  it('raises eligible round 2 incremental floors to 0.8/P2', () => {
    expect(compose()).toEqual({
      minConfidence: 0.8,
      minSeverity: 'P2',
      categoryConfidence,
      effectiveChanged: true,
      roundFloor: { minConfidence: 0.8, minSeverity: 'P2' },
    });
  });

  it('raises eligible round 3+ confidence to 0.85 without escalating severity past P2', () => {
    expect(compose({ reviewRound: 3 })).toMatchObject({
      minConfidence: 0.85,
      minSeverity: 'P2',
      effectiveChanged: true,
      roundFloor: { minConfidence: 0.85, minSeverity: 'P2' },
    });
    expect(compose({ reviewRound: 8 })).toMatchObject({
      minConfidence: 0.85,
      minSeverity: 'P2',
      effectiveChanged: true,
    });
  });

  it('applies escalation to fallback mode when durable incremental rounds are enabled', () => {
    expect(compose({ reviewMode: 'fallback' })).toMatchObject({
      minConfidence: 0.8,
      minSeverity: 'P2',
      effectiveChanged: true,
    });
  });

  it.each([
    ['round 1', { reviewRound: 1 }],
    ['full mode', { reviewMode: 'full' as const }],
    ['rest mode', { reviewMode: 'rest' as const }],
    ['no_changes mode', { reviewMode: 'no_changes' as const }],
    ['incremental disabled', { roundsIncremental: false }],
    ['floor escalation disabled', { escalateFloors: false }],
  ])('leaves floors unchanged for %s', (_label, overrides) => {
    expect(compose(overrides)).toEqual({
      minConfidence: 0.7,
      minSeverity: 'nit',
      categoryConfidence,
      effectiveChanged: false,
      roundFloor: { minConfidence: 0, minSeverity: 'nit' },
    });
  });

  it('preserves stricter user floors and reports no effective escalation', () => {
    expect(compose({ minConfidence: 0.9, minSeverity: 'P1' })).toEqual({
      minConfidence: 0.9,
      minSeverity: 'P1',
      categoryConfidence,
      effectiveChanged: false,
      roundFloor: { minConfidence: 0.8, minSeverity: 'P2' },
    });
  });

  it('reports an effective change when only one composed floor tightens', () => {
    expect(compose({ minConfidence: 0.9, minSeverity: 'nit' })).toMatchObject({
      minConfidence: 0.9,
      minSeverity: 'P2',
      effectiveChanged: true,
    });
    expect(compose({ minConfidence: 0.7, minSeverity: 'P1' })).toMatchObject({
      minConfidence: 0.8,
      minSeverity: 'P1',
      effectiveChanged: true,
    });
  });

  it('names the absolute effective-floor audit metric without claiming a baseline delta', () => {
    expect(buildRoundsEscalatedEvent({
      from: { minConfidence: 0.7, minSeverity: 'nit' },
      to: { minConfidence: 0.8, minSeverity: 'P2' },
      effective: { minConfidence: 0.8, minSeverity: 'P2' },
      round: 2,
      droppedAtEffectiveFloor: 3,
    }, '2026-07-23T00:00:00.000Z')).toMatchObject({
      stage: 'rounds.escalated',
      droppedAtEffectiveFloor: 3,
    });
  });
});
