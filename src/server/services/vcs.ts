import type { AppBindings } from '../env';
import { GithubAdapter } from '../vcs/github';
import { BitbucketAdapter } from '../vcs/bitbucket';
import type { VcsProvider } from '../vcs/types';

/**
 * Typed placeholder for features the VcsService declares but does not yet implement. As of Phase 11
 * NO current path throws this -- `forProvider({ provider: 'bitbucket' })` is now a live jobless
 * provider factory. The class is retained (exported) so callers / tests can `instanceof
 * NotImplementedError` to distinguish "intentionally not yet wired" from a genuine error, and so any
 * future not-yet-implemented branch has a typed signal to reuse.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * WR-07: the subrequest tracker shape both factory entry points accept, kept IDENTICAL to the shape
 * `GithubAdapter` / `GitHubService` / `GitHubClient` and `BitbucketAdapter` declare. `forRepo` and
 * `forProvider` are the only construction sites, so any field missing here is silently dropped on
 * the way into the adapter with no compile error -- which is precisely how the
 * `hasRemainingSafeBudget` budget guard could be defeated (`undefined === false` never fires).
 * Widen this alias, never one of the two signatures alone.
 */
export type TrackerLike = {
  incrementSubrequests(count?: number): void;
  hasRemainingSafeBudget?(needed?: number): boolean;
};

/**
 * The single branch point every VCS operation in `core/review.ts` dispatches through (FND-05),
 * structurally mirroring the `ModelService` strategy pattern in `services/model.ts` but shaped as
 * a factory (D-05) rather than an instantiable class: there is nothing to resolve/fallback across
 * per call the way models do -- the provider mapping is 1:1 per repo.
 *
 * Both entry points are `async` so that a real, potentially-rejecting provider/credential read
 * (Phase 4/5's Bitbucket adapter) never has to re-edit this highest-scrutiny seam later.
 */
export class VcsService {
  /**
   * Resolves the provider for an already-loaded job row (D-14, R-01 widening).
   *
   * Reads `job.repositoryVcsProvider` (a DB-derived value, NEVER request-derived; T-05-10):
   *   - 'bitbucket' -> `BitbucketAdapter.create(env, job, tracker)` -- the async factory reads +
   *     decrypts the per-repo credential. A rejection propagates upward, where the caller's
   *     lease-release try/catch (core/review.ts:388-394) absorbs it and releases the lease.
   *   - 'github' (default) -> `new GithubAdapter(env, job.installationId, tracker)`. Zero behavior
   *     change for the GitHub path; byte-identical to the prior implementation.
   */
  static async forRepo(
    env: AppBindings,
    // REV-C-3 / R-01: installationId is now nullable (Bitbucket rows carry null). The adapter
    // constructor still requires a string today; the Bitbucket branch lands in Wave 2 via the
    // GitHubAdapter-for-non-github rows guard. For now, a null installationId should never reach
    // this method (runReviewJob gates it via the R-02 widenings) -- pass through as '' defensively
    // so the typecheck stays clean while we wait for the Wave 2 adapter implementation.
    job: {
      installationId?: string | null;
      repositoryVcsProvider?: string | null;
      repositoryWorkspace?: string | null;
      // The head commit SHA the Bitbucket adapter needs for the Code Insights PUT + build-status
      // POST (updateStatusCheck). It is NOT carried under a single field name across callers: the
      // mapped PersistedReviewJob exposes it as `commitSha` (hex), while callers holding a raw job
      // row must hex-decode `commit_sha` and pass `headSha` explicitly. Normalize both below so the
      // adapter never posts to an empty `/commit//...` segment (BitbucketError 404).
      headSha?: string | null;
      commitSha?: string | null;
    },
    // WR-07: MUST include `hasRemainingSafeBudget?`. `forRepo`/`forProvider` are the ONLY places an
    // adapter is constructed, so a narrower type here silently discards the method on the way
    // through -- `GitHubClient`'s guard `this.tracker?.hasRemainingSafeBudget?.(1) === false` then
    // evaluates `undefined === false`, the per-comment fallback loop never stops, and the SAFE_MARGIN
    // rationale in core/github.ts becomes false with NO compile error. Same silent-forwarding
    // regression the comment at vcs/github.ts:52-53 warns about, one layer up.
    tracker?: TrackerLike,
  ): Promise<VcsProvider> {
    if (job.repositoryVcsProvider === 'bitbucket') {
      // Prefer an explicit headSha; fall back to the mapped job's commitSha (both are the PR head
      // commit — see webhook-bitbucket.ts:165/221 and core/bitbucket.ts:168). Without this the
      // adapter reads `this.job.headSha ?? ''` and posts Code Insights / build status to an empty
      // commit, which 404s in both the live finalize cosmetics path and the maintenance sweep.
      const headSha = job.headSha ?? job.commitSha ?? null;
      return BitbucketAdapter.create(
        env as AppBindings,
        { ...job, headSha } as Parameters<typeof BitbucketAdapter.create>[1],
        tracker,
      );
    }
    return new GithubAdapter(env, job.installationId ?? '', tracker);
  }

