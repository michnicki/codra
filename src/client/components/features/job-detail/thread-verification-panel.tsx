import { ChevronRight, ShieldCheck } from 'lucide-react';
import type { JobDetail, ThreadVerificationEntry } from '@shared/schema';

interface ThreadVerificationPanelProps {
  job: JobDetail;
}

function shortOpaqueRef(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/40 px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function ThreadRow({ entry }: { entry: ThreadVerificationEntry }) {
  const line = entry.lineStart == null
    ? ''
    : entry.lineEnd != null && entry.lineEnd !== entry.lineStart
      ? `:${entry.lineStart}-${entry.lineEnd}`
      : `:${entry.lineStart}`;

  return (
    <li className="rounded-md border border-border/40 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold text-secondary-foreground">
          {entry.verdict}
        </span>
        {entry.resolved ? (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-foreground bg-success/10">
            resolved
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-muted-foreground">
          {shortOpaqueRef(entry.threadRef)}
        </span>
      </div>
      <p className="mt-2 break-all font-mono text-xs text-foreground/90">
        {entry.path}{line}
      </p>
      <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{entry.reason}</p>
    </li>
  );
}

/**
 * D-04's always-available dashboard surface. It reads only the durable job-detail payload, renders
 * nothing for pre-Phase-19/default rows, and keeps fail-open/in-flight results distinct from a
 * successful zero-count verification. React text nodes escape every persisted path, ref, and reason.
 */
export function ThreadVerificationPanel({ job }: ThreadVerificationPanelProps) {
  const verification = job.threadVerification;
  if (!verification) return null;

  const degraded =
    verification.status !== 'completed' ||
    verification.totals.resolved > verification.totals.fixed;

  return (
    <div className="surface surface-static surface-static-shadow overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <ShieldCheck size={14} strokeWidth={1.75} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Thread verification</h2>
      </div>

      <div className="px-5 py-5">
        {degraded ? (
          <div
            className="rounded-md border px-3 py-2.5"
            style={{
              background: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning)',
            }}
          >
            <p className="text-sm font-semibold">Verification unavailable (degraded)</p>
            {verification.reason ? (
              <p className="mt-1 break-words font-mono text-xs">{verification.reason}</p>
            ) : null}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Total label="Fixed" value={verification.totals.fixed} />
            <Total label="Unfixed" value={verification.totals.unfixed} />
            <Total label="Unverifiable" value={verification.totals.unverifiable} />
            <Total label="Resolved" value={verification.totals.resolved} />
          </div>
        )}

        {verification.entries.length > 0 ? (
          <details className="group/threads mt-4 rounded-md border border-border/50 bg-card/30">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={12}
                className="shrink-0 transition-transform group-open/threads:rotate-90"
              />
              Threads ({verification.entries.length})
            </summary>
            <ul className="flex flex-col gap-2 border-t border-border/30 px-3 py-3">
              {verification.entries.map((entry) => (
                <ThreadRow key={`${entry.threadRef}:${entry.path}`} entry={entry} />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
