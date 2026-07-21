import type { AppBindings } from '@server/env';
import { appendJobAuditEvents } from '@server/db/jobs';
import type { FileReviewPass, JobAuditEvent } from '@shared/schema';
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
