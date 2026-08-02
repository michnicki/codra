import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodeIndexPanel } from '@client/components/features/repos/code-index-panel';
import { api, type CodeIndexStatus } from '@client/lib/api';
import { renderPage } from './render';
import type { RepoConfig, VcsProvider } from '@shared/schema';

/**
 * Phase 29 (QA-IDX-01, plan 29-09) — rendered-state coverage for CodeIndexPanel: the three branch
 * states, the build action and its pending affordance, the truncated partial-index indication, the
 * recorded failure, the `mode` freshness line, and the Bitbucket push-subscription hint with both
 * of its negative renders (a hint that always shows is as wrong as one that never does).
 *
 * RUNTIME: this file runs ONLY in the vitest `browser` project (headless Chromium). CI already
 * handles the browser dependency — .github/workflows/ci.yml's `verify` job runs
 * `npx playwright install --with-deps chromium` before its Browser Tests step, and --with-deps
 * installs the system libraries. The constraint is LOCAL ONLY: on a bare workstation shell this
 * project exits 127 for missing Chromium system libraries (this host is NixOS), so run it under
 * the repo's nix shell (`nix-shell shell.nix --run "npm run test:browser"`) or via the Playwright
 * MCP. A 127 is an environment problem, never a failing assertion, and it means the local shell,
 * not CI.
 */

