import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import type {
  CodeInsightsReport,
  CommitBuildStatus,
  PrComment,
} from '@shared/bitbucket';
import type { VcsPullRequest } from '@server/vcs/types';
import type { BotIdentityResolver } from '@server/core/bot-identity';

// BB-01 deliberately mirrors the hand-rolled GitHub client: Workers-native fetch keeps the REST
// surface small and avoids an SDK. The methods below own Bitbucket-specific mappings for PR fields,
// comment anchors (REV-M-2), Code Insights/build status (D-10/D-11), and baseSha (REV-M-7).
const BITBUCKET_API_BASE_URL = 'https://api.bitbucket.org/2.0';
// Match GitHub's 30-second request cap so a single external call cannot consume a Worker invocation.
const BITBUCKET_TIMEOUT_MS = 30_000;

export class BitbucketError extends Error {
  constructor(
    public readonly status: number,
    // This raw response may contain provider detail. Pass the Error object through the structured
    // logger so its redaction policy applies; never log `body` directly (T-05-06).
    public readonly body: string,
    public readonly path: string,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BitbucketError';
  }

  // Structured logging and JSON.stringify(err) must never serialize the raw response `body`, which
  // can carry provider credentials or sensitive detail (T-05-06). `body` stays available to retry
  // logic internally; only its serialized form is suppressed here.
  toJSON() {
    return {
      name: this.name,
      status: this.status,
      path: this.path,
      message: this.message,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

function retryAfterMs(response: Response) {
  const rawValue = response.headers.get('retry-after');
  if (!rawValue) {
    return undefined;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(rawValue);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt += 1;
      const isRetryable =
        (error instanceof BitbucketError && (error.status === 429 || error.status >= 500)) ||
        error?.name === 'TimeoutError' ||
        String(error?.message ?? '').toLowerCase().includes('timeout');

      if (!isRetryable || attempt > maxRetries) {
        throw error;
      }

      const delay = error instanceof BitbucketError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : Math.pow(2, attempt) * 1000;
      logger.warn(`Retrying Bitbucket operation ${operation} (attempt ${attempt}/${maxRetries}) in ${delay}ms`, {
        status: error instanceof BitbucketError ? error.status : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

type BitbucketPullRequestRecord = {
  id: number;
  title?: string | null;
  description?: string | null;
  draft?: boolean;
  source: {
    branch?: { name?: string | null };
    commit: { hash: string };
  };
  destination: {
    branch?: { name?: string | null };
    commit: { hash: string };
  };
  author?: { username?: string | null; display_name?: string | null };
};

type BitbucketCommentRecord = {
  id: number;
  content?: { raw?: string };
  inline?: {
    path: string;
    to?: number;
    from?: number;
    // PROV-02 (R-4): start_to and start_from are explicit new-side/old-side range starts. Absent
    // fields are treated as undefined -- we never FABRICATE a value (D-05). Optional here so the
    // existing `inline` mapping stays byte-compatible with submitReview's dedup step (NREG-01).
    start_to?: number;
    start_from?: number;
  };
  // PROV-02 (R-4): `parent` distinguishes a root comment (parent == null) from a reply. `deleted`
  // indicates a soft-deleted comment that must be filtered out. `resolution` is the OpenAPI's
  // resolve-state object whose absence/null means unresolved. All three are OPTIONAL -- absent
  // fields are treated as undefined (NREG-01 byte-compat).
  parent?: { id?: number } | null;
  deleted?: boolean;
  resolution?: { user?: { account_id?: string }; created_on?: string } | null;
  // Additive author block (Phase 8). `account_id` is the IMMUTABLE provider id used as the author
  // self-filter key (NREG-02); `nickname` is the renameable @mention handle. Bitbucket comment
  // authors have NO `username` field (removed from the API in 2019) — never read it (Pitfall 4).
  user?: { account_id?: string; nickname?: string; display_name?: string };
};

function repositoryPath(workspace: string, repoSlug: string) {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

export class BitbucketClient {
  constructor(
    private readonly env: Pick<AppBindings, 'BOT_USERNAME'>,
    private readonly token: string,
    private readonly tracker?: { incrementSubrequests(count?: number): void },
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/json',
  ): Promise<Response> {
    return withRetry(`${method} ${path}`, async () => {
      this.tracker?.incrementSubrequests(1);
      const response = await withTimeout(`Bitbucket ${method} ${path}`, BITBUCKET_TIMEOUT_MS, (signal) =>
        globalThis.fetch(`${BITBUCKET_API_BASE_URL}${path}`, {
          method,
          signal,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.token}`,
            'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new BitbucketError(
          response.status,
          errorBody,
          path,
          `Bitbucket API ${method} ${path} failed with ${response.status}`,
          retryAfterMs(response),
        );
      }

      return response;
    });
  }

  async getPullRequest(workspace: string, repoSlug: string, prNumber: number): Promise<VcsPullRequest> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}`;
    const response = await this.request('GET', path);
    const pullRequest = (await response.json()) as BitbucketPullRequestRecord;

    return {
      number: pullRequest.id,
      title: pullRequest.title ?? null,
      body: pullRequest.description ?? null,
      draft: pullRequest.draft ?? false,
      headSha: pullRequest.source.commit.hash,
      headRef: pullRequest.source.branch?.name ?? null,
      baseSha: pullRequest.destination.commit.hash,
      baseRef: pullRequest.destination.branch?.name ?? null,
      authorLogin: pullRequest.author?.username ?? pullRequest.author?.display_name ?? null,
    };
  }

  async getPullRequestDiff(workspace: string, repoSlug: string, prNumber: number): Promise<string> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/diff?context=3`;
    const response = await this.request('GET', path, undefined, 'text/plain');
    return response.text();
  }

  // PROV-01 (D-08): raw file content via /src/{ref}/{path}. The ref is preserved case (Bitbucket
  // branch / tag names are case-sensitive), and the path is encoded segment-by-segment so slash
  // delimiters survive (`encodeURIComponent` on the whole path would lose them). 404 -> null
  // (D-08 delete-at-head); any other non-2xx throws BitbucketError.
  async getFileContent(workspace: string, repoSlug: string, ref: string, path: string): Promise<string | null> {
    const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    const apiPath = `${repositoryPath(workspace, repoSlug)}/src/${encodeURIComponent(ref)}/${encodedPath}`;
    try {
      const response = await this.request('GET', apiPath, undefined, 'text/plain');
      return response.text();
    } catch (error) {
      if (error instanceof BitbucketError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // PROV-01 (D-09): compare-diff primitive. Bitbucket's diff spec is REVERSED relative to the
  // seam's `(base, head)` convention: the first spec operand is the SOURCE commit (changes to
  // preview) and the second is the DESTINATION (the state to compare against). The seam's
  // `base` parameter is the destination, `head` is the source of new changes -- so the spec
  // becomes `HEAD..BASE` (R-5). `context=3` matches the existing PR-diff call; `topic=true`
  // is sent explicitly so a future default change cannot silently alter the response shape.
  async getCompareDiff(workspace: string, repoSlug: string, base: string, head: string): Promise<string> {
    const spec = `${encodeURIComponent(head)}..${encodeURIComponent(base)}`;
    const path = `${repositoryPath(workspace, repoSlug)}/diff/${spec}?context=3&topic=true`;
    const response = await this.request('GET', path, undefined, 'text/plain');
    return response.text();
  }

  /**
   * PROV-02 (R-4): RAWS multi-page walk of the comments endpoint. Distinct from
   * `listPullRequestComments` (which projects to the byte-compatible dedup/listing shape used by
   * submitReview). The raw shape here PRESERVES the OpenAPI fields a thread filter needs
   * (`deleted`, `parent`, `resolution`, and nested `inline.start_to`/`inline.start_from`) so the
   * adapter can build its filter without losing information. Pages are followed ONLY when the
   * server-supplied `next` URL passes the SSRF guard (T-17-02-03 / R-9). On bound exhaustion OR
   * later-page failure the client THROWS (so the adapter can convert to `[]` rather than
   * returning partial comments -- D-01/D-02).
   *
   * `MAX_THREAD_LIST_PAGES = 10` is a TUNED EMPIRICAL CAP, intentionally identical to the
   * GitHub cap (R-9). 100 comments per page x 10 pages = 1000 comments, well above any realistic
   * PR. Going higher risks the Workers 50/invocation cap; going lower risks silently dropping
   * legitimate bot threads on the largest PRs.
   */
  static readonly MAX_THREAD_LIST_PAGES = 10;

  async listRawPullRequestComments(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    tracker?: { hasRemainingSafeBudget?(needed?: number): boolean },
  ): Promise<BitbucketCommentRecord[]> {
    const maxPages = BitbucketClient.MAX_THREAD_LIST_PAGES;
    const collected: BitbucketCommentRecord[] = [];
    const seenNextUrls = new Set<string>();
    let nextUrl: string | null = `${BITBUCKET_API_BASE_URL}${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments?pagelen=100`;
    for (let page = 0; page < maxPages; page += 1) {
      // R-9: cap before issuing the next request using the live tracker (optional / 1 unit).
      if (tracker?.hasRemainingSafeBudget && !tracker.hasRemainingSafeBudget(1)) {
        throw new BitbucketError(
          503,
          `Bitbucket thread pagination exceeded safe subrequest budget on page ${page + 1}/${maxPages}`,
          '/pullrequests/{n}/comments',
          `Bitbucket thread list aborted: safe subrequest budget exhausted at page ${page + 1}`,
        );
      }
      // SSRF guard (T-17-02-03 / R-9): the client strictly trusts the FIRST page's URL (built
      // locally) and treats any `next` URL from the response payload as UNTRUSTED. Validate the
      // origin is the Bitbucket API host AND the path stays under `/2.0/` before following.
      if (!isValidBitbucketNextUrl(nextUrl, seenNextUrls)) {
        throw new BitbucketError(
          502,
          `Bitbucket next-link did not pass origin/path validation`,
          '/pullrequests/{n}/comments',
          `Bitbucket pagination next URL failed SSRF validation`,
        );
      }
      // Fetch directly with the absolute URL (NOT request(), which would re-prefix the base).
      // Use the same auth + timeout patterns as `request()`.
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
      };
      this.tracker?.incrementSubrequests(1);
      const response = await withTimeout(`Bitbucket GET ${new URL(nextUrl).pathname}`, BITBUCKET_TIMEOUT_MS, (signal) =>
        globalThis.fetch(nextUrl as string, { method: 'GET', signal, headers }),
      );
      if (!response.ok) {
        const errorBody = await response.text();
        throw new BitbucketError(
          response.status,
          errorBody,
          new URL(nextUrl).pathname,
          `Bitbucket API GET ${new URL(nextUrl).pathname} failed with ${response.status}`,
          retryAfterMs(response),
        );
      }
      const body = (await response.json()) as { values?: BitbucketCommentRecord[]; next?: string | null };
      for (const v of body.values ?? []) collected.push(v);
      if (!body.next) return collected;
      seenNextUrls.add(nextUrl);
      nextUrl = body.next;
    }
    // Cap reached while `body.next` was still populated -- FAIL CLOSED (D-01/D-02).
    throw new BitbucketError(
      503,
      `Bitbucket thread pagination exceeded MAX_THREAD_LIST_PAGES (${maxPages}); aborting partial traversal`,
      '/pullrequests/{n}/comments',
      `Bitbucket thread list exceeded MAX_THREAD_LIST_PAGES=${maxPages}`,
    );
  }

  /**
   * PROV-02 (D-04 / R-1): POST /comments/{comment_id}/resolve. The narrow path here INTENTIONALLY
   * bypasses `withRetry` via `requestNoRetry` so a 500/501 produces exactly ONE request -- a retry
   * loop would mask the resolution-downgrade signal the adapter needs (Pitfall 2). The caller
   * sees the raw status and decides whether to downgrade `supportsThreadResolution`.
   */
  async resolvePullRequestCommentThread(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    commentId: number,
  ): Promise<number> {
    return this.resolvePullRequestCommentThreadStatus(workspace, repoSlug, prNumber, commentId);
  }

  async resolvePullRequestCommentThreadStatus(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    commentId: number,
  ): Promise<number> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments/${commentId}/resolve`;
    this.tracker?.incrementSubrequests(1);
    const response = await withTimeout(`Bitbucket POST ${path}`, BITBUCKET_TIMEOUT_MS, (signal) =>
      globalThis.fetch(`${BITBUCKET_API_BASE_URL}${path}`, {
        method: 'POST',
        signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
        },
      }),
    );
    return response.status;
  }

  async listPullRequestComments(workspace: string, repoSlug: string, prNumber: number, pagelen = 100) {
    // SINGLE page, pagelen=100, OLDEST-first (Bitbucket's default order). A consumer needing the
    // most-recent comments must sort newest-first or paginate — the primitive does not (cap +
    // ordering caveat, review F7). Do NOT change the query/pagelen: it is shared with submitReview's
    // dedup (buildDedupIndex) and findExistingReviewForCommit, so any change here is a regression
    // (NREG-01).
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments?pagelen=${pagelen}`;
    const response = await this.request('GET', path);
    const page = (await response.json()) as { values?: BitbucketCommentRecord[] };

    return (page.values ?? []).map((comment) => ({
      // id, body, inline stay byte-identical — submitReview dedup depends on this exact shape
      // (Pitfall 2, NREG-01). `author` is purely ADDITIVE.
      id: comment.id,
      body: comment.content?.raw ?? '',
      inline: comment.inline,
      // author.id is `string | undefined` — a comment missing an immutable account_id must NOT be
      // minted as '' here (a false identity would defeat the Phase 11 self-filter, review F5). The
      // drop-missing-author policy lives in the ADAPTER (vcs/bitbucket.ts), not this shared client
      // method, so submitReview dedup still sees every comment. author.id = account_id (immutable,
      // NREG-02); login = nickname (@mention handle), never username (removed from the API).
      author: {
        id: comment.user?.account_id as string | undefined,
        login: comment.user?.nickname ?? comment.user?.display_name ?? '',
      },
    }));
  }

  async postPullRequestComment(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    comment: PrComment,
  ): Promise<{ id: number }> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments`;
    // `line_type` is Codra's internal classification. Bitbucket's OpenAPI accepts only path and
    // to/from on the wire: removed lines anchor with `from`, while added/context lines use `to`.
    // Marker and summary comments carry content only and intentionally omit the inline object.
    const body = 'line_type' in comment
      ? {
          content: { raw: comment.content.raw },
          inline: comment.line_type === 'removed'
            ? { path: comment.path, from: comment.line }
            : { path: comment.path, to: comment.line },
        }
      : { content: { raw: comment.content.raw } };
    const response = await this.request('POST', path, body);
    return (await response.json()) as { id: number };
  }

  // Net-new threaded reply (Phase 12, D-01). Mirrors postPullRequestComment's content-only branch
  // but attaches `parent:{id}` so Bitbucket threads the reply under the originating comment. The
  // payload local is named `requestBody` (NOT `body`) because `body` is already the string parameter
  // in this scope — a second `const body` would be a compile-time redeclaration (review: Codex MEDIUM).
  async replyToPullRequestComment(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments`;
    const requestBody = { content: { raw: body }, parent: { id: commentId } };
    const response = await this.request('POST', path, requestBody);
    return (await response.json()) as { id: number };
  }

  async editPullRequestComment(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    commentId: number,
    raw: string,
  ): Promise<{ id: number } | null> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments/${commentId}`;
    try {
      // Confirmed against the Atlassian OpenAPI: PUT with body { content: { raw } }.
      const response = await this.request('PUT', path, { content: { raw } });
      return (await response.json()) as { id: number };
    } catch (e) {
      // A gone comment surfaces as 404 OR 410 (amended D-05, review F3). Map both to null INSIDE the
      // client so the adapter maps null->null uniformly and never inspects a raw HTTP status (D-05).
      // Any OTHER status (e.g. 403/422) rethrows.
      if (e instanceof BitbucketError && (e.status === 404 || e.status === 410)) {
        return null;
      }
      throw e;
    }
  }

  // Phase 28 (LRN-01): fetch a single pull request comment by id. Returns the comment record
  // including inline path/line and content, or null on 404 (deleted comment). Uses the same
  // error-handling pattern as editPullRequestComment: catches BitbucketError 404/410 → null,
  // rethrows any other error.
  async getPullRequestComment(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    commentId: number,
  ): Promise<BitbucketCommentRecord | null> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments/${commentId}`;
    try {
      const response = await this.request('GET', path);
      return (await response.json()) as BitbucketCommentRecord;
    } catch (e) {
      if (e instanceof BitbucketError && (e.status === 404 || e.status === 410)) {
        return null;
      }
      throw e;
    }
  }

  async approvePullRequest(workspace: string, repoSlug: string, prNumber: number): Promise<void> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/approve`;
    await this.request('POST', path);
  }

  async upsertCodeInsightsReport(
    workspace: string,
    repoSlug: string,
    commit: string,
    report: CodeInsightsReport,
  ): Promise<void> {
    const path = `${repositoryPath(workspace, repoSlug)}/commit/${encodeURIComponent(commit)}/reports/codra-review`;
    await this.request('PUT', path, report);
  }

  async postCommitBuildStatus(
    workspace: string,
    repoSlug: string,
    commit: string,
    status: CommitBuildStatus,
  ): Promise<void> {
    const path = `${repositoryPath(workspace, repoSlug)}/commit/${encodeURIComponent(commit)}/statuses/build`;
    await this.request('POST', path, status);
  }

  // --- Command-authorization + bot-identity primitives (Phase 11, CMD-07/CMD-08) ---

  /**
   * BEST-EFFORT per-user repository permission read (A1). Bitbucket authorization is PRIMARILY the
   * per-repo allow-list of immutable account_ids evaluated in Plan 03 `authorizeActor`
   * (config.review.interactive.commands.bitbucket_allowed_account_ids) — a deterministic gate that
   * needs no special token scope. This method is a diagnostic enhancement only.
   *
   * Atlassian **repository access tokens cannot query this endpoint at all** — it 403s (NOT merely a
   * missing scope). So this returns `null` on ANY failure (403/404/network) and a `null` return
   * means "defer to the allow-list", never "authorize". It keys STRICTLY on the immutable
   * `account_id` (NREG-02, never a nickname) and NEVER maps workspace membership to 'write'
   * (membership ≠ write access). A 403 is logged distinctly so the landmine stays diagnosable.
   */
  async getUserRepoPermission(
    workspace: string,
    repoSlug: string,
    accountId: string,
  ): Promise<'admin' | 'write' | 'read' | null> {
    // Defense-in-depth (IN-02): real Atlassian account_ids are opaque quote-free tokens. Reject any
    // value carrying a `"` or control character before interpolating it into the BBQL quoted string,
    // so it can never alter the server-side query parse. Fail closed (null = defer to the allow-list).
    if (/["\u0000-\u001f]/.test(accountId)) {
      logger.warn(
        `Bitbucket permission read skipped for ${workspace}/${repoSlug}: account_id contains invalid characters; deferring to the allow-list`,
      );
      return null;
    }
    const path =
      `/workspaces/${encodeURIComponent(workspace)}/permissions/repositories/${encodeURIComponent(repoSlug)}` +
      `?q=${encodeURIComponent(`user.account_id="${accountId}"`)}`;
    try {
      const response = await this.request('GET', path);
      const page = (await response.json()) as {
        values?: Array<{ permission?: string; user?: { account_id?: string } }>;
      };
      // Match STRICTLY on the immutable account_id (NREG-02) — never trust list order or a nickname.
      const match = (page.values ?? []).find((entry) => entry.user?.account_id === accountId);
      if (!match || !match.permission) {
        return null;
      }
      switch (match.permission) {
        case 'admin':
          return 'admin';
        case 'write':
          return 'write';
        case 'read':
          return 'read';
        default:
          // NEVER map anything else (e.g. a workspace-membership flavor) to write — fail closed.
          return null;
      }
    } catch (error) {
      if (error instanceof BitbucketError && error.status === 403) {
        // The A1 landmine: repository access tokens cannot query permissions. Log distinctly so the
        // best-effort path is diagnosable; the allow-list (Plan 03) is the authoritative gate.
        logger.warn(
          `Bitbucket permission read forbidden (403) for ${workspace}/${repoSlug} — repository access tokens cannot query permissions (A1); deferring to the account_id allow-list`,
        );
      } else {
        logger.warn(
          `Bitbucket permission read failed for ${workspace}/${repoSlug}; returning null (fail-closed)`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return null;
    }
  }

  /**
   * Resolve the bot's OWN Bitbucket identity via `GET /2.0/user` (CMD-07). `account_id` is the
   * IMMUTABLE id the self-filter echo-loop defense keys on (D-03); `nickname` is the renameable
   * @mention handle used only as `login`. Throws if `/user` returns no account_id (the caller then
   * leaves accountId null and command processing self-disables).
   */
  async resolveBotUserIdentity(): Promise<{ accountId: string; login?: string }> {
    const response = await this.request('GET', '/user');
    const data = (await response.json()) as {
      account_id?: string;
      nickname?: string;
      username?: string;
      display_name?: string | null;
    };
    if (!data.account_id) {
      throw new Error('Bitbucket /2.0/user did not return an account_id');
    }
    return {
      accountId: data.account_id,
      login: data.nickname ?? data.username ?? data.display_name ?? undefined,
    };
  }
}

/**
 * BotIdentityResolver for Bitbucket (CMD-07). Wraps `BitbucketClient.resolveBotUserIdentity()` so
 * `getBotIdentity(env, 'bitbucket', resolver, { workspace, repo })` can populate a NON-NULL
 * immutable account_id on a cold cache. Because Bitbucket tokens are PER-REPO, the caller MUST scope
 * the cache key per repository (see core/bot-identity.ts).
 */
export function createBitbucketBotIdentityResolver(
  client: Pick<BitbucketClient, 'resolveBotUserIdentity'>,
  // CMD-07 (Layer 2): the admin-configured immutable bot account_id. When supplied, the resolver
  // returns it WITHOUT calling the client. Optional so the signature stays backward-compatible.
  configuredAccountId?: string | null,
): BotIdentityResolver {
  return {
    resolveIdentity() {
      if (configuredAccountId) {
        // A Repository Access Token 403s on `GET /2.0/user`, so a configured immutable account_id
        // avoids that call entirely. Leave `login` undefined so getBotIdentity fills it from
        // BOT_USERNAME (the mutable @mention handle); the self-filter keys on this immutable id only.
        return Promise.resolve({ accountId: configuredAccountId });
      }
      // No configured id: fall back to live discovery (unchanged). Layer 1 now catches any 403/throw
      // in getBotIdentity → fail-closed accountId null.
      return client.resolveBotUserIdentity();
    },
  };
}

/**
 * PROV-02 SSRF guard (T-17-02-03 / R-9): a Bitbucket pagination `next` URL must point at the
 * Bitbucket Cloud API origin over HTTPS AND live under `/2.0/`. Returns false when either the
 * origin/path guard fails or the URL has already been seen (cycle defense).
 */
export function isValidBitbucketNextUrl(url: string | null, seen: Set<string>): boolean {
  if (!url) return false;
  if (seen.has(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== 'api.bitbucket.org') return false;
  if (!parsed.pathname.startsWith('/2.0/')) return false;
  return true;
}
