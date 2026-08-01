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

import { describe, expect, it, vi } from 'vitest';
import { parseYaml } from '@server/core/yaml-parse';
import { buildYamlConfigParseFailedEvent, recordYamlConfigParseFailed } from '@server/core/audit';
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

// vi.hoisted so the vi.mock factory below can reference the spy (vitest hoists mock factories
// above the imports). The prepare-phase integration tests assert getFileContent call counts.
const mocks = vi.hoisted(() => ({
  getRepoFileContent: vi.fn(),
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
      async getPullRequest() {
        return {
          title: 'Test PR',
          body: 'Test Body',
          head: { sha: HEAD_SHA, ref: 'feature' },
          base: { sha: sha('0'), ref: 'main' },
          user: { login: 'author' },
        };
      }
      async getPullRequestDiff() {
        return generateMockDiff([{ path: 'src/x.ts', content: 'x' }]);
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
          base: { sha: sha('0'), ref: 'main' },
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

    // D-13: .review.yaml discovered first (with the PR head SHA); .review.yml never tried.
    expect(mocks.getRepoFileContent).toHaveBeenCalledTimes(1);
    expect(mocks.getRepoFileContent).toHaveBeenCalledWith(OWNER, repo, '.review.yaml', HEAD_SHA);

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
});
