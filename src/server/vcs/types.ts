// Provider-agnostic VCS contract. This module is the sibling of `models/types.ts` --
// a plain types module (no logic) that every per-provider adapter (`vcs/github.ts`,
// and a future `vcs/bitbucket.ts`) implements. Lives in `vcs/`, not `src/shared/`,
// because these shapes do not cross the worker/client boundary this phase.
//
// Phase 30 (ANNO-01): imports ParsedReviewComment from @shared/schema for
// VcsPostAnnotationsInput.findings. This is a type-only import from a module that has no imports
// back from vcs/types.ts, so no circular import is introduced.
import type { ParsedReviewComment } from '@shared/schema';

/**
 * Flattened PR metadata. Deliberately NOT the nested `{ head: { sha, ref }, base: {...},
 * user: { login } }` shape GitHub's REST API returns (see `core/github.ts` `PullRequestRecord`)
 * -- the flatten is what stops GitHub's payload shape leaking into the shared contract (D-01).
 */
export type VcsPullRequest = {
  number: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  headSha: string;
  headRef: string | null;
  baseSha: string;
  baseRef: string | null;
  authorLogin: string | null;
};

/**
 * Input for creating a status check. `headSha` is REQUIRED here because
 * `createStatusCheck` maps to `createCheckRun`, which needs it to anchor the check run to a
 * commit. Split from `VcsUpdateStatusCheckInput` (review finding 6, opencode MEDIUM) so the
 * update shape never carries a field its call sites don't have in scope.
 */
export type VcsCreateStatusCheckInput = {
  headSha: string;
  title: string;
  summary: string;
  // NO `status`/`conclusion` here: creation is always `in_progress` (the GitHub adapter's
  // `createCheckRun` hardcodes it, and Bitbucket's create is equivalently fixed). Advertising
  // them on the create input would be a silent no-op the adapter cannot honor (WR-02) --
  // callers that need a terminal state use `updateStatusCheck`/`VcsUpdateStatusCheckInput`.
};

/**
 * Input for updating an already-created status check. Deliberately has NO `headSha` --
 * `core/review.ts`'s four `updateStatusCheck` call sites (:703/:987/:1405/:1527) never have a
 * headSha in scope, so it must not leak into this type (review finding 6, opencode MEDIUM).
 */
export type VcsUpdateStatusCheckInput = {
  title: string;
  summary: string;
  status?: 'in_progress' | 'completed';
  conclusion?: 'success' | 'neutral' | 'failure' | 'cancelled';
};

/**
 * Field-for-field identical to `GitHubReviewComment` (`core/github.ts:89`), so GitHub's adapter
 * performs zero mapping (assumption A1). The concrete anchor/position naming is provider-agnostic
 * on purpose -- no GitHub-only required fields (Pitfall 1).
 */
export type VcsReviewComment = {
  path: string;
  position?: number;
  body: string;
};

export type VcsSubmitReviewInput = {
  commitSha: string;
  verdict: 'approve' | 'comment';
  summaryBody: string;
  comments: VcsReviewComment[];
  // REV-M-5: optional job id used by the Bitbucket adapter's combined marker+summary comment
  // (REV-R-A). The GitHub adapter accepts it and ignores it -- the GitHub submitReview flow
  // composes a single createReview POST that does not need the job id embedded in the body. The
  // field is optional so existing GitHub call sites continue to type-check unchanged.
  jobIdHint?: string;
};

/**
 * Phase 30 (ANNO-01, D-11): the shape `submitReview`'s widened return threads per posted-or-
 * matched comment -- populated for BOTH a freshly-posted comment and a dedup-matched (already
 * existing) comment, so a re-review round's dedup-skipped comments still carry a `link` (closes
 * RESEARCH.md Pitfall 1). `link` is optional because a comment's `links.html.href` is not
 * guaranteed present on every response shape.
 */
export type VcsPostedComment = { path: string; line: number; body: string; link?: string };

/**
 * Phase 30 (ANNO-01): input to `postAnnotations?`. `postedComments` is OPTIONAL because a
 * finalize retry that reuses an already-posted review has none from THIS invocation -- the
 * caller (Plan 30-04) handles that branch via a type guard.
 */
