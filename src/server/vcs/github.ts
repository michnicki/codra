import { GitHubService } from '../services/github';
import type { AppBindings } from '../env';
import type {
  VcsCapabilities,
  VcsCreateStatusCheckInput,
  VcsProvider,
  VcsPullRequest,
  VcsReviewThread,
  VcsSubmitReviewInput,
  VcsUpdateStatusCheckInput,
} from './types';

/**
 * Wraps the existing, unchanged `GitHubService` behind the provider-agnostic `VcsProvider`
 * interface. Delegation ONLY -- no new REST logic.
 *
 * Imports `GitHubService` (NOT `GitHubClient`) from '../services/github' -- this exact module
 * path is load-bearing (Pitfall 3, review finding 5): three of the six protected specs
 * (review-flow, async-batch-review, review-subrequest-completion) `vi.mock('@server/services/github')`
 * and need the adapter to construct `GitHubService` through that module for the mock to keep
 * intercepting; pr-review-pipeline runs the REAL `GitHubClient` via `installGitHubFetchMock` and
 * stays green because the `GitHubService` -> `GitHubClient` delegation is unchanged.
 */
export class GithubAdapter implements VcsProvider {
  readonly name = 'github' as const;
  // GitHub renders Mermaid fenced code blocks in markdown, so the walkthrough formatter may emit a
  // Mermaid diagram for GitHub PRs (D-09). Required member on VcsProvider; inert this phase.
  // GitHub's GraphQL `reviewThreads` and `resolveReviewThread` are always available with the
  // installation token (D-03/D-04), so the two thread flags are static-true (R-2); Plan 17-02
  // wires the GraphQL plumbing behind these neutral stubs.
  readonly capabilities: VcsCapabilities = {
    supportsMermaid: true,
    supportsThreadListing: true,
    supportsThreadResolution: true,
  };
  private gh: GitHubService;
  // PROV-02 (R-9): retain the construction-time tracker so we can forward it into the
  // thread-listing call path. Mirrors BitbucketAdapter's `TrackerLike` shape widened to
  // include `hasRemainingSafeBudget`; the incrementSubrequests half is required by the existing
  // `GitHubService` constructor (transitively forwarded into the client).
  private readonly tracker?: { incrementSubrequests(count?: number): void; hasRemainingSafeBudget?(needed?: number): boolean };

