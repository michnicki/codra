import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReposPage } from '@client/pages/repos';
import { StatsPage } from '@client/pages/stats';
import { CommentCard } from '@client/components/features/job-detail/comment-card';
import { AuditTrailViewer } from '@client/components/features/job-detail/audit-trail-viewer';
import { api } from '@client/lib/api';
import {
  defaultRepoConfig,
  type JobDetail,
  type RepoConfigRecord,
  type StatsPayload,
} from '@shared/schema';
import { renderPage } from './render';
import {
  loadProductionStylesheet,
  removeProductionStylesheet,
  VISUAL_BACKSTOP_WINDOW_KEY,
} from '../support/visual-backstop-runtime';

vi.mock('@client/lib/api', () => ({
  api: {
    getRepos: vi.fn(),
    getGlobalConfig: vi.fn(),
    getModelConfigs: vi.fn(),
    updateRepoConfig: vi.fn(),
    syncRepos: vi.fn(),
    getStats: vi.fn(),
  },
}));

// D-09 invocation gate: CI/local launchers must require
// `process.env.VITEST_BROWSER_OK === '1'` before invoking this file. Supported command:
// `VITEST_BROWSER_OK=1 nix-shell shell.nix --run 'npx vitest run --project browser test/browser/visual-backstops.spec.tsx'`.
// This suite deliberately has no conditional suite skips: a Chromium launch failure (including a
// missing libgbm.so.1) must fail visibly and be captured in 20-VISUAL-EVIDENCE.md, never count as pass.

const THEMES = ['light', 'dark'] as const;
type TestTheme = (typeof THEMES)[number];

const LONG_SKIP_GLOB = `generated/${'deeply-nested-generated-directory/'.repeat(17)}**/*.generated.ts`;
const LONG_CUSTOM_RULE = `Flag this generated boundary because ${'untrusted-input-must-remain-escaped '.repeat(15)}`.trim();
const LONG_TITLE = `Reject the unsafe fallback because ${'the-authorization-boundary-remains-unverified '.repeat(12)}`.trim();
const LONG_FILE_PATH = `src/${'provider-boundary/'.repeat(28)}review-handler-with-a-long-name.ts`;
const LONG_AUDIT_PATH = `src/${'audit-boundary/'.repeat(30)}decision-recorder.ts`;
const LONG_AUDIT_REASON = `provider_rejected_${'bounded_structural_metadata_'.repeat(7)}without_retry`;
// Phase 35 backstop B-1: the agentic_context arm bounds `reason` to 200 characters, so this is the
// worst legal value that surface can ever be asked to render.
const LONG_AGENTIC_REASON = `budget_exhausted_${'x'.repeat(200 - 'budget_exhausted_'.length)}`;

// Phase 20.1 WARNING 1 closure: load the production Vite/Tailwind build instead of injecting
// hardcoded utility CSS. The vitest server has a Vite plugin (`test/support/visual-backstop-vite-plugin.ts`)
// that serves `dist/client/` at `${window.__VISUAL_BACKSTOP_BASE__}` — the path segment is
// injected into the iframe HTML via `transformIndexHtml`. We derive the served origin from
// `window.location.origin`, fetch the served `/index.html` to discover the hashed CSS asset,
// and inject the production stylesheet as a real `<link>` element on the test document. The
// computed-style assertions below now prove the production Tailwind build applies the
// expected CSS — not just that some stylesheet (real or hardcoded) assigns the declaration.
let productionStylesheetLink: HTMLLinkElement | null = null;

beforeAll(async () => {
  const basePath = (window as unknown as Record<string, string | undefined>)[VISUAL_BACKSTOP_WINDOW_KEY];
  if (!basePath) {
    throw new Error(
      [
        'visual-backstops.spec.tsx: window.__VISUAL_BACKSTOP_BASE__ was not injected.',
        'The Vite plugin at test/support/visual-backstop-vite-plugin.ts must be loaded by vitest.config.ts.',
        'Check vitest.config.ts has plugins: [react(), visualBackstopPlugin()].',
      ].join('\n'),
    );
  }
  productionStylesheetLink = await loadProductionStylesheet(`${window.location.origin}${basePath}`);
}, 120_000);

