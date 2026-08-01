import { vi } from 'vitest';

export type RecordedBitbucketCall = {
  url: string;
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
};

export type BitbucketMockResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

type ResponseFactory = (
  call: RecordedBitbucketCall,
) => BitbucketMockResponse | Response | Promise<BitbucketMockResponse | Response>;

export type BitbucketFetchMockOptions = {
  getPullRequestResponses?: BitbucketMockResponse[];
  getPullRequestDiffResponse?: BitbucketMockResponse;
  listPullRequestCommentsResponse?: BitbucketMockResponse;
  postPullRequestCommentResponses?: BitbucketMockResponse[];
  approvePullRequestResponse?: BitbucketMockResponse;
  upsertCodeInsightsReportResponse?: BitbucketMockResponse;
  postCommitBuildStatusResponse?: BitbucketMockResponse;
  /**
   * Phase 30 (ANNO-01): response for DELETE .../commit/{commit}/reports/{reportId} (any reportId).
   * Defaults to a 204. Use `status: 404` to exercise the round-1-no-prior-report swallow path.
   */
  deleteCodeInsightsReportResponse?: BitbucketMockResponse;
  /**
   * Phase 30 (ANNO-01): response for POST .../commit/{commit}/reports/{reportId}/annotations.
   * Defaults to a 200 with an empty array body.
   */
  bulkUpsertAnnotationsResponse?: BitbucketMockResponse;
  responseSequence?: Array<BitbucketMockResponse | Response | ResponseFactory>;
  /**
   * Response for GET /repositories/{workspace}/{repo}/src/{ref}/{path} (PROV-01, D-08).
   * `status` defaults to 200; `body` is returned as raw text. Use `status: 404` to exercise
   * the null path.
   */
  fileContentResponses?: BitbucketMockResponse;
  /**
   * Response for GET /repositories/{workspace}/{repo}/diff/{spec}?context=3&topic=true
   * (PROV-01, D-09). `status` defaults to 200; `body` is returned as raw text. Use
   * `status: 200, body: ''` to exercise the empty-success path.
   */
  compareDiffResponses?: BitbucketMockResponse;
  /**
   * PROV-02: scripted list of raw pull-request comment pages for `listRawPullRequestComments`.
   * Each entry becomes one `values[]` page; the LAST entry's missing `next` signals end-of-pages.
   * Earlier entries that supply `next` cause the client to follow the link (validated against
   * the SSRF guard, so use absolute HTTPS api.bitbucket.org URLs only). Empty default falls back
   * to the single default fixture.
   */
  rawCommentPageResponses?: BitbucketMockResponse[];
  /**
   * PROV-02 (D-04): scripted status sequence for successive POST /resolve calls. Default is a
   * single 200 (success). 403/404/501 flips `supportsThreadResolution` to false on the adapter;
   * 500/other returns false WITHOUT flipping the capability.
   */
  resolveCommentStatuses?: Array<{ status: number }>;
  /**
   * PROV-02 (D-07): when true, `/user` (resolveBotUserIdentity) returns 403 to simulate a
   * Repository Access Token. Use to verify the configured bot id SHORT-CIRCUITS that call.
   */
  blockResolveBotUserIdentity?: boolean;
  /**
   * PRD-04 (FR-114): response for GET /repositories/{workspace}/{repo}/commits/{ref}?path=...
   * (per-touched-file commit history). `status` defaults to 200; `body` carries
   * `{ values: [{ hash, message }] }` — Bitbucket's commit-list endpoint omits the file
   * manifest. Registered ONLY when supplied, so every other spec's route table is
   * byte-identical (NREG-01).
   */
  fileHistoryResponses?: BitbucketMockResponse;
};

// Concrete author fixtures for the comment-primitive specs (review F6). Three DISTINCT string
// values so a test can prove author.id maps from account_id and NOT the nickname/display_name
// (NREG-02). BITBUCKET_FIXTURE_EDIT_COMMENT_ID is the id the default PUT edit route echoes back.
export const BITBUCKET_FIXTURE_ACCOUNT_ID = '557058:alice-account-id';
export const BITBUCKET_FIXTURE_NICKNAME = 'alice';
export const BITBUCKET_FIXTURE_DISPLAY_NAME = 'Alice Example';
export const BITBUCKET_FIXTURE_EDIT_COMMENT_ID = 8;

const defaultPullRequest = {
  id: 42,
  title: 'Add Bitbucket support',
  description: 'Review Bitbucket pull requests.',
  draft: false,
  source: {
    branch: { name: 'feature/bitbucket' },
    commit: { hash: 'head123' },
  },
  destination: {
    branch: { name: 'main' },
    commit: { hash: 'base123' },
  },
  author: { username: 'alice' },
  state: 'OPEN',
};

