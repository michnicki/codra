import { describe, expect, it } from 'vitest';
import type { VcsReviewThread } from '@server/vcs/types';
import type { JobAuditEvent } from '@shared/schema';
import {
  buildRoundInputsFromConfig,
  buildRoundsAnchorSkippedEvent,
  buildRoundsDetectedEvent,
  buildRoundsEscalatedEvent,
  buildRoundsNoChangesEvent,
  buildRoundsSuppressedEvent,
  composeRoundFloors,
  overlapsOpenThread,
  resolveRoundContext,
  suppressByOpenThreads,
  type ResolveRoundInputs,
} from '@server/core/rounds';

// Phase 18 Plan 01 (RND-01 / D-01..D-06): the pure round resolver, floor composer, thread
// overlap matcher, and audit-event builders. Every helper in core/rounds.ts is PURE -- this
// spec is pure (no DB, no Vitest mocks) and exercises the locked decision matrix from the
// plan's acceptance criteria.

// ───────────────────────────────────────────────────────────────────────────────────────
// resolveRoundContext — D-01/D-02 round resolution matrix.
// ───────────────────────────────────────────────────────────────────────────────────────

const noThreads: VcsReviewThread[] = [];
const oneThread: VcsReviewThread[] = [
  { ref: 'PRRT_abc', path: 'src/a.ts', lineStart: 1, lineEnd: 5, rootBody: '', outdated: false },
];

const noPrior = {
  priorState: null,
};

const priorRound2 = {
  priorState: {
    last_reviewed_sha: 'a'.repeat(40),
    last_review_round: 2,
  },
};

const priorRound1 = {
  priorState: {
    last_reviewed_sha: 'b'.repeat(40),
    last_review_round: 1,
  },
};

function resolve(input: ResolveRoundInputs) {
  return resolveRoundContext(input);
}