afterAll(() => {
  removeProductionStylesheet(productionStylesheetLink);
  productionStylesheetLink = null;
});

function setTheme(theme: TestTheme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.setAttribute('data-theme', theme);
  localStorage.setItem('codra-theme', theme);
}

afterEach(() => {
  const root = document.documentElement;
  root.classList.remove('dark', 'theme-changing');
  root.removeAttribute('data-theme');
  localStorage.removeItem('codra-theme');
  vi.clearAllMocks();
});

function makeRepo(): RepoConfigRecord {
  return {
    installationId: '1',
    owner: 'acme',
    repo: 'visual-backstops',
    vcsProvider: 'github',
    parsedJson: {
      review: {
        ...defaultRepoConfig.review,
        skip_files: [LONG_SKIP_GLOB],
        custom_rules: [LONG_CUSTOM_RULE],
      },
      model: { main: null, fallbacks: [], size_overrides: [] },
    },
    updatedAt: new Date().toISOString(),
    lastJobCreatedAt: null,
    lastJobVerdict: null,
    mainModel: null,
    fallbackModels: null,
    sizeOverrides: null,
    enabled: true,
  };
}

function makeStats(): StatsPayload {
  return {
    totals: { jobs: 1, inputTokens: 100, outputTokens: 25, comments: 1 },
    trend: [],
    verdicts: [],
    models: [],
    topRepos: [],
    statuses: [],
    triggers: [],
    severities: [],
    categories: [],
    performance: {
      avgDurationMs: 444_359_999,
      p95DurationMs: 888_719_999,
      avgConfidence: 0.98,
    },
  };
}

