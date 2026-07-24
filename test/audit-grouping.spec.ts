import { describe, it, expect } from 'vitest';
import {
  groupAuditByStage,
  normalizeAuditDisplayStage,
  STAGE_ORDER,
} from '@client/lib/audit-grouping';
import type { JobAuditEvent } from '@shared/schema';

// AUD-02 stable group-by-stage (Plan 16-02, Task 2) extended by Phases 18-19 — every
// `rounds.*` and `threads.*` sub-variant collapses to its normalized display group. Fixtures are minimal
// { stage, timestamp } objects cast through JobAuditEvent[] to keep them terse — the grouper only
// reads `.stage`.
const ev = (stage: JobAuditEvent['stage'], timestamp = '2026-01-01T00:00:00Z') =>
  ({ stage, timestamp } as unknown as JobAuditEvent);

describe('STAGE_ORDER', () => {
  it('is the fixed eleven-stage order including rounds, threads, critic, ensemble, and walkthrough', () => {
    expect(STAGE_ORDER).toEqual([
      'file_skipped',
      'drafted',
      'severity_adjusted',
      'filtered',
      'deduped',
      'evidence_missing',
      'rounds',
      'threads',
      'critic',
      'ensemble',
      'walkthrough',
    ]);
  });
});

describe('groupAuditByStage', () => {
  it('returns [] on empty input so the viewer renders the neutral line', () => {
    expect(groupAuditByStage([])).toEqual([]);
  });

  it('orders present groups by STAGE_ORDER and omits absent stages', () => {
    const drafted1 = ev('drafted', '2026-01-01T00:00:01Z');
    const filtered1 = ev('filtered', '2026-01-01T00:00:02Z');
    const drafted2 = ev('drafted', '2026-01-01T00:00:03Z');

    const groups = groupAuditByStage([drafted1, filtered1, drafted2]);

    // Order follows STAGE_ORDER (drafted before filtered), and no empty groups appear.
    expect(groups.map((g) => g.stage)).toEqual(['drafted', 'filtered']);
  });

  it('keeps two same-stage events as distinct entries in original order (stable, never merged)', () => {
    const drafted1 = ev('drafted', '2026-01-01T00:00:01Z');
    const filtered1 = ev('filtered', '2026-01-01T00:00:02Z');
    const drafted2 = ev('drafted', '2026-01-01T00:00:03Z');

    const groups = groupAuditByStage([drafted1, filtered1, drafted2]);
    const draftedGroup = groups.find((g) => g.stage === 'drafted')!;

    expect(draftedGroup.count).toBe(2);
    expect(draftedGroup.events).toEqual([drafted1, drafted2]);
  });
});

describe('normalizeAuditDisplayStage — Phase 18 RND-01..05', () => {
  it('maps every rounds.* sub-variant to the single `rounds` display stage', () => {
    expect(normalizeAuditDisplayStage('rounds.detected')).toBe('rounds');
    expect(normalizeAuditDisplayStage('rounds.no_changes')).toBe('rounds');
    expect(normalizeAuditDisplayStage('rounds.anchor_skipped')).toBe('rounds');
    expect(normalizeAuditDisplayStage('rounds.escalated')).toBe('rounds');
    expect(normalizeAuditDisplayStage('rounds.suppressed')).toBe('rounds');
  });

  it('maps every threads.* sub-variant to the single `threads` display stage', () => {
    expect(normalizeAuditDisplayStage('threads.verified_fixed')).toBe('threads');
    expect(normalizeAuditDisplayStage('threads.unfixed')).toBe('threads');
    expect(normalizeAuditDisplayStage('threads.unverifiable')).toBe('threads');
    expect(normalizeAuditDisplayStage('threads.resolved')).toBe('threads');
    expect(normalizeAuditDisplayStage('threads.resolve_failed')).toBe('threads');
  });

  it('passes non-prefixed stages through unchanged', () => {
    expect(normalizeAuditDisplayStage('file_skipped')).toBe('file_skipped');
    expect(normalizeAuditDisplayStage('drafted')).toBe('drafted');
    expect(normalizeAuditDisplayStage('severity_adjusted')).toBe('severity_adjusted');
    expect(normalizeAuditDisplayStage('filtered')).toBe('filtered');
    expect(normalizeAuditDisplayStage('deduped')).toBe('deduped');
    expect(normalizeAuditDisplayStage('evidence_missing')).toBe('evidence_missing');
  });
});

