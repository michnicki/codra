import type { AppBindings } from '@server/env';
import { appendJobAuditEvents } from '@server/db/jobs';
import type { CriticDecision, FileReviewPass, JobAuditEvent, ReviewSeverity } from '@shared/schema';
import type { FileSelectionResult } from './diff';
import type { DropRecord, NoiseFilterResult } from './noise-filter';
import type { EnsembleReconciliation } from './ensemble';
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

/**
 * PURE file-skip drop-event builder (PRIO-03 / D-11 / D-12). Maps the `selectReviewableFiles`
 * (core/diff.ts) drop metadata into the `file_skipped` audit variant — no I/O, never throws.
 * Emission rules:
 *   - generated: one PER-FILE `file_skipped` / `generated` event per dropped generated file
 *     (count:1, sample:[{ path }]). A generated file is a distinct low-volume drop reason, so it is
 *     surfaced individually rather than aggregated (D-12).
 *   - overCap: ONE aggregate `file_skipped` / `over_cap` event whose `count` is the COMPLETE
 *     overCap length (no dropped file is invisible in the aggregate) and whose `sample` is the FIRST
 *     20 of overCap. `selectReviewableFiles` already sorts overCap in descending-priority order, so
 *     the sample names the HIGHEST-PRIORITY OMITTED files — the near-miss files a reviewer most wants
 *     to know were dropped (RESEARCH Open-Q1 resolution, which SUPERSEDES CONTEXT D-12's imprecise
 *     "lowest-priority dropped files are named" phrasing; the two are reconciled here to the
 *     highest-priority-omitted interpretation). Sample bounded to ≤20 (FILT-04 reuse).
 *   - skip_glob is NEVER emitted (D-12): glob-skipped files are user-configured, expected, and would
 *     flood the 500-event ring buffer; they never enter selectReviewableFiles' drop metadata anyway.
 *
 * PRIVACY (T-15-05-01): a file identifier is `{ path }` ONLY — a skipped file has no finding line or
 * title, and no event ever carries body/diff/existingCode/codeSuggestion.
 */
export function buildFileSkipEvents(dropped: FileSelectionResult['dropped']): JobAuditEvent[] {
  const events: JobAuditEvent[] = [];
  const timestamp = new Date().toISOString();

  // One per-file event per generated file (low-volume, D-12): count:1, path-only sample.
  for (const file of dropped.generated) {
    events.push({
      stage: 'file_skipped',
      reason: 'generated',
      count: 1,
      sample: [{ path: file.path }],
      timestamp,
    });
  }

  // One bounded aggregate for the over-cap remainder (D-12). count = COMPLETE overCap length so the
  // aggregate visibility is total; sample = first 20 (highest-priority OMITTED, already ordered by the
  // selector) so the named files are the near-miss ones (RESEARCH Open-Q1, superseding D-12's phrasing).
  if (dropped.overCap.length > 0) {
    events.push({
      stage: 'file_skipped',
      reason: 'over_cap',
      count: dropped.overCap.length,
      sample: dropped.overCap.slice(0, 20).map((file) => ({ path: file.path })),
      timestamp,
    });
  }

  return events;
}

/**
 * Job-level file-skip recorder (PRIO-03 / D-12). A VERBATIM clone of `recordFinalizeDrops`: wraps a
 * SINGLE `appendJobAuditEvents` in try/catch, defensively stamps a timestamp on any event that arrived
 * without one, logs a failure via `logger.warn`, and NEVER rethrows — the audit trail is decision
 * telemetry, never a hard dependency of the prepare phase (T-15-05-02). A prepare run batches ALL its
 * file_skipped events into this one append. Do NOT reintroduce granular per-event recorders.
 */
export async function recordFileSkips(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record file-skip audit events for job ${jobId}`, error);
  }
}

/**
 * Phase 18 (RND-01..05): bounded best-effort recorder for the `rounds.*` audit variants.
 * `core/rounds.ts` builds typed events via the locked builder helpers (buildRoundsDetectedEvent
 * etc.) and the caller batches them into ONE `appendJobAuditEvents` call here. Mirrors
 * `recordFinalizeDrops` / `recordFileSkips` EXACTLY: try/catch, defensive timestamp stamping,
 * logs and NEVER rethrows. A broken round audit write must never fail the caller's review
 * (T-15-05-02 / D-13-03-04 carry-over posture).
 *
 * Producer discipline (D-08): rounds.* events carry the exact producer fields declared in
 * src/shared/schema.ts:jobAuditEventSchema — NEVER body / diff / existingCode / thread bodies
 * (T-13-03-03). The .passthrough() on each variant is additive-only and does not strip secrets;
 * producer construction is the privacy boundary, not the schema parser.
 */
export async function recordRoundAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record round audit events for job ${jobId}`, error);
  }
}

