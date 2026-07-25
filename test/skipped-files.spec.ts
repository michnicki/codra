import { describe, it, expect, beforeEach } from 'vitest';
import {
  insertSkippedFiles,
  listSkippedFilesForHead,
} from '@server/db/skipped-files';
import { insertJob, getJobForProcessing, mapJob } from '@server/db/jobs';
import { queryRows } from '@server/db/client';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { filterReviewableFiles, parseUnifiedDiff, partitionReviewableFiles } from '@server/core/diff';
import { getDiffFiles, getJobDiffFiles } from '@server/core/review';
import { createTestEnv, generateMockDiff, hasConfiguredTestDatabaseUrl } from './helpers';

// CMD-02 / D-10: prove the skipped-for-size bookkeeping accessors behave as review-rest requires.
// The lookup keys on PR identity + CURRENT head_sha across ANY job (REVIEW: Codex 11-01 HIGH), so a
// NEW review-rest job finds the ORIGINAL full-review job's skips. Runs against the migrated
// TEST_DATABASE_URL (migration 009 applied by `npm test`).
const sha = (char: string) => char.repeat(40);
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const baseJob = {
  installationId: '123',
  owner: 'test-owner',
  prTitle: 'Skipped files',
  prAuthor: 'author',
  trigger: 'auto' as const,
  headRef: 'feature',
  baseRef: 'main',
  configSnapshot: defaultRepoConfig,
};

