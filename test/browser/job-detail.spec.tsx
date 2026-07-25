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

// Phase 19 D-04: durable thread-verification results render independently of the audit trail and
// survive the same job-detail reload path on both providers.
describe('JobDetailPage thread verification surfaces', () => {
  const okResponse = <T,>(data: T) => ({
    status: 200 as const,
    etag: null,
    lastModified: null,
    notModified: false as const,
    data,
  });

  const threadVerification: NonNullable<JobDetail['threadVerification']> = {
    version: 1,
    status: 'completed',
    entries: [
      {
        threadRef: `opaque-fixed-${'x'.repeat(80)}`,
        path: 'src/fixed.ts',
        lineStart: 10,
        lineEnd: 10,
        verdict: 'fixed',
        reason: 'model_confirmed_fix',
        resolved: true,
      },
      {
        threadRef: 'opaque-fixed-open',
        path: 'src/fixed.ts',
        lineStart: 20,
        lineEnd: 21,
        verdict: 'fixed',
        reason: 'model_confirmed_via_window',
        resolved: false,
      },
      {
        threadRef: 'opaque-unfixed',
        path: 'src/open.ts',
        lineStart: 30,
        lineEnd: 32,
        verdict: 'unfixed',
        reason: 'issue_still_present',
        resolved: false,
      },
      {
        threadRef: 'opaque-deleted',
        path: 'src/deleted.ts',
        lineStart: null,
        lineEnd: null,
        verdict: 'unverifiable',
        reason: 'file_deleted_at_head',
        resolved: false,
      },
    ],
    totals: { fixed: 2, unfixed: 1, unverifiable: 1, resolved: 1 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['github', 'bitbucket'] as const)(
    'renders four truthful totals and every persisted verdict/reason after %s reload',
    async (provider) => {
      const user = userEvent.setup();
      vi.mocked(api.getJob).mockResolvedValue(
        okResponse({
          job: {
            ...JOB,
            repositoryVcsProvider: provider,
            repositoryWorkspace: provider === 'bitbucket' ? 'acme-workspace' : null,
            threadVerification,
          } as JobDetail,
        }),
      );

      renderJobDetail();

      const heading = await screen.findByText('Thread verification');
      const panel = heading.closest('.surface') as HTMLElement;
      expect(within(panel).getByText('Fixed').parentElement?.textContent).toBe('Fixed2');
      expect(within(panel).getByText('Unfixed').parentElement?.textContent).toBe('Unfixed1');
      expect(within(panel).getByText('Unverifiable').parentElement?.textContent).toBe('Unverifiable1');
      expect(within(panel).getByText('Resolved').parentElement?.textContent).toBe('Resolved1');

      await user.click(within(panel).getByText('Threads (4)'));
      for (const reason of [
        'model_confirmed_fix',
        'model_confirmed_via_window',
        'issue_still_present',
        'file_deleted_at_head',
      ]) {
        expect(within(panel).getByText(reason)).toBeVisible();
      }
      expect(within(panel).getAllByText('fixed')).toHaveLength(2);
      expect(within(panel).getByText('unfixed')).toBeVisible();
      expect(within(panel).getByText('unverifiable')).toBeVisible();
      expect(panel.textContent).not.toContain(`opaque-fixed-${'x'.repeat(80)}`);
    },
  );

  it('hides absent/default results and renders fail-open as visibly degraded', async () => {
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, threadVerification: null } }));
    const first = renderJobDetail();
    await screen.findByText('Add retry handling');
    expect(screen.queryByText('Thread verification')).not.toBeInTheDocument();
    first.unmount();

    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: {
          ...JOB,
          threadVerification: {
            version: 1,
            status: 'fail_open',
            reason: 'provider_unavailable',
            entries: [],
            totals: { fixed: 0, unfixed: 0, unverifiable: 0, resolved: 0 },
          },
        } as JobDetail,
      }),
    );
    renderJobDetail();

    expect(await screen.findByText('Verification unavailable (degraded)')).toBeVisible();
    expect(screen.getByText('provider_unavailable')).toBeVisible();
    expect(screen.queryByText('Fixed')).not.toBeInTheDocument();
  });

  it('normalizes every thread audit event and keeps the verified-fixed reason visible', async () => {
    const user = userEvent.setup();
    const timestamp = new Date().toISOString();
    const threadAudit: JobDetail['audit'] = [
      {
        stage: 'threads.verified_fixed',
        threadRef: `fixed-${'r'.repeat(80)}`,
        path: 'src/fixed.ts',
        line: 10,
        reason: 'model_confirmed_fix',
        timestamp,
      },
      {
        stage: 'threads.unfixed',
        threadRef: 'unfixed-ref',
        path: 'src/open.ts',
        line: 20,
        reason: 'issue_still_present',
        timestamp,
      },
      {
        stage: 'threads.unverifiable',
        threadRef: 'deleted-ref',
        path: 'src/deleted.ts',
        line: null,
        reason: 'file_deleted_at_head',
        timestamp,
      },
      {
        stage: 'threads.resolved',
        threadRef: 'resolved-ref',
        path: 'src/fixed.ts',
        line: 10,
        reason: 'verify_fixes_auto_resolve',
        timestamp,
      },
      {
        stage: 'threads.resolve_failed',
        threadRef: 'failed-ref',
        path: 'src/open.ts',
        line: 20,
        reason: 'provider_returned_false',
        timestamp,
      },
    ];
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit: threadAudit } }));

    renderJobDetail();
    const auditHeading = await screen.findByText('Audit trail');
    await user.click(auditHeading);

    expect(screen.getByText('Threads')).toBeVisible();
    for (const reason of [
      'model_confirmed_fix',
      'issue_still_present',
      'file_deleted_at_head',
      'verify_fixes_auto_resolve',
      'provider_returned_false',
    ]) {
      expect(screen.getByText(reason)).toBeVisible();
    }
    expect(document.body.textContent).not.toContain(`fixed-${'r'.repeat(80)}`);
  });
});