export type VcsPostAnnotationsInput = {
  commitSha: string;
  findings: ParsedReviewComment[];
  postedComments?: VcsPostedComment[];
};

/**
 * Provider-agnostic review-thread shape (D-05/D-06). Every field is plain data so the seam
 * surface never exposes a raw provider id to `core/`. `ref` is PROVIDER-OPAQUE: GitHub uses the
 * GraphQL PullRequestReviewThread node id; Bitbucket uses the self-encoding `${prId}:${rootId}`
 * convention. `outdated` is the union of GitHub's native `isOutdated` and Bitbucket's local
 * anchor-validity heuristic (R-4).
 *
 * `lineStart`/`lineEnd` are the head/new-side line range. Phase 18 (RND-04) suppresses
 * findings whose range overlaps. `rootBody` is the thread's root comment text only; the
 * comment chain is not surfaced (D-05).
 */
export type VcsReviewThread = {
  ref: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  rootBody: string;
  outdated: boolean;
};

/**
 * Provider-agnostic default-branch tree listing (QA-IDX-01, D-09). Flat by design: the codebase
 * index only ever needs "which blobs exist, at which commit", so the shape deliberately does NOT
 * expose per-entry modes, sizes or a nested directory structure that would leak GitHub's
 * `git/trees` payload (or Bitbucket's `/src` entry shape) into the shared contract.
 *
 * `ref` is the resolved default-branch NAME; `sha` is the commit that branch pointed at when the
 * listing was taken. See `VcsProvider.listDefaultBranchTree` for the `truncated` semantics.
 */
export type VcsTreeListing = {
  ref: string;
  sha: string;
  paths: string[];
  truncated: boolean;
};

/**
 * Per-adapter capability flags (D-03/D-04). The block is the single extension point for future
 * capability flags (Phase 8 D-09). `supportsThreadListing` and `supportsThreadResolution` are
 * both `static: true` for GitHub and `static: true` for Bitbucket today, but Bitbucket's
 * `supportsThreadResolution` is ALSO backed by a mutable adapter field that can downgrade on a
 * real 403/404/501 resolve call (R-1). Declared as a getter-on-class shape (not a frozen `as
 * const`) so the adapter can expose a mutable field without re-typing the interface.
 */
export type VcsCapabilities = {
  readonly supportsMermaid: boolean;
  readonly supportsThreadListing: boolean;
  readonly supportsThreadResolution: boolean;
};

/**
 * The provider-agnostic seam every later phase rides on (mirrors the `ModelService`/
 * `models/types.ts` strategy pattern). Status-check/review methods return an opaque
 * `{ ref: string }`, never a numeric id (D-01/D-02) -- Bitbucket's build-status API has no
 * server-assigned id to hand back. `labels` is OPTIONAL: Bitbucket Cloud has no native PR-labels
 * feature, so callers must feature-detect `if (vcs.labels)` rather than assume it (Pattern 2).
 */
export interface VcsProvider {
  readonly name: 'github' | 'bitbucket';

  /**
   * Per-adapter capability flags. REQUIRED (not optional like `labels?`) so every adapter MUST
   * declare it — this is the single extension point where future capability flags join the same
   * block, avoiding a per-flag interface refactor (D-09). `supportsMermaid` lets a later phase's
   * walkthrough formatter gate its Mermaid diagram per-provider (GitHub renders Mermaid in
   * markdown; Bitbucket Cloud does not). `supportsThreadListing` and `supportsThreadResolution`
   * (D-03) are static on GitHub and mutable on Bitbucket (D-04). Inert this phase — no consumer
   * reads any of them yet.
   */
  readonly capabilities: VcsCapabilities;

  /**
   * Read the file at `path` at `ref` (any git ref: branch / tag / commit SHA). Returns the
   * decoded raw text on success, `null` ONLY when the provider responds with a 404 (D-08 -- a
   * deleted-at-head file is a "can't-verify" signal, not a crash). Throws on any other non-2xx
   * (network, 5xx, auth) so real failures are not masked. Both providers implement this on the
   * same semantic contract (PROV-01).
   */
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;