vi.mock('@client/lib/api', () => ({
  api: {
    buildCodeIndex: vi.fn(),
    getCodeIndexStatus: vi.fn(),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));

type IndexConfig = RepoConfig['review']['interactive']['qa']['index'];

const INDEX_ON: IndexConfig = { enabled: true, max_files: 500, chunk_lines: 50, top_k: 8 };
const INDEX_OFF: IndexConfig = { enabled: false, max_files: 500, chunk_lines: 50, top_k: 8 };

const INDEXED_SHA = '0123456789abcdef0123456789abcdef01234567';
const INDEXED_AT = '2026-07-20T12:00:00.000Z';

function statusFixture(overrides: Partial<CodeIndexStatus> = {}): CodeIndexStatus {
  return {
    status: 'ready',
    mode: 'full',
    indexedSha: INDEXED_SHA,
    indexedAt: INDEXED_AT,
    fileCount: 42,
    chunkCount: 314,
    truncated: false,
    lastError: null,
    ...overrides,
  };
}

const NEVER_BUILT = statusFixture({
  status: 'idle',
  mode: null,
  indexedSha: null,
  indexedAt: null,
  fileCount: 0,
  chunkCount: 0,
});

function mountPanel(overrides: Partial<{
  config: IndexConfig;
  vcsProvider: VcsProvider;
  onIndexChange: (index: IndexConfig) => void;
  onRefreshed: () => void;
}> = {}) {
  const onIndexChange = overrides.onIndexChange ?? vi.fn();
  const onRefreshed = overrides.onRefreshed ?? vi.fn();
  const result = renderPage(
    <CodeIndexPanel
      owner="michnicki"
      repo="opencodra"
      vcsProvider={overrides.vcsProvider ?? 'github'}
      config={overrides.config ?? INDEX_ON}
      onIndexChange={onIndexChange}
      onRefreshed={onRefreshed}
    />,
  );
  return { ...result, onIndexChange, onRefreshed };
}

describe('CodeIndexPanel rendered states (QA-IDX-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: NEVER_BUILT });
    vi.mocked(api.buildCodeIndex).mockResolvedValue({
      ok: true,
      coalesced: false,
      build: { mode: 'full', workflowInstanceId: 'wf-1' },
    });
  });

  it('toggle off: shows the disabled card and no build control', () => {
    mountPanel({ config: INDEX_OFF });

    expect(screen.getByText('Codebase index is disabled')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Enable codebase index' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Build codebase index' })).not.toBeInTheDocument();
  });

  it('toggle on with no index: shows the never-built card and an enabled build control', async () => {
    mountPanel();

    await screen.findByText('No index built yet');
    expect(screen.getByRole('checkbox', { name: 'Enable codebase index' })).toBeChecked();
    expect(screen.getAllByRole('button', { name: 'Build codebase index' })[0]).toBeEnabled();
  });

  it('built status: shows the short commit, the counts and the last-built time', async () => {
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: statusFixture() });
    mountPanel();

    await screen.findByText(INDEXED_SHA.slice(0, 7));
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('42 files / 314 chunks')).toBeInTheDocument();
    expect(screen.getByText(new Date(INDEXED_AT).toLocaleString())).toBeInTheDocument();
  });

  it('pressing build issues exactly one post and the control enters its pending affordance', async () => {
    let resolveBuild: ((value: { ok: boolean; coalesced: boolean; build: { mode: 'full'; workflowInstanceId: string } }) => void) | undefined;
    vi.mocked(api.buildCodeIndex).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        }),
    );
    mountPanel();

    const buildButton = (await screen.findAllByRole('button', { name: 'Build codebase index' }))[0];
    await userEvent.click(buildButton);

    // Pending affordance: spinner copy and a disabled control while the post is in flight.
    expect(await screen.findAllByText('Building...')).not.toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Build codebase index' })[0]).toBeDisabled();
    expect(api.buildCodeIndex).toHaveBeenCalledTimes(1);
    expect(api.buildCodeIndex).toHaveBeenCalledWith('michnicki', 'opencodra', 'github');

    resolveBuild?.({ ok: true, coalesced: false, build: { mode: 'full', workflowInstanceId: 'wf-1' } });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Index build started.'));
  });

  it('truncated status: renders the partial-index indication with the honest copy', async () => {
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({
      index: statusFixture({ truncated: true }),
    });
    mountPanel();

    const indication = await screen.findByText(/Partial index/);
    expect(indication.textContent).toMatch(/covers only part of the repository/);
    expect(indication.textContent).toMatch(/rebuilding will truncate the same way/i);
  });

  it('failed status: renders the recorded message unmodified', async () => {
    const recorded = 'Provider error: rate limited';
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({
      index: statusFixture({ status: 'failed', lastError: recorded }),
    });
    mountPanel();

    expect(await screen.findByText(recorded)).toBeInTheDocument();
  });

  it('renders a distinct freshness string for each of mode full, incremental and null', async () => {
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: statusFixture({ mode: 'full' }) });
    const first = mountPanel();
    expect(await screen.findByText('Last refresh: dashboard rebuild')).toBeInTheDocument();
    first.unmount();

    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: statusFixture({ mode: 'incremental' }) });
    const second = mountPanel();
    expect(await screen.findByText('Last refresh: push refresh')).toBeInTheDocument();
    second.unmount();

    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: NEVER_BUILT });
    mountPanel();
    expect(await screen.findByText('Last refresh: never built')).toBeInTheDocument();
  });

  it('Bitbucket push-subscription hint: shown at mode full on Bitbucket, hidden on GitHub and after a push refresh', async () => {
    const hintText = /Bitbucket webhook subscription to include the repository push event/;

    // Positive: Bitbucket repository whose index has only ever been dashboard-built.
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: statusFixture({ mode: 'full' }) });
    const positive = mountPanel({ vcsProvider: 'bitbucket' });
    expect(await screen.findByText(hintText)).toBeInTheDocument();
    positive.unmount();

    // Negative 1: the same status on a GitHub repository.
    const negativeGithub = mountPanel({ vcsProvider: 'github' });
    await screen.findByText(INDEXED_SHA.slice(0, 7));
    expect(screen.queryByText(hintText)).not.toBeInTheDocument();
    negativeGithub.unmount();

    // Negative 2: a Bitbucket repository once a push refresh has occurred.
    vi.mocked(api.getCodeIndexStatus).mockResolvedValue({ index: statusFixture({ mode: 'incremental' }) });
    mountPanel({ vcsProvider: 'bitbucket' });
    await screen.findByText(INDEXED_SHA.slice(0, 7));
    expect(screen.queryByText(hintText)).not.toBeInTheDocument();
  });
});
