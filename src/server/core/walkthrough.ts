// Streaming-walkthrough orchestration (Phase 9, Plan 09-02). Called from the two anchored
// review.ts call sites (placeholder in runPreparePhase; best-effort single edit in
// runFinalizePhase) and kept in its own module so the hottest file's diff stays minimal and the
// NREG-01 risk is isolated.
//
// This module owns THREE pure-ish concerns and NOTHING else:
//   1. postWalkthroughPlaceholder — idempotent placeholder create keyed on the durable
//      jobs.walkthrough_comment_ref (never Workflow memory), persisted the instant it posts.
//   2. buildWalkthroughData       — deterministic, pure aggregation of the main-pass file reviews.
//   3. editWalkthroughComment     — the single in-place edit, with delete-recovery + a bounded
//      in-invocation transient retry, carrying NO supersede / review.ts dependency.
//
// Deliberate NON-responsibilities (cross-AI blocker 4 — no core/ module cycle):
//   - It does NOT import heartbeatAndCheckSuperseded (or any other private review.ts symbol). The
//     supersede re-check stays INLINE in review.ts, so review.ts -> walkthrough.ts is the only edge
//     and core/ stays acyclic.
//   - editWalkthroughComment takes no leaseOwner and does no supersede logic.
//   - The mermaid seam is left `null` this plan; Plan 09-03 fills it without re-touching the seam.

import { logger } from './logger';
import type { AppBindings } from '@server/env';
import { updateJobWalkthroughCommentRef } from '@server/db/jobs';
import {
  reviewSeverities,
  type ParsedReviewComment,
  type RepoConfig,
  type ThreadVerificationTotals,
  type ThreadVerifications,
} from '@shared/schema';
import type { VcsProvider } from '../vcs/types';
import type { FormatterService } from '../services/formatter';

type Severity = ParsedReviewComment['severity'];

// Canonical severity ordering (P0 highest). Mirrors the ranks used in review.ts for min_severity /
// finalComments sorting so the walkthrough's "highest severity first" ordering matches the review.
const SEVERITY_RANKS: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

// Bounded in-invocation retry of the SINGLE walkthrough edit (cross-AI blocker 3). A transient
// provider error on editPrComment is retried within the invocation before giving up; a persistent
// failure throws out of editWalkthroughComment and the review.ts call site catches it best-effort
// (it must never fail the job). Kept tiny: this runs in the budget-fragile finalize phase and one
// edit per review is the contract (D-05) — the retry is a blip-smoother, not a backoff loop.
const EDIT_MAX_ATTEMPTS = 2;
const EDIT_RETRY_DELAY_MS = 200;

/** The minimal shape buildWalkthroughData consumes from a getFileReviewsForJobs row. */
export type WalkthroughReviewRow = {
  file_path: string;
  file_summary: string | null;
  file_status: 'pending' | 'done' | 'skipped' | 'failed';
  error_msg: string | null;
  verdict: 'approve' | 'comment' | null;
  // NULLABLE in the DB (001_initial.sql:83) even though getFileReviewsForJobs types it `number`;
  // the sort tiebreak uses `?? 0` (cross-AI LOW).
  diff_line_count: number | null;
  // file_reviews is unique on (job_id, file_path, pass); Phase 10 adds security-pass rows, so the
  // walkthrough filters pass === 'main' to keep exactly one row per file_path (D-02, forward-compat).
  pass: 'main' | 'security';
};

/** Durable thread-verification data projected into the PR walkthrough. */
export type WalkthroughThreadVerificationSummary =
  | { status: 'completed'; totals: ThreadVerificationTotals }
  | { status: 'degraded' };

/** Deterministic, provider-agnostic payload consumed by FormatterService.formatWalkthrough. */
export type WalkthroughData = {
  files: Array<{ path: string; summary: string; counts: Record<Severity, number> }>;
  severityCounts: Record<Severity, number>;
  filesReviewed: number;
  threadVerification?: WalkthroughThreadVerificationSummary;
};

/** The subset of a PersistedReviewJob these helpers read. */
type WalkthroughJob = {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  // `.nullable().optional()` on the jobSummary schema → optional + string | null.
  walkthroughCommentRef?: string | null;
};

function emptyCounts(): Record<Severity, number> {
  const counts = {} as Record<Severity, number>;
  for (const sev of reviewSeverities) counts[sev] = 0;
  return counts;
}

// First line only (buildWalkthroughData is not the escaping sink — Plan 01's formatMarkdownTableCell
// does the final `|`/backtick escaping + length cap at render time). We only need to collapse a
// multi-line file_summary down to its opening line here.
function firstLine(value: string): string {
  const nl = value.search(/\r?\n/);
  return (nl === -1 ? value : value.slice(0, nl)).trim();
}

