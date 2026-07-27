// Phase 29 / QA-IDX-01: the codebase index build's PHASE LOGIC and BUDGET CONSTANTS.
//
// The durable execution vehicle is src/server/workflows/index-build.ts. This split deliberately
// mirrors core/review.ts versus workflows/review.ts: the core module is a plain async function that
// returns an ACTION, and the Workflow class is the thin thing that interprets that action into
// step.do / step.sleep / a fresh-instance handoff. Keeping the decision logic out of the
// WorkflowEntrypoint is what makes it testable without a Workflows runtime.
//
// THIS MODULE DELIBERATELY DOES NOT TOUCH REVIEW-JOB MACHINERY (D-06). It does not import from or add
// a branch to any review phase-routing selector (nextPhaseAfterReview / nextPhaseAfterCritic /
// nextPhaseAfterVerifyFixes), it does not call the review path's best-effort job maintenance, and it
// does not set the `system:active_jobs` KV flag. Phase 20.1 spent eight plans hardening those
// selectors into canonical single sources; an unrelated `index` branch is exactly the routing hole
// those BLOCKERs documented, which is why the index build got its own Workflow binding instead.

import picomatch from 'picomatch';
import type { RepoConfig } from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import type { AppBindings } from '@server/env';
import { VcsService } from '@server/services/vcs';
import type { VcsProvider } from '@server/vcs/types';
import {
  claimCodeIndexBuildLease,
  countIndexedForSha,
  deleteCodeIndexChunksForPaths,
  getCodeIndexState,
  listIndexedPathsForSha,
  markCodeIndexBuildCompleted,
  markCodeIndexBuildFailed,
  markCodeIndexBuildStarted,
  markCodeIndexFileIndexed,
  releaseCodeIndexBuildLease,
  renewCodeIndexBuildLease,
  truncateCodeIndexForRepo,
  upsertCodeIndexChunks,
  type CodeIndexChunkInput,
  type CodeIndexSkipReason,
} from '@server/db/code-index';
import { getRepoConfigByRepositoryId } from '@server/db/repo-configs';
import {
  CODE_INDEX_MAX_FILE_BYTES,
  buildIndexTokens,
  chunkLines,
} from './code-index';
import { isGeneratedContent, isReviewableFile, parseUnifiedDiff } from './diff';
import { logger } from './logger';
import { scorePath } from './priority';
import { redactErrorMessage } from './audit-redact';
import { TokenTracker } from './token-tracker';

// ---------------------------------------------------------------------------------------------
// Budget constants
//
// Every value below is RE-DERIVED for an INDEX unit. None of them is imported from core/review.ts,
// and that is deliberate rather than an oversight: a review unit and an index unit cost different
// numbers of subrequests, and the standing v1.2 decision forbids changing a subrequest budget
// silently. Re-deriving here, with the derivation written down, is the non-silent form.
// ---------------------------------------------------------------------------------------------

// Estimated subrequest cost of indexing ONE FILE, used only to size how many files a single
// invocation may process given its remaining safe budget (see budgetAwareIndexFileLimit).
//
// The value is 2: one provider `getFileContent` call, plus one batched per-file DB write group (the
// multi-row upsertCodeIndexChunks insert and the markCodeIndexFileIndexed progress row, both of which
// travel over the same Hyperdrive connection and are counted as one unit here).
//
// RE-DERIVED DELIBERATELY, NOT INHERITED. core/review.ts's ESTIMATED_SUBREQUESTS_PER_FILE is 5, but
// almost all of that pays for walking a model fallback chain of up to ~3 providers plus the persisted
// review write plus the audit append. An index unit calls NO model at all (D-01: the index is Postgres
// full-text search, and the `AI` binding is deliberately unused by this phase), so importing 5 would
// under-use the budget by a factor of 2.5 and make every build take 2.5x as long in wall clock for no
// safety benefit.
//
// The arithmetic this value participates in is pinned by test/code-index-workflow.spec.ts, following
// the test/chunk-concurrency.spec.ts precedent. Raising it to 4 to "be safe" would halve
// MAX_INDEX_FILES_PER_INVOCATION to 6 and silently double every build's wall clock; the spec fails
// instead of letting that happen quietly.
export const ESTIMATED_SUBREQUESTS_PER_INDEX_FILE = 2;

