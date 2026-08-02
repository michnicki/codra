import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '@server/app';
import { insertRejectFeedback } from '@server/db/reject-feedback';
import { getRepoConfigRecord, upsertRepoConfig } from '@server/db/repo-configs';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

/**
 * Phase 28 (LRN-01) — HTTP-level coverage for the two learned-rule ROUTES.
 *
 * `test/learned-rules.spec.ts` proves the three PURE functions (cluster / synthesize / suppress).
 * This file covers what those unit tests structurally cannot: the route bodies in
 * `src/server/routes/api/repos.ts` that read reject_feedback, APPEND to the existing rule set, and
 * PERSIST through `upsertRepoConfig` + cache invalidation.
 *
 * 28-VERIFICATION.md flagged both as behavior-unverified (UAT tests 3 and 4): the only live
 * synthesize run ever executed hit the `newRules.length === 0` early return, so the append+persist
 * branch had never run anywhere, and no test targeted
 * PATCH /api/repos/:owner/:repo/learned-rules/:ruleId at all.
 *
 * Every assertion re-reads the config from Postgres rather than trusting the response body — the
 * defect class these tests exist to catch is "route answers 200 but nothing persisted".
 */
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const OWNER = 'lrn-api-owner';
const INSTALLATION_ID = '123';

/** A fixed pending rule id. `learnedRuleSchema.id` is `z.uuid()` — a readable slug fails parse. */
const SEEDED_PENDING_RULE_ID = '22222222-2222-4222-8222-222222222222';
/** A pre-existing ACTIVE rule, used to prove synthesis appends instead of replacing. */
const SEEDED_ACTIVE_RULE_ID = '33333333-3333-4333-8333-333333333333';

function mockGitHubProfile(login = 'devarshishimpi') {
  return { id: 42, login, name: 'Devarshi Shimpi', avatar_url: 'https://example.invalid/a.png', email: null };
}

function learningConfig(
  enabled: boolean,
  rules: RepoConfig['review']['learning']['learned_rules'] = [],
): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      learning: { enabled, learned_rules: rules },
    },
  };
}