describe('resolveRoundContext — D-01/D-02 (RND-01)', () => {
  it('no signal: prior null + no threads => round 1, mode full', () => {
    expect(resolve({ ...noPrior, unresolvedThreads: noThreads, roundsIncremental: false })).toEqual({
      round: 1,
      mode: 'full',
      roundsIncremental: false,
      anchorSha: null,
      hasUnresolvedThreads: false,
    });
  });

  it('anchor only (round 1 prior) + roundsIncremental true => round 2, mode incremental', () => {
    expect(resolve({ ...priorRound1, unresolvedThreads: noThreads, roundsIncremental: true })).toEqual({
      round: 2,
      mode: 'incremental',
      roundsIncremental: true,
      anchorSha: 'b'.repeat(40),
      hasUnresolvedThreads: false,
    });
  });

  it('anchor only (round 2 prior) + roundsIncremental false => round 3, mode fallback', () => {
    expect(resolve({ ...priorRound2, unresolvedThreads: noThreads, roundsIncremental: false })).toEqual({
      round: 3,
      mode: 'fallback',
      roundsIncremental: false,
      anchorSha: 'a'.repeat(40),
      hasUnresolvedThreads: false,
    });
  });

  it('anchor + threads: anchor-derived round wins (OR composition), incremental respects the toggle', () => {
    expect(resolve({ ...priorRound2, unresolvedThreads: oneThread, roundsIncremental: true })).toEqual({
      round: 3,
      mode: 'incremental',
      roundsIncremental: true,
      anchorSha: 'a'.repeat(40),
      hasUnresolvedThreads: true,
    });
  });

  it('thread-only detection at default-disabled roundsIncremental: round 2, mode fallback (D-04)', () => {
    // Acceptance criterion (1): thread-only detection resolves round 2 with roundsIncremental
    // false (the schema-default). The round counter advances; the consumer path (compare-diff)
    // is gated elsewhere.
    expect(resolve({ ...noPrior, unresolvedThreads: oneThread, roundsIncremental: false })).toEqual({
      round: 2,
      mode: 'fallback',
      roundsIncremental: false,
      anchorSha: null,
      hasUnresolvedThreads: true,
    });
  });

  it('review-rest short-circuit: NO state / thread calls, round 1, mode rest (D-03)', () => {
    // Acceptance criterion (1): review-rest forces round 1 / mode rest regardless of any
    // prior state or threads present. The resolver is called with prior + threads but the
    // review-rest flag short-circuits.
    expect(
      resolve({
        ...priorRound2,
        unresolvedThreads: oneThread,
        roundsIncremental: true,
        reviewScope: 'rest',
      }),
    ).toEqual({
      round: 1,
      mode: 'rest',
      roundsIncremental: true,
      anchorSha: null,
      hasUnresolvedThreads: false,
    });
  });

  it('review-rest with NO prior + NO threads: still round 1, mode rest (idempotent short-circuit)', () => {
    expect(
      resolve({
        ...noPrior,
        unresolvedThreads: noThreads,
        roundsIncremental: false,
        reviewScope: 'rest',
      }),
    ).toEqual({
      round: 1,
      mode: 'rest',
      roundsIncremental: false,
      anchorSha: null,
      hasUnresolvedThreads: false,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// buildRoundInputsFromConfig — wiring helper.
// ───────────────────────────────────────────────────────────────────────────────────────

describe('buildRoundInputsFromConfig', () => {
  it('pulls rounds.incremental from the config snapshot at the durable default (false)', () => {
    const built = buildRoundInputsFromConfig({
      reviewScope: null,
      priorState: null,
      unresolvedThreads: noThreads,
      config: { review: { rounds: { incremental: false, escalate_floors: true } } } as never,
    });
    expect(built.roundsIncremental).toBe(false);
  });

  it('respects rounds.incremental: true when configured', () => {
    const built = buildRoundInputsFromConfig({
      reviewScope: null,
      priorState: null,
      unresolvedThreads: noThreads,
      config: { review: { rounds: { incremental: true, escalate_floors: true } } } as never,
    });
    expect(built.roundsIncremental).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// composeRoundFloors — D-09/D-10/D-11/D-12 floor composition matrix.
// ───────────────────────────────────────────────────────────────────────────────────────

describe('composeRoundFloors — D-09/D-10/D-11/D-12 (RND-03)', () => {
  it('round 1: floors unchanged, effectiveChanged false', () => {
    const out = composeRoundFloors({
      reviewRound: 1,
      escalateFloors: true,
      base: { minConfidence: 0.7, minSeverity: 'P2', categoryConfidence: {} },
    });
    expect(out.minConfidence).toBe(0.7);
    expect(out.minSeverity).toBe('P2');
    expect(out.effectiveChanged).toBe(false);
  });

  it('round 2 with default floors: effective = round (0.80, P2), effectiveChanged true', () => {
    const out = composeRoundFloors({
      reviewRound: 2,
      escalateFloors: true,
      base: { minConfidence: 0.7, minSeverity: 'nit', categoryConfidence: {} },
    });
    expect(out.minConfidence).toBe(0.80);
    expect(out.minSeverity).toBe('P2');
    expect(out.effectiveChanged).toBe(true);
  });

  it('round 3+: confidence 0.85, severity stays P2 (D-10)', () => {
    const out = composeRoundFloors({
      reviewRound: 3,
      escalateFloors: true,
      base: { minConfidence: 0.7, minSeverity: 'nit', categoryConfidence: {} },
    });
    expect(out.minConfidence).toBe(0.85);
    expect(out.minSeverity).toBe('P2');
    expect(out.roundFloor).toEqual({ minConfidence: 0.85, minSeverity: 'P2' });
  });

  it('round 2 with stricter user-set confidence 0.90: user wins (D-11)', () => {
    const out = composeRoundFloors({
      reviewRound: 2,
      escalateFloors: true,
      // minSeverity must already match the round's P2 so effectiveChanged only measures confidence.
      base: { minConfidence: 0.90, minSeverity: 'P2', categoryConfidence: {} },
    });
    expect(out.minConfidence).toBe(0.90);
    expect(out.minSeverity).toBe('P2');
    expect(out.effectiveChanged).toBe(false);
  });

  it('round 2 with stricter user-set severity P1: user wins (D-11)', () => {
    const out = composeRoundFloors({
      reviewRound: 2,
      escalateFloors: true,
      // minConfidence must already match the round's 0.80 so effectiveChanged only measures severity.
      base: { minConfidence: 0.80, minSeverity: 'P1', categoryConfidence: {} },
    });
    expect(out.minSeverity).toBe('P1');
    expect(out.minConfidence).toBe(0.80);
    expect(out.effectiveChanged).toBe(false);
  });

  it('escalate_floors: false disables the round escalation entirely (D-12)', () => {
    const out = composeRoundFloors({
      reviewRound: 2,
      escalateFloors: false,
      base: { minConfidence: 0.7, minSeverity: 'nit', categoryConfidence: {} },
    });
    expect(out.minConfidence).toBe(0.7);
    expect(out.minSeverity).toBe('nit');
    expect(out.effectiveChanged).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// overlapsOpenThread + suppressByOpenThreads — RND-04.
// ───────────────────────────────────────────────────────────────────────────────────────

const thread = (over: Partial<VcsReviewThread>): VcsReviewThread => ({
  ref: 'PRRT_x',
  path: 'src/a.ts',
  lineStart: 10,
  lineEnd: 15,
  rootBody: '',
  outdated: false,
  ...over,
});

describe('overlapsOpenThread (RND-04)', () => {
  it('point inside inclusive range => true', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 12 }, thread({}))).toBe(true);
  });

  it('point on the inclusive boundary (lineStart) => true', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 10 }, thread({}))).toBe(true);
  });

  it('point on the inclusive boundary (lineEnd) => true', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 15 }, thread({}))).toBe(true);
  });

  it('point one below lineStart => false', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 9 }, thread({}))).toBe(false);
  });

  it('point one above lineEnd => false', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 16 }, thread({}))).toBe(false);
  });

  it('outdated thread => false (D-08)', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 12 }, thread({ outdated: true }))).toBe(false);
  });

  it('finding with null line => false (no current anchor)', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: null }, thread({}))).toBe(false);
  });

  it('finding with mismatched path => false', () => {
    expect(overlapsOpenThread({ path: 'src/b.ts', line: 12 }, thread({}))).toBe(false);
  });

  it('reversed range (lineEnd < lineStart) => false (defensive)', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 12 }, thread({ lineStart: 20, lineEnd: 5 }))).toBe(false);
  });

  it('lineStart <= 0 => false (defensive)', () => {
    expect(overlapsOpenThread({ path: 'src/a.ts', line: 12 }, thread({ lineStart: 0 }))).toBe(false);
  });
});

