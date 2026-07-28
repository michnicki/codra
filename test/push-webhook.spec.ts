// Phase 29 (QA-IDX-01, D-08) — default-branch push handling on BOTH providers, one spec.
//
// Covers the GitHub `push` branch (src/server/routes/webhook.ts) and the Bitbucket `repo:push`
// branch (src/server/routes/webhook-bitbucket.ts): the positive refresh path, every ignore shape,
// the bad-signature 401, the identity-projection regression guard, the provider-symmetry reason
// token, and the shared instance-id agreement that makes `instance.already_exists` coalescing real.
//
// ── TWO THINGS NO AUTOMATED TEST HERE CAN COVER (both are Task 4's job) ─────────────────────────
//
//  1. THE OPERATOR STEP. Bitbucket webhook subscriptions are created BY HAND in the Bitbucket UI,
//     so already-onboarded repositories will not receive `repo:push` until an operator edits each
//     existing subscription to include that event. Without that step, Bitbucket freshness appears
//     broken with no error anywhere — and nothing in this suite can see it.
//  2. THE PAYLOAD ASSUMPTIONS. Every fixture in this file is constructed from the ASSUMED payload
//     shapes — A1 (GitHub push carries `repository.default_branch`) and A2 (Bitbucket `repo:push`
//     carries `push.changes[].new.target.hash`). This spec proves the routing logic GIVEN those
//     shapes and proves nothing about whether the shapes are right: a green run here is green
//     whether or not the assumptions hold. Both reviewers rated the unvalidated shapes the top
//     risk in the phase; they are confirmed against one real delivery per provider at this plan's
//     blocking Task 4 checkpoint.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createApp } from '@server/app';
import { encryptSecret } from '@server/core/crypto';
import { codeIndexInstanceId, type IndexBuildParams } from '@server/core/code-index-build';
import { findRepositoryIdByIdentity, findRepositoryByBitbucketIdentity } from '@server/db/repositories';
import { upsertRepoConfig } from '@server/db/repo-configs';
import { queryRows } from '@server/db/client';
import { logger } from '@server/core/logger';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import {
  createTestEnv,
  hasConfiguredTestDatabaseUrl,
  signWebhookPayload,
  MockWorkflow,
} from './helpers';
import { installBitbucketFetchMock } from './bitbucket-fetch-mock';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// ── Module seams ───────────────────────────────────────────────────────────────────────────────
// loadRepoConfig is mocked so each GitHub case picks its index toggle deterministically (the
// GitHub route reads the toggle only through it). The Bitbucket route does NOT use loadRepoConfig
// — it reads getRepoConfigByRepositoryId — so Bitbucket toggle cases seed a real repo_configs row.
// findRepositoryIdByIdentity is mocked ONLY so the instance-id agreement case can point both
// providers at one repository id; every other case gets the passthrough real implementation.
const { loadRepoConfigMock, findRepositoryIdMock, actuals } = vi.hoisted(() => ({
  loadRepoConfigMock: vi.fn(),
  findRepositoryIdMock: vi.fn(),
  actuals: { findRepositoryIdByIdentity: null as null | ((...args: any[]) => Promise<number | null>) },
}));

vi.mock('@server/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/config')>();
  return { ...actual, loadRepoConfig: (...args: any[]) => loadRepoConfigMock(...args) };
});

vi.mock('@server/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/db/repositories')>();
  actuals.findRepositoryIdByIdentity = actual.findRepositoryIdByIdentity;
  return {
    ...actual,
    findRepositoryIdByIdentity: (...args: any[]) => findRepositoryIdMock(...args),
  };
});

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

const GH_OWNER = 'push-spec-gh-owner';
const GH_INSTALLATION_ID = '778899';
const BB_SECRET = 'push-spec-bitbucket-webhook-secret';
const BB_MAIN_BRANCH = 'main';

const sha = (char: string) => char.repeat(40);
const ALL_ZERO_SHA = '0'.repeat(40);

/** The default config with only `review.interactive.qa.index.enabled` moved. */
function indexConfig(enabled: boolean): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      interactive: {
        ...defaultRepoConfig.review.interactive,
        qa: {
          ...defaultRepoConfig.review.interactive.qa,
          index: { ...defaultRepoConfig.review.interactive.qa.index, enabled },
        },
      },
    },
  };
}

type GitHubPushOverrides = {
  ref?: string;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  repository?: Record<string, unknown>;
};

