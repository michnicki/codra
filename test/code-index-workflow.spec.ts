// Phase 29 / QA-IDX-01, plan 29-05 — the index build's budget arithmetic, path selection,
// resumability, lease coalescing, and the IndexWorkflow durable loop.
//
// WHAT THIS FILE IS FOR. test/code-index-db.spec.ts proved the ACCESSORS change Postgres correctly.
// This file proves the CALLER uses them correctly, which is a different and largely non-overlapping
// set of defects — plan 29-04 built its destructive deletes as deliberately lease-agnostic primitives
// and delegated three obligations to the build:
//
//   1. LEASE BEFORE DESTRUCTION. truncateCodeIndexForRepo must run only after
//      claimCodeIndexBuildLease returned true, and a false claim must be LOGGED as a coalesced build
//      rather than returning silently. A truncate in front of a failed claim would let a coalesced
//      duplicate delete an index a live build is writing, and nothing else in the suite would notice.
//   2. REDACT BEFORE PERSISTING FAILURE. markCodeIndexBuildFailed's `message` must arrive already
//      routed through redactErrorMessage (AUD-01), because db/ cannot import core/ and therefore
//      cannot redact for itself.
//   3. RESUME AT THE RIGHT SHA. listIndexedPathsForSha must be called with
//      `code_index_state.building_sha`, NEVER `indexed_sha` — reading at the last COMPLETED sha would
//      make a resumed build skip files whose content has since changed, a silent correctness bug that
//      D-15's fail-open retrieval would never surface.
//
// BUDGET ARITHMETIC IS PINNED THE WAY test/chunk-concurrency.spec.ts PINS THE REVIEW MATH. The
// invariant is asserted against MAX_INDEX_FILES_PER_INVOCATION (the per-invocation batch ceiling), not
// against the configured `max_files` — see the named category-error case below for why that
// distinction is load-bearing rather than pedantic.
//
// ENVIRONMENT HAZARDS — recorded so a future reader does not misdiagnose one as a code defect:
//   - The live local test Postgres does NOT answer on the port written in `.env.test` (5432). It has
//     been observed on 5433 and on 5455 depending on the local data directory, so an ECONNREFUSED
//     here is an ENVIRONMENT problem: point TEST_DATABASE_URL at the running instance. Never "fix" it
//     by hardcoding a port or by changing production code.
//   - A bare `npx vitest run` skips the env files entirely, so createTestEnv() throws on a missing
//     BITBUCKET_CLIENT_ID before any case runs. Use `npm test`, or load the env files first.
//   - The test database is NEVER reset, so this spec removes its own index rows in beforeEach and
//     afterAll.
//   - The two IndexWorkflow cases call `run()`, which goes through the real runWithDb and therefore
//     creates one Hyperdrive pool each (runWithDb pools per invocation by design). They are
//     deliberately only two, because a low Postgres max_connections turns extra pools into scattered
//     unrelated test failures.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESTIMATED_SUBREQUESTS_PER_INDEX_FILE,
  INDEX_FRESH_INVOCATION_YIELD_SECONDS,
  MAX_INDEX_CONTINUATIONS,
  MAX_INDEX_FILES_PER_INVOCATION,
  budgetAwareIndexFileLimit,
  codeIndexInstanceId,
  runIndexBuild,
  selectIndexablePaths,
  type IndexBuildParams,
} from '@server/core/code-index-build';
import { IndexWorkflow } from '@server/workflows/index-build';
import { TokenTracker } from '@server/core/token-tracker';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import {
  claimCodeIndexBuildLease,
  markCodeIndexFileIndexed,
  upsertCodeIndexChunks,
} from '@server/db/code-index';
import { getOrCreateRepository } from '@server/db/repositories';
import { upsertRepoConfig } from '@server/db/repo-configs';
import { queryRows } from '@server/db/client';
import { MockWorkflow, createTestEnv, hasConfiguredTestDatabaseUrl, seedInstallationToken } from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// ---------------------------------------------------------------------------------------------
// Pure: budget arithmetic
// ---------------------------------------------------------------------------------------------

