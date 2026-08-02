import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddBitbucketWorkspacePage } from '@client/pages/repos/add-bitbucket-workspace';
import { api } from '@client/lib/api';
import { renderPage } from './render';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@client/lib/api', () => ({
  api: {
    discoverBitbucketWorkspaceRepos: vi.fn(),
    addBitbucketWorkspace: vi.fn(),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const MIXED_REPOS = [
  { slug: 'alpha-repo', name: 'alpha-repo', alreadyOnboarded: false },
  { slug: 'zeta-repo', name: 'zeta-repo', alreadyOnboarded: true },
];

async function fillAndDiscover(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('my-workspace'), 'my-ws');
  await user.type(screen.getByPlaceholderText('Workspace Access Token'), 'tok-value');
  await user.type(screen.getByPlaceholderText('Workspace webhook secret'), 'sec-value');
  await user.click(screen.getByRole('button', { name: /Discover repositories/i }));
}

describe('AddBitbucketWorkspacePage (D-31-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders both rows after discovery, "Already added" badge on the onboarded one, both unchecked by default', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: MIXED_REPOS });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);

    await waitFor(() => {
      expect(screen.getByText('alpha-repo')).toBeInTheDocument();
      expect(screen.getByText('zeta-repo')).toBeInTheDocument();
    });

    expect(screen.getByText('Already added')).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    for (const checkbox of checkboxes) {
      expect(checkbox).not.toBeChecked();
    }
    expect(screen.getByText('0 selected')).toBeInTheDocument();
  });

  it('"Select all" checks every row and updates the counter/submit label', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: MIXED_REPOS });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);
    await waitFor(() => expect(screen.getByText('alpha-repo')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Select all' }));

    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).toBeChecked();
    }
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add 2 repositories/i })).not.toBeDisabled();
  });

  it('"Select none" after "Select all" unchecks every row and disables the submit button', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: MIXED_REPOS });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);
    await waitFor(() => expect(screen.getByText('alpha-repo')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Select none' }));

    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).not.toBeChecked();
    }
    const submitButton = screen.getByRole('button', { name: /Select repositories to add/i });
    expect(submitButton).toBeDisabled();
  });

  it('checking exactly one row shows "Add 1 repository"', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: MIXED_REPOS });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);
    await waitFor(() => expect(screen.getByText('alpha-repo')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: 'Select alpha-repo' }));

    expect(screen.getByRole('button', { name: /Add 1 repository$/i })).not.toBeDisabled();
  });

  it('a repo name of 150+ synthetic characters renders with the truncate class on its containing element', async () => {
    const longName = 'x'.repeat(160);
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({
      repos: [{ slug: 'long-repo', name: longName, alreadyOnboarded: false }],
    });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);

    const nameEl = await screen.findByText(longName);
    expect(nameEl).toHaveClass('truncate');
  });

  it('checking two rows in reverse alphabetical order submits selectedRepoSlugs SORTED, not in check order', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: MIXED_REPOS });
    vi.mocked(api.addBitbucketWorkspace).mockResolvedValue({
      credential: {
        vcsProvider: 'bitbucket',
        workspace: 'my-ws',
        hasToken: true,
        hasWebhookSecret: true,
        tokenExpiresAt: null,
        label: null,
        status: 'valid',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      repositoryCount: 2,
    });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);
    await waitFor(() => expect(screen.getByText('alpha-repo')).toBeInTheDocument());

    // Check zeta-repo (alphabetically later) FIRST, then alpha-repo -- reverse of alphabetical.
    await user.click(screen.getByRole('checkbox', { name: 'Select zeta-repo' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select alpha-repo' }));

    await user.click(screen.getByRole('button', { name: /Add 2 repositories/i }));

    await waitFor(() => {
      expect(api.addBitbucketWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedRepoSlugs: ['alpha-repo', 'zeta-repo'],
        }),
      );
    });
  });

  it('a rejected addBitbucketWorkspace call renders the destructive Alert with the exact copy and preserves the checked selection', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: MIXED_REPOS });
    vi.mocked(api.addBitbucketWorkspace).mockRejectedValue(new Error('boom'));

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);
    await waitFor(() => expect(screen.getByText('alpha-repo')).toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: 'Select alpha-repo' }));
    await user.click(screen.getByRole('button', { name: /Add 1 repository/i }));

    expect(await screen.findByText('Could not add workspace.')).toBeInTheDocument();
    expect(
      screen.getByText("Your token and webhook weren't saved. Please try again."),
    ).toBeInTheDocument();

    expect(screen.getByRole('checkbox', { name: 'Select alpha-repo' })).toBeChecked();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('a rejected discoverBitbucketWorkspaceRepos call renders the destructive Alert with exact copy and preserves the typed workspace/token values', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockRejectedValue(new Error('boom'));

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);

    expect(await screen.findByText('Could not list repositories.')).toBeInTheDocument();
    expect(
      screen.getByText('Check the workspace slug and access token, then try again.'),
    ).toBeInTheDocument();

    expect(screen.getByPlaceholderText('my-workspace')).toHaveValue('my-ws');
    expect(screen.getByPlaceholderText('Workspace Access Token')).toHaveValue('tok-value');
  });

  it('a successful discovery resolving with zero repos renders the empty state with exact copy and no repo rows', async () => {
    vi.mocked(api.discoverBitbucketWorkspaceRepos).mockResolvedValue({ repos: [] });

    const user = userEvent.setup();
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });
    await fillAndDiscover(user);

    expect(await screen.findByText('No repositories found')).toBeInTheDocument();
    expect(
      screen.getByText(
        "This workspace doesn't have any repositories, or the token can't see any. Double-check the workspace slug and the token's scopes, then try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('renders the Step 1 instructional Alert with the required webhook scope and automatic-webhook-creation copy before any discovery happens', async () => {
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });

    expect(
      await screen.findByText(/at least/i, { selector: 'p' }),
    ).toBeInTheDocument();
    const instructionalParagraph = screen.getByText(/at least/i, { selector: 'p' });
    expect(instructionalParagraph.textContent).toContain('webhook');
    expect(instructionalParagraph.textContent).toContain(
      'you do not need to create the webhook yourself',
    );
    expect(instructionalParagraph.textContent).toContain(
      'Codra creates a workspace webhook',
    );
    expect(instructionalParagraph.textContent).toContain('automatically');
    expect(api.discoverBitbucketWorkspaceRepos).not.toHaveBeenCalled();
  });

  it('the PageHeader description retains the "whole workspace" scope-transparency framing verbatim', () => {
    renderPage(<AddBitbucketWorkspacePage />, { route: '/repos/add/bitbucket-workspace' });

    expect(
      screen.getByText(
        'Store a workspace access token and webhook secret so OpenCodra can discover and review pull requests across the whole workspace.',
      ),
    ).toBeInTheDocument();
  });
});
