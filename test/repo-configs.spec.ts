import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { queryRows } from '@server/db/client';
import {
  getRepoConfigRecord,
  listRepoConfigs,
  upsertRepoConfig,
  updateRepoConfigEnabled,
} from '@server/db/repo-configs';
import { getOrCreateRepository } from '@server/db/repositories';
import { defaultRepoConfig, normalizeRepoConfig, repoConfigSchema } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// Requires migrations 001-009 applied to TEST_DATABASE_URL (run via `npm test`). Skipped when no
// test database is configured, matching test/add-bitbucket-repo.spec.ts.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// Unique per-run namespace so the never-reset test DB does not accumulate colliding rows across
// runs (Codra test-env quirk). Bitbucket identities are stored lowercase, so keep names lowercase.
const RUN = `p1204${Date.now().toString(36)}`;

dbDescribe('repo-configs — Bitbucket read/write path (D-04/D-05, provider isolation)', () => {
  const env = createTestEnv();

  // Every owner/workspace this spec seeds. afterAll purges repo_configs (by repository_id) then the
  // repositories rows, for both providers, so nothing leaks into other specs' list reads.
  const owners = new Set<string>();

  async function purge(owner: string) {
    await queryRows(
      env,
      `DELETE FROM repo_configs WHERE repository_id IN (SELECT id FROM repositories WHERE owner = $1)`,
      [owner],
    );
    await queryRows(env, `DELETE FROM repositories WHERE owner = $1`, [owner]);
  }

  async function purgeAll() {
    for (const owner of owners) {
      await purge(owner);
    }
  }

  // Seed a Bitbucket repositories row (NULL installation_id) via the real bitbucket branch.
  async function seedBitbucketRepo(workspace: string, repo: string) {
    owners.add(workspace);
    return getOrCreateRepository(env, {
      installationId: '',
      vcsProvider: 'bitbucket',
      owner: workspace,
      repo,
      workspace,
    });
  }

  // Seed a GitHub repositories row (non-null installation_id) via the real github branch.
  async function seedGithubRepo(owner: string, repo: string, installationId: string) {
    owners.add(owner);
    return getOrCreateRepository(env, { installationId, owner, repo });
  }

  beforeAll(async () => {
    await purgeAll();
  });

  afterAll(async () => {
    await purgeAll();
  });

  it('D-04: a Bitbucket row with NULL installation_id + a repo_config maps without throwing (installationId null, workspace populated)', async () => {
    const ws = `${RUN}d04`;
    const repo = 'repo-a';
    await seedBitbucketRepo(ws, repo);
    // Materialize a config via the provider-aware write path.
    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: ws,
      installationId: null,
      owner: ws,
      repo,
      parsedJson: defaultRepoConfig,
    });

    const record = await getRepoConfigRecord(env, ws, repo, 'bitbucket');
    expect(record).not.toBeNull();
    expect(record?.installationId).toBeNull();
    expect(record?.workspace).toBe(ws);
    expect(record?.vcsProvider).toBe('bitbucket');

    // Also proves listRepoConfigs maps the NULL-installation row without a Zod 500.
    const list = await listRepoConfigs(env);
    const listed = list.find((r) => r.owner === ws && r.repo === repo);
    expect(listed).toBeDefined();
    expect(listed?.installationId).toBeNull();
  });

  it('D-05 list materialization: a config-less Bitbucket repo is returned by listRepoConfigs; a config-less GitHub repo is NOT', async () => {
    const ws = `${RUN}mat`;
    const bbRepo = 'bb-nocfg';
    const ghRepo = 'gh-nocfg';
    await seedBitbucketRepo(ws, bbRepo); // no repo_config created
    await seedGithubRepo(ws, ghRepo, '5001'); // no repo_config created

    const list = await listRepoConfigs(env);
    const bb = list.find((r) => r.owner === ws && r.repo === bbRepo);
    const gh = list.find((r) => r.owner === ws && r.repo === ghRepo);

    expect(bb).toBeDefined(); // materialized default surfaced it
    expect(bb?.vcsProvider).toBe('bitbucket');
    expect(gh).toBeUndefined(); // GitHub is never materialized
  });

  it('D-05 read lazy default: getRepoConfigRecord for a config-less Bitbucket repo returns a persisted default that round-trips', async () => {
    const ws = `${RUN}lazy`;
    const repo = 'lazy-repo';
    await seedBitbucketRepo(ws, repo); // no repo_config

    const record = await getRepoConfigRecord(env, ws, repo, 'bitbucket');
    expect(record).not.toBeNull();
    expect(record?.installationId).toBeNull();
    expect(record?.parsedJson).toEqual(normalizeRepoConfig(defaultRepoConfig));

    // The default was persisted: a repo_config row now exists for this repository.
    const [{ count }] = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM repo_configs rc
         JOIN repositories r ON rc.repository_id = r.id
        WHERE r.vcs_provider = 'bitbucket' AND r.workspace = $1 AND r.repo = $2`,
      [ws, repo],
    );
    expect(count).toBe('1');

    // A subsequent provider-aware upsert round-trips through the same repository row.
    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: ws,
      installationId: null,
      owner: ws,
      repo,
      parsedJson: { ...defaultRepoConfig, review: { ...defaultRepoConfig.review, max_files: 42 } },
    });
    const after = await getRepoConfigRecord(env, ws, repo, 'bitbucket');
    expect(after?.parsedJson.review.max_files).toBe(42);
  });

  it('D-05 write: upsertRepoConfig with vcsProvider=bitbucket keeps installation_id NULL and does not create a same-named GitHub row', async () => {
    const ws = `${RUN}write`;
    const repo = 'write-repo';
    await seedBitbucketRepo(ws, repo);

    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: ws,
      installationId: null,
      owner: ws,
      repo,
      parsedJson: defaultRepoConfig,
    });

    const rows = await queryRows<{ vcs_provider: string; installation_id: string | null }>(
      env,
      `SELECT vcs_provider, installation_id FROM repositories WHERE owner = $1 AND repo = $2`,
      [ws, repo],
    );
    expect(rows).toHaveLength(1); // ONLY the Bitbucket row — no GitHub row cross-created
    expect(rows[0].vcs_provider).toBe('bitbucket');
    expect(rows[0].installation_id).toBeNull();
  });

  it('provider isolation: same-named GitHub+Bitbucket reads resolve per-provider and updateRepoConfigEnabled toggles exactly one row', async () => {
    const name = `${RUN}iso`;
    owners.add(name);

    // Same owner/repo TEXT for both providers (allowed by migration 003). upsertRepoConfig creates
    // both the repositories row and its config through the provider-correct branch.
    await upsertRepoConfig(env, {
      installationId: '9001',
      owner: name,
      repo: name,
      parsedJson: defaultRepoConfig,
      enabled: true,
    });
    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: name,
      installationId: null,
      owner: name,
      repo: name,
      parsedJson: defaultRepoConfig,
      enabled: true,
    });

    const gh = await getRepoConfigRecord(env, name, name, 'github');
    const bb = await getRepoConfigRecord(env, name, name, 'bitbucket');
    expect(gh?.vcsProvider).toBe('github');
    expect(gh?.installationId).toBe('9001');
    expect(bb?.vcsProvider).toBe('bitbucket');
    expect(bb?.installationId).toBeNull();

    // Toggle ONLY the Bitbucket row off.
    await updateRepoConfigEnabled(env, {
      owner: name,
      repo: name,
      enabled: false,
      vcsProvider: 'bitbucket',
    });

    const ghAfter = await getRepoConfigRecord(env, name, name, 'github');
    const bbAfter = await getRepoConfigRecord(env, name, name, 'bitbucket');
    expect(bbAfter?.enabled).toBe(false); // toggled
    expect(ghAfter?.enabled).toBe(true); // untouched
  });
});

// Pure schema assertions — deliberately NOT inside dbDescribe. These pin the QA-IDX-01 default-off
// contract (NREG-01) and must run on every host, including one with no TEST_DATABASE_URL.
describe('repoConfigSchema — review.interactive.qa.index (QA-IDX-01 / D-16-R, NREG-01 default-off)', () => {
  const INDEX_DEFAULTS = { enabled: false, max_files: 500, chunk_lines: 50, top_k: 8 } as const;

  // The four shapes below each exercise a DIFFERENT Zod resolution path. Zod 4 returns a
  // `.default(literal)` value WITHOUT re-parsing it, so an edit that only touched the inner
  // `z.object` would leave `index` undefined for the three outer shapes. Each case therefore pins one
  // literal, and together they would fail on an inner-object-only edit.
  const shapes: Array<{ label: string; input: unknown }> = [
    { label: 'nothing at all (outer reviewConfigSchema.default literal)', input: {} },
    { label: 'review present, interactive absent (interactive .default literal)', input: { review: {} } },
    { label: 'interactive present, qa absent (qa .default literal)', input: { review: { interactive: {} } } },
    { label: 'qa present as {} (index z.object .default)', input: { review: { interactive: { qa: {} } } } },
  ];

  for (const { label, input } of shapes) {
    it(`materializes every index default when the config supplies ${label}`, () => {
      const index = repoConfigSchema.parse(input).review.interactive.qa.index;

      // NREG-01: the toggle is off, so a repository that has not opted in does no retrieval, stores
      // no index and runs no build.
      expect(index.enabled).toBe(false);
      // Real values, not `undefined` — the whole point of the three-site discipline.
      expect(index).toEqual(INDEX_DEFAULTS);
      expect(typeof index.max_files).toBe('number');
      expect(typeof index.chunk_lines).toBe('number');
      expect(typeof index.top_k).toBe('number');
    });
  }

  it('leaves the other three knobs at their defaults when only index.enabled is supplied', () => {
    const index = repoConfigSchema.parse({
      review: { interactive: { qa: { index: { enabled: true } } } },
    }).review.interactive.qa.index;

    expect(index).toEqual({ ...INDEX_DEFAULTS, enabled: true });
  });

  it('does not disturb the pre-existing qa defaults', () => {
    expect(defaultRepoConfig.review.interactive.qa.enabled).toBe(false);
    expect(defaultRepoConfig.review.interactive.qa.rate_limit_per_hour).toBe(10);
    // defaultRepoConfig is itself repoConfigSchema.parse({}), so this doubles as the exported-oracle
    // assertion for the new block.
    expect(defaultRepoConfig.review.interactive.qa.index).toEqual(INDEX_DEFAULTS);
  });

  // T-29-02-01: every numeric key is bounded so an authenticated-but-malicious config write cannot
  // request an unbounded build or an unbounded retrieval.
  it.each([
    ['max_files', 2_001],
    ['chunk_lines', 501],
    ['top_k', 51],
  ])('rejects %s above its declared .max() bound (%i)', (key, value) => {
    const result = repoConfigSchema.safeParse({
      review: { interactive: { qa: { index: { [key]: value } } } },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ['max_files', 0],
    ['chunk_lines', 0],
    ['top_k', -1],
  ])('rejects a non-positive %s (%i)', (key, value) => {
    const result = repoConfigSchema.safeParse({
      review: { interactive: { qa: { index: { [key]: value } } } },
    });
    expect(result.success).toBe(false);
  });

  // BOUNDARY PAIR on max_files. The 2 000 ceiling was confirmed by the developer at the 29-02 Task 1
  // checkpoint (D-16-R), tightened from a drafted 5 000 because the build advances ~12 files per
  // minute, so 2 000 is roughly a three-hour worst legal request and 5 000 roughly seven hours.
  // Pinning BOTH sides means the ceiling cannot drift looser without failing this suite.
  it('accepts max_files exactly at the confirmed 2000 ceiling and rejects 2001', () => {
    const accepted = repoConfigSchema.safeParse({
      review: { interactive: { qa: { index: { max_files: 2_000 } } } },
    });
    expect(accepted.success).toBe(true);
    expect(accepted.success && accepted.data.review.interactive.qa.index.max_files).toBe(2_000);

    const rejected = repoConfigSchema.safeParse({
      review: { interactive: { qa: { index: { max_files: 2_001 } } } },
    });
    expect(rejected.success).toBe(false);
  });

  it('round-trips the index block through normalizeRepoConfig unchanged (spread-based, no special case)', () => {
    const parsed = repoConfigSchema.parse({
      review: { interactive: { qa: { index: { enabled: true, max_files: 1_200 } } } },
    });
    expect(normalizeRepoConfig(parsed).review.interactive.qa.index).toEqual({
      ...INDEX_DEFAULTS,
      enabled: true,
      max_files: 1_200,
    });
  });
});
