import { ChevronRight, ScrollText } from 'lucide-react';
import type { JobDetail, JobAuditEvent } from '@shared/schema';
import { groupAuditByStage, type AuditStageGroup } from '@client/lib/audit-grouping';

interface AuditTrailViewerProps {
  job: JobDetail;
}

// D-09: human-readable labels for each pipeline stage (STAGE_ORDER lives in audit-grouping).
// The display-stage `rounds` covers every `rounds.*` sub-variant (D-08 / Phase 18); original
// sub-stage is preserved on each event (rounds.detected, rounds.no_changes, etc.) and surfaced
// as a sub-label inside the DecisionEvent renderer below.
const STAGE_LABELS: Record<AuditStageGroup['stage'], string> = {
  file_skipped: 'Files skipped',
  drafted: 'Drafted',
  severity_adjusted: 'Severity adjusted',
  filtered: 'Filtered',
  deduped: 'Deduped',
  evidence_missing: 'Evidence missing',
  rounds: 'Rounds',
  threads: 'Threads',
  critic: 'Critic',
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
function SampleIdentifier({
  path,
  line,
  title,
}: {
  path: string;
  line?: number | null;
  title?: string | null;
}) {
  return (
    <div className="text-xs leading-relaxed">
      <span className="font-mono break-all text-foreground/90">
        {path}
        {line != null ? `:${line}` : ''}
      </span>
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
    default:
      // drafted is handled by DraftedGroup; other variants are exhaustively handled above.
      return null;
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