/**
 * Phase 19 (THR-01/THR-02, D-04): bounded best-effort recorder for the per-thread verify-fixes
 * audit variants (`threads.verified_fixed`, `threads.unfixed`, `threads.unverifiable`,
 * `threads.resolved`, `threads.resolve_failed`). Mirrors `recordRoundAudit` EXACTLY: try/catch,
 * defensive timestamp stamping, logs and NEVER rethrows. A broken verify-fixes audit write
 * must never fail the caller's review (T-19-01-02 carry-over posture).
 *
 * Each event carries ONLY the privacy-bounded identifier { threadRef, path, line, reason } +
 * verdict. NEVER the thread body, file content, prompt, or raw provider/model payload. The
 * `.passthrough()` on each `threads.*` schema variant is additive-only; producer construction
 * here is the privacy boundary.
 *
 * The caller (core/verify-fixes.ts runVerifyFixesPhase) batches up to 20 events per call so a
 * single batch's emission never approaches the 500-event ring buffer cap (T-19-01-02). The
 * `appendJobAuditEvents` helper itself applies the 500-event trim with `audit_truncated` flag,
 * so this recorder needs no additional cap.
 */
export async function recordVerifyFixesAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record verify-fixes audit events for job ${jobId}`, error);
  }
}

// ---------------------------------------------------------------------------
// Phase 19 (PASS-02) — bounded ensemble vote audit builder + best-effort recorder.
// ---------------------------------------------------------------------------

// Audit sample bounds — match the `ensemble.voted` schema's `.max(20)` limits and the
// `failedRunReasons` `.max(4)` cap (max four extra ensemble runs in any configuration).
const ENSEMBLE_WINNING_SAMPLE_CAP = 20;
const ENSEMBLE_DROPPED_SAMPLE_CAP = 20;
const ENSEMBLE_FAILED_RUN_REASONS_CAP = 4;

export type EnsembleVoteAuditEvent = Extract<JobAuditEvent, { stage: 'ensemble.voted' }>;

/**
 * PURE ensemble vote audit builder (PASS-02 / D-12). Derives one `ensemble.voted` event from a
 * single reconciliation result. Returns null when total runs <= 1 so the inert D-13 (runs:1)
 * path emits ZERO Phase-19 ensemble audit events (NREG-01 — this mirrors the existing
 * `deduped`/`file_skipped` builders which also guard against empty input).
 *
 * Bounded samples (T-19-05-01): winningSample and droppedSample are independently sliced to
 * <=20 so a single file with a large cluster set cannot flood the 500-event ring buffer.
 * failedRunReasons are machine strings only (never raw provider response bodies) and are
 * capped at 4 (the configured max number of extra runs).
 */
export function buildEnsembleVoteAuditEvent(
  file: string,
  reconciliation: EnsembleReconciliation,
  failedRunReasons: readonly string[] = [],
): EnsembleVoteAuditEvent | null {
  const totalRuns = reconciliation.successfulRuns + reconciliation.failedRuns;
  if (totalRuns <= 1) return null;

  const winningSample = reconciliation.winners
    .slice(0, ENSEMBLE_WINNING_SAMPLE_CAP)
    .map(({ cluster, finding }) => ({
      clusterId: cluster.id,
      votes: cluster.voters.length,
      path: finding.path,
      line: finding.line ?? null,
      title: finding.title.slice(0, 200),
    }));

  const droppedSample = reconciliation.droppedClusters
    .slice(0, ENSEMBLE_DROPPED_SAMPLE_CAP)
    .map((cluster) => {
      // Deterministic first member's path/line/title for the sample (privacy-bounded identifier).
      const sample = cluster.members[0]?.finding;
      return {
        clusterId: cluster.id,
        votes: cluster.voters.length,
        path: sample?.path ?? '',
        line: sample?.line ?? null,
        title: (sample?.title ?? '').slice(0, 200),
      };
    });

  return {
    stage: 'ensemble.voted',
    file,
    requestedRuns: totalRuns,
    successfulRuns: reconciliation.successfulRuns,
    failedRuns: reconciliation.failedRuns,
    winnerCount: reconciliation.winners.length,
    droppedClusterCount: reconciliation.droppedClusters.length,
    winningSample,
    droppedSample,
    failedRunReasons: failedRunReasons.slice(0, ENSEMBLE_FAILED_RUN_REASONS_CAP),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Phase 19 (PASS-02): bounded best-effort recorder for the `ensemble.voted` audit variant.
 * Mirrors `recordRoundAudit` / `recordVerifyFixesAudit` EXACTLY: try/catch, defensive timestamp
 * stamping, logs and NEVER rethrows. A broken ensemble audit write must never fail the caller's
 * review (T-19-05-01 / D-13-03-04 carry-over posture).
 *
 * The builder is pure and short-circuits to null for runs <= 1 (D-13 inert), so the recorder's
 * no-op path handles both the no-events case and the broken-DB case identically. The producer
 * (core/ensemble.ts via review.ts) owns the privacy boundary — events only carry the
 * { clusterId, votes, path, line, title } sample shape plus failed-run machine reasons; never
 * raw provider/model payloads.
 */
export async function recordEnsembleAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    if (events.length === 0) return; // nothing to append — never produce an inert event row.
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record ensemble audit events for job ${jobId}`, error);
  }
}

