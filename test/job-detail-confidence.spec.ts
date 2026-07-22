import { describe, it, expect } from 'vitest';
import { insertJob, getJobDetail } from '@server/db/jobs';
import { upsertFileReview } from '@server/db/file-reviews';
import { defaultRepoConfig, type ParsedReviewComment } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// UI-02 SC2 / D-07 (REVIEW #2): prove the getJobDetail parsedComments JSON_BUILD_OBJECT now SELECTs
// `rc.confidence`, so a persisted per-finding confidence round-trips DB write -> read back to the
// client payload. Before this fix the object omitted `confidence`, so the job-detail confidence chip
// would NEVER render in production while a mocked browser fixture passed falsely. Runs against the
// migrated TEST_DATABASE_URL (migration 006 confidence column applied by `npm test`).
const sha = (char: string) => char.repeat(40);
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const baseFileReview = {
  fileStatus: 'done' as const,
  modelUsed: 'test-model',
  modelProvider: 'test',
  diffLineCount: 1,
  diffInput: 'x',
  rawAiOutput: '{}',
  parsedComments: [] as ParsedReviewComment[],
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  verdict: 'comment' as const,
  fileSummary: 'ok',
  errorMessage: null,
};

dbDescribe('getJobDetail per-finding confidence round-trip (SC2 / REVIEW #2)', () => {
  const env = createTestEnv();

  it('returns a persisted non-null confidence on files[].parsedComments[]', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-confidence`,
      prNumber: 1, prTitle: 'Confidence round-trip', prAuthor: 'author', commitSha: sha('a'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    const withConfidence: ParsedReviewComment = {
      path: 'src/x.ts', line: 10, severity: 'P1', category: 'security',
      title: 'confident finding', body: 'from main pass', confidence: 0.82,
    };
    const withoutConfidence: ParsedReviewComment = {
      path: 'src/x.ts', line: 20, severity: 'nit', category: 'quality',
      title: 'no-confidence finding', body: 'fail-open null', confidence: null,
    };

    await upsertFileReview(env, job.id, {
      ...baseFileReview, filePath: 'src/x.ts', pass: 'main',
      parsedComments: [withConfidence, withoutConfidence],
    });

    const detail = await getJobDetail(env, job.id);
    expect(detail).not.toBeNull();

    const comments = detail!.files[0].parsedComments;
    const confident = comments.find((c) => c.title === 'confident finding');
    const unconfident = comments.find((c) => c.title === 'no-confidence finding');

    // The DB write -> read round-trip surfaces the confidence the chip needs (was omitted pre-fix).
    expect(confident?.confidence).toBe(0.82);
    // A fail-open null confidence round-trips as null so the consumer omits the chip (never 0%).
    expect(unconfident?.confidence).toBeNull();
  });
});