describe('normalizeAuditDisplayStage — Phase 20 D-01 / D-06 amended', () => {
  it('maps ensemble.voted to the synthetic `ensemble` display stage', () => {
    expect(normalizeAuditDisplayStage('ensemble.voted')).toBe('ensemble');
  });

  it('maps the schema-authoritative literal walkthrough.enrichment to the synthetic `walkthrough` display stage', () => {
    expect(normalizeAuditDisplayStage('walkthrough.enrichment')).toBe('walkthrough');
  });
});

describe('groupAuditByStage — Phase 20 D-01 / D-06 amended', () => {
  it('produces an ensemble group for an ensemble.voted event and preserves its original stage', () => {
    const event = ev('ensemble.voted', '2026-01-01T00:00:01Z');
    const groups = groupAuditByStage([event]);
    const ensembleGroup = groups.find((g) => g.stage === 'ensemble');
    expect(ensembleGroup).toBeDefined();
    expect(ensembleGroup!.count).toBe(1);
    expect(ensembleGroup!.events.map((e) => e.stage)).toEqual(['ensemble.voted']);
  });

  it('produces a walkthrough group for a walkthrough.enrichment event and preserves its original stage', () => {
    const event = ev('walkthrough.enrichment', '2026-01-01T00:00:01Z');
    const groups = groupAuditByStage([event]);
    const walkthroughGroup = groups.find((g) => g.stage === 'walkthrough');
    expect(walkthroughGroup).toBeDefined();
    expect(walkthroughGroup!.count).toBe(1);
    expect(walkthroughGroup!.events.map((e) => e.stage)).toEqual(['walkthrough.enrichment']);
  });

  it('emits ensemble and walkthrough groups in order after critic when the input is mixed', () => {
    const critic = ev('critic.decisions', '2026-01-01T00:00:01Z');
    const ensemble = ev('ensemble.voted', '2026-01-01T00:00:02Z');
    const walkthrough = ev('walkthrough.enrichment', '2026-01-01T00:00:03Z');

    const groups = groupAuditByStage([critic, ensemble, walkthrough]);

    expect(groups.map((g) => g.stage)).toEqual(['critic', 'ensemble', 'walkthrough']);
  });
});

describe('groupAuditByStage — Phase 18 rounds display group', () => {
  it('renders all five rounds.* variants in one normalized Rounds group with original event order', () => {
    const detected = ev('rounds.detected', '2026-01-01T00:00:01Z');
    const noChanges = ev('rounds.no_changes', '2026-01-01T00:00:02Z');
    const anchorSkipped = ev('rounds.anchor_skipped', '2026-01-01T00:00:03Z');
    const escalated = ev('rounds.escalated', '2026-01-01T00:00:04Z');
    const suppressed = ev('rounds.suppressed', '2026-01-01T00:00:05Z');

    const groups = groupAuditByStage([detected, noChanges, anchorSkipped, escalated, suppressed]);

    const roundsGroup = groups.find((g) => g.stage === 'rounds');
    expect(roundsGroup).toBeDefined();
    expect(roundsGroup!.count).toBe(5);
    // The original sub-stage is preserved on each event for per-row renderer branching.
    expect(roundsGroup!.events.map((e) => e.stage)).toEqual([
      'rounds.detected',
      'rounds.no_changes',
      'rounds.anchor_skipped',
      'rounds.escalated',
      'rounds.suppressed',
    ]);
  });

  it('renders mixed-stage input with the rounds group alongside other stages', () => {
    const drafted1 = ev('drafted', '2026-01-01T00:00:01Z');
    const detected = ev('rounds.detected', '2026-01-01T00:00:02Z');
    const filtered1 = ev('filtered', '2026-01-01T00:00:03Z');
    const escalated = ev('rounds.escalated', '2026-01-01T00:00:04Z');

    const groups = groupAuditByStage([drafted1, detected, filtered1, escalated]);

    expect(groups.map((g) => g.stage)).toEqual(['drafted', 'filtered', 'rounds']);
    const roundsGroup = groups.find((g) => g.stage === 'rounds')!;
    expect(roundsGroup.count).toBe(2);
    expect(roundsGroup.events.map((e) => e.stage)).toEqual(['rounds.detected', 'rounds.escalated']);
  });
});
