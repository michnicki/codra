import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReposPage } from '@client/pages/repos';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { RepoConfigRecord } from '@shared/schema';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@client/lib/api', () => ({
  api: {
    getRepos: vi.fn(),
    getGlobalConfig: vi.fn(),
    getModelConfigs: vi.fn(),
    updateRepoConfig: vi.fn(),
    syncRepos: vi.fn(),
  },
}));

const REPO: RepoConfigRecord = {
  installationId: '1',
  owner: 'acme',
  repo: 'widgets',
  vcsProvider: 'github',
  parsedJson: {} as any,
  updatedAt: new Date().toISOString(),
  lastJobCreatedAt: null,
  lastJobVerdict: null,
  mainModel: null,
  fallbackModels: null,
  sizeOverrides: null,
  enabled: true,
};

describe('ReposPage provider picker (D-30 / D-38)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRepos).mockResolvedValue({ repos: [REPO] });
    vi.mocked(api.getGlobalConfig).mockResolvedValue({ config: { main: null, fallbacks: [], size_overrides: [] } });
    vi.mocked(api.getModelConfigs).mockResolvedValue({ providers: [], configs: [], syncErrors: [] });
  });

  it('renders an "Add Repositories" dropdown trigger button', async () => {
    renderPage(<ReposPage />);

    expect(await screen.findByText('acme/widgets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Repositories/i })).toBeInTheDocument();
  });

  it('opening the trigger shows exactly three provider items', async () => {
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');
    await user.click(screen.getByRole('button', { name: /Add Repositories/i }));

    expect(await screen.findByRole('menuitem', { name: /Install via GitHub App/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Add Bitbucket repository/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Add Bitbucket workspace/i })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('selecting the GitHub item opens /api/repos/install in a new tab', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');
    await user.click(screen.getByRole('button', { name: /Add Repositories/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Install via GitHub App/i }));

    expect(openSpy).toHaveBeenCalledWith('/api/repos/install', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('selecting the Bitbucket item navigates to /repos/add/bitbucket', async () => {
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');
    await user.click(screen.getByRole('button', { name: /Add Repositories/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Add Bitbucket repository/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/repos/add/bitbucket');
    });
  });

  it('selecting the Bitbucket workspace item navigates to /repos/add/bitbucket-workspace', async () => {
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');
    await user.click(screen.getByRole('button', { name: /Add Repositories/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Add Bitbucket workspace/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/repos/add/bitbucket-workspace');
    });
  });
});
