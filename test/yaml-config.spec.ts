// Phase 34 (PRD-05, §15): YAML config pipeline tests — YAML → JS object → Zod validation → merge.
//
// PURE Zod tests (no DB). This file locks the D-09 merge contract as a tested expression:
// `repoConfigSchema.parse({ ...dbConfig, ...yamlDeclared })` — a YAML-declared top-level key
// replaces the DB key WHOLESALE ("right-biased for the entire nested subtree"), sub-keys the YAML
// subtree omits revert to their Zod schema defaults (review.max_files → 150, never the DB's 100),
// and top-level keys the YAML does not declare keep their DB values (model.main unchanged).
// Deep-merging sub-keys (which would yield 100) FAILS this contract. 34-03 Task 1 re-implements
// the same expression inside runPreparePhase.
//
// Also pins: the yaml_config_parse_failed audit-event shape via jobAuditEventSchema (the
// builder/recorder family itself is 34-03's — here the SHAPE is the contract), the identity
// merge for an absent YAML file, unknown-key stripping, and the .review.yaml-before-.review.yml
// discovery ordering.
//
// quick-k31 (WR-03) — READ FROM THE BASE BRANCH. `runPreparePhase` fetches the config file at
// `pr.baseSha`, NOT `pr.headSha`. This deliberately reverses the head half of D-13 (its
// first-found-wins / re-read-every-review / no-cache half stands): `pr.headSha` is a ref the PR
// author controls and the D-09 merge is wholesale, so a head-side `skip_files: ["**"]` used to buy
// an author a green review that examined nothing. The integration block below pins the fetch ref,
// pins that a head-side neutering config is inert, pins the fail-closed empty-base-SHA path (no
// fetch, no head fallback, no crash), and pins the `yaml_config_head_ignored` notice.