// Yield between continuations of the SAME build. Carried over from core/review.ts's
// FRESH_INVOCATION_YIELD_SECONDS -- both the value AND its rationale, because the rationale is a
// property of the Cloudflare runtime rather than of the review path:
//
// Cloudflare only HIBERNATES a Workflow -- running -> waiting -> resume in a NEW invocation, with a
// fresh 50-subrequest budget -- when the step.sleep is long enough. A "very short" sleep keeps the
// instance warm in the SAME invocation, so the real subrequest budget ACCUMULATES across every
// continuation until it is exhausted and the whole build loops in one invocation until "Too many
// subrequests". 60 seconds is deliberately long enough to force hibernation, which is the entire
// mechanism that lets a 500-file build run at all.
export const INDEX_FRESH_INVOCATION_YIELD_SECONDS = 60;

// Ceiling on how many times ONE Workflow instance may reschedule the same build before handing off to
// a brand-new instance. A long-lived instance eventually stops hibernating between steps (the observed
// review-path failure), at which point its per-invocation budget never resets again and every
// subsequent step immediately hits the 50-subrequest cap. Handing off at this ceiling is what keeps a
// large repository's build making progress instead of stalling forever at ~90% indexed.
export const MAX_INDEX_CONTINUATIONS = 20;

// PER-INVOCATION FILE BATCH CEILING. Derived entirely from constants that already exist in this
// repository: TokenTracker has MAX_SUBREQUESTS = 50 and SAFE_MARGIN = 25, so a FRESH invocation's
// remainingSafeBudget() is 50 - 25 = 25; at ESTIMATED_SUBREQUESTS_PER_INDEX_FILE = 2 that funds
// floor(25 / 2) = 12 files.
//
// THIS IS A DIFFERENT BOUND FROM THE CONFIGURED `max_files`, AND CONFLATING THE TWO IS THE MISTAKE
// THIS NAMED CONSTANT EXISTS TO PREVENT. `review.interactive.qa.index.max_files` (default 500) is a
// TOTAL-WORK cap applied ONCE by selectIndexablePaths; this constant is how much of that total a
// SINGLE invocation may attempt. Handing `max_files` to budgetAwareIndexFileLimit would make the
// function return 12 no matter what, so the "a padded estimate cannot silently shrink the batch"
// invariant could never hold -- the assertion would be against a number the function can never
// return, and a future estimate change would sail through the suite.
export const MAX_INDEX_FILES_PER_INVOCATION = 12;

// LIVENESS FLOOR: an invocation always attempts at least this many files when work remains, even if
// budgetAwareIndexFileLimit already returned 0.
//
// Why this is necessary and not just defensive: runIndexBuild RE-ENUMERATES the candidate path set on
// every invocation (see the note on that in runIndexBuild), and enumeration itself spends subrequests
// -- 4 for GitHub (installation token + repository + branch + recursive tree), and potentially the
// whole safe budget for a Bitbucket repository whose paginated `/src` walk runs many pages. Without a
// floor, a repository whose enumeration alone drains remainingSafeBudget() to 0 would return "continue"
// forever having indexed nothing, and neither the continuation ceiling nor the fresh-instance handoff
// would help, because a fresh instance re-enumerates and drains the budget again.
//
// Overshooting by one file is safe by construction: remainingSafeBudget() reaching 0 means the
// SAFE_MARGIN reserve of 25 subrequests is still untouched below Cloudflare's hard cap of 50, and one
// file costs ~2. The floor spends a sliver of a 25-subrequest cushion to buy guaranteed monotonic
// progress, which is the right trade -- a build that never finishes is a worse outcome than a build
// that dips into the margin.
export const MIN_INDEX_FILES_PER_INVOCATION = 1;

// Build-lease window. Comfortably longer than one invocation's wall clock (a 12-file batch is a
// handful of provider calls) but far shorter than a whole build, so a crashed owner's lease expires
// and the repository becomes rebuildable instead of wedging forever. Renewed on every continuation
// that has more work to do.
export const INDEX_BUILD_LEASE_SECONDS = 15 * 60;

