import { useState } from 'react';
import { Sparkles, ChevronRight } from 'lucide-react';
import type { JobDetail } from '@shared/schema';
import { hasCriticResult, isCriticSkipped } from '@client/lib/job-telemetry';

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

// UI-02 SC2 / D-06 (REVIEW #6): dedicated Critic panel. Renders NOTHING when job.criticResult is
// absent (no empty placeholder). When the critic bypassed its model call (skip-threshold / char-budget
// / fail-open) it shows an explicit 'Critic skipped (kept all / fail-open)' status rather than a
// misleading 0 kept / 0 pruned verdict. Otherwise it lists kept/pruned counts and each pruned finding
// with its reason (rendered as plain React text — auto-escaped, never dangerouslySetInnerHTML), with
// the pruned list collapsed by default when long.
export function CriticPanel({ job }: CriticPanelProps) {
  const critic = job.criticResult;
  const [expanded, setExpanded] = useState(false);

  // D-06: not rendered at all when absent.
  if (!hasCriticResult(critic) || !critic) return null;

  // REVIEW #6: explicit skipped state, NOT a bare 0/0 verdict.
  if (isCriticSkipped(critic)) {
    return (
      <CriticShell>
        <p className="text-sm text-muted-foreground">Critic skipped (kept all / fail-open)</p>
      </CriticShell>
    );
  }

  const keptCount = critic.kept.length;
  const prunedCount = critic.pruned.length;

  return (
    <CriticShell>
      <div className="flex flex-wrap items-center gap-6">
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
              {critic.pruned.map((entry, index) => (
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