dbDescribe('learned-rule routes (LRN-01 synthesize + transition)', () => {
  const app = createApp();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Drive the real OAuth callback to mint a session cookie (same approach as test/api.spec.ts). */
  async function getAuthCookie(env: ReturnType<typeof createTestEnv>): Promise<string> {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-access-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json(mockGitHubProfile());
      }
      return originalFetch(input, init);
    });

    const authStart = await app.request('/auth/github', {}, env);
    const state = new URL(authStart.headers.get('location')!).searchParams.get('state');
    const stateCookie = (authStart.headers.get('set-cookie') || '').match(/codra_oauth_state=[^;]+/)?.[0] ?? '';
    const callback = await app.request(
      `/auth/github/callback?code=test-code&state=${state}`,
      { headers: { cookie: stateCookie } },
      env,
    );
    return (callback.headers.get('set-cookie') || '').match(/codra_session=([^;]+)/)?.[1] ?? '';
  }

  function writeHeaders(token: string) {
    return {
      Cookie: `codra_session=${token}`,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/json',
    };
  }

  /**
   * Seed a GitHub repo config plus `rejectionCount` reject_feedback rows that all share the same
   * (finding_category, finding_file_path) — i.e. one clusterable group per D-03/D-04.
   *
   * A GitHub `repositories` row has workspace NULL, and the synthesize route reads feedback with
   * `workspace: existing.workspace ?? existing.owner` — so the rows are seeded under the OWNER.
   */
  async function seedRepo(
    env: ReturnType<typeof createTestEnv>,
    repo: string,
    options: {
      enabled?: boolean;
      existingRules?: RepoConfig['review']['learning']['learned_rules'];
      rejections?: Array<{ category: string | null; filePath: string | null }>;
    } = {},
  ) {
    await upsertRepoConfig(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      parsedJson: learningConfig(options.enabled ?? true, options.existingRules ?? []),
      vcsProvider: 'github',
    });

    const rejections = options.rejections ?? [];
    for (const [index, rejection] of rejections.entries()) {
      await insertRejectFeedback(env, {
        vcsProvider: 'github',
        workspace: OWNER,
        repoSlug: repo,
        prNumber: 7,
        findingRef: `7:${1000 + index}`,
        reason: 'false positive',
        rejectedBy: 'account-id-immutable-abc',
        // Idempotency key is (vcs_provider, source_comment_ref) — must be unique per row or the
        // second insert silently no-ops and the cluster never reaches the min size of 2.
        sourceCommentRef: `${repo}:7:${2000 + index}`,
        findingTitle: `Rejected finding ${index}`,
        findingCategory: rejection.category,
        findingFilePath: rejection.filePath,
        findingSeverity: 'P3',
      });
    }
  }

  /** Re-read the persisted rule set straight from Postgres. */
  async function readPersistedRules(env: ReturnType<typeof createTestEnv>, repo: string) {
    const record = await getRepoConfigRecord(env, OWNER, repo, 'github');
    return record?.parsedJson.review.learning?.learned_rules ?? [];
  }

  // --- UAT test 3: synthesize, populated half ---------------------------------------------------

  it('persists a pending rule when >=2 rejections share (category, file_path)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-synth-${Date.now()}`;

    await seedRepo(env, repo, {
      rejections: [
        { category: 'quality', filePath: 'src/app.ts' },
        { category: 'quality', filePath: 'src/app.ts' },
      ],
    });

    const response = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; rules: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({
      category: 'quality',
      file_pattern: 'src/app.ts',
      status: 'pending',
    });
    // Both rejection ids are carried onto the rule — this is what RuleCard's count renders.
    expect((body.rules[0].source_rejection_ids as string[]).length).toBe(2);

    // The branch under test: append + upsertRepoConfig. Assert against the DB, not the response.
    const persisted = await readPersistedRules(env, repo);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: body.rules[0].id,
      category: 'quality',
      file_pattern: 'src/app.ts',
      status: 'pending',
    });
  });

  it('appends to existing rules rather than replacing them', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-append-${Date.now()}`;

    // An operator-approved active rule on a DIFFERENT (category, file) must survive synthesis
    // (Antigravity 1.1 — state-preserving merge).
    await seedRepo(env, repo, {
      existingRules: [
        {
          id: SEEDED_ACTIVE_RULE_ID,
          category: 'security',
          file_pattern: 'src/auth.ts',
          status: 'active',
          source_rejection_ids: ['seed-1', 'seed-2'],
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      rejections: [
        { category: 'bugs', filePath: 'src/queue.ts' },
        { category: 'bugs', filePath: 'src/queue.ts' },
      ],
    });

    const response = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );
    expect(response.status).toBe(200);

    const persisted = await readPersistedRules(env, repo);
    expect(persisted).toHaveLength(2);
    // The pre-existing ACTIVE rule keeps both its id and its operator-set status.
    expect(persisted.find((r) => r.id === SEEDED_ACTIVE_RULE_ID)).toMatchObject({ status: 'active' });
    expect(persisted.find((r) => r.category === 'bugs')).toMatchObject({
      file_pattern: 'src/queue.ts',
      status: 'pending',
    });
  });

  it('is idempotent — a second synthesize emits no duplicate rule', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-idem-${Date.now()}`;

    await seedRepo(env, repo, {
      rejections: [
        { category: 'quality', filePath: 'src/dup.ts' },
        { category: 'quality', filePath: 'src/dup.ts' },
      ],
    });

    const first = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );
    expect(((await first.json()) as { rules: unknown[] }).rules).toHaveLength(1);

    const second = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      rules: [],
      message: 'No new rule candidates found',
    });

    expect(await readPersistedRules(env, repo)).toHaveLength(1);
  });

  it('does not cluster rejections whose finding metadata is NULL (D-02)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-null-${Date.now()}`;

    // Two rejections on the same file, but the category never resolved — the pre-G-28-3 shape.
    await seedRepo(env, repo, {
      rejections: [
        { category: null, filePath: 'src/app.ts' },
        { category: null, filePath: 'src/app.ts' },
      ],
    });

    const response = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, rules: [] });
    expect(await readPersistedRules(env, repo)).toHaveLength(0);
  });

  it('refuses synthesis with 400 when learning.enabled is false (NREG-01)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-off-${Date.now()}`;

    await seedRepo(env, repo, {
      enabled: false,
      rejections: [
        { category: 'quality', filePath: 'src/app.ts' },
        { category: 'quality', filePath: 'src/app.ts' },
      ],
    });

    const response = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: writeHeaders(token) },
      env,
    );
    expect(response.status).toBe(400);
    // Even with a perfectly clusterable pair present, nothing is written while the gate is off.
    expect(await readPersistedRules(env, repo)).toHaveLength(0);
  });

  it('rejects synthesis without the CSRF header', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-csrf-${Date.now()}`;
    await seedRepo(env, repo);

    const response = await app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/synthesize?provider=github`,
      { method: 'POST', headers: { Cookie: `codra_session=${token}` } },
      env,
    );
    expect(response.status).toBe(403);
  });

  // --- UAT test 4: rule status transitions ------------------------------------------------------

  async function patchRule(
    env: ReturnType<typeof createTestEnv>,
    token: string,
    repo: string,
    ruleId: string,
    status: string,
  ) {
    return app.request(
      `/api/repos/${OWNER}/${repo}/learned-rules/${ruleId}?provider=github`,
      { method: 'PATCH', headers: writeHeaders(token), body: JSON.stringify({ status }) },
      env,
    );
  }

  function pendingRule() {
    return {
      id: SEEDED_PENDING_RULE_ID,
      category: 'quality',
      file_pattern: 'src/app.ts',
      status: 'pending' as const,
      source_rejection_ids: ['rej-1', 'rej-2'],
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  it('walks the full pending -> active -> disabled -> active lifecycle, persisting each step', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-lifecycle-${Date.now()}`;
    await seedRepo(env, repo, { existingRules: [pendingRule()] });

    // Approve: pending -> active
    const approve = await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'active');
    expect(approve.status).toBe(200);
    await expect(approve.json()).resolves.toMatchObject({ ok: true, rule: { status: 'active' } });
    expect((await readPersistedRules(env, repo))[0].status).toBe('active');

    // Disable: active -> disabled
    const disable = await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'disabled');
    expect(disable.status).toBe(200);
    await expect(disable.json()).resolves.toMatchObject({ ok: true, rule: { status: 'disabled' } });
    expect((await readPersistedRules(env, repo))[0].status).toBe('disabled');

    // Re-enable: disabled -> active
    const reEnable = await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'active');
    expect(reEnable.status).toBe(200);
    await expect(reEnable.json()).resolves.toMatchObject({ ok: true, rule: { status: 'active' } });
    expect((await readPersistedRules(env, repo))[0].status).toBe('active');

    // Identity survives the round trip — a transition must never mint a new rule or drop fields.
    const [final] = await readPersistedRules(env, repo);
    expect(final).toMatchObject({
      id: SEEDED_PENDING_RULE_ID,
      category: 'quality',
      file_pattern: 'src/app.ts',
      source_rejection_ids: ['rej-1', 'rej-2'],
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rejects pending -> disabled with 400 and names the valid transitions (D-08)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-badtrans-${Date.now()}`;
    await seedRepo(env, repo, { existingRules: [pendingRule()] });

    const response = await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'disabled');
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Invalid status transition: pending -> disabled. Valid transitions: active');

    // A refused transition leaves the stored status untouched.
    expect((await readPersistedRules(env, repo))[0].status).toBe('pending');
  });

  it('rejects active -> pending with 400 (no un-approving a rule)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-nounapprove-${Date.now()}`;
    await seedRepo(env, repo, { existingRules: [{ ...pendingRule(), status: 'active' }] });

    const response = await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'pending');
    expect(response.status).toBe(400);
    expect((await readPersistedRules(env, repo))[0].status).toBe('active');
  });

  it('returns 404 for an unknown rule id', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-404-${Date.now()}`;
    await seedRepo(env, repo, { existingRules: [pendingRule()] });

    const response = await patchRule(env, token, repo, '44444444-4444-4444-8444-444444444444', 'active');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Learned rule not found.' });
  });

  it('returns 400 for a status value outside the enum', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-badstatus-${Date.now()}`;
    await seedRepo(env, repo, { existingRules: [pendingRule()] });

    const response = await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'approved');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid status. Must be one of: pending, active, disabled.',
    });
  });

  it('transitions only the addressed rule, leaving siblings untouched', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const repo = `lrn-sibling-${Date.now()}`;
    await seedRepo(env, repo, {
      existingRules: [
        pendingRule(),
        {
          id: SEEDED_ACTIVE_RULE_ID,
          category: 'security',
          file_pattern: 'src/auth.ts',
          status: 'pending',
          source_rejection_ids: ['rej-9'],
          created_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    expect((await patchRule(env, token, repo, SEEDED_PENDING_RULE_ID, 'active')).status).toBe(200);

    const persisted = await readPersistedRules(env, repo);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((r) => r.id === SEEDED_PENDING_RULE_ID)!.status).toBe('active');
    expect(persisted.find((r) => r.id === SEEDED_ACTIVE_RULE_ID)!.status).toBe('pending');
  });
});
