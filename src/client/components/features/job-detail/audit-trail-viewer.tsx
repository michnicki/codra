import { ChevronRight, ScrollText } from 'lucide-react';
import type { JobDetail, JobAuditEvent } from '@shared/schema';
import { groupAuditByStage, type AuditStageGroup } from '@client/lib/audit-grouping';

interface AuditTrailViewerProps {
  job: JobDetail;
}

// D-09: human-readable labels for each pipeline stage (STAGE_ORDER lives in audit-grouping).
// The display-stage `rounds` covers every `rounds.*` sub-variant (D-08 / Phase 18); original
// sub-stage is preserved on each event (rounds.detected, rounds.no_changes, etc.) and surfaced
// as a sub-label inside the DecisionEvent renderer below. Phase 20 (D-01 / D-06 amended) adds
// `ensemble` (one per `ensemble.voted` event) and `walkthrough` (one per `walkthrough.enrichment`
// event) — both are synthetic display stages that wrap a single bounded aggregate.
const STAGE_LABELS: Record<AuditStageGroup['stage'], string> = {
  // WR-03: these two schema stages previously had no STAGE_ORDER entry and were never rendered.
  yaml_config_parse_failed: 'Config parse failed',
  // Phase 34 WR-03/WR-07: which top-level config keys a repo's .review.yaml replaced (a WHOLESALE
  // D-09 replacement, read from the maintainer-reviewed base branch) and which it declared but the
  // schema ignored.
  yaml_config_applied: 'Repo config applied',
  // quick-k31 (WR-03): the PR itself edits .review.yaml, but config comes from the base branch —
  // the edit is inert for this review and takes effect once merged.
  yaml_config_head_ignored: 'Repo config change ignored',
  file_skipped: 'Files skipped',
  drafted: 'Drafted',
  severity_adjusted: 'Severity adjusted',
  filtered: 'Filtered',
  deduped: 'Deduped',
  evidence_missing: 'Evidence missing',
  learned_rule_suppressed: 'Learned rule suppressed',
  // Phase 33 (PRD-02 / FR-153, D-08): FR-153 parse-drop aggregate event.
  suggestion_dropped: 'Suggestions dropped',
  rounds: 'Rounds',
  threads: 'Threads',
  critic: 'Critic',
  ensemble: 'Ensemble',
  walkthrough: 'Walkthrough enrichment',
  cross_file_security: 'Cross-file security',
  // Phase 33 (PRD-01 / FR-031, D-03/D-04): posting-boundary aggregate event.
  inline_comment_skipped: 'Inline comments skipped',
  // WR-03 catch-all: any schema stage without a dedicated display group renders here instead of
  // being silently discarded by groupAuditByStage's STAGE_ORDER filter.
  other: 'Other',
};

// A count pill mirroring the job-findings-list / critic-panel count-badge idiom.
function CountBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-secondary text-secondary-foreground">
      {count}
    </span>
  );
}

// A single producer-bounded sample identifier: { path, line?, title? }. Paths render mono + break-all
// so a long file path wraps within the row instead of stretching the viewer (E6 long-text backstop).
// All fields are plain React text nodes — auto-escaped, never dangerouslySetInnerHTML (T-16-06-01).
// WR-01: `position` is a DIFF OFFSET, not a head-side line number, and the two are not
// interchangeable (G-28-3). It renders as ` @pos N` — never as `:N` — so a GitHub skip is never
// read as a line number the finding was not on. `line` still renders as `:N`.
function SampleIdentifier({
  path,
  line,
  position,
  title,
  commentId,
}: {
  path: string;
  line?: number | null;
  position?: number | null;
  title?: string | null;
  // WR-06: the persisted review_comments.id, rendered as `#id` so an operator can join a skipped
  // entry straight back to its row. Only the inline_comment_skipped sample supplies it; the other
  // aggregate samples still carry a (redacted) title.
  commentId?: string | null;
}) {
  return (
    <div className="text-xs leading-relaxed">
      <span className="font-mono break-all text-foreground/90">
        {path}
        {line != null ? `:${line}` : ''}
        {line == null && position != null ? ` @pos ${position}` : ''}
      </span>
      {commentId ? <span className="font-mono text-muted-foreground"> #{commentId}</span> : null}
      {title ? <span className="text-muted-foreground"> — {title}</span> : null}
    </div>
  );
}

// A small "key: value" decision-metric chip line (threshold, rule, similarities, from→to, …).
function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs text-muted-foreground">
      <span className="font-semibold uppercase tracking-wide text-[10px] text-muted-foreground/70">{label}</span>{' '}
      <span className="font-mono break-all text-foreground/80">{value}</span>
    </div>
  );
}

