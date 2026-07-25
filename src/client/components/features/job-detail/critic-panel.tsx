import { useState } from 'react';
import { Sparkles, ChevronRight } from 'lucide-react';
import {
  type CriticDecision,
  type CriticResult,
  type JobDetail,
} from '@shared/schema';
import { hasCriticResult } from '@client/lib/job-telemetry';

interface CriticPanelProps {
  job: JobDetail;
}

function CriticShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="surface surface-static surface-static-shadow overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
        <Sparkles size={14} strokeWidth={1.75} className="text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Critic</span>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

// D-08 (Codra / OpenCodra): historical prune-only rows MUST remain readable and labeled
// "Legacy prune-only" without ever being upgraded to a v2 verdict. The test in
// test/critic-v2.spec.ts asserts the legacy shape survives parsing; the rendered UI mirrors
// that posture — a legacy row never displays a verdict tile, only the kept/pruned counts.
//
// Distinguishing v1-skip from legacy prune-only: a v1-skip carried `{ skipped: true }` while a
// true legacy prune-only row had a populated `kept`/`pruned` count without skip flag. The skip
// was the v1 way to express "skipped keep-all" — Phase 19 still surfaces that text instead of
// upgrading the legacy row to verdict tiles.
function isLegacyPruneOnly(critic: CriticResult): boolean {
  if (critic.version === 2) return false;
  if (critic.skipped === true) return false; // v1 skip → handled by the skip banner
  return true;
}

function StatusBanner({ status }: { status: 'completed' | 'skipped' | 'fail_open' }) {
  if (status === 'fail_open') {
    return <p className="text-sm text-muted-foreground">Critic unavailable (kept all / fail-open)</p>;
  }
  if (status === 'skipped') {
    return <p className="text-sm text-muted-foreground">Critic skipped (kept all)</p>;
  }
  return null;
}

function DecisionRow({ decision }: { decision: CriticDecision }) {
  return (
    <li className="rounded-md border border-border/40 bg-card/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          {decision.verdict ?? '— no verdict'}
        </span>
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.08em] ${
            decision.outcome === 'dropped' ? 'text-rose-600' : 'text-emerald-600'
          }`}
        >
          {decision.outcome}
        </span>
      </div>
      <p className="mt-1 text-sm font-semibold text-foreground leading-snug line-clamp-2">
        {decision.title}
      </p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground/80 break-all">
        {decision.path}
        {decision.line ? `:${decision.line}` : ''}
      </p>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{decision.reason}</p>
    </li>
  );
}

// UI-02 SC2 / D-05 / D-06 / D-08: dedicated Critic panel.
//   - NOT rendered at all when job.criticResult is absent (no empty placeholder).
//   - Banners are explicit (fail_open / skipped) so the user never sees a fabricated 0/0 verdict.
//   - Legacy prune-only blobs render the v1 kept/pruned counts and labels as "Legacy prune-only"
//     (D-08) — never upgraded to v2 verdict tiles.
//   - v2 rows are driven SOLELY from the canonical `decisions` array: every row renders once
//     with its verdict, outcome, and machine reason. The verdicts summary (proven / plausible /
//     unsupported) and the kept/dropped totals are derived from the same array (no parallel map).
export function CriticPanel({ job }: CriticPanelProps) {
  const critic = job.criticResult;
  const [expanded, setExpanded] = useState(false);

  if (!hasCriticResult(critic) || !critic) return null;

  // v1 skip (D-07-equivalent): the legacy `skipped: true` flag short-circuits the v1 skip banner
  // — the v1 Phase-10 contract surfaced this as "Critic skipped (kept all / fail-open)" so the
  // old assertion continues to pass. v2 runs with `status: 'skipped'` get the same wording.
  if (critic.version !== 2 && critic.skipped === true) {
    return (
      <CriticShell>
        <p className="text-sm text-muted-foreground">Critic skipped (kept all / fail-open)</p>
      </CriticShell>
    );
  }

  // Legacy prune-only (D-08): keep the v1 kept/pruned counts and labelled banner. The prune
  // list is preserved so reviewers can still see the per-finding reason behind a legacy prune.
  // Never synthesize v2 verdicts or statuses — the legacy row is preserved verbatim.
  if (isLegacyPruneOnly(critic)) {
    const keptCount = critic.kept?.length ?? 0;
    const pruned = critic.pruned ?? [];
    const prunedCount = pruned.length;
    return (
      <CriticShell>
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Legacy prune-only
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Kept</div>
            <div className="text-xl font-semibold text-foreground tabular-nums">{keptCount}</div>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Pruned</div>
            <div className="text-xl font-semibold text-foreground tabular-nums">{prunedCount}</div>
          </div>
        </div>

        {prunedCount > 0 && (
          <div className="mt-4 border-t border-border/40 pt-4">
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight
                size={12}
                className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
              Pruned ({prunedCount})
            </button>

            {expanded && (
              <ul className="mt-3 flex flex-col gap-3">
                {pruned.map((entry, index) => (
                  <li key={index} className="rounded-md border border-border/40 bg-card/40 p-3">
                    <p className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
                      {entry.finding.title}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{entry.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CriticShell>
    );
  }

  const decisions = critic.decisions ?? [];
  const status = critic.status ?? 'completed';

  // Status-first handling (D-07): fail_open / skipped runs are visually distinct from a genuine
  // 0-pruned completed evaluation.
  if (status !== 'completed') {
    return (
      <CriticShell>
        <StatusBanner status={status} />
      </CriticShell>
    );
  }

  // Derive per-band totals from the canonical decisions array — never a parallel map. The
  // verdict tile tracks the total KEEPS per band (proven keeps, plausible keeps, plausible-threshold
  // drops, unsupported drops) so the per-band numbers add up to the kept/dropped totals above.
  const provenCount = decisions.filter((d) => d.verdict === 'proven' && d.outcome === 'kept').length;
  const plausibleCount = decisions.filter((d) => d.verdict === 'plausible' && d.outcome === 'kept').length;
  const unsupportedCount = decisions.filter((d) => d.verdict === 'unsupported' && d.outcome === 'dropped').length;
  const noVerdictCount = decisions.filter((d) => d.verdict === null).length;
  const keptCount = decisions.filter((d) => d.outcome === 'kept').length;
  const droppedCount = decisions.filter((d) => d.outcome === 'dropped').length;

  return (
    <CriticShell>
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Kept</div>
          <div className="text-xl font-semibold text-foreground tabular-nums">{keptCount}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Dropped</div>
          <div className="text-xl font-semibold text-foreground tabular-nums">{droppedCount}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Proven</div>
          <div className="text-xl font-semibold text-foreground tabular-nums">{provenCount}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Plausible</div>
          <div className="text-xl font-semibold text-foreground tabular-nums">{plausibleCount}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">Unsupported</div>
          <div className="text-xl font-semibold text-foreground tabular-nums">{unsupportedCount}</div>
        </div>
        {noVerdictCount > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1">No verdict</div>
            <div className="text-xl font-semibold text-foreground tabular-nums">{noVerdictCount}</div>
          </div>
        )}
      </div>

      {decisions.length > 0 && (
        <div className="mt-4 border-t border-border/40 pt-4">
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight
              size={12}
              className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            Decisions ({decisions.length})
          </button>

          {expanded && (
            <ul className="mt-3 flex flex-col gap-3">
              {decisions.map((decision) => (
                <DecisionRow key={decision.id} decision={decision} />
              ))}
            </ul>
          )}
        </div>
      )}
    </CriticShell>
  );
}
