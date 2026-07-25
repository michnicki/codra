import { Clock } from 'lucide-react';
import type { JobDetail } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';
import { cn, formatDuration } from '@client/lib/utils';
import { countSeverities, jobDurationMs } from '@client/lib/job-telemetry';
import { severityConfig } from './constants';

interface JobSeveritySummaryProps {
  job: JobDetail;
}

// UI-02 SC2 / D-05 (REVIEW #3): compact strip at the TOP of job detail summarizing the findings
// VISIBLE ON THE PAGE — the SAME candidate set (drafted candidates incl. dropped/security-pass rows)
// the finding cards below display, NOT the posted-comment count (job.commentCount). The heading
// scopes it explicitly. All five bands always render (zero-filled). Whole-job duration is omitted
// (rather than NaN/throwing) on an in-flight / pre-v1.2 / reversed-timestamp job (Plan 16-02 guard).
export function JobSeveritySummary({ job }: JobSeveritySummaryProps) {
  const comments = job.files.flatMap((file) => file.parsedComments);
  const counts = countSeverities(comments);
  const duration = formatDuration(jobDurationMs(job.startedAt, job.finishedAt));

  return (
    <div className="surface surface-static surface-static-shadow overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
            Findings by severity
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {reviewSeverities.map((band) => {
              const sev = severityConfig[band] ?? severityConfig.nit;
              return (
                <span
                  key={band}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold',
                    sev.bg, sev.border, sev.text,
                  )}
                >
                  {sev.svg ? <img src={sev.svg} alt={band} className="w-3 h-3" /> : null}
                  <span>{band}</span>
                  <span className="tabular-nums">{counts[band]}</span>
                </span>
              );
            })}
          </div>
        </div>
        {duration && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock size={12} className="shrink-0" />
            <span className="font-mono tabular-nums">{duration}</span>
          </span>
        )}
      </div>
    </div>
  );
}
