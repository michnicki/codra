import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError } from '@server/core/github';
import { AGENTIC_GREP_HIT_MAX_BYTES } from '@server/core/agentic-tools';
import { createTestEnv, seedInstallationToken } from './helpers';
import { installGitHubFetchMock, type GitHubFetchMockFixtures } from './github-fetch-mock';

const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUMBER = 42;
const INSTALLATION_ID = '123456';

/** The literal endpoint path. Asserted rather than interpolated so a route rename is caught here. */
const SEARCH_PATH = '/search/code';
/** The media type WITHOUT which the response carries no `text_matches` at all. */
const TEXT_MATCH_ACCEPT = 'application/vnd.github.text-match+json';

function buildGitHubFixtures(
  overrides: Partial<GitHubFetchMockFixtures> = {},
): GitHubFetchMockFixtures {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    pull: {
      number: PR_NUMBER,
      title: 'Test PR',
      body: 'Test body',
      draft: false,
      head: { sha: 'headsha1234567890', ref: 'feature-branch' },
      base: { sha: 'basesha1234567890', ref: 'main' },
      user: { login: 'author-login' },
    },
    diff: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ...overrides,
  };
}

type TrackerStub = {
  incrementSubrequests: ReturnType<typeof vi.fn<(count?: number) => void>>;
  hasRemainingSafeBudget: ReturnType<typeof vi.fn<(needed?: number) => boolean>>;
};

function makeTracker(): TrackerStub {
  return {
    incrementSubrequests: vi.fn<(count?: number) => void>(),
    hasRemainingSafeBudget: vi.fn<(needed?: number) => boolean>(() => true),
  };
}

/** Total subrequests charged so far, summing each call's `count` argument (default 1). */
function chargedSubrequests(tracker: TrackerStub): number {
  return tracker.incrementSubrequests.mock.calls.reduce(
    (total, [count]) => total + (count ?? 1),
    0,
  );
}

async function withClient(
  fixtures: Partial<GitHubFetchMockFixtures>,
  run: (ctx: {
    client: GitHubClient;
    tracker: TrackerStub;
    calls: ReturnType<typeof installGitHubFetchMock>['calls'];
    searchCalls: () => ReturnType<typeof installGitHubFetchMock>['calls'];
  }) => Promise<void>,
) {
  const env = createTestEnv();
  await seedInstallationToken(env, INSTALLATION_ID);
  const { calls, restore } = installGitHubFetchMock(buildGitHubFixtures(fixtures));
  const tracker = makeTracker();
  const client = new GitHubClient(env, INSTALLATION_ID, tracker);
  try {
    await run({
      client,
      tracker,
      calls,
      searchCalls: () => calls.filter((call) => call.path === SEARCH_PATH),
    });
  } finally {
    restore();
  }
}

/** Decoded `q` operand of the single recorded search call. */
function decodedQuery(search: string): string {
  return new URLSearchParams(search).get('q') ?? '';
}

