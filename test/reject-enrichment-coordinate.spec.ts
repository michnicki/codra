import { describe, it, expect, vi } from 'vitest';
import { executeCommand, type CommentContext, type ClassifiedCommand } from '@server/core/commands';
import type { VcsProvider } from '@server/vcs/types';
import { insertJob } from '@server/db/jobs';
import { upsertFileReview } from '@server/db/file-reviews';
import { queryRows } from '@server/db/client';
import { findReviewCommentByCoordinate, pickReviewCommentByCommentBody } from '@server/db/reject-feedback';
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

// Two findings sharing one coordinate is not hypothetical: live PR#9 had two findings on the same
// path at position 32 / line 366. `LIMIT 1` alone would attribute the rejection to whichever row
// the ordering happened to surface. The rejected comment's OWN body identifies the finding, because
// `formatInlineComment` renders the title verbatim into `<strong>...</strong>`.
const COLLIDE_A_TITLE = 'Missing error handling for replyToPrComment call';
const COLLIDE_B_TITLE = 'Unbounded candidate fetch can read every row';

dbDescribe('reject enrichment — ambiguous coordinate resolves by the rejected comment body', () => {
  const env = createTestEnv();

  const collidingComments: ParsedReviewComment[] = [
    {
      path: SEEDED_PATH,
      line: SEEDED_LINE,
      position: SEEDED_POSITION,
      severity: 'P1',
      category: 'bugs',
      title: COLLIDE_A_TITLE,
      body: 'The reply call is not wrapped in a try/catch.',
    },
    {
      path: SEEDED_PATH,
      line: SEEDED_LINE,
      position: SEEDED_POSITION,
      severity: 'P2',
      category: 'performance',
      title: COLLIDE_B_TITLE,
      body: 'The candidate query has no row cap.',
    },
  ];

  async function lookup(slug: string, commentBody?: string | null) {
    return findReviewCommentByCoordinate(env, {
      workspace: 'acme',
      repoSlug: slug,
      vcsProvider: 'github',
      prNumber: 9,
      path: SEEDED_PATH,
      line: null,
      position: SEEDED_POSITION,
      commentBody,
    });
  }

  it('selects the finding whose title appears in the body — BOTH directions', async () => {
    const slug = `repo-lrn-collide-${Date.now()}`;
    await seedFinishedJob(env, { slug, prNumber: 9, comments: collidingComments });

    // Body naming the SECOND finding must resolve to the second, not to whichever row the
    // ordering surfaces first.
    const pickedB = await lookup(slug, formatterBody(COLLIDE_B_TITLE));
    expect(pickedB?.title).toBe(COLLIDE_B_TITLE);
    expect(pickedB?.category).toBe('performance');

    // Mirror direction: a body naming the FIRST finding must resolve to the first. Asserting only
    // one direction would pass against an arbitrary pick, so both are required.
    const pickedA = await lookup(slug, formatterBody(COLLIDE_A_TITLE));
    expect(pickedA?.title).toBe(COLLIDE_A_TITLE);
    expect(pickedA?.category).toBe('bugs');
  });

  it('is deterministic across repeated calls when no body is available', async () => {
    const slug = `repo-lrn-determ-${Date.now()}`;
    await seedFinishedJob(env, { slug, prNumber: 9, comments: collidingComments });

    const first = await lookup(slug);
    const second = await lookup(slug);
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
  });
});

dbDescribe('reject enrichment — Bitbucket resolves on line (NREG-02 parity)', () => {
  const env = createTestEnv();

  const BB_LINE = 120;
  // Deliberately != BB_LINE so a lookup that reached for `position` would miss.
  const BB_POSITION = 47;

  const bbComments: ParsedReviewComment[] = [
    {
      path: SEEDED_PATH,
      line: BB_LINE,
      position: BB_POSITION,
      severity: 'P0',
      category: 'security',
      title: 'Bitbucket anchors inline comments by line',
      body: 'Bitbucket sends inline: { path, to | from }.',
    },
  ];

  it('resolves a Bitbucket finding from the line coordinate', async () => {
    const slug = `repo-lrn-bb-${Date.now()}`;
    await seedFinishedJob(env, { slug, prNumber: 11, comments: bbComments, provider: 'bitbucket' });

    const result = await findReviewCommentByCoordinate(env, {
      workspace: 'acme',
      repoSlug: slug,
      vcsProvider: 'bitbucket',
      prNumber: 11,
      path: SEEDED_PATH,
      line: BB_LINE,
      position: null,
    });
    expect(result?.category).toBe('security');
    expect(result?.severity).toBe('P0');
  });

  it('returns null for Bitbucket when the line is null, even if a position is supplied', async () => {
    const slug = `repo-lrn-bb-null-${Date.now()}`;
    await seedFinishedJob(env, { slug, prNumber: 11, comments: bbComments, provider: 'bitbucket' });

    // No cross-provider coordinate borrowing: the Bitbucket path must not fall back to `position`.
    const result = await findReviewCommentByCoordinate(env, {
      workspace: 'acme',
      repoSlug: slug,
      vcsProvider: 'bitbucket',
      prNumber: 11,
      path: SEEDED_PATH,
      line: null,
      position: BB_POSITION,
    });
    expect(result).toBeNull();
  });
});

// Pure-helper units — no database, so these run even without TEST_DATABASE_URL.
describe('pickReviewCommentByCommentBody (deterministic collision tiebreak)', () => {
  const a = { title: 'Missing null check', category: 'bugs', severity: 'P1' };
  const b = { title: 'Unbounded fetch', category: 'performance', severity: 'P2' };

  it('returns null for no candidates', () => {
    expect(pickReviewCommentByCommentBody([], 'anything')).toBeNull();
  });

  it('returns the only candidate regardless of body', () => {
    expect(pickReviewCommentByCommentBody([a], null)).toEqual(a);
    expect(pickReviewCommentByCommentBody([a], 'body naming nothing')).toEqual(a);
  });

  it('returns the first candidate when the body is empty or absent', () => {
    expect(pickReviewCommentByCommentBody([a, b], null)).toEqual(a);
    expect(pickReviewCommentByCommentBody([a, b], '')).toEqual(a);
    expect(pickReviewCommentByCommentBody([a, b], undefined)).toEqual(a);
  });

  it('matches a title that the formatter HTML-escaped in the posted body', () => {
    const escaped = { title: `Guard <input> & "quoted" 'value'`, category: 'security', severity: 'P0' };
    const body = `⚠️ P1 <strong>Guard &lt;input&gt; &amp; &quot;quoted&quot; &#39;value&#39;</strong>\n\nsome body`;
    expect(pickReviewCommentByCommentBody([b, escaped], body)).toEqual(escaped);
  });

  it('ignores markup and whitespace noise between the tags and the title', () => {
    const body = `<img src="x" /> <strong>\n  Unbounded    fetch\n</strong>\n\ndetails`;
    expect(pickReviewCommentByCommentBody([a, b], body)).toEqual(b);
  });

  it('falls back to the first candidate when no title matches the body', () => {
    expect(pickReviewCommentByCommentBody([a, b], 'a body naming neither finding')).toEqual(a);
  });
});