describe('budgetAwareIndexFileLimit (QA-IDX-01, D-05)', () => {
  // The REAL TokenTracker, so MAX_SUBREQUESTS and SAFE_MARGIN are genuinely in play rather than
  // restated as a literal that could drift away from the class.
  const fresh = new TokenTracker().remainingSafeBudget();

  it('returns MAX_INDEX_FILES_PER_INVOCATION exactly at a fresh safe budget', () => {
    expect(fresh).toBe(25);
    expect(budgetAwareIndexFileLimit(fresh, MAX_INDEX_FILES_PER_INVOCATION)).toBe(
      MAX_INDEX_FILES_PER_INVOCATION,
    );
  });

  it('keeps the per-file estimate at 2 and the batch ceiling at its derived floor(25 / 2) == 12', () => {
    // Pinned deliberately. Padding the estimate to 4 "to be safe" would halve the batch ceiling and
    // silently double every build's wall clock; this relationship fails instead of letting that happen
    // quietly (the test/chunk-concurrency.spec.ts precedent).
    expect(ESTIMATED_SUBREQUESTS_PER_INDEX_FILE).toBe(2);
    expect(MAX_INDEX_FILES_PER_INVOCATION).toBe(
      Math.floor(fresh / ESTIMATED_SUBREQUESTS_PER_INDEX_FILE),
    );
    expect(MAX_INDEX_FILES_PER_INVOCATION).toBe(12);
  });

  it('returns 12 rather than 500 when handed the configured max_files — the category error the named batch ceiling exists to prevent', () => {
    // THIS CASE IS DOCUMENTATION AS MUCH AS A TEST. `max_files` (default 500) is a TOTAL-WORK cap
    // applied once by selectIndexablePaths; MAX_INDEX_FILES_PER_INVOCATION is how much of that total a
    // SINGLE invocation may attempt. Handing max_files to this function makes it return 12 no matter
    // what, so the "a padded estimate cannot silently shrink the batch" invariant above could never
    // hold — it would be asserted against a number the function can never return, and a future
    // estimate change would sail straight through the suite. Keeping both cases side by side is what
    // makes the distinction impossible to re-conflate.
    expect(budgetAwareIndexFileLimit(fresh, 500)).toBe(12);
    expect(budgetAwareIndexFileLimit(fresh, 500)).not.toBe(500);
  });

  it('returns the floor of the division at a reduced budget', () => {
    expect(budgetAwareIndexFileLimit(9, MAX_INDEX_FILES_PER_INVOCATION)).toBe(4);
    expect(budgetAwareIndexFileLimit(6, MAX_INDEX_FILES_PER_INVOCATION)).toBe(3);
    expect(budgetAwareIndexFileLimit(1, MAX_INDEX_FILES_PER_INVOCATION)).toBe(0);
  });

  it('returns zero and never a negative number at an exhausted or overspent budget', () => {
    expect(budgetAwareIndexFileLimit(0, MAX_INDEX_FILES_PER_INVOCATION)).toBe(0);
    // An adapter that overspent can hand back a negative remainder; floor() of that is negative, and a
    // negative loop bound reads as "no work" in one place and as an error in another.
    expect(budgetAwareIndexFileLimit(-10, MAX_INDEX_FILES_PER_INVOCATION)).toBe(0);
  });

  it('never exceeds the batch ceiling even with an enormous budget', () => {
    expect(budgetAwareIndexFileLimit(10_000, MAX_INDEX_FILES_PER_INVOCATION)).toBe(
      MAX_INDEX_FILES_PER_INVOCATION,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Pure: the shared instance id
// ---------------------------------------------------------------------------------------------

describe('codeIndexInstanceId (QA-IDX-01, D-06)', () => {
  it('produces the SAME id for the same repository across calls, so instance.already_exists can fire', () => {
    // The whole coalescing story depends on this: the dashboard trigger (29-08) and both push branches
    // (29-06) must produce an identical id, or the duplicate silently starts a second build and only
    // the durable lease catches it.
    expect(codeIndexInstanceId(41)).toBe(codeIndexInstanceId(41));
  });

  it('produces DIFFERENT ids for different repositories', () => {
    expect(codeIndexInstanceId(41)).not.toBe(codeIndexInstanceId(42));
  });

  it('is the documented code-index-{repositoryId} shape (dash — Cloudflare rejects colons with instance.invalid_id)', () => {
    expect(codeIndexInstanceId(7)).toBe('code-index-7');
  });
});

// ---------------------------------------------------------------------------------------------
// Pure: selection (D-09)
// ---------------------------------------------------------------------------------------------

describe('selectIndexablePaths (QA-IDX-01, D-09)', () => {
  const noConfig = undefined;

  it('orders a mixed path list by descending priority with a deterministic path tiebreak', () => {
    const selected = selectIndexablePaths(
      [
        'src/zeta.ts',
        'src/server/routes/webhook.ts', // 'routes' -> +5
        'test/helpers.ts', //              'test'   -> -5
        'src/alpha.ts',
        'src/server/core/auth.ts', //      'auth'   -> +5
      ],
      noConfig,
      100,
    );
    // +5 tier first (tie broken by ascending path), then the 0 tier (likewise), then -5.
    expect(selected).toEqual([
      'src/server/core/auth.ts',
      'src/server/routes/webhook.ts',
      'src/alpha.ts',
      'src/zeta.ts',
      'test/helpers.ts',
    ]);
  });

  it('excludes lockfile and minified paths through the default skip matchers', () => {
    const selected = selectIndexablePaths(
      ['src/app.ts', 'package-lock.json', 'yarn.lock', 'vendor/jquery.min.js', 'pnpm-lock.yaml'],
      noConfig,
      100,
    );
    expect(selected).toEqual(['src/app.ts']);
  });

  it("excludes paths the repository's OWN skip_files globs match, because an operator exclusion applies to indexing too", () => {
    // Load-bearing beyond tidiness: an indexed path can be RETRIEVED INTO A PROMPT, so filtering at
    // index time is what makes the operator's exclusion actually hold (T-29-05-06).
    const reviewConfig = {
      ...defaultRepoConfig.review,
      skip_files: ['**/secrets/**', 'infra/**'],
    } as RepoConfig['review'];
    const selected = selectIndexablePaths(
      ['src/app.ts', 'config/secrets/keys.ts', 'infra/terraform/main.tf'],
      reviewConfig,
      100,
    );
    expect(selected).toEqual(['src/app.ts']);
  });

  it('truncates to the configured max-files cap AFTER ordering, so the cap keeps the highest-priority paths', () => {
    const selected = selectIndexablePaths(
      ['src/zzz.ts', 'src/server/core/auth.ts', 'src/aaa.ts', 'src/payment/charge.ts'],
      noConfig,
      2,
    );
    expect(selected).toEqual(['src/payment/charge.ts', 'src/server/core/auth.ts']);
  });

  it('returns an empty array for a zero or negative cap rather than throwing', () => {
    expect(selectIndexablePaths(['src/app.ts'], noConfig, 0)).toEqual([]);
    expect(selectIndexablePaths(['src/app.ts'], noConfig, -1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// DB-backed: runIndexBuild
// ---------------------------------------------------------------------------------------------

const OWNER = 'codra-idxwf-owner';
const REPO = 'codra-idxwf-29-05';
const INSTALLATION_ID = '99000296';
const PR_NUMBER = 11;
const DEFAULT_BRANCH = 'main';
/** The commit sha the branch read resolves to — i.e. the sha the build freezes on as `building_sha`. */
const BUILD_SHA = 'c'.repeat(40);
/** A DIFFERENT sha, used to seed rows that belong to a PREVIOUS build. */
const OLD_SHA = 'd'.repeat(40);

function githubFixtures(paths: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    pull: {
      number: PR_NUMBER,
      title: 'unused',
      body: null,
      draft: false,
      head: { sha: 'headsha', ref: 'feature' },
      base: { sha: 'basesha', ref: DEFAULT_BRANCH },
      user: { login: 'author' },
    },
    diff: '',
    repositoryResponse: { body: { default_branch: DEFAULT_BRANCH } },
    branchResponse: { body: { commit: { sha: BUILD_SHA } } },
    treeResponse: {
      truncated: false,
      tree: paths.map((path) => ({ path, type: 'blob' as const })),
    },
    ...overrides,
  } as Parameters<typeof installGitHubFetchMock>[0];
}

dbDescribe('runIndexBuild (QA-IDX-01, plan 29-05)', () => {
  const env = createTestEnv();
  let repositoryId = 0;
  let restoreFetch: (() => void) | null = null;

  async function seedRepository() {
    if (repositoryId) return;
    repositoryId = await getOrCreateRepository(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo: REPO,
      vcsProvider: 'github',
    });
    // Keeps the adapter from spending a subrequest minting an installation token per run.
    await seedInstallationToken(env, INSTALLATION_ID);
  }

  async function setIndexEnabled(enabled: boolean) {
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.interactive.qa.index = {
      ...parsedJson.review.interactive.qa.index,
      enabled,
    };
    await upsertRepoConfig(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo: REPO,
      parsedJson,
    });
  }

  /** Raw re-reads: every assertion goes back to Postgres rather than trusting a return value. */
  async function chunkPaths(): Promise<string[]> {
    const rows = await queryRows<{ path: string }>(
      env,
      'SELECT path FROM code_index_chunks WHERE repository_id = $1 ORDER BY path ASC',
      [repositoryId],
    );
    return rows.map((row) => row.path);
  }

  async function stateRow() {
    const [row] = await queryRows<Record<string, unknown>>(
      env,
      'SELECT * FROM code_index_state WHERE repository_id = $1',
      [repositoryId],
    );
    return row ?? null;
  }

  async function clearIndexRows() {
    if (!repositoryId) return;
    await queryRows(env, 'DELETE FROM code_index_chunks WHERE repository_id = $1', [repositoryId]);
    await queryRows(env, 'DELETE FROM code_index_files WHERE repository_id = $1', [repositoryId]);
    await queryRows(env, 'DELETE FROM code_index_state WHERE repository_id = $1', [repositoryId]);
  }

  function params(overrides: Partial<IndexBuildParams> = {}): IndexBuildParams {
    return {
      repositoryId,
      vcsProvider: 'github',
      owner: OWNER,
      repo: REPO,
      installationId: INSTALLATION_ID,
      mode: 'full',
      workflowInstanceId: 'instance-under-test',
      continuation: 0,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await seedRepository();
    await clearIndexRows();
    await setIndexEnabled(true);
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await clearIndexRows();
  });

  // ---- NREG-01: the binding is inert when the toggle is off ----

  it('writes nothing and makes NO provider call when the index toggle is off (NREG-01)', async () => {
    await setIndexEnabled(false);
    const { restore, calls } = installGitHubFetchMock(githubFixtures(['src/aaa.ts']));
    restoreFetch = restore;

    const result = await runIndexBuild(env, params());

    expect(result).toEqual({ action: 'ack', reason: 'disabled' });
    // Asserted as ZERO calls, not as "no chunks": the point is that the early return precedes the
    // provider construction entirely, so the binding cannot cost a subrequest for a repository whose
    // operator never opted in.
    expect(calls).toHaveLength(0);
    expect(await stateRow()).toBeNull();
    expect(await chunkPaths()).toEqual([]);
  });

  // ---- Resumability (D-05, inherited contract 3) ----

  it('processes ONLY the unindexed path when progress rows already exist at the in-progress sha', async () => {
    // Two of three paths were already recorded at BUILD_SHA by an interrupted earlier invocation.
    await markCodeIndexFileIndexed(env, {
      repositoryId,
      path: 'src/aaa.ts',
      indexedSha: BUILD_SHA,
      chunkCount: 1,
    });
    await markCodeIndexFileIndexed(env, {
      repositoryId,
      path: 'src/bbb.ts',
      indexedSha: BUILD_SHA,
      chunkCount: 1,
    });

    const { restore, calls } = installGitHubFetchMock(
      githubFixtures(['src/aaa.ts', 'src/bbb.ts', 'src/ccc.ts']),
    );
    restoreFetch = restore;

    const result = await runIndexBuild(env, params());

    expect(result).toEqual({ action: 'ack', reason: 'completed' });
    // Exactly ONE content fetch, for the one remaining path. Asserting the fetch COUNT (not just the
    // stored rows) is what proves the resumption skipped work rather than redoing it idempotently.
    const contentCalls = calls.filter((call) => call.path.includes('/contents/'));
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.path).toContain('src/ccc.ts');
    expect(await chunkPaths()).toEqual(['src/ccc.ts']);
  });

  it('resolves resumability against building_sha, so progress recorded at a DIFFERENT sha does not suppress a fetch', async () => {
    // The inherited contract's failure mode, stated as a test: rows at the last COMPLETED sha must not
    // be mistaken for this build's progress, or a resumed build would skip files whose content changed.
    await markCodeIndexFileIndexed(env, {
      repositoryId,
      path: 'src/aaa.ts',
      indexedSha: OLD_SHA,
      chunkCount: 1,
    });

    const { restore, calls } = installGitHubFetchMock(githubFixtures(['src/aaa.ts']));
    restoreFetch = restore;

    const result = await runIndexBuild(env, params());

    expect(result).toEqual({ action: 'ack', reason: 'completed' });
    expect(calls.filter((call) => call.path.includes('/contents/'))).toHaveLength(1);
    expect(await chunkPaths()).toEqual(['src/aaa.ts']);
    expect((await stateRow())?.indexed_sha).toBe(BUILD_SHA);
  });

  // ---- Lease coalescing (T-29-05-04, inherited contract 1) ----

  it('coalesces a second build start while a live lease is held by a different instance, without throwing', async () => {
    const claimed = await claimCodeIndexBuildLease(env, {
      repositoryId,
      workflowInstanceId: 'the-live-foreign-instance',
      leaseSeconds: 600,
    });
    expect(claimed).toBe(true);

    await upsertCodeIndexChunks(env, {
      repositoryId,
      path: 'src/seeded.ts',
      indexedSha: OLD_SHA,
      pathTokens: 'src/seeded.ts src seeded ts',
      chunks: [{ chunkStart: 1, chunkEnd: 5, content: 'seeded window' }],
    });
    const before = await chunkPaths();

    const { restore, calls } = installGitHubFetchMock(githubFixtures(['src/aaa.ts']));
    restoreFetch = restore;

    const result = await runIndexBuild(env, params({ workflowInstanceId: 'the-losing-instance' }));

    // A coalesced duplicate reports its outcome; it does not throw (the same disposition
    // `instance.already_exists` already gets elsewhere in this codebase).
    expect(result).toEqual({ action: 'ack', reason: 'coalesced' });
    // Asserted as an unchanged chunk row SET, not merely as "no error was thrown" — a truncate in
    // front of the failed claim would leave no error behind either.
    expect(await chunkPaths()).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  it('does NOT truncate on a coalesced FULL rebuild, so a duplicate cannot delete an index a live build is writing (Antigravity C-02)', async () => {
    await upsertCodeIndexChunks(env, {
      repositoryId,
      path: 'src/precious.ts',
      indexedSha: OLD_SHA,
      pathTokens: 'src/precious.ts src precious ts',
      chunks: [
        { chunkStart: 1, chunkEnd: 5, content: 'first window' },
        { chunkStart: 6, chunkEnd: 10, content: 'second window' },
      ],
    });
    await claimCodeIndexBuildLease(env, {
      repositoryId,
      workflowInstanceId: 'the-live-foreign-instance',
      leaseSeconds: 600,
    });

    const { restore } = installGitHubFetchMock(githubFixtures(['src/aaa.ts']));
    restoreFetch = restore;

    const result = await runIndexBuild(
      env,
      params({ mode: 'full', workflowInstanceId: 'the-losing-rebuild' }),
    );

    expect(result).toEqual({ action: 'ack', reason: 'coalesced' });
    // The exact row COUNT, because truncateCodeIndexForRepo would have removed both windows and left a
    // state row that still looked plausible. Nothing else in the suite would have noticed.
    const [row] = await queryRows<{ n: number | string }>(
      env,
      'SELECT count(*)::int AS n FROM code_index_chunks WHERE repository_id = $1',
      [repositoryId],
    );
    expect(Number(row?.n)).toBe(2);
  });

  // ---- Full rebuild: the truncate DOES happen when the lease is genuinely held ----

  it("clears a PREVIOUS build's rows on a full rebuild whose lease claim succeeded", async () => {
    // The positive counterpart to the two coalescing cases: without it, "does not truncate" would pass
    // just as well for an implementation that never truncates at all.
    await upsertCodeIndexChunks(env, {
      repositoryId,
      path: 'src/stale-from-an-older-commit.ts',
      indexedSha: OLD_SHA,
      pathTokens: 'stale',
      chunks: [{ chunkStart: 1, chunkEnd: 5, content: 'stale window' }],
    });

    const { restore } = installGitHubFetchMock(githubFixtures(['src/aaa.ts']));
    restoreFetch = restore;

    const result = await runIndexBuild(env, params({ mode: 'full' }));

    expect(result).toEqual({ action: 'ack', reason: 'completed' });
    expect(await chunkPaths()).toEqual(['src/aaa.ts']);
  });

  // ---- Selection is applied by the build, not just available to it ----

  it('never fetches a path the default skip matchers exclude, so an excluded file cannot reach the index', async () => {
    const { restore, calls } = installGitHubFetchMock(
      githubFixtures(['src/aaa.ts', 'package-lock.json', 'vendor/lib.min.js']),
    );
    restoreFetch = restore;

    await runIndexBuild(env, params());

    const contentCalls = calls.filter((call) => call.path.includes('/contents/'));
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.path).toContain('src/aaa.ts');
    expect(await chunkPaths()).toEqual(['src/aaa.ts']);
  });
});

// ---------------------------------------------------------------------------------------------
// DB-backed: the IndexWorkflow durable loop
// ---------------------------------------------------------------------------------------------

type RecordedStep = { kind: 'do' | 'sleep'; name: string; duration?: string };

/**
 * A `WorkflowStep` stand-in that records the step names and sleep durations while running each step
 * body inline. The real runtime's retry/hibernation behavior is not being tested here — the LOOP's
 * shape is: a named step per continuation, a sleep between them, and a handoff step when asked.
 */
function makeRecordingStep(recorded: RecordedStep[]) {
  return {
    async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
      recorded.push({ kind: 'do', name });
      const callback = (typeof configOrCallback === 'function' ? configOrCallback : maybeCallback) as (
        ctx: unknown,
      ) => Promise<unknown>;
      return callback({});
    },
    async sleep(name: string, duration: unknown) {
      recorded.push({ kind: 'sleep', name, duration: String(duration) });
    },
  };
}

/** Enough candidate paths that one budget-sized batch cannot finish the build. */
const MANY_PATHS = Array.from({ length: 14 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);

dbDescribe('IndexWorkflow durable loop (QA-IDX-01, D-05 / D-06)', () => {
  let repositoryId = 0;
  let restoreFetch: (() => void) | null = null;

  async function seed(env: ReturnType<typeof createTestEnv>) {
    repositoryId = await getOrCreateRepository(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo: REPO,
      vcsProvider: 'github',
    });
    await seedInstallationToken(env, INSTALLATION_ID);
    const parsedJson = structuredClone(defaultRepoConfig) as RepoConfig;
    parsedJson.review.interactive.qa.index = {
      ...parsedJson.review.interactive.qa.index,
      enabled: true,
    };
    await upsertRepoConfig(env, {
      installationId: INSTALLATION_ID,
      owner: OWNER,
      repo: REPO,
      parsedJson,
    });
    await queryRows(env, 'DELETE FROM code_index_chunks WHERE repository_id = $1', [repositoryId]);
    await queryRows(env, 'DELETE FROM code_index_files WHERE repository_id = $1', [repositoryId]);
    await queryRows(env, 'DELETE FROM code_index_state WHERE repository_id = $1', [repositoryId]);
  }

  /** Build the workflow instance. The mocked WorkflowEntrypoint base has a no-arg constructor, so
   * `env` is attached directly — there is no Workflows runtime to inject it. */
  function buildWorkflow(env: ReturnType<typeof createTestEnv>) {
    const workflow = new (IndexWorkflow as unknown as new () => IndexWorkflow)();
    Object.assign(workflow, { env });
    return workflow;
  }

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const env = createTestEnv();
    if (!repositoryId) return;
    await queryRows(env, 'DELETE FROM code_index_chunks WHERE repository_id = $1', [repositoryId]);
    await queryRows(env, 'DELETE FROM code_index_files WHERE repository_id = $1', [repositoryId]);
    await queryRows(env, 'DELETE FROM code_index_state WHERE repository_id = $1', [repositoryId]);
  });

  it('runs the build inside a NAMED step per continuation and sleeps at least one second between them', async () => {
    const env = createTestEnv();
    await seed(env);

    const { restore } = installGitHubFetchMock(githubFixtures(MANY_PATHS));
    restoreFetch = restore;

    const recorded: RecordedStep[] = [];
    const workflow = buildWorkflow(env);
    await workflow.run(
      { payload: buildPayload(repositoryId), instanceId: 'wf-instance-loop' } as never,
      makeRecordingStep(recorded) as never,
    );

    const doSteps = recorded.filter((step) => step.kind === 'do').map((step) => step.name);
    const sleeps = recorded.filter((step) => step.kind === 'sleep');

    // Two continuations, each in its own uniquely named step. The continuation number is IN the name so
    // a Workflows replay cannot collapse two different batches onto one memoized step result.
    expect(doSteps).toEqual(['index-build-c0-a1', 'index-build-c1-a2']);
    expect(sleeps).toHaveLength(1);
    // The forced yield is what resets the 50-subrequest per-invocation limit; a sub-second sleep keeps
    // the instance warm in the SAME invocation and the budget never resets.
    expect(sleeps[0]!.duration).toBe(`${INDEX_FRESH_INVOCATION_YIELD_SECONDS} seconds`);
    expect(INDEX_FRESH_INVOCATION_YIELD_SECONDS).toBeGreaterThanOrEqual(1);

    const [state] = await queryRows<{ status: string; file_count: number | string; indexed_sha: string }>(
      env,
      'SELECT status, file_count, indexed_sha FROM code_index_state WHERE repository_id = $1',
      [repositoryId],
    );
    expect(state?.status).toBe('ready');
    expect(Number(state?.file_count)).toBe(MANY_PATHS.length);
    expect(state?.indexed_sha).toBe(BUILD_SHA);
  });

  it('hands off to a FRESH instance id carrying a NON-ZERO continuation, so the handoff neither collides nor re-truncates', async () => {
    const indexWorkflowBinding = new MockWorkflow();
    const env = createTestEnv({ INDEX_WORKFLOW: indexWorkflowBinding as never });
    await seed(env);

    const { restore } = installGitHubFetchMock(githubFixtures(MANY_PATHS));
    restoreFetch = restore;

    const recorded: RecordedStep[] = [];
    const workflow = buildWorkflow(env);
    await workflow.run(
      {
        // At the continuation ceiling, so the first batch's result carries the fresh-instance flag.
        payload: buildPayload(repositoryId, { continuation: MAX_INDEX_CONTINUATIONS }),
        instanceId: 'wf-instance-handoff',
      } as never,
      makeRecordingStep(recorded) as never,
    );

    expect(indexWorkflowBinding.created).toHaveLength(1);
    const handoff = indexWorkflowBinding.created[0]!;

    // A handoff must create a NEW instance. Keying it on the shared per-repository id would collide
    // with the instance handing off and be dropped as a benign `instance.already_exists` duplicate —
    // stalling the build at exactly the point the handoff exists to rescue it.
    expect(handoff.id).not.toBe(codeIndexInstanceId(repositoryId));
    expect(handoff.id).toMatch(/^[0-9a-f-]{36}$/i);

    // THE REGRESSION THIS CASE EXISTS FOR. `runIndexBuild` treats continuation 0 as "first invocation"
    // and performs the destructive reset on that branch only. A handoff continues a build that is
    // already partly done, so passing 0 here would truncate away everything the previous instance
    // indexed and restart from zero on every handoff — meaning a repository large enough to NEED a
    // handoff would never finish. The natural-looking value is the broken one.
    expect(handoff.params.continuation).not.toBe(0);
    expect(handoff.params.continuation).toBe(1);
    expect(handoff.params.repositoryId).toBe(repositoryId);

    // The handoff runs in its own named step, and the loop breaks rather than continuing to drive a
    // build that is now owned by another instance.
    const doSteps = recorded.filter((step) => step.kind === 'do').map((step) => step.name);
    expect(doSteps).toEqual([
      `index-build-c${MAX_INDEX_CONTINUATIONS}-a1`,
      `index-handoff-c${MAX_INDEX_CONTINUATIONS}-a1`,
    ]);
  });
});

function buildPayload(repositoryId: number, overrides: Partial<IndexBuildParams> = {}): IndexBuildParams {
  return {
    repositoryId,
    vcsProvider: 'github',
    owner: OWNER,
    repo: REPO,
    installationId: INSTALLATION_ID,
    mode: 'full',
    workflowInstanceId: 'ignored-the-loop-uses-event.instanceId',
    continuation: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Source contracts
//
// Three of this plan's acceptance criteria are properties of the SOURCE rather than of any observable
// behavior — "wraps its body in runWithDb", "does not call review job maintenance", "the handoff does
// not use the shared instance id". They are asserted here by reading the file, following the
// precedent set for the truncation-ordering paragraph in plan 29-03. A behavioral test cannot
// distinguish "does not call job maintenance" from "job maintenance happened to be a no-op".
// ---------------------------------------------------------------------------------------------

describe('IndexWorkflow source contracts (QA-IDX-01, D-06)', () => {
  const workflowSource = readSource('src/server/workflows/index-build.ts');
  const buildSource = readSource('src/server/core/code-index-build.ts');
  // EVERY "must not appear" ASSERTION RUNS AGAINST CODE WITH COMMENTS STRIPPED, and that is the whole
  // point rather than a convenience. Both modules are REQUIRED by this plan to document, in prose, the
  // very things they must not do — the header names the review phase-routing selectors it must not
  // branch into, and ESTIMATED_SUBREQUESTS_PER_INDEX_FILE's rationale names the review constant it
  // deliberately does not inherit. Asserting against the raw text would therefore make the plan's own
  // documentation requirement fail its own prohibition, and the only way to pass would be to DELETE the
  // explanation. The prohibitions are about imports and call sites; the comments are the mitigation.
  const workflowCode = codeOnly(workflowSource);
  const buildCode = codeOnly(buildSource);

  it('wraps its body in runWithDb and calls runIndexBuild inside a step.do', () => {
    expect(workflowCode).toMatch(/runWithDb\(this\.env,/);
    expect(workflowCode).toMatch(/step\.do\(/);
    expect(workflowCode).toMatch(/runIndexBuild\(env, \{/);
  });

  it('runs NO review-job maintenance and never touches the cron active-jobs KV flag', () => {
    // An index build is not a review job. Setting that flag would wake Postgres every two minutes for
    // maintenance that has no index work to do.
    for (const code of [workflowCode, buildCode]) {
      expect(code).not.toMatch(/runBestEffortJobMaintenance/);
      expect(code).not.toMatch(/job-recovery/);
      expect(code).not.toMatch(/APP_KV/);
    }
  });

  it('adds no branch to any review phase-routing selector and imports nothing from core/review', () => {
    // Phase 20.1 spent eight plans hardening nextPhaseAfterReview / nextPhaseAfterCritic /
    // nextPhaseAfterVerifyFixes into canonical selectors; D-06 exists so the index build never becomes
    // a branch in them.
    for (const code of [workflowCode, buildCode]) {
      expect(code).not.toMatch(/nextPhaseAfter/);
      expect(code).not.toMatch(/from ['"](@server\/core\/review|\.\/review)['"]/);
    }
  });

  it("declares the index per-file estimate locally instead of importing the review path's", () => {
    expect(buildCode).toMatch(/export const ESTIMATED_SUBREQUESTS_PER_INDEX_FILE = 2;/);
    // The review constant is NAMED in the rationale comment on purpose (that is how the re-derivation
    // is non-silent) but must never be imported or referenced as an identifier.
    expect(buildCode).not.toMatch(/\bESTIMATED_SUBREQUESTS_PER_FILE\b/);
  });
});

function readSource(relativePath: string): string {
  // Read through the bundler-agnostic route so this works under the node project without a fs alias.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(relativePath, 'utf8');
}

/**
 * Strip block and line comments so a "must not appear" assertion is about CODE. Deliberately naive: it
 * can also clip the tail of a string literal containing `//`, which is acceptable here because that can
 * only ever weaken an absence assertion for text these modules do not contain, never invent a match.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}
