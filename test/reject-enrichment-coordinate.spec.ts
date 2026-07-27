import { describe, it, expect, vi } from 'vitest';
import { executeCommand, type CommentContext, type ClassifiedCommand } from '@server/core/commands';
import type { VcsProvider } from '@server/vcs/types';
import { insertJob } from '@server/db/jobs';
import { upsertFileReview } from '@server/db/file-reviews';
import { queryRows } from '@server/db/client';
import { findReviewCommentByCoordinate } from '@server/db/reject-feedback';
import { defaultRepoConfig, repoConfigSchema, type ParsedReviewComment, type RepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// Phase 28 (LRN-01) / G-28-3 regression suite.
//
// This spec exists because the 28-02 integration tests seeded `reject_feedback` rows with
// `finding_category` ALREADY populated, so they never exercised the
// `getInlineCommentDetails` -> `findReviewCommentByCoordinate` handoff at all. The real user path
// was therefore broken end-to-end while the suite stayed green (28-UAT.md, gap G-28-3).
//
// Root cause the tests below pin: Codra POSTs GitHub inline comments by diff `position`
// (`core/github.ts createReview` sends `{ path, position, body }` and never `line`), but the
// enrichment lookup used to join on `rc.line`. GitHub's own `line` is derived from that position
// against the CURRENT diff and drifts from the `line` the model reported and Codra persisted. On
// live PR michnicki/opencodra#9 `position` matched on both sampled comments and `line` matched on
// NEITHER (GitHub line 56/position 16 vs stored line 57/position 16; GitHub line 364/position 32 vs
// stored line 366/position 32).
//
// Each provider must therefore match on the coordinate it actually anchors by: GitHub on
// `review_comments.position`, Bitbucket on `review_comments.line` (NREG-02).
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const sha = (char: string) => char.repeat(40);

const SEEDED_PATH = 'src/server/core/commands.ts';
const SEEDED_TITLE = 'Missing error handling for replyToPrComment call';
// The stored line the model reported and `db/file-reviews.ts` persisted.
const SEEDED_LINE = 366;
// The diff offset Codra POSTed the inline comment with.
const SEEDED_POSITION = 32;
// The line GitHub reports back for that same comment. DELIBERATELY != SEEDED_LINE — this
// divergence is the whole point of the spec and mirrors live PR#9 evidence. A future editor MUST
// NOT "simplify" these two numbers into agreement: doing so makes the test pass against the
// `rc.line`-based join that G-28-3 is about.
const PROVIDER_REPORTED_LINE = 364;

const baseFileReview = {
  fileStatus: 'done' as const,
  modelUsed: 'test-model',
  modelProvider: 'test',
  diffLineCount: 1,
  diffInput: 'x',
  rawAiOutput: '{}',
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  verdict: 'comment' as const,
  fileSummary: 'ok',
  errorMessage: null,
};

/** The shape `services/formatter.ts formatInlineComment` actually posts. */
function formatterBody(title: string, body = 'The reply call is not wrapped in a try/catch.'): string {
  return `<img src="https://codra.test/icons/p1-icon.svg" width="20" height="20" alt="P1" style="vertical-align:middle" /> <strong>${title}</strong>\n\n${body}`;
}

function makeProvider(name: 'github' | 'bitbucket', overrides: Partial<VcsProvider> = {}): VcsProvider {
  return { name, ...overrides } as unknown as VcsProvider;
}

function cfg(): RepoConfig {
  return repoConfigSchema.parse({
    review: {
      mention_trigger: '@codra-app',
      interactive: {
        commands: { enabled: true, bitbucket_allowed_account_ids: [], bitbucket_bot_account_id: null },
        qa: { enabled: true },
      },
    },
  });
}

type EnrichmentRow = {
  finding_title: string | null;
  finding_category: string | null;
  finding_file_path: string | null;
  finding_severity: string | null;
};

async function readEnrichment(
  env: ReturnType<typeof createTestEnv>,
  sourceCommentRef: string,
): Promise<EnrichmentRow[]> {
  return queryRows<EnrichmentRow>(
    env,
    `SELECT finding_title, finding_category, finding_file_path, finding_severity
     FROM reject_feedback
     WHERE vcs_provider = 'github' AND source_comment_ref = $1`,
    [sourceCommentRef],
  );
}

/**
 * Seed one terminal (`done`) job plus its review_comments rows so the enrichment join has
 * something to resolve. Returns the unique repo slug the job was created under.
 */
async function seedFinishedJob(
  env: ReturnType<typeof createTestEnv>,
  opts: {
    slug: string;
    prNumber: number;
    comments: ParsedReviewComment[];
    provider?: 'github' | 'bitbucket';
  },
): Promise<void> {
  const provider = opts.provider ?? 'github';
  const job = await insertJob(env, {
    installationId: provider === 'bitbucket' ? null : '123',
    owner: 'acme',
    repo: opts.slug,
    prNumber: opts.prNumber,
    prTitle: 'LRN-01 coordinate fixture',
    prAuthor: 'author',
    commitSha: sha('a'),
    baseSha: sha('0'),
    trigger: 'auto',
    headRef: 'feature',
    baseRef: 'main',
    configSnapshot: defaultRepoConfig,
    ...(provider === 'bitbucket' ? { vcsProvider: 'bitbucket' as const, workspace: 'acme' } : {}),
  });

  await upsertFileReview(env, job.id, {
    ...baseFileReview,
    filePath: SEEDED_PATH,
    parsedComments: opts.comments,
  });

  // The enrichment join only considers jobs whose status is 'done'.
  await queryRows(env, `UPDATE jobs SET status = $1 WHERE id = $2::uuid`, ['done', job.id]);
}

dbDescribe('reject enrichment — provider-aware coordinate match (G-28-3)', () => {
  const env = createTestEnv();

  it('enriches a GitHub reject when the provider-reported line DIVERGES from review_comments.line', async () => {
    const slug = `repo-lrn-coord-${Date.now()}`;
    await seedFinishedJob(env, {
      slug,
      prNumber: 9,
      comments: [
        {
          path: SEEDED_PATH,
          line: SEEDED_LINE,
          position: SEEDED_POSITION,
          severity: 'P1',
          category: 'bugs',
          title: SEEDED_TITLE,
          body: 'The reply call is not wrapped in a try/catch.',
        },
      ],
    });

    const commentRef = `9:src-${slug}`;
    const c: CommentContext = {
      authorId: 'gh-id-writer',
      authorLogin: 'octocat',
      body: '@codra-app reject false positive',
      prNumber: 9,
      owner: 'acme',
      repo: slug,
      workspace: 'acme',
      commentRef,
      findingRef: '1001',
    };
    const cmd: ClassifiedCommand = { kind: 'command', name: 'reject', args: 'false positive', findingRef: '1001' };

    const provider = makeProvider('github', {
      getUserRepoPermission: vi.fn(async () => 'write' as const),
      // GitHub reports line 364 for the comment Codra posted at position 32; the DB holds line 366.
      getInlineCommentDetails: vi.fn(async () => ({
        path: SEEDED_PATH,
        line: PROVIDER_REPORTED_LINE,
        position: SEEDED_POSITION,
        body: formatterBody(SEEDED_TITLE),
      })),
    });

    await executeCommand(env, provider, cmd, c, cfg());

    const rows = await readEnrichment(env, commentRef);
    expect(rows).toHaveLength(1);
    expect(rows[0].finding_category).toBe('bugs');
    expect(rows[0].finding_title).toBe(SEEDED_TITLE);
    expect(rows[0].finding_severity).toBe('P1');
    expect(rows[0].finding_file_path).toBe(SEEDED_PATH);
  });

  it('leaves all four enrichment columns NULL when the diff position matches nothing (no line fallback)', async () => {
    const slug = `repo-lrn-miss-${Date.now()}`;
    await seedFinishedJob(env, {
      slug,
      prNumber: 9,
      comments: [
        {
          path: SEEDED_PATH,
          line: SEEDED_LINE,
          position: SEEDED_POSITION,
          severity: 'P1',
          category: 'bugs',
          title: SEEDED_TITLE,
          body: 'The reply call is not wrapped in a try/catch.',
        },
      ],
    });

    const commentRef = `9:src-${slug}`;
    const c: CommentContext = {
      authorId: 'gh-id-writer',
      authorLogin: 'octocat',
      body: '@codra-app reject false positive',
      prNumber: 9,
      owner: 'acme',
      repo: slug,
      workspace: 'acme',
      commentRef,
      findingRef: '1002',
    };
    const cmd: ClassifiedCommand = { kind: 'command', name: 'reject', args: 'false positive', findingRef: '1002' };

    const provider = makeProvider('github', {
      getUserRepoPermission: vi.fn(async () => 'write' as const),
      // position 999 matches nothing. `line: SEEDED_LINE` is supplied deliberately: a
      // line-fallback would enrich here, and that is exactly the prohibition being pinned.
      getInlineCommentDetails: vi.fn(async () => ({
        path: SEEDED_PATH,
        line: SEEDED_LINE,
        position: 999,
        body: formatterBody(SEEDED_TITLE),
      })),
    });

    await expect(executeCommand(env, provider, cmd, c, cfg())).resolves.toBeUndefined();

    const rows = await readEnrichment(env, commentRef);
    expect(rows).toHaveLength(1);
    expect(rows[0].finding_category).toBeNull();
    expect(rows[0].finding_title).toBeNull();
    expect(rows[0].finding_severity).toBeNull();
    // finding_file_path is set from the provider path alone (it needs no coordinate match), so it
    // is NOT part of the "all NULL" claim; assert it explicitly instead of leaving it ambiguous.
    expect(rows[0].finding_file_path).toBe(SEEDED_PATH);
  });

  it('returns null from the lookup itself when the GitHub position is null', async () => {
    const slug = `repo-lrn-nullpos-${Date.now()}`;
    await seedFinishedJob(env, {
      slug,
      prNumber: 9,
      comments: [
        {
          path: SEEDED_PATH,
          line: SEEDED_LINE,
          position: SEEDED_POSITION,
          severity: 'P1',
          category: 'bugs',
          title: SEEDED_TITLE,
          body: 'The reply call is not wrapped in a try/catch.',
        },
      ],
    });

    // A GitHub comment on an outdated diff has position: null. Supplying the stored line must not
    // rescue the lookup — GitHub never anchors by line.
    const result = await findReviewCommentByCoordinate(env, {
      workspace: 'acme',
      repoSlug: slug,
      vcsProvider: 'github',
      prNumber: 9,
      path: SEEDED_PATH,
      line: SEEDED_LINE,
      position: null,
    });
    expect(result).toBeNull();
  });
});