// The Fetch spec forbids a body on a null-body status (the WHATWG "null body status" list:
// 101/103/204/205/304) -- the Response constructor throws if one is supplied. Phase 30's
// deleteCodeInsightsReportResponse default (`{ status: 204 }`) exercises this path for the first
// time in this shared helper (Rule 1 fix, scoped to toResponse only).
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function toResponse(spec: BitbucketMockResponse) {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers);

  if (NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status, headers });
  }

  const body = spec.body ?? {};

  if (typeof body === 'string') {
    return new Response(body, { status, headers });
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Stubs only api.bitbucket.org so the real BitbucketClient can be exercised end-to-end without
 * network traffic. Scripted responses make retry behavior observable while terminal defaults keep
 * endpoint tests fast and deterministic.
 */
export function installBitbucketFetchMock(options: BitbucketFetchMockOptions = {}) {
  const calls: RecordedBitbucketCall[] = [];
  const originalFetch = globalThis.fetch;
  const responseSequence = [...(options.responseSequence ?? [])];
  const getPullRequestResponses = [...(options.getPullRequestResponses ?? [])];
  const postPullRequestCommentResponses = [...(options.postPullRequestCommentResponses ?? [])];
  const rawCommentPageResponses = [...(options.rawCommentPageResponses ?? [])];
  const resolveCommentStatuses = [...(options.resolveCommentStatuses ?? [{ status: 200 }])];

  async function handler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname !== 'api.bitbucket.org' || !url.pathname.startsWith('/2.0/')) {
      throw new Error(`Unexpected non-Bitbucket fetch in test: ${rawUrl}`);
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const call = {
      url: url.toString(),
      method,
      path: `${url.pathname}${url.search}`,
      authorization: headers.get('Authorization'),
      body,
    };
    calls.push(call);

    const scripted = responseSequence.shift();
    if (scripted) {
      const value = typeof scripted === 'function' ? await scripted(call) : scripted;
      return value instanceof Response ? value : toResponse(value);
    }

    if (method === 'GET' && /\/pullrequests\/\d+$/.test(url.pathname)) {
      return toResponse(getPullRequestResponses.shift() ?? { body: defaultPullRequest });
    }
    if (method === 'GET' && /\/pullrequests\/\d+\/diff$/.test(url.pathname)) {
      return toResponse(options.getPullRequestDiffResponse ?? {
        body: 'diff --git a/src/foo.ts b/src/foo.ts\n',
        headers: { 'content-type': 'text/plain' },
      });
    }
    // PROV-01 (D-08): GET /src/{ref}/{path} — single-page raw-text response. 404 -> null path
    // at the adapter; non-404 status errors throw at the adapter. The recorder preserves the
    // full URL (pathname + search) so a spec can assert the ref segment is encoded as-is.
    if (method === 'GET' && /\/src\/[^/]+\//.test(url.pathname)) {
      const fixture = options.fileContentResponses ?? {
        status: 200,
        body: 'default file content',
        headers: { 'content-type': 'text/plain' },
      };
      return toResponse(fixture);
    }
    // PROV-01 (D-09): GET /diff/{head}..{base}?context=3&topic=true — raw-text. The recorder
    // preserves the full URL so the reversed operands + query params are observable.
    if (method === 'GET' && /\/diff\//.test(url.pathname)) {
      const fixture = options.compareDiffResponses ?? {
        status: 200,
        body: 'diff --git a/src/foo.ts b/src/foo.ts\n+const added = true;\n',
        headers: { 'content-type': 'text/plain' },
      };
      return toResponse(fixture);
    }
    // PRD-04 (FR-114): GET /repositories/{w}/{r}/commits/{ref} (file history). The
    // path/pagelen operands ride the query string (the recorder preserves pathname + search).
    // Registered ONLY when the fixture is supplied so every other spec's route table is
    // byte-identical (NREG-01); the terminal 404 covers the unregistered case.
    if (method === 'GET' && options.fileHistoryResponses && /\/2\.0\/repositories\/[^/]+\/[^/]+\/commits\/[^/]+$/.test(url.pathname)) {
      return toResponse(options.fileHistoryResponses);
    }
    // PROV-02 (R-4): raw multi-page listRawPullRequestComments. MUST be checked BEFORE the existing
    // `listPullRequestComments` route below because the raw consumer wants control over the page
    // shape and follows the `next` URL itself; the legacy consumer wants the single-page mapped fixture.
    // When no raw fixture is supplied, fall through to the legacy handler so existing tests keep
    // their expected behavior.
    if (method === 'GET' && /\/pullrequests\/\d+\/comments/.test(url.pathname) && rawCommentPageResponses.length > 0) {
      return toResponse(rawCommentPageResponses.shift()!);
    }
    if (method === 'GET' && /\/pullrequests\/\d+\/comments$/.test(url.pathname)) {
      return toResponse(options.listPullRequestCommentsResponse ?? {
        // Additive `user` object so the comment-primitive specs can assert author.id comes from
        // account_id (never a username field — Bitbucket comment authors have none). The existing
        // id (7) and content are untouched so the client mapping stays byte-compatible until Task 2.
        body: {
          values: [
            {
              id: 7,
              content: { raw: 'Existing comment' },
              user: {
                account_id: BITBUCKET_FIXTURE_ACCOUNT_ID,
                nickname: BITBUCKET_FIXTURE_NICKNAME,
                display_name: BITBUCKET_FIXTURE_DISPLAY_NAME,
              },
            },
          ],
        },
      });
    }
    if (method === 'POST' && /\/pullrequests\/\d+\/comments$/.test(url.pathname)) {
      return toResponse(postPullRequestCommentResponses.shift() ?? { status: 201, body: { id: 8 } });
    }
    // PROV-02: POST /pullrequests/{n}/comments/{id}/resolve (D-04). Scripted status sequence lets
    // a spec drive the success/403/404/500/501 matrix; 200/204 -> success, 403/404/501 -> adapter
    // flips `supportsThreadResolution` to false, others -> false without flipping.
    if (method === 'POST' && /\/pullrequests\/\d+\/comments\/\d+\/resolve$/.test(url.pathname)) {
      const next = resolveCommentStatuses.shift();
      const status = next?.status ?? 200;
      return toResponse({
        status,
        body: status === 200 || status === 204 ? {} : { error: { message: `Resolve failed with ${status}` } },
      });
    }
    // PROV-02 (D-07): GET /2.0/user — return 403 by default only if the fixture opts in. Default
    // returns the configured immutable bot account id so the resolver short-circuits.
    if (method === 'GET' && url.pathname === '/2.0/user') {
      if (options.blockResolveBotUserIdentity) {
        return toResponse({ status: 403, body: { error: { message: 'Repository access tokens cannot query /user' } } });
      }
      return toResponse({
        status: 200,
        body: {
          account_id: BITBUCKET_FIXTURE_ACCOUNT_ID,
          nickname: BITBUCKET_FIXTURE_NICKNAME,
          display_name: BITBUCKET_FIXTURE_DISPLAY_NAME,
        },
      });
    }
    // Comment-edit PUT (net-new client method in Task 2). Default echoes the edited comment id;
    // a spec scripts 404/410 (gone -> null) or a non-gone 403/422 (must throw) via responseSequence.
    if (method === 'PUT' && /\/pullrequests\/\d+\/comments\/\d+$/.test(url.pathname)) {
      return toResponse({ status: 200, body: { id: BITBUCKET_FIXTURE_EDIT_COMMENT_ID } });
    }
    if (method === 'POST' && /\/pullrequests\/\d+\/approve$/.test(url.pathname)) {
      return toResponse(options.approvePullRequestResponse ?? { status: 200, body: {} });
    }
    // Phase 30 (ANNO-01): widened from the literal `codra-review` to ANY reportId. Every EXISTING
    // caller still PUTs to `codra-review`, so this is a strict, non-breaking superset.
    if (method === 'PUT' && /\/commit\/[^/]+\/reports\/[^/]+$/.test(url.pathname)) {
      return toResponse(options.upsertCodeInsightsReportResponse ?? { status: 200, body: {} });
    }
    if (method === 'DELETE' && /\/commit\/[^/]+\/reports\/[^/]+$/.test(url.pathname)) {
      return toResponse(options.deleteCodeInsightsReportResponse ?? { status: 204 });
    }
    if (method === 'POST' && /\/commit\/[^/]+\/reports\/[^/]+\/annotations$/.test(url.pathname)) {
      return toResponse(options.bulkUpsertAnnotationsResponse ?? { status: 200, body: [] });
    }
    if (method === 'POST' && /\/commit\/[^/]+\/statuses\/build$/.test(url.pathname)) {
      return toResponse(options.postCommitBuildStatusResponse ?? { status: 201, body: {} });
    }

    return toResponse({ status: 404, body: { error: { message: `Unhandled mock route: ${method} ${url.pathname}` } } });
  }

  vi.stubGlobal('fetch', handler);

  return {
    calls,
    restore() {
      vi.stubGlobal('fetch', originalFetch);
    },
  };
}

export function expectBitbucketGet(call: RecordedBitbucketCall, path: string) {
  if (call.method !== 'GET' || call.path !== path) {
    throw new Error(`Expected GET ${path}, received ${call.method} ${call.path}`);
  }
}

export function expectBitbucketPost(call: RecordedBitbucketCall, path: string) {
  if (call.method !== 'POST' || call.path !== path) {
    throw new Error(`Expected POST ${path}, received ${call.method} ${call.path}`);
  }
}

export function expectBitbucketPut(call: RecordedBitbucketCall, path: string) {
  if (call.method !== 'PUT' || call.path !== path) {
    throw new Error(`Expected PUT ${path}, received ${call.method} ${call.path}`);
  }
}
