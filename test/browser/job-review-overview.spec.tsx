import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JobReviewOverview } from '@client/components/features/job-detail/job-review-overview';
import type { JobDetail } from '@shared/schema';

const JOB_ID = '22222222-2222-2222-2222-222222222222';

function makeJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: JOB_ID,
    owner: 'acme',
    repo: 'widgets',
    installationId: '1',
    repositoryVcsProvider: 'github',
    repositoryWorkspace: null,
    prNumber: 42,
    prTitle: 'Add retry handling',
    prAuthor: 'octocat',
    commitSha: 'abc123def456',
    trigger: 'auto',
    status: 'done',
    verdict: 'comment',
    fileCount: 1,
    commentCount: 2,
    totalInputTokens: 1200,
    totalOutputTokens: 400,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRetryAt: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    errorMessage: null,
    steps: [],
    checkRunId: null,
    configSnapshot: null,
    retryOfJobId: null,
    baseSha: 'base123',
    headRef: 'feature-branch',
    baseRef: 'main',
    summaryMarkdown: null,
    reviewId: null,
    summaryModel: null,
    audit: [],
    auditTruncated: false,
    files: [],
    ...overrides,
  };
}

const NEW_FORMAT_SUMMARY = `### OpenCodra Review

This PR tightens input validation across the API layer.

**Verdict:** Changes requested · Confidence 82%
🚨 P0 ×1  ⚠️ P1 ×2

**Top findings**
- 🚨 P0 SQL injection risk — \`src/index.ts\`
- ⚠️ P1 Missing null check — \`src/util.ts\`

_2 files reviewed_

<details>
<summary>About OpenCodra</summary>

<br/>

[Your team has set up OpenCodra to review pull requests in this repo](https://codra.test/repos). Reviews are triggered when you open a pull request.

</details>`;

describe('JobReviewOverview', () => {
  it('renders the verdict and confidence from summary_markdown verbatim, with no separate chips or Priority Triage widget', () => {
    const job = makeJob({ summaryMarkdown: NEW_FORMAT_SUMMARY, files: [] });
    render(<JobReviewOverview job={job} />);

    expect(screen.getByText(/Changes requested/)).toBeTruthy();
    expect(screen.getByText(/82%/)).toBeTruthy();

    expect(screen.queryByText('Priority Triage')).toBeNull();
    // The old header chip rendered "Confidence" as its own standalone label text (separate from
    // the markdown body); that chip no longer exists. Exact match (not substring) so this does not
    // false-positive on the markdown paragraph "...Confidence 82%" rendered as body content.
    expect(screen.queryByText('Confidence')).toBeNull();
  });

  it('renders nothing when summaryMarkdown is null', () => {
    const job = makeJob({ summaryMarkdown: null });
    const { container } = render(<JobReviewOverview job={job} />);

    expect(container).toBeEmptyDOMElement();
  });
});
