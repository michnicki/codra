import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
          confidence: 0.82,
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

// UI-02 SC2 (Plan 16-04): per-finding category/confidence, the top severity/duration strip, and the
// Critic panel. Renders from the already-fetched jobDetail payload via the Plan 16-02 fail-open helpers.
describe('JobDetailPage severity summary, category/confidence, and critic panel', () => {
  const okResponse = <T,>(data: T) => ({
    status: 200 as const,
    etag: null,
    lastModified: null,
    notModified: false as const,
    data,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: JOB }));
  });

  it('renders the severity summary strip with all five zero-filled bands and the whole-job duration', async () => {
    renderJobDetail();

    // The scoping heading distinguishes the page-findings strip from the posted-comment count.
    const heading = await screen.findByText('Findings by severity');
    const strip = heading.closest('.surface') as HTMLElement;
    expect(strip).toBeTruthy();

    for (const band of ['P0', 'P1', 'P2', 'P3', 'nit']) {
      expect(within(strip).getByText(band)).toBeInTheDocument();
    }
    // startedAt === finishedAt in the fixture -> jobDurationMs 0 -> formatDuration '0.0s'.
    expect(within(strip).getByText('0.0s')).toBeInTheDocument();
  });

  it('shows the category tag on each finding, an 82% chip where confidence is set, and no chip where confidence is absent', async () => {
    const user = userEvent.setup();
    renderJobDetail();

    const fileSummary = await screen.findByText('src/index.ts', { selector: 'summary span' });
    await user.click(fileSummary);

    const card1 = (await screen.findByText('SQL injection risk')).closest('article') as HTMLElement;
    expect(card1.querySelector('.category-tag')).toBeTruthy();
    expect(card1.textContent).toContain('82%');

    const card2 = screen.getByText('Prefer const over let').closest('article') as HTMLElement;
    expect(card2.querySelector('.category-tag')).toBeTruthy();
    // Null confidence -> chip omitted entirely (never 'N/A'/'0%').
    expect(card2.textContent).not.toContain('%');
  });

  it('renders the critic panel with kept/pruned counts and reveals the prune reason only after expanding', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: {
          ...JOB,
          criticResult: {
            kept: [
              { path: 'a.ts', severity: 'P1', category: 'bugs', title: 'kept finding', body: 'still relevant' },
            ],
            pruned: [
              {
                finding: { path: 'b.ts', severity: 'nit', category: 'quality', title: 'pruned finding', body: 'dropped' },
                reason: 'duplicate of a higher-severity finding',
              },
            ],
          },
        } as JobDetail,
      }),
    );

    renderJobDetail();

    expect(await screen.findByText('Critic')).toBeInTheDocument();
    // Collapsed by default: the reason is not in the DOM until expand.
    expect(screen.queryByText('duplicate of a higher-severity finding')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Pruned \(1\)/ }));
    expect(await screen.findByText('duplicate of a higher-severity finding')).toBeInTheDocument();
  });

  it('shows an explicit skipped status (not a 0/0 verdict) when criticResult.skipped is true', async () => {
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: {
          ...JOB,
          criticResult: { kept: [], pruned: [], skipped: true },
        } as JobDetail,
      }),
    );

    renderJobDetail();

    expect(await screen.findByText('Critic skipped (kept all / fail-open)')).toBeInTheDocument();
  });

  it('does not render the critic panel at all when criticResult is null', async () => {
    renderJobDetail();

    await screen.findByText('Add retry handling');
    expect(screen.queryByText('Critic')).not.toBeInTheDocument();
  });
});

