import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDb } from '@server/db/client';
import * as jobsDb from '@server/db/jobs';
import { defaultRepoConfig, type ThreadVerifications } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
const sha = (char: string) => char.repeat(40);

const jobsSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/server/db/jobs.ts',
);

function setJobThreadVerifications(
  env: ReturnType<typeof createTestEnv>,
  jobId: string,
  result: ThreadVerifications | null,
): Promise<void> {
  const setter = (jobsDb as unknown as Record<string, unknown>).setJobThreadVerifications;
  if (typeof setter !== 'function') {
    throw new Error('Missing jobs DB export: setJobThreadVerifications');
  }
  return (setter as (
    env: ReturnType<typeof createTestEnv>,
    jobId: string,
    result: ThreadVerifications | null,
  ) => Promise<void>)(env, jobId, result);
}

const canonicalResult: ThreadVerifications = {
  version: 1,
  status: 'completed',
  entries: [
    {
      threadRef: 'thread-fixed-resolved',
      path: 'src/fixed.ts',
      lineStart: 10,
      lineEnd: 10,
      verdict: 'fixed',
      reason: 'model_confirmed_fix',
      resolved: true,
    },
    {
      threadRef: 'thread-fixed-open',
      path: 'src/fixed.ts',
      lineStart: 30,
      lineEnd: 31,
      verdict: 'fixed',
      reason: 'model_confirmed_fix',
      resolved: false,
    },
    {
      threadRef: 'thread-unfixed',
      path: 'src/open.ts',
      lineStart: 20,
      lineEnd: 22,
      verdict: 'unfixed',
      reason: 'issue_still_present',
      resolved: false,
    },
    {
      threadRef: 'thread-unverifiable',
      path: 'src/deleted.ts',
      lineStart: null,
      lineEnd: null,
      verdict: 'unverifiable',
      reason: 'file_deleted_at_head',
      resolved: false,
    },
  ],
  totals: {
    fixed: 2,
    unfixed: 1,
    unverifiable: 1,
    resolved: 1,
  },
};

async function makeJob(env: ReturnType<typeof createTestEnv>, suffix: string) {
  return jobsDb.insertJob(env, {
    installationId: '123',
    owner: 'open-codra',
    repo: `phase19-thread-read-${suffix}-${Date.now()}-${crypto.randomUUID()}`,
    prNumber: 19,
    prTitle: 'Thread verification persistence',
    prAuthor: 'author',
    commitSha: sha('a'),
    baseSha: sha('0'),
    trigger: 'auto',
    headRef: 'feature',
    baseRef: 'main',
    configSnapshot: defaultRepoConfig,
  });
}

dbDescribe('thread-verification persistence read path', () => {
  const env = createTestEnv();

  it('survives setter to processing reload and job-detail reload with all totals and reasons', async () => {
    const job = await makeJob(env, 'canonical');

    await setJobThreadVerifications(env, job.id, canonicalResult);

    const processingRow = await jobsDb.getJobForProcessing(env, job.id);
    expect(processingRow).not.toBeNull();
    const processingJob = jobsDb.mapJob(processingRow!);
    expect(processingJob.threadVerification).toEqual(canonicalResult);
    expect(processingJob.threadVerification?.totals).toEqual({
      fixed: 2,
      unfixed: 1,
      unverifiable: 1,
      resolved: 1,
    });
    expect(processingJob.threadVerification?.entries[0]).toMatchObject({
      verdict: 'fixed',
      reason: 'model_confirmed_fix',
      resolved: true,
    });

    const detail = await jobsDb.getJobDetail(env, job.id);
    expect(detail).not.toBeNull();
    expect(detail!.threadVerification).toEqual(canonicalResult);
    expect(detail!.threadVerification?.entries.map(({ verdict, reason }) => ({ verdict, reason }))).toEqual([
      { verdict: 'fixed', reason: 'model_confirmed_fix' },
      { verdict: 'fixed', reason: 'model_confirmed_fix' },
      { verdict: 'unfixed', reason: 'issue_still_present' },
      { verdict: 'unverifiable', reason: 'file_deleted_at_head' },
    ]);

    // The durable result is independent metadata. The original config_snapshot remains the sole
    // authoritative source for whether verification/auto-resolution were enabled for this job.
    expect(detail!.configSnapshot?.review.threads).toEqual({
      verify_fixes: false,
      auto_resolve: false,
    });

    const source = readFileSync(jobsSourcePath, 'utf8');
    expect(source).toMatch(/SET\s+thread_verifications\s*=\s*\$2::jsonb/);
  });

  it('degrades malformed stored JSON only to threadVerification null', async () => {
    const job = await makeJob(env, 'malformed');
    const malformed = {
      version: 1,
      status: 'completed',
      entries: [
        {
          threadRef: 'thread-missing-reason',
          path: 'src/a.ts',
          verdict: 'fixed',
          resolved: true,
        },
      ],
      totals: { fixed: 1, unfixed: 0, unverifiable: 0, resolved: 1 },
    };

    await getDb(env).query(
      'UPDATE jobs SET thread_verifications = $2::jsonb WHERE id = $1',
      [job.id, JSON.stringify(malformed)],
    );

    const processingRow = await jobsDb.getJobForProcessing(env, job.id);
    expect(processingRow).not.toBeNull();
    const processingJob = jobsDb.mapJob(processingRow!);
    expect(processingJob.id).toBe(job.id);
    expect(processingJob.owner).toBe('open-codra');
    expect(processingJob.threadVerification).toBeNull();
    expect(processingJob.configSnapshot?.review.threads).toEqual({
      verify_fixes: false,
      auto_resolve: false,
    });

    const detail = await jobsDb.getJobDetail(env, job.id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(job.id);
    expect(detail!.repositoryVcsProvider).toBe('github');
    expect(detail!.files).toEqual([]);
    expect(detail!.threadVerification).toBeNull();
  });
});
