import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { JobDetailPage } from '@client/pages/job-detail';
import { api } from '@client/lib/api';
import { ThemeProvider } from '@client/lib/theme';
import type { JobDetail } from '@shared/schema';

vi.mock('@client/lib/api', () => ({
  api: {
    getJob: vi.fn(),
    rerunJob: vi.fn(),
  },
}));

const JOB_ID = '22222222-2222-2222-2222-222222222222';

const JOB: JobDetail = {
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
  files: [
    {
      id: '33333333-3333-3333-3333-333333333333',
      jobId: JOB_ID,
      filePath: 'src/index.ts',
      pass: 'main',
      fileStatus: 'done',
      modelUsed: 'gpt-4o-mini',
      diffLineCount: 12,
      diffInput: null,
      rawAiOutput: null,
      parsedComments: [
        {
          path: 'src/index.ts',
          line: 10,
          position: 3,
          severity: 'P0',
          category: 'security',
          title: 'SQL injection risk',
          body: 'User input is concatenated directly into the query string.',
          codeSuggestion: null,
        },
        {
          path: 'src/index.ts',
          line: 20,
          position: 8,
          severity: 'nit',
          category: 'quality',
          title: 'Prefer const over let',
          body: 'This binding is never reassigned.',
          codeSuggestion: null,
        },
      ],
      inputTokens: 1200,
      outputTokens: 400,
      durationMs: 2500,
      verdict: 'comment',
      fileSummary: 'Found one security issue and one style nit.',
      errorMessage: null,
      createdAt: new Date().toISOString(),
    },
  ],
};

function renderJobDetail() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[`/jobs/${JOB_ID}`]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetailPage />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('JobDetailPage findings and retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getJob).mockResolvedValue({
      status: 200,
      etag: null,
      lastModified: null,
      notModified: false,
      data: { job: JOB },
    });
  });

  it('renders the job verdict and file findings', async () => {
    renderJobDetail();

    expect(await screen.findByText('Add retry handling')).toBeInTheDocument();
    expect(screen.getByText('src/index.ts', { selector: 'summary span' })).toBeInTheDocument();
  });

  it('expands a file to reveal its inline findings', async () => {
    const user = userEvent.setup();
    renderJobDetail();

    const fileSummary = await screen.findByText('src/index.ts', { selector: 'summary span' });
    await user.click(fileSummary);

    expect(await screen.findByText('SQL injection risk')).toBeInTheDocument();
    expect(screen.getByText('Prefer const over let')).toBeInTheDocument();
  });

  it('triggers a rerun when the re-run button is clicked', async () => {
    vi.mocked(api.rerunJob).mockResolvedValue({
      job: { ...JOB, id: 'new-job-id', status: 'queued' } as JobDetail,
    });

    const user = userEvent.setup();
    renderJobDetail();

    await screen.findByText('Add retry handling');
    await user.click(screen.getByRole('button', { name: 'Re-run job' }));

    await waitFor(() => {
      expect(api.rerunJob).toHaveBeenCalledWith(JOB_ID);
    });
  });

  it('uses provider-aware repository marks and external links', async () => {
    vi.mocked(api.getJob).mockResolvedValue({
      status: 200,
      etag: null,
      lastModified: null,
      notModified: false,
      data: {
        job: {
          ...JOB,
          installationId: null,
          repositoryVcsProvider: 'bitbucket',
          repositoryWorkspace: 'acme-workspace',
          reviewId: 123,
        },
      },
    });

    renderJobDetail();

    expect(await screen.findByRole('img', { name: 'Bitbucket' })).toHaveAttribute('title', 'Bitbucket');
    expect(screen.getByRole('link', { name: /Add retry handling/i })).toHaveAttribute(
      'href',
      'https://bitbucket.org/acme-workspace/widgets/pull-requests/42',
    );
    expect(screen.getByRole('link', { name: /abc123d/i })).toHaveAttribute(
      'href',
      'https://bitbucket.org/acme-workspace/widgets/commits/abc123def456',
    );
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });
});