  constructor(
    private env: AppBindings,
    installationId: string,
    tracker?: { incrementSubrequests(count?: number): void; hasRemainingSafeBudget?(needed?: number): boolean },
  ) {
    // tracker MUST be forwarded -- it's an optional param on GitHubService's constructor, so
    // dropping it is silent: the subrequest budget regresses with no compile error (Pitfall 1).
    this.gh = new GitHubService(env, installationId, tracker);
    this.tracker = tracker;
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    const pr = await this.gh.getPullRequest(owner, repo, prNumber);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      authorLogin: pr.user?.login ?? null,
    };
  }

  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    return this.gh.getPullRequestDiff(owner, repo, prNumber);
  }

  // PROV-01 (D-08): content primitive. Delegates to GitHubService which forwards to the
  // ref-aware `getRepoFileOrNull` (Task 2). 404 -> null; non-2xx -> GitHubError.
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    return this.gh.getRepoFileContent(owner, repo, path, ref);
  }

  // PROV-01 (D-09): compare-diff primitive. Delegates to GitHubService.getCompareDiff which
  // sends `/compare/{base}...{head}` with `application/vnd.github.diff` (Task 2). Empty success
  // passes through as `''`; non-2xx throws GitHubError.
  async getCompareDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    return this.gh.getCompareDiff(owner, repo, base, head);
  }

  // PROV-02 (D-05/D-06/D-07): unresolved-bot-thread listing. Pulls every page from the GraphQL
  // `reviewThreads` connection, filters to UNRESOLVED root comments authored by the immutable bot
  // id, and projects to the canonical 6-field `VcsReviewThread` shape. Any GraphQL/transport
  // failure is caught and converted to `[]` (D-02) — no seam log, no audit emission.
  async getUnresolvedBotThreads(owner: string, repo: string, prNumber: number): Promise<VcsReviewThread[]> {
    try {
      const botIdentity = await this.gh.resolveBotUserIdentity();
      const botAccountId = botIdentity.accountId;
      // PROV-02 (R-9): forward the construction-time tracker so the client's per-page
      // `hasRemainingSafeBudget` consult gates pagination at the boundary. The tracker shape
      // accepted by the client is `hasRemainingSafeBudget?(needed?: number): boolean`; the
      // adapter's `tracker` is wider (includes `incrementSubrequests` for the underlying
      // REST path) so the structural narrow is intentional.
      const rawThreads = await this.gh.getReviewThreads(owner, repo, prNumber, this.tracker);
      const out: VcsReviewThread[] = [];
      for (const rawThread of rawThreads) {
        const thread = rawThread as {
          id?: unknown;
          path?: unknown;
          line?: unknown;
          startLine?: unknown;
          originalLine?: unknown;
          originalStartLine?: unknown;
          isResolved?: unknown;
          isOutdated?: unknown;
          comments?: { nodes?: Array<unknown> };
        };
        // ID + path + bot filter first (cheapest rejections). Use `thread.comments.nodes[0]`
        // (NEVER the unscoped `nodes[0]`) per review concern 13.
        const rootCandidate = thread.comments?.nodes?.[0] as undefined | {
          body?: unknown;
          replyTo?: { id?: unknown } | null;
          author?: { databaseId?: unknown; __typename?: unknown } | null;
        };
        if (!rootCandidate) continue;
        // D-06 + R-4 / R-7: thread root MUST be a true root (not a reply), unresolved, and bot-authored.
        if (rootCandidate.replyTo !== null && rootCandidate.replyTo !== undefined) continue;
        if (thread.isResolved === true) continue;
        if (typeof thread.id !== 'string' || thread.id.length === 0) continue;
        if (typeof thread.path !== 'string' || thread.path.length === 0) continue;
        const body = typeof rootCandidate.body === 'string' ? rootCandidate.body : '';
        if (body.length === 0) continue;
        const authorId = rootCandidate.author?.databaseId;
        if (authorId === undefined || authorId === null) continue;
        if (String(authorId) !== botAccountId) continue;

        // R-3: current/original fallback for line range. Outdated threads still emit a numeric
        // fallback (Phase 18 ignores outdated=true, so we never fabricate zero ranges).
        const currentLine = typeof thread.line === 'number' ? thread.line : null;
        const originalLine = typeof thread.originalLine === 'number' ? thread.originalLine : null;
        const startLine = typeof thread.startLine === 'number' ? thread.startLine : null;
        const originalStartLine = typeof thread.originalStartLine === 'number' ? thread.originalStartLine : null;

        let lineStart: number;
        let lineEnd: number;
        if (currentLine !== null) {
          lineEnd = currentLine;
          // Prefer startLine (range start); fall back to line when only a single anchor is set.
          lineStart = startLine !== null && startLine <= currentLine ? startLine : currentLine;
        } else if (originalLine !== null) {
          // Outdated fallback only: R-3 says surface original anchors when current is null.
          lineEnd = originalLine;
          lineStart = originalStartLine !== null && originalStartLine <= originalLine ? originalStartLine : originalLine;
        } else {
          // Truly no anchor available — skip rather than fabricate zero lines (R-3 / review F4).
          continue;
        }
        if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) continue;
        if (lineStart <= 0 || lineEnd <= 0 || lineStart > lineEnd) continue;

        out.push({
          ref: thread.id,
          path: thread.path,
          lineStart,
          lineEnd,
          rootBody: body,
          outdated: thread.isOutdated === true,
        });
      }
      return out;
    } catch {
      // D-02: silent neutral degradation — no log, no audit, no throw. Phase 18/19 emit the
      // audit event with proper context.
      return [];
    }
  }

  // PROV-02 (D-04): resolve a thread. The opaque `ref` MUST be the GitHub GraphQL thread node id;
  // reject empty / whitespace / control-character / overlong refs BEFORE any HTTP request so a
  // malformed/forgeable id cannot reach the wire (T-17-02-01, R-7). On any transport or
  // envelope failure return `false` (D-02) while leaving the static capability flag untouched
  // (D-04: GitHub is static-true, observed-downgrade is Bitbucket-only).
  async resolveThread(_owner: string, _repo: string, ref: string): Promise<boolean> {
    void _owner; void _repo;
    if (!isValidGraphQlThreadRef(ref)) {
      throw new Error(`resolveThread received a malformed ref: ${JSON.stringify(ref)}`);
    }
    try {
      await this.gh.resolveReviewThread(ref);
      return true;
    } catch {
      return false;
    }
  }

  async createStatusCheck(
    owner: string,
    repo: string,
    input: VcsCreateStatusCheckInput,
  ): Promise<{ ref: string }> {
    const { id } = await this.gh.createCheckRun(owner, repo, {
      headSha: input.headSha,
      title: input.title,
      summary: input.summary,
    });
    // Validate the id at the adapter boundary before stringifying (WR-04). `createCheckRun`
    // casts its response with an unchecked `as { id: number }`, so a body without a numeric `id`
    // (API change, error envelope that still parsed) would otherwise produce `String(undefined)`
    // -> "undefined" -> `Number("undefined")` -> NaN written into check_run_id at the call site.
    // `typeof NaN === 'number'`, so a NaN slips past a bare typeof check and stringifies to "NaN";
    // require a finite number to catch that too. Fail loudly at the seam instead.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createCheckRun returned a non-numeric id for ${owner}/${repo}: ${String(id)}`);
    }
    // id -> ref at the adapter boundary (D-02); the numeric column stays canonical.
    return { ref: String(id) };
  }

  async updateStatusCheck(
    owner: string,
    repo: string,
    ref: string,
    input: VcsUpdateStatusCheckInput,
  ): Promise<void> {
    // ref -> id at the adapter boundary (D-02). Mirror the create-side WR-04 guard: a corrupt
    // check_run_id (e.g. the round-trip of a prior "undefined"/"NaN" stringify) would make
    // `Number(ref)` NaN and build a `/check-runs/NaN` request. Reject non-finite refs at the seam.
    const checkRunId = Number(ref);
    if (!Number.isFinite(checkRunId)) {
      throw new Error(`updateStatusCheck received a non-numeric ref for ${owner}/${repo}: ${String(ref)}`);
    }
    await this.gh.updateCheckRun(owner, repo, checkRunId, {
      title: input.title,
      summary: input.summary,
      status: input.status,
      conclusion: input.conclusion,
    });
  }

  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    input: VcsSubmitReviewInput,
  ): Promise<{ ref: string }> {
    // Relocated toReviewEvent (formerly services/formatter.ts:6-8).
    // REV-M-5: `jobIdHint` is intentionally IGNORED here -- the GitHub submitReview flow composes
    // a single createReview POST that does not embed the job id in its body. The field exists on
    // VcsSubmitReviewInput so the Bitbucket adapter (REV-R-A) can use it for its combined
    // marker+summary comment. Reference it once so the linter doesn't flag an unused parameter.
    void input.jobIdHint;
    const event = input.verdict === 'approve' ? ('APPROVE' as const) : ('COMMENT' as const);
    const { id } = await this.gh.createReview(owner, repo, prNumber, {
      commitSha: input.commitSha,
      event,
      body: input.summaryBody,
      comments: input.comments,
    });
    // Mirror the createStatusCheck WR-04 guard: `createReview` casts its body with an unchecked
    // `as { id: number }`, so a non-numeric/NaN id would otherwise stringify into a corrupt ref.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createReview returned a non-numeric id for ${owner}/${repo}#${prNumber}: ${String(id)}`);
    }
    return { ref: String(id) };
  }

  async findExistingReviewForCommit(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
  ): Promise<{ ref: string } | null> {
    // The interface omits botLogin; the adapter injects env.BOT_USERNAME internally (Pitfall 5).
    const found = await this.gh.findBotReviewForCommit(owner, repo, prNumber, commitSha, this.env.BOT_USERNAME);
    return found ? { ref: String(found.id) } : null;
  }

  async createPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ ref: string }> {
    const { id } = await this.gh.createIssueComment(owner, repo, prNumber, body);
    // WR-04 finite-guard copied from submitReview (:123-125): createIssueComment casts its body
    // with an unchecked `as { id: number }`, so a non-numeric/NaN id would otherwise stringify into
    // a corrupt ref. Fail loudly at the seam.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createIssueComment returned a non-numeric id for ${owner}/${repo}#${prNumber}: ${String(id)}`);
    }
    // GitHub ref is the bare comment id (D-02).
    return { ref: String(id) };
  }

  async editPrComment(
    owner: string,
    repo: string,
    ref: string,
    body: string,
  ): Promise<{ ref: string } | null> {
    // Validate the ref STRICTLY (review F4): Number.isFinite(Number(ref)) is too weak -- it accepts
    // '', '  ', '1.5', '1e3', '-1', '0'. Require a canonical positive safe-integer string (no leading
    // zeros, no sign, no decimal/exponent, no whitespace, > 0) BEFORE any request. No prNumber arg (D-02).
    if (!/^[1-9][0-9]*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new Error(`editPrComment received a malformed ref for ${owner}/${repo}: ${JSON.stringify(ref)}`);
    }
    const commentId = Number(ref);
    const result = await this.gh.updateIssueComment(owner, repo, commentId, body);
    // null flows straight through from the client for both 404 and 410 (amended D-05 / review F3);
    // the adapter never inspects a raw HTTP status.
    // WR-01: echo the already-validated input ref instead of re-deriving from `result.id`.
    // `updateIssueComment` casts its body with an unchecked `as { id: number }`, so a malformed/absent
    // id would otherwise stringify into a corrupt ref ("undefined"/"NaN") that gets persisted and
    // breaks the next edit. `ref` was validated as a canonical positive safe-integer above; echoing
    // it matches the Bitbucket sibling and needs no extra guard.
    return result ? { ref } : null;
  }

  async replyToPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    inReplyToRef: string,
  ): Promise<{ ref: string }> {
    // Validate the opaque ref STRICTLY before any request (T-12-01-1/T-12-01-2): the canonical
    // positive safe-integer guard copied from editPrComment (:166). Rejects '', whitespace, decimals,
    // exponent, sign, leading zeros, zero. inReplyToRef is the ORIGINATING comment's bare id (D-01).
    if (!/^[1-9][0-9]*$/.test(inReplyToRef) || !Number.isSafeInteger(Number(inReplyToRef))) {
      throw new Error(`replyToPrComment received a malformed inReplyToRef for ${owner}/${repo}#${prNumber}: ${JSON.stringify(inReplyToRef)}`);
    }
    const commentId = Number(inReplyToRef);
    const { id } = await this.gh.createReviewCommentReply(owner, repo, prNumber, body, commentId);
    // WR-04 finite-guard (mirrors createPrComment :150): createReviewCommentReply casts its body with
    // an unchecked `as { id: number }`, so a non-numeric/NaN id would stringify into a corrupt ref.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createReviewCommentReply returned a non-numeric id for ${owner}/${repo}#${prNumber}: ${String(id)}`);
    }
    // GitHub ref is the bare comment id of the new reply (D-02).
    return { ref: String(id) };
  }

  async listPrComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ ref: string; body: string; author: { id: string; login: string } }>> {
    const items = await this.gh.listIssueComments(owner, repo, prNumber);
    const results: Array<{ ref: string; body: string; author: { id: string; login: string } }> = [];
    for (const c of items) {
      // OMIT any comment whose author identity is missing/invalid (review F5): a false '' /
      // 'undefined' id would defeat the Phase 11 self-filter, which requires a non-null immutable id
      // (core/bot-identity.ts:105-108). Skip rather than emit a forgeable empty id.
      if (!c.user || typeof c.user.id !== 'number' || !Number.isFinite(c.user.id)) {
        continue;
      }
      // IN-01: guard c.id the same way as author.id -- the list is an unchecked `as`-cast, so a
      // non-numeric/NaN comment id would stringify into a corrupt ref. Skip such rows.
      if (typeof c.id !== 'number' || !Number.isFinite(c.id)) {
        continue;
      }
      // author.id is String(c.user.id), the immutable numeric user id, never login (NREG-02, D-03).
      // login is best-effort (only author.id is load-bearing); default to '' so it is never
      // undefined, matching the Bitbucket sibling's `?? ''` normalization (IN-01).
      results.push({ ref: String(c.id), body: c.body, author: { id: String(c.user.id), login: c.user.login ?? '' } });
    }
    return results;
  }

  async getInlineCommentDetails(
    owner: string,
    repo: string,
    prNumber: number,
    commentRef: string,
  ): Promise<{ path: string; line: number | null; position: number | null; body: string } | null> {
    // `position` is GitHub's DIFF OFFSET — the coordinate createReview posts by — and flows through
    // this adapter unchanged; do not remap or drop it (G-28-3).
    void prNumber; // GitHub's GET /pulls/comments/{id} doesn't need the PR number.
    const commentId = Number(commentRef);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      return null;
    }
    return this.gh.getReviewComment(owner, repo, commentId);
  }

  async getUserRepoPermission(
    owner: string,
    repo: string,
    authorId: string,
    authorLogin?: string,
  ): Promise<'admin' | 'write' | 'read' | 'none' | null> {
    // authorLogin forms the GitHub URL (the endpoint needs a username in the path); without it we
    // cannot query, so fail closed. authorId is what we AUTHORIZE on (NREG-02) — never the login.
    if (!authorLogin) {
      return null;
    }
    const result = await this.gh.getUserRepoPermission(owner, repo, authorLogin);
    if (!result) {
      return null;
    }
    // Re-verify the IMMUTABLE id (review: all-3 HIGH/MED): a login can be reassigned between capture
    // and check, so the endpoint's resolved user.id MUST equal the authorId we were asked to
    // authorize. A mismatch (or an unparseable/absent id) fails closed to null.
    const expectedId = Number(authorId);
    if (!Number.isFinite(expectedId) || result.userId === null || result.userId !== expectedId) {
      return null;
    }
    switch (result.permission) {
      case 'admin':
      case 'write':
      case 'read':
      case 'none':
        return result.permission;
      default:
        // An unrecognized permission string fails closed rather than being treated as authorized.
        return null;
    }
  }

  // Phase 11 (CMD-07): resolve the bot's own immutable identity so the Plan 06 dispatch layer can
  // build a self-filter resolver from this provider. Delegates to the unchanged GitHubService seam.
  async resolveBotUserIdentity(): Promise<{ accountId: string; login?: string }> {
    return this.gh.resolveBotUserIdentity();
  }

  labels = {
    ensure: (owner: string, repo: string, name: string, color: string) =>
      this.gh.ensureLabel(owner, repo, name, color),
    add: (owner: string, repo: string, prNumber: number, labels: string[]) =>
      this.gh.addIssueLabels(owner, repo, prNumber, labels),
    removeIfPresent: (owner: string, repo: string, prNumber: number, labels: string[]) =>
      this.gh.removeIssueLabelsIfPresent(owner, repo, prNumber, labels),
  };
}