describe('repo-settings-modal-long-text', () => {
  it.each(THEMES)('keeps long list entries bounded in %s mode', async (theme) => {
    setTheme(theme);
    vi.mocked(api.getRepos).mockResolvedValue({ repos: [makeRepo()] });
    vi.mocked(api.getGlobalConfig).mockResolvedValue({
      config: { main: null, fallbacks: [], size_overrides: [] },
    });
    vi.mocked(api.getModelConfigs).mockResolvedValue({ providers: [], configs: [], syncErrors: [] });
    vi.mocked(api.updateRepoConfig).mockResolvedValue({ ok: true });

    renderPage(<ReposPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit repository settings' });
    const skipGlob = within(dialog).getByText(LONG_SKIP_GLOB);
    const customRule = within(dialog).getByText(LONG_CUSTOM_RULE);

    expect(skipGlob).toHaveClass('break-all', 'min-w-0');
    expect(customRule).toHaveClass('break-all', 'min-w-0');
    expect(getComputedStyle(skipGlob).wordBreak).toBe('break-all');
    expect(parseFloat(getComputedStyle(skipGlob).minWidth)).toBe(0);
    expect(getComputedStyle(customRule).wordBreak).toBe('break-all');
    expect(parseFloat(getComputedStyle(customRule).minWidth)).toBe(0);
  });
});

describe('comment-card-long-text', () => {
  it.each(THEMES)('clamps the title and breaks the file path in %s mode', (theme) => {
    setTheme(theme);

    renderPage(
      <CommentCard
        filePath={LONG_FILE_PATH}
        comment={{
          path: LONG_FILE_PATH,
          line: 42,
          position: 8,
          severity: 'P1',
          category: 'security',
          title: LONG_TITLE,
          body: 'The authorization check must remain at the provider boundary.',
          codeSuggestion: null,
          confidence: 0.94,
        }}
      />,
    );

    const title = screen.getByText(LONG_TITLE);
    const filePath = screen.getByText(LONG_FILE_PATH);

    expect(title).toHaveClass('line-clamp-2');
    expect(filePath).toHaveClass('break-all');
    expect(getComputedStyle(title).webkitLineClamp).toBe('2');
    expect(getComputedStyle(filePath).wordBreak).toBe('break-all');
  });
});

describe('audit-trail-viewer-long-text', () => {
  it.each(THEMES)('breaks bounded reason and path values in %s mode', async (theme) => {
    setTheme(theme);
    const timestamp = new Date().toISOString();
    const job = {
      audit: [
        {
          stage: 'threads.resolve_failed',
          threadRef: 'opaque-thread-ref',
          path: LONG_AUDIT_PATH,
          line: 77,
          reason: LONG_AUDIT_REASON,
          timestamp,
        },
      ],
      auditTruncated: false,
    } as JobDetail;

    renderPage(<AuditTrailViewer job={job} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('Audit trail'));

    const reason = screen.getByText(LONG_AUDIT_REASON);
    const filePath = screen.getByText(`${LONG_AUDIT_PATH}:77`);

    expect(reason).toHaveClass('break-all');
    expect(filePath).toHaveClass('break-all');
    expect(getComputedStyle(reason).wordBreak).toBe('break-all');
    expect(getComputedStyle(filePath).wordBreak).toBe('break-all');
  });
});

// Phase 35 (PRD-06 / 35-06) backstop B-1. The `agentic_context` row copies its token-only utilities
// verbatim from the `cross_file_security` case, so BOTH themes should invert with no extra
// declaration and the schema-bounded 200-character `reason` should wrap inside the row via
// `MetricLine`'s `break-all` — but that is an INFERENCE until it is rendered against the real
// production Tailwind build, which is exactly what this suite loads.
describe('audit-trail-agentic-context-row', () => {
  it.each(THEMES)('wraps a 200-char reason inside the row and stays achromatic in %s mode', async (theme) => {
    setTheme(theme);
    const job = {
      audit: [
        {
          stage: 'agentic_context',
          status: 'failed',
          reason: LONG_AGENTIC_REASON,
          hops_used: 0,
          files_read: 0,
          greps_run: 0,
          bytes_gathered: 0,
          truncated: false,
          grep_supported: false,
          budget_headroom: 0,
          timestamp: new Date().toISOString(),
        },
      ],
      auditTruncated: false,
    } as unknown as JobDetail;

    renderPage(<AuditTrailViewer job={job} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('Audit trail'));

    const reason = screen.getByText(LONG_AGENTIC_REASON);
    expect(reason).toHaveClass('break-all');
    expect(getComputedStyle(reason).wordBreak).toBe('break-all');

    // The row must not grow wider than the group shell that contains it — a 200-char token that
    // stretched the viewer is the failure mode B-1 exists to rule out.
    const row = reason.closest('li') as HTMLElement;
    const group = row.closest('div.rounded-md') as HTMLElement;
    expect(row.getBoundingClientRect().width).toBeLessThanOrEqual(
      group.getBoundingClientRect().width + 1,
    );

    // Achromatic in BOTH themes: `failed` here is a D-11 fail-open, not a job failure, and
    // `grep_supported: false` is the expected Bitbucket steady state. Neither may be coloured, and
    // the row must carry no inline style of its own (the trail's only inline-style element is the
    // truncation banner).
    expect(row.getAttribute('style')).toBeNull();
    expect(row.querySelector('svg')).toBeNull();
    // Indexed by position rather than by text: `truncated: false` and `grep supported: false`
    // render the same token, so a text query is ambiguous by construction.
    const values = Array.from(row.querySelectorAll('span.font-mono'));
    expect(values.map((el) => el.textContent)).toEqual([
      'failed',
      LONG_AGENTIC_REASON,
      '0',
      '0',
      '0',
      '0',
      'false',
      'false',
      '0',
    ]);
    const statusValue = values[0] as HTMLElement;
    const grepValue = values[7] as HTMLElement;
    expect(getComputedStyle(statusValue).color).toBe(getComputedStyle(grepValue).color);
    // Same colour as an ordinary neutral value in the same row — no severity map anywhere.
    expect(getComputedStyle(statusValue).color).toBe(getComputedStyle(reason).color);
  });
});

describe('stats-kpi-large-value', () => {
  it.each(THEMES)('keeps multi-hour values inside the KPI tile in %s mode', async (theme) => {
    setTheme(theme);
    vi.mocked(api.getStats).mockResolvedValue({ stats: makeStats() });

    renderPage(<StatsPage />);

    const label = await screen.findByText('Avg duration');
    const tile = label.closest('article') as HTMLElement;
    const value = within(tile).getByText('123h 26m');

    expect(tile).toHaveClass('overflow-hidden');
    expect(value).toHaveClass('break-words');
    expect(getComputedStyle(tile).overflow).toBe('hidden');
  });
});