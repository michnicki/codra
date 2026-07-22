import { useParams } from 'react-router-dom';
import { useJobDetail } from '@client/hooks/use-job-detail';
import { JobHeader } from '@client/components/features/job-detail/job-header';
import { JobProgress } from '@client/components/features/job-detail/job-progress';
import { JobMetaCards } from '@client/components/features/job-detail/job-meta-cards';
import { JobReviewOverview } from '@client/components/features/job-detail/job-review-overview';
import { JobSeveritySummary } from '@client/components/features/job-detail/job-severity-summary';
import { CriticPanel } from '@client/components/features/job-detail/critic-panel';
import { JobFindingsList } from '@client/components/features/job-detail/job-findings-list';
import { JobDetailSkeleton } from '@client/components/features/job-detail/job-skeleton';
import { Alert } from '@client/components/ui/alert';

export function JobDetailPage() {
  const { id = '' } = useParams();
  const {
    job,
    error,
    isRerunning,
    isStopping,
    isDeleting,
    handleRerun,
    handleStop,
    handleDelete,
  } = useJobDetail(id);

  if (!job) {
    return <JobDetailSkeleton error={error} />;
  }

  return (
    <section className="flex flex-col gap-6">
      <JobHeader
        job={job}
        isRerunning={isRerunning}
        isStopping={isStopping}
        isDeleting={isDeleting}
        onRerun={handleRerun}
        onStop={handleStop}
        onDelete={handleDelete}
      />

      {error && (
        <Alert variant="destructive">{error}</Alert>
      )}

      {/* D-05: severity/duration strip at the top, above the meta cards */}
      <JobSeveritySummary job={job} />

      <JobProgress job={job} />

      <JobMetaCards job={job} />

      <JobReviewOverview job={job} />

      {/* D-06: renders nothing when job.criticResult is absent */}
      <CriticPanel job={job} />

      <JobFindingsList job={job} />
    </section>
  );
}
