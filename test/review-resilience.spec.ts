import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDiffFiles, failJobAndCheckRun } from '@server/core/review';
import { createTestEnv, generateMockDiff } from './helpers';
import { defaultRepoConfig } from '@shared/schema';

// Regression coverage for the subrequest-exhaustion incident (job bb9cf692...): a large PR's
// review workflow re-fetched the PR diff from GitHub on every phase/chunk and, once the
// Worker's subrequest budget was exhausted, the failure-reporting path silently swallowed
// errors and could leave a job's DB failure state undone. These tests pin down the fixes for
// both without requiring a real Postgres connection or live GitHub/Workflow infrastructure.

const { failJobMock, getJobForProcessingMock, markJobCheckRunCompletedMock } = vi.hoisted(() => ({
  failJobMock: vi.fn(),
  getJobForProcessingMock: vi.fn(),
  markJobCheckRunCompletedMock: vi.fn(),
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    failJob: failJobMock,
    getJobForProcessing: getJobForProcessingMock,
    markJobCheckRunCompleted: markJobCheckRunCompletedMock,
  };
});

describe('getDiffFiles', () => {
  const baseJob = { owner: 'test-owner', repo: 'test-repo', prNumber: 26 };

  it('fetches the PR diff from GitHub once and reuses the cached copy on later calls for the same job', async () => {
    const env = createTestEnv();
    const job = { ...baseJob, id: `diff-cache-hit-${Date.now()}` };
    const rawDiff = generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }]);
    const github = {
      getPullRequestDiff: vi.fn().mockResolvedValue(rawDiff),
      getCompareDiff: vi.fn().mockResolvedValue(''),
    };

    const first = await getDiffFiles(env, job, github, defaultRepoConfig);
    const second = await getDiffFiles(env, job, github, defaultRepoConfig);
    const third = await getDiffFiles(env, job, github, defaultRepoConfig);

    expect(github.getPullRequestDiff).toHaveBeenCalledTimes(1);
    expect(first.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(second.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(third.map((f) => f.path)).toEqual(['src/app.ts']);
  });

  it('does not share cached diffs across different jobs', async () => {
    const env = createTestEnv();
    const jobA = { ...baseJob, id: `diff-cache-job-a-${Date.now()}` };
    const jobB = { ...baseJob, id: `diff-cache-job-b-${Date.now()}` };
    const githubA = {
      getPullRequestDiff: vi.fn().mockResolvedValue(generateMockDiff([{ path: 'src/one.ts', content: 'a' }])),
      getCompareDiff: vi.fn().mockResolvedValue(''),
    };
    const githubB = {
      getPullRequestDiff: vi.fn().mockResolvedValue(generateMockDiff([{ path: 'src/two.ts', content: 'b' }])),
      getCompareDiff: vi.fn().mockResolvedValue(''),
    };

    const filesA = await getDiffFiles(env, jobA, githubA, defaultRepoConfig);
    const filesB = await getDiffFiles(env, jobB, githubB, defaultRepoConfig);

    expect(githubA.getPullRequestDiff).toHaveBeenCalledTimes(1);
    expect(githubB.getPullRequestDiff).toHaveBeenCalledTimes(1);
    expect(filesA.map((f) => f.path)).toEqual(['src/one.ts']);
    expect(filesB.map((f) => f.path)).toEqual(['src/two.ts']);
  });

  it('still returns the parsed files if caching the diff in KV fails', async () => {
    const env = createTestEnv();
    (env.APP_KV as any).put = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    const job = { ...baseJob, id: `diff-cache-put-fail-${Date.now()}` };
    const github = {
      getPullRequestDiff: vi.fn().mockResolvedValue(generateMockDiff([{ path: 'src/app.ts', content: 'console.log(1);' }])),
      getCompareDiff: vi.fn().mockResolvedValue(''),
    };

    const files = await getDiffFiles(env, job, github, defaultRepoConfig);

    expect(files.map((f) => f.path)).toEqual(['src/app.ts']);
    // The next phase would simply re-fetch from GitHub since the cache write failed; it must
    // not throw and break the job.
  });
});

describe('failJobAndCheckRun', () => {
  const job = { id: 'job-fail-1', owner: 'test-owner', repo: 'test-repo', checkRunId: 42 };

  beforeEach(() => {
    failJobMock.mockReset();
    getJobForProcessingMock.mockReset();
    markJobCheckRunCompletedMock.mockReset();
  });

  it('durably records the DB failure even when the GitHub check-run update fails (e.g. subrequest limit exhausted)', async () => {
    const env = createTestEnv();
    failJobMock.mockResolvedValue(undefined);
    getJobForProcessingMock.mockResolvedValue({ check_run_id: job.checkRunId });
    const updateCheckRun = vi.fn().mockRejectedValue(new Error('Too many subrequests by single Worker invocation.'));

    await expect(failJobAndCheckRun(env, job, { updateCheckRun }, 'boom')).resolves.toBeUndefined();

    // Use expect.anything() rather than the literal env: env's APP_PRIVATE_KEY getter
    // deliberately throws for unused test secrets, and toHaveBeenCalledWith's deep-equality
    // check would otherwise trigger it while walking env's own properties.
    expect(failJobMock).toHaveBeenCalledWith(expect.anything(), job.id, 'boom');
    expect(updateCheckRun).toHaveBeenCalledTimes(1);
    // Deliberately not marked complete: completeTerminalCheckRuns() picks this up and
    // retries the GitHub update later, once a fresh invocation has its own subrequest budget.
    expect(markJobCheckRunCompletedMock).not.toHaveBeenCalled();
  });

  it('does not attempt the GitHub call at all if the DB write itself fails', async () => {
    const env = createTestEnv();
    failJobMock.mockRejectedValue(new Error('Too many subrequests by single Worker invocation.'));
    const updateCheckRun = vi.fn();

    await expect(failJobAndCheckRun(env, job, { updateCheckRun }, 'boom')).resolves.toBeUndefined();

    expect(failJobMock).toHaveBeenCalledWith(expect.anything(), job.id, 'boom');
    expect(getJobForProcessingMock).not.toHaveBeenCalled();
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it('marks the check run completed once the GitHub update succeeds', async () => {
    const env = createTestEnv();
    failJobMock.mockResolvedValue(undefined);
    getJobForProcessingMock.mockResolvedValue({ check_run_id: job.checkRunId });
    const updateCheckRun = vi.fn().mockResolvedValue(undefined);

    await failJobAndCheckRun(env, job, { updateCheckRun }, 'boom');

    expect(updateCheckRun).toHaveBeenCalledWith(
      job.owner,
      job.repo,
      job.checkRunId,
      expect.objectContaining({ status: 'completed', conclusion: 'failure', summary: 'boom' }),
    );
    expect(markJobCheckRunCompletedMock).toHaveBeenCalledWith(expect.anything(), job.id);
  });
});