/** A GitHub `push` payload built from ASSUMPTION A1 — `repository.default_branch` is present. */
function buildGitHubPush(repo: string, overrides: GitHubPushOverrides = {}) {
  return {
    ref: overrides.ref ?? 'refs/heads/main',
    before: overrides.before ?? sha('a'),
    after: overrides.after ?? sha('b'),
    created: overrides.created ?? false,
    deleted: overrides.deleted ?? false,
    forced: overrides.forced ?? false,
    installation: { id: Number(GH_INSTALLATION_ID) },
    repository: {
      owner: { login: GH_OWNER },
      name: repo,
      default_branch: 'main',
      ...(overrides.repository ?? {}),
    },
  };
}

type BitbucketChange = {
  new?: { type: string; name: string; target: { hash: string } } | null;
  old?: { type: string; name: string; target: { hash: string } } | null;
  created?: boolean;
  closed?: boolean;
  forced?: boolean;
  truncated?: boolean;
};

/** A Bitbucket `repo:push` body built from ASSUMPTION A2 — `push.changes[].new.target.hash`. */
function buildBitbucketPush(workspace: string, repo: string, change: BitbucketChange = {}) {
  return {
    repository: {
      full_name: `${workspace}/${repo}`,
      name: repo,
      workspace: { slug: workspace },
      uuid: '{push-spec-uuid}',
    },
    push: {
      changes: [
        {
          created: false,
          closed: false,
          forced: false,
          truncated: false,
          old: { type: 'branch', name: BB_MAIN_BRANCH, target: { hash: sha('c') } },
          new: { type: 'branch', name: BB_MAIN_BRANCH, target: { hash: sha('d') } },
          ...change,
        },
      ],
    },
  };
}