  /**
   * Read the unified diff between `base` and `head` (any git refs). Returns the raw diff text
   * on success, including the empty string `''` when the providers' diff is empty (D-09 --
   * Phase 18 must distinguish a genuinely-empty incremental diff from an errored one). Throws
   * on any non-2xx. Provider-specific compare direction is preserved: GitHub uses BASE...HEAD
   * with the `application/vnd.github.diff` media type; Bitbucket uses HEAD..BASE with
   * `context=3&topic=true` (R-5).
   */
  getCompareDiff(owner: string, repo: string, base: string, head: string): Promise<string>;

  /**
   * List the blob paths of the repository's DEFAULT branch (QA-IDX-01, D-09).
   *
   * The adapter RESOLVES THE DEFAULT BRANCH ITSELF. There is no webhook payload on the
   * dashboard-triggered index-build path (D-07: the build is started by a button, not by a push),
   * so the caller has no branch to supply. The resolved commit sha is returned ALONGSIDE the paths
   * so the caller can persist `indexed_sha` (D-12) without a second round trip.
   *
   * `paths` contains BLOBS ONLY -- no directories -- as repo-root-absolute paths, UNSORTED. GitHub
   * `tree` entries (directories) and `commit` entries (submodules) are dropped; Bitbucket
   * `commit_directory` entries are dropped. A submodule's content is not in this repository, so an
   * indexer must never try to read it as a file.
   *
   * `truncated` is true when the provider could not return the whole tree within its own limits:
   * GitHub sets it above 100 000 entries or 7 MB on the recursive `git/trees` endpoint; the
   * Bitbucket adapter sets it when its internal page budget is exhausted. A truncated result is
   * USABLE but PARTIAL -- never returned silently, mirroring the D-09 "empty string is a real
   * result" convention on `getCompareDiff`.
   *
   * ORDERING CONSEQUENCE OF TRUNCATION (read this before adding a max-files cap). The PROVIDER
   * chooses which prefix of the tree to return, and that choice is ARBITRARY -- it is not
   * priority-ordered in any way the consumer can influence. A consumer's priority sort (`scorePath`)
   * therefore runs AFTER the truncation, so on a repository large enough to truncate, a
   * high-priority path (an auth or crypto file) can be absent from the candidate pool ENTIRELY and
   * no amount of downstream ranking recovers it. Two alternatives were considered and rejected:
   * reordering the prefix server-side is impossible because the provider already made the cut, and
   * re-walking per directory to beat truncation would cost thousands of subrequests against a
   * 50-per-invocation budget. The ACCEPTED MITIGATION is disclosure -- `truncated` is persisted on
   * the build-state row and rendered by the dashboard panel as a partial-index indication -- so an
   * operator on a very large repository knows the index is a partial view rather than believing it
   * is complete.
   *
   * Throws on any non-2xx that is NOT a documented degradation, so a real failure is not masked.
   * That includes a provider that reports no default branch at all: both adapters throw rather than
   * guessing a conventional branch name, because indexing a branch the operator did not choose is a
   * worse failure than a loud one.
   *
   * BOTH adapters implement this (NREG-02) and there is deliberately NO capability flag. Neither
   * provider LACKS the capability -- GitHub does it in one recursive call, Bitbucket in a paginated
   * `/src` walk -- so they differ only in COST, which `truncated` plus the adapter-internal page
   * budget already express. A flag here would be a flag no consumer ever branches on, exactly what
   * the `VcsCapabilities` doc comment warns against.
   */
  listDefaultBranchTree(owner: string, repo: string): Promise<VcsTreeListing>;

  /**
   * Repository metadata read narrowed to `mainbranch` (QA-IDX-01, D-08). The `repo:push` webhook
   * branch resolves the repository's main branch through this method — Bitbucket's push payload
   * carries no default-branch field (unlike GitHub's, which carries `default_branch` on the
   * payload), so the Bitbucket route spends one subrequest to learn it.
   *
   * OPTIONAL, following the `labels?` feature-detect pattern: only the Bitbucket adapter implements
   * it today. GitHub's push branch reads the default branch off the payload and has no use for the
   * call, so callers must feature-detect with `provider.getRepositoryMetadata?.(...)` rather than
   * assume it. `mainbranch` may be absent on the response (a repository with no main branch
   * configured) — the caller treats that as "cannot resolve" rather than guessing a conventional
   * branch name, the same discipline `listDefaultBranchTree` throws on.
   */
  getRepositoryMetadata?(owner: string, repo: string): Promise<{ mainbranch?: { name?: string } }>;

