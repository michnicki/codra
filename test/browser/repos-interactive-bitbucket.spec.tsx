import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReposPage } from '@client/pages/repos';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import { defaultRepoConfig, type RepoConfigRecord } from '@shared/schema';

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

type InteractiveOverride = {
  commands?: Partial<{
    enabled: boolean;
    bitbucket_allowed_account_ids: string[];
    bitbucket_bot_account_id: string | null;
  }>;
  qa?: Partial<{ enabled: boolean; rate_limit_per_hour: number }>;
};

function makeParsedJson(over: InteractiveOverride = {}) {
  // Seed from the FULL default review so the expanded modal (which mounts ReviewSettingsPanel and
  // dereferences every nested review key) mounts without crashing (REVIEW #10). Only the interactive
  // block is overridden on top of the full default.
  return {
    review: {
      ...defaultRepoConfig.review,
      interactive: {
        commands: {
          enabled: false,
          bitbucket_allowed_account_ids: [],
          bitbucket_bot_account_id: null,
          ...over.commands,
        },
        qa: {
          enabled: false,
          rate_limit_per_hour: 10,
          ...over.qa,
        },
      },
    },
    model: { main: null, fallbacks: [], size_overrides: [] },
  };
}

function makeRepo(
  overrides: Partial<RepoConfigRecord> & { interactive?: InteractiveOverride } = {},
): RepoConfigRecord {
  const { interactive, ...rest } = overrides;
  return {
    installationId: '1',
    owner: 'acme',
    repo: 'widgets',
    vcsProvider: 'github',
    parsedJson: makeParsedJson(interactive) as any,
    updatedAt: new Date().toISOString(),
    lastJobCreatedAt: null,
    lastJobVerdict: null,
    mainModel: null,
    fallbackModels: null,
    sizeOverrides: null,
    enabled: true,
    ...rest,
  };
}

function mountWithRepo(repo: RepoConfigRecord) {
  vi.mocked(api.getRepos).mockResolvedValue({ repos: [repo] });
  vi.mocked(api.getGlobalConfig).mockResolvedValue({
    config: { main: null, fallbacks: [], size_overrides: [] },
  });
  vi.mocked(api.getModelConfigs).mockResolvedValue({ providers: [], configs: [], syncErrors: [] });
  vi.mocked(api.updateRepoConfig).mockResolvedValue({ ok: true });
}

async function openEditModal() {
  const user = userEvent.setup();
  await screen.findByText('acme/widgets');
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  // The modal title confirms the Edit-settings dialog (and thus InteractivePanel) mounted.
  await screen.findByText('Edit repository settings');
  return user;
}

describe('ReposPage Interactive panel — provider-conditional Bitbucket fields (D-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Bitbucket repo: renders the bot-account-id field (by its label) and the allowed-ids editor', async () => {
    mountWithRepo(makeRepo({ vcsProvider: 'bitbucket' }));
    renderPage(<ReposPage />);
    await openEditModal();

    // Queried by label text — proves the <label htmlFor="bitbucket-bot-account-id"> association.
    expect(screen.getByLabelText('Bitbucket bot account ID')).toBeInTheDocument();
    expect(screen.getByText('Allowed Bitbucket account IDs')).toBeInTheDocument();
  });

  it('GitHub repo: hides both Bitbucket fields (byte-identical panel, no gap)', async () => {
    mountWithRepo(makeRepo({ vcsProvider: 'github' }));
    renderPage(<ReposPage />);
    await openEditModal();

    expect(screen.queryByLabelText('Bitbucket bot account ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Allowed Bitbucket account IDs')).not.toBeInTheDocument();
  });

  it('editing the bot-account-id marks the panel dirty (Apply becomes enabled)', async () => {
    mountWithRepo(makeRepo({ vcsProvider: 'bitbucket' }));
    renderPage(<ReposPage />);
    const user = await openEditModal();

    const applyButton = screen.getByRole('button', { name: /Apply/ });
    expect(applyButton).toBeDisabled();

    await user.type(screen.getByLabelText('Bitbucket bot account ID'), '557058:abc');
    expect(applyButton).toBeEnabled();
  });

  it('a whitespace-only bot-account-id is reported up as null (not "") on Apply, with the provider threaded', async () => {
    mountWithRepo(
      makeRepo({ vcsProvider: 'bitbucket', interactive: { commands: { bitbucket_bot_account_id: 'existing-id-123' } } }),
    );
    renderPage(<ReposPage />);
    const user = await openEditModal();

    const input = screen.getByLabelText('Bitbucket bot account ID');
    await user.clear(input);
    await user.type(input, '   ');

    const applyButton = screen.getByRole('button', { name: /Apply/ });
    expect(applyButton).toBeEnabled();
    await user.click(applyButton);

    expect(api.updateRepoConfig).toHaveBeenCalledWith(
      'acme',
      'widgets',
      expect.objectContaining({
        review: expect.objectContaining({
          interactive: expect.objectContaining({
            commands: expect.objectContaining({ bitbucket_bot_account_id: null }),
          }),
        }),
      }),
      'bitbucket',
    );
  });

  it('shows the soft warning when the field is blank and Commands is toggled on, Apply stays enabled', async () => {
    mountWithRepo(makeRepo({ vcsProvider: 'bitbucket' }));
    renderPage(<ReposPage />);
    const user = await openEditModal();

    expect(screen.queryByText(/commands and Q&A are ignored/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Toggle in-PR commands' }));

    expect(screen.getByText(/commands and Q&A are ignored/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeEnabled();
    // Non-blocking: no per-field error surface.
    expect(screen.getByLabelText('Bitbucket bot account ID')).not.toHaveAttribute('aria-invalid');
  });

  it('shows the soft warning when the field is blank and only Q&A is on (Commands off) — corrected (commandsEnabled || qaEnabled) trigger', async () => {
    mountWithRepo(makeRepo({ vcsProvider: 'bitbucket' }));
    renderPage(<ReposPage />);
    const user = await openEditModal();

    // Commands stays OFF; enabling ONLY Q&A must still surface the warning.
    await user.click(screen.getByRole('checkbox', { name: 'Toggle pull-request Q&A' }));

    expect(screen.getByText(/commands and Q&A are ignored/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeEnabled();
  });

  it('allowed-ids editor renders the empty-state helper when the list is empty', async () => {
    mountWithRepo(makeRepo({ vcsProvider: 'bitbucket' }));
    renderPage(<ReposPage />);
    await openEditModal();

    expect(
      screen.getByText('No account IDs added yet. Add at least one to authorize command use on Bitbucket.'),
    ).toBeInTheDocument();
  });
});
