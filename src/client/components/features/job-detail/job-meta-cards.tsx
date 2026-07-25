import { ExternalLink, Check, Minus, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@client/components/ui/card';
import { Badge, StatusBadge } from '@client/components/ui/badge';
import type { JobDetail, JobStep } from '@shared/schema';
import { formatDuration } from '@client/lib/utils';
import { commitUrl, reviewUrl, vcsProviderLabel } from '@client/lib/vcs';
import { formatRoundBadge } from '@client/lib/rounds-badge';

interface JobMetaCardsProps {
  job: JobDetail;
}

function elapsedSec(step: JobStep): string | null {
  if (step.finishedAt && step.startedAt) {
    const start = new Date(step.startedAt).getTime();
    const end = new Date(step.finishedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    // Reuse the shared formatter so long phases roll up into minutes/hours (e.g. "6m 24s")
    // instead of an unwieldy "383.7s".
    return formatDuration(end - start);
  }
  return null;
}

function StepRow({ step, index, total }: { step: JobStep; index: number; total: number }) {
  const isRunning = step.status === 'running';
  const isDone    = step.status === 'done';
  const isFailed  = step.status === 'failed';
  const isPending = step.status === 'pending';
  const isLast    = index === total - 1;

  const elapsed = elapsedSec(step);

  // Left accent bar color
  const accentColor = isDone
    ? 'bg-success'
    : isRunning
    ? 'bg-info'
    : isFailed
    ? 'bg-danger'
    : 'bg-border';

  // Icon
  const iconEl = isDone ? (
    <Check size={11} strokeWidth={2.5} className="text-success" />
  ) : isFailed ? (
    <X size={11} strokeWidth={2.5} className="text-danger" />
  ) : isRunning ? (
    <ArrowRight size={11} strokeWidth={2.5} className="text-info" />
  ) : (
    <Minus size={11} strokeWidth={2} className="text-muted-foreground/30" />
  );

  return (
    <div className={`flex gap-3 ${!isLast ? 'pb-3' : ''} ${index > 0 ? 'pt-3' : ''} ${!isLast ? 'border-b border-border/30' : ''}`}>
      {/* Left accent strip */}
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <div className={`w-[3px] flex-1 rounded-full ${accentColor} opacity-40`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          {/* Step name + icon */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 flex h-4 w-4 items-center justify-center">{iconEl}</span>
            <span
              className={`text-sm truncate ${
                isPending ? 'text-muted-foreground/40' : 'text-foreground'
              } ${isRunning ? 'font-semibold' : 'font-medium'}`}
            >
              {step.name}
            </span>
          </div>

          {/* Right side: status or time */}
          <div className="shrink-0">
            {isRunning && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-info">
                In progress
              </span>
            )}
            {elapsed && (
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {elapsed}
              </span>
            )}
            {!elapsed && !isRunning && (
              <span className="text-xs text-muted-foreground/25">—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobMetaCards({ job }: JobMetaCardsProps) {
  const providerReviewUrl = reviewUrl(job, job.prNumber, job.reviewId);
  const isPartialReview = job.status === 'done' && job.errorMessage?.startsWith('Partial review:');
  const steps = job.steps ?? [];
  const shortCommitSha = job.commitSha?.slice(0, 7) ?? 'unknown';
  // Only link when the helper yields a validated http(s) URL; otherwise fall
  // back to plain text rather than rendering a broken/dangerous anchor.
  const commitHref = job.commitSha ? commitUrl(job, job.commitSha) : undefined;
  const roundLabel = formatRoundBadge({
    round: job.reviewRound,
    mode: job.reviewMode,
    incrementalEnabled: job.roundsIncremental,
    escalateFloors: job.configSnapshot?.review.rounds.escalate_floors,
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

      {/* ── Job details ── */}
      <Card className="surface-static surface-static-shadow">
        <CardHeader><CardTitle>Job details</CardTitle></CardHeader>
        <CardContent className="pt-0 space-y-0">

          {/* Metadata grid */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              { label: 'Status',  value: <StatusBadge label={job.status} job={job} /> },
              { label: 'Verdict', value: job.verdict
                  ? <StatusBadge label={job.verdict} />
                  : <span className="text-muted-foreground/50 text-sm">—</span>
              },
              { label: 'Trigger', value: <Badge variant="neutral" className="capitalize">{job.trigger}</Badge> },
              { label: 'Tokens',  value:
                  <span className="font-mono text-sm tabular-nums">
                    {(job.totalInputTokens + job.totalOutputTokens).toLocaleString()}
                  </span>
              },
              ...(roundLabel
                ? [{ label: 'Round', value: <Badge variant="neutral">{roundLabel}</Badge> }]
                : []),
            ].map(({ label, value }) => (
              <div key={label}>
                <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">
                  {label}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}

            <div>
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Commit</dt>
              <dd>
                {commitHref ? (
                  <a
                    href={commitHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {shortCommitSha}
                    <ExternalLink size={10} className="text-muted-foreground/50" />
                  </a>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">{shortCommitSha}</span>
                )}
              </dd>
            </div>

            {providerReviewUrl && (
              <div>
                <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Review</dt>
                <dd>
                  <a
                    href={providerReviewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {vcsProviderLabel(job.repositoryVcsProvider)} <ExternalLink size={10} className="text-muted-foreground/50" />
                  </a>
                </dd>
              </div>
            )}

            {job.retryOfJobId && (
              <div>
                <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Retry of</dt>
                <dd>
                  <Link
                    to={`/jobs/${job.retryOfJobId}`}
                    className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
                  >
                    {job.retryOfJobId.slice(0, 8)}…
                  </Link>
                </dd>
              </div>
            )}

            <div className="col-span-2 pt-1 border-t border-border/40">
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Created</dt>
              <dd className="text-sm text-muted-foreground tabular-nums">{new Date(job.createdAt).toLocaleString()}</dd>
            </div>
          </dl>

          {/* Error / partial message */}
          {job.errorMessage && (
            <div
              className="mt-5 rounded-lg border p-4"
              style={{
                background: isPartialReview ? 'var(--warning-bg)' : 'var(--danger-bg)',
                borderColor: isPartialReview ? 'var(--warning-border)' : 'var(--danger-border)',
              }}
            >
              <p
                className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em]"
                style={{ color: isPartialReview ? 'var(--warning)' : 'var(--danger)' }}
              >
                {isPartialReview ? 'Partial review' : 'Error'}
              </p>
              <p className="text-sm leading-relaxed" style={{ color: isPartialReview ? 'var(--warning)' : 'var(--danger)' }}>
                {job.errorMessage}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Progress steps ── */}
      <Card className="surface-static surface-static-shadow">
        <CardHeader><CardTitle>Progress steps</CardTitle></CardHeader>
        <CardContent className="pt-0">
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground/60 italic">No steps recorded yet.</p>
          ) : (
            <div>
              {steps.map((step, idx) => (
                <StepRow key={step.name || idx} step={step} index={idx} total={steps.length} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