  /**
   * ANNO-01: bulk-create-or-replace Code Insights annotations mirroring the findings already
   * posted as inline comments (D-07/D-08 -- exact mirror, no independent selection/cap).
   *
   * OPTIONAL, following the `getRepositoryMetadata?`/`labels?` feature-detect pattern: GitHub has
   * no Code Insights concept (NREG-02 by exclusion) and MUST NOT implement this method -- callers
   * feature-detect with `vcs.postAnnotations?.(...)` (mirroring the `labels?` block's
   * `if (vcs.labels && ...)` convention at `core/review.ts:2797`) rather than assume every
   * provider has it.
   */
  postAnnotations?(
    owner: string,
    repo: string,
    prNumber: number,
    input: VcsPostAnnotationsInput,
  ): Promise<void>;

  /**
   * Resolve the bot's own immutable identity for the comment self-filter (Phase 11, CMD-07). Returns
   * the bot's immutable provider account id (GitHub bot-user numeric id as a string / Bitbucket
   * `account_id`) plus its optional login.
   *
   * Surfaced on the seam so the webhook-ingest dispatch layer (Plan 06) can build a
   * `BotIdentityResolver` from the already-constructed provider WITHOUT reaching into the private
   * underlying client — mirroring how `getUserRepoPermission` was exposed through the adapter. The
   * resolved id is the load-bearing echo-loop defense key (classifyComment self-filters on it before
   * any parse, D-03).
   */
  resolveBotUserIdentity(): Promise<{ accountId: string; login?: string }>;

  /**
   * List unresolved bot threads for a PR (D-05/D-06/D-07). Returns ONLY unresolved root
   * comments authored by the immutable bot identity; the consumer never iterates the comment
   * chain. Path/line range are the head/new-side anchors so Phase 18 can suppress overlapping
   * findings. `ref` is PROVIDER-OPAQUE -- the adapter alone transforms it back to a
   * provider-specific id for `resolveThread`.
   *
   * Always callable on both adapters (D-01); an unsupported op returns `[]` so a consumer that
   * forgets to check `capabilities.supportsThreadListing` still degrades safely. Phase 17
   * leaves the implementation as a neutral stub (PLAN-02-IMPL) -- Plan 17-02 wires the
   * provider GraphQL/REST plumbing.
   */
  getUnresolvedBotThreads(owner: string, repo: string, prNumber: number): Promise<VcsReviewThread[]>;

  /**
   * Resolve a thread by its opaque `ref` (D-05). Returns `true` on a successful resolve,
   * `false` on any failure or unsupported op. Always callable on both adapters (D-01); an
   * unsupported op returns `false` so a consumer that forgets to check
   * `capabilities.supportsThreadResolution` still degrades safely. On Bitbucket this is the
   * observed-downgrade trigger (D-04): the first 403/404/501 flips the backing
   * `supportsThreadResolution` flag to `false`, and subsequent calls short-circuit without
   * making a request. Phase 17 leaves the implementation as a neutral stub (PLAN-02-IMPL) --
   * Plan 17-02 wires the provider GraphQL/REST plumbing.
   */
  resolveThread(owner: string, repo: string, ref: string): Promise<boolean>;

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest>;
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;

  createStatusCheck(owner: string, repo: string, input: VcsCreateStatusCheckInput): Promise<{ ref: string }>;
  /**
   * Update an already-created status check.
   *
   * `ref` is PROVIDER-OPAQUE (REV-M-10): the adapter chooses how to interpret it. GitHub uses
   * numeric check_run_id (as a string); Bitbucket uses report_id string ('codra-review' for
   * both fresh and retry). For Bitbucket the build-status POST always uses key='codra-review'
   * regardless of `ref` -- `ref` is consumed only by the Code Insights PUT path.
   *
   * The implementation contract:
   *   - GitHubAdapter: `Number(ref)` -> numeric check_run_id; forwarded to `updateCheckRun`.
   *   - BitbucketAdapter: `ref` -> the report_id for the Code Insights PUT; build-status POST
   *     uses hardcoded key='codra-review'.
   */
  updateStatusCheck(owner: string, repo: string, ref: string, input: VcsUpdateStatusCheckInput): Promise<void>;

