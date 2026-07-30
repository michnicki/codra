import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';
import { BitbucketClient, BitbucketError } from '@server/core/bitbucket';
import { decryptSecret } from '@server/core/crypto';
import { parseUnifiedDiff, getValidNewLines, type FileDiff } from '@server/core/diff';
import { resolveBitbucketBotCredential } from '@server/core/bitbucket-credential-resolution';
import {
  REPORT_TYPE,
  REPORT_RESULT,
  ANNOTATION_REPORT_ID,
  ANNOTATION_TYPE,
  ANNOTATION_SEVERITY_MAP,
  ANNOTATION_BATCH_SIZE,
} from '@server/bitbucket/constants';
import type { ReportAnnotation } from '@shared/bitbucket';
import type { RepoConfig, ParsedReviewComment } from '@shared/schema';
import type {
  VcsCapabilities,
  VcsCreateStatusCheckInput,
  VcsPostAnnotationsInput,
  VcsPostedComment,
  VcsProvider,
  VcsPullRequest,
  VcsReviewComment,
  VcsReviewThread,
  VcsSubmitReviewInput,
  VcsTreeListing,
  VcsUpdateStatusCheckInput,
} from './types';

/**
 * BitbucketAdapter — `VcsProvider` realization for Bitbucket Cloud (BB-01, D-08 through D-12).
 *
 * Mirrors the structural shape of `GithubAdapter` (vcs/github.ts) but with three load-bearing
 * differences, each annotated inline where it lives:
 *
 *  1. **Async factory `create`** (D-14 / lease-safety): the constructor itself is private because
 *     building a usable BitbucketAdapter requires reading + decrypting a per-repo credential from
 *     Postgres BEFORE the client can be constructed. The async factory makes that rejection visible
 *     to the caller's try/catch at core/review.ts:388-394, which releases the lease before re-
 *     throwing -- the EXACT lease-safety invariant Phase 2 D-05 was carved out to satisfy.
 *
 *  2. **REV-R-A combined marker+summary** (D-08 / D-09): instead of posting a marker comment + N
 *     inline comments + a summary comment + an optional approve (4+ posts), the Bitbucket finalize
 *     path posts `[inlines... (dedup'd), combined-marker+summary, optional approve]` -- a single
 *     final post. The dedup-before-POST step ensures retries after a mid-sequence crash are
 *     idempotent: an existing matching comment is skipped, not duplicated.
 *
 *  3. **REV-M-9 verdict mapping** (D-11): verdict === 'comment' maps to build-status 'SUCCESSFUL',
 *     NOT 'INPROGRESS'. The latter would permanently block PR merges on Bitbucket workspaces
 *     enforcing "require passing builds" once the review finishes -- a permanent block even though
 *     the review is conceptually complete (it's just a comment-only verdict).
 *
 *  4. **REV-M-10 ref opacity**: `updateStatusCheck`'s `ref` argument is PROVIDER-OPAQUE. This
 *     adapter uses it ONLY for the Code Insights report's PUT path. The build-status POST always
 *     uses key='codra-review' regardless of ref -- this is the antigravity merge-gating invariant.
 */

type JobLike = {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  repositoryVcsProvider?: string | null;
  repositoryWorkspace?: string | null;
  headSha?: string | null;
  // PROV-02 (D-07): the resolved repo config snapshot — supplies the configured bot account id
  // for thread-filter self-resolution. Optional so existing call sites without the snapshot
  // (NREG-01) still compile.
  configSnapshot?: RepoConfig | null;
};

type BitbucketJob = JobLike & {
  repositoryWorkspace: string;
  // PROV-02 (D-07): optional configSnapshot pass-through — `undefined` is allowed because tests
  // and non-wire callers may not have it in scope (NREG-01).
};

type TrackerLike = { incrementSubrequests(count?: number): void; hasRemainingSafeBudget?(needed?: number): boolean };

// In-memory cache of fetched PR comments used by submitReview's dedup step (REV-R-A). One fetch
// per submitReview call — the API list is paginated by pagelen=100 which already covers all PRs
// Codra is realistically asked to review. Stored on `this` so multiple inline-comment dedup checks
// share the same lookup within a single submitReview invocation.
type CommentListingItem = {
  id: number;
  body: string;
  inline?: { path: string; to?: number; from?: number };
  // Phase 30 (ANNO-01, D-11/Pitfall 2): a comment's PR-visible permalink, additive and optional --
  // absent on any response shape that doesn't carry it (NREG-01 byte-compat). Threaded through
  // buildDedupIndex/submitReview so postAnnotations can link an annotation back to its comment.
  links?: { html?: { href?: string } };
};

// Stable machine token for the review summary comment's dedup anchor. Bitbucket Cloud has no hidden
// HTML comments (a GitHub-style `<!-- ... -->` renders visibly and its inner HTML is sanitized), so
// the anchor is a clean, human-readable footer instead. Bitbucket preserves the submitted markdown
// verbatim in `content.raw` (what listPullRequestComments reads), so this footer round-trips for
// findExistingReviewForCommit's idempotency check even though it also renders cleanly in the PR.
const BITBUCKET_REVIEW_MARKER = 'codra-review';
// 12 hex chars uniquely identify a commit within a single PR while keeping the footer tidy.
const BITBUCKET_MARKER_SHA_LENGTH = 12;