function decodedPerPage(search: string): string {
  return new URLSearchParams(search).get('per_page') ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Task 1 — GitHubClient.searchCode
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('GitHubClient.searchCode: request composition', () => {
  it('sends exactly one request carrying the text-match media type', async () => {
    await withClient(
      {
        codeSearchResponses: {
          body: { total_count: 0, incomplete_results: false, items: [] },
        },
      },
      async ({ client, searchCalls }) => {
        await client.searchCode(OWNER, REPO, 'handleWebhook', 5);

        const recorded = searchCalls();
        expect(recorded).toHaveLength(1);
        // WITHOUT this media type GitHub omits `text_matches` entirely, so there is no fragment to
        // show the model and the whole call is useless. This is the assertion that pins it.
        expect(recorded[0].accept).toBe(TEXT_MATCH_ACCEPT);
        expect(recorded[0].method).toBe('GET');
      },
    );
  });

  it('pins the repository in `q` alongside the model-supplied literal query (T-35-07)', async () => {
    await withClient(
      {
        codeSearchResponses: { body: { items: [] } },
      },
      async ({ client, searchCalls }) => {
        await client.searchCode(OWNER, REPO, 'handleWebhook payload', 5);

        const [recorded] = searchCalls();
        // The URL really is percent-encoded on the wire...
        expect(recorded.search).toContain('repo%3Atest-owner%2Ftest-repo');
        expect(recorded.search).toContain('handleWebhook');
        // ...and decoded, `q` is the model's literal query PLUS the repository-scoping qualifier
        // built from the pinned owner/repo. A tool argument can never name another repository.
        expect(decodedQuery(recorded.search)).toBe(`handleWebhook payload repo:${OWNER}/${REPO}`);
      },
    );
  });

  it('clamps per_page to 100 when maxHits exceeds GitHub‘s page maximum', async () => {
    await withClient({ codeSearchResponses: { body: { items: [] } } }, async ({ client, searchCalls }) => {
      await client.searchCode(OWNER, REPO, 'needle', 500);
      expect(decodedPerPage(searchCalls()[0].search)).toBe('100');
    });
  });

  it('clamps per_page to 1 when maxHits is below 1, and returns no hits at all', async () => {
    await withClient(
      {
        codeSearchResponses: {
          body: { items: [{ path: 'src/a.ts', text_matches: [{ fragment: 'hit' }] }] },
        },
      },
      async ({ client, searchCalls }) => {
        const hits = await client.searchCode(OWNER, REPO, 'needle', 0);
        expect(decodedPerPage(searchCalls()[0].search)).toBe('1');
        // The clamp is on the REQUEST operand only; the returned array still never exceeds maxHits.
        expect(hits).toEqual([]);
      },
    );
  });

  it('passes maxHits through as per_page when it is inside the closed 1..100 range', async () => {
    await withClient({ codeSearchResponses: { body: { items: [] } } }, async ({ client, searchCalls }) => {
      await client.searchCode(OWNER, REPO, 'needle', 30);
      expect(decodedPerPage(searchCalls()[0].search)).toBe('30');
    });
  });
});

describe('GitHubClient.searchCode: payload mapping', () => {
  it('flattens items × text_matches in item-then-match order', async () => {
    await withClient(
      {
        codeSearchResponses: {
          body: {
            total_count: 2,
            incomplete_results: false,
            items: [
              { path: 'src/a.ts', text_matches: [{ fragment: 'A1' }, { fragment: 'A2' }] },
              { path: 'src/b.ts', text_matches: [{ fragment: 'B1' }, { fragment: 'B2' }] },
            ],
          },
        },
      },
      async ({ client }) => {
        const hits = await client.searchCode(OWNER, REPO, 'needle', 10);

        expect(hits).toHaveLength(4);
        expect(hits?.map((hit) => `${hit.path}:${hit.fragment}`)).toEqual([
          'src/a.ts:A1',
          'src/a.ts:A2',
          'src/b.ts:B1',
          'src/b.ts:B2',
        ]);
      },
    );
  });

  it('returns the provider fragment VERBATIM and untruncated (the per-hit bound lives in the executor)', async () => {
    // Deliberately longer than the executor's per-hit byte bound: if the client sliced it, this
    // assertion goes red and the FR-132 bound would silently exist in two places.
    const longFragment = 'x'.repeat(AGENTIC_GREP_HIT_MAX_BYTES * 3);
    await withClient(
      {
        codeSearchResponses: {
          body: { items: [{ path: 'src/long.ts', text_matches: [{ fragment: longFragment }] }] },
        },
      },
      async ({ client }) => {
        const hits = await client.searchCode(OWNER, REPO, 'needle', 10);
        expect(hits?.[0].fragment).toBe(longFragment);
        expect(hits?.[0].fragment.length).toBeGreaterThan(AGENTIC_GREP_HIT_MAX_BYTES);
      },
    );
  });

  it('labels every hit with the default branch and NEVER fabricates a line number (D-07)', async () => {
    await withClient(
      {
        codeSearchResponses: {
          body: {
            items: [
              { path: 'src/a.ts', text_matches: [{ fragment: 'A1' }] },
              { path: 'src/b.ts', text_matches: [{ fragment: 'B1' }] },
            ],
          },
        },
      },
      async ({ client }) => {
        const hits = await client.searchCode(OWNER, REPO, 'needle', 10);

        for (const hit of hits ?? []) {
          // GitHub's text-match fragments carry NO line number. A guessed one would have the model
          // cite a line the provider never reported.
          expect(hit.line).toBeNull();
          // The code-search index is the DEFAULT BRANCH, never the pull-request head.
          expect(hit.ref).toContain('default branch');
          expect(hit.ref).not.toContain('headsha1234567890');
          expect(hit.ref).not.toMatch(/^[0-9a-f]{7,40}$/);
        }
      },
    );
  });

  it('returns at most maxHits even when the response carries more matches', async () => {
    await withClient(
      {
        codeSearchResponses: {
          body: {
            items: [
              { path: 'src/a.ts', text_matches: [{ fragment: 'A1' }, { fragment: 'A2' }, { fragment: 'A3' }] },
              { path: 'src/b.ts', text_matches: [{ fragment: 'B1' }, { fragment: 'B2' }] },
            ],
          },
        },
      },
      async ({ client }) => {
        const hits = await client.searchCode(OWNER, REPO, 'needle', 2);
        expect(hits).toHaveLength(2);
        expect(hits?.map((hit) => hit.fragment)).toEqual(['A1', 'A2']);
      },
    );
  });

  it('skips a malformed item and a malformed text match without throwing (T-35-11)', async () => {
    await withClient(
      {
        codeSearchResponses: {
          body: {
            items: [
              // No `path` at all: the whole item is untrustworthy and is dropped.
              { text_matches: [{ fragment: 'ORPHAN' }] },
              { path: 42, text_matches: [{ fragment: 'NUMERIC-PATH' }] },
              {
                path: 'src/ok.ts',
                text_matches: [
                  { object_url: 'https://example.invalid' },
                  { fragment: null },
                  { fragment: 'KEPT' },
                ],
              },
              // `text_matches` absent entirely (the shape when the media type is missing).
              { path: 'src/no-matches.ts' },
            ],
          },
        },
      },
      async ({ client }) => {
        const hits = await client.searchCode(OWNER, REPO, 'needle', 10);
        expect(hits).toEqual([
          { path: 'src/ok.ts', fragment: 'KEPT', line: null, ref: expect.stringContaining('default branch') },
        ]);
      },
    );
  });

  it('returns an empty array for a 200 with no items key at all', async () => {
    await withClient(
      { codeSearchResponses: { body: { total_count: 0, incomplete_results: false } } },
      async ({ client }) => {
        expect(await client.searchCode(OWNER, REPO, 'needle', 10)).toEqual([]);
      },
    );
  });
});

describe('GitHubClient.searchCode: three-valued status handling', () => {
  it('returns null on 403 — rate limiting stands the capability down for the invocation', async () => {
    await withClient({ codeSearchResponses: { status: 403 } }, async ({ client, searchCalls }) => {
      expect(await client.searchCode(OWNER, REPO, 'needle', 10)).toBeNull();
      // Exactly ONE attempt: /search/code is capped at 10 requests per minute per installation and a
      // retry cannot clear a limit inside one job, so there must be no retry storm.
      expect(searchCalls()).toHaveLength(1);
    });
  });

  it('returns null on 429', async () => {
    await withClient({ codeSearchResponses: { status: 429 } }, async ({ client, searchCalls }) => {
      expect(await client.searchCode(OWNER, REPO, 'needle', 10)).toBeNull();
      expect(searchCalls()).toHaveLength(1);
    });
  });

  it('returns an EMPTY ARRAY (never null) on 422 — a query problem, not a capability problem', async () => {
    await withClient({ codeSearchResponses: { status: 422 } }, async ({ client }) => {
      const hits = await client.searchCode(OWNER, REPO, 'a'.repeat(300), 10);
      // The distinction is load-bearing: `null` would permanently kill grep_repo for the rest of the
      // run over a single over-long / operator-heavy / term-less query.
      expect(hits).not.toBeNull();
      expect(hits).toEqual([]);
    });
  });

  it('throws on 500 with the status on the error, so a real outage is never masked', async () => {
    await withClient({ codeSearchResponses: { status: 500 } }, async ({ client }) => {
      await expect(client.searchCode(OWNER, REPO, 'needle', 10)).rejects.toThrow(GitHubError);
      await expect(client.searchCode(OWNER, REPO, 'needle', 10)).rejects.toMatchObject({
        status: 500,
        path: SEARCH_PATH,
      });
    });
  });

  it('throws on 404 too — only 403/429 and 422 are documented degradations', async () => {
    await withClient({ codeSearchResponses: { status: 404 } }, async ({ client }) => {
      await expect(client.searchCode(OWNER, REPO, 'needle', 10)).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('GitHubClient.searchCode: subrequest accounting', () => {
  it('charges exactly ONE subrequest per call and never double-increments', async () => {
    await withClient(
      { codeSearchResponses: { body: { items: [] } } },
      async ({ client, tracker, searchCalls }) => {
        // First call also pays the one-off installation-token KV read (`readCachedInstallationToken`
        // charges 1); the token is then memoized on the client for the rest of the invocation.
        await client.searchCode(OWNER, REPO, 'needle', 10);
        const afterFirst = chargedSubrequests(tracker);
        expect(afterFirst).toBe(2);

        await client.searchCode(OWNER, REPO, 'needle', 10);
        // The delta is the whole point: `request()` self-increments, so `searchCode` must NOT.
        expect(chargedSubrequests(tracker) - afterFirst).toBe(1);
        expect(searchCalls()).toHaveLength(2);
      },
    );
  });
});