// ---------------------------------------------------------------------------
// Phase 19 (PASS-01) — bounded critic-decisions audit builder + best-effort recorder.
//
// One aggregate `critic.decisions` event per persisted critic run. The canonical decisions array
// lives on jobs.critic_result; the audit receives a privacy-bounded sample (max 20 rows) so a
// huge candidate set cannot flood the 500-event ring buffer or duplicate full finding bodies.
// ---------------------------------------------------------------------------

const CRITIC_DECISION_SAMPLE_CAP = 20;

export type CriticDecisionsAuditEvent = Extract<JobAuditEvent, { stage: 'critic.decisions' }>;

/**
 * PURE critic-decisions audit builder (PASS-01 / D-05). Derives ONE `critic.decisions` event
 * from the canonical decisions array, refusing to duplicate body/evidence content. The sample
 * is always sliced to the bounded cap (max 20) so a 200-candidate set still produces a single
 * audit row whose sample merely names the bounded milestones.
 *
 * Returns null when the input decisions array is empty so the inert critic-off / empty-input
 * paths emit ZERO Phase-19 critic audit events (NREG-01 — mirrors the ensemble / file_skipped
 * builders).
 */
export function buildCriticDecisionsAuditEvent(
  decisions: CriticDecision[],
  status: 'completed' | 'skipped' | 'fail_open',
  reason?: string,
): CriticDecisionsAuditEvent | null {
  if (decisions.length === 0) return null;
  const sample = decisions.slice(0, CRITIC_DECISION_SAMPLE_CAP).map((d) => ({
    id: d.id,
    path: d.path,
    line: d.line ?? null,
    title: d.title,
    verdict: d.verdict,
    outcome: d.outcome,
    reason: d.reason,
  }));
  return {
    stage: 'critic.decisions',
    status,
    count: decisions.length,
    reason,
    sample,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Phase 19 (PASS-01): bounded best-effort recorder for the `critic.decisions` audit variant.
 * Mirrors `recordEnsembleAudit` EXACTLY: try/catch, defensive timestamp stamping, logs and
 * NEVER rethrows. A broken critic audit write must never fail the caller's review (D-13-03-04
 * carry-over posture).
 *
 * The builder is pure and short-circuits to null for empty decisions (D-06 inert), so the
 * recorder's no-op path handles both the no-events case and the broken-DB case identically. The
 * producer (review.ts::runCriticPhase) owns the privacy boundary — events only carry the
 * { id, path, line, title, verdict, outcome, reason } sample shape, never raw finding bodies.
 */
export async function recordCriticAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    if (events.length === 0) return; // nothing to append — never produce an inert event row.
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record critic audit events for job ${jobId}`, error);
  }
}