function bitbucketReviewFooter(commitSha: string): string {
  return `${BITBUCKET_REVIEW_MARKER} · reviewed commit \`${commitSha.slice(0, BITBUCKET_MARKER_SHA_LENGTH)}\``;
}

/**
 * Parse the self-encoding `prId:commentId` comment ref (D-02) back into its two numeric parts.
 *
 * STRICTER than `updateStatusCheck`'s `Number.isFinite` guard (review F4): accepts ONLY exactly two
 * colon-separated CANONICAL POSITIVE SAFE INTEGERS. `Number.isFinite(Number(part))` alone is too
 * weak — it would accept `'42:8:extra'` (split loses the tail), `'42:'`, decimals (`'4.2'`),
 * exponent (`'4e1'`), negatives, zero, and leading zeros. Centralizing validation here means both
 * `editPrComment` (and any future consumer) reject a malformed ref BEFORE any HTTP request.
 */
function parsePrCommentRef(ref: string): { prId: number; commentId: number } {
  const parts = ref.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid Bitbucket comment ref: expected exactly "prId:commentId", got "${ref}"`);
  }
  const [prPart, commentPart] = parts;
  // /^[1-9][0-9]*$/ rejects '', leading zeros, sign, decimal, exponent, and whitespace.
  const canonical = /^[1-9][0-9]*$/;
  if (!canonical.test(prPart) || !canonical.test(commentPart)) {
    throw new Error(`Invalid Bitbucket comment ref: both segments must be canonical positive integers, got "${ref}"`);
  }
  const prId = Number(prPart);
  const commentId = Number(commentPart);
  if (!Number.isSafeInteger(prId) || !Number.isSafeInteger(commentId)) {
    throw new Error(`Invalid Bitbucket comment ref: segments exceed the safe integer range, got "${ref}"`);
  }
  return { prId, commentId };
}

export class BitbucketAdapter implements VcsProvider {
  readonly name = 'bitbucket' as const;
  // Bitbucket Cloud does not render Mermaid diagrams in PR markdown, so the walkthrough formatter
  // MUST NOT emit one for Bitbucket PRs (D-09). `supportsThreadListing` is static-true (the
  // comments endpoint is always available). `supportsThreadResolution` is OBSERVED-DOWNGRADE
  // (D-04): it starts optimistic (true) and the first real 403/404/501 from POST /resolve flips
  // the private backing boolean to false, cached for the rest of the invocation. Exposed via a
  // class getter so the mutable field can be read through the immutable interface shape. Plan
  // 17-02 wires the real POST /resolve plumbing behind the neutral stub.
  private threadResolutionSupported = true;
  get capabilities(): VcsCapabilities {
    return {
      supportsMermaid: false,
      supportsThreadListing: true,
      supportsThreadResolution: this.threadResolutionSupported,
    };
  }
  // Bitbucket Cloud has no native PR-labels feature (Pattern 2). The interface marks `labels`
  // optional; this adapter intentionally does NOT assign the property so callers must feature-
  // detect `if (vcs.labels)` (mirrors `GithubAdapter` which DOES assign it).

  private constructor(
    private env: AppBindings,
    private readonly client: BitbucketClient,
    private readonly job: BitbucketJob,
    private readonly tracker?: TrackerLike,
  ) {}

  /**
   * Async factory: load + decrypt the per-repo credential, then construct the adapter (D-14).
   *
   * The credential read is asynchronous and may reject (missing row, decryption failure, KV
   * unavailable). `runReviewJob` awaits this call INSIDE its lease-release try/catch
   * (core/review.ts:388-394), so a rejection here releases the lease before propagating -- the
   * Phase 2 D-05 promise this factory was carved out to satisfy.
   */
  static async create(
    env: AppBindings,
    job: JobLike,
    tracker?: TrackerLike,
  ): Promise<BitbucketAdapter> {
    const workspace = job.repositoryWorkspace;
    if (!workspace) {
      throw new Error(`Bitbucket job ${job.id} is missing repositoryWorkspace`);
    }

    // Phase 31 (WS-01, D-03): resolves the per-repo credential when present, falling back to the
    // workspace-level credential only when no per-repo row exists (per-repo wins).
    const secrets = await resolveBitbucketBotCredential(env, {
      workspace,
      repoSlug: job.repo,
    });

    if (!secrets || !secrets.encryptedAccessToken) {
      throw new Error(`Bitbucket credential not configured for ${workspace}/${job.repo}`);
    }

    // Phase 4-extracted decryptSecret primitive. Plaintext lives ONLY in this closure (mirrors
    // GitHubClient's memoToken lifetime); never logged (relies on logger redaction in core/logger.ts).
    const token = await decryptSecret(env, secrets.encryptedAccessToken);

    const client = new BitbucketClient(env, token, tracker);
    const adapter = new BitbucketAdapter(env, client, { ...job, repositoryWorkspace: workspace }, tracker);
    return adapter;
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    return this.client.getPullRequest(owner, repo, prNumber);
  }

  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    return this.client.getPullRequestDiff(owner, repo, prNumber);
  }

  // PROV-01 (D-08): content primitive. Delegates to BitbucketClient.getFileContent
  // (`/src/{ref}/{path}`); 404 -> null at the client; non-2xx throws BitbucketError. Bitbucket's
  // `owner` parameter is the workspace (canonical per repo), so we pass it through.
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    return this.client.getFileContent(owner, repo, ref, path);
  }

  // PROV-01 (D-09): compare-diff primitive. Delegates to BitbucketClient.getCompareDiff which
  // builds the REVERSED spec `HEAD..BASE` so the seam's `(base, head)` semantics survive
  // (R-5). Empty success passes through as `''`; non-2xx throws BitbucketError.
  async getCompareDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    return this.client.getCompareDiff(owner, repo, base, head);
  }

  // QA-IDX-01 (D-09): default-branch blob listing. Thin delegation -- three client reads, no walk
  // logic here: `mainbranch.name`, that branch's commit hash, then the paginated `/src` walk.
  //
  // Cost asymmetry versus GitHub is REAL and is what `truncated` exists to express: GitHub finishes
  // in 2 subrequests, Bitbucket needs 2 + one page per ~100 entries per directory level. The walk
  // owns its own page cap and live-budget check, so this method never needs a capability flag
  // (NREG-02) -- see the contract in vcs/types.ts.
  async listDefaultBranchTree(owner: string, repo: string): Promise<VcsTreeListing> {
    const metadata = await this.client.getRepositoryMetadata(owner, repo);
    const branch = metadata.mainbranch?.name;
    if (typeof branch !== 'string' || branch.length === 0) {
      // Throw rather than guessing 'main'/'master'. Deliberately SYMMETRIC with the GitHub adapter,
      // which also throws rather than guessing: indexing a branch the operator did not choose is a
      // worse failure than a loud one.
      throw new BitbucketError(
        502,
        JSON.stringify({ mainbranch: metadata.mainbranch ?? null }),
        `/repositories/${owner}/${repo}`,
        `Bitbucket repository ${owner}/${repo} reported no mainbranch name`,
      );
    }

    const sha = await this.client.getBranchCommitSha(owner, repo, branch);
    if (!sha) {
      throw new BitbucketError(
        502,
        JSON.stringify({ branch }),
        `/repositories/${owner}/${repo}/refs/branches/${branch}`,
        `Bitbucket branch ${branch} on ${owner}/${repo} reported no target commit hash`,
      );
    }

    const { paths, truncated } = await this.client.listSrcTree(owner, repo, branch, this.tracker);
    return { ref: branch, sha, paths, truncated };
  }

  // QA-IDX-01 (D-08): repository metadata read, narrowed to `mainbranch`. Thin delegation — the
  // same client read `listDefaultBranchTree` resolves its default branch through, surfaced so the
  // `repo:push` webhook branch can learn the main branch name without reaching into the private
  // client. Declared OPTIONAL on the interface (the `labels?` pattern): only this adapter
  // implements it, because only Bitbucket's push payload lacks a default-branch field.
  async getRepositoryMetadata(owner: string, repo: string): Promise<{ mainbranch?: { name?: string } }> {
    return this.client.getRepositoryMetadata(owner, repo);
  }

  // PROV-02 (D-05/D-06/D-07): unresolved-bot-thread listing. Walks paginated comments, filters to
  // UNRESOLVED root comments authored by the immutable bot account_id (configured FIRST, then
  // `GET /2.0/user` fallback), and computes `outdated` locally via the current PR diff (R-4).
  // Any client-side failure is caught and converted to `[]` (D-02). The op supports the safe-budget
  // tracker so Phase 18/19 can size work against the live budget (R-9).
  async getUnresolvedBotThreads(owner: string, repo: string, prNumber: number): Promise<VcsReviewThread[]> {
    void owner;
    try {
      // D-07: configured bot id PRECEDES the live `GET /2.0/user` lookup. A repository access
      // token 403s on the live discovery call (A1), so the configured id is the only viable path
      // for many installs. Fall back to the live resolver only when no configuration exists.
      const configuredBotId = this.job.configSnapshot?.review.interactive.commands.bitbucket_bot_account_id ?? null;
      const botIdentity = configuredBotId ? { accountId: configuredBotId } : await this.client.resolveBotUserIdentity();
      const botAccountId = botIdentity.accountId;

      const allComments = await this.client.listRawPullRequestComments(this.job.repositoryWorkspace, this.job.repo, prNumber, this.tracker);

      // Pre-filter deleted / replies / resolved / wrong-id / no-inline so the diff fetch only
      // runs when there are SURVIVING candidates. Each survivor still gets an `outdated` flag
      // computed against the live PR diff below.
      const survivors = allComments.filter((comment) => {
        if (comment.deleted === true) return false;
        if (comment.parent && Object.keys(comment.parent).length > 0) return false;
        if (comment.resolution) return false;
        if (!comment.inline || typeof comment.inline.path !== 'string' || comment.inline.path.length === 0) return false;
        if (typeof comment.id !== 'number') return false;
        if (comment.user?.account_id === undefined || comment.user.account_id !== botAccountId) return false;
        return true;
      });

      if (survivors.length === 0) return [];

      // Parse the current PR diff once. We don't render the diff itself — only its line-validity
      // set per file. Survivors whose path is absent OR whose new-side anchor is invalid become
      // outdated (R-4).
      const diffRaw = await this.client.getPullRequestDiff(this.job.repositoryWorkspace, this.job.repo, prNumber);
      const files = parseUnifiedDiff(diffRaw);
      const fileByPath = new Map<string, FileDiff>();
      for (const file of files) fileByPath.set(file.path, file);

      const out: VcsReviewThread[] = [];
      for (const comment of survivors) {
        const inline = comment.inline!;
        const path = inline.path;
        const file = fileByPath.get(path);
        // new-side anchor: start_to / to. Old-side only: start_from / from, ALWAYS marked outdated.
        const hasNewSide = typeof inline.to === 'number';
        const toVal = inline.to;
        const fromVal = inline.from;
        const startToVal = inline.start_to;
        const startFromVal = inline.start_from;
        const lineEnd = toVal ?? fromVal;
        const lineStart = startToVal ?? toVal ?? startFromVal ?? fromVal;
        const body = typeof comment.content?.raw === 'string' ? comment.content.raw : '';
        if (body.length === 0) continue;

        // Range guards BEFORE emitting the row. Skip rather than fabricate.
        if (lineStart === undefined || lineEnd === undefined) continue;
        if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) continue;
        if (lineStart <= 0 || lineEnd <= 0 || lineStart > lineEnd) continue;

        const newSideValid = file !== undefined &&
          getValidNewLines(file).has(lineStart) && getValidNewLines(file).has(lineEnd);
        const outdated = !hasNewSide || file === undefined || !newSideValid;

        out.push({
          ref: `${prNumber}:${comment.id}`,
          path,
          lineStart,
          lineEnd,
          rootBody: body,
          outdated,
        });
      }
      return out;
    } catch {
      // D-02: silent neutral degradation — no log, no audit, no throw.
      return [];
    }
  }

  // PROV-02 (D-04): resolve a thread. The opaque `ref` is self-encoding `prId:commentId`; validate
  // via the existing `parsePrCommentRef` BEFORE any HTTP request so a malformed ref cannot
  // reach the wire (T-17-02-01). Any operation failure returns `false` (D-02). 403/404/501 are
  // the ONLY statuses that flip `threadResolutionSupported` to false (Pitfall 2): 500/501/etc.
  // are exactly one HTTP attempt via `resolvePullRequestCommentThreadStatus` (no retry).
  async resolveThread(_owner: string, _repo: string, ref: string): Promise<boolean> {
    void _owner; void _repo;
    // Downgrade short-circuit (D-04): once a real 403/404/501 happened, every later call returns
    // false WITHOUT a request.
    if (!this.threadResolutionSupported) return false;
    let parsed: { prId: number; commentId: number };
    try {
      parsed = parsePrCommentRef(ref);
    } catch (error) {
      throw new Error(`resolveThread received a malformed ref: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const status = await this.client.resolvePullRequestCommentThreadStatus(
        this.job.repositoryWorkspace,
        this.job.repo,
        parsed.prId,
        parsed.commentId,
      );
      if (status === 200 || status === 204) return true;
      if (status === 403 || status === 404 || status === 501) {
        this.threadResolutionSupported = false;
      }
      return false;
    } catch {
      return false;
    }
  }

  async createStatusCheck(
    _owner: string,
    _repo: string,
    input: VcsCreateStatusCheckInput,
  ): Promise<{ ref: string }> {
    // REV-M-4: report_type is hard-coded to BUG (Atlassian OpenAPI accepts BUG; smoke-test swap
    // point lives in @server/bitbucket/constants). Prepare-phase always starts the result as
    // PASSED; the actual verdict is set at finalize via updateStatusCheck.
    await this.client.upsertCodeInsightsReport(this.job.repositoryWorkspace, this.job.repo, input.headSha, {
      title: input.title,
      details: input.summary,
      report_type: REPORT_TYPE,
      result: REPORT_RESULT[0], // 'PASSED' — initialize for the prepare phase.
    });
    // Caller-chosen report_id; both fresh and retry use this same string (D-10 idempotent upsert).
    return { ref: 'codra-review' };
  }

  async updateStatusCheck(
    owner: string,
    repo: string,
    ref: string,
    input: VcsUpdateStatusCheckInput,
  ): Promise<void> {
    // Map VCS-agnostic verdict -> Bitbucket Code Insights result. SUCCESS/FAILURE/CANCELLED map
    // directly to PASSED/FAILED (REV-M-4: Bitbucket reports are binary terminal states only).
    let result: typeof REPORT_RESULT[number] = 'PASSED';
    if (input.conclusion === 'failure' || input.conclusion === 'cancelled') {
      result = 'FAILED';
    }

    // (1) PUT the rich report FIRST so the in-PR summary carries the latest title/details
    // (D-10 ordering). `ref` is PROVIDER-OPAQUE; for Bitbucket it's the report_id string
    // ('codra-review' for both fresh and retry), and PUT to the same URL is the idempotent upsert.
    await this.client.upsertCodeInsightsReport(this.job.repositoryWorkspace, repo, this.job.headSha ?? '', {
      title: input.title,
      details: input.summary,
      report_type: REPORT_TYPE,
      result,
      ...(ref ? { link: `${this.env.APP_URL}/jobs/${this.job.id}` } : {}),
    });

    // (2) POST the merge-gating build status SECOND (D-11).
    // REV-M-9 mapping (the antigravity merge-blocking fix):
    //   - conclusion 'success'  -> 'SUCCESSFUL'
    //   - conclusion 'neutral'  -> 'SUCCESSFUL' (NOT 'INPROGRESS' — that would block merges
    //                               forever on workspaces enforcing 'require passing builds'
    //                               for a comment-only verdict)
    //   - conclusion 'failure' | 'cancelled' -> 'FAILED'
    //   - status 'in_progress' -> 'INPROGRESS'
    let state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS';
    if (input.status === 'in_progress') {
      state = 'INPROGRESS';
    } else if (input.conclusion === 'failure' || input.conclusion === 'cancelled') {
      state = 'FAILED';
    } else {
      // 'success' OR 'neutral' (the comment verdict) -> SUCCESSFUL
      state = 'SUCCESSFUL';
    }

    // REV-M-10: the build-status POST HARDCODES key='codra-review' regardless of `ref`. The `ref`
    // argument is used ONLY for the Code Insights PUT path above; the merge-gating POST is keyed
    // by the canonical 'codra-review' string so retries upsert in place.
    await this.client.postCommitBuildStatus(this.job.repositoryWorkspace, repo, this.job.headSha ?? '', {
      key: 'codra-review',
      state,
      description: input.title,
      url: `${this.env.APP_URL}/jobs/${this.job.id}`,
    });
    // `owner` is unused here because Bitbucket's workspace is canonical (not the workspace+owner
    // pair GitHub uses). Accept the parameter to satisfy the VcsProvider interface.
    void owner;
  }

  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    input: VcsSubmitReviewInput,
  ): Promise<{ ref: string; postedComments: VcsPostedComment[] }> {
    const workspace = this.job.repositoryWorkspace;

    // REV-R-A step 1: fetch existing comments to seed the dedup index BEFORE posting anything.
    const existing = await this.client.listPullRequestComments(workspace, repo, prNumber, 100);
    const dedup = buildDedupIndex(existing);

    // Walk the cached diff once so we can translate `position -> { to | from, line_type }`.
    const files = await this.loadCachedDiffFiles();

    // Phase 30 (ANNO-01, D-11): collect a VcsPostedComment for BOTH the freshly-posted branch AND
    // the dedup-matched (already-existing) branch below, so postAnnotations (called after this
    // method returns) can link every current-round finding's annotation back to its comment --
    // including findings whose comment already existed from a prior round (Pitfall 1).
    const postedComments: VcsPostedComment[] = [];

    // REV-R-A step 2: post inline comments (or skip if a matching comment already exists).
    for (const comment of input.comments) {
      const anchor = anchorForComment(comment, files);
      if (!anchor) {
        logger.warn(`BitbucketAdapter: no anchor found for comment on ${comment.path} position ${comment.position}; skipping`);
        continue;
      }

      const key = deDupKey(comment.path, anchor, comment.body);
      const existingMatch = dedup.get(key);
      if (existingMatch) {
        // Existing matching comment on this PR for this anchor + body — skip the POST, but still
        // record its link (Pitfall 1 fix).
        postedComments.push({ path: comment.path, line: anchor.line, body: comment.body, link: existingMatch.link });
        continue;
      }

      const postedInline = await this.client.postPullRequestComment(workspace, repo, prNumber, {
        path: comment.path,
        line: anchor.line,
        line_type: anchor.line_type,
        content: { raw: comment.body },
      });
      postedComments.push({ path: comment.path, line: anchor.line, body: comment.body, link: postedInline.links?.html?.href });
      // Add to the in-memory map so subsequent comments with the same key are also dedup'd.
      dedup.set(key, { id: postedInline.id, link: postedInline.links?.html?.href });
    }

    // REV-R-A step 3: the summary as the SINGLE final post. The dedup anchor is a clean Bitbucket
    // footer (see BITBUCKET_REVIEW_MARKER) appended AFTER the summary — no GitHub-flavored HTML
    // (`<!-- ... -->` / `<sub>`), both of which render as junk on Bitbucket Cloud (Thread C).
    // `input.summaryBody` is already Bitbucket-formatted by formatReviewOverview({ provider }).
    const combinedBody = `${input.summaryBody}\n\n---\n\n${bitbucketReviewFooter(input.commitSha)}`;
    void input.jobIdHint;
    const posted = await this.client.postPullRequestComment(workspace, repo, prNumber, {
      content: { raw: combinedBody },
    });

    // REV-R-A step 4: approve ONLY when verdict === 'approve'.
    if (input.verdict === 'approve') {
      await this.client.approvePullRequest(workspace, repo, prNumber);
    }
    void owner;
    return { ref: String(posted.id), postedComments };
  }

  async findExistingReviewForCommit(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
  ): Promise<{ ref: string } | null> {
    const workspace = this.job.repositoryWorkspace;
    const items = await this.client.listPullRequestComments(workspace, repo, prNumber, 100);
    // Match the Bitbucket review-summary footer (BITBUCKET_REVIEW_MARKER) for this commit. Bitbucket
    // returns the raw submitted markdown in `content.raw`, so the footer is present verbatim even
    // though it also renders in the PR. Both submitReview and this matcher slice the sha to the same
    // length so the anchor is symmetric.
    const shortSha = commitSha.slice(0, BITBUCKET_MARKER_SHA_LENGTH);
    const matched = items.find(
      (item) => item.body.includes(BITBUCKET_REVIEW_MARKER) && item.body.includes(shortSha),
    );
    void owner;
    return matched ? { ref: String(matched.id) } : null;
  }

  /**
   * ANNO-01: bulk-create-or-replace the dedicated Code Insights annotation report, mirroring the
   * exact set of findings already posted as inline comments (D-07/D-08 -- no independent
   * selection/cap logic here).
   *
   * D-09 full-replace: DELETE the report (idempotent -- 404 on round 1 is swallowed inside the
   * client) then recreate it via PUT, THEN bulk-POST the current round's annotations. This is
   * stateless -- no persisted external_id bookkeeping across rounds is needed, since Bitbucket's
   * report deletion is documented (and, per this phase's blocking human-check, confirmed live) to
   * cascade to the report's child annotations.
   *
   * D-11 FIFO-per-key join: `input.postedComments` and `input.findings` are assumed to be
   * populated from the SAME underlying array in the SAME relative order upstream -- Plan 30-04's
   * `runFinalizePhase` passes the SAME `finalComments` array to both `submitReview` and
   * `postAnnotations`, which is what keeps the two arrays' relative ordering aligned
   * (30-REVIEWS.md OpenCode Concern #2). A FIFO-per-key `.shift()` (not a plain `.find()`)
   * correctly disambiguates the rare case of two findings sharing one `(path, line)` pair.
   *
   * Fail-open (D per RESEARCH.md Open Questions #3): this method does NOT catch its own errors --
   * the caller (Plan 30-04's finalize wiring) wraps the whole call in its own best-effort
   * try/catch, matching the walkthrough-edit posture elsewhere in finalize.
   */
  async postAnnotations(
    owner: string,
    repo: string,
    prNumber: number,
    input: VcsPostAnnotationsInput,
  ): Promise<void> {
    const workspace = this.job.repositoryWorkspace;
    const commit = input.commitSha;

    // D-09: full replace every round. Delete-then-recreate; the DELETE 404-swallow (round 1, no
    // prior report) lives inside deleteCodeInsightsReport (core/bitbucket.ts, Plan 30-02).
    await this.client.deleteCodeInsightsReport(workspace, repo, commit, ANNOTATION_REPORT_ID);
    await this.client.upsertCodeInsightsReport(
      workspace,
      repo,
      commit,
      {
        title: 'Codra Annotations',
        details: 'Per-line severity markers mirroring inline review comments.',
        report_type: REPORT_TYPE,
        result: REPORT_RESULT[0], // 'PASSED' — ALWAYS, per D-02 (informational only, never merge-gating).
      },
      ANNOTATION_REPORT_ID,
    );

    // FIFO-per-key join: findings and postedComments are matched by `${path}|${line}` and the
    // matched queue entry is shift()'d off so a rare same-(path,line) collision consumes entries
    // in the same relative order they were produced (see the class-level doc comment above).
    const postedByKey = new Map<string, VcsPostedComment[]>();
    for (const comment of input.postedComments ?? []) {
      const key = `${comment.path}|${comment.line}`;
      const queue = postedByKey.get(key);
      if (queue) {
        queue.push(comment);
      } else {
        postedByKey.set(key, [comment]);
      }
    }

    const annotations = input.findings.map((finding) => {
      const key = `${finding.path}|${finding.line}`;
      const queue = postedByKey.get(key);
      const matchedComment = queue?.shift();
      return buildAnnotation(finding, matchedComment);
    });

    // Pitfall 3: chunk at Bitbucket's documented maxItems (100 per POST); log a per-batch-index
    // warning naming the failing chunk before rethrowing (additive diagnostics only -- fail-open
    // is preserved by the caller's own try/catch).
    const totalChunks = Math.ceil(annotations.length / ANNOTATION_BATCH_SIZE);
    for (let i = 0; i < annotations.length; i += ANNOTATION_BATCH_SIZE) {
      const chunk = annotations.slice(i, i + ANNOTATION_BATCH_SIZE);
      try {
        await this.client.bulkUpsertAnnotations(workspace, repo, commit, ANNOTATION_REPORT_ID, chunk);
      } catch (error) {
        logger.warn(
          `BitbucketAdapter.postAnnotations: batch ${i / ANNOTATION_BATCH_SIZE} of ${totalChunks} (size ${chunk.length}) failed`,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }
    }

    void owner;
    void prNumber;
  }

  /**
   * Standalone (issue/PR-level) comment primitives (D-01/D-02). Inert this phase — no consumer
   * (D-06). The ref is self-encoding `prId:commentId` so a persisted ref (Phase 9's
   * `walkthrough_comment_ref`) is editable with nothing else, mirroring `updateStatusCheck`'s
   * opaque ref. `owner` is ignored — Bitbucket's workspace is canonical (this.job.repositoryWorkspace).
   */
  async createPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ ref: string }> {
    // Reuse the content-only post branch (no inline object) — the same path submitReview uses for
    // its combined marker+summary. No dedup scan of listPrComments (thin primitive, D-04).
    const posted = await this.client.postPullRequestComment(this.job.repositoryWorkspace, repo, prNumber, {
      content: { raw: body },
    });
    void owner;
    return { ref: `${prNumber}:${posted.id}` };
  }

  async replyToPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    inReplyToRef: string,
  ): Promise<{ ref: string }> {
    // Decode BOTH parts via parsePrCommentRef (never split(':') — Pitfall #1); this throws on a
    // malformed ref BEFORE any request (T-12-01-1). The opaque ref self-encodes the PR id, so
    // validate the decoded prId against the target prNumber and reject a mismatch — the encoded PR
    // component must not be silently discarded (T-12-01-4; mirrors how editPrComment trusts prId).
    const { prId, commentId } = parsePrCommentRef(inReplyToRef);
    if (prId !== prNumber) {
      throw new Error(
        `replyToPrComment ref PR mismatch for ${repo}: decoded prId ${prId} != target prNumber ${prNumber} (ref ${JSON.stringify(inReplyToRef)})`,
      );
    }
    const posted = await this.client.replyToPullRequestComment(this.job.repositoryWorkspace, repo, prNumber, commentId, body);
    void owner;
    return { ref: `${prNumber}:${posted.id}` };
  }

  async editPrComment(
    owner: string,
    repo: string,
    ref: string,
    body: string,
  ): Promise<{ ref: string } | null> {
    // parsePrCommentRef throws on a malformed ref BEFORE any request (review F4). The self-encoding
    // ref carries the PR id, so editPrComment needs no prNumber argument (D-02).
    const { prId, commentId } = parsePrCommentRef(ref);
    const result = await this.client.editPullRequestComment(this.job.repositoryWorkspace, repo, prId, commentId, body);
    void owner;
    // null (from a 404 OR 410 — amended D-05) flows straight through; on success echo the same ref.
    return result ? { ref } : null;
  }

  async listPrComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ ref: string; body: string; author: { id: string; login: string } }>> {
    const items = await this.client.listPullRequestComments(this.job.repositoryWorkspace, repo, prNumber, 100);
    void owner;
    const results: Array<{ ref: string; body: string; author: { id: string; login: string } }> = [];
    for (const item of items) {
      const id = item.author?.id;
      // OMIT a comment lacking an immutable account_id (review F5) — never surface author.id ''.
      // A false empty id would defeat the Phase 11 self-filter that keys on author.id (NREG-02).
      if (id === undefined || id === '') continue;
      results.push({
        ref: `${prNumber}:${item.id}`,
        body: item.body,
        author: { id, login: item.author.login },
      });
    }
    return results;
  }

  async getUserRepoPermission(
    owner: string,
    repo: string,
    authorId: string,
    _authorLogin?: string,
  ): Promise<'admin' | 'write' | 'read' | 'none' | null> {
    // On Bitbucket the AUTHORITATIVE authorization is the per-repo allow-list of immutable
    // account_ids evaluated in Plan 03 authorizeActor
    // (config.review.interactive.commands.bitbucket_allowed_account_ids). This read is a BEST-EFFORT
    // enhancement (A1): repository access tokens cannot query the permission endpoint, so it
    // frequently 403s → null. A null return means "defer to the allow-list", NOT "deny". It keys
    // STRICTLY on the immutable account_id (NREG-02) — the paired login is irrelevant here — and it
    // NEVER maps workspace membership to 'write' (membership ≠ write access).
    void _authorLogin;
    void owner; // Bitbucket's workspace is canonical (this.job.repositoryWorkspace), not owner.
    return this.client.getUserRepoPermission(this.job.repositoryWorkspace, repo, authorId);
  }

  // Phase 11 (CMD-07): resolve the bot's own immutable account_id (GET /2.0/user) so the Plan 06
  // dispatch layer can build a self-filter resolver from this provider. Delegates to the client.
  async resolveBotUserIdentity(): Promise<{ accountId: string; login?: string }> {
    return this.client.resolveBotUserIdentity();
  }

  async getInlineCommentDetails(
    owner: string,
    repo: string,
    prNumber: number,
    commentRef: string,
  ): Promise<{ path: string; line: number | null; position: number | null; body: string } | null> {
    void owner; // Bitbucket's workspace is canonical (this.job.repositoryWorkspace).
    const commentId = Number(commentRef);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      return null;
    }
    const comment = await this.client.getPullRequestComment(this.job.repositoryWorkspace, repo, prNumber, commentId);
    if (!comment) {
      return null;
    }
    // Not an inline comment — no path/line to resolve.
    if (!comment.inline) {
      return null;
    }
    return {
      path: comment.inline.path,
      line: comment.inline.to ?? comment.inline.from ?? null,
      // Bitbucket has NO diff offset to report, so `position` is always null here. The write path
      // (`postPullRequestComment`) sends `inline: { path, to | from }` and this read path returns
      // `inline.to ?? inline.from` — a LINE on both sides. The asymmetry with GitHub (which anchors
      // by diff `position`) is intentional: each provider is matched on the coordinate it actually
      // anchors by, so Bitbucket enrichment resolves on `review_comments.line` (NREG-02, G-28-3).
      position: null,
      body: comment.content?.raw ?? '',
    };
  }

  /**
   * Loads the cached diff for this job from KV and parses it once. Mirrors the diff-cache shape
   * that core/review.ts uses (key `diff:<jobId>`). Falls back to a freshly-fetched diff if no
   * cache entry exists (REV-R-A wants to be robust to mid-sequence cache eviction).
   */
  private async loadCachedDiffFiles(): Promise<FileDiff[]> {
    const cacheKey = `diff:${this.job.id}`;
    let raw = await this.env.APP_KV.get(cacheKey);
    if (!raw) {
      raw = await this.client.getPullRequestDiff(this.job.repositoryWorkspace, this.job.repo, this.job.prNumber);
      try {
        await this.env.APP_KV.put(cacheKey, raw);
      } catch (error) {
        logger.warn(`Failed to cache diff for job ${this.job.id}; using fresh fetch only`, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return parseUnifiedDiff(raw);
  }
}

type AnchorShape = { path: string; line: number; line_type: 'added' | 'context' | 'removed' };

/**
 * Translate VcsReviewComment.position to Bitbucket's `{path, to | from, line_type}` anchor by
 * walking the parsed FileDiff (D-12). Antigravity's preference: search the flattened hunk lines
 * for `line.position === comment.position` directly (uniform for added/context/removed). For
 * deletion-only lines (R-03 inverse mapping) the adapter uses `from=line.oldLineNumber,
 * line_type='removed'` since findPositionForLine only handles non-del kind.
 */
function anchorForComment(comment: VcsReviewComment, files: FileDiff[]): AnchorShape | null {
  if (comment.position === undefined || comment.position === null) return null;
  const file = files.find((f) => f.path === comment.path);
  if (!file) return null;

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.position !== comment.position) continue;

      if (line.kind === 'del') {
        // R-03 inverse: removed lines anchor with `from` + line_type='removed'. oldLineNumber
        // is set during diff parsing for del lines; fall back to a defensive Number() check.
        const oldLine = line.oldLineNumber;
        if (oldLine === undefined) return null;
        return { path: comment.path, line: oldLine, line_type: 'removed' };
      }
      // Added or context: anchor with `to` + newLineNumber.
      const newLine = line.newLineNumber;
      if (newLine === undefined) return null;
      return { path: comment.path, line: newLine, line_type: line.kind === 'add' ? 'added' : 'context' };
    }
  }

  return null;
}