// Maximum length of a GitHub GraphQL node id. The opaque id is base64 over the type+databaseId
// pair, never assuming a specific alphabet; 256 bytes is generous headroom for any future schema.
// Anything longer than this is either a typo or a forging attempt and must be rejected at the seam.
const MAX_GITHUB_THREAD_REF_LEN = 256;

/**
 * Strict opaque-ref validator for GitHub GraphQL thread node ids (R-7, T-17-02-01).
 *
 * Rejects (BEFORE any HTTP request):
 *   - empty / whitespace-only strings
 *   - any control character (U+0000..U+001F, U+007F)
 *   - refs longer than `MAX_GITHUB_THREAD_REF_LEN` (forging / typos)
 *
 * Does NOT enforce a `PRRT_` prefix or specific alphabet — the GraphQL id is opaque base64 over
 * `{type}:{databaseId}` and the schema could change. This guard is intentionally permissive
 * about content but strict about shape: it ensures a malformed value cannot reach the wire, while
 * leaving future schema changes non-breaking.
 */
export function isValidGraphQlThreadRef(ref: string): boolean {
  if (typeof ref !== 'string') return false;
  if (ref.length === 0 || ref.length > MAX_GITHUB_THREAD_REF_LEN) return false;
  if (/\s/.test(ref)) return false;
  if (/[ -]/.test(ref)) return false;
  return true;
}