  /**
   * The no-job-row entry point (Open Q2, D-03) for callers that have `env` + a known provider but no
   * persisted job row yet — `resolveQueuedJob` (GitHub) AND the Phase 11 interactive handlers
   * (commands / Q&A / permission / identity), which must resolve a provider BEFORE any job row
   * exists. `tracker` is intentionally OPTIONAL and OMITTED by the pre-`runReviewJob` callers.
   *
   * Both providers are now live (Phase 11): 'github' builds a `GithubAdapter` (requires
   * `installationId`); 'bitbucket' builds a JOBLESS `BitbucketAdapter` via `BitbucketAdapter.create`
   * keyed on `{ workspace, repo }` (loading + decrypting the per-repo credential — REV: Codex
   * 11-02/11-03, OpenCode 11-06). A jobless provider carries a placeholder job (prNumber 0); the
   * comment/permission/identity methods take their own owner/repo/prNumber arguments and only use
   * the job for `repositoryWorkspace`, so the placeholder is inert for those paths.
   *
   * Call contract (Plan 06 constructs it, Plan 03/04 consume it): build the provider via
   * `VcsService.forProvider(env, { provider, installationId?, workspace, repo })` PLUS the matching
   * `BotIdentityResolver` (createGithubBotIdentityResolver / createBitbucketBotIdentityResolver),
   * then pass BOTH into `classifyComment`/`executeCommand` (Plan 03) and `answerQuestion` (Plan 04).
   */
  static async forProvider(
    env: AppBindings,
    opts: {
      provider: 'github' | 'bitbucket';
      installationId?: string;
      workspace?: string;
      repo?: string;
      headSha?: string;
    },
    // WR-07: same widening as `forRepo` -- see the note there.
    tracker?: TrackerLike,
  ): Promise<VcsProvider> {
    if (opts.provider === 'bitbucket') {
      if (!opts.workspace || !opts.repo) {
        throw new Error('VcsService.forProvider requires workspace and repo for bitbucket');
      }
      // JOBLESS provider: a minimal job-like object mirroring the forRepo Bitbucket branch, with a
      // placeholder prNumber (comment/permission/identity methods take prNumber as an argument and
      // never read job.prNumber). BitbucketAdapter.create reuses the EXISTING per-repo credential
      // decrypt path — it does not invent a new token source.
      const joblessJob = {
        id: `jobless:bitbucket:${opts.workspace}/${opts.repo}`,
        owner: opts.workspace,
        repo: opts.repo,
        prNumber: 0,
        repositoryVcsProvider: 'bitbucket' as const,
        repositoryWorkspace: opts.workspace,
        headSha: opts.headSha ?? null,
      };
      return BitbucketAdapter.create(
        env,
        joblessJob as Parameters<typeof BitbucketAdapter.create>[1],
        tracker,
      );
    }
    if (!opts.installationId) {
      throw new Error('VcsService.forProvider requires installationId for github');
    }
    return new GithubAdapter(env, opts.installationId, tracker);
  }
}