// D-10: a clear in-progress line naming the file count. MUST read as transient — never look like a
// finished/empty walkthrough (an empty coverage table would). Reuses the same `### OpenCodra
// Walkthrough` heading formatWalkthrough emits so the edit swaps cleanly in place.
function buildPlaceholderBody(fileCount: number): string {
  const fileWord = `${fileCount} changed file${fileCount === 1 ? '' : 's'}`;
  return [
    '### OpenCodra Walkthrough',
    `_Reviewing ${fileWord}… the walkthrough will appear here shortly._`,
  ].join('\n\n');
}

/**
 * WT-01/WT-05: post the standalone placeholder comment exactly once and persist its opaque VCS ref
 * the instant it posts (Pitfall #4 — durability across fresh-instance handoff).
 *
 * Gated (NREG-01 / D-11): no-op unless walkthrough.enabled AND fileCount > 0.
 * Idempotent (Pattern 1): if job.walkthroughCommentRef is already set, a retried prepare does NOT
 * create a second comment.
 *
 * ACCEPTED RESIDUAL (WT-05 edge, Codex 09-02 HIGH): createPrComment (external) and
 * updateJobWalkthroughCommentRef (Postgres) are two independent, non-atomic ops. A create-success
 * followed by a ref-write throw leaves the ref unpersisted and can orphan the placeholder + let
 * finalize double-post. This is accepted this phase, NOT closed. We deliberately do NOT swallow the
 * ref-write failure here — it propagates to the prepare best-effort try/catch which LOGS it, so the
 * residual stays observable. The closing listPrComments job-id-marker scan is DEFERRED.
 */
export async function postWalkthroughPlaceholder(params: {
  env: AppBindings;
  job: WalkthroughJob;
  config: RepoConfig;
  fileCount: number;
  vcs: VcsProvider;
}): Promise<void> {
  const { env, job, config, fileCount, vcs } = params;

  if (!config.review.walkthrough.enabled) return;
  if (fileCount <= 0) return;
  // Idempotency: a ref already exists (retried prepare / fresh-instance handoff) -> never re-post.
  if (job.walkthroughCommentRef) return;

  const body = buildPlaceholderBody(fileCount);
  const { ref } = await vcs.createPrComment(job.owner, job.repo, job.prNumber, body);
  // Persist immediately (Pitfall #4). Intentionally NOT wrapped in try/catch — see the ACCEPTED
  // RESIDUAL note above: the failure must surface to the caller's best-effort log, not be swallowed.
  await updateJobWalkthroughCommentRef(env, job.id, ref);
}

function projectThreadVerification(
  result: ThreadVerifications | null | undefined,
): WalkthroughThreadVerificationSummary | undefined {
  if (!result) return undefined;

  // Only a completed durable result may claim successful counts. A fail-open/in-flight result, or a
  // logically impossible resolved count, is rendered as degraded rather than fabricating zeros or
  // silently clamping persisted data (D-02/D-04, T-19-03-02).
  if (result.status !== 'completed' || result.totals.resolved > result.totals.fixed) {
    return { status: 'degraded' };
  }

  return {
    status: 'completed',
    totals: {
      fixed: result.totals.fixed,
      unfixed: result.totals.unfixed,
      unverifiable: result.totals.unverifiable,
      resolved: result.totals.resolved,
    },
  };
}

/**
 * WT-02/WT-04: deterministic, pure aggregation. FIRST filters `pass === 'main'` (getFileReviewsForJobs
 * returns all passes; uniqueness is (job_id, file_path, pass), so filtering main keeps exactly one row
 * per file_path even once Phase 10 adds security-pass rows). Produces:
 *   - files:          one entry per main-pass reviewed file (path, one-line summary, per-file counts),
 *                     sorted by highest severity present then most-changed (diff_line_count ?? 0).
 *   - severityCounts: per-severity totals over finalComments (mirrors review.ts:1416-1419).
 *   - filesReviewed:  the main-pass reviews length.
 *
 * Option A (recorded in Plan 01): the per-file line reuses file_reviews.file_summary read-only — no
 * new model call, no file_summary mutation, no migration. A failed row uses the same `Review failed:`
 * text as review.ts:1337; an empty summary still yields a coverage row (D-02 deterministic fallback).
 */
