import type { AppBindings } from '@server/env';
import { appendJobAuditEvents } from '@server/db/jobs';
import type { CriticDecision, FileReviewPass, JobAuditEvent, ReviewSeverity } from '@shared/schema';
import type { FileSelectionResult } from './diff';
import type { DropRecord, NoiseFilterResult } from './noise-filter';
import type { EnsembleReconciliation } from './ensemble';
import type { EvidenceDropEntry } from './evidence';
import type { LearnedRuleSuppressionEntry } from './learned-rules';
import { logger, scrubEmbeddedSecrets } from './logger';
import { MACHINE_ERROR_REASONS, redactFindingTitle } from './audit-redact';
// PRD-06: the loop's own closed stop-reason union is imported as a VALUE, not re-typed by hand, so
// the agentic audit vocabulary below widens automatically when a stop reason is added and cannot
// drift out of sync with the thing it describes. No cycle: `core/agentic-tools` imports only zod,
// picomatch, the prompt module and erased `import type`s — nothing that reaches back here.
import { agenticStopReasons } from './agentic-tools';

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
 * @deprecated Phase 20.1 BLOCKER 1 (D-06): the legacy `clampAuditTitle` is no longer the privacy
 * boundary. It permitted arbitrary titles to leak through to the audit trail up to 100 chars. The
 * producer-side enforcement is now `redactFindingTitle` (./audit-redact), which not only caps the
 * length but also wraps over-length titles in a fixed-shape marker so the persisted audit trail is
 * bounded to a recognizable clamp shape. This deprecation shim is retained for any external caller
 * that still imports the symbol; it delegates to the new redactor so the two helpers always agree
 * on the shape. New code MUST use `redactFindingTitle` directly.
 */
export function clampAuditTitle(title: string): string {
  return redactFindingTitle(title);
}

/**
 * Project any finding-shaped record to the privacy-bounded audit identifier { path, line, title }
 * (T-14-02-01) — the ONLY finding fields that ever reach persisted audit events. Titles are passed
 * through `redactFindingTitle` (D-06) which caps at 100 chars and wraps over-length input in a
 * fixed-shape marker. NEVER carries body/diff/existingCode/codeSuggestion.
 */
export function toAuditIdentifier(record: {
  path: string;
  line?: number | null;
  title: string;
}): { path: string; line: number | null; title: string } {
  return { path: record.path, line: record.line ?? null, title: redactFindingTitle(record.title) };
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
 * Phase 34 (PRD-05 / D-12): PURE builder for the `yaml_config_parse_failed` audit variant.
 * Produces the shape locked by 34-01's jobAuditEventSchema arm (stage literal, reason
 * bounded at 500 chars, timestamp). The reason is the parse/validation error message,
 * sliced to the schema bound — the schema REJECTS a longer reason, so the slice is the
 * producer's obligation. No I/O, never throws. Mirrors the buildFileSkipEvents pure-builder
 * family — this codebase has NO emitAuditEvent; the builder + best-effort recorder pair is
 * the established pattern.
 */
