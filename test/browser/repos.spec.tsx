import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReposPage } from '@client/pages/repos';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import { defaultRepoConfig, type RepoConfig, type RepoConfigRecord } from '@shared/schema';

vi.mock('@client/lib/api', () => ({
  api: {
    getRepos: vi.fn(),
    getGlobalConfig: vi.fn(),
    getModelConfigs: vi.fn(),
    updateRepoConfig: vi.fn(),
    syncRepos: vi.fn(),
  },
}));

// Seed every modal-opening fixture from the FULL default review (REVIEW #10): the expanded modal
// mounts ReviewSettingsPanel which dereferences every nested review key, so a bare `{}` crashes.
function makeReview(over: Partial<RepoConfig['review']> = {}): RepoConfig['review'] {
  return { ...defaultRepoConfig.review, ...over };
}

const REPO: RepoConfigRecord = {
  installationId: '1',
  owner: 'acme',
  repo: 'widgets',
  vcsProvider: 'github',
  parsedJson: { review: makeReview(), model: { main: null, fallbacks: [], size_overrides: [] } } as any,
  updatedAt: new Date().toISOString(),
  lastJobCreatedAt: null,
  lastJobVerdict: null,
  mainModel: null,
  fallbackModels: null,
  sizeOverrides: null,
  enabled: true,
};

function repoWithReview(overrides: Partial<RepoConfigRecord>, reviewOver: Partial<RepoConfig['review']> = {}): RepoConfigRecord {
  return {
    ...REPO,
    ...overrides,
    parsedJson: { review: makeReview(reviewOver), model: { main: null, fallbacks: [], size_overrides: [] } } as any,
  };
}

async function openEditModal() {
  const user = userEvent.setup();
  await screen.findByText('acme/widgets');
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByText('Edit repository settings');
  return user;
}

describe('ReposPage repository management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRepos).mockResolvedValue({ repos: [REPO] });
    vi.mocked(api.getGlobalConfig).mockResolvedValue({ config: { main: null, fallbacks: [], size_overrides: [] } });
    vi.mocked(api.getModelConfigs).mockResolvedValue({ providers: [], configs: [], syncErrors: [] });
    vi.mocked(api.updateRepoConfig).mockResolvedValue({ ok: true });
  });

  it('renders the repo list with its enabled state', async () => {
    renderPage(<ReposPage />);

    expect(await screen.findByText('acme/widgets')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'GitHub' })).toHaveAttribute('title', 'GitHub');
  });

  it('distinguishes same-named repositories by provider', async () => {
    vi.mocked(api.getRepos).mockResolvedValue({
      repos: [REPO, { ...REPO, installationId: '2', vcsProvider: 'bitbucket' }],
    });

    renderPage(<ReposPage />);

    expect(await screen.findAllByText('acme/widgets')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bitbucket' })).toHaveAttribute('title', 'Bitbucket');
  });

  it('toggling the enabled switch patches the repo config', async () => {
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');

    await user.click(screen.getByRole('checkbox', { name: 'Pause reviews for acme/widgets' }));

    await waitFor(() => {
      expect(api.updateRepoConfig).toHaveBeenCalledWith('acme', 'widgets', { enabled: false }, 'github');
    });
  });

  it('syncing repositories calls the sync endpoint and reloads the list', async () => {
    vi.mocked(api.syncRepos).mockResolvedValue({ ok: true, synced: ['acme/widgets'] });
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');
    vi.mocked(api.getRepos).mockClear();

    await user.click(screen.getByRole('button', { name: /Sync/i }));

    await waitFor(() => {
      expect(api.syncRepos).toHaveBeenCalled();
      expect(api.getRepos).toHaveBeenCalled();
    });
  });
});