describe('suppressByOpenThreads (RND-04)', () => {
  it('returns survivors in original order + suppressed { finding, thread } pairs', () => {
    const findings = [
      { path: 'src/a.ts', line: 5, title: 'a' },
      { path: 'src/a.ts', line: 12, title: 'b' },
      { path: 'src/a.ts', line: 20, title: 'c' },
    ] as const;
    const { survivors, suppressed } = suppressByOpenThreads(
      findings as unknown as Array<{ path: string; line: number | null; title: string }>,
      [thread({})],
    );
    expect(survivors.map((f) => f.title)).toEqual(['a', 'c']);
    expect(suppressed.map((s) => s.finding.title)).toEqual(['b']);
    expect(suppressed[0].thread).toMatchObject({ ref: 'PRRT_x' });
  });

  it('no overlapping threads => survivors === input, suppressed === []', () => {
    const findings = [
      { path: 'src/a.ts', line: 5, title: 'a' },
    ] as unknown as Array<{ path: string; line: number | null; title: string }>;
    const { survivors, suppressed } = suppressByOpenThreads(findings, []);
    expect(survivors).toEqual(findings);
    expect(suppressed).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// Round audit-event builders (D-08 EXACT producer fields).
// ───────────────────────────────────────────────────────────────────────────────────────

describe('round audit-event builders', () => {
  const ts = '2026-01-01T00:00:00.000Z';

  it('buildRoundsDetectedEvent carries { mode, round, incremental, anchorSha, hasUnresolvedThreads, timestamp }', () => {
    const event = buildRoundsDetectedEvent({
      round: 3,
      mode: 'incremental',
      roundsIncremental: true,
      anchorSha: 'abc123',
      hasUnresolvedThreads: false,
    }, ts) as JobAuditEvent;
    expect(event).toEqual({
      stage: 'rounds.detected',
      round: 3,
      mode: 'incremental',
      incremental: true,
      anchorSha: 'abc123',
      hasUnresolvedThreads: false,
      timestamp: ts,
    });
  });

  it('buildRoundsNoChangesEvent carries the locked D-08 exact fields { from, to, round, incremental: true }', () => {
    const event = buildRoundsNoChangesEvent({
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      round: 2,
    }, ts) as JobAuditEvent;
    expect(event).toEqual({
      stage: 'rounds.no_changes',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      round: 2,
      incremental: true,
      timestamp: ts,
    });
  });

  it('buildRoundsAnchorSkippedEvent carries { reason, round?, timestamp }', () => {
    const event = buildRoundsAnchorSkippedEvent({ reason: 'empty_head', round: 3 }, ts) as JobAuditEvent;
    expect(event).toEqual({
      stage: 'rounds.anchor_skipped',
      reason: 'empty_head',
      round: 3,
      timestamp: ts,
    });
  });

  it('buildRoundsEscalatedEvent carries { from, to, effective, round, timestamp }', () => {
    const event = buildRoundsEscalatedEvent({
      from: { minConfidence: 0.7, minSeverity: 'nit' },
      to: { minConfidence: 0.8, minSeverity: 'P2' },
      effective: { minConfidence: 0.85, minSeverity: 'P2' },
      round: 3,
    }, ts) as JobAuditEvent;
    expect(event).toEqual({
      stage: 'rounds.escalated',
      from: { minConfidence: 0.7, minSeverity: 'nit' },
      to: { minConfidence: 0.8, minSeverity: 'P2' },
      effective: { minConfidence: 0.85, minSeverity: 'P2' },
      round: 3,
      timestamp: ts,
    });
  });

  it('buildRoundsSuppressedEvent carries { path, line, title, threadPath, timestamp } and NEVER thread body / ref', () => {
    const event = buildRoundsSuppressedEvent({
      finding: { path: 'src/a.ts', line: 12, title: 'overlap' },
      threadPath: 'src/a.ts',
    }, ts) as JobAuditEvent;
    expect(event).toEqual({
      stage: 'rounds.suppressed',
      path: 'src/a.ts',
      line: 12,
      title: 'overlap',
      threadPath: 'src/a.ts',
      timestamp: ts,
    });
    // Privacy (T-13-03-03): the producer MUST NOT leak the thread ref or body.
    expect(Object.keys(event)).not.toContain('ref');
    expect(Object.keys(event)).not.toContain('rootBody');
  });
});