// Phase 19 Plan 19-04 / D-05 / D-07 / D-08: every canonical critic outcome renders exactly once
// in the UI, and legacy prune-only rows are labeled as such without fabricated verdicts.
describe('JobDetailPage critic v2 canonical outcomes', () => {
  const okResponse = <T,>(data: T) => ({
    status: 200 as const,
    etag: null,
    lastModified: null,
    notModified: false as const,
    data,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const completedDecisions = [
    { id: 0, path: 'src/a.ts', line: 10, severity: 'P1' as const, category: 'bugs' as const, title: 'proven title', body: 'b', confidence: 0.95, verdict: 'proven' as const, outcome: 'kept' as const, reason: 'evidence-supported' },
    { id: 1, path: 'src/b.ts', line: 20, severity: 'P1' as const, category: 'quality' as const, title: 'unsupported title', body: 'b', confidence: 0.5, verdict: 'unsupported' as const, outcome: 'dropped' as const, reason: 'evidence-unsupported' },
    { id: 2, path: 'src/c.ts', line: 30, severity: 'P0' as const, category: 'security' as const, title: 'plausible title', body: 'b', confidence: 0.9, verdict: 'plausible' as const, outcome: 'kept' as const, reason: 'keeps-evidence' },
    { id: 3, path: 'src/d.ts', line: 40, severity: 'P2' as const, category: 'correctness' as const, title: 'plausible threshold dropped', body: 'b', confidence: 0.7, verdict: 'plausible' as const, outcome: 'dropped' as const, reason: 'plausible-below-threshold' },
    { id: 4, path: 'src/e.ts', line: 50, severity: 'P1' as const, category: 'bugs' as const, title: 'no-verdict dropped', body: 'b', confidence: 0.9, verdict: null, outcome: 'dropped' as const, reason: 'no-verdict' },
  ];

  function makeBoundedCriticJob(overrides: any): JobDetail {
    return {
      ...JOB,
      criticResult: {
        kept: [],
        pruned: [],
        ...overrides,
      },
    } as JobDetail;
  }

  it('renders every canonical outcome exactly once for a completed run', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: makeBoundedCriticJob({
          version: 2,
          status: 'completed',
          decisions: completedDecisions,
        }),
      }),
    );

    renderJobDetail();

    const heading = await screen.findByText('Critic');
    const panel = heading.closest('.surface') as HTMLElement;

    // Each outcome total reflects the canonical decisions array.
    expect(within(panel).getByText('Kept').parentElement?.textContent).toBe('Kept2');
    expect(within(panel).getByText('Dropped').parentElement?.textContent).toBe('Dropped3');
    expect(within(panel).getByText('Proven').parentElement?.textContent).toBe('Proven1');
    expect(within(panel).getByText('Plausible').parentElement?.textContent).toBe('Plausible1');
    expect(within(panel).getByText('Unsupported').parentElement?.textContent).toBe('Unsupported1');
    expect(within(panel).getByText('No verdict').parentElement?.textContent).toBe('No verdict1');

    // Expand the decisions list and assert each canonical row renders once.
    await user.click(within(panel).getByRole('button', { name: /Decisions \(5\)/ }));
    for (const d of completedDecisions) {
      expect(within(panel).getByText(d.title)).toBeVisible();
    }
  });

  it('renders the skipped banner (kept all) for skipped runs', async () => {
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: makeBoundedCriticJob({
          version: 2,
          status: 'skipped',
          reason: 'below-skip-threshold',
          decisions: completedDecisions.map((d) => ({ ...d, verdict: null, outcome: 'kept', reason: 'below-skip-threshold' })),
        }),
      }),
    );

    renderJobDetail();

    expect(await screen.findByText('Critic skipped (kept all)')).toBeInTheDocument();
  });

  it('renders the fail-open banner (kept all) for fail_open runs', async () => {
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: makeBoundedCriticJob({
          version: 2,
          status: 'fail_open',
          reason: 'malformed',
          decisions: completedDecisions.map((d) => ({ ...d, verdict: null, outcome: 'kept', reason: 'malformed' })),
        }),
      }),
    );

    renderJobDetail();

    expect(await screen.findByText('Critic unavailable (kept all / fail-open)')).toBeInTheDocument();
  });

  it('renders legacy prune-only rows as Legacy prune-only (no fabricated verdicts)', async () => {
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: {
          ...JOB,
          criticResult: {
            kept: [
              { path: 'src/a.ts', severity: 'P1', category: 'bugs', title: 'kept finding', body: 'still relevant' },
            ],
            pruned: [
              {
                finding: { path: 'src/b.ts', severity: 'nit', category: 'quality', title: 'pruned finding', body: 'dropped' },
                reason: 'duplicate of a higher-severity finding',
              },
            ],
          },
        } as JobDetail,
      }),
    );

    renderJobDetail();

    const heading = await screen.findByText('Critic');
    const panel = heading.closest('.surface') as HTMLElement;
    expect(within(panel).getByText('Legacy prune-only')).toBeInTheDocument();
    expect(within(panel).getByText('Kept').parentElement?.textContent).toBe('Kept1');
    expect(within(panel).getByText('Pruned').parentElement?.textContent).toBe('Pruned1');
    // Legacy rows must never display a verdict tile.
    expect(within(panel).queryByText('Proven')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Plausible')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Unsupported')).not.toBeInTheDocument();
  });

  it('renders the critic-decisions audit event in the audit trail', async () => {
    const user = userEvent.setup();
    const audit: JobDetail['audit'] = [
      {
        stage: 'critic.decisions',
        status: 'completed',
        count: 5,
        reason: undefined,
        sample: completedDecisions.slice(0, 3).map((d) => ({
          id: d.id,
          path: d.path,
          line: d.line,
          title: d.title,
          verdict: d.verdict,
          outcome: d.outcome,
          reason: d.reason,
        })),
        timestamp: new Date().toISOString(),
      },
    ];
    vi.mocked(api.getJob).mockResolvedValue(
      okResponse({
        job: { ...JOB, audit } as JobDetail,
      }),
    );

    renderJobDetail();
    const auditHeading = await screen.findByText('Audit trail');
    await user.click(auditHeading);

    expect(screen.getByText('Critic')).toBeVisible();
    expect(screen.getByText('status')).toBeVisible();
    expect(screen.getByText('count')).toBeVisible();
  });
});