/**
 * How many files this invocation may process: the per-invocation batch ceiling, capped only by what
 * the remaining safe subrequest budget can actually cover. The direct analog of
 * core/review.ts's `budgetAwareFileLimit`.
 *
 * CALLERS PASS `MAX_INDEX_FILES_PER_INVOCATION` HERE -- never the configured `max_files`.
 * `selectIndexablePaths` has already applied `max_files` as the total-work cap; this function is about
 * one invocation's slice of that total.
 *
 * The pinned invariant is
 *   budgetAwareIndexFileLimit(25, MAX_INDEX_FILES_PER_INVOCATION) === MAX_INDEX_FILES_PER_INVOCATION
 * (25 being a fresh TokenTracker's remainingSafeBudget()). It exists so a future estimate change that
 * would silently shrink the batch -- and therefore quietly halve every build's throughput -- fails the
 * suite instead of going unnoticed. This is the `test/chunk-concurrency.spec.ts` precedent applied to
 * the index path.
 *
 * Floored at zero so a negative budget (possible if an adapter overspent) can never produce a negative
 * limit that a `for` bound would silently read as "no work".
 */
export function budgetAwareIndexFileLimit(remainingSafeBudget: number, batchFileLimit: number) {
  const budgetLimit = Math.floor(remainingSafeBudget / ESTIMATED_SUBREQUESTS_PER_INDEX_FILE);
  return Math.max(0, Math.min(batchFileLimit, budgetLimit));
}

/**
 * The Workflow instance id for a repository's index build: `code-index:{repositoryId}`.
 *
 * A SHARED EXPORTED HELPER rather than a string built at each call site, on purpose. THREE sites create
 * index-build instances -- the dashboard "Build index" endpoint (plan 29-08), the GitHub `push` branch
 * and the Bitbucket `repo:push` branch (plan 29-06) -- and the entire `instance.already_exists`
 * coalescing story depends on all three producing the SAME id for the same repository. Two
 * independently-constructed "stable per-repository" ids would never collide, so the duplicate trigger
 * would silently start a second build and only the durable lease would catch it; the instance-id layer
 * that the plans claim as defense in depth would be inert. Every creation site MUST call this.
 *
 * THE FRESH-INSTANCE HANDOFF DELIBERATELY DOES NOT USE THIS HELPER. A handoff must create a genuinely
 * NEW instance; keying it on this id would collide with the instance that is handing off and be dropped
 * as a benign duplicate, stalling the build at exactly the point the handoff exists to rescue.
 */
export function codeIndexInstanceId(repositoryId: number): string {
  return `code-index:${repositoryId}`;
}

/**
 * D-09's SINGLE SELECTION VOCABULARY: the same three ideas the review path uses, applied to bare paths.
 *
 * Keeps only paths `isReviewableFile` accepts (the built-in lockfile/minified skips plus the
 * repository's OWN `skip_files` globs), orders the survivors by descending `scorePath`, breaks ties
 * deterministically by path so a rerun produces the same ordering, and truncates to `maxFiles`.
 *
 * The operator-exclusion half is load-bearing beyond tidiness: a path the operator excluded from review
 * must not be indexed either, because an indexed path can be RETRIEVED INTO A PROMPT. Filtering at
 * index time is what makes that exclusion actually hold; filtering only at retrieval time would leave
 * the excluded content sitting in Postgres waiting for the next caller who forgets.
 *
 * `maxFiles` CAPS FETCHES, NOT STORED FILES. Generated-file detection is content-based
 * (`isGeneratedContent`), so a file must be fetched before it can be dropped -- a build that fetches
 * `max_files` files therefore stores at most, and usually fewer than, `max_files` files. Stated because
 * without that framing the worst-case build cost stops being a statable number, which is the whole
 * reason the cap exists.
 */
