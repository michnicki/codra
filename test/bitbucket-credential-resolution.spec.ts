import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveBitbucketBotCredential,
  resolveBitbucketWebhookSecretCandidates,
} from '@server/core/bitbucket-credential-resolution';
import { createTestEnv } from './helpers';

// Mock both credential DB modules so this test depends on neither Postgres nor the encryption key
// (mirrors test/vcs-service.spec.ts's mocking style). vi.mock calls are hoisted above imports by
// vitest, so declaration order here does not matter.
const getVcsCredentialSecretsMock = vi.fn();
const getVcsWorkspaceCredentialSecretsMock = vi.fn();
vi.mock('@server/db/vcs-credentials', () => ({
  getVcsCredentialSecrets: (...args: unknown[]) => getVcsCredentialSecretsMock(...args),
}));
vi.mock('@server/db/vcs-workspace-credentials', () => ({
  getVcsWorkspaceCredentialSecrets: (...args: unknown[]) => getVcsWorkspaceCredentialSecretsMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const perRepoSecret = {
  vcsProvider: 'bitbucket' as const,
  workspace: 'ws-foo',
  repoSlug: 'repo-bar',
  hasToken: true,
  hasWebhookSecret: true,
  tokenExpiresAt: null,
  label: null,
  status: 'valid' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  encryptedAccessToken: 'v1:iv:per-repo-token',
  encryptedWebhookSecret: 'v1:iv:per-repo-webhook-secret',
};

const workspaceSecret = {
  vcsProvider: 'bitbucket' as const,
  workspace: 'ws-foo',
  hasToken: true,
  hasWebhookSecret: true,
  tokenExpiresAt: null,
  label: null,
  status: 'valid' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  encryptedAccessToken: 'v1:iv:workspace-token',
  encryptedWebhookSecret: 'v1:iv:workspace-webhook-secret',
};

describe('resolveBitbucketBotCredential (D-03 precedence)', () => {
  const env = createTestEnv();
  const key = { workspace: 'ws-foo', repoSlug: 'repo-bar' };

  it('returns the per-repo secret and does NOT call the workspace lookup when per-repo is present', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(perRepoSecret);

    const result = await resolveBitbucketBotCredential(env, key);

    expect(result).toBe(perRepoSecret);
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(getVcsWorkspaceCredentialSecretsMock).not.toHaveBeenCalled();
  });

  it('falls back to the workspace secret when the per-repo row exists but its access token was cleared', async () => {
    // A per-repo row can outlive its token (clearToken: true on POST /api/vcs-credentials keeps
    // the row, e.g. to retain a webhook secret, while nulling the access token). Regression for
    // the bug where `if (perRepo)` short-circuited on the row's mere existence, permanently
    // blocking the workspace fallback even when a valid workspace credential was available.
    getVcsCredentialSecretsMock.mockResolvedValue({ ...perRepoSecret, hasToken: false, encryptedAccessToken: null });
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(workspaceSecret);

    const result = await resolveBitbucketBotCredential(env, key);

    expect(result).toBe(workspaceSecret);
    expect(getVcsWorkspaceCredentialSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the workspace secret when only workspace-level is present', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(null);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(workspaceSecret);

    const result = await resolveBitbucketBotCredential(env, key);

    expect(result).toBe(workspaceSecret);
    expect(getVcsWorkspaceCredentialSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('returns the per-repo secret (D-03) when BOTH are present with different values', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(perRepoSecret);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(workspaceSecret);

    const result = await resolveBitbucketBotCredential(env, key);

    expect(result).toBe(perRepoSecret);
    expect(getVcsWorkspaceCredentialSecretsMock).not.toHaveBeenCalled();
  });

  it('returns null when neither is present', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(null);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(null);

    const result = await resolveBitbucketBotCredential(env, key);

    expect(result).toBeNull();
  });
});

describe('resolveBitbucketWebhookSecretCandidates (always queries both, never short-circuits)', () => {
  const env = createTestEnv();
  const key = { workspace: 'ws-foo', repoSlug: 'repo-bar' };

  it('returns both encrypted secrets when both sources are present', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(perRepoSecret);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(workspaceSecret);

    const result = await resolveBitbucketWebhookSecretCandidates(env, key);

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        perRepoSecret.encryptedWebhookSecret,
        workspaceSecret.encryptedWebhookSecret,
      ]),
    );
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(getVcsWorkspaceCredentialSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('returns a length-1 array when only one source is present', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(perRepoSecret);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(null);

    const result = await resolveBitbucketWebhookSecretCandidates(env, key);

    expect(result).toEqual([perRepoSecret.encryptedWebhookSecret]);
    // Both mocks were still called even though only one source had data (never short-circuited).
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(getVcsWorkspaceCredentialSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] when neither source is present', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(null);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(null);

    const result = await resolveBitbucketWebhookSecretCandidates(env, key);

    expect(result).toEqual([]);
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(getVcsWorkspaceCredentialSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('always queries both sources unconditionally regardless of outcome', async () => {
    getVcsCredentialSecretsMock.mockResolvedValue(null);
    getVcsWorkspaceCredentialSecretsMock.mockResolvedValue(workspaceSecret);

    await resolveBitbucketWebhookSecretCandidates(env, key);

    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(getVcsWorkspaceCredentialSecretsMock).toHaveBeenCalledTimes(1);
  });
});