// Phase 20 D-01 / D-02: the ensemble.voted and walkthrough.enrichment audit events BOTH reach the
// audit-trail viewer (GAP-INT-01 + GAP-INT-02 closure). The viewer's DecisionEvent switch covers
// each new variant, and the synthetic `ensemble` / `walkthrough` display groups are reachable
// from groupAuditByStage.
describe('JobDetailPage audit-trail viewer — Phase 20 ensemble + walkthrough', () => {
  const okResponse = <T,>(data: T) => ({
    status: 200 as const,
    etag: null,
    lastModified: null,
    notModified: false as const,
    data,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a populated ensemble.voted event with file, runs, and aggregate counts', async () => {
    const user = userEvent.setup();
    const audit: JobDetail['audit'] = [
      {
        stage: 'ensemble.voted',
        file: 'src/ensemble.ts',
        requestedRuns: 3,
        successfulRuns: 2,
        failedRuns: 1,
        winnerCount: 1,
        droppedClusterCount: 1,
        winningSample: [
          {
            clusterId: 'c1',
            votes: 2,
            path: 'src/ensemble.ts',
            line: 10,
            title: 'kept null-check finding',
          },
        ],
        droppedSample: [
          {
            clusterId: 'c2',
            votes: 1,
            path: 'src/ensemble.ts',
            line: 20,
            title: 'dropped duplicate finding',
          },
        ],
        failedRunReasons: ['timeout'],
        timestamp: new Date().toISOString(),
      },
    ];
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit } }));

    renderJobDetail();
    const auditHeading = await screen.findByText('Audit trail');
    await user.click(auditHeading);

    // The aggregator group + the per-row file / runs / winner / dropped metrics are visible.
    expect(screen.getByText('Ensemble')).toBeVisible();
    expect(screen.getByText('src/ensemble.ts')).toBeVisible();
    expect(screen.getByText('2/3 ok · 1 failed')).toBeVisible();
    expect(screen.getByText('failed reasons')).toBeVisible();
    expect(screen.getByText('timeout')).toBeVisible();
    // Bound samples visible
    expect(screen.getByText(/kept null-check finding/)).toBeVisible();
    expect(screen.getByText(/dropped duplicate finding/)).toBeVisible();
  });

  it('renders an all-failed ensemble.voted event with the file identifier and aggregate counts but no samples', async () => {
    const user = userEvent.setup();
    const audit: JobDetail['audit'] = [
      {
        stage: 'ensemble.voted',
        file: 'src/all-failed.ts',
        requestedRuns: 3,
        successfulRuns: 0,
        failedRuns: 3,
        winnerCount: 0,
        droppedClusterCount: 0,
        winningSample: [],
        droppedSample: [],
        failedRunReasons: ['timeout', 'timeout', 'timeout'],
        timestamp: new Date().toISOString(),
      },
    ];
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit } }));

    renderJobDetail();
    const auditHeading = await screen.findByText('Audit trail');
    await user.click(auditHeading);

    // The group header + the file identifier + the aggregate counts are present even when both
    // samples are empty (D-02 LOW — the file identifier must be visible to distinguish file events).
    expect(screen.getByText('Ensemble')).toBeVisible();
    expect(screen.getByText('src/all-failed.ts')).toBeVisible();
    expect(screen.getByText('0/3 ok · 3 failed')).toBeVisible();
    // No sample sub-headings rendered when both samples are empty.
    expect(screen.queryByText('Winning sample')).not.toBeInTheDocument();
    expect(screen.queryByText('Dropped sample')).not.toBeInTheDocument();
  });

  it('renders a walkthrough.enrichment event with status, reason, and group count', async () => {
    const user = userEvent.setup();
    const audit: JobDetail['audit'] = [
      {
        stage: 'walkthrough.enrichment',
        status: 'completed',
        reason: undefined,
        groupCount: 3,
        timestamp: new Date().toISOString(),
      },
    ];
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit } }));

    renderJobDetail();
    const auditHeading = await screen.findByText('Audit trail');
    await user.click(auditHeading);

    expect(screen.getByText('Walkthrough enrichment')).toBeVisible();
    expect(screen.getByText('completed')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
  });

  it('renders a walkthrough.enrichment failed event with reason and no group count', async () => {
    const user = userEvent.setup();
    const audit: JobDetail['audit'] = [
      {
        stage: 'walkthrough.enrichment',
        status: 'failed',
        reason: 'model_call_failed',
        timestamp: new Date().toISOString(),
      },
    ];
    vi.mocked(api.getJob).mockResolvedValue(okResponse({ job: { ...JOB, audit } }));

    renderJobDetail();
    const auditHeading = await screen.findByText('Audit trail');
    await user.click(auditHeading);

    expect(screen.getByText('Walkthrough enrichment')).toBeVisible();
    expect(screen.getByText('failed')).toBeVisible();
    expect(screen.getByText('model_call_failed')).toBeVisible();
    // No group count surface when the run failed (status !== completed / partial).
    expect(screen.queryByText('groups')).not.toBeInTheDocument();
  });
});
