import type { AppBindings } from '@server/env';
import { appendJobAuditEvents } from '@server/db/jobs';
import type { FileReviewPass, JobAuditEvent, ReviewSeverity } from '@shared/schema';
import type { DropRecord, NoiseFilterResult } from './noise-filter';
import { logger } from './logger';

/**
 * AUD-01 audit-trail recorder. A SINGLE best-effort recorder for one completed (file, pass) review
 * unit: it builds the `drafted` event (D-10), concatenates any `severity_adjusted` events the severity
 * engine produced for that unit, and issues EXACTLY ONE `appendJobAuditEvents` call.
 *
 * One combined append per unit (review fix — Codex HIGH): the earlier draft planned two separate
 * recorder functions (drafted + severity), which would have cost two DB writes per completed unit and
 * broken the pinned Cloudflare subrequest budget (re-derived in Plan 13-04). Collapsing them into one
 * recorder that batches all of a unit's events into a single append keeps the cost at exactly one
 * extra DB write per unit. Do NOT reintroduce granular per-event recorder functions here.
 *
 * BEST-EFFORT / non-blocking (must_haves.prohibitions safety item; threat T-13-03-04, review finding
 * #7): the audit trail is decision telemetry, never a hard dependency of a completed review. The
 * single append is wrapped in try/catch and a failure is logged via `logger.warn` — it NEVER rethrows
 * into the caller, so a broken/slow audit write can never fail, block, or roll back the underlying
 * file-review persist or the review job. This mirrors the codebase's established best-effort-
 * maintenance convention (core/job-recovery.ts) and the critic_result fail-soft read posture. The
 * function still returns its (caught) promise so a caller MAY `await` it for ordering, but a rejection
 * never propagates. Callers wire this in Plan 13-04 after every successful file-review persist.
 */
export async function recordUnitAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  file: string,
  pass: FileReviewPass,
  severityAuditEvents?: JobAuditEvent[],
): Promise<void> {
  try {
    // D-10: the per-unit `drafted` event. Only the rule/pass/file/timestamp shape is persisted —
    // never raw finding body/title/diff content (must_haves.prohibitions privacy item, T-13-03-03).
    const draftedEvent: JobAuditEvent = {
      stage: 'drafted',
      file,
      pass,
      timestamp: new Date().toISOString(),
    };

    // Concatenate the severity-engine events (D-09) for this same unit. undefined/empty means no extra
    // events. Defensively stamp a timestamp on any severity event that arrived without one so every
    // stored event satisfies jobAuditEventSchema's required `timestamp`.
    const severityEvents = (severityAuditEvents ?? []).map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );

    // EXACTLY ONE append per unit (the drafted event plus any severity events, in that order).
    await appendJobAuditEvents(env, jobId, [draftedEvent, ...severityEvents]);
  } catch (error) {
    // Best-effort: log and continue. A failed audit write must never fail the caller's review.
    logger.warn(`Failed to record audit events for job ${jobId} (file=${file}, pass=${pass})`, error);
  }
}

/**
 * Clamp an audit title to at most 100 chars at the WRITE boundary (Codex LOW / T-14-02-01):
 * `parsedReviewCommentSchema.title` is unbounded (`min(1)` only), so nothing upstream guarantees a
 * length cap. Do NOT rely on an upstream 100-cap — every persisted audit identifier passes through here.
 */
export function clampAuditTitle(title: string): string {
  return title.slice(0, 100);
}

/**
 * Project any finding-shaped record to the privacy-bounded audit identifier { path, line, title }
 * (T-14-02-01) — the ONLY finding fields that ever reach persisted audit events. Titles are clamped
 * to <=100 chars via `clampAuditTitle`. NEVER carries body/diff/existingCode/codeSuggestion.
 */
export function toAuditIdentifier(record: {
  path: string;
  line?: number | null;
  title: string;
}): { path: string; line: number | null; title: string } {
  return { path: record.path, line: record.line ?? null, title: clampAuditTitle(record.title) };
}