import { describe, expect, it, vi } from 'vitest';
import { parseYaml } from '@server/core/yaml-parse';
import {
  buildYamlConfigAppliedEvent,
  buildYamlConfigParseFailedEvent,
  recordYamlConfigApplied,
  recordYamlConfigParseFailed,
} from '@server/core/audit';
import * as jobsModule from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { repoConfigSchema, jobAuditEventSchema, defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { runReviewJob } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';
import { findExistingJobForHead } from '@server/db/jobs';
import { getOrCreateRepository } from '@server/db/repositories';
import { upsertRepoConfig } from '@server/db/repo-configs';
import { queryRows } from '@server/db/client';

const sha = (char: string) => char.repeat(40);
const OWNER = 'test-owner';
const INSTALLATION_ID = '123';
const PR_NUMBER = 1;
const HEAD_SHA = sha('c');
// quick-k31 (WR-03): the ref config discovery must actually read from. Named (rather than the
// inline `sha('0')` it replaces) so the base-vs-head assertions below are unmistakable.
const BASE_SHA = sha('0');

// vi.hoisted so the vi.mock factory below can reference the spy (vitest hoists mock factories
// above the imports). The prepare-phase integration tests assert getFileContent call counts.
// quick-k31: `getPullRequest` and `getPullRequestDiff` are spies too so a single test can vary the
// PR's base SHA (the fail-closed case) or the reviewed diff (the head-ignored notice) without
// touching the shared class. Their defaults are (re-)installed in the integration block's
// beforeEach, so every pre-existing test keeps today's behavior byte-for-byte.
const mocks = vi.hoisted(() => ({
  getRepoFileContent: vi.fn(),
  getPullRequest: vi.fn(),
  getPullRequestDiff: vi.fn(),
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    // Concurrency admission in runReviewJob returns 'retry' when the shared test DB has too
    // many running jobs; force the count to 0 so prepare actually runs.
    getOtherRunningJobsCount: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('@server/services/github', () => {
  return {
    GitHubService: class MockGitHubService {
      async getPullRequest(...args: any[]) {
        return mocks.getPullRequest(...args);
      }
      async getPullRequestDiff(...args: any[]) {
        return mocks.getPullRequestDiff(...args);
      }
      async getCompareDiff() {
        return '';
      }
      async createCheckRun() {
        return { id: 1 };
      }
      async updateCheckRun() {
        return {};
      }
      async createReview() {
        return { id: 999 };
      }
      async findBotReviewForCommit() {
        return null;
      }
      async ensureLabel() {
        return {};
      }
      async addIssueLabels() {
        return {};
      }
      async removeIssueLabelsIfPresent() {
        return {};
      }
      async getReviewThreads() {
        return [];
      }
      async resolveReviewThread() {
        return true;
      }
      async getRepoFileContent(...args: any[]) {
        return mocks.getRepoFileContent(...args);
      }
      async getRepoFileOrNull() {
        return null;
      }
      async getBotIdentity() {
        return { accountId: 'bot-1', login: 'codra-app' };
      }
      async createStatusCheck() {
        return { ref: 'status-ref' };
      }
      async updateStatusCheck() {
        return;
      }
      async resolveBotUserIdentity() {
        return { accountId: 'bot-1', login: 'codra-app' };
      }
      async getUserRepoPermission() {
        return 'admin';
      }
    },
  };
});

// quick-k31: the byte-for-byte defaults the mocked class used to hard-code. Re-installed before
// every integration test so a test that overrides one of them cannot leak into the next.
function installVcsMockDefaults() {
  mocks.getPullRequest.mockResolvedValue({
    title: 'Test PR',
    body: 'Test Body',
    head: { sha: HEAD_SHA, ref: 'feature' },
    base: { sha: BASE_SHA, ref: 'main' },
    user: { login: 'author' },
  });
  mocks.getPullRequestDiff.mockResolvedValue(generateMockDiff([{ path: 'src/x.ts', content: 'x' }]));
}
installVcsMockDefaults();

function auditEventFor(reason: string) {
  return { stage: 'yaml_config_parse_failed', reason, timestamp: new Date().toISOString() };
}

describe('YAML config pipeline', () => {
  it('parses valid full config YAML into a normalized RepoConfig', () => {
    const raw = [
      '# .review.yaml',
      'review:',
      '  max_comments: 5',
      '  max_files: 100',
      '  custom_rules:',
      '    - "no console.log"',
      '    - "no any type"',
      '  skip_files:',
      '    - "*.lock"',
      '    - "dist/**"',
      'model:',
      '  main: "claude-sonnet-4-20250514"',
      '  fallbacks:',
      '    - "gpt-4o"',
    ].join('\n');

    const config = repoConfigSchema.parse(parseYaml(raw));

    expect(config.review.max_comments).toBe(5);
    expect(config.review.max_files).toBe(100);
    expect(config.review.custom_rules).toEqual(['no console.log', 'no any type']);
    expect(config.review.skip_files).toEqual(['*.lock', 'dist/**']);
    expect(config.model.main).toBe('claude-sonnet-4-20250514');
    expect(config.model.fallbacks).toEqual(['gpt-4o']);
  });

  it('applies Zod defaults for missing sub-keys in a partial config', () => {
    const config = repoConfigSchema.parse(parseYaml('review:\n  max_comments: 3'));

    expect(config.review.max_comments).toBe(3);
    // Zod default at schema.ts — the DB value would be irrelevant here; the schema fills it.
    expect(config.review.max_files).toBe(150);
    expect(config.review.max_diff_lines_per_file).toBe(800);
    expect(config.model.main).toBeNull();
    expect(config.review.file_history.enabled).toBe(false);
    expect(config.review.yaml_config.enabled).toBe(false);
  });

  it('validates the yaml_config_parse_failed audit event shape (schema contract)', () => {
    const event = auditEventFor('Invalid YAML syntax');

    const parsed = jobAuditEventSchema.parse(event);
    expect(parsed.stage).toBe('yaml_config_parse_failed');
    expect(parsed.reason).toBe('Invalid YAML syntax');
  });

  it('rejects a reason longer than the 500-char bound (builder must slice to 500)', () => {
    const event = auditEventFor('x'.repeat(600));

    expect(jobAuditEventSchema.safeParse(event).success).toBe(false);
  });

  it('falls back to DB config when parseYaml throws (catch-and-keep semantics)', () => {
    const dbConfig = repoConfigSchema.parse({
      review: { max_comments: 10, max_files: 100 },
      model: { main: 'gpt-4o', fallbacks: [], size_overrides: [] },
    });

    let parseError: unknown;
    try {
      parseYaml('key: |\n  multi\n  line');
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toBeInstanceOf(Error);
    expect((parseError as Error).message).toMatch(/^YAML parse error:/);
    // The DB config is the resolved config, unchanged — and the failure reason still validates
    // against the audit-event schema so the 34-03 recorder can emit it.
    const auditEvent = auditEventFor((parseError as Error).message);
    expect(jobAuditEventSchema.safeParse(auditEvent).success).toBe(true);
    expect(dbConfig.review.max_comments).toBe(10);
    expect(dbConfig.review.max_files).toBe(100);
  });

  it('D-09: top-level key replacement with Zod default fill (the contract 34-03 implements)', () => {
    const dbConfig = repoConfigSchema.parse({
      review: { max_comments: 10, max_files: 100 },
      model: { main: 'gpt-4o', fallbacks: [], size_overrides: [] },
    });
    const yamlDeclared = parseYaml('review:\n  max_comments: 3');

    const merged = repoConfigSchema.parse({ ...dbConfig, ...yamlDeclared });

    // YAML-declared top-level key replaces the DB key wholesale.
    expect(merged.review.max_comments).toBe(3);
    // Sub-keys the YAML subtree omits revert to Zod schema defaults — the DB's 100 is NOT retained
    // (right-biased for the entire nested subtree). A deep merge would yield 100 and fail this.
    expect(merged.review.max_files).toBe(150);
    // Top-level key the YAML does not declare at all keeps its DB value.
    expect(merged.model.main).toBe('gpt-4o');
  });

  it('no YAML file → the merge expression is identity (DB config used as-is)', () => {
    const dbConfig = repoConfigSchema.parse({
      review: { max_comments: 10, max_files: 100 },
      model: { main: 'gpt-4o', fallbacks: [], size_overrides: [] },
    });

    const merged = repoConfigSchema.parse({ ...dbConfig, ...{} });

    expect(merged).toEqual(dbConfig);
    expect(merged.review.max_comments).toBe(10);
    expect(merged.review.max_files).toBe(100);
  });

  it('unknown top-level YAML keys are stripped by Zod (default .strip() behavior)', () => {
    const merged = repoConfigSchema.parse(parseYaml('bogus_key: "hello"'));

    expect(merged).toBeDefined();
    expect((merged as Record<string, unknown>).bogus_key).toBeUndefined();
  });

  it('valid YAML but invalid Zod throws, and the failure reason fits the audit event shape', () => {
    const yamlDeclared = parseYaml('review:\n  max_comments: "not_a_number"');

    expect(() => repoConfigSchema.parse(yamlDeclared)).toThrow();

    const auditEvent = auditEventFor('review.max_comments must be a number');
    expect(jobAuditEventSchema.safeParse(auditEvent).success).toBe(true);
  });

  it('first found file wins — .review.yaml before .review.yml', () => {
    // Simulation of the discovery contract: the caller (34-03) tries .review.yaml first and only
    // falls through to .review.yml when the first file is absent. Pinning the ordering here.
    const reviewYaml = parseYaml('review:\n  max_comments: 3');
    const reviewYml = parseYaml('review:\n  max_comments: 7');

    const candidates = [
      { path: '.review.yaml', parsed: reviewYaml },
      { path: '.review.yml', parsed: reviewYml },
    ];
    // Discovery in order, stopping at the first file that parses successfully.
    const found = candidates.find((candidate) => candidate.parsed !== null);

    expect(found?.path).toBe('.review.yaml');
    const config = repoConfigSchema.parse(found?.parsed ?? {});
    expect(config.review.max_comments).toBe(3);
  });

  it('flow-style and block-style arrays round-trip through the schema (MEDIUM-5 shapes)', () => {
    const config = repoConfigSchema.parse(
      parseYaml('review:\n  on: [opened, synchronize]\n  skip_files: ["*.lock", "dist/**"]'),
    );

    expect(config.review.on).toEqual(['opened', 'synchronize']);
    expect(config.review.skip_files).toEqual(['*.lock', 'dist/**']);
  });
});

// ---------------------------------------------------------------------------
// Phase 34 (34-03 Task 1): the audit builder/recorder family runPreparePhase composes.
// The builder is pure; the recorder is best-effort / never-throws (mirrors
// recordFileSkips — the codebase has NO emitAuditEvent, D-12). These cases fail
// until the 34-03 Task 1 GREEN lands.
// ---------------------------------------------------------------------------

describe('Phase 34 (34-03): YAML config audit builder/recorder', () => {
  it('builds a valid yaml_config_parse_failed event via the builder', () => {
    const event = buildYamlConfigParseFailedEvent('Invalid YAML syntax at line 3');
    const parsed = jobAuditEventSchema.parse(event);
    expect(parsed.stage).toBe('yaml_config_parse_failed');
    expect(parsed.reason).toBe('Invalid YAML syntax at line 3');
  });

  it('slices a 600-char reason to the 500-char schema bound', () => {
    const event = buildYamlConfigParseFailedEvent('x'.repeat(600));
    expect(event.reason).toHaveLength(500);
    expect(jobAuditEventSchema.safeParse(event).success).toBe(true);
  });

  // WR-02 (34-REVIEW): the reason derives from an error raised over UNTRUSTED PR-head content and
  // is persisted to jobs.audit + rendered in the dashboard. parseYaml no longer echoes source text
  // (see yaml-parse.spec.ts); this is the builder-level second layer for reasons it does not
  // control (Zod messages, future producers).
  it('scrubs credential-shaped tokens out of the reason before persisting it', () => {
    const event = buildYamlConfigParseFailedEvent('bad value near ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here');
    expect(event.reason).toBe('bad value near [REDACTED] here');
  });

  it('scrubs BEFORE slicing so a token straddling the 500-char bound cannot survive as a partial', () => {
    const filler = 'y'.repeat(490);
    const event = buildYamlConfigParseFailedEvent(`${filler} sk-AAAAAAAAAAAAAAAAAAAAAAAA`);
    expect(event.reason).not.toContain('sk-');
    expect(String(event.reason).length).toBeLessThanOrEqual(500);
  });

  // WR-03 / WR-07 (34-REVIEW): the success-path event that makes the D-09 wholesale replacement
  // (and Zod's silent unknown-key strip) observable.
  it('builds a valid yaml_config_applied event naming the replaced and ignored top-level keys', () => {
    const event = buildYamlConfigAppliedEvent('.review.yaml', ['review'], ['reveiw']);
    const parsed = jobAuditEventSchema.parse(event);
    expect(parsed.stage).toBe('yaml_config_applied');
    expect(parsed).toMatchObject({ source: '.review.yaml', replaced_keys: ['review'], ignored_keys: ['reveiw'] });
  });

  it('bounds untrusted key names to 20 entries of at most 64 chars each (schema bound)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `k${i}`.padEnd(90, 'x'));
    const event = buildYamlConfigAppliedEvent('.review.yaml', many, many);
    expect(jobAuditEventSchema.safeParse(event).success).toBe(true);
    expect((event as unknown as { replaced_keys: string[] }).replaced_keys).toHaveLength(20);
    expect((event as unknown as { ignored_keys: string[] }).ignored_keys.every((k) => k.length <= 64)).toBe(true);
  });

  it('recordYamlConfigApplied appends the builder-shaped event and never throws on a rejected write', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(recordYamlConfigApplied(env, 'job-id', '.review.yml', ['model'], [])).resolves.toBeUndefined();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][2][0]).toMatchObject({
      stage: 'yaml_config_applied',
      source: '.review.yml',
      replaced_keys: ['model'],
      ignored_keys: [],
    });
    expect(warnSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('recordYamlConfigParseFailed appends via appendJobAuditEvents and never throws on a rejected write', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi
      .spyOn(jobsModule, 'appendJobAuditEvents')
      .mockRejectedValue(new Error('simulated audit-write failure'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(
      recordYamlConfigParseFailed(env, jobId, 'Invalid YAML syntax at line 3'),
    ).resolves.toBeUndefined();
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('recordYamlConfigParseFailed appends the builder-shaped event with a stamped timestamp', async () => {
    const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as any;
    const jobId = 'job-id';
    const appendSpy = vi.spyOn(jobsModule, 'appendJobAuditEvents').mockResolvedValue(undefined);
    await recordYamlConfigParseFailed(env, jobId, 'bad yaml');
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const passedEvent = appendSpy.mock.calls[0][2][0];
    expect(passedEvent.stage).toBe('yaml_config_parse_failed');
    expect(passedEvent.reason).toBe('bad yaml');
    expect(passedEvent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    appendSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Phase 34 (34-03 Task 3): prepare-phase integration — the runPreparePhase YAML block
// composed end-to-end. DB-gated: drives the REAL runReviewJob prepare phase against a
// mocked GitHubService whose getRepoFileContent serves (or withholds) .review.yaml.
// Proves the D-09 merge contract through the prepare phase, config_snapshot persistence
// (review HIGH-2), and the NREG-01 toggle-off inertness (zero getFileContent calls, zero
// yaml_config_parse_failed audit events, byte-identical config).
// ---------------------------------------------------------------------------

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('Phase 34 (34-03): prepare-phase YAML config integration', () => {
  const env = createTestEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getRepoFileContent.mockReset();
    mocks.getPullRequest.mockReset();
    mocks.getPullRequestDiff.mockReset();
    installVcsMockDefaults();
  });

  async function seedRepoWithYamlToggle(repo: string, enabled: boolean, maxComments: number, maxFiles: number) {
    await getOrCreateRepository(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      vcsProvider: 'github',
    });
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.yaml_config = { enabled };
    parsedJson.review.max_comments = maxComments;
    parsedJson.review.max_files = maxFiles;
    await upsertRepoConfig(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo,
      parsedJson,
    });
  }

  async function runPrepare(repo: string) {
    return runReviewJob(env, {
      deliveryId: `delivery-yaml-${Date.now()}`,
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: INSTALLATION_ID },
        repository: { owner: { login: OWNER }, name: repo },
        pull_request: {
          number: PR_NUMBER,
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: BASE_SHA, ref: 'main' },
          title: 'Test PR',
          user: { login: 'author' },
          draft: false,
        },
      },
    } as any);
  }

  async function jobFor(repo: string) {
    return findExistingJobForHead(env, {
      owner: OWNER,
      repo,
      prNumber: PR_NUMBER,
      commitSha: HEAD_SHA,
      trigger: 'auto',
    });
  }

  it('D-09 + HIGH-2: valid .review.yaml merges at top-level boundaries and persists to config_snapshot', async () => {
    const repo = `repo-yaml-on-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100); // DB review: max_comments 10, max_files 100
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, path: string) =>
      path === '.review.yaml' ? 'review:\n  max_comments: 3' : null,
    );

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    // .review.yaml discovered first, read at the BASE BRANCH TIP (quick-k31 reversed D-13's head
    // half; its first-found-wins half stands, so .review.yml is never tried).
    expect(mocks.getRepoFileContent).toHaveBeenCalledTimes(1);
    expect(mocks.getRepoFileContent).toHaveBeenCalledWith(OWNER, repo, '.review.yaml', BASE_SHA);

    const job = await jobFor(repo);
    // review HIGH-2: the merged config round-trips through jobs.config_snapshot so
    // review/finalize/critic/verify-fixes observe the YAML override.
    expect(job!.configSnapshot!.review.max_comments).toBe(3);
    // D-09 (checker context_compliance fix): the YAML review subtree replaces the DB subtree
    // wholesale — sub-keys the YAML omits revert to the Zod schema default (150), NOT the
    // DB's 100. A deep merge would yield 100 and fail this assertion.
    expect(job!.configSnapshot!.review.max_files).toBe(150);
    // Undeclared top-level keys keep their DB values.
    expect(job!.configSnapshot!.review.file_history.enabled).toBe(false);
  });

  // WR-03 (34-REVIEW): the D-09 merge is a WHOLESALE top-level replacement, so an innocuous-looking
  // two-line .review.yaml resets every operator-configured sub-key of `review` (here: the security
  // pass) to its Zod default, and that reset is persisted to jobs.config_snapshot. quick-k31 closed
  // the TAMPERING half of WR-03 at the source (the file now comes from the maintainer-reviewed base
  // branch — see the tests below), so the config here is trusted; what this test pins is that the
  // wholesale reset is OBSERVABLE: a yaml_config_applied event names the replaced top-level keys.
  it('WR-03: a base-branch YAML that resets the security pass records which top-level keys it replaced', async () => {
    const repo = `repo-yaml-wr03-${Date.now()}`;
    await getOrCreateRepository(env, { installationId: INSTALLATION_ID, owner: OWNER, repo, vcsProvider: 'github' });
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.yaml_config = { enabled: true };
    parsedJson.review.passes.security.enabled = true; // operator turned the security pass ON
    await upsertRepoConfig(env, { installationId: INSTALLATION_ID, owner: OWNER, repo, parsedJson });

    // Looks like it only adds a lint rule.
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, path: string) =>
      path === '.review.yaml' ? 'review:\n  custom_rules:\n    - prefer const' : null,
    );

    await runPrepare(repo);
    const job = await jobFor(repo);

    // The documented D-09 consequence, unchanged: the operator's security pass is now off.
    expect(job!.configSnapshot!.review.passes.security.enabled).toBe(false);

    // ...and the audit trail now SAYS SO instead of staying silent.
    const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
    const applied = ((rows[0]?.audit as Array<Record<string, unknown>>) ?? []).find(
      (event) => event.stage === 'yaml_config_applied',
    );
    expect(applied).toBeDefined();
    expect(applied).toMatchObject({ source: '.review.yaml', replaced_keys: ['review'], ignored_keys: [] });
  });

  // WR-07 (34-REVIEW): repoConfigSchema is non-strict, so a typo'd top-level key is stripped by Zod
  // and the merge is an identity — previously with NO warning and NO event, leaving the operator
  // with no signal that their file did nothing.
  it('WR-07: a typo\'d top-level key is reported as ignored rather than being a silent no-op', async () => {
    const repo = `repo-yaml-wr07-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, path: string) =>
      path === '.review.yaml' ? 'reveiw:\n  max_files: 5' : null,
    );

    await runPrepare(repo);
    const job = await jobFor(repo);

    // Identity merge: the DB config still governs.
    expect(job!.configSnapshot!.review.max_files).toBe(100);

    const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
    const applied = ((rows[0]?.audit as Array<Record<string, unknown>>) ?? []).find(
      (event) => event.stage === 'yaml_config_applied',
    );
    expect(applied).toMatchObject({ replaced_keys: [], ignored_keys: ['reveiw'] });
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes('Ignored 1 unknown top-level key')),
    ).toBe(true);
  });

  // WR-01 (34-REVIEW): a transient provider failure on the .review.yaml probe must NOT be recorded
  // as a parse failure and must NOT suppress the .review.yml fallback. Before the fix, one try
  // wrapped getFileContent + parseYaml + both Zod parses, so a GitHub 500 emitted
  // yaml_config_parse_failed (blaming the operator's syntax for an API hiccup) and `break`ed —
  // a repo that uses `.review.yml` silently lost its config for that review.
  it('WR-01: a fetch failure on .review.yaml falls through to .review.yml with no parse-failed event', async () => {
    const repo = `repo-yaml-fetchfail-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, path: string) => {
      if (path === '.review.yaml') throw Object.assign(new Error('GitHub API failed with 500'), { status: 500 });
      return 'review:\n  max_comments: 7';
    });

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    // BOTH candidates were probed — the failure did not stop discovery.
    expect(mocks.getRepoFileContent).toHaveBeenCalledTimes(2);
    expect(mocks.getRepoFileContent.mock.calls.map((call: any[]) => call[2])).toEqual(['.review.yaml', '.review.yml']);

    // The .review.yml config actually applied.
    const job = await jobFor(repo);
    expect(job!.configSnapshot!.review.max_comments).toBe(7);

    // The infrastructure failure is a warning, NOT a yaml_config_parse_failed audit event (D-12).
    expect(warnSpy.mock.calls.some(([message]) => String(message).includes('Failed to fetch .review.yaml'))).toBe(true);
    const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
    const stages = ((rows[0]?.audit as Array<{ stage: string }>) ?? []).map((event) => event.stage);
    expect(stages).not.toContain('yaml_config_parse_failed');
  });

  // Discovery still stops at the first file FOUND, even when that file fails to parse — falling
  // through to .review.yml on a parse failure would let a syntactically broken .review.yaml be
  // silently shadowed by a stale .review.yml.
  it('WR-01: a PARSE failure on .review.yaml still stops discovery and records the audit event', async () => {
    const repo = `repo-yaml-parsefail-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, path: string) =>
      path === '.review.yaml' ? 'review:\n  max_comments: |\n    block' : 'review:\n  max_comments: 7',
    );

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    expect(mocks.getRepoFileContent).toHaveBeenCalledTimes(1);
    const job = await jobFor(repo);
    // DB config retained (fallback), not the .review.yml value.
    expect(job!.configSnapshot!.review.max_comments).toBe(10);
    const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
    const stages = ((rows[0]?.audit as Array<{ stage: string }>) ?? []).map((event) => event.stage);
    expect(stages).toContain('yaml_config_parse_failed');
  });

  it('NREG-01: toggle off produces zero getFileContent calls, byte-identical config, zero audit events', async () => {
    const repo = `repo-yaml-off-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, false, 10, 100);

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });
    expect(mocks.getRepoFileContent).not.toHaveBeenCalled();

    const job = await jobFor(repo);
    // Byte-identical: the persisted config_snapshot is exactly the seeded DB config.
    expect(job!.configSnapshot!.review.max_comments).toBe(10);
    expect(job!.configSnapshot!.review.max_files).toBe(100);
    expect(job!.configSnapshot!.review.yaml_config.enabled).toBe(false);

    // Zero yaml_config_parse_failed audit events on the job.
    const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
    const stages = ((rows[0]?.audit as Array<{ stage: string }>) ?? []).map((event) => event.stage);
    expect(stages).not.toContain('yaml_config_parse_failed');
  });

  // -------------------------------------------------------------------------
  // quick-k31 (WR-03): the base-branch read and the head-ignored notice.
  //
  // PROVIDER COVERAGE: this fixture mocks only `@server/services/github`, so a Bitbucket prepare
  // run is not reachable here — but it does not need to be. Both adapters' `baseSha` mapping is
  // ALREADY pinned elsewhere: `test/vcs-github-adapter.spec.ts:39-55` ("flattens the nested PR
  // shape into a flat VcsPullRequest", asserting `baseSha: 'basesha1234567890'` from
  // `pr.base.sha`) and `test/bitbucket-client.spec.ts:48` (`baseSha: 'base123'` from
  // `pullRequest.destination.commit.hash`). Do NOT add duplicate adapter tests here.
  // -------------------------------------------------------------------------

  // Catches a regression to `pr.headSha` (or to any ref that is not the base tip): the mock THROWS
  // if it is ever asked for the head SHA, so a reverted ref fails loudly instead of quietly
  // returning the same config. Asserting the actual fetch ref — not just the call count — is the
  // whole point of this test.
  it('quick-k31: config discovery fetches at the BASE sha and never at the head', async () => {
    const repo = `repo-yaml-baseref-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, path: string, ref: string) => {
      if (ref === HEAD_SHA) throw new Error('config discovery must never read from the PR head');
      return ref === BASE_SHA && path === '.review.yaml' ? 'review:\n  max_comments: 3' : null;
    });

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    expect(mocks.getRepoFileContent).toHaveBeenCalledTimes(1);
    expect(mocks.getRepoFileContent).toHaveBeenCalledWith(OWNER, repo, '.review.yaml', BASE_SHA);

    const job = await jobFor(repo);
    expect(job!.configSnapshot!.review.max_comments).toBe(3);
  });

  // THE BYPASS IS DEAD. Catches a regression that lets head content reach the effective config.
  // The head file declares `skip_files: ["**"]`; if it were applied, `parseUnifiedDiff` would
  // ignore every file and prepare would enqueue `finalize` on zero reviewable files instead of
  // advancing to `review`. So the single `phase: 'review'` assertion is a DIRECT proof that the
  // head file did nothing — review theater is no longer purchasable by a PR author.
  it('quick-k31: a head-branch skip_files: ["**"] does not neuter the review', async () => {
    const repo = `repo-yaml-bypass-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    mocks.getRepoFileContent.mockImplementation(async (_o: string, _r: string, _path: string, ref: string) =>
      ref === HEAD_SHA ? 'review:\n  skip_files:\n    - "**"' : null,
    );

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    const job = await jobFor(repo);
    expect(job!.configSnapshot!.review.skip_files).not.toContain('**');
  });

  // FAIL CLOSED. Catches a fail-OPEN regression (a head fallback, or discovery running against an
  // empty ref). Only `getPullRequest` is overridden — the webhook payload's base sha is left alone
  // so `insertJob` stays on its normal path and the guard is isolated to the `pr.baseSha` the seam
  // call returns.
  it('quick-k31: an empty base SHA skips discovery entirely with a warn and no head fallback', async () => {
    const repo = `repo-yaml-nobase-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    mocks.getPullRequest.mockResolvedValue({
      title: 'Test PR',
      body: 'Test Body',
      head: { sha: HEAD_SHA, ref: 'feature' },
      base: { sha: '', ref: 'main' },
      user: { login: 'author' },
    });

    const prep = await runPrepare(repo);
    expect(prep).toMatchObject({ action: 'next_phase', phase: 'review' });

    // No fetch at ALL — not at the base ref, and emphatically not at the head.
    expect(mocks.getRepoFileContent).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes('no usable base SHA')),
    ).toBe(true);

    // The DB config still governs; nothing from the head leaked in.
    const job = await jobFor(repo);
    expect(job!.configSnapshot!.review.max_comments).toBe(10);
    expect(job!.configSnapshot!.review.max_files).toBe(100);
  });

  // Catches the notice going missing for the case it matters most in: a contributor ADDING
  // .review.yaml for the first time, where the base branch has no config at all. Without the event
  // that contributor gets a review that ignored their file and no explanation anywhere.
  it.each(['.review.yaml', '.review.yml'])(
    'quick-k31: records yaml_config_head_ignored when the reviewed diff touches %s',
    async (configPath) => {
      const repo = `repo-yaml-headignored-${configPath.replace(/\W/g, '')}-${Date.now()}`;
      await seedRepoWithYamlToggle(repo, true, 10, 100);
      mocks.getPullRequestDiff.mockResolvedValue(
        generateMockDiff([
          { path: configPath, content: 'review:' },
          { path: 'src/x.ts', content: 'x' },
        ]),
      );
      mocks.getRepoFileContent.mockResolvedValue(null); // no base-branch config — first-time add

      await runPrepare(repo);
      const job = await jobFor(repo);

      const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
      const ignored = ((rows[0]?.audit as Array<Record<string, unknown>>) ?? []).find(
        (event) => event.stage === 'yaml_config_head_ignored',
      );
      expect(ignored).toBeDefined();
      expect(ignored).toMatchObject({ path: configPath, base_sha: BASE_SHA, head_sha: HEAD_SHA });
    },
  );

  // The mirror guard: catches an emission that fires on every review regardless of the diff, which
  // would make the notice meaningless noise in the audit trail.
  it('quick-k31: does NOT record yaml_config_head_ignored when the diff leaves the config alone', async () => {
    const repo = `repo-yaml-noignore-${Date.now()}`;
    await seedRepoWithYamlToggle(repo, true, 10, 100);
    mocks.getRepoFileContent.mockResolvedValue(null);

    await runPrepare(repo);
    const job = await jobFor(repo);

    const rows = await queryRows<{ audit: unknown }>(env, `SELECT audit FROM jobs WHERE id = $1`, [job!.id]);
    const stages = ((rows[0]?.audit as Array<{ stage: string }>) ?? []).map((event) => event.stage);
    expect(stages).not.toContain('yaml_config_head_ignored');
  });
});
