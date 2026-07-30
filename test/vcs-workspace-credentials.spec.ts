import { describe, it, expect, afterEach } from 'vitest';
import { queryRows } from '@server/db/client';
import {
  listVcsWorkspaceCredentials,
  getVcsWorkspaceCredentialSecrets,
  upsertVcsWorkspaceCredential,
  deleteVcsWorkspaceCredential,
} from '@server/db/vcs-workspace-credentials';
import { EXPIRING_SOON_THRESHOLD_MS } from '@server/db/vcs-credentials';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// Unique lowercase identities per test to survive the shared TEST_DATABASE_URL without the
// (disabled) global cleanup in test/setup.ts (mirrors test/vcs-credentials.spec.ts convention).
let identityCounter = 0;
function uniqueWorkspace() {
  identityCounter += 1;
  return `ws-${Date.now()}-${identityCounter}`;
}

const createdWorkspaces: string[] = [];
function track(workspace: string) {
  createdWorkspaces.push(workspace);
  return workspace;
}

dbDescribe('vcs-workspace-credentials DB module (D-01/D-05/D-11)', () => {
  const env = createTestEnv();

  afterEach(async () => {
    for (const workspace of createdWorkspaces) {
      try {
        await queryRows(
          env,
          "DELETE FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1",
          [workspace],
        );
      } catch {
        // table may not exist yet -- ignore.
      }
    }
    createdWorkspaces.length = 0;
  });

  it('computes status "missing" when upserted with no token', async () => {
    const workspace = track(uniqueWorkspace());
    const result = await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
    });
    expect(result.status).toBe('missing');
    expect(result.hasToken).toBe(false);
    expect(result.hasWebhookSecret).toBe(false);
  });

  it('computes status "valid" when upserted with a token + future expiry', async () => {
    const workspace = track(uniqueWorkspace());
    const futureExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const result = await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-access-token',
      tokenExpiresAt: futureExpiry,
    });
    expect(result.status).toBe('valid');
    expect(result.hasToken).toBe(true);
  });

  it('computes status "expiring-soon" when upserted with a near expiry', async () => {
    const workspace = track(uniqueWorkspace());
    const nearExpiry = new Date(Date.now() + EXPIRING_SOON_THRESHOLD_MS / 2).toISOString();
    const result = await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-access-token',
      tokenExpiresAt: nearExpiry,
    });
    expect(result.status).toBe('expiring-soon');
  });

  it('computes status "expired" when upserted with a past expiry', async () => {
    const workspace = track(uniqueWorkspace());
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    const result = await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-access-token',
      tokenExpiresAt: pastExpiry,
    });
    expect(result.status).toBe('expired');
  });

  it('rotates in place on a second upsert -- exactly 1 row present, never a duplicate', async () => {
    const workspace = track(uniqueWorkspace());
    await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-first',
    });
    await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-second',
    });
    const rows = await queryRows<{ count: string }>(
      env,
      "SELECT count(*) FROM vcs_workspace_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1",
      [workspace],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('leaves an omitted field untouched on a second upsert (D-11 undefined-vs-null)', async () => {
    const workspace = track(uniqueWorkspace());
    const originalExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-token',
      tokenExpiresAt: originalExpiry,
      label: 'original-label',
    });

    // Second upsert omits tokenExpiresAt and label entirely -> both must remain untouched.
    const result = await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-token-rotated',
    });

    expect(result.label).toBe('original-label');
    expect(result.tokenExpiresAt).toBe(new Date(originalExpiry).toISOString());
  });

  it('getVcsWorkspaceCredentialSecrets returns the ciphertext fields', async () => {
    const workspace = track(uniqueWorkspace());
    await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-access',
      encryptedWebhookSecret: 'cipher-webhook',
    });

    const secret = await getVcsWorkspaceCredentialSecrets(env, { vcsProvider: 'bitbucket', workspace });
    expect(secret).not.toBeNull();
    expect(secret?.encryptedAccessToken).toBe('cipher-access');
    expect(secret?.encryptedWebhookSecret).toBe('cipher-webhook');
  });

  it('getVcsWorkspaceCredentialSecrets returns null when no row exists', async () => {
    const secret = await getVcsWorkspaceCredentialSecrets(env, {
      vcsProvider: 'bitbucket',
      workspace: 'never-created-workspace',
    });
    expect(secret).toBeNull();
  });

  it('listVcsWorkspaceCredentials returns a redacted DTO with no encrypted_* keys', async () => {
    const workspace = track(uniqueWorkspace());
    await upsertVcsWorkspaceCredential(env, {
      vcsProvider: 'bitbucket',
      workspace,
      encryptedAccessToken: 'cipher-access',
      encryptedWebhookSecret: 'cipher-webhook',
    });

    const all = await listVcsWorkspaceCredentials(env);
    const entry = all.find((c) => c.workspace === workspace);
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain('encrypted_');
    expect(entry).toMatchObject({ hasToken: true, hasWebhookSecret: true });
  });

  it('deleteVcsWorkspaceCredential returns true then false on a repeat call', async () => {
    const workspace = track(uniqueWorkspace());
    await upsertVcsWorkspaceCredential(env, { vcsProvider: 'bitbucket', workspace });

    const firstDelete = await deleteVcsWorkspaceCredential(env, { vcsProvider: 'bitbucket', workspace });
    expect(firstDelete).toBe(true);

    const secondDelete = await deleteVcsWorkspaceCredential(env, { vcsProvider: 'bitbucket', workspace });
    expect(secondDelete).toBe(false);
  });
});
