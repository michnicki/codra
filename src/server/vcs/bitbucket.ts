import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';
import { BitbucketClient } from '@server/core/bitbucket';
import { decryptSecret } from '@server/core/crypto';
import { parseUnifiedDiff, type FileDiff } from '@server/core/diff';
import { getVcsCredentialSecrets } from '@server/db/vcs-credentials';
import {
  REPORT_TYPE,
  REPORT_RESULT,
} from '@server/bitbucket/constants';
import type {
  VcsCapabilities,
  VcsCreateStatusCheckInput,
  VcsProvider,
  VcsPullRequest,
  VcsReviewComment,
  VcsReviewThread,
  VcsSubmitReviewInput,
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
};

type BitbucketJob = JobLike & {
  repositoryWorkspace: string;
};

type TrackerLike = { incrementSubrequests(count?: number): void };

// In-memory cache of fetched PR comments used by submitReview's dedup step (REV-R-A). One fetch
// per submitReview call — the API list is paginated by pagelen=100 which already covers all PRs
// Codra is realistically asked to review. Stored on `this` so multiple inline-comment dedup checks
// share the same lookup within a single submitReview invocation.
type CommentListingItem = { id: number; body: string; inline?: { path: string; to?: number; from?: number } };

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

    const secrets = await getVcsCredentialSecrets(env, {
      vcsProvider: 'bitbucket',
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
    const adapter = new BitbucketAdapter(env, client, { ...job, repositoryWorkspace: workspace });
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

  // PROV-02 (D-05/D-06/D-07): unresolved-bot-thread listing. PLAN-02-IMPL — Plan 17-02 replaces
  // this stub with the comments-page filter (root + unresolved + immutable bot account_id).
  async getUnresolvedBotThreads(owner: string, repo: string, prNumber: number): Promise<VcsReviewThread[]> {
    void owner; void repo; void prNumber;
    return [];
  }

  // PROV-02 (D-04): resolve a thread. PLAN-02-IMPL — Plan 17-02 replaces this stub with the
  // POST /comments/{id}/resolve call. The first 403/404/501 flips `threadResolutionSupported`
  // to false; subsequent calls short-circuit without a request.
  async resolveThread(owner: string, repo: string, ref: string): Promise<boolean> {
    void owner; void repo; void ref;
    return false;
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
  ): Promise<{ ref: string }> {
    const workspace = this.job.repositoryWorkspace;

    // REV-R-A step 1: fetch existing comments to seed the dedup index BEFORE posting anything.
    const existing = await this.client.listPullRequestComments(workspace, repo, prNumber, 100);
    const dedup = buildDedupIndex(existing);

    // Walk the cached diff once so we can translate `position -> { to | from, line_type }`.
    const files = await this.loadCachedDiffFiles();

    // REV-R-A step 2: post inline comments (or skip if a matching comment already exists).
    for (const comment of input.comments) {
      const anchor = anchorForComment(comment, files);
      if (!anchor) {
        logger.warn(`BitbucketAdapter: no anchor found for comment on ${comment.path} position ${comment.position}; skipping`);
        continue;
      }

      if (dedup.has(deDupKey(comment.path, anchor, comment.body))) {
        // Existing matching comment on this PR for this anchor + body — skip.
        continue;
      }

      await this.client.postPullRequestComment(workspace, repo, prNumber, {
        path: comment.path,
        line: anchor.line,
        line_type: anchor.line_type,
        content: { raw: comment.body },
      });
      // Add to the in-memory set so subsequent comments with the same key are also dedup'd.
      dedup.add(deDupKey(comment.path, anchor, comment.body));
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
    return { ref: String(posted.id) };
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

function buildDedupIndex(items: CommentListingItem[]) {
  const set = new Set<string>();
  for (const item of items) {
    if (!item.inline) continue;
    const anchor: AnchorShape = {
      path: item.inline.path,
      line: item.inline.to ?? item.inline.from ?? 0,
      line_type: item.inline.from !== undefined ? 'removed' : 'added',
    };
    set.add(deDupKey(item.inline.path, anchor, item.body));
  }
  return set;
}