/**
 * PURE finalize drop-event builder (FILT-04 / D-07). Maps a `NoiseFilterResult['dropped']` into the
 * `filtered` / `deduped` audit variants — no I/O, never throws. Emission rules:
 *   - confidenceFloor: GROUP records by their `effectiveFloor` and emit ONE `filtered` /
 *     `confidence_floor` event PER DISTINCT effective floor (review finding #2 — a security group
 *     dropped at 0.85 and a global group dropped at 0.7 are two events with correct per-group
 *     thresholds, never one mislabeled 0.7). Each sample entry carries { path, line, title, category,
 *     confidence } — the identifier plus the finding's own values that fell below the floor (#4).
 *   - severityFloor: ONE `filtered` / `severity_floor` event; threshold = the min_severity band; each
 *     sample entry carries { path, line, title, severity }.
 *   - cap: ONE `filtered` / `cap` event; threshold = the effectiveMaxComments integer; each sample
 *     entry carries { path, line, title, severity }.
 *   - Every sample array is sliced to at most 20 entries (bounded — T-14-02-02).
 *   - merges: ONE `deduped` event per merge carrying survivor/suppressed (via toAuditIdentifier) and
 *     the MergeRecord's titleSimilarity/bodySimilarity (#4).
 *
 * Because the confidence `threshold` is derived per-record from `effectiveFloor`, the caller (14-03)
 * does NOT pass a global confidence floor — `thresholds` is only { severityFloor, cap }. No event ever
 * carries body/diff/existingCode/codeSuggestion (T-14-02-01).
 */
export function buildFinalizeDropEvents(
  dropped: NoiseFilterResult['dropped'],
  thresholds: { severityFloor: ReviewSeverity; cap: number },
): JobAuditEvent[] {
  const events: JobAuditEvent[] = [];
  const timestamp = new Date().toISOString();

  // confidence_floor: one event per distinct effective floor (review finding #2). Map preserves
  // first-seen insertion order so the emitted events are deterministic.
  const byFloor = new Map<number, DropRecord[]>();
  for (const rec of dropped.confidenceFloor) {
    const floor = rec.effectiveFloor ?? 0;
    const group = byFloor.get(floor);
    if (group) group.push(rec);
    else byFloor.set(floor, [rec]);
  }
  for (const [floor, records] of byFloor) {
    events.push({
      stage: 'filtered',
      rule: 'confidence_floor',
      count: records.length,
      threshold: floor,
      sample: records.slice(0, 20).map((r) => ({
        ...toAuditIdentifier(r),
        category: r.category,
        confidence: r.confidence,
      })),
      timestamp,
    });
  }

  if (dropped.severityFloor.length > 0) {
    events.push({
      stage: 'filtered',
      rule: 'severity_floor',
      count: dropped.severityFloor.length,
      threshold: thresholds.severityFloor,
      sample: dropped.severityFloor.slice(0, 20).map((r) => ({
        ...toAuditIdentifier(r),
        severity: r.severity,
      })),
      timestamp,
    });
  }

  if (dropped.cap.length > 0) {
    events.push({
      stage: 'filtered',
      rule: 'cap',
      count: dropped.cap.length,
      threshold: thresholds.cap,
      sample: dropped.cap.slice(0, 20).map((r) => ({
        ...toAuditIdentifier(r),
        severity: r.severity,
      })),
      timestamp,
    });
  }

  for (const merge of dropped.merges) {
    events.push({
      stage: 'deduped',
      rule: merge.rule,
      survivor: toAuditIdentifier(merge.survivor),
      suppressed: toAuditIdentifier(merge.suppressed),
      titleSimilarity: merge.titleSimilarity,
      bodySimilarity: merge.bodySimilarity,
      timestamp,
    });
  }

  return events;
}

/**
 * Job-level finalize drop recorder (D-08). Mirrors `recordUnitAudit` EXACTLY: wraps a SINGLE
 * `appendJobAuditEvents` in try/catch, logs a failure via `logger.warn`, and NEVER rethrows — the
 * audit trail is decision telemetry, never a hard dependency of a completed review (T-14-02-03). A
 * finalize run batches ALL its drop events into this one append (D-08 — recordUnitAudit is unit-keyed
 * and does not fit). Defensively stamps a timestamp on any event that arrived without one. Do NOT
 * reintroduce granular per-event recorders (the recordUnitAudit anti-pattern note applies here too).
 */
export async function recordFinalizeDrops(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    // EXACTLY ONE append for the whole finalize run (a single oversized append can itself truncate +
    // set audit_truncated — accepted per review finding #9, still subrequest-budget safe).
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record finalize drop audit events for job ${jobId}`, error);
  }
}