function deDupKey(path: string, anchor: AnchorShape, body: string) {
  // The body is what the bot would post; path+line+line_type disambiguate the anchor; the body
  // distinguishes a rephrased comment at the same location. This is intentionally a single string
  // so the dedup set is a Set<string> (cheap lookup; no JSON.stringify hot path).
  return `${path}|${anchor.line_type}|${anchor.line}|${body}`;
}

/**
 * Phase 30 (ANNO-01, D-11/Pitfall 1): widened from a `Set<string>` to a `Map<string, {id, link}>`
 * so a dedup-matched comment on a re-review round still carries its id/link forward -- a bare Set
 * only answered "does this need posting," discarding the id/link a later annotation-linking step
 * needs. Both the freshly-posted and dedup-matched branches of submitReview's posting loop now
 * populate `postedComments` from this map (closes RESEARCH.md Pitfall 1).
 */
function buildDedupIndex(items: CommentListingItem[]) {
  const map = new Map<string, { id: number; link?: string }>();
  for (const item of items) {
    if (!item.inline) continue;
    const anchor: AnchorShape = {
      path: item.inline.path,
      line: item.inline.to ?? item.inline.from ?? 0,
      line_type: item.inline.from !== undefined ? 'removed' : 'added',
    };
    map.set(deDupKey(item.inline.path, anchor, item.body), { id: item.id, link: item.links?.html?.href });
  }
  return map;
}

