import { vi } from 'vitest';

export type RecordedGitHubCall = {
  method: string;
  path: string;
  search: string;
  accept: string | null;
  body: any;
};

export type ReviewResponseScript = Array<{ status: number; id?: number }>;

/**
 * Body for any of the new mock fixtures (content/compare). `body` is whatever the adapter
 * expects to decode — a JSON object for `/contents`, a raw string for `/compare`.
 */
export type BitbucketLikeMockResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Scripted status sequence for successive PATCH /issues/comments/{id} calls (the edit-comment
 * path). Mirrors the reviewResponses precedent: a spec can script 404 and 410 (both map to the
 * D-05 null path -- review F3) as well as a non-gone status like 403/422 (which must still THROW
 * -- review F9). Defaults to a single 200.
 */
export type CommentEditResponseScript = Array<{ status: number; id?: number }>;

/** A single issue-comment list fixture, mirroring GitHub's issue-comment shape. `user` may be
 * null so a spec can prove listPrComments OMITS a comment with no immutable author id (review F5). */
export type IssueCommentFixture = {
  id: number;
  body: string;
  user: { id: number; login: string } | null;
};

export type GitHubFetchMockFixtures = {
  owner: string;
  repo: string;
  prNumber: number;
  pull: {
    number: number;
    title: string | null;
    body: string | null;
    draft: boolean;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    user: { login: string };
  };
  diff: string;
  /** Scripted status sequence for successive POST .../reviews calls. Defaults to a single 200. */
  reviewResponses?: ReviewResponseScript;
  /** Comment id the POST /issues/{n}/comments route returns (and the PATCH default id). */
  commentId?: number;
  /** Comment id the net-new POST /pulls/{n}/comments (review-comment reply) route returns.
   * Defaults DISTINCT from commentId so a spec can assert the reply ref is the reply's own id,
   * not the originating comment's id (Phase 12, D-01). */
  replyCommentId?: number;
  /** Numeric user id the POST/GET comment routes attach as user.id (distinct from login so a
   * spec can assert author.id derives from the immutable numeric id, not the login -- NREG-02). */
  commentUserId?: number;
  /** Login the POST/GET comment routes attach as user.login. */
  commentUserLogin?: string;
  /** Body the default GET comment fixture carries. */
  commentBody?: string;
  /** Full single-page list the GET /issues/{n}/comments route returns. When omitted it defaults
   * to a one-item list built from commentId/commentBody/commentUserId/commentUserLogin. A spec
   * seeds a user-less entry here to exercise the missing-author omission path (review F5). */
  commentListItems?: IssueCommentFixture[];
  /** Scripted status sequence for successive PATCH /issues/comments/{id} calls (review F3/F9). */
  commentEditResponses?: CommentEditResponseScript;
  /**
   * Response for GET /repos/{owner}/{repo}/collaborators/{login}/permission (CMD-08). `status`
   * defaults to 200; `permission` to 'write'; `userId`/`userLogin` populate the returned
   * `user` object so a spec can prove the adapter re-verifies the immutable id (id-mismatch → null).
   */
  permissionResponse?: { status?: number; permission?: string; userId?: number; userLogin?: string };
  /**
   * Response for GET /repos/{owner}/{repo}/contents/{path}?ref={ref} (PROV-01, D-08). `status`
   * defaults to 200; when `body` is provided as `{ content, encoding }` the route returns it
   * verbatim so a spec can verify base64 decoding. Use `status: 404` to exercise the null path.
   */
  contentResponses?: BitbucketLikeMockResponse;
  /**
   * Response for GET /repos/{owner}/{repo}/compare/{base}...{head} with the
   * `application/vnd.github.diff` media type (PROV-01, D-09). `status` defaults to 200; `body`
   * is returned as raw text. Use `status: 200, body: ''` to exercise the empty-success path.
   */
  compareResponses?: BitbucketLikeMockResponse;
  /**
   * Response for POST /graphql (PROV-02). Two flows are used by the fixtures:
   *   - `threadListResponses`: a scripted sequence of bodies for successive `ListReviewThreads`
   *     queries — each entry becomes one `{ data, errors? }` envelope sent verbatim, with the
   *     last entry reused for any additional pages. Empty default returns `{ data: { repository:
   *     { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }}}}}}}`.
   *   - `resolveReviewThreadResponse`: a single response body used by every `ResolveReviewThread`
   *     mutation (default is the success envelope).
   *   - `threadListNonRetriable`: when true, return the body with `status: 502` so the real
   *     client surfaces the failure as a `GitHubError` rather than a GraphQL envelope.
   */
  threadListResponses?: Array<{ data?: unknown; errors?: unknown }>;
  resolveReviewThreadResponse?: { status?: number; data?: unknown; errors?: unknown };
  threadListNonRetriable?: boolean;
  /**
   * Numeric user id the bot-identity GET /users/{login} route returns. Defaults to 99999 so
   * thread fixtures with `author.databaseId: GH_BOT_USER_ID (99999)` pass the immutable-id filter.
   */
  botUserId?: number;
  /**
   * Response for GET /repos/{owner}/{repo}/pulls/comments/{id} (LRN-01, G-28-3). `status` defaults
   * to 200. `position` is GitHub's DIFF OFFSET — the coordinate `createReview` posts by — and is
   * surfaced separately from `line` because the two diverge in practice. Use `status: 404` to
   * exercise the deleted-comment branch (the client maps 404 to null).
   *
   * When this fixture is OMITTED the route is not registered at all and the request falls through
   * to the terminal 404, so every other spec's behavior is byte-identical.
   */
  reviewCommentResponse?: {
    status?: number;
    path?: string;
    line?: number | null;
    position?: number | null;
    body?: string;
  };
  /**
   * Response for GET /repos/{owner}/{repo} (QA-IDX-01, D-09) -- the repository read that resolves
   * the default branch. `status` defaults to 200. Supply `body: {}` to exercise the
   * no-default-branch throw, or `{ master_branch: 'master' }` to exercise the legacy alias.
   *
   * Registered ONLY when supplied, so every pre-existing spec falls through to the terminal 404
   * exactly as before (NREG-01).
   */
  repositoryResponse?: {
    status?: number;
    body?: { default_branch?: string; master_branch?: string };
  };
  /**
   * Response for GET /repos/{owner}/{repo}/branches/{branch} (QA-IDX-01, D-12) -- the branch read
   * that resolves the head COMMIT sha (the trees endpoint only echoes a TREE sha). `status` defaults
   * to 200. Supply `body: {}` to exercise the missing-commit-sha throw, or `status: 404` for the
   * no-such-branch path.
   *
   * Registered ONLY when supplied (NREG-01).
   */
  branchResponse?: {
    status?: number;
    body?: { commit?: { sha?: string } };
  };
  /**
   * Response for GET /repos/{owner}/{repo}/git/trees/{treeIsh}?recursive=1 (QA-IDX-01, D-09).
   * `status` defaults to 200. `truncated` flows straight through to the listing, and `tree` entries
   * carry the real `type` discriminator so a spec can prove directories ('tree') and submodules
   * ('commit') are dropped.
   *
   * Registered ONLY when supplied (NREG-01).
   */
  treeResponse?: {
    status?: number;
    sha?: string;
    truncated?: boolean;
    tree?: Array<{ path: string; type: 'blob' | 'tree' | 'commit'; sha?: string; size?: number }>;
  };
};

