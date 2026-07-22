import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { StatsPage } from '@client/pages/stats';
import { api } from '@client/lib/api';
import type { StatsPayload } from '@shared/schema';
import { renderPage } from './render';

vi.mock('@client/lib/api', () => ({
  api: {
    getStats: vi.fn(),
  },
}));

// Base payload with empty severities/categories and null performance — the REVIEW #1 empty-payload
// path (db/stats.ts GROUP BY omits zero-count bands, so the array is empty, not full-of-zeros).
function baseStats(overrides: Partial<StatsPayload> = {}): StatsPayload {
  return {
    totals: { jobs: 5, inputTokens: 100, outputTokens: 50, comments: 3 },
    trend: [],
    verdicts: [],
    models: [],
    topRepos: [
      { owner: 'acme', repo: 'widgets', vcsProvider: 'github', jobs: 3 },
      { owner: 'acme', repo: 'widgets', vcsProvider: 'bitbucket', jobs: 2 },
    ],
    statuses: [],
    triggers: [],
    severities: [],
    categories: [],
    performance: { avgDurationMs: null, p95DurationMs: null, avgConfidence: null },
    ...overrides,
  };
}

const SEVERITY_BANDS = ['P0', 'P1', 'P2', 'P3', 'nit'];
const CATEGORY_BANDS = ['security', 'bugs', 'performance', 'correctness', 'quality'];

describe('StatsPage repository providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getStats).mockResolvedValue({ stats: baseStats() });
  });

  it('keeps same-named repositories visually distinct by provider', async () => {
    renderPage(<StatsPage />);

    expect(await screen.findAllByText('acme/widgets')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bitbucket' })).toBeInTheDocument();
  });
});

describe('StatsPage severity + category distributions (REVIEW #1 zero-fill)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every severity + category band on an EMPTY payload (all at 0)', async () => {
    vi.mocked(api.getStats).mockResolvedValue({ stats: baseStats() });
    renderPage(<StatsPage />);

    // The empty severities/categories arrays must still yield all five bands each — the
    // normalizers zero-fill from the static enums (never map the raw payload arrays).
    for (const band of SEVERITY_BANDS) {
      expect(await screen.findByText(band)).toBeInTheDocument();
    }
    for (const band of CATEGORY_BANDS) {
      expect(screen.getByText(band)).toBeInTheDocument();
    }
  });

  it('renders all five bands on a SPARSE payload with the others at 0', async () => {
    vi.mocked(api.getStats).mockResolvedValue({
      stats: baseStats({
        severities: [{ severity: 'P0', count: 8 }],
        categories: [{ category: 'security', count: 3 }],
      }),
    });
    renderPage(<StatsPage />);

    // All five bands still present even though only one band is in the payload.
    for (const band of SEVERITY_BANDS) {
      expect(await screen.findByText(band)).toBeInTheDocument();
    }
    for (const band of CATEGORY_BANDS) {
      expect(screen.getByText(band)).toBeInTheDocument();
    }
    // The present severity count renders (8 is unique on the page), and the absent bands render a
    // 0 track (not hidden) — at least the four other severities + four other categories.
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(8);
  });
});

describe('StatsPage performance KPI tiles (D-12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the three KPI tiles with an em-dash on null metrics', async () => {
    vi.mocked(api.getStats).mockResolvedValue({ stats: baseStats() });
    renderPage(<StatsPage />);

    expect(await screen.findByText('Avg duration')).toBeInTheDocument();
    expect(screen.getByText('p95 duration')).toBeInTheDocument();
    expect(screen.getByText('Avg confidence')).toBeInTheDocument();
    // All three metrics are null in the base payload → three em-dashes.
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('renders formatted KPI values when performance metrics are present', async () => {
    vi.mocked(api.getStats).mockResolvedValue({
      stats: baseStats({
        performance: { avgDurationMs: 4500, p95DurationMs: 9000, avgConfidence: 0.82 },
      }),
    });
    renderPage(<StatsPage />);

    expect(await screen.findByText('82%')).toBeInTheDocument();
    // No em-dash when every metric is present.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});