// AUD-02 SC3 (Plan 16-06): the audit-trail viewer at the bottom of job detail. Renders job.audit
// grouped by stage (via groupAuditByStage), decision groups expanded with reasons + sample
// identifiers, the high-volume drafted group collapsed to a count, and the truncation banner when
// auditTruncated is true. All render-only over the already-fetched jobDetail payload.
describe('JobDetailPage audit trail viewer', () => {
  const okResponse = <T,>(data: T) => ({
    status: 200 as const,
    etag: null,
    lastModified: null,
    notModified: false as const,
    data,
  });

  const AUDIT_EVENTS: JobDetail['audit'] = [
    { stage: 'drafted', file: 'src/a.ts', pass: 'main', timestamp: new Date().toISOString() },
    { stage: 'drafted', file: 'src/b.ts', pass: 'main', timestamp: new Date().toISOString() },
    {
      stage: 'filtered',
      rule: 'confidence_floor',
      count: 1,
      threshold: 0.5,
      sample: [{ path: 'src/filtered.ts', line: 12, title: 'low confidence finding' }],
      timestamp: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function openAuditTrail(user: ReturnType<typeof userEvent.setup>) {
    const heading = await screen.findByText('Audit trail');
    const details = heading.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false); // (c) outer section starts collapsed
    await user.click(heading);
    expect(details.open).toBe(true);
    return details;
  }

  it('groups events by stage with the filtered decision group expanded (reason + sample path) after opening the collapsed section', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit: AUDIT_EVENTS } }));

    renderJobDetail();
    await openAuditTrail(user);

    // (a) decision group expanded: rule (drop reason) + a sample path are visible immediately.
    // SampleIdentifier renders `path:line` (src/filtered.ts:12), so match the path prefix.
    expect(screen.getByText(/src\/filtered\.ts/)).toBeVisible();
    expect(screen.getByText('confidence_floor')).toBeVisible();
  });

  it('renders the drafted group collapsed to a count and reveals per-file rows only after toggling', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit: AUDIT_EVENTS } }));

    renderJobDetail();
    await openAuditTrail(user);

    // (b) drafted collapse asserted via the nested <details>.open, not mere presence.
    const draftedSummary = screen.getByText(/Drafted — 2 events/);
    const draftedDetails = draftedSummary.closest('details') as HTMLDetailsElement;
    expect(draftedDetails.open).toBe(false);
    expect(screen.getByText('src/a.ts')).not.toBeVisible();

    await user.click(draftedSummary);
    expect(draftedDetails.open).toBe(true);
    expect(screen.getByText('src/a.ts')).toBeVisible();
  });

  it('keeps decision group content hidden until the outer section is opened', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit: AUDIT_EVENTS } }));

    renderJobDetail();

    // (c) before opening: the outer details is closed and its decision-group content is not visible.
    const heading = await screen.findByText('Audit trail');
    const details = heading.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText(/src\/filtered\.ts/)).not.toBeVisible();

    await user.click(heading);
    expect(details.open).toBe(true);
    expect(screen.getByText(/src\/filtered\.ts/)).toBeVisible();
  });

  it('renders the truncation banner when auditTruncated is true', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({ job: { ...JOB, audit: AUDIT_EVENTS, auditTruncated: true } }),
    );

    renderJobDetail();
    await openAuditTrail(user);

    // (d) truncation banner present.
    expect(
      screen.getByText('Showing the latest 500 events — older events were evicted.'),
    ).toBeVisible();
  });

  it('renders the truncation banner AND the empty line together when audit is empty but truncated (REVIEW #9)', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({ job: { ...JOB, audit: [], auditTruncated: true } }),
    );

    renderJobDetail();
    await openAuditTrail(user);

    // (e) banner is NOT gated behind the non-empty audit array — both co-occur.
    expect(
      screen.getByText('Showing the latest 500 events — older events were evicted.'),
    ).toBeVisible();
    expect(screen.getByText('No audit events recorded for this review.')).toBeVisible();
  });

  it('renders only the neutral empty line when audit is empty and not truncated', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit: [], auditTruncated: false } }));

    renderJobDetail();
    await openAuditTrail(user);

    // (f) empty-only: the neutral line shows, the truncation banner does not.
    expect(screen.getByText('No audit events recorded for this review.')).toBeVisible();
    expect(
      screen.queryByText('Showing the latest 500 events — older events were evicted.'),
    ).not.toBeInTheDocument();
  });
});