  submitReview(owner: string, repo: string, prNumber: number, input: VcsSubmitReviewInput): Promise<{ ref: string; postedComments?: VcsPostedComment[] }>;
  findExistingReviewForCommit(owner: string, repo: string, prNumber: number, commitSha: string): Promise<{ ref: string } | null>;

  /**
   * Standalone (issue/PR-level) comment primitives. REQUIRED on every adapter (not optional like
   * `labels?`) -- both providers implement them (D-01). No consumer is wired this phase; the
   * methods are inert (D-06). The primitives are thin -- consumers own de-duplication, there is no
   * built-in dedup (D-04).
   *
   * The `ref` is PROVIDER-OPAQUE and self-encoding: the adapter alone interprets it, and a numeric
   * provider id must NEVER cross this seam into `core/` (D-01/D-02). GitHub's ref is the bare
   * comment id; Bitbucket packs the PR id with the comment id (e.g. `${prId}:${commentId}`) so a
   * persisted ref stays fully self-sufficient -- `editPrComment(owner, repo, ref, body)` mirrors
   * `updateStatusCheck(owner, repo, ref, input)` exactly, with NO separate `prNumber` argument (D-02).
   *
   * `editPrComment` returns `null` when the target comment no longer exists -- HTTP 404 OR 410 Gone
   * (amended D-05, review F3) -- identically on both providers, so a consumer re-posts with a plain
   * `if (!result)` branch rather than `try/catch`; any other status throws (existing
   * `GitHubError` / Bitbucket error patterns), and `core/` never inspects a raw HTTP status. Its
   * success return `{ ref }` mirrors the `findExistingReviewForCommit` nullable-return precedent.
   *
   * `listPrComments` author is `{ id, login }`: `id` is the IMMUTABLE provider id (GitHub numeric
   * user id as a string / Bitbucket `account_id`) used for authorization and bot self-filter
   * (NREG-02, Phase 11); `login` is the renameable `@mention` handle (GitHub `login` / Bitbucket
   * `nickname`) (D-03). `author.id` is ALWAYS non-empty -- a comment missing an immutable id is
   * OMITTED from the result rather than surfaced as `''` (review F5), so a consumer can trust it as
   * a self-filter key. The result is a SINGLE oldest-first page (GitHub `per_page=100` / Bitbucket
   * `pagelen=100`); a consumer needing the most-recent comments MUST sort newest-first or paginate
   * (cap + ordering caveat -- review F7).
   */
  createPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<{ ref: string }>;
  editPrComment(owner: string, repo: string, ref: string, body: string): Promise<{ ref: string } | null>;
  listPrComments(owner: string, repo: string, prNumber: number): Promise<Array<{ ref: string; body: string; author: { id: string; login: string } }>>;

  /**
   * Post a provider-native THREADED reply under an existing PR comment (D-01, Phase 12). REQUIRED on
   * every adapter (not optional) -- both providers implement it (NREG-02). No consumer is wired this
   * phase; the method is inert until Part A (Plans 02/03) consumes it.
   *
   * `inReplyToRef` is the PROVIDER-OPAQUE ref of the ORIGINATING comment, exactly as carried on
   * `CommentContext.commentRef` -- the adapter alone interprets it, and a numeric provider id must
   * NEVER cross this seam into `core/` (mirrors the createPrComment/editPrComment contract above).
   *
   * Provider threading semantics differ, so the CALLER (not this method) decides threadability via
   * the payload `threadable` flag:
   *   - GitHubAdapter: threads ONLY an inline review comment via `in_reply_to` on
   *     POST /pulls/{n}/comments. A top-level ISSUE comment is NOT threadable on GitHub, so the
   *     caller falls back to `createPrComment` for those; `inReplyToRef` is the bare comment id.
   *   - BitbucketAdapter: threads BOTH general and inline comments via `parent:{id}` on
   *     POST /pullrequests/{n}/comments; `inReplyToRef` is the self-encoding `${prId}:${commentId}`.
   *
   * A malformed `inReplyToRef` is rejected BEFORE any HTTP request (GitHub canonical
   * positive-integer regex + Number.isSafeInteger; Bitbucket parsePrCommentRef, which also rejects a
   * ref whose encoded prId != the target prNumber). Returns the NEW comment's opaque `{ ref }`.
   */
  replyToPrComment(owner: string, repo: string, prNumber: number, body: string, inReplyToRef: string): Promise<{ ref: string }>;