dbDescribe('push webhooks (Phase 29 D-08): default-branch index freshness on both providers', () => {
  const app = createApp();
  const seededRepos: Array<{ vcsProvider: 'github' | 'bitbucket'; key: string; repo: string }> = [];
  let deliveryCounter = 0;

  /** A fresh env per test so the INDEX_WORKFLOW mock's `created` log is test-local. */
  function freshEnv() {
    const env = createTestEnv();
    const indexWorkflow = env.INDEX_WORKFLOW as unknown as MockWorkflow;
    return { env, indexWorkflow };
  }

  function nextDeliveryId(prefix: string) {
    deliveryCounter += 1;
    return `push-spec-${prefix}-${Date.now()}-${deliveryCounter}`;
  }

  /** Seed a GitHub repositories row (+ config row) and return its id. */
  async function seedGitHubRepo(env: ReturnType<typeof createTestEnv>, repo: string, indexEnabled = true) {
    await upsertRepoConfig(env, {
      installationId: GH_INSTALLATION_ID,
      owner: GH_OWNER,
      repo,
      parsedJson: indexConfig(indexEnabled),
      vcsProvider: 'github',
    });
    seededRepos.push({ vcsProvider: 'github', key: GH_OWNER, repo });
    const id = await findRepositoryIdByIdentity(env, { vcsProvider: 'github', ownerOrWorkspace: GH_OWNER, repo });
    if (id === null) throw new Error(`seedGitHubRepo: no row for ${GH_OWNER}/${repo}`);
    return id;
  }

  /**
   * Seed a Bitbucket repositories row, its per-repo config (the route's toggle source), and the
   * vcs_credentials row with a REAL encrypted access token — the repo:push branch decrypts it to
   * build the adapter for the main-branch metadata read, so the placeholder other specs use would
   * not survive `decryptSecret`.
   */
  async function seedBitbucketRepo(env: ReturnType<typeof createTestEnv>, workspace: string, repo: string, indexEnabled = true) {
    await upsertRepoConfig(env, {
      installationId: null,
      owner: workspace,
      repo,
      parsedJson: indexConfig(indexEnabled),
      vcsProvider: 'bitbucket',
      workspace,
    });
    seededRepos.push({ vcsProvider: 'bitbucket', key: workspace, repo });
    const id = await findRepositoryByBitbucketIdentity(env, { workspace, repoSlug: repo });
    if (id === null) throw new Error(`seedBitbucketRepo: no row for ${workspace}/${repo}`);

    const encryptedSecret = await encryptSecret(env, BB_SECRET);
    const encryptedToken = await encryptSecret(env, `push-spec-access-token-${workspace}`);
    await queryRows(
      env,
      `INSERT INTO vcs_credentials (vcs_provider, workspace, repo_slug, encrypted_webhook_secret, encrypted_access_token, created_at, updated_at)
       VALUES ('bitbucket', $1, $2, $3, $4, now(), now())
       ON CONFLICT (vcs_provider, workspace, repo_slug) DO UPDATE
         SET encrypted_webhook_secret = EXCLUDED.encrypted_webhook_secret,
             encrypted_access_token = EXCLUDED.encrypted_access_token,
             updated_at = now()`,
      [workspace, repo, encryptedSecret, encryptedToken],
    );
    return id;
  }

  /** POST a signed GitHub `push` delivery. */
  async function postGitHubPush(env: ReturnType<typeof createTestEnv>, payload: unknown, deliveryPrefix: string) {
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);
    return app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': nextDeliveryId(deliveryPrefix),
          'x-hub-signature-256': signature,
        },
        body,
      },
      env,
    );
  }

  /** POST a Bitbucket `repo:push` delivery; `signature` may be overridden for the 401 case. */
  async function postBitbucketPush(
    env: ReturnType<typeof createTestEnv>,
    payload: unknown,
    deliveryPrefix: string,
    signatureOverride?: string,
  ) {
    const body = JSON.stringify(payload);
    const signature = signatureOverride ?? (await signWebhookPayload(BB_SECRET, body));
    return app.request(
      'http://codra.test/webhook/bitbucket',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-event-key': 'repo:push',
          'x-request-uuid': nextDeliveryId(deliveryPrefix),
          'x-hub-signature': signature,
        },
        body,
      },
      env,
    );
  }

  /** The scripted Bitbucket metadata read every actionable repo:push case needs. */
  function mockMainBranchMetadata(branch: string | null) {
    return installBitbucketFetchMock({
      responseSequence: [{ body: branch === null ? {} : { mainbranch: { name: branch } } }],
    });
  }

  beforeEach(() => {
    loadRepoConfigMock.mockReset();
    loadRepoConfigMock.mockResolvedValue({ parsedJson: indexConfig(true), enabled: true });
    findRepositoryIdMock.mockReset();
    findRepositoryIdMock.mockImplementation((...args: any[]) => actuals.findRepositoryIdByIdentity!(...args));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // The test database is never reset; remove exactly what this file seeded.
    const env = createTestEnv();
    await queryRows(env, `DELETE FROM webhook_deliveries WHERE delivery_id LIKE 'push-spec-%'`);
    for (const seeded of seededRepos) {
      const repositoryId =
        seeded.vcsProvider === 'bitbucket'
          ? await findRepositoryByBitbucketIdentity(env, { workspace: seeded.key, repoSlug: seeded.repo })
          : await findRepositoryIdByIdentity(env, { vcsProvider: 'github', ownerOrWorkspace: seeded.key, repo: seeded.repo });
      if (repositoryId === null) continue;
      await queryRows(env, `DELETE FROM webhook_deliveries WHERE repository_id = $1`, [repositoryId]);
      await queryRows(env, `DELETE FROM repo_configs WHERE repository_id = $1`, [repositoryId]);
      await queryRows(env, `DELETE FROM repositories WHERE id = $1`, [repositoryId]);
    }
    for (const seeded of seededRepos) {
      if (seeded.vcsProvider !== 'bitbucket') continue;
      await queryRows(env, `DELETE FROM vcs_credentials WHERE workspace = $1 AND repo_slug = $2`, [seeded.key, seeded.repo]);
    }
  });

  // ── GitHub ──────────────────────────────────────────────────────────────────────────────────

  it('GitHub: records exactly one incremental index build for a default-branch push with the toggle on', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-pos-${Date.now()}`;
    const repositoryId = await seedGitHubRepo(env, repo);

    const payload = buildGitHubPush(repo);
    const response = await postGitHubPush(env, payload, 'gh-pos');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, refreshed: true, mode: 'incremental' });

    expect(indexWorkflow.created).toHaveLength(1);
    const created = indexWorkflow.created[0] as { id: string; params: IndexBuildParams };
    expect(created.id).toBe(codeIndexInstanceId(repositoryId));
    expect(created.params).toMatchObject({
      repositoryId,
      vcsProvider: 'github',
      owner: GH_OWNER,
      repo,
      mode: 'incremental',
      baseSha: payload.before,
      headSha: payload.after,
      continuation: 0,
    });
  });

  it('GitHub: ignores a push to a non-default branch and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-nondef-${Date.now()}`;
    await seedGitHubRepo(env, repo);

    const response = await postGitHubPush(env, buildGitHubPush(repo, { ref: 'refs/heads/feature-x' }), 'gh-nondef');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'non_default_branch' });
    expect(indexWorkflow.created).toHaveLength(0);
  });

  it('GitHub: ignores a tag push and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-tag-${Date.now()}`;
    await seedGitHubRepo(env, repo);

    const response = await postGitHubPush(env, buildGitHubPush(repo, { ref: 'refs/tags/v1.2.3' }), 'gh-tag');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'non_branch_ref' });
    expect(indexWorkflow.created).toHaveLength(0);
  });

  it('GitHub: ignores a branch deletion and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-del-${Date.now()}`;
    await seedGitHubRepo(env, repo);

    const response = await postGitHubPush(env, buildGitHubPush(repo, { deleted: true, after: ALL_ZERO_SHA }), 'gh-del');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'deleted' });
    expect(indexWorkflow.created).toHaveLength(0);
  });

  it('GitHub: ignores a default-branch push when the index toggle is off', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-off-${Date.now()}`;
    await seedGitHubRepo(env, repo);
    loadRepoConfigMock.mockResolvedValue({ parsedJson: indexConfig(false), enabled: true });

    const response = await postGitHubPush(env, buildGitHubPush(repo), 'gh-off');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'index_disabled' });
    expect(indexWorkflow.created).toHaveLength(0);
  });

  it('GitHub: starts a full rebuild for a branch-creation push instead of comparing against a zero sha', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-created-${Date.now()}`;
    const repositoryId = await seedGitHubRepo(env, repo);

    const response = await postGitHubPush(
      env,
      buildGitHubPush(repo, { created: true, before: ALL_ZERO_SHA }),
      'gh-created',
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      refreshed: true,
      mode: 'full',
      reason: 'branch_created_full_rebuild',
    });

    expect(indexWorkflow.created).toHaveLength(1);
    const created = indexWorkflow.created[0] as { id: string; params: IndexBuildParams };
    expect(created.id).toBe(codeIndexInstanceId(repositoryId));
    expect(created.params.mode).toBe('full');
    // The all-zeros before-sha must NOT travel to the build as a compare operand.
    expect(created.params.baseSha ?? null).toBeNull();
    expect(created.params.headSha ?? null).toBeNull();
  });

  it('GitHub: warns and ignores when the payload carries neither default_branch nor master_branch', async () => {
    const { env, indexWorkflow } = freshEnv();
    const repo = `gh-nodefault-${Date.now()}`;
    await seedGitHubRepo(env, repo);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const payload = buildGitHubPush(repo, { repository: { default_branch: undefined } });
    delete (payload.repository as Record<string, unknown>).default_branch;
    const response = await postGitHubPush(env, payload, 'gh-nodefault');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'default_branch_unknown' });
    expect(indexWorkflow.created).toHaveLength(0);

    // The response is indistinguishable from a correctly-ignored delivery — the WARNING is the
    // whole point of this path, so assert on the captured log, not only on the response.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, warnPayload] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    // Exactly owner, repo, event kind and ref — no commit list, no committer identity, no body.
    expect(Object.keys(warnPayload).sort()).toEqual(['eventKind', 'owner', 'ref', 'repo']);
    expect(warnPayload).toMatchObject({ owner: GH_OWNER, repo, eventKind: 'push', ref: 'refs/heads/main' });
  });

  // ── Bitbucket ───────────────────────────────────────────────────────────────────────────────

  it('Bitbucket: records exactly one incremental index build for a signed repo:push on the main branch', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-pos-${Date.now()}`;
    const repo = `bb-pos-${Date.now()}`;
    const repositoryId = await seedBitbucketRepo(env, workspace, repo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const payload = buildBitbucketPush(workspace, repo);
      const response = await postBitbucketPush(env, payload, 'bb-pos');

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, refreshed: true, mode: 'incremental' });

      expect(indexWorkflow.created).toHaveLength(1);
      const created = indexWorkflow.created[0] as { id: string; params: IndexBuildParams };
      expect(created.id).toBe(codeIndexInstanceId(repositoryId));
      expect(created.params).toMatchObject({
        repositoryId,
        vcsProvider: 'bitbucket',
        owner: workspace,
        repo,
        workspace,
        installationId: null,
        mode: 'incremental',
        baseSha: payload.push.changes[0].old!.target.hash,
        headSha: payload.push.changes[0].new!.target.hash,
        continuation: 0,
      });
    } finally {
      bbMock.restore();
    }
  });

  it('Bitbucket: a signed repo:push reaches the full-payload parse instead of a 400 (identity-projection regression guard)', async () => {
    const { env } = freshEnv();
    const workspace = `ws-bb-guard-${Date.now()}`;
    const repo = `bb-guard-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const response = await postBitbucketPush(env, buildBitbucketPush(workspace, repo), 'bb-guard');

      // Assert the EXACT status code, not a truthy "ignored" body: the pre-change route REJECTED
      // a repo:push body with a 400 at the identity projection (it hard-required pullrequest.id),
      // so a spec asserting only an ignored acknowledgement would pass against the old 400 for the
      // wrong reason — the route rejected the body before it could ignore it. Do not weaken this
      // back into a truthiness check.
      expect(response.status).toBe(202);
      expect(response.status).not.toBe(400);
    } finally {
      bbMock.restore();
    }
  });

  it('Bitbucket: ignores a repo:push for a tag and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-tag-${Date.now()}`;
    const repo = `bb-tag-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const response = await postBitbucketPush(
        env,
        buildBitbucketPush(workspace, repo, { new: { type: 'tag', name: 'v1.2.3', target: { hash: sha('e') } } }),
        'bb-tag',
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'non_branch_ref' });
      expect(indexWorkflow.created).toHaveLength(0);
    } finally {
      bbMock.restore();
    }
  });

  it('Bitbucket: ignores a repo:push for a non-main branch and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-nondef-${Date.now()}`;
    const repo = `bb-nondef-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const response = await postBitbucketPush(
        env,
        buildBitbucketPush(workspace, repo, {
          new: { type: 'branch', name: 'feature-x', target: { hash: sha('e') } },
          old: { type: 'branch', name: 'feature-x', target: { hash: sha('f') } },
        }),
        'bb-nondef',
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'non_default_branch' });
      expect(indexWorkflow.created).toHaveLength(0);
    } finally {
      bbMock.restore();
    }
  });

  it('Bitbucket: ignores a repo:push deleting a ref (null new) and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-del-${Date.now()}`;
    const repo = `bb-del-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const response = await postBitbucketPush(
        env,
        buildBitbucketPush(workspace, repo, { new: null, closed: true }),
        'bb-del',
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'deleted' });
      expect(indexWorkflow.created).toHaveLength(0);
    } finally {
      bbMock.restore();
    }
  });

  it('Bitbucket: starts a full rebuild for a branch-creation change (null old) instead of comparing against a missing sha', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-created-${Date.now()}`;
    const repo = `bb-created-${Date.now()}`;
    const repositoryId = await seedBitbucketRepo(env, workspace, repo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const response = await postBitbucketPush(
        env,
        buildBitbucketPush(workspace, repo, { old: null, created: true }),
        'bb-created',
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        refreshed: true,
        mode: 'full',
        reason: 'branch_created_full_rebuild',
      });

      expect(indexWorkflow.created).toHaveLength(1);
      const created = indexWorkflow.created[0] as { id: string; params: IndexBuildParams };
      expect(created.id).toBe(codeIndexInstanceId(repositoryId));
      expect(created.params.mode).toBe('full');
      expect(created.params.baseSha ?? null).toBeNull();
      expect(created.params.headSha ?? null).toBeNull();
    } finally {
      bbMock.restore();
    }
  });

  it('Bitbucket: ignores a repo:push when the index toggle is off and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-off-${Date.now()}`;
    const repo = `bb-off-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo, false);
    // No fetch mock on purpose: the toggle check precedes the metadata read, so an opted-out
    // repository must spend no subrequest at all. A call to api.bitbucket.org here would throw
    // "Unexpected non-Bitbucket fetch" under the real fetch and fail the test loudly.

    const response = await postBitbucketPush(env, buildBitbucketPush(workspace, repo), 'bb-off');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'index_disabled' });
    expect(indexWorkflow.created).toHaveLength(0);
  });

  it('Bitbucket: a wrongly-signed repo:push returns 401 and starts nothing', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-badsig-${Date.now()}`;
    const repo = `bb-badsig-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo);

    const body = JSON.stringify(buildBitbucketPush(workspace, repo));
    const wrongSignature = await signWebhookPayload('not-the-webhook-secret', body);
    const response = await postBitbucketPush(env, JSON.parse(body), 'bb-badsig', wrongSignature);

    // Adding the event type adds payload-validation work, never verification work: a forged
    // repo:push fails closed at the HMAC, exactly like every other event kind.
    expect(response.status).toBe(401);
    expect(indexWorkflow.created).toHaveLength(0);
  });

  it('Bitbucket: warns and ignores when the main-branch metadata read fails', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-metafail-${Date.now()}`;
    const repo = `bb-metafail-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, repo);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const bbMock = installBitbucketFetchMock({
      responseSequence: [
        { status: 500, body: { error: { message: 'bitbucket exploded' } } },
        { status: 500, body: { error: { message: 'bitbucket exploded' } } },
        { status: 500, body: { error: { message: 'bitbucket exploded' } } },
      ],
    });

    try {
      const response = await postBitbucketPush(env, buildBitbucketPush(workspace, repo), 'bb-metafail');

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: 'default_branch_unknown' });
      expect(indexWorkflow.created).toHaveLength(0);
      // Same failure discipline as the GitHub both-absent path: never a silent skip.
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      bbMock.restore();
    }
  });

  // ── Cross-provider ──────────────────────────────────────────────────────────────────────────

  it('Provider symmetry: a non-default-branch push is ignored with the SAME reason token on both providers', async () => {
    const { env } = freshEnv();
    const ghRepo = `gh-sym-${Date.now()}`;
    await seedGitHubRepo(env, ghRepo);
    const workspace = `ws-bb-sym-${Date.now()}`;
    const bbRepo = `bb-sym-${Date.now()}`;
    await seedBitbucketRepo(env, workspace, bbRepo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    try {
      const ghResponse = await postGitHubPush(env, buildGitHubPush(ghRepo, { ref: 'refs/heads/feature-x' }), 'gh-sym');
      const bbResponse = await postBitbucketPush(
        env,
        buildBitbucketPush(workspace, bbRepo, {
          new: { type: 'branch', name: 'feature-x', target: { hash: sha('e') } },
          old: { type: 'branch', name: 'feature-x', target: { hash: sha('f') } },
        }),
        'bb-sym',
      );

      const ghJson = (await ghResponse.json()) as { reason?: string };
      const bbJson = (await bbResponse.json()) as { reason?: string };
      // The two tokens are asserted string-EQUAL, not merely both present: a future divergence in
      // one provider's routing vocabulary is caught here rather than discovered in production.
      expect(ghJson.reason).toBe('non_default_branch');
      expect(bbJson.reason).toBe(ghJson.reason);
    } finally {
      bbMock.restore();
    }
  });

  it('Instance-id agreement: both providers key the build instance on codeIndexInstanceId(repositoryId)', async () => {
    const { env, indexWorkflow } = freshEnv();
    const workspace = `ws-bb-agree-${Date.now()}`;
    const bbRepo = `bb-agree-${Date.now()}`;
    const bitbucketRepositoryId = await seedBitbucketRepo(env, workspace, bbRepo);
    const bbMock = mockMainBranchMetadata(BB_MAIN_BRANCH);

    // Point the GitHub branch's repository resolution at the SAME repository id the Bitbucket
    // branch resolves for its own repo. Only then are the two recorded ids comparable — the
    // agreement being proven is that BOTH branches produce the shared helper's output for a given
    // repository id, which is what makes the cross-trigger `instance.already_exists` coalescing
    // real rather than assumed. Read the expected value from the imported helper, never a retyped
    // `code-index:{id}` literal, so the assertion tracks the helper instead of freezing a copy of
    // its current output.
    findRepositoryIdMock.mockResolvedValue(bitbucketRepositoryId);

    try {
      const ghResponse = await postGitHubPush(env, buildGitHubPush(`gh-agree-${Date.now()}`), 'gh-agree');
      expect(ghResponse.status).toBe(202);

      const bbResponse = await postBitbucketPush(env, buildBitbucketPush(workspace, bbRepo), 'bb-agree');
      expect(bbResponse.status).toBe(202);

      expect(indexWorkflow.created).toHaveLength(2);
      const [ghCreated, bbCreated] = indexWorkflow.created as Array<{ id: string; params: IndexBuildParams }>;
      const expected = codeIndexInstanceId(bitbucketRepositoryId);
      expect(ghCreated.id).toBe(expected);
      expect(bbCreated.id).toBe(expected);
      expect(ghCreated.id).toBe(bbCreated.id);
      expect(ghCreated.params.workflowInstanceId).toBe(expected);
      expect(bbCreated.params.workflowInstanceId).toBe(expected);
    } finally {
      bbMock.restore();
    }
  });
});