export function buildWalkthroughData(params: {
  reviews: WalkthroughReviewRow[];
  finalComments: ParsedReviewComment[];
  threadVerification?: ThreadVerifications | null;
}): WalkthroughData {
  const { reviews, finalComments, threadVerification } = params;

  // Filter to the main pass BEFORE aggregating (cross-AI MEDIUM, WT-04 adjacency).
  const mainReviews = reviews.filter((review) => review.pass === 'main');

  // Per-file counts: group finalComments by path.
  const countsByPath = new Map<string, Record<Severity, number>>();
  for (const comment of finalComments) {
    let counts = countsByPath.get(comment.path);
    if (!counts) {
      counts = emptyCounts();
      countsByPath.set(comment.path, counts);
    }
    counts[comment.severity] = (counts[comment.severity] ?? 0) + 1;
  }

  // Per-severity totals over finalComments (mirrors review.ts:1416-1419).
  const severityCounts = emptyCounts();
  for (const comment of finalComments) {
    severityCounts[comment.severity] = (severityCounts[comment.severity] ?? 0) + 1;
  }

  const files = mainReviews.map((review) => {
    const rawSummary = review.file_status === 'failed'
      ? `Review failed: ${review.error_msg ?? 'Unknown file review error'}`
      : (review.file_summary ?? '');
    return {
      path: review.file_path,
      summary: firstLine(rawSummary),
      counts: countsByPath.get(review.file_path) ?? emptyCounts(),
      // Kept only for the sort below; not part of the rendered row.
      _diffLineCount: review.diff_line_count ?? 0,
    };
  });

  // Highest severity present first, then most-changed (diff_line_count ?? 0) as tiebreak, so the
  // Plan 01 WALKTHROUGH_FILE_CAP keeps the most important rows (D-04, WT-04 ordering).
  const bestRank = (counts: Record<Severity, number>): number => {
    for (const sev of reviewSeverities) {
      if ((counts[sev] ?? 0) > 0) return SEVERITY_RANKS[sev];
    }
    return Number.POSITIVE_INFINITY; // no findings -> sorts after any file with findings
  };
  files.sort((a, b) => {
    const rankDelta = bestRank(a.counts) - bestRank(b.counts);
    if (rankDelta !== 0) return rankDelta;
    return b._diffLineCount - a._diffLineCount;
  });

  const threadVerificationSummary = projectThreadVerification(threadVerification);

  return {
    files: files.map(({ path, summary, counts }) => ({ path, summary, counts })),
    severityCounts,
    filesReviewed: mainReviews.length,
    ...(threadVerificationSummary ? { threadVerification: threadVerificationSummary } : {}),
  };
}

// Bounded in-invocation retry of the single edit. A THROWN error is transient and retried; a `null`
// return is delete-recovery (a normal branch, NOT a failure) and is returned immediately so the
// caller can re-post. Throws the last error only once the attempt budget is exhausted.
async function editPrCommentWithRetry(
  vcs: VcsProvider,
  owner: string,
  repo: string,
  ref: string,
  body: string,
): Promise<{ ref: string } | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EDIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await vcs.editPrComment(owner, repo, ref, body);
    } catch (error) {
      lastError = error;
      logger.warn(
        `walkthrough editPrComment attempt ${attempt}/${EDIT_MAX_ATTEMPTS} failed`,
        error instanceof Error ? error : new Error(String(error)),
      );
      if (attempt < EDIT_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, EDIT_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * WT-01/WT-05: edit the single placeholder comment in place into the complete walkthrough.
 *
 * Gated (NREG-01): no-op unless walkthrough.enabled. Renders the body via formatWalkthrough (Plan 01,
 * provider-aware, mermaid GitHub-only). Branches on the durable ref:
 *   - ref present, edit succeeds -> done (one edit per review, D-05).
 *   - ref present, edit returns null (deleted, 404/410 per Phase 8 D-05) -> re-post + update ref
 *     (WT-05 delete-recovery); the job never fails.
 *   - no ref (defensive — placeholder never posted) -> create + persist.
 *
 * Carries NO supersede / review.ts dependency (cross-AI blocker 4): the supersede re-check is done
 * INLINE in review.ts before this is called. May throw on an exhausted transient retry — the review.ts
 * call site catches it best-effort (it must never fail the job).
 *
 * `mermaid` defaults null this plan; Plan 09-03 fills it without re-touching this seam.
 */
export async function editWalkthroughComment(params: {
  env: AppBindings;
  job: WalkthroughJob;
  config: RepoConfig;
  vcs: VcsProvider;
  formatter: FormatterService;
  data: WalkthroughData;
  mermaid?: string | null;
}): Promise<void> {
  const { env, job, config, vcs, formatter, data, mermaid = null } = params;

  if (!config.review.walkthrough.enabled) return;

  const body = formatter.formatWalkthrough({ ...data, mermaid }, { provider: vcs.name });

  const ref = job.walkthroughCommentRef;
  if (ref) {
    const result = await editPrCommentWithRetry(vcs, job.owner, job.repo, ref, body);
    if (result) return; // edited in place
    // null -> the human deleted the comment: re-post and re-point the durable ref (WT-05).
    const created = await vcs.createPrComment(job.owner, job.repo, job.prNumber, body);
    await updateJobWalkthroughCommentRef(env, job.id, created.ref);
    return;
  }

  // Defensive: no ref at all (placeholder never posted) -> create + persist.
  const created = await vcs.createPrComment(job.owner, job.repo, job.prNumber, body);
  await updateJobWalkthroughCommentRef(env, job.id, created.ref);
}
