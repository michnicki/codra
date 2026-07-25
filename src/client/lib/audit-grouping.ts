// AUD-02 audit trail grouping (Plan 16-02, Task 2) extended by Phase 18 (RND-01..05).
//
// Pure helper consumed by AuditTrailViewer in Plan 16-06. No React/DOM imports so the ordering /
// stability / empty-input contract is node-testable without the blocked browser env.
import type { JobAuditEvent } from '@shared/schema';

// D-09: the fixed display order for stage groups. Matches the pipeline's logical stage progression
// (file selection -> drafting -> severity adjustment -> noise filter -> dedup -> evidence gate ->
// rounds -> thread verification -> critic -> ensemble -> walkthrough). Phase 18 adds `rounds`;
// Phase 19 adds one normalized `threads` group for every `threads.*` verdict/resolution event and a
// `critic` group for the canonical critic-decisions audit event. Phase 20 (D-01 / D-06 amended)
// adds `ensemble` (one per `ensemble.voted` event) and `walkthrough` (one per `walkthrough.enrichment`
// event).
export const STAGE_ORDER = [
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
] as const;

/**
 * Phase 18 (RND-01..05): the VIEWER-facing display stage. Distinct from the event's
 * `stage` field — every `rounds.*` sub-variant maps to the SAME `rounds` group so a single
 * `DecisionGroup` shell renders all five variants. Adding a new `rounds.*` event in a future
 * phase needs ZERO viewer changes: just normalize the new stage via `normalizeAuditDisplayStage`
 * and it lands in the `rounds` group. The original `event.stage` is preserved on each event so
 * the viewer / future per-variant switch can still distinguish them.
 *
 * Phase 24: the synthetic `evidence_missing` display group now also covers
 * `evidence_missing_summary` aggregate events alongside the legacy per-finding
 * `evidence_missing` events.
 *
 * Closed union matching STAGE_ORDER. Non-round stages pass through unchanged.
 */
export type AuditDisplayStage = typeof STAGE_ORDER[number];

/**
 * Phase 18 (D-08 / Codex HIGH review): the synthetic `rounds` display group cannot match
 * `rounds.detected` / `rounds.no_changes` / `rounds.anchor_skipped` / `rounds.escalated` /
 * `rounds.suppressed` events under an exact `event.stage` comparison (the original grouping code
 * compared exact values against STAGE_ORDER and the synthetic display name would not match any of
 * the real stages). This normalizer collapses EVERY `rounds.*` sub-variant to the single
 * `rounds` display stage while leaving non-round stages unchanged. The audit-trail viewer
 * (Phase 16-06) renders ALL rounds events under one `Rounds` group.
 *
 * Phase 19 (PASS-01 / D-05): the synthetic `critic` display group covers the single
 * `critic.decisions` aggregate event. The canonical decisions array lives on jobs.critic_result;
 * the audit receives only a bounded sample so the viewer can show the same outcome/reason
 * pattern for the audited rows.
 *
 * Phase 20 (D-01 / D-06 amended): the synthetic `ensemble` display group covers the single
 * `ensemble.voted` aggregate event, and the synthetic `walkthrough` display group covers the
 * single `walkthrough.enrichment` aggregate event. Both literals are the schema-authoritative
 * phase-19 event names — they are mapped to a synthetic display stage so the `groupAuditByStage`
 * filter (which iterates over STAGE_ORDER) and the `DecisionEvent` renderer (which switches on the
 * event's stage) can route them through the same machinery as the existing synthetic groups.
 */
export function normalizeAuditDisplayStage(stage: JobAuditEvent['stage']): AuditDisplayStage {
  if (stage.startsWith('rounds.')) return 'rounds';
  if (stage.startsWith('threads.')) return 'threads';
  if (stage === 'critic.decisions') return 'critic';
  if (stage === 'ensemble.voted') return 'ensemble';
  if (stage === 'walkthrough.enrichment') return 'walkthrough';
  // Phase 24: evidence_missing_summary maps to the existing evidence_missing display stage
  // so the aggregate event lands in the same Evidence missing group as legacy per-finding events.
  if (stage === 'evidence_missing_summary') return 'evidence_missing';
  return stage as AuditDisplayStage;
}

export interface AuditStageGroup {
  stage: AuditDisplayStage;
  events: JobAuditEvent[];
  count: number;
}

// Group audit events by DISPLAY stage in the fixed STAGE_ORDER, preserving each event's original
// insertion order WITHIN its stage group (stable — two same-stage events never merge). The
// display stage is derived via `normalizeAuditDisplayStage` so every `rounds.*` sub-variant lands
// in one normalized `rounds` group while retaining its ORIGINAL `event.stage` field on each event.
// Absent stages produce no group; an empty input returns [] so the viewer renders the neutral
// 'No audit events' line.
export function groupAuditByStage(events: JobAuditEvent[]): AuditStageGroup[] {
  const buckets = new Map<AuditDisplayStage, JobAuditEvent[]>();
  for (const event of events) {
    const displayStage = normalizeAuditDisplayStage(event.stage);
    const bucket = buckets.get(displayStage);
    if (bucket) {
      bucket.push(event);
    } else {
      buckets.set(displayStage, [event]);
    }
  }
  return STAGE_ORDER.filter((stage) => buckets.has(stage)).map((stage) => {
    const stageEvents = buckets.get(stage)!;
    return { stage, events: stageEvents, count: stageEvents.length };
  });
}