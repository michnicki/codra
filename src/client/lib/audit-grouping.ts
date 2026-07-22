// AUD-02 audit trail grouping (Plan 16-02, Task 2).
//
// Pure helper consumed by AuditTrailViewer in Plan 16-06. No React/DOM imports so the ordering /
// stability / empty-input contract is node-testable without the blocked browser env.
import type { JobAuditEvent } from '@shared/schema';

// D-09: the fixed display order for stage groups. Matches the pipeline's logical stage progression
// (file selection -> drafting -> severity adjustment -> noise filter -> dedup -> evidence gate).
export const STAGE_ORDER = [
  'file_skipped',
  'drafted',
  'severity_adjusted',
  'filtered',
  'deduped',
  'evidence_missing',
] as const;

export interface AuditStageGroup {
  stage: JobAuditEvent['stage'];
  events: JobAuditEvent[];
  count: number;
}

// Group audit events by stage in the fixed STAGE_ORDER, preserving each event's original insertion
// order WITHIN its stage group (stable — two same-stage events never merge). Absent stages produce
// no group; an empty input returns [] so the viewer renders the neutral 'No audit events' line.
export function groupAuditByStage(events: JobAuditEvent[]): AuditStageGroup[] {
  const buckets = new Map<JobAuditEvent['stage'], JobAuditEvent[]>();
  for (const event of events) {
    const bucket = buckets.get(event.stage);
    if (bucket) {
      bucket.push(event);
    } else {
      buckets.set(event.stage, [event]);
    }
  }
  return STAGE_ORDER.filter((stage) => buckets.has(stage)).map((stage) => {
    const stageEvents = buckets.get(stage)!;
    return { stage, events: stageEvents, count: stageEvents.length };
  });
}
