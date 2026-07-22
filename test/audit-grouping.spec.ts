import { describe, it, expect } from 'vitest';
import { groupAuditByStage, STAGE_ORDER } from '@client/lib/audit-grouping';
import type { JobAuditEvent } from '@shared/schema';

// AUD-02 stable group-by-stage (Plan 16-02, Task 2). Pure helper consumed by AuditTrailViewer in
// Plan 16-06. Fixtures are minimal { stage, timestamp } objects cast through JobAuditEvent[] to keep
// them terse — the grouper only reads `.stage`.
const ev = (stage: JobAuditEvent['stage'], timestamp = '2026-01-01T00:00:00Z') =>
  ({ stage, timestamp } as unknown as JobAuditEvent);

describe('STAGE_ORDER', () => {
  it('is the fixed six-stage order', () => {
    expect(STAGE_ORDER).toEqual([
      'file_skipped',
      'drafted',
      'severity_adjusted',
      'filtered',
      'deduped',
      'evidence_missing',
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