async function makeJob(env: ReturnType<typeof createTestEnv>, suffix: string) {
  return insertJob(env, {
    ...baseJob,
    repo: `test-repo-${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
    prNumber: 1,
    commitSha: sha('a'),
    baseSha: sha('0'),
  });
}

dbDescribe('skipped_files bookkeeping (CMD-02 / D-10)', () => {
  const env = createTestEnv();

  beforeEach(async () => {
    // Isolate from the shared-DB accumulation flake noted in MEMORY.md.
    await queryRows(env, `TRUNCATE skipped_files`);
  });

  it('round-trips a batch and returns distinct file_paths oldest-first', async () => {
    const job = await makeJob(env, 'roundtrip');
    const headSha = sha('b');

    await insertSkippedFiles(env, {
      jobId: job.id,
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: 'repo-x',
      prNumber: 42,
      headSha,
      files: [
        { filePath: 'src/a.ts', reason: 'max_files' },
        { filePath: 'src/b.ts', reason: 'max_files' },
      ],
    });

    const paths = await listSkippedFilesForHead(env, {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: 'repo-x',
      prNumber: 42,
      headSha,
    });
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns an empty array when there are no skips for the PR + head', async () => {
    const paths = await listSkippedFilesForHead(env, {
      vcsProvider: 'github',
      workspace: 'test-owner',
      repoSlug: 'repo-none',
      prNumber: 99,
      headSha: sha('c'),
    });
    expect(paths).toEqual([]);
  });

  it('a NEW job finds the ORIGINAL job’s skips via PR identity + current head (REVIEW: Codex 11-01 HIGH)', async () => {
    const original = await makeJob(env, 'original');
    const headSha = sha('d');
    const identity = { vcsProvider: 'github' as const, workspace: 'test-owner', repoSlug: 'repo-shared', prNumber: 7 };

    await insertSkippedFiles(env, {
      ...identity,
      jobId: original.id,
      headSha,
      files: [{ filePath: 'big/one.ts', reason: 'max_files' }, { filePath: 'big/two.ts', reason: 'too_large' }],
    });

    // A brand-new review-rest job exists but recorded nothing; the lookup keys on identity+head, not
    // job_id, so it still retrieves the original job's skips.
    await makeJob(env, 'review-rest');

    const paths = await listSkippedFilesForHead(env, { ...identity, headSha });
    expect(paths.sort()).toEqual(['big/one.ts', 'big/two.ts']);
  });

  it('lookup is head-specific: skips recorded for a different head are not returned', async () => {
    const job = await makeJob(env, 'headscope');
    const identity = { vcsProvider: 'github' as const, workspace: 'test-owner', repoSlug: 'repo-heads', prNumber: 3 };

    await insertSkippedFiles(env, { ...identity, jobId: job.id, headSha: sha('1'), files: [{ filePath: 'old.ts', reason: 'max_files' }] });

    const paths = await listSkippedFilesForHead(env, { ...identity, headSha: sha('2') });
    expect(paths).toEqual([]);
  });

  it('re-inserting the same (job_id, file_path) is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const job = await makeJob(env, 'idempotent');
    const headSha = sha('e');
    const identity = { vcsProvider: 'github' as const, workspace: 'test-owner', repoSlug: 'repo-dup', prNumber: 11 };

    const files = [{ filePath: 'dup.ts', reason: 'max_files' }];
    await insertSkippedFiles(env, { ...identity, jobId: job.id, headSha, files });
    await insertSkippedFiles(env, { ...identity, jobId: job.id, headSha, files });

    const paths = await listSkippedFilesForHead(env, { ...identity, headSha });
    expect(paths).toEqual(['dup.ts']);

    const [{ n }] = await queryRows<{ n: string }>(
      env,
      `SELECT COUNT(*)::text AS n FROM skipped_files WHERE job_id = $1 AND file_path = $2`,
      [job.id, 'dup.ts'],
    );
    expect(Number(n)).toBe(1);
  });

  it('an empty files batch is a no-op (no rows written, no error)', async () => {
    const job = await makeJob(env, 'empty');
    const identity = { vcsProvider: 'github' as const, workspace: 'test-owner', repoSlug: 'repo-empty', prNumber: 5 };

    await insertSkippedFiles(env, { ...identity, jobId: job.id, headSha: sha('f'), files: [] });

    const paths = await listSkippedFilesForHead(env, { ...identity, headSha: sha('f') });
    expect(paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 1 (Plan 11-05): partitionReviewableFiles wrapper — kept byte-identical to
// filterReviewableFiles, omitted = the remainder the max_files slice discarded. Pure, no DB.
// ---------------------------------------------------------------------------------------------
describe('partitionReviewableFiles (CMD-02 / D-10, Pitfall 4)', () => {
  const reviewCfg = (maxFiles: number): RepoConfig['review'] => ({
    ...defaultRepoConfig.review,
    max_files: maxFiles,
  });

  const files = () =>
    parseUnifiedDiff(
      generateMockDiff([
        { path: 'src/a.ts', content: 'a' },
        { path: 'src/b.ts', content: 'b' },
        { path: 'src/c.ts', content: 'c' },
        { path: 'src/d.ts', content: 'd' },
      ]),
      defaultRepoConfig.review,
    );

  it('splits kept vs omitted exactly at max_files (sorted by isNew then path)', () => {
    const { kept, omitted } = partitionReviewableFiles(files(), reviewCfg(2));
    expect(kept.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(omitted.map((f) => f.path)).toEqual(['src/c.ts', 'src/d.ts']);
  });

  it('kept is byte-identical (path-for-path) to filterReviewableFiles for the same config', () => {
    const cfg = reviewCfg(2);
    const parsed = files();
    const { kept } = partitionReviewableFiles(parsed, cfg);
    const filtered = filterReviewableFiles(parsed, cfg);
    expect(kept.map((f) => f.path)).toEqual(filtered.map((f) => f.path));
  });

  it('omitted is empty when everything fits under max_files', () => {
    const { kept, omitted } = partitionReviewableFiles(files(), reviewCfg(150));
    expect(kept).toHaveLength(4);
    expect(omitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 1 producer contract + Task 2 consumer: the prepare producer records omitted files by PR
// identity + head, and getJobDiffFiles honors job.reviewScope (rest / undefined / all).
// ---------------------------------------------------------------------------------------------
const restIdentity = {
  vcsProvider: 'github' as const,
  workspace: 'test-owner',
  repoSlug: 'repo-rest',
  prNumber: 42,
};
const fourFileDiff = generateMockDiff([
  { path: 'src/a.ts', content: 'a' },
  { path: 'src/b.ts', content: 'b' },
  { path: 'src/c.ts', content: 'c' },
  { path: 'src/d.ts', content: 'd' },
]);

// A job-shaped object carrying only the fields getJobDiffFiles / skippedFilesKeyForJob read.
function jobLike(overrides: Record<string, unknown> = {}) {
  return {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    owner: 'test-owner',
    repo: 'repo-rest',
    prNumber: 42,
    commitSha: sha('a'),
    repositoryVcsProvider: 'github',
    repositoryWorkspace: null,
    reviewScope: null,
    ...overrides,
  } as any;
}

dbDescribe('getJobDiffFiles scope-aware wrapper + producer round-trip (Plan 11-05, Codex 11-05 HIGH)', () => {
  const env = createTestEnv();
  const restConfig = { ...defaultRepoConfig, review: { ...defaultRepoConfig.review, max_files: 2 } } as RepoConfig;

  beforeEach(async () => {
    await queryRows(env, `TRUNCATE skipped_files`);
  });

  it('producer contract: partition(max_files) omitted set persists by PR identity + head, retrievable across jobs', async () => {
    const producer = await makeJob(env, 'producer');
    const headSha = sha('a');
    const { kept, omitted } = partitionReviewableFiles(parseUnifiedDiff(fourFileDiff, restConfig.review), restConfig.review);
    expect(kept.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);

    await insertSkippedFiles(env, {
      jobId: producer.id,
      ...restIdentity,
      headSha,
      files: omitted.map((f) => ({ filePath: f.path, reason: 'max_files' })),
    });

    const recorded = await listSkippedFilesForHead(env, { ...restIdentity, headSha });
    expect(recorded).toEqual(['src/c.ts', 'src/d.ts']);
  });

  it('reviewScope="rest": getJobDiffFiles returns exactly the recorded omitted files (bypassing max_files)', async () => {
    const producer = await makeJob(env, 'producer');
    const headSha = sha('a');
    await insertSkippedFiles(env, {
      jobId: producer.id,
      ...restIdentity,
      headSha,
      files: [
        { filePath: 'src/c.ts', reason: 'max_files' },
        { filePath: 'src/d.ts', reason: 'max_files' },
      ],
    });

    const restJob = jobLike({ reviewScope: 'rest', commitSha: headSha });
    const vcs = {
      getPullRequestDiff: async () => fourFileDiff,
      getCompareDiff: async () => '',
    };
    // Uses the DEFAULT (max_files 150) config: the rest set comes from skipped_files, not the slice.
    const files = await getJobDiffFiles(env, restJob, vcs, defaultRepoConfig as RepoConfig);
    expect(files.map((f) => f.path)).toEqual(['src/c.ts', 'src/d.ts']);
  });

  it('reviewScope="rest" with zero recorded skips is a no-op (empty set, not an error)', async () => {
    const restJob = jobLike({ reviewScope: 'rest', commitSha: sha('9') });
    const vcs = {
      getPullRequestDiff: async () => fourFileDiff,
      getCompareDiff: async () => '',
    };
    const files = await getJobDiffFiles(env, restJob, vcs, defaultRepoConfig as RepoConfig);
    expect(files).toEqual([]);
  });

  it('undefined scope is byte-identical to getDiffFiles (NREG-01)', async () => {
    const job = jobLike({ reviewScope: null });
    const vcs = {
      getPullRequestDiff: async () => fourFileDiff,
      getCompareDiff: async () => '',
    };
    const viaJob = await getJobDiffFiles(env, job, vcs, restConfig);
    const viaPlain = await getDiffFiles(env, { id: job.id, owner: job.owner, repo: job.repo, prNumber: job.prNumber, reviewMode: null, roundsFromSha: null, roundsToSha: null }, vcs, restConfig);
    expect(viaJob.map((f) => f.path)).toEqual(viaPlain.map((f) => f.path));
    // max_files=2 -> only the first two kept, honoring the slice exactly like today.
    expect(viaJob.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('reviewScope="all" reviews the full current head (delegates to getDiffFiles)', async () => {
    const job = jobLike({ reviewScope: 'all' });
    const vcs = {
      getPullRequestDiff: async () => fourFileDiff,
      getCompareDiff: async () => '',
    };
    const files = await getJobDiffFiles(env, job, vcs, defaultRepoConfig as RepoConfig);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });
});

dbDescribe('jobs.review_scope / scope_source_job_id (REVIEW: Codex 11-05 HIGH)', () => {
  const env = createTestEnv();

  it('are null on a normal insert (existing callers byte-identical, NREG-01)', async () => {
    const job = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-scope-null`,
      prNumber: 1,
      commitSha: sha('a'),
      baseSha: sha('0'),
    });
    expect(job.reviewScope ?? null).toBeNull();
    expect(job.scopeSourceJobId ?? null).toBeNull();
  });

  it('round-trips reviewScope + scopeSourceJobId when supplied', async () => {
    const source = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-scope-source`,
      prNumber: 2,
      commitSha: sha('b'),
      baseSha: sha('0'),
    });

    const restJob = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-scope-rest`,
      prNumber: 3,
      commitSha: sha('c'),
      baseSha: sha('0'),
      reviewScope: 'rest',
      scopeSourceJobId: source.id,
    });

    expect(restJob.reviewScope).toBe('rest');
    expect(restJob.scopeSourceJobId).toBe(source.id);

    const row = await getJobForProcessing(env, restJob.id);
    expect(row).not.toBeNull();
    const mapped = mapJob(row!);
    expect(mapped.reviewScope).toBe('rest');
    expect(mapped.scopeSourceJobId).toBe(source.id);
  });
});
