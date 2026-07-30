import type { AppBindings } from '@server/env';
import { queryRows } from './client';
import { computeCredentialStatus } from './vcs-credentials';
import {
  vcsWorkspaceCredentialStatusSchema,
  type VcsWorkspaceCredentialStatus,
} from '@shared/schema';

// Raw row shape for the vcs_workspace_credentials table (migration 019). Secrets are
// stored/read as ciphertext only; the encrypted_* columns never leave this module except
// through getVcsWorkspaceCredentialSecrets, which is internal-only (decrypt/rotate) and must
// never be serialized into a response (mirrors vcs-credentials.ts D-10 / T-04-01).
type VcsWorkspaceCredentialRow = {
  vcs_provider: 'bitbucket';
  workspace: string;
  encrypted_access_token: string | null;
  encrypted_webhook_secret: string | null;
  // postgres.js decodes TIMESTAMPTZ columns into JS `Date` objects, not strings (IN-02, mirrored
  // from vcs-credentials.ts). The DTO boundary (mapWorkspaceCredentialStatus ->
  // vcsWorkspaceCredentialStatusSchema) normalizes these to ISO strings via `dateStringSchema`.
  token_expires_at: Date | null;
  label: string | null;
  created_at: Date;
  updated_at: Date;
};

export type VcsWorkspaceCredentialKey = {
  vcsProvider: 'bitbucket';
  workspace: string;
};

// Internal-only secret view (mirrors VcsCredentialSecret in vcs-credentials.ts). Exposes the
// ciphertext columns for decrypt/rotate paths ONLY. NEVER route this into an HTTP response.
export type VcsWorkspaceCredentialSecret = VcsWorkspaceCredentialStatus & {
  encryptedAccessToken: string | null;
  encryptedWebhookSecret: string | null;
};

// Redacted read mapper (mirrors mapCredentialStatus in vcs-credentials.ts): returns presence
// booleans + computed status + expiry/label, NEVER ciphertext or plaintext. Reuses the SAME
// computeCredentialStatus date-math vcs_credentials already uses -- no duplicated threshold logic.
function mapWorkspaceCredentialStatus(row: VcsWorkspaceCredentialRow): VcsWorkspaceCredentialStatus {
  const hasToken = Boolean(row.encrypted_access_token);
  return vcsWorkspaceCredentialStatusSchema.parse({
    vcsProvider: row.vcs_provider,
    workspace: row.workspace,
    hasToken,
    hasWebhookSecret: Boolean(row.encrypted_webhook_secret),
    tokenExpiresAt: row.token_expires_at,
    label: row.label,
    status: computeCredentialStatus({ hasToken, tokenExpiresAt: row.token_expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const WORKSPACE_CREDENTIAL_COLUMNS = `
  vcs_provider,
  workspace,
  encrypted_access_token,
  encrypted_webhook_secret,
  token_expires_at,
  label,
  created_at,
  updated_at
`;

export async function listVcsWorkspaceCredentials(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
): Promise<VcsWorkspaceCredentialStatus[]> {
  const rows = await queryRows<VcsWorkspaceCredentialRow>(
    env,
    `SELECT ${WORKSPACE_CREDENTIAL_COLUMNS}
     FROM vcs_workspace_credentials
     ORDER BY workspace ASC`,
  );
  return rows.map(mapWorkspaceCredentialStatus);
}

// INTERNAL-ONLY: returns the ciphertext columns for decrypt/rotate use (mirrors
// getVcsCredentialSecrets). Never serialize the result into an HTTP response. Every keyed lookup
// filters on (vcs_provider, workspace) TOGETHER -- never workspace alone -- so the
// UNIQUE(vcs_provider, workspace) index's own B-tree stays usable (its leading column must be
// bound in the WHERE clause for the index to serve the lookup).
export async function getVcsWorkspaceCredentialSecrets(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: VcsWorkspaceCredentialKey,
): Promise<VcsWorkspaceCredentialSecret | null> {
  const [row] = await queryRows<VcsWorkspaceCredentialRow>(
    env,
    `SELECT ${WORKSPACE_CREDENTIAL_COLUMNS}
     FROM vcs_workspace_credentials
     WHERE vcs_provider = $1 AND workspace = $2`,
    [key.vcsProvider, key.workspace],
  );
  if (!row) return null;
  return {
    ...mapWorkspaceCredentialStatus(row),
    encryptedAccessToken: row.encrypted_access_token,
    encryptedWebhookSecret: row.encrypted_webhook_secret,
  };
}

export type UpsertVcsWorkspaceCredentialInput = VcsWorkspaceCredentialKey & {
  // string = set, null = clear, undefined = leave the stored value untouched (D-11, mirrored).
  encryptedAccessToken?: string | null;
  encryptedWebhookSecret?: string | null;
  tokenExpiresAt?: string | null;
  label?: string | null;
};

// Rotate-in-place upsert on the UNIQUE(vcs_provider, workspace) key (D-11, mirrors
// upsertVcsCredential lines 158-195 in vcs-credentials.ts). The `DO UPDATE SET` list is built
// dynamically -- a column is appended ONLY when its input is not `undefined` -- so an omitted
// field on a rotation never wipes a previously-stored value. `vcs_provider` is always bound as a
// parameter (never a hardcoded literal) in both the INSERT column list and the ON CONFLICT clause.
export async function upsertVcsWorkspaceCredential(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: UpsertVcsWorkspaceCredentialInput,
): Promise<VcsWorkspaceCredentialStatus> {
  const params: unknown[] = [input.vcsProvider, input.workspace];
  const insertColumns = ['vcs_provider', 'workspace'];
  const insertValues = ['$1', '$2'];
  const updates = ['updated_at = now()'];

  const optional: Array<[column: string, value: string | null | undefined]> = [
    ['encrypted_access_token', input.encryptedAccessToken],
    ['encrypted_webhook_secret', input.encryptedWebhookSecret],
    ['token_expires_at', input.tokenExpiresAt],
    ['label', input.label],
  ];

  for (const [column, value] of optional) {
    if (value === undefined) continue; // omitted -> leave the stored value untouched (D-11)
    params.push(value);
    const placeholder = `$${params.length}`;
    insertColumns.push(column);
    insertValues.push(placeholder);
    updates.push(`${column} = ${placeholder}`);
  }

  const [row] = await queryRows<VcsWorkspaceCredentialRow>(
    env,
    `
    INSERT INTO vcs_workspace_credentials (${insertColumns.join(', ')}, updated_at)
    VALUES (${insertValues.join(', ')}, now())
    ON CONFLICT (vcs_provider, workspace)
    DO UPDATE SET ${updates.join(', ')}
    RETURNING ${WORKSPACE_CREDENTIAL_COLUMNS}
    `,
    params,
  );
  return mapWorkspaceCredentialStatus(row);
}

export async function deleteVcsWorkspaceCredential(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: VcsWorkspaceCredentialKey,
): Promise<boolean> {
  const rows = await queryRows<{ workspace: string }>(
    env,
    `DELETE FROM vcs_workspace_credentials
     WHERE vcs_provider = $1 AND workspace = $2
     RETURNING workspace`,
    [key.vcsProvider, key.workspace],
  );
  return rows.length > 0;
}