/**
 * Phase 30 (ANNO-01): a small, synchronous, deterministic 32-bit FNV-1a string hash. Exists
 * purely so two DIFFERENT finding titles at the same `(path, line, category)` never collide on
 * `buildAnnotation`'s `external_id` (30-REVIEWS.md OpenCode Concern #4 / Suggestion #2) --
 * non-cryptographic, not used for any security property. `Math.imul` keeps the multiplication
 * within 32-bit semantics without needing `BigInt`; this needs no crypto import, matching this
 * file's zero-new-dependency posture.
 */
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Phase 30 (ANNO-01): builds one Bitbucket `report_annotation` from a Codra finding.
 *
 * - `external_id` combines `path`/`line`/`category` AND a deterministic `fnv1aHash(finding.title)`
 *   suffix -- two findings sharing the SAME `(path, line, category)` but DIFFERENT titles (e.g.
 *   two P0 security issues on the same line) must never collide and silently overwrite each
 *   other via Bitbucket's create-or-update semantics (30-REVIEWS.md OpenCode Concern #4).
 * - `title`/`summary` are `finding.title` VERBATIM -- D-10/D-12: no redaction, no category/
 *   confidence padding, no audit-trail metadata. Annotations are posted PR content with the same
 *   visibility as the inline comment they mirror, NOT the `jobs.audit` operator surface AUD-01
 *   governs (review-feedback prohibition against expanded disclosure).
 * - `result` is the LITERAL string `'PASSED'`, never derived from `finding.severity` or any other
 *   signal (D-02) -- this is intentionally hardcoded so the informational annotation surface can
 *   never silently become an unexpected new merge-gating signal alongside the existing
 *   `codra-review` summary report.
 * - `link` is OMITTED (not fabricated) when `matchedComment` has no `link` (Pitfall 4).
 */
function buildAnnotation(finding: ParsedReviewComment, matchedComment: VcsPostedComment | undefined): ReportAnnotation {
  return {
    external_id: `codra-${finding.path}-${finding.line ?? 0}-${finding.category}-${fnv1aHash(finding.title)}`,
    title: finding.title,
    annotation_type: ANNOTATION_TYPE,
    severity: ANNOTATION_SEVERITY_MAP[finding.severity],
    summary: finding.title,
    result: 'PASSED',
    path: finding.path,
    line: finding.line ?? undefined,
    link: matchedComment?.link,
  };
}