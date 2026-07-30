import type { AppBindings } from '@server/env';
import { getVcsCredentialSecrets, type VcsCredentialSecret } from '@server/db/vcs-credentials';
import {
  getVcsWorkspaceCredentialSecrets,
  type VcsWorkspaceCredentialSecret,
} from '@server/db/vcs-workspace-credentials';

// D-03: bot-identity resolution (used for POSTING comments/check-runs -- e.g.
// BitbucketAdapter.create / VcsService.forRepo). The per-repo credential is authoritative when
// present; the workspace-level credential is a fallback ONLY consulted when no per-repo row
// exists. This is a short-circuiting lookup -- unlike resolveBitbucketWebhookSecretCandidates
// below, we deliberately return early rather than always querying both sources, because bot
// identity/posting needs exactly ONE winner, not a candidate list.
export async function resolveBitbucketBotCredential(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: { workspace: string; repoSlug: string },
): Promise<VcsCredentialSecret | VcsWorkspaceCredentialSecret | null> {
  const perRepo = await getVcsCredentialSecrets(env, {
    vcsProvider: 'bitbucket',
    workspace: key.workspace,
    repoSlug: key.repoSlug,
  });
  // A per-repo row can exist with its access token cleared (clearToken: true on
  // POST /api/vcs-credentials) while the row itself remains. Short-circuiting on the row's
  // mere existence would then permanently block the workspace-level fallback even though a
  // valid workspace credential is available -- check for a usable token, not just a row.
  if (perRepo?.encryptedAccessToken) return perRepo;
  return getVcsWorkspaceCredentialSecrets(env, {
    vcsProvider: 'bitbucket',
    workspace: key.workspace,
  });
}

// Webhook HMAC verification needs a LIST of candidate secrets, not a single winner. This
// deliberately differs from resolveBitbucketBotCredential above: a per-repo webhook subscription
// AND a workspace-level webhook subscription can both be independently, legitimately live for the
// same repo at once (31-RESEARCH.md Common Pitfall 1 -- overlapping subscriptions may sign with
// either secret). Both lookups therefore always run via Promise.all, unconditionally -- NEVER
// short-circuited -- so the caller can try every candidate during HMAC verification. This
// function returns CIPHERTEXT only; decryption stays the caller's responsibility (matches the
// existing webhook route's step 6).
export async function resolveBitbucketWebhookSecretCandidates(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: { workspace: string; repoSlug: string },
): Promise<string[]> {
  const [perRepo, workspaceCred] = await Promise.all([
    getVcsCredentialSecrets(env, {
      vcsProvider: 'bitbucket',
      workspace: key.workspace,
      repoSlug: key.repoSlug,
    }),
    getVcsWorkspaceCredentialSecrets(env, {
      vcsProvider: 'bitbucket',
      workspace: key.workspace,
    }),
  ]);
  return [perRepo?.encryptedWebhookSecret, workspaceCred?.encryptedWebhookSecret].filter(
    (v): v is string => Boolean(v),
  );
}