  /**
   * Resolve an actor's effective permission on a repo for command authorization (CMD-08, D-06/D-07).
   *
   * `authorId` is the IMMUTABLE provider id (GitHub numeric user id as a string / Bitbucket
   * `account_id`) — authorization is ALWAYS decided on `authorId`, NEVER on a renameable username
   * (NREG-02). `authorLogin` is OPTIONAL and used ONLY to form the provider URL where the endpoint
   * needs a username in the path (GitHub `GET .../collaborators/{login}/permission`); the response's
   * immutable id is then re-verified against `authorId`.
   *
   * Returns the mapped union on success, or `null` on ANY resolution failure (403/404/network, a
   * login/id mismatch, or — on Bitbucket — the frequent case where a repository access token cannot
   * query permissions at all, A1). A `null` return means "could not resolve" so the caller fails
   * CLOSED: only a resolved 'admin'/'write' authorizes a state-changing command; 'read'/'none'/null
   * are unauthorized and silently ignored (D-07).
   *
   * NOTE (Bitbucket, A1): on Bitbucket this is a BEST-EFFORT diagnostic only — the AUTHORITATIVE
   * Bitbucket authorization is the per-repo allow-list of immutable account_ids evaluated in Plan 03
   * `authorizeActor` (config.review.interactive.commands.bitbucket_allowed_account_ids). A Bitbucket
   * `null` here means "defer to the allow-list", not "deny"; membership is NEVER mapped to 'write'.
   */
  getUserRepoPermission(
    owner: string,
    repo: string,
    authorId: string,
    authorLogin?: string,
  ): Promise<'admin' | 'write' | 'read' | 'none' | null>;

  /**
   * Fetch the details of an inline PR review comment by its provider-opaque ref (LRN-01, D-01).
   * Returns the comment's file path, line number, and body text, or null if the comment doesn't
   * exist (404), was deleted, or is not an inline comment (no `inline` object on Bitbucket, no
   * `path` on GitHub issue comments).
   *
   * Used by the reject handler to resolve finding metadata at reject time: the `finding_ref` in
   * `reject_feedback` is the provider's comment id, and this method translates it to the
   * (path, line, body) triple needed to join against `review_comments`.
   *
   * `commentRef` is PROVIDER-OPAQUE — the adapter alone interprets it. GitHub uses the bare
   * numeric `pull_request_review_comment.id`; Bitbucket uses the comment id from the PR comments
   * endpoint.
   *
   * COORDINATE SYSTEMS ARE NOT INTERCHANGEABLE ACROSS PROVIDERS (G-28-3). GitHub anchors an inline
   * comment by its diff `position` — `core/github.ts createReview` posts `{ path, position, body }`
   * and never sends `line`, and the `line` GitHub reports back is re-derived from that position
   * against the CURRENT diff, so it drifts from the line Codra persisted. Bitbucket has no diff
   * offset at all: it anchors by `inline.to ?? inline.from`, i.e. a LINE, on both the post and the
   * read path, and therefore reports `position: null`.
   *
   * Consequence for consumers: select the coordinate PER PROVIDER (GitHub -> `position`,
   * Bitbucket -> `line`) rather than assuming `line` is comparable across providers. Matching a
   * GitHub comment on `line` is the exact defect G-28-3 documents.
   *
   * Error handling: returns null on 404/deleted/comment-not-found (never throws for missing
   * comments). Throws on auth errors, 5xx, or network failures so the caller can distinguish
   * "comment doesn't exist" from "provider is down".
   */
  getInlineCommentDetails(
    owner: string,
    repo: string,
    prNumber: number,
    commentRef: string,
  ): Promise<{ path: string; line: number | null; position: number | null; body: string } | null>;

  labels?: {
    ensure(owner: string, repo: string, name: string, color: string): Promise<void>;
    add(owner: string, repo: string, prNumber: number, labels: string[]): Promise<void>;
    removeIfPresent(owner: string, repo: string, prNumber: number, labels: string[]): Promise<void>;
  };
}