export function selectIndexablePaths(
  paths: readonly string[],
  reviewConfig: RepoConfig['review'] | undefined,
  maxFiles: number,
): string[] {
  const customMatchers = reviewConfig?.skip_files?.map((pattern) => picomatch(pattern, { dot: true })) ?? [];
  const survivors = paths.filter((path) => isReviewableFile(path, customMatchers));

  // ORDERING CONSEQUENCE OF PROVIDER TRUNCATION -- read this before reading the sort as a bug. This
  // sort runs on WHATEVER THE PROVIDER RETURNED. When listDefaultBranchTree reported `truncated`, the
  // provider already chose an ARBITRARY prefix of the tree, so the priority ordering is being applied
  // AFTER that cut: a high-priority path (an auth or crypto file) beyond the provider's cut is absent
  // from `paths` ENTIRELY rather than merely ranked low, and no amount of ranking here recovers it.
  //
  // This is DISCLOSED, not fixed. The prefix cannot be reordered after the provider chose it, and
  // re-walking per directory to beat truncation would cost thousands of subrequests against a
  // 50-per-invocation budget. The accepted mitigation is the `truncated` flag persisted on the
  // build-state row and rendered by the dashboard panel, so an operator on a very large repository
  // knows the index is a partial view. (Independently raised by two reviewers: Consensus Agreed
  // Concern 2 / OpenCode 29-03, Antigravity C-04. The same paragraph lives on the seam's doc comment
  // in vcs/types.ts, deliberately restated here at the site a reader would otherwise misread.)
  const ordered = [...survivors].sort((a, b) => {
    const byScore = scorePath(b) - scorePath(a);
    if (byScore !== 0) return byScore;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return ordered.slice(0, Math.max(0, Math.floor(maxFiles)));
}

/**
 * Everything the build needs WITHOUT a database identity lookup.
 *
 * Identity travels on the payload, mirroring how the review workflow carries its `phase` on the
 * payload while reading the rest of the job from the database. Per-file PROGRESS deliberately does NOT
 * travel here: it lives in `code_index_files`, because progress must survive a fresh-instance handoff
 * (D-05) and payload state does not -- a handoff creates a new instance with a new payload, so
 * anything on the payload restarts from its initial value.
 */
export type IndexBuildParams = {
  repositoryId: number;
  vcsProvider: 'github' | 'bitbucket';
  owner: string;
  repo: string;
  workspace?: string | null;
  installationId?: string | null;
  /** 'full' = dashboard-triggered rebuild (D-07); 'incremental' = push-triggered refresh (D-08). */
  mode: 'full' | 'incremental';
  /** Incremental only: the `compare` base, i.e. the previously completed `indexed_sha` (a COMMIT sha). */
  baseSha?: string | null;
  /** Incremental only: the `compare` head, i.e. the pushed default-branch commit sha. */
  headSha?: string | null;
  workflowInstanceId: string;
  /** How many times THIS instance has already rescheduled this build. Starts at 0. */
  continuation: number;
};

/**
 * The action the durable loop interprets, shaped like `ReviewJobRunResult`.
 *
 *  - `ack` is TERMINAL: the build finished, was inert because the toggle is off, was coalesced away by
 *    a live foreign lease, or had nothing left to do. `reason` is carried so a caller (and a spec) can
 *    distinguish those without reading logs -- "coalesced" and "completed" look identical otherwise,
 *    which is exactly the ambiguity that makes a "the rebuild did not clear the old chunks" report
 *    impossible to diagnose.
 *  - `continue` means there is more work: the loop sleeps `delaySeconds` and calls back. `freshInstance`
 *    asks the loop to hand off to a brand-new Workflow instance instead, because this one can no longer
 *    obtain a clean per-invocation subrequest budget.
 *  - `retry` means a TRANSIENT failure that has NOT been recorded as a terminal build failure; the loop
 *    sleeps and calls back with the same continuation.
 */
export type IndexBuildRunResult =
  | { action: 'ack'; reason: 'completed' | 'disabled' | 'coalesced' | 'nothing_to_do' }
  | { action: 'continue'; delaySeconds: number; freshInstance?: boolean }
  | { action: 'retry'; delaySeconds: number };

/** UTF-8 byte length, for the per-file size cap (the cap is a byte cap, not a character cap). */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Classify a caught error as transient, using the same shared vocabulary the review path uses. */
function isTransientBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (lower.length === 0) return false;
  // A timeout is deliberately NOT transient here, matching isRetryableFileReviewErrorMessage: retrying
  // a timeout just spends the retry budget re-timing-out.
  if (isTimeoutMessage(lower)) return false;
  return matchesAnyTransientSubstring(lower);
}

/**
 * Run one invocation's slice of a codebase index build (D-05).
 *
 * Resumable and budget-bounded: it processes at most one budget-sized batch of files, persists per-file
 * progress as it goes, and returns an action telling the durable loop whether to continue, hand off, or
 * stop. Called only from src/server/workflows/index-build.ts.
 */
export async function runIndexBuild(
  env: AppBindings,
  params: IndexBuildParams,
): Promise<IndexBuildRunResult> {
  const log = logger.withContext({
    indexBuild: true,
    repositoryId: params.repositoryId,
    mode: params.mode,
    continuation: params.continuation,
    workflowInstanceId: params.workflowInstanceId,
  });

  // PER-INVOCATION BY DESIGN, and deliberately not persisted. Cloudflare's 50-subrequest limit is
  // itself per-invocation, so this tracker's remainingSafeBudget() only ever governs how many files
  // THIS invocation may process. A post-hibernation resume, and a fresh-instance handoff, both
  // legitimately start from a clean budget -- carrying a running total across them would throttle a
  // build against a limit that no longer applies (review: OpenCode 29-05 #3).
  const tracker = new TokenTracker();

  // NREG-01: the config gate runs FIRST and returns BEFORE any provider call, any lease claim and any
  // DB write, so the INDEX_WORKFLOW binding is completely inert for a repository whose operator has not
  // opted in. A repository with no per-repo config row at all also lands here, because the schema
  // default for `enabled` is false.
  const configRecord = await getRepoConfigByRepositoryId(env, params.repositoryId);
  const reviewConfig = configRecord?.parsedJson.review;
  const indexConfig = reviewConfig?.interactive?.qa?.index;
  if (!indexConfig?.enabled) {
    log.info('Codebase index build skipped: index is not enabled for this repository');
    return { action: 'ack', reason: 'disabled' };
  }

  if (params.mode === 'incremental' && (!params.baseSha || !params.headSha)) {
    // A caller bug, not a runtime condition: raised before the lease is claimed so a malformed trigger
    // cannot leave a lease behind for the expiry window to clean up.
    throw new Error('runIndexBuild: incremental mode requires both baseSha and headSha');
  }

  // THE CONCURRENCY GUARD (D-05 / T-29-05-04). A dashboard press and a push event can race, and two
  // builds writing the same (repository_id, path, chunk_start) rows at two different shas produce an
  // index that is half of each commit. A failed claim is a BENIGN COALESCED DUPLICATE -- the same
  // disposition `instance.already_exists` already gets elsewhere in this codebase -- not an error.
  const claimed = await claimCodeIndexBuildLease(env, {
    repositoryId: params.repositoryId,
    workflowInstanceId: params.workflowInstanceId,
    leaseSeconds: INDEX_BUILD_LEASE_SECONDS,
  });
  if (!claimed) {
    // LOG BEFORE RETURNING, never return silently (review: Antigravity C-02). A silent coalesce is
    // indistinguishable in the logs from a build that ran and found nothing to do -- which is precisely
    // what makes a "the branch-creation rebuild did not clear the old chunks" report impossible to
    // diagnose after the fact.
    log.info('Codebase index build coalesced: another build holds the lease for this repository', {
      repositoryId: params.repositoryId,
      reason: 'lease_held_by_another_instance',
    });
    return { action: 'ack', reason: 'coalesced' };
  }

  try {
    const provider = await VcsService.forProvider(
      env,
      {
        provider: params.vcsProvider,
        installationId: params.installationId ?? undefined,
        workspace: params.workspace ?? params.owner,
        repo: params.repo,
      },
      tracker,
    );

    const isFirstInvocation = params.continuation === 0;

    // ENUMERATION RUNS ON EVERY INVOCATION, not only the first. The candidate path set is not persisted
    // anywhere, and it deliberately does not travel on the payload (see IndexBuildParams), so a
    // continuation has to re-derive it. selectIndexablePaths is deterministic, so the same tree yields
    // the same ordering and the resumability subtraction below lands on the right remainder. The cost
    // of re-enumerating is why MIN_INDEX_FILES_PER_INVOCATION exists.
    const enumerated = await enumerateCandidates(provider, params, reviewConfig, indexConfig.max_files, log);

    // The build's sha is FROZEN AT THE FIRST INVOCATION and read back from `building_sha` afterwards.
    // Re-reading the freshly enumerated sha on a continuation would silently re-target the build at a
    // newer commit mid-run, so half the index would describe one commit and half another. This is also
    // where the accepted limitation lives: a push landing mid-build is coalesced away and the finished
    // index reflects the commit the build STARTED from, not the newest one (freshness then depends on
    // the next push; D-15 already fails Q&A open on staleness).
    let buildingSha = enumerated.sha;
    let indexedRef = enumerated.ref;

    if (!isFirstInvocation) {
      const state = await getCodeIndexState(env, { repositoryId: params.repositoryId });
      buildingSha = state?.building_sha ?? buildingSha;
      indexedRef = state?.indexed_ref ?? indexedRef;
    }

    // RESUMABILITY (D-05): read at the IN-PROGRESS sha, never at `indexed_sha`. At the in-progress sha
    // this answers "what has THIS build already fetched"; at the last completed sha it would answer
    // "what did the PREVIOUS build fetch", so a resumed build would skip files whose content has since
    // changed and quietly keep serving stale windows for them.
    //
    // Read BEFORE the destructive reset below, because it is also the second of the two guards that
    // stop that reset from destroying live progress.
    const alreadyIndexed = new Set(
      await listIndexedPathsForSha(env, {
        repositoryId: params.repositoryId,
        indexedSha: buildingSha,
      }),
    );

    if (isFirstInvocation) {
      await markCodeIndexBuildStarted(env, {
        repositoryId: params.repositoryId,
        mode: params.mode,
        indexedRef,
        buildingSha,
        workflowInstanceId: params.workflowInstanceId,
        leaseSeconds: INDEX_BUILD_LEASE_SECONDS,
      });

      // THE ORDERING HERE IS LOAD-BEARING, AND IT IS GUARDED TWICE.
      //
      // `truncateCodeIndexForRepo` and `deleteCodeIndexChunksForPaths` are LEASE-AGNOSTIC PRIMITIVES by
      // contract (see the header comment on that section of db/code-index.ts) -- they neither check nor
      // take the lease, because three callers have three different lease stories. Nothing but this call
      // site prevents a coalesced duplicate from truncating an index a live build is still writing,
      // which is why the destructive step sits AFTER the successful claim above.
      //
      // GUARD 1 is `isFirstInvocation` (continuation === 0). GUARD 2 is "no progress rows exist at the
      // sha we are about to build". Guard 2 is not redundant belt-and-braces: the fresh-instance handoff
      // in workflows/index-build.ts creates a NEW Workflow instance for a build that is already half
      // done, and if that handoff ever passed continuation 0 -- the natural-looking thing to write --
      // guard 1 alone would truncate away everything the previous instance indexed and the build would
      // restart from zero on every handoff, i.e. never finish on a repository large enough to need one.
      // Guard 2 makes the destructive reset safe regardless of what a future caller puts on the payload.
      //
      // Consequence worth naming: re-triggering a full rebuild at a sha that already has partial
      // progress RESUMES it rather than starting over. That is the D-05 resumability contract, not a
      // missed truncate -- the stale-rows case a rebuild actually needs to clear is a PREVIOUS sha's
      // rows, and those have no progress row at this sha so guard 2 lets the truncate through.
      if (alreadyIndexed.size > 0) {
        log.info('Resuming an interrupted codebase index build; skipping the destructive reset', {
          alreadyIndexedAtBuildingSha: alreadyIndexed.size,
          buildingSha,
        });
      } else if (params.mode === 'full') {
        const removed = await truncateCodeIndexForRepo(env, { repositoryId: params.repositoryId });
        log.info('Codebase index cleared for full rebuild', {
          deletedChunks: removed.deletedChunks,
          deletedFiles: removed.deletedFiles,
        });
      } else {
        await deleteCodeIndexChunksForPaths(env, {
          repositoryId: params.repositoryId,
          paths: enumerated.candidates,
        });
      }
    }

    const remaining = enumerated.candidates.filter((path) => !alreadyIndexed.has(path));

    if (remaining.length === 0) {
      return await finishBuild(env, params, {
        buildingSha,
        indexedRef,
        truncated: enumerated.truncated,
        log,
      });
    }

    // PASS THE BATCH CEILING, NEVER THE CONFIGURED max_files. `max_files` was already applied by
    // selectIndexablePaths as the total-work cap; see MAX_INDEX_FILES_PER_INVOCATION's comment.
    const budgetLimit = budgetAwareIndexFileLimit(
      tracker.remainingSafeBudget(),
      MAX_INDEX_FILES_PER_INVOCATION,
    );
    const fileLimit = Math.max(budgetLimit, MIN_INDEX_FILES_PER_INVOCATION);

    let processed = 0;
    for (const path of remaining) {
      if (processed >= fileLimit) break;
      // Mid-batch budget exhaustion yields rather than overspending -- but only once at least one file
      // has landed, so the liveness floor above is not undone on the very first iteration.
      if (processed > 0 && tracker.remainingSafeBudget() < ESTIMATED_SUBREQUESTS_PER_INDEX_FILE) break;

      await indexOneFile(env, provider, params, {
        path,
        buildingSha,
        chunkLineCount: indexConfig.chunk_lines,
      });
      // The second half of ESTIMATED_SUBREQUESTS_PER_INDEX_FILE: the provider read is counted by the
      // adapter's own tracker, the per-file DB write group is counted here.
      tracker.incrementSubrequests(1);
      processed += 1;
    }

    if (processed >= remaining.length) {
      return await finishBuild(env, params, {
        buildingSha,
        indexedRef,
        truncated: enumerated.truncated,
        log,
      });
    }

    await renewCodeIndexBuildLease(env, {
      repositoryId: params.repositoryId,
      workflowInstanceId: params.workflowInstanceId,
      leaseSeconds: INDEX_BUILD_LEASE_SECONDS,
    });

    const freshInstance = params.continuation >= MAX_INDEX_CONTINUATIONS;
    log.info('Codebase index build continuing', {
      indexedThisInvocation: processed,
      remainingAfterThisInvocation: remaining.length - processed,
      freshInstance,
    });
    return {
      action: 'continue',
      delaySeconds: INDEX_FRESH_INVOCATION_YIELD_SECONDS,
      ...(freshInstance ? { freshInstance: true } : {}),
    };
  } catch (error) {
    if (isTransientBuildError(error)) {
      // A transient provider/network failure is NOT a terminal build failure: leave the state row
      // reading `building` and let the loop come back, rather than marking `failed` and making the
      // operator panel cry wolf for something that clears in seconds.
      log.warn('Codebase index build hit a transient failure; retrying', {
        reason: redactErrorMessage(error instanceof Error ? error : String(error)),
      });
      return { action: 'retry', delaySeconds: INDEX_FRESH_INVOCATION_YIELD_SECONDS };
    }

    // AUD-01: `last_error` is operator-visible and db/ cannot redact (it must not import core/), so the
    // redaction happens HERE, at the only call site, before the message reaches the DB module. What
    // lands in the column is a machine reason code, never a provider response body or a stack frame.
    const redacted = redactErrorMessage(error instanceof Error ? error : String(error));
    try {
      await markCodeIndexBuildFailed(env, {
        repositoryId: params.repositoryId,
        message: redacted,
      });
      await releaseCodeIndexBuildLease(env, {
        repositoryId: params.repositoryId,
        workflowInstanceId: params.workflowInstanceId,
      });
    } catch (bookkeepingError) {
      log.error(
        'Failed to record codebase index build failure',
        bookkeepingError instanceof Error ? bookkeepingError : new Error(String(bookkeepingError)),
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

type EnumeratedCandidates = {
  ref: string | null;
  sha: string;
  truncated: boolean;
  candidates: string[];
};

/**
 * Derive this build's candidate path set, the ref it belongs to and the commit sha its content is read
 * at. Full rebuilds enumerate the default-branch tree; incremental refreshes derive the changed set
 * from the existing Phase 17 `getCompareDiff` primitive.
 */
async function enumerateCandidates(
  provider: VcsProvider,
  params: IndexBuildParams,
  reviewConfig: RepoConfig['review'] | undefined,
  maxFiles: number,
  log: ReturnType<typeof logger.withContext>,
): Promise<EnumeratedCandidates> {
  if (params.mode === 'incremental') {
    const rawDiff = await provider.getCompareDiff(
      params.owner,
      params.repo,
      params.baseSha!,
      params.headSha!,
    );
    // parseUnifiedDiff returns FileDiff[], NOT string[] -- map `.path` off each entry. (Cross-AI review
    // flagged this call as possibly returning a path array; it does not, and assigning it to a
    // string[] would type-check nowhere but would silently produce object-shaped "paths" if it were
    // ever loosened.)
    const changedPaths = parseUnifiedDiff(rawDiff, reviewConfig).map((file) => file.path);
    return {
      ref: null,
      sha: params.headSha!,
      truncated: false,
      candidates: selectIndexablePaths(changedPaths, reviewConfig, maxFiles),
    };
  }

  const listing = await provider.listDefaultBranchTree(params.owner, params.repo);

  if (listing.truncated) {
    // THE ONLY PLACE BOTH NUMBERS ARE IN SCOPE, which is why this warning lives in the build and not in
    // the adapter (review: OpenCode 29-03 #17). An operator seeing it knows the index covers an
    // arbitrary prefix of a tree larger than the provider would enumerate, rather than the whole
    // repository -- see the ordering note on selectIndexablePaths.
    log.warn('Provider tree listing was truncated; the index will cover a partial tree', {
      returnedPathCount: listing.paths.length,
      configuredMaxFiles: maxFiles,
      truncated: true,
    });
  }

  return {
    ref: listing.ref,
    sha: listing.sha,
    truncated: listing.truncated,
    candidates: selectIndexablePaths(listing.paths, reviewConfig, maxFiles),
  };
}

/**
 * Fetch, classify, chunk and persist ONE file, then record its progress.
 *
 * Every outcome -- including every skip -- writes a `code_index_files` row. A zero-chunk file that is
 * NOT recorded would never appear in `listIndexedPathsForSha`, so every continuation would re-fetch it,
 * spend a subrequest on it, drop it again and make no progress, forever, until the continuation ceiling
 * killed the build (see markCodeIndexFileIndexed's contract).
 */
async function indexOneFile(
  env: AppBindings,
  provider: VcsProvider,
  params: IndexBuildParams,
  input: { path: string; buildingSha: string; chunkLineCount: number },
): Promise<void> {
  const record = (chunkCount: number, skipReason: CodeIndexSkipReason | null) =>
    markCodeIndexFileIndexed(env, {
      repositoryId: params.repositoryId,
      path: input.path,
      indexedSha: input.buildingSha,
      chunkCount,
      skipReason,
    });

  // Read at the BUILD's sha, not at the branch name: a push landing mid-build must not change what this
  // build stores, or the index would describe two different commits at once.
  const content = await provider.getFileContent(
    params.owner,
    params.repo,
    input.path,
    input.buildingSha,
  );

  if (content === null) {
    // The provider 404'd: the path was in the tree listing but is not readable at this commit (a race
    // with a force-push, a submodule pointer, a permissions edge).
    await record(0, 'unreadable');
    return;
  }
  if (content.length === 0) {
    await record(0, 'empty');
    return;
  }
  // Character length is a cheap lower bound on byte length, so it short-circuits the common case without
  // encoding a megabyte to find out.
  if (content.length > CODE_INDEX_MAX_FILE_BYTES || utf8ByteLength(content) > CODE_INDEX_MAX_FILE_BYTES) {
    await record(0, 'oversized');
    return;
  }
  if (isGeneratedContent(content)) {
    // D-09's stated cost: generated detection is CONTENT-based, so the fetch above was already paid for.
    // That is exactly why the configured max-files value caps fetches rather than stored files.
    await record(0, 'generated');
    return;
  }

  const windows = chunkLines(content, input.chunkLineCount);
  if (windows.length === 0) {
    await record(0, 'empty');
    return;
  }

  // `pathTokens` is identical for every window of a file, so it is taken from the first window's
  // tokenization rather than recomputed (or computed from the whole file, which would scan the content
  // twice).
  const tokenized = windows.map((window) => ({ window, tokens: buildIndexTokens(input.path, window.content) }));
  const pathTokens = tokenized[0]!.tokens.pathTokens;
  const chunks: CodeIndexChunkInput[] = tokenized.map(({ window, tokens }) => ({
    chunkStart: window.start,
    chunkEnd: window.end,
    content: window.content,
    contentTokens: tokens.contentTokens,
  }));

  await upsertCodeIndexChunks(env, {
    repositoryId: params.repositoryId,
    path: input.path,
    indexedSha: input.buildingSha,
    pathTokens,
    chunks,
  });
  await record(chunks.length, null);
}

/** Terminal success: record the totals, release the lease, and tell the loop to stop. */
async function finishBuild(
  env: AppBindings,
  params: IndexBuildParams,
  input: {
    buildingSha: string;
    indexedRef: string | null;
    truncated: boolean;
    log: ReturnType<typeof logger.withContext>;
  },
): Promise<IndexBuildRunResult> {
  const counts = await countIndexedForSha(env, {
    repositoryId: params.repositoryId,
    indexedSha: input.buildingSha,
  });

  await markCodeIndexBuildCompleted(env, {
    repositoryId: params.repositoryId,
    indexedRef: input.indexedRef,
    indexedSha: input.buildingSha,
    fileCount: counts.fileCount,
    chunkCount: counts.chunkCount,
    truncated: input.truncated,
  });
  await releaseCodeIndexBuildLease(env, {
    repositoryId: params.repositoryId,
    workflowInstanceId: params.workflowInstanceId,
  });

  input.log.info('Codebase index build completed', {
    indexedSha: input.buildingSha,
    fileCount: counts.fileCount,
    chunkCount: counts.chunkCount,
    truncated: input.truncated,
  });
  return { action: 'ack', reason: 'completed' };
}
