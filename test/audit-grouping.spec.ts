import { describe, it, expect } from 'vitest';
import {
  groupAuditByStage,
  normalizeAuditDisplayStage,
  STAGE_ORDER,
} from '@client/lib/audit-grouping';
import { jobAuditEventSchema, type JobAuditEvent } from '@shared/schema';

// AUD-02 stable group-by-stage (Plan 16-02, Task 2) extended by Phases 18-19 — every
// `rounds.*` and `threads.*` sub-variant collapses to its normalized display group. Fixtures are minimal
// { stage, timestamp } objects cast through JobAuditEvent[] to keep them terse — the grouper only
// reads `.stage`.
const ev = (stage: JobAuditEvent['stage'], timestamp = '2026-01-01T00:00:00Z') =>
  ({ stage, timestamp } as unknown as JobAuditEvent);

describe('STAGE_ORDER', () => {
  it('is the fixed twenty-stage order including yaml_config_applied, yaml_config_head_ignored, agentic_context, learned_rule_suppressed, suggestion_dropped, rounds, threads, critic, ensemble, walkthrough, cross_file_security, inline_comment_skipped, and the `other` catch-all', () => {
    expect(STAGE_ORDER).toEqual([
      // WR-03 gave these two previously-homeless schema stages a display group.
      'yaml_config_parse_failed',
      // Phase 34 WR-03/WR-07 (34-REVIEW): the success-path config-resolution event, next to its
      // failure sibling.
      'yaml_config_applied',
      // quick-k31 (WR-03): the PR edited .review.yaml but config is read from the base branch, so
      // the edit was ignored for this review. Config resolution, hence next to its siblings.
      'yaml_config_head_ignored',
      'file_skipped',
      // Phase 35 (PRD-06, D-09): the bounded agentic-context pass runs BETWEEN prepare and review.
      // `file_skipped` is prepare-only (review.ts:1364) and `drafted` onward are review-time, so
      // this position is derived from execution order, not chosen.
      'agentic_context',
      'drafted',
      'severity_adjusted',
      'filtered',
      'deduped',
      'evidence_missing',
      // Phase 28 (LRN-01) inserted this between evidence_missing and rounds.
      'learned_rule_suppressed',
      // Phase 33 (PRD-02 / FR-153, D-08) inserted this after learned_rule_suppressed (index 7).
      'suggestion_dropped',
      'rounds',
      'threads',
      'critic',
      'ensemble',
      'walkthrough',
      'cross_file_security',
      // Phase 33 (PRD-01 / FR-031, D-03/D-04) appended this at the end.
      'inline_comment_skipped',
      // WR-03 catch-all, deliberately last.
      'other',
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

describe('normalizeAuditDisplayStage — Phase 24 D-01', () => {
  it('maps evidence_missing_summary to the synthetic `evidence_missing` display stage', () => {
    expect(normalizeAuditDisplayStage('evidence_missing_summary')).toBe('evidence_missing');
  });

  it('leaves existing non-prefixed stages unchanged — including evidence_missing itself', () => {
    expect(normalizeAuditDisplayStage('evidence_missing')).toBe('evidence_missing');
    expect(normalizeAuditDisplayStage('file_skipped')).toBe('file_skipped');
  });
});

describe('groupAuditByStage — Phase 24 D-01 / D-02', () => {
  it('produces an evidence_missing group for an evidence_missing_summary event and preserves its original stage', () => {
    const event = ev('evidence_missing_summary', '2026-01-01T00:00:01Z');
    const groups = groupAuditByStage([event]);
    const group = groups.find((g) => g.stage === 'evidence_missing');
    expect(group).toBeDefined();
    expect(group!.count).toBe(1);
    expect(group!.events.map((e) => e.stage)).toEqual(['evidence_missing_summary']);
  });

  it('groups legacy evidence_missing and evidence_missing_summary events together in one evidence_missing group', () => {
    const legacy = ev('evidence_missing', '2026-01-01T00:00:01Z');
    const summary = ev('evidence_missing_summary', '2026-01-01T00:00:02Z');
    const groups = groupAuditByStage([legacy, summary]);
    const group = groups.find((g) => g.stage === 'evidence_missing');
    expect(group).toBeDefined();
    expect(group!.count).toBe(2);
    expect(group!.events.map((e) => e.stage)).toEqual(['evidence_missing', 'evidence_missing_summary']);
  });
});

describe('Phase 28 (LRN-01) / G-28-4 — learned_rule_suppressed is its own display group', () => {
  // (a) PRIMARY DISCRIMINATOR. Proves the collapse branch is gone from the normalizer.
  // FAILS PRE-FIX: the pre-fix normalizer returned 'evidence_missing' for this stage.
  it('does not collapse learned_rule_suppressed into the evidence_missing display stage', () => {
    expect(normalizeAuditDisplayStage('learned_rule_suppressed')).toBe('learned_rule_suppressed');
  });

  // (b) BADGE HONESTY. The viewer renders each group's `count` as the group heading badge, so this
  // is the pure-function form of "Evidence missing: N is not inflated by suppressions".
  // FAILS PRE-FIX: pre-fix all three events land in ONE evidence_missing group of count 3, so both
  // the group count (1 vs 2) and the evidence count (3 vs 2) are wrong.
  it('keeps the evidence_missing count free of suppression events', () => {
    const legacy = ev('evidence_missing', '2026-01-01T00:00:01Z');
    const hardDropped = ev('evidence_hard_dropped', '2026-01-01T00:00:02Z');
    const suppressed = ev('learned_rule_suppressed', '2026-01-01T00:00:03Z');

    const groups = groupAuditByStage([legacy, hardDropped, suppressed]);

    expect(groups.map((g) => g.stage)).toEqual(['evidence_missing', 'learned_rule_suppressed']);

    const evidenceGroup = groups.find((g) => g.stage === 'evidence_missing')!;
    expect(evidenceGroup.count).toBe(2);
    expect(evidenceGroup.events.map((e) => e.stage)).toEqual([
      'evidence_missing',
      'evidence_hard_dropped',
    ]);

    const suppressionGroup = groups.find((g) => g.stage === 'learned_rule_suppressed')!;
    expect(suppressionGroup.count).toBe(1);
    expect(suppressionGroup.events).toEqual([suppressed]);
  });

  // (c) The STAGE_ORDER entry is LIVE (not dead code) and drives placement independent of arrival
  // order — input is deliberately REVERSED relative to STAGE_ORDER.
  // FAILS PRE-FIX: pre-fix both events collapse into a single evidence_missing group, so only one
  // stage comes back.
  it('emits the suppression group after evidence_missing regardless of arrival order', () => {
    const suppressed = ev('learned_rule_suppressed', '2026-01-01T00:00:01Z');
    const hardDropped = ev('evidence_hard_dropped', '2026-01-01T00:00:02Z');

    const groups = groupAuditByStage([suppressed, hardDropped]);

    expect(groups.map((g) => g.stage)).toEqual(['evidence_missing', 'learned_rule_suppressed']);
  });

  // (d) REGRESSION GUARD — NOT a discriminator: this passes both before AND after the fix. It
  // exists solely to catch an over-broad edit that strips the NEIGHBOURING collapse branches while
  // removing the Phase 28 one. Both of these must keep collapsing.
  it('still collapses evidence_hard_dropped and evidence_missing_summary into evidence_missing', () => {
    expect(normalizeAuditDisplayStage('evidence_hard_dropped')).toBe('evidence_missing');
    expect(normalizeAuditDisplayStage('evidence_missing_summary')).toBe('evidence_missing');
  });
});

describe('Phase 33 (PRD-01 / FR-031, D-03/D-04) — inline_comment_skipped is its own display group', () => {
  it('normalizes inline_comment_skipped to itself (own group, appended after walkthrough)', () => {
    expect(normalizeAuditDisplayStage('inline_comment_skipped')).toBe('inline_comment_skipped');
  });

  it('places the inline_comment_skipped group last, after walkthrough, regardless of arrival order', () => {
    const walkthrough = ev('walkthrough.enrichment', '2026-01-01T00:00:01Z');
    const skipped = ev('inline_comment_skipped', '2026-01-01T00:00:02Z');

    const groups = groupAuditByStage([skipped, walkthrough]);

    expect(groups.map((g) => g.stage)).toEqual(['walkthrough', 'inline_comment_skipped']);
    const skipGroup = groups.find((g) => g.stage === 'inline_comment_skipped')!;
    expect(skipGroup.count).toBe(1);
    expect(skipGroup.events).toEqual([skipped]);
  });
});

// WR-03: before the `other` catch-all existed, `normalizeAuditDisplayStage` ended in an unchecked
// `return stage as AuditDisplayStage`, so any schema stage missing from STAGE_ORDER produced a
// bucket the `STAGE_ORDER.filter(...)` in `groupAuditByStage` discarded without a trace — the
// viewer's header badge (job.audit.length) then disagreed with the sum of the rendered group
// counts. `cross_file_security` and `yaml_config_parse_failed` were both already in that state.
// These tests are the guard: adding a schema stage without giving it a display home now fails
// loudly here instead of silently vanishing at runtime.
describe('WR-03 — every schema audit stage has a display home', () => {
  // Derived from the schema itself (z.discriminatedUnion exposes `.options`), so a new variant is
  // picked up automatically and cannot be forgotten in a hand-maintained list.
  const SCHEMA_STAGES = jobAuditEventSchema.options.map(
    (option) => option.shape.stage.value as JobAuditEvent['stage'],
  );

  it('derives a non-empty stage list from jobAuditEventSchema', () => {
    expect(SCHEMA_STAGES.length).toBeGreaterThan(20);
  });

  it('normalizes every schema stage into a STAGE_ORDER entry', () => {
    for (const stage of SCHEMA_STAGES) {
      expect(STAGE_ORDER).toContain(normalizeAuditDisplayStage(stage));
    }
  });

  it('routes every schema stage into exactly one rendered group (no silent drops)', () => {
    const events = SCHEMA_STAGES.map((stage) => ev(stage));
    const groups = groupAuditByStage(events);
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(events.length);
  });

  it('no schema stage falls into the `other` catch-all (each has a dedicated group or collapse)', () => {
    const homeless = SCHEMA_STAGES.filter((stage) => normalizeAuditDisplayStage(stage) === 'other');
    expect(homeless).toEqual([]);
  });

  it('an unknown stage collapses to `other` rather than being discarded', () => {
    const unknown = ev('a_stage_that_does_not_exist_yet' as JobAuditEvent['stage']);
    const groups = groupAuditByStage([unknown]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stage).toBe('other');
    expect(groups[0].count).toBe(1);
  });
});

// Phase 35 (PRD-06, D-09) — the agentic_context display group.
//
// B-2 (35-UI-SPEC.md, raised by the kind correction on element E2): the contract asserts "at most
// one event per job" as a Task-3 EMISSION property, not as a rendered invariant, so nothing
// specified how the group reads at zero, or if re-entry / a future multi-emit ever produced 2+.
// All three counts are pinned here.
describe('Phase 35 (PRD-06, D-09) — agentic_context is its own display group', () => {
  it('normalizes agentic_context to itself — no normalizer branch, no `other` fallthrough', () => {
    // It is a single snake_case literal with a dedicated group, so the DISPLAY_STAGES pass-through
    // resolves it. A normalizer branch would be dead code; falling into `other` would bury a
    // designed stage in the catch-all for undesigned ones.
    expect(normalizeAuditDisplayStage('agentic_context')).toBe('agentic_context');
    expect(normalizeAuditDisplayStage('agentic_context')).not.toBe('other');
  });

  it('places the group after file_skipped and before drafted regardless of arrival order', () => {
    const drafted = ev('drafted', '2026-01-01T00:00:01Z');
    const agentic = ev('agentic_context', '2026-01-01T00:00:02Z');
    const fileSkipped = ev('file_skipped', '2026-01-01T00:00:03Z');

    const groups = groupAuditByStage([drafted, agentic, fileSkipped]);

    expect(groups.map((g) => g.stage)).toEqual(['file_skipped', 'agentic_context', 'drafted']);
  });

  // B-2 (i) — ZERO. The toggle-off run's correct UI is the ABSENCE of the group (NREG-01): no
  // empty-state copy, and the section's header badge (job.audit.length) is unchanged.
  it('B-2 zero: no agentic_context group at all when the stage emitted nothing', () => {
    const groups = groupAuditByStage([ev('drafted', '2026-01-01T00:00:01Z')]);
    expect(groups.find((g) => g.stage === 'agentic_context')).toBeUndefined();
    expect(groups.map((g) => g.stage)).not.toContain('agentic_context');
  });

  // B-2 (ii) — ONE. The normal toggle-on run: one group, count badge 1, one row.
  it('B-2 one: exactly one group holding one event, with count 1', () => {
    const agentic = ev('agentic_context', '2026-01-01T00:00:01Z');
    const groups = groupAuditByStage([agentic]);
    const group = groups.find((g) => g.stage === 'agentic_context');

    expect(group).toBeDefined();
    expect(group!.count).toBe(1);
    expect(group!.events).toEqual([agentic]);
  });

  // B-2 (iii) — TWO. Not producible today (Task 3 emits at most one per job and re-entry emits
  // none), but the grouper must not merge, drop or reorder if it ever were: the badge counts both
  // and the rows stack in timestamp order inside ONE group.
  it('B-2 two: one group holding BOTH events in timestamp order, badge counts both', () => {
    const first = ev('agentic_context', '2026-01-01T00:00:01Z');
    const second = ev('agentic_context', '2026-01-01T00:00:02Z');

    const groups = groupAuditByStage([first, second]);
    const agenticGroups = groups.filter((g) => g.stage === 'agentic_context');

    expect(agenticGroups).toHaveLength(1);
    expect(agenticGroups[0].count).toBe(2);
    expect(agenticGroups[0].events).toEqual([first, second]);
    expect(agenticGroups[0].events.map((e) => e.timestamp)).toEqual([
      '2026-01-01T00:00:01Z',
      '2026-01-01T00:00:02Z',
    ]);
  });
});

describe('Phase 33 (PRD-02 / FR-153, D-08) — suggestion_dropped is its own display group', () => {
  it('normalizes suggestion_dropped to itself (own group between learned_rule_suppressed and rounds)', () => {
    expect(normalizeAuditDisplayStage('suggestion_dropped')).toBe('suggestion_dropped');
  });

  it('orders the suggestion_dropped group between learned_rule_suppressed and rounds regardless of arrival order', () => {
    const suppressed = ev('learned_rule_suppressed', '2026-01-01T00:00:01Z');
    const dropped = ev('suggestion_dropped', '2026-01-01T00:00:02Z');
    const rounds = ev('rounds.detected', '2026-01-01T00:00:03Z');

    const groups = groupAuditByStage([rounds, dropped, suppressed]);

    expect(groups.map((g) => g.stage)).toEqual(['learned_rule_suppressed', 'suggestion_dropped', 'rounds']);
    const dropGroup = groups.find((g) => g.stage === 'suggestion_dropped')!;
    expect(dropGroup.count).toBe(1);
    expect(dropGroup.events).toEqual([dropped]);
  });
});