/**
 * Stubs global fetch so the real GitHubClient (core/github.ts) can run end-to-end
 * against a fake api.github.com. Every response is terminal (2xx/404/422) so
 * GitHubClient's retry/backoff logic never triggers a real-time sleep.
 */
export function installGitHubFetchMock(fixtures: GitHubFetchMockFixtures) {
  const calls: RecordedGitHubCall[] = [];
  const originalFetch = globalThis.fetch;
  const repoPrefix = `/repos/${fixtures.owner}/${fixtures.repo}`;
  const reviewsListPath = `${repoPrefix}/pulls/${fixtures.prNumber}/reviews`;
  const reviewResponses = fixtures.reviewResponses ?? [{ status: 200, id: 5150 }];
  let reviewCallIndex = 0;

  // Issue-comment fixtures (net-new routes). Defaults are chosen so commentUserId != any login
  // string, letting the adapter spec prove author.id comes from the immutable numeric user id.
  const commentId = fixtures.commentId ?? 8001;
  const replyCommentId = fixtures.replyCommentId ?? 8002;
  const commentUserId = fixtures.commentUserId ?? 424242;
  const commentUserLogin = fixtures.commentUserLogin ?? 'commenter-login';
  const commentBody = fixtures.commentBody ?? 'existing comment body';
  const commentListItems: IssueCommentFixture[] =
    fixtures.commentListItems ?? [
      { id: commentId, body: commentBody, user: { id: commentUserId, login: commentUserLogin } },
    ];
  const commentEditResponses = fixtures.commentEditResponses ?? [{ status: 200 }];
  let commentEditCallIndex = 0;

  // PROV-02 bot identity: `resolveBotUserIdentity` (CMD-07) hits `GET /users/{botLogin}`. The
  // thread filter (D-07) keys on the immutable numeric id the endpoint returns, so test
  // fixtures seed a specific value here so author.databaseId from /graphql compares equal.
  // Defaults to GH_BOT_USER_ID (99999) which matches the test fixture default.
  const botUserId = fixtures.botUserId ?? 99999;
  // PROV-02: GraphQL scripted responses. `threadListResponses` is consumed sequentially so a
  // fixture can drive a two-page traversal; the final entry is reused for any later pages. The
  // mutation response is a single body because each call returns fresh from the same fixture.
  const threadListResponses = fixtures.threadListResponses ?? [
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ];
  let threadListCallIndex = 0;
  const resolveReviewThreadFixture = fixtures.resolveReviewThreadResponse ?? {};

  const existingLabels = new Map<string, string>();
  const issueLabels = new Set<string>();

  async function handler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);

    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const accept = headers.get('Accept');
    let body: any = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    // Record BOTH the path's pathname (so existing pathname-only matchers keep working) AND the
    // search query (so PROV-01 specs can assert the `?ref=` query on `/contents`).
    calls.push({ method, path: url.pathname, search: url.search, accept, body });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    const text = (data: string, status = 200, extraHeaders: Record<string, string> = {}) =>
      new Response(data, { status, headers: { 'content-type': 'text/plain', ...extraHeaders } });

    // --- PROV-01: GET /compare/{base}...{head} (D-09) ---
    // Match the canonical path; the compare accept hdr is `application/vnd.github.diff`. Order
    // matters: this route must be checked BEFORE the getPullRequest `pathname === pulls/N` branch
    // since `/compare/...` shares the prefix but never matches the bare pull endpoint.
    if (method === 'GET' && url.pathname.includes('/compare/')) {
      const fixture = fixtures.compareResponses ?? { status: 200, body: fixtures.diff };
      const status = fixture.status ?? 200;
      const headers = new Headers(fixture.headers ?? {});
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
      if (typeof fixture.body === 'string') {
        return new Response(fixture.body, { status, headers });
      }
      return new Response(JSON.stringify(fixture.body), { status, headers });
    }

    // --- QA-IDX-01: GET /repos/{owner}/{repo} and GET .../git/trees/{treeIsh}?recursive=1 (D-09) ---
    // Both are registered ONLY when their fixture is supplied so every other spec's route table is
    // byte-identical. The tree route matches the literal `/git/trees/` segment, which cannot collide
    // with any existing route.
    if (method === 'GET' && fixtures.repositoryResponse && url.pathname === repoPrefix) {
      const fixture = fixtures.repositoryResponse;
      const status = fixture.status ?? 200;
      if (status >= 400) {
        return json({ message: `Repository read error ${status}` }, status);
      }
      return json(fixture.body ?? {}, status);
    }

    if (method === 'GET' && fixtures.branchResponse && url.pathname.startsWith(`${repoPrefix}/branches/`)) {
      const fixture = fixtures.branchResponse;
      const status = fixture.status ?? 200;
      if (status >= 400) {
        return json({ message: `Branch read error ${status}` }, status);
      }
      return json(fixture.body ?? { commit: { sha: 'commitsha000000000' } }, status);
    }

    if (method === 'GET' && fixtures.treeResponse && url.pathname.startsWith(`${repoPrefix}/git/trees/`)) {
      const fixture = fixtures.treeResponse;
      const status = fixture.status ?? 200;
      if (status >= 400) {
        return json({ message: `Tree read error ${status}` }, status);
      }
      return json(
        {
          sha: fixture.sha ?? 'treesha0000000000',
          truncated: fixture.truncated ?? false,
          tree: fixture.tree ?? [],
        },
        status,
      );
    }

    if (method === 'GET' && url.pathname === `${repoPrefix}/pulls/${fixtures.prNumber}`) {
      if (accept === 'application/vnd.github.v3.diff') {
        return text(fixtures.diff, 200);
      }
      return json(fixtures.pull);
    }

    if (method === 'POST' && url.pathname === `${repoPrefix}/check-runs`) {
      return json({ id: 9001 }, 201);
    }

    if (method === 'PATCH' && /\/check-runs\/\d+$/.test(url.pathname)) {
      return json({});
    }

    if (method === 'GET' && url.pathname === reviewsListPath) {
      // findBotReviewForCommit's existing-review lookup (only hit when a finalize retries past
      // the posting step). No prior review exists in these fixtures.
      return json([]);
    }

    if (method === 'POST' && url.pathname === reviewsListPath) {
      const script = reviewResponses[Math.min(reviewCallIndex, reviewResponses.length - 1)];
      reviewCallIndex += 1;
      if (script.status >= 400) {
        return json({ message: 'Unprocessable Entity' }, script.status);
      }
      return json({ id: script.id ?? 5150 }, script.status);
    }

    // --- PROV-01: GET /contents/{path}?ref={ref} (D-08) ---
    // Match the contents path (any sub-path, with optional ?ref=). Status 404 maps to a null
    // text body; 200 returns the supplied fixture body so a spec can verify base64 decoding.
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/contents\//.test(url.pathname)) {
      const fixture = fixtures.contentResponses ?? {
        status: 200,
        body: { content: Buffer.from('default content').toString('base64'), encoding: 'base64' },
      };
      const status = fixture.status ?? 200;
      if (status === 404) {
        return json({ message: 'Not Found' }, 404);
      }
      if (status >= 400) {
        return json({ message: `Contents error ${status}` }, status);
      }
      return json(fixture.body, status);
    }

    // --- Issue-comment routes (net-new, additive; NREG-01) ---
    // POST create: returns the new comment id plus the authoring user { id, login }.
    if (method === 'POST' && url.pathname === `${repoPrefix}/issues/${fixtures.prNumber}/comments`) {
      return json({ id: commentId, user: { id: commentUserId, login: commentUserLogin } }, 201);
    }

    // POST review-comment reply (net-new, Phase 12 D-01): threads a reply via in_reply_to on the
    // PULLS comments route (distinct from the ISSUES comments route above). Returns the reply's own
    // id + authoring user, mirroring the issue-comment POST shape. Without this handler the shared
    // mock 404s this route (:below), so the reply adapter test cannot exercise the endpoint (Codex MEDIUM).
    if (method === 'POST' && url.pathname === `${repoPrefix}/pulls/${fixtures.prNumber}/comments`) {
      return json({ id: replyCommentId, user: { id: commentUserId, login: commentUserLogin } }, 201);
    }

    // GET single review comment by id (LRN-01, G-28-3). Matches the LITERAL `comments` segment so it
    // can never shadow `pulls/{prNumber}` (exact-equality match above) or `pulls/{prNumber}/reviews`
    // (exact-equality match above), and it is GET-only so the POST reply route above is untouched.
    // Registered ONLY when the fixture is supplied; otherwise the request falls through to the
    // terminal 404 and every pre-existing spec behaves byte-identically (NREG-01).
    if (
      method === 'GET' &&
      fixtures.reviewCommentResponse &&
      url.pathname.startsWith(`${repoPrefix}/pulls/comments/`) &&
      /\/pulls\/comments\/\d+$/.test(url.pathname)
    ) {
      const fixture = fixtures.reviewCommentResponse;
      const status = fixture.status ?? 200;
      if (status === 404) {
        return json({ message: 'Not Found' }, 404);
      }
      if (status >= 400) {
        return json({ message: `Review comment fetch error ${status}` }, status);
      }
      return json(
        {
          path: fixture.path ?? 'src/example.ts',
          line: fixture.line ?? null,
          position: fixture.position ?? null,
          body: fixture.body ?? 'default review comment body',
        },
        status,
      );
    }

    // GET list: single-page fixture. commentListItems may include a user-less entry so a spec can
    // prove listPrComments OMITS comments with no immutable author id (review F5).
    if (method === 'GET' && url.pathname === `${repoPrefix}/issues/${fixtures.prNumber}/comments`) {
      return json(commentListItems);
    }

    // PATCH edit-by-id: scriptable status (404/410 -> null path; 403/422 -> throw). The recorded
    // call (calls.push above) exposes the PATCH body so a spec can assert it is exactly { body }.
    if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(url.pathname)) {
      const script = commentEditResponses[Math.min(commentEditCallIndex, commentEditResponses.length - 1)];
      commentEditCallIndex += 1;
      if (script.status >= 400) {
        return json({ message: 'Comment edit error' }, script.status);
      }
      return json({ id: script.id ?? commentId }, script.status);
    }

    // GET collaborators/{login}/permission (CMD-08). Returns the effective permission plus the
    // immutable user.id so the adapter can re-verify it against authorId.
    if (method === 'GET' && /\/collaborators\/[^/]+\/permission$/.test(url.pathname)) {
      const pr = fixtures.permissionResponse ?? {};
      const status = pr.status ?? 200;
      if (status >= 400) {
        return json({ message: 'permission lookup error' }, status);
      }
      return json(
        {
          permission: pr.permission ?? 'write',
          user: { id: pr.userId ?? 424242, login: pr.userLogin ?? 'author-login' },
        },
        200,
      );
    }

    // POST /graphql (PROV-02). Two operations are surfaced: ListReviewThreads (query) and
    // ResolveReviewThread (mutation). The handler chooses a scripted body per operation name
    // (`ListReviewThreads` selects from `threadListResponses`; `ResolveReviewThread` uses
    // `resolveReviewThreadResponse`). When `threadListNonRetriable` is set the response is a
    // 5xx body so the real client's retry path surfaces a `GitHubError` rather than swallowing.
    if (method === 'POST' && url.pathname === '/graphql') {
      const payload = (init?.body ? JSON.parse(String(init.body)) : {}) as { query?: string; variables?: Record<string, unknown> };
      const queryName = /query\s+(\w+)/.exec(payload.query ?? '')?.[1] ?? '';
      const mutationName = /mutation\s+(\w+)/.exec(payload.query ?? '')?.[1] ?? '';

      if (mutationName === 'ResolveReviewThread') {
        const status = resolveReviewThreadFixture.status ?? 200;
        if (status >= 400) {
          return json({ message: 'GitHub resolve mutation failed' }, status);
        }
        const body = resolveReviewThreadFixture.errors
          ? { errors: resolveReviewThreadFixture.errors }
          : {
              data: resolveReviewThreadFixture.data ?? {
                resolveReviewThread: {
                  thread: { id: payload.variables?.threadId ?? 'PRRT_unknown', isResolved: true },
                },
              },
            };
        return json(body, status);
      }

      if (queryName === 'ListReviewThreads') {
        const idx = Math.min(threadListCallIndex, threadListResponses.length - 1);
        threadListCallIndex += 1;
        const scripted = threadListResponses[idx];
        if (fixtures.threadListNonRetriable) {
          return json({ message: 'GitHub thread list 502' }, 502);
        }
        if (scripted.errors) {
          return json({ data: scripted.data ?? null, errors: scripted.errors }, 200);
        }
        return json({ data: scripted.data ?? {}, errors: scripted.errors }, 200);
      }

      // Unknown query/mutation: respond with a 200 + errors envelope so the caller can decide.
      return json({ errors: [{ message: `Unhandled mock GraphQL operation: ${queryName || mutationName || '<anonymous>'}` }] }, 200);
    }

    const labelLookup = new RegExp(`^${repoPrefix}/labels/([^/]+)$`).exec(url.pathname);
    if (method === 'GET' && labelLookup) {
      const name = decodeURIComponent(labelLookup[1]);
      return existingLabels.has(name) ? json({ name }) : json({ message: 'Not Found' }, 404);
    }

    if (method === 'POST' && url.pathname === `${repoPrefix}/labels`) {
      existingLabels.set(body.name, body.color);
      return json({ name: body.name, color: body.color }, 201);
    }

    if (method === 'GET' && url.pathname === `${repoPrefix}/issues/${fixtures.prNumber}/labels`) {
      return json(Array.from(issueLabels, (name) => ({ name })));
    }

    if (method === 'POST' && url.pathname === `${repoPrefix}/issues/${fixtures.prNumber}/labels`) {
      for (const name of body?.labels ?? []) issueLabels.add(name);
      return json([]);
    }

    const labelRemoval = new RegExp(`^${repoPrefix}/issues/${fixtures.prNumber}/labels/([^/]+)$`).exec(url.pathname);
    if (method === 'DELETE' && labelRemoval) {
      issueLabels.delete(decodeURIComponent(labelRemoval[1]));
      return json([]);
    }

    // GET /users/{login} (CMD-07). Returns the bot identity used by resolveBotUserIdentity.
    if (method === 'GET' && /^\/users\/[^/]+$/.test(url.pathname)) {
      const login = decodeURIComponent(url.pathname.replace(/^\/users\//, ''));
      return json({ id: botUserId, login });
    }

    return json({ message: `Unhandled mock GitHub route: ${method} ${url.pathname}` }, 404);
  }

  vi.stubGlobal('fetch', handler);

  return {
    calls,
    restore() {
      vi.stubGlobal('fetch', originalFetch);
    },
  };
}
