import type { AppBindings } from '@server/env';
import { withTimeout } from '@server/core/timeout';
import { logger } from '@server/core/logger';
import type { BotIdentityResolver } from '@server/core/bot-identity';

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
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
      attempt++;
      const isSecondaryRateLimit = error instanceof GitHubError &&
        error.status === 403 &&
        error.body?.toLowerCase().includes('secondary rate limit');

      // `fn` can reject with a non-Error (string, null, number). Reading `error.name` /
      // `error.message` directly would then throw a TypeError from inside the retry predicate,
      // masking the real rejection. Normalize both fields first (matches core/bitbucket.ts).
      const errorName = error instanceof Error ? error.name : '';
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isRetryable =
        isSecondaryRateLimit ||
        (error instanceof GitHubError && (error.status === 429 || error.status >= 500)) ||
        errorName === 'TimeoutError' ||
        errorMessage.includes('timeout');

      if (!isRetryable || attempt > maxRetries) {
        throw error;
      }

      const delay = isSecondaryRateLimit ? Math.pow(2, attempt) * 30000 : Math.pow(2, attempt) * 1000;
      logger.warn(`Retrying GitHub operation ${operation} (attempt ${attempt}/${maxRetries}) in ${delay}ms`, {
        status: error instanceof GitHubError ? error.status : undefined,
        error: errorMessage,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export type GitHubInstallation = {
  id: number;
};

export type GitHubRepository = {
  name: string;
  owner: {
    login: string;
  };
};

/** Default timeout for every GitHub API call (30 s). */
const GITHUB_TIMEOUT_MS = 30_000;
const GITHUB_APP_INSTALL_URL_CACHE_KEY = 'github:app_installation_url';
const GITHUB_REPOSITORIES_PER_PAGE = 100;
const GITHUB_REPOSITORY_PAGE_LIMIT = 100;

type InstallationTokenCacheRecord = {
  token: string;
  expiresAt: string;
};

type GitHubAppRecord = {
  html_url?: string;
  slug?: string;
};

type PullRequestRecord = {
  number: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
};

export type GitHubReviewComment = {
  path: string;
  position?: number;
  body: string;
};

type GitHubIssueLabel = {
  name?: string;
};

function installationCacheKey(installationId: string) {
  return `install:${installationId}`;
}

function normalizeGitHubAppSlug(slug: string | undefined) {
  const normalized = slug?.trim().replace(/\[bot\]$/i, '');
  return normalized || null;
}

function installUrlFromSlug(slug: string) {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

function encodeGitHubContentPath(path: string) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function repoApiPath(owner: string, repo: string) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    // Handle literal \n escape sequences (e.g. when the key is stored as a
    // single-line string with \n instead of real newlines in wrangler secrets)
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function base64UrlEncode(input: string) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createGitHubJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signatureString = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${header}.${payload}.${signatureString}`;
}

async function readCachedInstallationToken(env: Pick<AppBindings, 'APP_KV'>, installationId: string, tracker?: { incrementSubrequests(count?: number): void }) {
  if (tracker) tracker.incrementSubrequests(1);
  const cached = await env.APP_KV.get(installationCacheKey(installationId), 'json');
  return cached as InstallationTokenCacheRecord | null;
}

async function writeCachedInstallationToken(
  env: Pick<AppBindings, 'APP_KV'>,
  installationId: string,
  record: InstallationTokenCacheRecord,
  tracker?: { incrementSubrequests(count?: number): void },
) {
  const expiresAt = new Date(record.expiresAt).getTime();
  const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 300);
  if (tracker) tracker.incrementSubrequests(1);
  await env.APP_KV.put(installationCacheKey(installationId), JSON.stringify(record), { expirationTtl: ttl });
}

export class GitHubClient {
  constructor(
    private readonly env: Pick<
      AppBindings,
      'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME' | 'GITHUB_APP_SLUG'
    >,
    private readonly installationId: string,
    private readonly tracker?: { incrementSubrequests(count?: number): void },
  ) {}

  // In-memory token cache scoped to this client instance (i.e. one Worker invocation). Without it,
  // every GitHub request re-read the token from KV -- a wasted subrequest per call. A finalize or
  // review invocation makes many GitHub calls, so that repeated KV read pushed the invocation toward
  // the Workers-Free 50-subrequest cap (finalize could tip over it right before posting the review).
  private memoToken: InstallationTokenCacheRecord | null = null;

  async getInstallationToken(): Promise<string> {
    // Reuse the in-memory token while it's comfortably unexpired (invocations are < ~120s; tokens
    // last ~1h, so this holds for the whole invocation) -- no KV read, no network call.
    if (this.memoToken?.token && new Date(this.memoToken.expiresAt).getTime() > Date.now() + 60_000) {
      return this.memoToken.token;
    }

    const cached = await readCachedInstallationToken(this.env, this.installationId, this.tracker);
    if (cached?.token) {
      this.memoToken = cached;
      return cached.token;
    }

    return withRetry('getInstallationToken', async () => {
      const jwt = await createGitHubJwt(this.env.GITHUB_APP_ID, this.env.APP_PRIVATE_KEY);

      const response = await withTimeout('GitHub installation token', GITHUB_TIMEOUT_MS, (signal) =>
        fetch(`https://api.github.com/app/installations/${this.installationId}/access_tokens`, {
          method: 'POST',
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
          },
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/app/installations/.../access_tokens',
          `GitHub installation token request failed with ${response.status}: ${errText}`,
        );
      }

      const data = (await response.json()) as { token: string; expires_at: string };
      const record: InstallationTokenCacheRecord = {
        token: data.token,
        expiresAt: data.expires_at,
      };
      await writeCachedInstallationToken(this.env, this.installationId, record, this.tracker);
      this.memoToken = record;

      return data.token;
    });
  }

  static async listInstallations(
    env: Pick<AppBindings, 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'>,
  ): Promise<GitHubInstallation[]> {
    return withRetry('listInstallations', async () => {
      const jwt = await createGitHubJwt(env.GITHUB_APP_ID, env.APP_PRIVATE_KEY);
      const response = await withTimeout('GitHub list installations', GITHUB_TIMEOUT_MS, (signal) =>
        fetch('https://api.github.com/app/installations', {
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': env.BOT_USERNAME ?? 'codra-bot',
          },
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/app/installations',
          `GitHub list installations failed with ${response.status}: ${errText}`,
        );
      }

      return (await response.json()) as GitHubInstallation[];
    });
  }

  static async getAppInstallationUrl(
    env: Pick<AppBindings, 'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME' | 'GITHUB_APP_SLUG'>,
  ): Promise<string> {
    const configuredSlug = normalizeGitHubAppSlug(env.GITHUB_APP_SLUG);
    if (configuredSlug) {
      return installUrlFromSlug(configuredSlug);
    }

    const cached = await env.APP_KV.get(GITHUB_APP_INSTALL_URL_CACHE_KEY);
    if (cached) {
      return cached;
    }

    return withRetry('getAppInstallationUrl', async () => {
      const jwt = await createGitHubJwt(env.GITHUB_APP_ID, env.APP_PRIVATE_KEY);
      const response = await withTimeout('GitHub app lookup', GITHUB_TIMEOUT_MS, (signal) =>
        fetch('https://api.github.com/app', {
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': env.BOT_USERNAME ?? 'codra-bot',
          },
        }),
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          '/app',
          `GitHub app lookup failed with ${response.status}: ${errText}`,
        );
      }

      const app = (await response.json()) as GitHubAppRecord;
      const fallbackSlug = normalizeGitHubAppSlug(app.slug);
      const installUrl = app.html_url
        ? `${app.html_url.replace(/\/$/, '')}/installations/new`
        : fallbackSlug
          ? installUrlFromSlug(fallbackSlug)
          : null;

      if (!installUrl) {
        throw new Error('GitHub app lookup did not return a usable app URL.');
      }

      await env.APP_KV.put(GITHUB_APP_INSTALL_URL_CACHE_KEY, installUrl, { expirationTtl: 60 * 60 * 24 });
      return installUrl;
    });
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    return withRetry('listRepositories', async () => {
      const repositories: GitHubRepository[] = [];

      for (let page = 1; page <= GITHUB_REPOSITORY_PAGE_LIMIT; page += 1) {
        const response = await this.requestAndCheck(`/installation/repositories?per_page=${GITHUB_REPOSITORIES_PER_PAGE}&page=${page}`);
        const data = (await response.json()) as { repositories: GitHubRepository[] };
        repositories.push(...data.repositories);

        if (data.repositories.length < GITHUB_REPOSITORIES_PER_PAGE) {
          return repositories;
        }
      }

      throw new Error(
        `GitHub repository listing exceeded ${GITHUB_REPOSITORY_PAGE_LIMIT} pages without a terminating page.`,
      );
    });
  }

  private async request(
    path: string,
    init: RequestInit = {},
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const token = await this.getInstallationToken();

    if (this.tracker) this.tracker.incrementSubrequests(1);
    return withTimeout(`GitHub ${init.method ?? 'GET'} ${path}`, GITHUB_TIMEOUT_MS, (signal) =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        signal,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
          ...(init.headers ?? {}),
        },
      }),
    );
  }

  private async requestAndCheck(
    path: string,
    init: RequestInit = {},
    accept = 'application/vnd.github+json',
  ): Promise<Response> {
    const response = await this.request(path, init, accept);
    if (!response.ok) {
      const errText = await response.text();
      throw new GitHubError(
        response.status,
        errText,
        path,
        `GitHub API ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${errText}`,
      );
    }
    return response;
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    return withRetry(`getPullRequest ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/pulls/${pullNumber}`);
      return (await response.json()) as PullRequestRecord;
    });
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number) {
    return withRetry(`getPullRequestDiff ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await this.requestAndCheck(
        `${repoApiPath(owner, repo)}/pulls/${pullNumber}`,
        {},
        'application/vnd.github.v3.diff',
      );
      return response.text();
    });
  }

  async getRepoFileOrNull(owner: string, repo: string, path: string, ref?: string) {
    return withRetry(`getRepoFileOrNull ${owner}/${repo}/${path}${ref ? `@${ref}` : ''}`, async () => {
      // PROV-01 (D-08): when `ref` is supplied, append `?ref=<encoded>` so the endpoint resolves
      // against any git ref (branch / tag / commit SHA). The legacy no-arg path is preserved
      // byte-compatibly for the existing call sites (NREG-01).
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const response = await this.request(`${repoApiPath(owner, repo)}/contents/${encodeGitHubContentPath(path)}${query}`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          path,
          `GitHub repo file fetch failed with ${response.status}: ${errText}`,
        );
      }

      const data = (await response.json()) as { content?: unknown; encoding?: unknown };
      // D-08 contract: null is reserved for 404 only. A valid 200 with empty string content
      // is a real (empty) file, NOT the absent-file signal. A malformed successful payload
      // (missing/non-string content or non-base64 encoding) must throw so the consumer can
      // distinguish "the endpoint is lying" from "the file is gone".
      if (typeof data.content !== 'string') {
        throw new GitHubError(
          200,
          `GitHub repo file fetch returned a malformed payload (content is ${data.content === undefined ? 'missing' : typeof data.content})`,
          path,
          `GitHub repo file fetch succeeded but content is not a string`,
        );
      }
      if (data.encoding !== 'base64') {
        throw new GitHubError(
          200,
          `GitHub repo file fetch returned a malformed payload (unsupported encoding: ${String(data.encoding)})`,
          path,
          `GitHub repo file fetch succeeded but encoding is not 'base64'`,
        );
      }
      if (data.content === '') {
        return '';
      }

      return atob(data.content.replace(/\n/g, ''));
    });
  }

  // PROV-01 (D-09): compare-diff primitive. The GitHub REST compare endpoint orders operands
  // `BASE...HEAD` (NOT `HEAD..BASE` — the opposite of Bitbucket's diff); see R-5/R-6. The
  // `application/vnd.github.diff` media type returns the raw unified diff as text. An empty
  // response is a real, expected result (same SHA on both sides) and is passed through as `''`
  // so a Phase 18 consumer can distinguish a genuinely-empty diff from an errored one.
  async getCompareDiff(owner: string, repo: string, base: string, head: string) {
    const spec = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    return withRetry(`getCompareDiff ${owner}/${repo} ${base}...${head}`, async () => {
      const response = await this.requestAndCheck(
        `${repoApiPath(owner, repo)}/compare/${spec}`,
        {},
        'application/vnd.github.diff',
      );
      return response.text();
    });
  }

  // --- PROV-02 GraphQL plumbing (review-thread listing + resolution) ---
  //
  // The thread family (D-05..D-07) is exposed only via GraphQL -- the REST review-comment endpoint
  // cannot list resolved threads or call resolveReviewThread. This is the project's FIRST GraphQL
  // path; the helper is hand-rolled to satisfy the zero-new-deps constraint (PROJECT.md). Variables
  // travel as a JSON object so owner/repo/PR/thread-id NEVER cross into query text (T-17-02-01 --
  // Tampering).

  /**
   * Thin POST-to-/graphql helper. JSON-serializes `{ query, variables }`, sets
   * `content-type: application/json`, and runs through the same `request()` so installation-token
   * auth and subrequest tracking stay consistent with the REST surface. The returned body is the
   * raw `{ data, errors }` envelope -- callers inspect `errors` themselves.
   */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    return withRetry('graphql', async () => {
      const response = await this.requestAndCheck(
        '/graphql',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        },
        'application/vnd.github+json',
      );
      return (await response.json()) as T;
    });
  }

  /**
   * PROV-02 (D-05/D-06/D-07/R-2): cursor-paged thread-list walk. Each page is a single GraphQL
   * request carrying `comments(first: 1)` alongside the thread nodes (the nested connection does
   * NOT add an extra HTTP call -- R-9). A GraphQL `errors` envelope OR an absent/empty
   * `data.repository.pullRequest.reviewThreads.nodes` is treated as a traversal failure (Pitfall 5);
   * the catch is the adapter's, not this client's -- preserve provider detail for the adapter's
   * neutral return (D-02). Bounded by `MAX_THREAD_LIST_PAGES` (R-9): a large PR can otherwise tip
   * over Cloudflare's 50-subrequest cap before the consumer can review.
   *
   * `MAX_THREAD_LIST_PAGES = 10` is a TUNED EMPIRICAL CAP, not an API feature:
   *   - 100 threads per page x 10 pages = 1000 threads, well above any realistic PR.
   *   - Each page is exactly 1 GraphQL subrequest (`comments(first:1)` rides inside it -- R-9).
   *   - 10 + the existing token-fetch / bot-identity / potential resolve calls leaves headroom
   *     inside the Workers 50/invocation cap (token-tracker.ts:SAFE_MARGIN=25 + this=10 + bot=1).
   * Going higher risks subrequest exhaustion during a long diff. Going lower risks silently
   * dropping legitimate threads on the largest PRs the bot services.
   */
  static readonly MAX_THREAD_LIST_PAGES = 10;

  async getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
    tracker?: { hasRemainingSafeBudget?(needed?: number): boolean },
  ): Promise<unknown[]> {
    const maxPages = GitHubClient.MAX_THREAD_LIST_PAGES;
    const collected: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      // R-9 / token-tracker: consult the live budget before issuing the next page so a near-limit
      // tracker fails closed at the boundary rather than mid-pagination. `hasRemainingSafeBudget`
      // is optional because legacy callers / tests can omit it; falling back to "always proceed"
      // matches the R-9 "track-aware but not gated" semantics.
      if (tracker?.hasRemainingSafeBudget && !tracker.hasRemainingSafeBudget(1)) {
        throw new GitHubError(
          503,
          `GitHub thread pagination exceeded safe subrequest budget on page ${page + 1}/${maxPages}`,
          '/graphql',
          `GitHub thread list aborted: safe subrequest budget exhausted at page ${page + 1}`,
        );
      }
      const variables: Record<string, unknown> = {
        owner,
        repo,
        number: prNumber,
        after: cursor,
      };
      const data = await this.graphql<{
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: unknown[];
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          };
        };
        errors?: Array<{ message?: string }>;
      }>(
        `query ListReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes {
                  id
                  path
                  line
                  startLine
                  originalLine
                  originalStartLine
                  isResolved
                  isOutdated
                  comments(first: 1) {
                    nodes {
                      body
                      replyTo { id }
                      author {
                        __typename
                        ... on Bot { databaseId }
                        ... on User { databaseId }
                      }
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        variables,
      );

      // Treat a non-empty errors envelope as a failure (Pitfall 5 -- data MUST be inspected).
      if (data?.errors?.length) {
        throw new GitHubError(
          200,
          `GraphQL reviewThreads returned errors (page ${page + 1})`,
          '/graphql',
          `GitHub GraphQL reviewThreads query reported errors`,
        );
      }

      // GraphQL responses wrap the payload under a top-level `data` key. The client reads
      // `data.data` so the same envelope-shape (`{ data, errors }`) is honored across queries.
      const payload = (data as { data?: unknown })?.data as {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: unknown[];
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          };
        };
      } | null | undefined;
      const nodes = payload?.repository?.pullRequest?.reviewThreads?.nodes ?? null;
      const pageInfo = payload?.repository?.pullRequest?.reviewThreads?.pageInfo;

      if (!nodes) {
        throw new GitHubError(
          200,
          `GraphQL reviewThreads returned no reviewThreads nodes (page ${page + 1})`,
          '/graphql',
          `GitHub GraphQL reviewThreads returned no thread data`,
        );
      }

      for (const node of nodes) collected.push(node);
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        return collected;
      }
      cursor = pageInfo.endCursor;
    }
    // Cap reached with `hasNextPage: true` still outstanding. FAIL-CLOSED (R-9): the adapter
    // converts this throw to [] rather than returning a partial thread set.
    throw new GitHubError(
      503,
      `GitHub thread pagination exceeded MAX_THREAD_LIST_PAGES (${maxPages}); aborting partial traversal`,
      '/graphql',
      `GitHub thread list exceeded MAX_THREAD_LIST_PAGES=${maxPages}`,
    );
  }

  /**
   * PROV-02: mark a review thread resolved via `resolveReviewThread` (R-2). Returns the (possibly
   * absent) resolved `thread` payload so the adapter can decide success vs. failure. The threadId
   * travels as a GraphQL variable (T-17-02-01) -- NEVER interpolated into query text.
   */
  async resolveReviewThread(threadId: string): Promise<unknown> {
    const envelope = await this.graphql<{
      data?: {
        resolveReviewThread?: { thread?: { id?: string; isResolved?: boolean } | null };
      };
      errors?: Array<{ message?: string }>;
    }>(
      `mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }`,
      { threadId },
    );
    if (envelope?.errors?.length || !envelope?.data?.resolveReviewThread?.thread) {
      throw new GitHubError(
        200,
        'GitHub resolveReviewThread returned an errors envelope or no thread payload',
        '/graphql',
        `GitHub GraphQL resolveReviewThread reported failure`,
      );
    }
    return envelope.data.resolveReviewThread.thread;
  }

  async createCheckRun(
    owner: string,
    repo: string,
    input: { headSha: string; title: string; summary: string; detailsUrl?: string },
  ) {
    return withRetry(`createCheckRun ${owner}/${repo}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/check-runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'OpenCodra',
          head_sha: input.headSha,
          status: 'in_progress',
          details_url: input.detailsUrl,
          output: {
            title: input.title,
            summary: input.summary,
          },
        }),
      });

      return (await response.json()) as { id: number };
    });
  }

  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    input: {
      title: string;
      summary: string;
      status?: 'in_progress' | 'completed';
      conclusion?: 'success' | 'neutral' | 'failure' | 'cancelled';
    },
  ) {
    return withRetry(`updateCheckRun ${owner}/${repo} ${checkRunId}`, async () => {
      await this.requestAndCheck(`${repoApiPath(owner, repo)}/check-runs/${checkRunId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: input.status ?? 'in_progress',
          conclusion: input.conclusion,
          completed_at: input.status === 'completed' ? new Date().toISOString() : undefined,
          output: {
            title: input.title,
            summary: input.summary,
          },
        }),
      });
    });
  }

  async createReview(
    owner: string,
    repo: string,
    pullNumber: number,
    input: {
      commitSha: string;
      event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
      body: string;
      comments: GitHubReviewComment[];
    },
  ) {
    return withRetry(`createReview ${owner}/${repo}#${pullNumber}`, async () => {
      const body = {
        commit_id: input.commitSha,
        event: input.event,
        body: input.body,
        comments: input.comments
          .filter((comment) => comment.position)
          .map((comment) => ({
            path: comment.path,
            position: comment.position,
            body: comment.body,
          })),
      };

      const reviewPath = `${repoApiPath(owner, repo)}/pulls/${pullNumber}/reviews`;
      let response = await this.request(reviewPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.status === 422 && body.comments.length > 0) {
        logger.warn(`GitHub review creation failed with 422, retrying without inline comments`, {
          owner,
          repo,
          pullNumber,
        });
        response = await this.request(reviewPath, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            commit_id: input.commitSha,
            event: input.event,
            body: input.body,
            comments: [],
          }),
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          reviewPath,
          `GitHub review creation failed with ${response.status}: ${errText}`,
        );
      }

      return (await response.json()) as { id: number };
    });
  }

  // Returns a review this app already posted on the given commit, if one exists. Used by finalize
  // ONLY when re-running after a prior attempt reached the posting stage, to avoid double-posting a
  // review when the earlier invocation died in the narrow window between createReview() succeeding
  // and completeJob() recording the review id (e.g. a subrequest-budget error). One GET, first page
  // of 100 -- enough for the guard on any realistic PR (a PR with >100 reviews is pathological).
  async findBotReviewForCommit(
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    botLogin: string,
  ): Promise<{ id: number } | null> {
    return withRetry(`findBotReviewForCommit ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await this.requestAndCheck(
        `${repoApiPath(owner, repo)}/pulls/${pullNumber}/reviews?per_page=100`,
      );
      const reviews = (await response.json()) as Array<{
        id: number;
        commit_id?: string | null;
        user?: { login?: string | null } | null;
      }>;
      const login = botLogin.toLowerCase();
      const match = reviews.find(
        (review) =>
          review.commit_id === commitSha &&
          (review.user?.login ?? '').toLowerCase().startsWith(login),
      );
      return match ? { id: match.id } : null;
    });
  }

  // --- Standalone issue/PR-level comment primitives (D-04: thin, no dedup) ---

  // Net-new POST create, mirroring addIssueLabels' issues/{n}/... POST-with-JSON-body shape.
  async createIssueComment(owner: string, repo: string, issueNumber: number, body: string) {
    return withRetry(`createIssueComment ${owner}/${repo}#${issueNumber}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });
      return (await response.json()) as { id: number; user: { id: number; login: string } };
    });
  }

  // Net-new review-comment reply (Phase 12, D-01). Mirrors createIssueComment EXACTLY but targets
  // the PULLS comments route with `in_reply_to` (an integer). Per research §API Confirmations,
  // `in_reply_to` is an integer and all body params except `body` are ignored, so `path`/`line`/
  // `commit_id` are intentionally omitted.
  async createReviewCommentReply(owner: string, repo: string, pullNumber: number, body: string, inReplyToId: number) {
    return withRetry(`createReviewCommentReply ${owner}/${repo}#${pullNumber}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/pulls/${pullNumber}/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body, in_reply_to: inReplyToId }),
      });
      return (await response.json()) as { id: number; user: { id: number; login: string } };
    });
  }

  // Single page of 100 issue comments. Two caveats (review F7):
  //   (a) 100-cap: the first 100 comments suffice for any realistic PR (same rationale as
  //       findBotReviewForCommit); a PR needing >100 scanned is pathological.
  //   (b) ordering: GitHub returns issue comments in ASCENDING/OLDEST-first order by default, so
  //       this returns the OLDEST <=100 comments. A future consumer needing the most-recent
  //       comments (the Phase 11 self-filter) MUST add `&sort=created&direction=desc` or paginate.
  //       Not added now: the method is inert this phase and newest-first is deferred to the
  //       consumer that needs it (keeps GitHub and Bitbucket documented consistently).
  async listIssueComments(owner: string, repo: string, issueNumber: number) {
    return withRetry(`listIssueComments ${owner}/${repo}#${issueNumber}`, async () => {
      const response = await this.requestAndCheck(
        `${repoApiPath(owner, repo)}/issues/${issueNumber}/comments?per_page=100`,
      );
      return (await response.json()) as Array<{
        id: number;
        body: string;
        user: { id: number; login: string } | null;
      }>;
    });
  }

  // Copies the getRepoFileOrNull NON-throwing idiom (D-05): uses this.request (NOT requestAndCheck)
  // so 404 OR 410 Gone returns null instead of throwing -- a deleted/gone comment is a control-flow
  // signal ("re-post"), not an error (amended D-05, review F3). Any OTHER non-2xx still throws a
  // GitHubError, so no raw HTTP status reaches core/.
  async updateIssueComment(owner: string, repo: string, commentId: number, body: string) {
    return withRetry(`updateIssueComment ${owner}/${repo} comment#${commentId}`, async () => {
      const commentPath = `${repoApiPath(owner, repo)}/issues/comments/${commentId}`;
      const response = await this.request(commentPath, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body }),
      });
      if (response.status === 404 || response.status === 410) {
        return null;
      }
      if (!response.ok) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          commentPath,
          `GitHub issue comment update failed with ${response.status}: ${errText}`,
        );
      }
      return (await response.json()) as { id: number };
    });
  }

  // --- Command-authorization + bot-identity primitives (Phase 11, CMD-07/CMD-08) ---

  /**
   * Read the caller's effective permission on a repo via
   * `GET /repos/{owner}/{repo}/collaborators/{login}/permission` (Metadata:read, installation token).
   *
   * Returns `{ permission, userId }` where `userId` is the IMMUTABLE numeric id the endpoint
   * resolved `login` to (the caller re-verifies it against the immutable authorId — a login can be
   * reassigned). Returns `null` on 403/404 (not-a-collaborator / no access) or ANY network/other
   * failure, so the authorization caller fails CLOSED (CMD-08, D-06/D-07). Uses `request()` (not
   * `requestAndCheck()`) so a 403/404 is a control-flow signal, not a thrown error.
   */
  async getUserRepoPermission(
    owner: string,
    repo: string,
    authorLogin: string,
  ): Promise<{ permission: string; userId: number | null } | null> {
    try {
      return await withRetry(`getUserRepoPermission ${owner}/${repo} ${authorLogin}`, async () => {
        const response = await this.request(
          `${repoApiPath(owner, repo)}/collaborators/${encodeURIComponent(authorLogin)}/permission`,
        );
        // 403 (token lacks access) / 404 (not a collaborator) → cannot resolve → fail closed.
        if (response.status === 403 || response.status === 404) {
          return null;
        }
        if (!response.ok) {
          const errText = await response.text();
          throw new GitHubError(
            response.status,
            errText,
            `${repoApiPath(owner, repo)}/collaborators/${authorLogin}/permission`,
            `GitHub permission lookup failed with ${response.status}: ${errText}`,
          );
        }
        const data = (await response.json()) as {
          permission?: string;
          user?: { id?: number } | null;
        };
        return {
          permission: data.permission ?? 'none',
          userId: typeof data.user?.id === 'number' && Number.isFinite(data.user.id) ? data.user.id : null,
        };
      });
    } catch (error) {
      // Any residual failure (network, timeout, non-gone HTTP error) fails closed to null — the
      // caller cannot distinguish "unauthorized" from "unresolvable", both are ignored (D-07).
      logger.warn(`GitHub permission lookup for ${owner}/${repo} returned null (fail-closed)`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Resolve the bot's OWN GitHub user (the `${app-slug}[bot]` account) to its IMMUTABLE numeric id
   * (CMD-07, A4). The self-filter echo-loop defense (D-03) keys on this id, never a renameable login.
   * Prefers the configured `GITHUB_APP_SLUG`, else falls back to `BOT_USERNAME`; throws if neither
   * resolves a numeric id (the caller then leaves accountId null and command processing self-disables).
   */
  async resolveBotUserIdentity(): Promise<{ accountId: string; login?: string }> {
    const configuredSlug = normalizeGitHubAppSlug(this.env.GITHUB_APP_SLUG) ?? this.env.BOT_USERNAME;
    if (!configuredSlug) {
      throw new Error('Cannot resolve GitHub bot identity: no app slug or bot username configured');
    }
    const botLogin = /\[bot\]$/i.test(configuredSlug) ? configuredSlug : `${configuredSlug}[bot]`;
    return withRetry('resolveBotUserIdentity', async () => {
      const response = await this.requestAndCheck(`/users/${encodeURIComponent(botLogin)}`);
      const data = (await response.json()) as { id?: number; login?: string };
      if (typeof data.id !== 'number' || !Number.isFinite(data.id)) {
        throw new Error(`GitHub /users/${botLogin} did not return a numeric id`);
      }
      return { accountId: String(data.id), login: data.login ?? botLogin };
    });
  }

  async ensureLabel(owner: string, repo: string, name: string, color: string) {
    return withRetry(`ensureLabel ${owner}/${repo} ${name}`, async () => {
      const listResponse = await this.request(`${repoApiPath(owner, repo)}/labels/${encodeURIComponent(name)}`);
      if (listResponse.ok) {
        return;
      }
      if (listResponse.status !== 404) {
        const errText = await listResponse.text();
        throw new GitHubError(
          listResponse.status,
          errText,
          name,
          `GitHub label lookup failed with ${listResponse.status}: ${errText}`,
        );
      }

      const createResponse = await this.request(`${repoApiPath(owner, repo)}/labels`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, color }),
      });

      if (!createResponse.ok && createResponse.status !== 422) {
        const errText = await createResponse.text();
        throw new GitHubError(
          createResponse.status,
          errText,
          name,
          `GitHub label creation failed with ${createResponse.status}: ${errText}`,
        );
      }
    });
  }

  async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]) {
    return withRetry(`addIssueLabels ${owner}/${repo}#${issueNumber}`, async () => {
      await this.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/labels`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ labels }),
      });
    });
  }

  async listIssueLabels(owner: string, repo: string, issueNumber: number) {
    return withRetry(`listIssueLabels ${owner}/${repo}#${issueNumber}`, async () => {
      const response = await this.requestAndCheck(`${repoApiPath(owner, repo)}/issues/${issueNumber}/labels?per_page=100`);
      const labels = await response.json();
      if (!Array.isArray(labels)) {
        throw new Error('Expected an array of labels from GitHub API.');
      }
      return labels
        .map((label: GitHubIssueLabel) => label.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    });
  }

  async removeIssueLabelsIfPresent(owner: string, repo: string, issueNumber: number, labels: string[]) {
    const currentLabels = await this.listIssueLabels(owner, repo, issueNumber);
    const currentByLowerName = new Map(currentLabels.map(label => [label.toLowerCase(), label]));

    const uniqueLabels = Array.from(new Set(labels.map(label => label.toLowerCase())));
    for (const label of uniqueLabels) {
      const currentLabel = currentByLowerName.get(label);
      if (currentLabel) {
        await this.removeIssueLabel(owner, repo, issueNumber, currentLabel);
      }
    }
  }

  async removeIssueLabel(owner: string, repo: string, issueNumber: number, label: string) {
    return withRetry(`removeIssueLabel ${owner}/${repo}#${issueNumber} ${label}`, async () => {
      const response = await this.request(
        `${repoApiPath(owner, repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        {
          method: 'DELETE',
        },
      );

      if (!response.ok && response.status !== 404) {
        const errText = await response.text();
        throw new GitHubError(
          response.status,
          errText,
          label,
          `GitHub label removal failed with ${response.status}: ${errText}`,
        );
      }
    });
  }
}

/**
 * BotIdentityResolver for GitHub (CMD-07). Wraps `GitHubClient.resolveBotUserIdentity()` so
 * `getBotIdentity(env, 'github', resolver)` can populate a NON-NULL immutable accountId on a cold
 * cache. Accepts the narrow method interface (not the full client) so callers/tests can supply a
 * minimal resolver.
 */
export function createGithubBotIdentityResolver(
  client: Pick<GitHubClient, 'resolveBotUserIdentity'>,
): BotIdentityResolver {
  return {
    resolveIdentity() {
      return client.resolveBotUserIdentity();
    },
  };
}