describe('ReposPage Review Settings editor (UI-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getGlobalConfig).mockResolvedValue({ config: { main: null, fallbacks: [], size_overrides: [] } });
    vi.mocked(api.getModelConfigs).mockResolvedValue({ providers: [], configs: [], syncErrors: [] });
    vi.mocked(api.updateRepoConfig).mockResolvedValue({ ok: true });
  });

  it('renders the Review Settings sections inside the modal', async () => {
    vi.mocked(api.getRepos).mockResolvedValue({ repos: [REPO] });
    renderPage(<ReposPage />);
    await openEditModal();

    // Grouped section headings + the collapsed Advanced disclosure trigger.
    expect(screen.getByText('Triggers')).toBeInTheDocument();
    expect(screen.getByText('Limits')).toBeInTheDocument();
    expect(screen.getByText('Minimum severity')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Advanced/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('saves an edited field through the 4-arg provider PATCH, preserving untouched top-level AND nested keys (REVIEW #5)', async () => {
    // Seed a non-default top-level key (mention_trigger) and a non-default UNEXPOSED nested knob
    // (passes.critic.skip_threshold) that the panel never renders a control for.
    const seededReview = makeReview({
      max_comments: 10,
      mention_trigger: '@custom-handle',
      passes: {
        security: { enabled: false, cross_file: false },
        critic: { enabled: false, skip_threshold: 42 },
        ensemble: { runs: 1, temperature: 0.7 },
      },
    });
    vi.mocked(api.getRepos).mockResolvedValue({
      repos: [repoWithReview({}, seededReview)],
    });
    renderPage(<ReposPage />);
    const user = await openEditModal();

    const maxComments = screen.getByLabelText('Max comments');
    await user.clear(maxComments);
    await user.type(maxComments, '25');

    const applyButton = screen.getByRole('button', { name: /Apply/ });
    await waitFor(() => expect(applyButton).toBeEnabled());
    await user.click(applyButton);

    await waitFor(() => expect(api.updateRepoConfig).toHaveBeenCalled());
    const call = vi.mocked(api.updateRepoConfig).mock.calls.at(-1)!;
    expect(call[0]).toBe('acme');
    expect(call[1]).toBe('widgets');
    expect(call[3]).toBe('github');
    const savedReview = (call[2] as { review: RepoConfig['review'] }).review;
    // Edited leaf
    expect(savedReview.max_comments).toBe(25);
    // Untouched top-level key survives
    expect(savedReview.mention_trigger).toBe('@custom-handle');
    // Untouched, UNEXPOSED nested knob survives byte-for-byte (NREG-02 / REVIEW #5)
    expect(savedReview.passes.critic.skip_threshold).toBe(42);
  });

  it('keeps a simultaneous Interactive edit AND the settings edit on one Apply (REVIEW #4)', async () => {
    vi.mocked(api.getRepos).mockResolvedValue({ repos: [repoWithReview({}, makeReview({ max_comments: 10 }))] });
    renderPage(<ReposPage />);
    const user = await openEditModal();

    // Edit the Interactive panel (Commands switch, currently off in the default).
    await user.click(screen.getByRole('checkbox', { name: 'Toggle in-PR commands' }));
    // Edit a Review Settings field.
    const maxComments = screen.getByLabelText('Max comments');
    await user.clear(maxComments);
    await user.type(maxComments, '30');

    const applyButton = screen.getByRole('button', { name: /Apply/ });
    await waitFor(() => expect(applyButton).toBeEnabled());
    await user.click(applyButton);

    await waitFor(() => expect(api.updateRepoConfig).toHaveBeenCalled());
    const call = vi.mocked(api.updateRepoConfig).mock.calls.at(-1)!;
    const savedReview = (call[2] as { review: RepoConfig['review'] }).review;
    // Fresh interactive edit wins (interactive applied LAST in mergeReviewPatch)
    expect(savedReview.interactive.commands.enabled).toBe(true);
    // Settings edit also persisted
    expect(savedReview.max_comments).toBe(30);
  });

  it('saves on a Bitbucket repo through the same 4-arg provider-addressed PATCH', async () => {
    vi.mocked(api.getRepos).mockResolvedValue({
      repos: [repoWithReview({ vcsProvider: 'bitbucket', installationId: '2' }, makeReview({ max_comments: 10 }))],
    });
    renderPage(<ReposPage />);
    const user = await openEditModal();

    const maxComments = screen.getByLabelText('Max comments');
    await user.clear(maxComments);
    await user.type(maxComments, '15');

    const applyButton = screen.getByRole('button', { name: /Apply/ });
    await waitFor(() => expect(applyButton).toBeEnabled());
    await user.click(applyButton);

    await waitFor(() => expect(api.updateRepoConfig).toHaveBeenCalled());
    const call = vi.mocked(api.updateRepoConfig).mock.calls.at(-1)!;
    expect(call[0]).toBe('acme');
    expect(call[1]).toBe('widgets');
    expect(call[3]).toBe('bitbucket');
    const savedReview = (call[2] as { review: RepoConfig['review'] }).review;
    expect(savedReview.max_comments).toBe(15);
  });
});