function shortOpaqueRef(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}

// Render one decision event's reason + sample identifiers + decision metrics. Reads ONLY the known
// fields for the narrowed variant (each variant is .passthrough() — never assume a field another
// variant carries).
function DecisionEvent({ event }: { event: JobAuditEvent }) {
  switch (event.stage) {
    case 'severity_adjusted':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="rule" value={event.rule} />
          <MetricLine label="matched" value={event.matched} />
          <MetricLine label="severity" value={`${event.from} → ${event.to}`} />
        </li>
      );
    case 'filtered':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="rule" value={event.rule} />
          <MetricLine label="dropped" value={String(event.count)} />
          <MetricLine label="threshold" value={String(event.threshold)} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s, i) => (
                <li key={i}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                  {(s.severity || s.category || s.confidence != null) && (
                    <div className="text-[10px] text-muted-foreground/70 font-mono">
                      {[
                        s.severity,
                        s.category,
                        s.confidence != null ? `${Math.round(s.confidence * 100)}%` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    case 'deduped':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="rule" value={event.rule} />
          <div className="mt-2 flex flex-col gap-1.5">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Suppressed</div>
              <SampleIdentifier
                path={event.suppressed.path}
                line={event.suppressed.line}
                title={event.suppressed.title}
              />
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Survivor</div>
              <SampleIdentifier
                path={event.survivor.path}
                line={event.survivor.line}
                title={event.survivor.title}
              />
            </div>
          </div>
          {event.titleSimilarity != null && (
            <MetricLine label="title similarity" value={event.titleSimilarity.toFixed(2)} />
          )}
          {event.bodySimilarity != null && (
            <MetricLine label="body similarity" value={event.bodySimilarity.toFixed(2)} />
          )}
        </li>
      );
    case 'file_skipped':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="reason" value={event.reason} />
          <MetricLine label="skipped" value={`${event.count} files`} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s) => (
                // A file is sampled at most once per skip event, so its path is a stable
                // unique key (IN-03) — no need for the array index.
                <li key={s.path}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    case 'evidence_missing':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="reason" value={event.reason} />
          <SampleIdentifier path={event.path} line={event.line} title={event.title} />
        </li>
      );
    // Phase 24: evidence_missing_summary aggregate event — the operator sees file+pass as identifier,
    // absentCount+notInHunkCount as metric lines, and up to 20 sample entries with path:line, title,
    // and reason. No model_line_cap data is surfaced per D-03.
    case 'evidence_missing_summary':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="file" value={event.file} />
          <MetricLine label="pass" value={event.pass} />
          <MetricLine label="absent" value={String(event.absentCount)} />
          <MetricLine label="not in hunk" value={String(event.notInHunkCount)} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s, i) => (
                <li key={i}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                  <div className="text-[10px] text-muted-foreground/70 font-mono">{s.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    // Phase 26 (EVID-02): evidence_hard_dropped aggregate event — the operator sees file+pass as
    // identifier, droppedCount as metric line, and up to 20 sample entries with path:line, title,
    // and reason tag. Follows the evidence_missing_summary pattern exactly.
    case 'evidence_hard_dropped':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="file" value={event.file} />
          <MetricLine label="pass" value={event.pass} />
          <MetricLine label="dropped" value={String(event.droppedCount)} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s, i) => (
                <li key={i}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                  <div className="text-[10px] text-muted-foreground/70 font-mono">{s.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    // Phase 28 (LRN-01) / gap G-28-4: learned_rule_suppressed aggregate event — one event per
    // (file, pass) when learned-rule suppression removed >=1 finding in finalize. `droppedCount` is
    // the FULL total, NOT the (max-20) sample length. Mirrors the evidence_hard_dropped row layout,
    // but this event lands in its OWN 'Learned rule suppressed' group (a different gate — see the
    // normalizer's Phase 28 note), and each sample names the matched rule id rather than a reason
    // tag. The rule id renders IN FULL (never shortOpaqueRef): it is the key the operator uses to
    // find the rule in the Learned Rules panel, so `break-all` wraps it inside the row instead.
    case 'learned_rule_suppressed':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="file" value={event.file} />
          <MetricLine label="pass" value={event.pass} />
          <MetricLine label="suppressed" value={String(event.droppedCount)} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s, i) => (
                <li key={i}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                  <div className="text-[10px] text-muted-foreground/70 font-mono break-all">
                    rule {s.matched_rule}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    // Phase 33 (PRD-02 / FR-153, D-08): suggestion_dropped aggregate event — one event per
    // (file, pass) when the FR-153 drop clause removed >=1 finding from the parse output.
    // `droppedCount` is the FULL total, NOT the (max-20) sample length. Mirrors the
    // learned_rule_suppressed row layout with a { path, line, title } sample (T-13-03-03
    // identifiers only — titles already redacted at build time, AUD-01).
    case 'suggestion_dropped':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="file" value={event.file} />
          <MetricLine label="pass" value={event.pass} />
          <MetricLine label="dropped" value={String(event.droppedCount)} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s, i) => (
                <li key={i}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    // Phase 33 (PRD-01 / FR-031, D-03/D-04): inline_comment_skipped aggregate event — one event
    // per review round when inline comments were skipped (per-comment 422, budget exhaustion, or
    // no usable anchor) at posting. `count` is the FULL total, NOT the (max-20) sample length.
    // Mirrors the learned_rule_suppressed row layout but reports a plain count +
    // { path, line, position, commentId } sample (T-13-03-03 identifiers only). WR-01: `position`
    // is passed through separately so a GitHub diff offset is never rendered as a head-side line
    // number. WR-06: the sample carries the persisted `review_comments.id` instead of a title —
    // the old title was always the fixed `[title-redacted]` marker, so it identified nothing. The
    // id is what an operator joins on: SELECT * FROM review_comments WHERE id = <commentId>.
    case 'inline_comment_skipped':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="skipped" value={String(event.count)} />
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s, i) => (
                <li key={i}>
                  <SampleIdentifier
                    path={s.path}
                    line={s.line}
                    position={s.position}
                    commentId={s.commentId}
                  />
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    // Phase 18 RND-01..05: every `rounds.*` sub-variant lands inside the normalized `Rounds`
    // DecisionGroup via the audit-grouping normalizer. The original event.stage distinguishes
    // each sub-variant for the per-row renderer below; .passthrough() keeps every known field
    // (anchorSha, hasUnresolvedThreads, effective, etc.) accessible without further normalization.
    case 'rounds.detected':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="rounds.detected" />
          <MetricLine label="round" value={String(event.round)} />
          <MetricLine label="mode" value={event.mode} />
          <MetricLine label="incremental" value={event.incremental ? 'true' : 'false'} />
          {event.anchorSha ? <MetricLine label="anchor" value={event.anchorSha.slice(0, 12)} /> : null}
          {event.hasUnresolvedThreads ? <MetricLine label="threads" value="unresolved" /> : null}
        </li>
      );
    case 'rounds.no_changes':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="rounds.no_changes" />
          <MetricLine label="round" value={String(event.round)} />
          <MetricLine label="from" value={event.from.slice(0, 12)} />
          <MetricLine label="to" value={event.to.slice(0, 12)} />
        </li>
      );
    case 'rounds.anchor_skipped':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="rounds.anchor_skipped" />
          <MetricLine label="reason" value={event.reason} />
          {event.round != null ? <MetricLine label="round" value={String(event.round)} /> : null}
        </li>
      );
    case 'rounds.escalated':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="rounds.escalated" />
          <MetricLine label="round" value={String(event.round)} />
          <MetricLine
            label="confidence"
            value={`${event.from.minConfidence.toFixed(2)} → ${event.to.minConfidence.toFixed(2)} (effective ${event.effective.minConfidence.toFixed(2)})`}
          />
          <MetricLine
            label="severity"
            value={`${event.from.minSeverity} → ${event.to.minSeverity} (effective ${event.effective.minSeverity})`}
          />
          {event.droppedAtEffectiveFloor != null && (
            <MetricLine label="dropped" value={String(event.droppedAtEffectiveFloor)} />
          )}
        </li>
      );
    case 'rounds.suppressed':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="rounds.suppressed" />
          <MetricLine label="thread path" value={event.threadPath} />
          <SampleIdentifier path={event.path} line={event.line} title={event.title} />
        </li>
      );
    case 'threads.verified_fixed':
    case 'threads.unfixed':
    case 'threads.unverifiable':
    case 'threads.resolved':
    case 'threads.resolve_failed':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value={event.stage} />
          <MetricLine label="reason" value={event.reason} />
          <MetricLine label="thread" value={shortOpaqueRef(event.threadRef)} />
          <SampleIdentifier path={event.path} line={event.line} />
        </li>
      );
    case 'critic.decisions':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="critic.decisions" />
          <MetricLine label="status" value={event.status} />
          <MetricLine label="count" value={String(event.count)} />
          {event.reason ? <MetricLine label="reason" value={event.reason} /> : null}
          {event.sample.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              {event.sample.map((s) => (
                <li key={`${s.id}:${s.path}:${s.line ?? ''}`}>
                  <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                  <div className="text-[10px] text-muted-foreground/70 font-mono">
                    {[(s.verdict ?? 'no-verdict'), s.outcome, s.reason].filter(Boolean).join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </li>
      );
    // Phase 20 D-01 / D-02: the ensemble.voted aggregate is one bounded row per file. The file
    // identifier is always rendered (even when both samples are empty — D-02 LOW) so an all-failed
    // ensemble event still names the file it ran for. Aggregate winner / dropped counts surface
    // above the bounded sample lists so the operator can see the totals without scanning the
    // samples.
    case 'ensemble.voted':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="ensemble.voted" />
          <MetricLine label="file" value={event.file} />
          <MetricLine label="runs" value={`${event.successfulRuns}/${event.requestedRuns} ok · ${event.failedRuns} failed`} />
          <MetricLine label="winners" value={String(event.winnerCount)} />
          <MetricLine label="dropped" value={String(event.droppedClusterCount)} />
          {event.failedRunReasons && event.failedRunReasons.length > 0 && (
            <MetricLine label="failed reasons" value={event.failedRunReasons.join(', ')} />
          )}
          {event.winningSample.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Winning sample</div>
              <ul className="flex flex-col gap-1.5">
                {event.winningSample.map((s) => (
                  <li key={`w:${s.clusterId}`}>
                    <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                    <div className="text-[10px] text-muted-foreground/70 font-mono">
                      {`${s.votes} votes · cluster ${s.clusterId}`}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {event.droppedSample.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-border/30 pt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Dropped sample</div>
              <ul className="flex flex-col gap-1.5">
                {event.droppedSample.map((s) => (
                  <li key={`d:${s.clusterId}`}>
                    <SampleIdentifier path={s.path} line={s.line} title={s.title} />
                    <div className="text-[10px] text-muted-foreground/70 font-mono">
                      {`${s.votes} votes · cluster ${s.clusterId}`}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      );
    // Phase 20 D-06 amended: the walkthrough.enrichment aggregate is one bounded row per run.
    // status is required (completed / partial / failed); reason is optional and names the
    // machine-readable failure code; groupCount names the count of valid groups the model emitted
    // on completed / partial runs (absent on failed runs).
    case 'walkthrough.enrichment':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value="walkthrough.enrichment" />
          <MetricLine label="status" value={event.status} />
          {event.reason ? <MetricLine label="reason" value={event.reason} /> : null}
          {event.groupCount != null ? <MetricLine label="groups" value={String(event.groupCount)} /> : null}
        </li>
      );
    // WR-03: both variants existed in the schema but had no STAGE_ORDER entry, so
    // `groupAuditByStage` discarded them and the viewer never rendered a row for either.
    case 'cross_file_security':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="status" value={event.status} />
          {event.reason ? <MetricLine label="reason" value={event.reason} /> : null}
          {event.finding_count != null ? (
            <MetricLine label="findings" value={String(event.finding_count)} />
          ) : null}
          {event.files_included != null ? (
            <MetricLine label="files" value={String(event.files_included)} />
          ) : null}
        </li>
      );
    case 'yaml_config_parse_failed':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="reason" value={event.reason} />
        </li>
      );
    // Phase 34 WR-03/WR-07: `replaced` is the operator-visible record of which top-level config
    // keys the base-branch YAML overrode wholesale; `ignored` names keys the schema stripped, so a
    // typo'd `reveiw:` no longer produces a silent no-op.
    case 'yaml_config_applied':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="source" value={event.source} />
          <MetricLine
            label="replaced"
            value={event.replaced_keys.length > 0 ? event.replaced_keys.join(', ') : '(none)'}
          />
          {event.ignored_keys.length > 0 ? (
            <MetricLine label="ignored" value={event.ignored_keys.join(', ')} />
          ) : null}
        </li>
      );
    // quick-k31 (WR-03): this row exists so a contributor reading the audit trail learns that repo
    // config is applied from the BASE branch — their `.review.yaml` edit did nothing for this
    // review and takes effect once the PR is merged. `base` renders `(none)` when the fail-closed
    // no-usable-base-SHA path produced an empty sha, which is itself the explanation.
    case 'yaml_config_head_ignored':
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="path" value={event.path} />
          <MetricLine label="base" value={event.base_sha ? event.base_sha.slice(0, 12) : '(none)'} />
          <MetricLine label="head" value={event.head_sha.slice(0, 12)} />
        </li>
      );
    default: {
      // WR-03: the switch above is exhaustive over today's union, so TypeScript narrows `event` to
      // the `drafted` variant here — hence the widening read. The runtime fallback below is
      // deliberately kept for the drift case the WR-03 `other` display group exists to catch: a
      // future schema variant added without a `case` would otherwise render as an empty group
      // shell whose count badge disagrees with its visible rows.
      const stage: string = (event as { stage: string }).stage;
      // drafted is handled by DraftedGroup, so it stays a no-op here.
      if (stage === 'drafted') return null;
      return (
        <li className="rounded-md border border-border/40 bg-card/40 p-3">
          <MetricLine label="stage" value={stage} />
        </li>
      );
    }
  }
}

// D-09: the high-volume drafted group collapses to 'Drafted — {count} events'. Native <details> keeps
// its content in the DOM while closed (file-finding.tsx precedent) so the browser spec can assert
// .open === false before interaction, then toggle and assert visibility.
function DraftedGroup({ group }: { group: AuditStageGroup }) {
  return (
    <details className="group/drafted rounded-md border border-border/50 bg-card/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="shrink-0 transition-transform group-open/drafted:rotate-90" />
        Drafted — {group.count} events
      </summary>
      <ul className="flex flex-col gap-1 border-t border-border/30 px-3 py-2">
        {group.events.map((event) =>
          event.stage === 'drafted' ? (
            // A file is drafted once per pass, so file:pass is a stable key (IN-03).
            <li key={`${event.file}:${event.pass}`} className="text-xs">
              <span className="font-mono break-all text-foreground/90">{event.file}</span>
              <span className="text-muted-foreground"> · {event.pass}</span>
            </li>
          ) : null,
        )}
      </ul>
    </details>
  );
}

// A decision group (everything except drafted) renders EXPANDED: a stage heading + count and one row
// per event with its reason, sample identifiers and decision metrics.
function DecisionGroup({ group }: { group: AuditStageGroup }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2.5">
        <span className="text-xs font-semibold text-foreground">{STAGE_LABELS[group.stage]}</span>
        <CountBadge count={group.count} />
      </div>
      <ul className="flex flex-col gap-2 px-3 py-2.5">
        {group.events.map((event, index) => (
          <DecisionEvent key={index} event={event} />
        ))}
      </ul>
    </div>
  );
}

// AUD-02 SC3 / D-08..D-10: a collapsed-by-default 'Audit trail' section at the bottom of job detail.
// It is the SOLE surface answering "why didn't this finding post?" — a dropped finding's drop reason
// lives only here (its candidate card may still exist, but the DECISION/REASON is answerable only from
// these producer-bounded sample identifiers). Renders job.audit grouped by stage via groupAuditByStage.
export function AuditTrailViewer({ job }: AuditTrailViewerProps) {
  const groups = groupAuditByStage(job.audit);

  return (
    <details className="group surface surface-static surface-static-shadow overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={15} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <ScrollText size={14} strokeWidth={1.75} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Audit trail</h2>
        {job.audit.length > 0 && <CountBadge count={job.audit.length} />}
      </summary>

      <div className="flex flex-col gap-4 border-t border-border px-5 py-5">
        {/* REVIEW #9 / D-10: the truncation banner renders INDEPENDENTLY of the empty-array state —
            getJobDetail can fail-soft-drop malformed elements while preserving auditTruncated, so
            `audit:[] && auditTruncated:true` is reachable and a partial trail must never be shown as
            complete. Do NOT nest this behind the empty-array early return. The copy carries no total
            (the payload has only `audit` capped at 500 + the boolean), so it never implies a total N. */}
        {job.auditTruncated && (
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{
              background: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning)',
            }}
          >
            Showing the latest 500 events — older events were evicted.
          </div>
        )}

        {job.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit events recorded for this review.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) =>
              group.stage === 'drafted' ? (
                <DraftedGroup key={group.stage} group={group} />
              ) : (
                <DecisionGroup key={group.stage} group={group} />
              ),
            )}
          </div>
        )}
      </div>
    </details>
  );
}