export function buildYamlConfigParseFailedEvent(reason: string): JobAuditEvent {
  return {
    stage: 'yaml_config_parse_failed',
    // WR-02 (34-REVIEW): the reason derives from an error raised while reading an UNTRUSTED,
    // PR-head-controlled `.review.yaml`, and it lands in `jobs.audit` (durable), the dashboard
    // audit-trail viewer, and the logs. The primary defense is upstream — `core/yaml-parse.ts`
    // reports position + construct and never echoes source text (see its ERROR-MESSAGE CONTRACT).
    // This scrub is the second layer for reasons this builder does not control (Zod messages, a
    // future producer): it strips credential-shaped tokens in place. Scrub BEFORE the slice so a
    // token straddling the 500-char bound cannot survive as a partial. The 500-char cap remains
    // the secondary bound (and the schema rejects anything longer).
    reason: scrubEmbeddedSecrets(reason).slice(0, 500),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Phase 34 (PRD-05 / D-12): job-level best-effort recorder for `yaml_config_parse_failed`.
 * A VERBATIM clone of `recordFileSkips`: wraps a SINGLE `appendJobAuditEvents` in try/catch,
 * defensively stamps a timestamp on an event that arrived without one, logs a failure via
 * `logger.warn`, and NEVER rethrows — a broken audit write must never fail the prepare phase
 * (T-34-03-01 / D-12 fail-open: YAML parse failure falls back to DB config, review proceeds
 * unaffected).
 */
export async function recordYamlConfigParseFailed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  reason: string,
): Promise<void> {
  try {
    await appendJobAuditEvents(env, jobId, [buildYamlConfigParseFailedEvent(reason)]);
  } catch (error) {
    logger.warn(`Failed to record yaml_config_parse_failed audit event for job ${jobId}`, error);
  }
}

// WR-03/WR-07 (34-REVIEW) bounds, matching the schema arm: at most 20 key names, each at most 64
// chars. `.review.yaml` is untrusted PR-head content, so an author could otherwise declare
// hundreds of long junk top-level keys and have every one of them written into jobs.audit.
const YAML_CONFIG_KEY_SAMPLE_LIMIT = 20;
const YAML_CONFIG_KEY_MAX_CHARS = 64;

function boundKeyNames(keys: string[]): string[] {
  return keys.slice(0, YAML_CONFIG_KEY_SAMPLE_LIMIT).map((key) => key.slice(0, YAML_CONFIG_KEY_MAX_CHARS));
}

/**
 * Phase 34 WR-03 / WR-07 (34-REVIEW): PURE builder for the `yaml_config_applied` audit variant —
 * the SUCCESS-path counterpart to `buildYamlConfigParseFailedEvent`.
 *
 * `replacedKeys` are the top-level keys the YAML declared that the schema recognizes; each one
 * replaced the operator's DB subtree WHOLESALE under D-09 (its unspecified sub-keys reverted to
 * Zod defaults). `ignoredKeys` are the declared top-level keys the schema does NOT recognize —
 * Zod strips them silently, so without this field a typo'd `reveiw:` makes the whole file a
 * no-op with no operator-visible signal (WR-07).
 *
 * Key names are bounded (count and length) because the file is untrusted. No I/O, never throws.
 */
export function buildYamlConfigAppliedEvent(
  source: string,
  replacedKeys: string[],
  ignoredKeys: string[],
): JobAuditEvent {
  return {
    stage: 'yaml_config_applied',
    source: source.slice(0, YAML_CONFIG_KEY_MAX_CHARS),
    replaced_keys: boundKeyNames(replacedKeys),
    ignored_keys: boundKeyNames(ignoredKeys),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Phase 34 WR-03 / WR-07 (34-REVIEW): job-level best-effort recorder for `yaml_config_applied`.
 * A VERBATIM clone of `recordYamlConfigParseFailed`: one `appendJobAuditEvents` in try/catch,
 * logs a failure via `logger.warn`, NEVER rethrows — audit telemetry must never fail the prepare
 * phase.
 */
export async function recordYamlConfigApplied(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  source: string,
  replacedKeys: string[],
  ignoredKeys: string[],
): Promise<void> {
  try {
    await appendJobAuditEvents(env, jobId, [buildYamlConfigAppliedEvent(source, replacedKeys, ignoredKeys)]);
  } catch (error) {
    logger.warn(`Failed to record yaml_config_applied audit event for job ${jobId}`, error);
  }
}

/**
 * quick-k31 (WR-03): PURE builder for the `yaml_config_head_ignored` audit variant.
 *
 * The reviewed diff CHANGES `.review.yaml` / `.review.yml`, but `runPreparePhase` reads the config
 * from the PR BASE branch, so the author's edit had NO effect on this review — it takes effect once
 * the PR is merged. Without this event, a contributor editing the config in their own PR gets a
 * review that ignored it and no explanation anywhere in the product. The event is emitted whether
 * or not a base-branch config was found; "adding `.review.yaml` for the first time" is exactly the
 * case where the signal matters most, and that case has no base config by definition (hence an
 * empty `base_sha` is legal, both here and in the schema arm).
 *
 * Every string is bounded to `YAML_CONFIG_KEY_MAX_CHARS` because `path` is derived from a diff the
 * PR author controls and the SHAs come from provider payloads. No I/O, never throws.
 */
export function buildYamlConfigHeadIgnoredEvent(
  path: string,
  baseSha: string,
  headSha: string,
): JobAuditEvent {
  return {
    stage: 'yaml_config_head_ignored',
    path: path.slice(0, YAML_CONFIG_KEY_MAX_CHARS),
    base_sha: baseSha.slice(0, YAML_CONFIG_KEY_MAX_CHARS),
    head_sha: headSha.slice(0, YAML_CONFIG_KEY_MAX_CHARS),
    timestamp: new Date().toISOString(),
  };
}

/**
 * quick-k31 (WR-03): job-level best-effort recorder for `yaml_config_head_ignored`. A VERBATIM
 * clone of `recordYamlConfigApplied`'s shape: one `appendJobAuditEvents` in try/catch, logs a
 * failure via `logger.warn`, NEVER rethrows — audit telemetry must never fail the prepare phase.
 */
export async function recordYamlConfigHeadIgnored(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  path: string,
  baseSha: string,
  headSha: string,
): Promise<void> {
  try {
    await appendJobAuditEvents(env, jobId, [buildYamlConfigHeadIgnoredEvent(path, baseSha, headSha)]);
  } catch (error) {
    logger.warn(`Failed to record yaml_config_head_ignored audit event for job ${jobId}`, error);
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

// Phase 21 (EVID-03): evidence_missing_summary bounded sample cap (schema .max(20) constant for the builder).
export const EVIDENCE_MISSING_SAMPLE_CAP = 20;

// Phase 26 (EVID-02): evidence_hard_dropped bounded sample cap (schema .max(20) constant for the builder).
export const EVIDENCE_HARD_DROP_SAMPLE_CAP = 20;

export type EvidenceMissingSummaryAuditEvent = Extract<JobAuditEvent, { stage: 'evidence_missing_summary' }>;

export interface EvidenceMissingEntry {
  path: string;
  line: number | null;
  title: string;
  reason: 'absent' | 'not_in_hunk';
}

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
      // Phase 20.1 BLOCKER 1 (D-06): the redactor caps the title to 100 chars with a length-bounded
      // head-clamp marker for over-length input. The prior `.slice(0, 200)` only truncated; the
      // redactor is the producer-side enforcement of the audit-event privacy boundary.
      title: redactFindingTitle(finding.title),
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
        // Phase 20.1 BLOCKER 1 (D-06): see winningSample.title above.
        title: redactFindingTitle(sample?.title ?? ''),
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
    // Phase 20.1 BLOCKER 1 (D-06): the redactor caps the title to 100 chars with a length-bounded
    // head-clamp marker for over-length input. The prior pass-through `d.title` accepted arbitrary
    // length; the redactor is the producer-side enforcement of the audit-event privacy boundary.
    title: redactFindingTitle(d.title),
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

// ---------------------------------------------------------------------------
// Phase 20 (PASS-03 closure, D-04 / D-05) — bounded walkthrough-enrichment audit builder +
// best-effort recorder.
//
// One bounded `walkthrough.enrichment` event per enabled walkthrough run. The status is
// determined by the parser's preserved malformed-field provenance (D-17 / D-05 reachability):
// `completed` when every supplied field survived; `partial` when at least one supplied field
// was malformed; `failed` when the whole call failed open. groupCount is set only on completed
// and partial runs (the projection's group count is the most operator-useful field).
// ---------------------------------------------------------------------------

export type WalkthroughEnrichmentAuditEvent = Extract<JobAuditEvent, { stage: 'walkthrough.enrichment' }>;

/**
 * PURE walkthrough-enrichment audit builder (D-04 / D-05). Derives ONE `walkthrough.enrichment`
 * event from the per-run inputs. The result validates against the schema-authoritative
 * `walkthrough.enrichment` arm of `jobAuditEventSchema` (no widening, no schema-side change).
 *
 * Status semantics:
 *   - `completed` — every supplied field survived validation (no malformedFields from the parser).
 *   - `partial`  — at least one supplied field was malformed; some valid fields survived.
 *   - `failed`   — the whole call failed open (no valid fields survived); the reason is the
 *                  machine-readable code from the parser.
 *
 * `groupCount` is set only on completed / partial runs (named when the projection has at least
 * one valid group). On failed runs groupCount is omitted — the projection never groups a
 * non-surviving payload.
 */
export function buildWalkthroughEnrichmentAuditEvent(
  status: 'completed' | 'partial' | 'failed',
  reason?: string,
  groupCount?: number,
): WalkthroughEnrichmentAuditEvent {
  const event: WalkthroughEnrichmentAuditEvent = {
    stage: 'walkthrough.enrichment',
    status,
    timestamp: new Date().toISOString(),
  };
  // The schema-derived `WalkthroughEnrichmentAuditEvent` type already declares `reason` and
  // `groupCount` as optional fields, so direct assignment is type-safe — no cast needed (WR-03).
  if (reason != null) event.reason = reason;
  if (groupCount != null && (status === 'completed' || status === 'partial')) {
    event.groupCount = groupCount;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Phase 21 (EVID-03) — bounded evidence_missing_summary audit builder.
//
// Replaces N per-finding `evidence_missing` events with ONE aggregate per
// (file, pass) unit, preventing a non-compliant model's flood of events from
// evicting other telemetry from the 500-event ring buffer.
// ---------------------------------------------------------------------------

/**
 * PURE evidence-missing-summary audit builder (EVID-03 / D-05 / D-06 / D-07).
 * Derives ONE `evidence_missing_summary` event from an array of
 * `EvidenceMissingEntry` objects. Returns null when entries is empty (D-05 —
 * no zero-count event for empty input).
 *
 * Counts are always aggregate (D-06): `absentCount` and `notInHunkCount`
 * reflect the FULL total passed in, NOT the capped sample length. The `sample`
 * array is bounded to at most `EVIDENCE_MISSING_SAMPLE_CAP` (20) entries and
 * preserves model emission order per D-07 — entries are NOT grouped by reason.
 *
 * Privacy boundary (T-15-04-01 / Phase 20.1 D-06): every sample entry's title
 * passes through `redactFindingTitle` before storage. The builder never
 * includes body/diff/existingCode/codeSuggestion in the event payload.
 *
 * Precedent: follows `buildFileSkipEvents` (lines 228-257) pattern — pure
 * function, no I/O, never throws, returns typed event via `satisfies`.
 */
export function buildEvidenceMissingSummary(
  file: string,
  pass: FileReviewPass,
  entries: EvidenceMissingEntry[],
): EvidenceMissingSummaryAuditEvent | null {
  if (entries.length === 0) return null;

  const absentCount = entries.filter((e) => e.reason === 'absent').length;
  const notInHunkCount = entries.length - absentCount;

  const sample = entries.slice(0, EVIDENCE_MISSING_SAMPLE_CAP).map((e) => ({
    path: e.path,
    line: e.line,
    title: redactFindingTitle(e.title),
    reason: e.reason,
  }));

  const event = {
    stage: 'evidence_missing_summary' as const,
    file,
    pass,
    absentCount,
    notInHunkCount,
    sample,
    timestamp: new Date().toISOString(),
  };

  // `satisfies` is a compile-time check — if the literal ever diverges from
  // the `JobAuditEvent` union member, TypeScript rejects at compile time
  // rather than silently widening (Codex REVIEWS finding). NEVER cast `as`.
  return event satisfies JobAuditEvent;
}

// ---------------------------------------------------------------------------
// Phase 26 (EVID-02) — bounded evidence_hard_dropped audit builder.
//
// One aggregate event per (file, pass) when EVID-02 hard-drop removed >=1 finding
// from the finalize pass output. Follows the buildEvidenceMissingSummary pattern.
// ---------------------------------------------------------------------------

/**
 * PURE evidence-hard-dropped audit builder (EVID-02 / D-05 / D-06).
 * Derives ONE `evidence_hard_dropped` event from an array of `EvidenceDropEntry`
 * objects. Returns null when entries is empty (no zero-count event for empty input).
 *
 * droppedCount reflects the FULL total passed in, NOT the capped sample length.
 * The sample array is bounded to at most `EVIDENCE_HARD_DROP_SAMPLE_CAP` (20) entries.
 *
 * Privacy boundary (T-26-02): every sample entry's title passes through
 * `redactFindingTitle` before storage. The builder never includes
 * body/diff/existingCode/codeSuggestion in the event payload.
 *
 * Precedent: follows `buildEvidenceMissingSummary` (lines 605-640) pattern — pure
 * function, no I/O, never throws, returns typed event via `satisfies`.
 */
export function buildEvidenceHardDroppedEvent(
  file: string,
  pass: FileReviewPass,
  entries: EvidenceDropEntry[],
): JobAuditEvent | null {
  if (entries.length === 0) return null;

  const sample = entries.slice(0, EVIDENCE_HARD_DROP_SAMPLE_CAP).map((e) => ({
    path: e.path,
    line: e.line,
    title: redactFindingTitle(e.title),
    reason: e.reason,
  }));

  const event = {
    stage: 'evidence_hard_dropped' as const,
    file,
    pass,
    droppedCount: entries.length,
    sample,
    timestamp: new Date().toISOString(),
  };

  // `satisfies` is a compile-time check — if the literal ever diverges from
  // the `JobAuditEvent` union member, TypeScript rejects at compile time
  // rather than silently widening (Codex REVIEWS finding). NEVER cast `as`.
  return event satisfies JobAuditEvent;
}

// ---------------------------------------------------------------------------
// Phase 33 (PRD-02 / FR-153, D-08) — bounded suggestion_dropped audit builder.
//
// ONE aggregate event per (file, pass) when the FR-153 drop clause removed
// >=1 finding from the parse output. Follows the evidence_hard_dropped
// precedent for the per-(file, pass) aggregate shape.
// ---------------------------------------------------------------------------

/**
 * Sample cap for suggestion_dropped events — matches the other aggregate builders.
 * Module-private, like `LEARNED_RULE_SUPPRESS_SAMPLE_CAP`: nothing outside this module
 * consumes it, so exporting it would widen the surface for no consumer (IN-05).
 */
const SUGGESTION_DROP_SAMPLE_CAP = 20;

/** One FR-153-dropped finding identifier: { path, line, title } only (T-13-03-03). */
export type SuggestionDropEntry = { path: string; line: number | null; title: string };

/** Narrowed `suggestion_dropped` variant, mirroring `InlineCommentSkippedAuditEvent` (IN-02). */
export type SuggestionDroppedAuditEvent = Extract<JobAuditEvent, { stage: 'suggestion_dropped' }>;

/**
 * PURE suggestion-dropped audit builder (FR-153 / D-08).
 * Derives ONE `suggestion_dropped` event from an array of `SuggestionDropEntry`
 * objects. Returns null when entries is empty (no zero-count event for empty input).
 *
 * droppedCount reflects the FULL total passed in, NOT the capped sample length.
 * The sample array is bounded to at most `SUGGESTION_DROP_SAMPLE_CAP` (20) entries.
 *
 * Privacy boundary: every sample entry's title passes through `redactFindingTitle`
 * before storage. The builder never includes body/existingCode/codeSuggestion in
 * the event payload.
 *
 * Precedent: follows `buildEvidenceHardDroppedEvent` pattern — pure function, no
 * I/O, never throws, returns typed event via `satisfies`.
 */
export function buildSuggestionDroppedEvent(
  file: string,
  pass: FileReviewPass,
  entries: SuggestionDropEntry[],
): SuggestionDroppedAuditEvent | null {
  if (entries.length === 0) return null;

  const sample = entries.slice(0, SUGGESTION_DROP_SAMPLE_CAP).map((e) => ({
    path: e.path,
    line: e.line,
    title: redactFindingTitle(e.title),
  }));

  const event = {
    stage: 'suggestion_dropped' as const,
    file,
    pass,
    droppedCount: entries.length,
    sample,
    timestamp: new Date().toISOString(),
  };

  // `satisfies` is a compile-time check — if the literal ever diverges from
  // the `JobAuditEvent` union member, TypeScript rejects at compile time.
  return event satisfies JobAuditEvent;
}

// ---------------------------------------------------------------------------
// Phase 28 (LRN-01) — bounded learned_rule_suppressed audit builder.
//
// One aggregate event per (file, pass) when learned-rule suppression removed >=1
// finding from the finalize pass output. Follows the `buildEvidenceHardDroppedEvent`
// precedent for the per-(file, pass) aggregate shape.
// ---------------------------------------------------------------------------

/** Sample cap for learned_rule_suppressed events — matches evidence_hard_dropped precedent. */
const LEARNED_RULE_SUPPRESS_SAMPLE_CAP = 20;

/**
 * PURE learned-rule-suppressed audit builder (LRN-01 / D-13).
 * Derives ONE `learned_rule_suppressed` event from an array of `LearnedRuleSuppressionEntry`
 * objects. Returns null when entries is empty (no zero-count event for empty input).
 *
 * droppedCount reflects the FULL total passed in, NOT the capped sample length.
 * The sample array is bounded to at most `LEARNED_RULE_SUPPRESS_SAMPLE_CAP` (20) entries.
 *
 * Privacy boundary: every sample entry's title passes through `redactFindingTitle` before
 * storage. The builder never includes body/diff/existingCode/codeSuggestion in the event payload.
 *
 * Precedent: follows `buildEvidenceHardDroppedEvent` pattern — pure function, no I/O, never
 * throws, returns typed event via `satisfies`.
 */
export function buildLearnedRuleSuppressedEvent(
  file: string,
  pass: FileReviewPass,
  entries: LearnedRuleSuppressionEntry[],
): JobAuditEvent | null {
  if (entries.length === 0) return null;

  const sample = entries.slice(0, LEARNED_RULE_SUPPRESS_SAMPLE_CAP).map((e) => ({
    path: e.path,
    line: e.line,
    title: redactFindingTitle(e.title),
    matched_rule: e.matched_rule,
  }));

  const event = {
    stage: 'learned_rule_suppressed' as const,
    file,
    pass,
    droppedCount: entries.length,
    sample,
    timestamp: new Date().toISOString(),
  };

  return event satisfies JobAuditEvent;
}

// ---------------------------------------------------------------------------
// Phase 33 (PRD-01 / FR-031, D-03/D-04) — bounded inline_comment_skipped audit builder.
//
// ONE aggregate event per review round when inline comments were skipped (per-comment 422 or
// budget exhaustion) at posting. Consumes the `skippedComments` seam Plan 33-01 produced on
// the widened VcsProvider.submitReview return. Follows the learned_rule_suppressed precedent.
// ---------------------------------------------------------------------------

/**
 * Sample cap for inline_comment_skipped events — matches the other aggregate builders.
 * Module-private for the same reason as `LEARNED_RULE_SUPPRESS_SAMPLE_CAP` (IN-05).
 */
const INLINE_COMMENT_SKIPPED_SAMPLE_CAP = 20;

export type InlineCommentSkippedAuditEvent = Extract<JobAuditEvent, { stage: 'inline_comment_skipped' }>;

/**
 * PURE inline-comment-skipped audit builder (D-03/D-04).
 * Derives ONE `inline_comment_skipped` event from an array of skipped-comment identifiers.
 * Returns null when skipped is empty (no zero-count event for a clean round).
 *
 * count reflects the FULL total passed in, NOT the capped sample length. The sample is bounded
 * to at most `INLINE_COMMENT_SKIPPED_SAMPLE_CAP` (20) entries.
 *
 * The param type is deliberately STRUCTURAL (NOT `VcsSkippedComment`) so `core/audit.ts` gains
 * no import from `vcs/types`; `VcsSkippedComment` is structurally assignable.
 *
 * Privacy boundary (T-13-03-03): sample identifiers admit ONLY
 * { path, line, position, commentId } — never body/title/existingCode/codeSuggestion.
 *
 * WR-01: `line` (head-side line) and `position` (diff offset) are carried SEPARATELY because they
 * are not the same quantity and are not comparable across providers (G-28-3). Bitbucket supplies
 * `line`, GitHub supplies `position`; whichever is absent stays null rather than being filled from
 * the other.
 *
 * WR-06: the sample carries `commentId` (the persisted `review_comments.id`) instead of a title.
 * The old `title` field ran through `redactFindingTitle`, which maps EVERY non-empty title to one
 * fixed marker — so the sample always read `[title-redacted]` and an operator could not tell WHICH
 * finding was skipped. The row id is not derived from the title in any way, so it identifies the
 * finding without reintroducing the content AUD-01 keeps out of `jobs.audit`. This builder no
 * longer needs `redactFindingTitle` at all: no title reaches it.
 */
export function buildInlineCommentSkippedEvent(
  skipped: Array<{ path: string; line?: number | null; position?: number | null; commentId?: string | null }>,
): InlineCommentSkippedAuditEvent | null {
  if (skipped.length === 0) return null;

  const sample = skipped.slice(0, INLINE_COMMENT_SKIPPED_SAMPLE_CAP).map((s) => ({
    path: s.path,
    line: s.line ?? null,
    position: s.position ?? null,
    commentId: s.commentId ?? null,
  }));

  const event = {
    stage: 'inline_comment_skipped' as const,
    count: skipped.length,
    sample,
    timestamp: new Date().toISOString(),
  };

  // `satisfies` is a compile-time check — if the literal ever diverges from the `JobAuditEvent`
  // union member, TypeScript rejects at compile time rather than silently widening.
  return event satisfies JobAuditEvent;
}

/**
 * Phase 20 (D-04): bounded best-effort recorder for the `walkthrough.enrichment` audit variant.
 * Mirrors `recordEnsembleAudit` / `recordCriticAudit` EXACTLY: try/catch, defensive timestamp
 * stamping, logs and NEVER rethrows. A broken walkthrough audit write must never fail the
 * caller's review (D-13-03-04 carry-over posture — same contract as the other Phase-19
 * recorders).
 *
 * The builder is pure and never short-circuits, so the recorder's empty-input fast path handles
 * only the broken-DB case (empty inputs are a no-op, never produce an inert event row). The
 * producer (core/walkthrough-enrichment.ts::runWalkthroughEnrichmentPhase) owns the privacy
 * boundary — events only carry { status, reason?, groupCount? } machine-readable metadata, never
 * raw findings / model payloads / provider response bodies.
 */
export async function recordWalkthroughAudit(
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
    logger.warn(`Failed to record walkthrough audit events for job ${jobId}`, error);
  }
}

// ---------------------------------------------------------------------------
// SEC-XDIFF-01 — cross-file security reasoning audit builder + best-effort recorder.
//
// One `cross_file_security` event per enabled run. Status is 'completed' when the model
// returned findings, 'skipped' when cross_file is disabled or the model call failed open,
// 'failed' when a hard error occurred. finding_count and files_included are set only on
// completed runs.
// ---------------------------------------------------------------------------

export type CrossFileSecurityAuditEvent = Extract<JobAuditEvent, { stage: 'cross_file_security' }>;

/**
 * PURE cross-file security audit builder (SEC-XDIFF-01). Derives ONE `cross_file_security`
 * event from the run status, optional finding count, and file count. Returns a typed event
 * that validates against the schema-authoritative `cross_file_security` arm of
 * `jobAuditEventSchema`.
 *
 * Status semantics:
 *   - `completed` — the model returned valid findings (may be 0 findings — still completed).
 *   - `skipped`   — cross_file is disabled, or the model call failed open (fail-open pattern).
 *   - `failed`    — a hard error occurred that prevented the pass from running.
 *
 * `finding_count` and `files_included` are set only on completed runs (the most useful
 * operator-telemetry fields).
 */
export function buildCrossFileSecurityAuditEvent(
  status: 'completed' | 'skipped' | 'failed',
  opts?: { reason?: string; findingCount?: number; filesIncluded?: number },
): CrossFileSecurityAuditEvent {
  const event: CrossFileSecurityAuditEvent = {
    stage: 'cross_file_security',
    status,
    timestamp: new Date().toISOString(),
  };
  if (opts?.reason != null) event.reason = opts.reason;
  if (status === 'completed') {
    if (opts?.findingCount != null) event.finding_count = opts.findingCount;
    if (opts?.filesIncluded != null) event.files_included = opts.filesIncluded;
  }
  return event;
}

/**
 * Best-effort recorder for the `cross_file_security` audit variant. Mirrors
 * `recordWalkthroughAudit` EXACTLY: try/catch, defensive timestamp stamping, logs and NEVER
 * rethrows. A broken cross-file security audit write must never fail the caller's review
 * (D-13-03-04 carry-over posture).
 */
export async function recordCrossFileSecurityAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    if (events.length === 0) return;
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record cross-file security audit events for job ${jobId}`, error);
  }
}

// ---------------------------------------------------------------------------
// PRD-06 (FR-131 / FR-132, D-05/D-09/D-11/D-14) — the agentic-context audit builder + best-effort
// recorder. The operator-visible trace of the bounded tool loop, and the substrate every metric and
// alert in 35-AI-SPEC.md §7 reads from.
//
// Status semantics (35-RESEARCH.md:583-594):
//   - `completed` — the loop terminated by its own decision or on a bound, HAVING gathered content.
//   - `partial`   — a D-11 fail-open exit (budget exhaustion, a model-call failure, a second
//                   unparseable action) that still gathered something. NOT a job failure.
//   - `skipped`   — a gate declined the pass (a ready code index, D-14), or the loop ran and
//                   yielded nothing. NOT a job failure either.
//   - `failed`    — a hard error that yielded nothing at all. STILL not a job failure: the phase's
//                   whole contract is that it cannot fail the review (D-11). The status exists so
//                   an operator can tell "gathered something then stopped" from "yielded nothing",
//                   which is the discriminator §7's `status: 'failed' > 5%` alert reads.
//
// The toggle-off branch emits NO EVENT AT ALL — see `toggle_off` below.
// ---------------------------------------------------------------------------

export type AgenticContextAuditEvent = Extract<JobAuditEvent, { stage: 'agentic_context' }>;

/**
 * The CLOSED machine-token reason vocabulary. Composed rather than hand-listed so it cannot drift:
 *
 *   - `agenticStopReasons` — every way the loop itself can exit (`done`, `hop_cap_reached`,
 *     `byte_cap_reached`, `file_cap_reached`, `budget_exhausted`, `unparseable_action`,
 *     `model_call_failed`). Imported from the executor, so a seventh stop reason widens this set
 *     automatically instead of silently producing an off-vocabulary token.
 *   - `toggle_off` — declared for completeness and DELIBERATELY NEVER EMITTED. The toggle-off
 *     branch must stay completely silent or NREG-01 is broken by an audit write; the token exists
 *     so a future reader does not "helpfully" add the emission thinking the vocabulary implies one.
 *   - `index_present` — the D-14 gate: the repository already has a ready code index, so the
 *     index-backed retrieval path is cheaper and broader and this pass would be pure waste.
 *   - `no_content` — the loop ran and gathered nothing (FR-131's documented fallback: review the
 *     diff alone).
 *   - `MACHINE_ERROR_REASONS` — every value `redactErrorMessage` can return. Any error-derived
 *     reason MUST be routed through that redactor first; including its outputs here is what makes
 *     "the vocabulary is closed" and "errors are recordable" both true at once.
 *
 * Nothing else is admissible. These literals are what 35-AI-SPEC.md §7's alert thresholds and an
 * operator's SQL / `wrangler tail` greps match on, and the viewer renders them verbatim — so a free
 * -text reason would be simultaneously a privacy risk (T-35-21) and an unmatchable signal.
 */
export const AGENTIC_CONTEXT_AUDIT_REASONS = [
  ...agenticStopReasons,
  'toggle_off',
  'index_present',
  'no_content',
  ...MACHINE_ERROR_REASONS,
] as const;

export type AgenticContextAuditReason = (typeof AGENTIC_CONTEXT_AUDIT_REASONS)[number];

const AGENTIC_CONTEXT_AUDIT_REASON_SET: ReadonlySet<string> = new Set<string>(
  AGENTIC_CONTEXT_AUDIT_REASONS,
);

/** Runtime membership test for the closed vocabulary. Pure, never throws. */
export function isAgenticContextAuditReason(value: string): value is AgenticContextAuditReason {
  return AGENTIC_CONTEXT_AUDIT_REASON_SET.has(value);
}

export interface AgenticContextAuditOptions {
  reason?: AgenticContextAuditReason;
  hopsUsed?: number;
  filesRead?: number;
  grepsRun?: number;
  bytesGathered?: number;
  truncated?: boolean;
  grepSupported?: boolean;
  /** `tracker.remainingSafeBudget()` at the audit write — NOT at loop exit (§7 alerts on `< 2`). */
  budgetHeadroom?: number;
}

/**
 * PURE agentic-context audit builder (PRD-06). Derives ONE `agentic_context` event from the run
 * status plus the counts and flags the loop outcome carries. Mirrors
 * `buildCrossFileSecurityAuditEvent` exactly, including its omit-absent-fields behaviour.
 *
 * Two properties are load-bearing and must survive any refactor:
 *
 *   1. AN ABSENT FIELD IS OMITTED, A PRESENT ZERO IS KEPT. Every numeric gate is `!= null` and
 *      every boolean gate is `!== undefined`, never truthiness. `hops_used: 0`, `bytes_gathered: 0`,
 *      `budget_headroom: 0`, `truncated: false` and `grep_supported: false` are all falsy AND all
 *      diagnostic — 35-AI-SPEC.md §7 samples `bytes_gathered == 0 && hops_used >= 2` at 100%, and
 *      `grep_supported: false` is the whole D-05 signal. A truthy gate here would delete exactly
 *      the readings the fields exist for.
 *   2. AN OFF-VOCABULARY REASON IS DROPPED, NEVER WRITTEN THROUGH. The parameter type already
 *      forbids it, but this builder is the audit boundary: an untyped call site (a cast, a future
 *      refactor) must not be able to smuggle provider text or a repository path into a durable,
 *      operator-facing record (T-35-21).
 */
export function buildAgenticContextAuditEvent(
  status: 'completed' | 'partial' | 'skipped' | 'failed',
  opts?: AgenticContextAuditOptions,
): AgenticContextAuditEvent {
  const event: AgenticContextAuditEvent = {
    stage: 'agentic_context',
    status,
    timestamp: new Date().toISOString(),
  };
  if (opts?.reason != null && isAgenticContextAuditReason(opts.reason)) {
    event.reason = opts.reason;
  }
  if (opts?.hopsUsed != null) event.hops_used = opts.hopsUsed;
  if (opts?.filesRead != null) event.files_read = opts.filesRead;
  if (opts?.grepsRun != null) event.greps_run = opts.grepsRun;
  if (opts?.bytesGathered != null) event.bytes_gathered = opts.bytesGathered;
  if (opts?.truncated !== undefined) event.truncated = opts.truncated;
  if (opts?.grepSupported !== undefined) event.grep_supported = opts.grepSupported;
  if (opts?.budgetHeadroom != null) event.budget_headroom = opts.budgetHeadroom;
  return event;
}

/**
 * Best-effort recorder for the `agentic_context` variant. Mirrors `recordCrossFileSecurityAudit`
 * EXACTLY: try/catch, defensive timestamp stamping, logs with the error value and NEVER rethrows.
 *
 * T-35-19: this runs inside a phase whose entire contract is that it cannot fail the job (D-11), so
 * a rethrow here would convert an advisory pass into a failed review — the precise failure mode the
 * fail-open design exists to prevent, arriving through the telemetry meant to watch for it.
 */
export async function recordAgenticContextAudit(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  jobId: string,
  events: JobAuditEvent[],
): Promise<void> {
  try {
    if (events.length === 0) return;
    const stamped = events.map((event) =>
      event.timestamp ? event : { ...event, timestamp: new Date().toISOString() },
    );
    await appendJobAuditEvents(env, jobId, stamped);
  } catch (error) {
    logger.warn(`Failed to record agentic-context audit events for job ${jobId}`, error);
  }
}
