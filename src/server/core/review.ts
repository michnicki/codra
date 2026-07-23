import { logger } from './logger';
import { isSupportedGitHubWebhookEvent, type GitHubWebhookEventName, type GitHubWebhookPayload, type IssueCommentWebhookPayload, type PullRequestWebhookPayload } from '@shared/github';
import { defaultRepoConfig, normalizeModelId, reviewUnitKey, type CriticResult, type FileReviewPass, type JobAuditEvent, type ParsedReviewComment, type RepoConfig, type ReviewJobMessage } from '@shared/schema';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';
import type { AppBindings } from '@server/env';
import { bulkInheritFileReviews, bulkMarkFilesFailed, getFileReviewsForJobs, recordRetryableFileReviewFailure, upsertFileReview } from '@server/db/file-reviews';
import { getResolvedModelConfig } from '@server/db/model-configs';
import {
  claimJobLease,
  completeJob,
  completePreparationStep,
  failJob,
  findExistingJobForHead,
  getJobForProcessing,
  getOtherRunningJobsCount,
  heartbeatJobLease,
  insertJob,
  mapJob,
  markJobCheckRunCompleted,
  markJobContinuationQueued,
  resetJobContinuationCount,
  releaseJobLease,
  setJobDiffSelection,
  setJobPullRequestMeta,
  setJobReviewRoundAndMode,
  setJobWorkflowInstance,
  supersedeOlderJobs,
  updateJobCheckRun,
  updateJobCriticResult,
  updateJobStatusCheckRef,
  updateJobStep,
} from '@server/db/jobs';
import { getPrReviewState, setLastReviewedSha, type PrReviewStateKey } from '@server/db/pr-review-state';
import { filterReviewableFiles, parseUnifiedDiff, partitionReviewableFiles, selectReviewableFiles, type FileDiff, type FileSelectionResult } from './diff';
import { insertSkippedFiles, listSkippedFilesForHead, type SkippedFilesHeadKey } from '@server/db/skipped-files';
import { dedupeComposite, dedupeFindings } from './dedup';
import { applyNoiseFilter, type NoiseFilterOptions } from './noise-filter';
import { parseCriticPruneResponse, parseSummaryResponse, parseWalkthroughDiagram } from './model-output';
import { buildWalkthroughData, editWalkthroughComment, postWalkthroughPlaceholder } from './walkthrough';
import {
  buildFileSkipEvents,
  buildFinalizeDropEvents,
  recordFileSkips,
  recordFinalizeDrops,
  recordRoundAudit,
  recordUnitAudit,
} from './audit';
import {
  buildRoundInputsFromConfig,
  buildRoundsDetectedEvent,
  buildRoundsEscalatedEvent,
  buildRoundsNoChangesEvent,
  composeRoundFloors,
  resolveRoundContext,
  selectDiffForRound,
  type DiffSelectionDescriptor,
} from './rounds';

import { VcsService } from '../services/vcs';
import type { VcsProvider, VcsPullRequest, VcsUpdateStatusCheckInput } from '../vcs/types';
import { isRetryableModelError, ModelService } from '../services/model';
import { FormatterService } from '../services/formatter';
import { TokenTracker } from './token-tracker';
import { loadRepoConfig } from './config';
import { getWebhookDelivery } from '@server/db/webhook-deliveries';
import { getReviewSettings } from '@server/db/app-settings';
import { REVIEW_CONCURRENCY_LIMITS } from '@shared/schema';

type PersistedReviewJob = ReturnType<typeof mapJob>;

export type ReviewJobRunResult =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number }
  // jobId is the RESOLVED job id (not the delivery id): mention-triggered jobs don't carry a jobId
  // in the queue message, so the workflow can't otherwise know it. The workflow uses it to re-enqueue
  // the next phase as a fresh instance.
  //
  // freshInstance signals the workflow to run the next phase in a BRAND-NEW instance rather than
  // continuing this one. It's set when the current instance can't get a usable per-invocation
  // subrequest budget anymore: either a subrequest-limit deferral (a long-lived instance has stopped
  // hibernating, so its budget never resets) or the transition into finalize (which needs ~20
  // subrequests at once to post the review). A fresh instance's first step always gets a clean budget.
  | { action: 'next_phase'; phase: 'prepare' | 'review' | 'finalize' | 'critic'; delaySeconds: number; jobId?: string; freshInstance?: boolean };

const REVIEW_CHUNK_WALL_CLOCK_MS = 12 * 60 * 1000;
const JOB_LEASE_SECONDS = 15 * 60;
const BUSY_RETRY_SECONDS = 60;
// Backoff between deferred retries of a file that hit a transient model/provider failure.
// Kept short at first: most observed failures are momentary provider load (Gemini 500/503
// "high demand") or self-inflicted connection queuing, both of which clear within seconds,
// so a long first delay just makes reviews grind. Later attempts back off harder in case the
// provider really is having an outage.
const RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS = [30, 2 * 60, 5 * 60];
// Yield used when a review chunk / phase transition MUST run in a fresh Worker invocation to get a
// fresh per-invocation subrequest budget (Workers Free: 50/invocation). Cloudflare only hibernates
// a Workflow -- running -> waiting -> resume in a NEW invocation -- when the step.sleep is long
// enough; a "very short" sleep keeps the instance warm in the SAME invocation, so the real
// subrequest budget accumulates across every chunk until it's exhausted and the whole review loops
// in one invocation until "Too many subrequests" (the observed failure). This yield is deliberately
// long enough to force hibernation so each continuation starts with a clean budget. It is only
// applied when a fresh budget is actually needed (multi-chunk reviews, budget-pressured finalize),
// so small PRs that fit in a single invocation stay fast.
const FRESH_INVOCATION_YIELD_SECONDS = 60;
// Delay between polls of an in-flight Workers AI async batch review. Batches typically complete
// within a few minutes, so poll on a short cadence; a stuck batch is bounded by the shared
// MAX_JOB_CONTINUATIONS ceiling (each poll reschedule counts as a no-progress continuation).
const ASYNC_BATCH_POLL_DELAY_SECONDS = 20;
const MAX_RETRYABLE_FILE_REVIEW_FAILURES = 3;
// Belt-and-suspenders ceiling on how many times a job may reschedule the *same* phase without
// completing a single file (see markJobContinuationQueued / resetJobContinuationCount). The
// per-file cap above is the primary bound and resets this counter on any progress, so a healthy
// job never approaches this; it only fires when a job is genuinely wedged (e.g. a provider is
// down for the whole backoff window) and stops it from churning for hours before finalizing.
const MAX_JOB_CONTINUATIONS = 20;
// Finalize gets a much lower reschedule ceiling than review. Unlike review (which makes real
// progress one file at a time and legitimately spans many continuations), finalize is a short,
// self-contained phase: on a fresh invocation it either fits the subrequest budget and posts, or
// it doesn't. Retrying it a few times covers a transient budget miss (a reschedule that lands on a
// genuinely fresh invocation), but if a saturated long-lived workflow instance can't give finalize
// a clean budget, more retries won't help -- so cap them low and fail fast (the check-run reconciler
// and an inheriting re-run recover) instead of churning ~20 min against the shared ceiling.
const MAX_FINALIZE_CONTINUATIONS = 3;
// Critic skip threshold (D-06): a deduped candidate set this small isn't worth a model round-trip.
// The critic's value is triaging a LARGE finding set (deduping main+security noise); re-judging a
// handful of findings risks pruning a genuine issue for negligible noise reduction. At or below this
// count runCriticPhase keeps ALL findings and records { skipped: true } instead of calling the model.
// Overridable per-repo via passes.critic.skip_threshold; kept low so the critic still runs on any set
// big enough to plausibly contain duplicates.
const CRITIC_SKIP_THRESHOLD = 3;
// Critic input char budget (D-06): an upper bound on the serialized candidate set handed to the
// single whole-set critic call. Beyond this the prompt would risk the model's context window and this
// invocation's subrequest/latency budget — and the plan forbids CHUNKING the critic (a chunked critic
// can't reason about the whole set), so an oversized set fail-opens keep-all rather than being
// partially judged. ~50k chars comfortably fits a large multi-finding set while staying well inside a
// single model context. Overridable per-repo via passes.critic.input_char_budget.
const CRITIC_INPUT_CHAR_BUDGET = 50_000;
// A job's commit (and therefore its diff) never changes, so the raw diff can be
// cached for the job's entire lifetime instead of being re-fetched from GitHub on
// every prepare/review-chunk/finalize phase. 6h comfortably covers even a job that
// hits every retryable-failure backoff (up to 15 min each, several times over).
const DIFF_CACHE_TTL_SECONDS = 6 * 60 * 60;
// Estimated subrequest cost of reviewing one (file, pass) WORK UNIT, used only to size how many
// units can safely run concurrently in a chunk given the job's remaining subrequest budget for
// this invocation (see budgetAwareFileLimit below). A unit walks a fallback chain of up
// to ~3 models, but the per-model model-config lookup is now cached per invocation
// (ModelService.resolveModel), so the recurring cost per unit is ~1 provider call per model
// tried plus the persisted-review write -- roughly 5 in the worst case rather than 9. Lower
// estimate => more units reviewed in parallel per chunk within the same 50-subrequest cap.
//
// PHASE 13 AUDIT-WRITE RE-DERIVATION (Codex HIGH, deliberate — the standing v1.2 decision forbids
// silently changing this budget): each completed (file,pass) unit now ALSO issues ONE combined audit
// append (core/audit.ts recordUnitAudit — a single DB write batching the unit's drafted + severity
// events, 13-03/13-04) ON TOP OF the persisted-review write. So the true worst-case per-unit cost is
// ~6, not ~5. The constant is KEPT AT 5 anyway, on purpose: at a fresh budget the max concurrency (4)
// runs cost 4 × 6 == 24, still <= the 25-subrequest safe budget (SAFE_MARGIN), so 4 concurrent units
// remain safe. Bumping the estimate to 6 to "account for" the audit write would make floor(22/6) == 3
// after even a 3-subrequest getPullRequest preamble and SILENTLY cap the concurrency slider below its
// max -- the exact "concurrency slider is dead above medium" regression chunk-concurrency.spec.ts
// guards -- for zero safety benefit (24 <= 25 already holds). This audit-append re-derivation is
// pinned non-silently by chunk-concurrency.spec.ts's `ESTIMATED_SUBREQUESTS_PER_FILE + 1` assertion.
//
// This is a per-(file,pass)-UNIT cost that governs CONCURRENCY (how many units run in one chunk),
// NOT a per-file cost. Phase 10's security pass is modelled as a SEPARATE (file,'security') unit
// alongside (file,'main'), so enabling it DOUBLES the unit-list LENGTH (more hibernating chunks),
// it does NOT raise this per-unit estimate. A single unit may still fan out internally to
// MAX_CHUNKS (=4) chunks inside ModelService.reviewFile, but that intra-unit fan-out is bounded
// WITHIN the unit by tracker.isNearLimit() (model.ts:320-337) -- the 5-estimate governs how many
// units run concurrently; the isNearLimit guard governs a single unit's internal chunk fan-out.
//
// Sized to the ~5 worst-case figure above (not padded higher): with the TokenTracker's
// SAFE_MARGIN reserve of 25 the fresh-budget headroom is 25, and 25 / 5 == 5 keeps even the
// highest configured concurrency level (max == 4) fully honored at a healthy budget. Padding
// this to 8 would make floor(25 / 8) == 3 silently cap the "max" slider to 3 -- the exact
// "concurrency slider is dead above medium" regression pinned by chunk-concurrency.spec.ts.
// Raising it to ~10 to "absorb" the second pass would make floor(25/10) == 2 cap the slider to 2:
// the second pass is absorbed by a longer unit list, never by a higher per-unit cost.
export const ESTIMATED_SUBREQUESTS_PER_FILE = 5;

/**
 * How many files a single review chunk may process concurrently: the configured concurrency
 * level, capped only by what the invocation's remaining subrequest budget can safely cover.
 *
 * The cap is deliberately sized so it does NOT silently override the user's chosen concurrency
 * at a healthy budget -- that would make the concurrency setting a no-op above the cap. It
 * only throttles once earlier failures in this invocation have actually eaten into the budget;
 * if there is not enough safe budget for one more file, the chunk yields and resumes in a fresh
 * invocation instead of gambling past the margin. Any files a throttled chunk can't reach roll
 * into the next chunk. The
 * chunk-file-limit-honors-configured-level invariant is pinned by a regression test.
 */
export function budgetAwareFileLimit(remainingSafeBudget: number, configuredChunkFileLimit: number) {
  const budgetLimit = Math.floor(remainingSafeBudget / ESTIMATED_SUBREQUESTS_PER_FILE);
  return Math.min(configuredChunkFileLimit, budgetLimit);
}

function isRetryableFileReviewErrorMessage(message: string | null | undefined) {
  if (!message) return false;
  const lower = message.toLowerCase();

  // Explicitly fail fast for timeouts so they don't loop endlessly, aligning with
  // isTransientModelFailure which prevents timeouts from being retried.
  if (isTimeoutMessage(lower)) {
    return false;
  }

  return (
    matchesAnyTransientSubstring(lower) ||
    lower.includes('all configured review models failed') ||
    lower.includes('retrying later') ||
    lower.includes('google request failed with 5') ||
    lower.includes('temporary') ||
    // Older jobs may have persisted subrequest-budget failures before budget exhaustion became
    // a pure chunk-level deferral. Keep retrying those rows instead of treating them as handled.
    lower.includes('subrequest')
  );
}

/**
 * Detects Cloudflare's per-invocation subrequest-limit error (Workers Free plan: 50
 * subrequests/invocation). Unlike a provider outage, this clears completely on the next
 * invocation, so the correct response is never to fail the whole job or permanently abandon
 * a file -- it is to persist whatever progress was made and reschedule the same phase, which
 * runs in a fresh invocation with a fresh budget. Because each review chunk reviews and
 * persists only a few files (see reviewChunkFileLimit), rescheduling reliably makes forward
 * progress and the review grinds to completion instead of dying mid-way.
 */
function isSubrequestBudgetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.toLowerCase().includes('subrequest');
}

function retryableModelFailureDelaySeconds(failureCount: number | null | undefined) {
  if (!failureCount || failureCount < 1) return RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[0];
  const index = Math.min(failureCount - 1, RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS.length - 1);
  return RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[index];
}

function getRetryableModelFailureDelaySeconds(error: unknown) {
  const record = error && typeof error === 'object' ? error as { retryAfterSeconds?: unknown } : null;
  const retryAfterSeconds =
    typeof record?.retryAfterSeconds === 'number'
      ? record.retryAfterSeconds
      : null;
  return retryAfterSeconds ?? RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[0];
}

function shouldRetryExistingFileReview(review: { file_status: string; error_msg: string | null }) {
  return review.file_status === 'failed' && isRetryableFileReviewErrorMessage(review.error_msg);
}

function countsAsHandledFileReview(review: { file_status: string; error_msg: string | null }) {
  return !shouldRetryExistingFileReview(review);
}

/**
 * A file whose review was submitted to the Workers AI async batch queue and is still
 * queued/running. Such a row is persisted as 'pending' with the queue request_id; it is neither
 * "handled" (it must be polled to completion) nor a failure to retry from scratch.
 */
function isAwaitingAsyncReview(review: { file_status: string; async_request_id?: string | null }) {
  return review.file_status === 'pending' && !!review.async_request_id;
}

// Reduces a model identifier to its bare name, ignoring the optional `provider:` prefix.
// A completed file review stores the bare model id (e.g. `gemini-3.1-flash-lite`), while the
// configured strategy stores the provider-qualified id (e.g. `google:gemini-3.1-flash-lite`).
// Comparing the bare form on both sides is what lets a retry recognise an already-reviewed file
// as inheritable -- without it, no completed review ever matches the config and every retry
// re-reviews every file from scratch.
function bareModelId(model: string): string {
  const normalized = normalizeModelId(model);
  const colon = normalized.indexOf(':');
  return colon === -1 ? normalized : normalized.slice(colon + 1);
}

function configuredModelSet(config: RepoConfig) {
  const models = new Set<string>();
  const addModel = (model: string | null | undefined) => {
    if (model) models.add(bareModelId(model));
  };

  addModel(config.model?.main);
  for (const fallback of config.model?.fallbacks ?? []) {
    addModel(fallback);
  }
  for (const tier of config.model?.size_overrides ?? []) {
    addModel(tier.model);
    for (const fallback of tier.fallbacks ?? []) {
      addModel(fallback);
    }
  }

  return models;
}

function canInheritParentFileReview(config: RepoConfig, review: { model_used: string }) {
  return configuredModelSet(config).has(bareModelId(review.model_used));
}

async function resolveModelProviderName(env: Pick<AppBindings, 'HYPERDRIVE'>, modelId: string | null | undefined) {
  if (!modelId || modelId === 'unconfigured') return null;

  try {
    const resolved = await getResolvedModelConfig(env, normalizeModelId(modelId));
    return resolved?.providerName ?? null;
  } catch (error) {
    logger.warn(`Failed to resolve provider for model ${modelId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function shouldTriggerFromPullRequest(action: PullRequestWebhookPayload['action'], config: RepoConfig['review']) {
  return (config.on as string[]).includes(action);
}

export type ReviewRequest = {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prAuthor: string | null;
  commitSha: string;
  // REV-M-7: baseSha is nullable so the Bitbucket webhook route may pass empty string OR
  // destination.commit.hash (when unavailable). The review pipeline tolerates a missing baseSha
  // because the head SHA + commitSha drive the review, not the base.
  baseSha: string | null;
  headRef: string | null;
  baseRef: string | null;
  trigger: 'auto' | 'mention';
  // 05-04 widening (D-14 / Phase-3 deferred item closure): optional provider awareness so the
  // Bitbucket webhook route can carry the Bitbucket identity (workspace + provider) alongside
  // the GitHub-shaped fields. extractReviewRequest (the GitHub path) leaves these unset; the
  // Bitbucket route in Task 2 sets them at construction time. NREG-02 holds because the GitHub
  // call sites never set these fields and webhook-ingest.ts reads them via `?? 'github' /
  // ?? null` fallbacks. The widening is purely additive — no Zod schema added here per project
  // convention (the type lives next to its only constructor `extractReviewRequest`).
  repositoryVcsProvider?: 'github' | 'bitbucket';
  repositoryWorkspace?: string | null;
};

export function extractReviewRequest(input: {
  eventName: GitHubWebhookEventName;
  payload: GitHubWebhookPayload;
  botUsername: string;
  config: RepoConfig;
}): ReviewRequest | null {
  if (input.eventName === 'pull_request') {
    const payload = input.payload as PullRequestWebhookPayload;
    if (input.config.review.ignore_drafts && payload.pull_request.draft) {
      return null;
    }
    if (!shouldTriggerFromPullRequest(payload.action, input.config.review)) {
      return null;
    }

    return {
      installationId: String(payload.installation?.id ?? ''),
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.pull_request.number,
      prTitle: payload.pull_request.title,
      prAuthor: payload.pull_request.user.login,
      commitSha: payload.pull_request.head.sha,
      baseSha: payload.pull_request.base.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      trigger: 'auto' as const,
    };
  }

  if (input.eventName === 'issue_comment') {
    const payload = input.payload as IssueCommentWebhookPayload;
    const mentionTrigger = input.config.review.mention_trigger;

    if (!payload.issue?.pull_request || payload.action !== 'created' || !mentionTrigger) {
      return null;
    }

    if (!payload.comment?.body?.includes(mentionTrigger)) {
      return null;
    }

    return {
      installationId: String(payload.installation?.id ?? ''),
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.issue.number,
      prTitle: null,
      prAuthor: null,
      commitSha: '',
      baseSha: '',
      headRef: null,
      baseRef: null,
      trigger: 'mention' as const,
    };
  }

  return null;
}

export async function runReviewJob(env: AppBindings, message: ReviewJobMessage): Promise<ReviewJobRunResult> {
  const resolved = await resolveQueuedJob(env, message);
  if (!resolved) {
    return { action: 'ack' };
  }

  // Concurrency admission control: only throttle a job that has NOT started yet (status 'queued').
  // A job that is already 'running' is mid-flight; re-gating its phase continuations would mean that
  // lowering the concurrency limit (or any transient over-count from the check-then-claim race)
  // makes every in-flight job retry forever -- that path returns before markJobContinuationQueued,
  // so MAX_JOB_CONTINUATIONS never trips, the lease goes stale, and recovery force-fails the job.
  // Gating only admission also avoids a second getReviewSettings fetch on review/finalize invocations.
  if (resolved.job.status === 'queued') {
    const { concurrencyLevel } = await getReviewSettings(env);
    const maxConcurrentJobs = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
    const runningCount = await getOtherRunningJobsCount(env, resolved.job.id);
    if (runningCount >= maxConcurrentJobs) {
      logger.info(`Throttling admission of job ${resolved.job.id}: ${runningCount} other jobs are currently running.`);
      return { action: 'retry', delaySeconds: 30 };
    }
  }

  const leaseOwner = crypto.randomUUID();
  const claim = await claimJobLease(env, resolved.job.id, leaseOwner, JOB_LEASE_SECONDS);
  if (claim.status === 'missing') {
    logger.warn(`Job not found for processing: ${resolved.job.id}`);
    return { action: 'ack' };
  }
  if (claim.status === 'terminal') {
    logger.info(`Job ${resolved.job.id} is already terminal (${claim.row.status}), acking queue delivery.`);
    return { action: 'ack' };
  }
  if (claim.status === 'busy') {
    logger.info(`Job ${resolved.job.id} has a fresh lease; retrying queue delivery later.`);
    return { action: 'retry', delaySeconds: Math.min(BUSY_RETRY_SECONDS, claim.retryAfterSeconds) };
  }

  const job = mapJob(claim.row);

  // Bind this job row to the ACTUAL Workflow instance id so job control (stop/delete/rerun) can
  // terminate the right instance. The bind-workflow-id step can't do this for webhook-triggered
  // jobs -- their instance is keyed on deliveryId while the job row (created later, in prepare) has
  // a different id -- so we (re)bind here now that the real job is resolved. Cheap and idempotent.
  if (message.workflowInstanceId && job.workflowInstanceId !== message.workflowInstanceId) {
    try {
      await setJobWorkflowInstance(env, job.id, message.workflowInstanceId);
    } catch (error) {
      logger.warn(`Failed to bind workflow instance id for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  const phase = resolved.phase;
  const tracker = new TokenTracker();
  // Provider construction is awaited BEFORE the main lease-release try block below. Today
  // `forRepo` is non-throwing, but its docstring promises a real, potentially-rejecting
  // provider/credential read in Phase 4/5. If that read is added without covering this await,
  // a rejection would escape with a live lease held -> the job wedges behind a stale lease_owner
  // until expiry recovery reclaims it (WR-01). Release the lease on rejection and re-throw. It
  // can't simply move into the main try block: that block's catch handlers reference `vcs`.
  let vcs: VcsProvider;
  try {
    vcs = await VcsService.forRepo(env, job, tracker);
  } catch (error) {
    await releaseJobLease(env, job.id, leaseOwner);
    throw error;
  }
  const model = new ModelService(env, tracker, { jobId: job.id });
  const formatter = new FormatterService(env.APP_URL);

  try {
    if (phase === 'prepare') {
      await runPreparePhase(env, job, leaseOwner, vcs);
    } else if (phase === 'finalize') {
      await runFinalizePhase(env, job, leaseOwner, vcs, formatter);
    } else if (phase === 'critic') {
      await runCriticPhase(env, job, leaseOwner, model);
    } else {
      await runReviewPhase(env, job, leaseOwner, vcs, model, tracker);
    }

    await releaseJobLease(env, job.id, leaseOwner);
    return { action: 'ack' };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown review failure';
    if (messageText === 'JOB_SUPERSEDED') {
      logger.info(`Job ${job.id} was superseded during execution, stopping.`);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'ack' };
    }

    if (error instanceof NextPhaseError) {
      await releaseJobLease(env, job.id, leaseOwner);
      // Finalize AND critic each need a fresh instance for a clean subrequest budget: finalize posts
      // the review (~20 subrequests at once) and critic makes its single whole-set model call on its
      // OWN budget (D-07 — the critic must never share finalize's budget). Other phase transitions
      // (e.g. the per-chunk review yield) stay in this instance and rely on the normal step.sleep
      // hibernation to reset the budget.
      return { action: 'next_phase', phase: error.phase, delaySeconds: error.delaySeconds, jobId: job.id, freshInstance: error.phase === 'finalize' || error.phase === 'critic' };
    }

    if (isRetryableModelError(error)) {
      const delaySeconds = getRetryableModelFailureDelaySeconds(error);
      logger.warn(`Review job hit transient model/provider failure; scheduling delayed continuation: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        error: messageText,
        phase,
        delaySeconds,
      });
      return continueOrFailWedgedJob(env, job, vcs, leaseOwner, phase, delaySeconds, 'transient model/provider failures');
    }

    // Running out of this invocation's subrequest budget is not a job failure: every phase is
    // idempotent enough to resume on a fresh budget, so reschedule the same phase instead of
    // terminally failing the whole review. Prepare and review skip already-persisted files;
    // finalize re-derives its inputs and is guarded against double-posting the GitHub review
    // (see the findBotReviewForCommit guard in runFinalizePhase), so a finalize that exhausts the
    // budget mid-way -- which the large-PR degrade path genuinely can -- resumes rather than dying.
    if (isSubrequestBudgetError(error)) {
      // A fresh Worker invocation is what fixes budget exhaustion -- but only a long-enough sleep
      // actually hibernates the workflow into one. Yield long enough to force that hibernation.
      const record = error && typeof error === 'object' ? error as { retryAfterSeconds?: unknown } : null;
      const delaySeconds = typeof record?.retryAfterSeconds === 'number'
        ? record.retryAfterSeconds
        : FRESH_INVOCATION_YIELD_SECONDS;
      logger.warn(`Review job hit the per-invocation subrequest limit; rescheduling ${phase} on a fresh budget: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        error: messageText,
        phase,
        delaySeconds,
      });
      return continueOrFailWedgedJob(env, job, vcs, leaseOwner, phase, delaySeconds, 'per-invocation subrequest limits');
    }

    logger.error(`Review job failed: ${job.owner}/${job.repo} PR #${job.prNumber}`, error);
    await failJobAndCheckRun(env, job, checkRunUpdaterFor(vcs), messageText);
    await releaseJobLease(env, job.id, leaseOwner);
    return { action: 'ack' };
  }
}

// Records a same-phase continuation and enforces the MAX_JOB_CONTINUATIONS ceiling. As long as
// the job keeps completing files, resetJobContinuationCount() keeps this counter near zero; once
// it has rescheduled MAX_JOB_CONTINUATIONS times without a single file completing, the job is
// genuinely wedged (e.g. a provider is down for the entire backoff window), so we fail it
// terminally instead of letting it churn indefinitely.
async function continueOrFailWedgedJob(
  env: AppBindings,
  job: PersistedReviewJob,
  vcs: VcsProvider,
  leaseOwner: string,
  phase: 'prepare' | 'review' | 'finalize' | 'critic',
  delaySeconds: number,
  reason: string,
): Promise<ReviewJobRunResult> {
  const continuationCount = await markJobContinuationQueued(env, job.id, delaySeconds);

  // Finalize AND critic burn their low ceiling fast so a saturated instance that can't post the
  // review / can't run the critic on a clean budget fails over within a few minutes instead of
  // looping ~20 min against the review-sized ceiling; review keeps the generous ceiling because it
  // makes real per-file progress. (Critic never terminal-fails on exceed — it fails OPEN to finalize
  // in the branch below — but it still uses the low ceiling to bound its fresh-instance retries.)
  const ceiling = phase === 'finalize' || phase === 'critic' ? MAX_FINALIZE_CONTINUATIONS : MAX_JOB_CONTINUATIONS;

  if (continuationCount > ceiling) {
    if (phase === 'review') {
      // Degrade to a partial review rather than throwing away the work done so far. NOTE: we must
      // RETURN the finalize transition here, not call enqueueJobPhase() -- that helper throws
      // NextPhaseError, and because continueOrFailWedgedJob runs inside runReviewJob's catch
      // block that throw would escape the function uncaught instead of being turned into a result.
      logger.error(`Review job exceeded the continuation ceiling; degrading to a partial review: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      // Any file still awaiting an async batch result would otherwise be finalized as an empty
      // "successful" review (its 'pending' row isn't 'failed', so finalize maps it to verdict
      // 'comment'/'' with no findings). Mark them failed first -- mirrors the async-poll degrade path.
      const stillPending = (await getFileReviewsForJobs(env, [job.id])).filter(isAwaitingAsyncReview);
      for (const review of stillPending) {
        await persistFailedFileReview(env, job.id, {
          filePath: review.file_path,
          // Thread the row's own pass (IN-03) so the failed row is keyed on the correct
          // (job_id, file_path, pass) tuple, matching the async-poll degrade path. Async rows are
          // main-only today (submitReviewBatch gates on pass === 'main'), so this is behavior-
          // preserving now and correct if async batching is ever extended to the security pass.
          pass: review.pass,
          modelUsed: review.async_model ?? review.model_used,
          diffLineCount: review.diff_line_count,
          errorMessage: 'Async batch review did not complete before the job wedged.',
          clearAsync: true,
        });
      }
      // Hand finalize its own fresh continuation budget. Without this the counter is already past
      // MAX_JOB_CONTINUATIONS (that's what triggered this degrade), so the first time finalize hits
      // a subrequest-budget limit it would re-enter continueOrFailWedgedJob already over the ceiling
      // and fail terminally -- exactly the large-PR "Too many subrequests" failure this guards.
      await resetJobContinuationCount(env, job.id);
      await releaseJobLease(env, job.id, leaseOwner);
      // Route the degrade through the SAME selector as a healthy review completion: when the critic
      // pass is enabled a degraded review must still enter the critic (never bypass it straight to
      // finalize), so a partial review is critiqued exactly like a full one (MP-03). Critic-off keeps
      // the pre-critic behavior byte-identically (nextPhaseAfterReview -> 'finalize', NREG-01).
      const configFromJob = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
      return { action: 'next_phase', phase: nextPhaseAfterReview(configFromJob), delaySeconds: FRESH_INVOCATION_YIELD_SECONDS, jobId: job.id, freshInstance: true };
    } else if (phase === 'critic') {
      // FAIL-OPEN ceiling (MP-03): a wedged critic (repeated subrequest-budget exhaustion on its
      // fresh-instance retries) must NEVER terminal-fail the job. Reset the continuation counter and
      // hand finalize its own fresh instance/budget; finalize's null-critic_result branch (10-07)
      // reconstructs the deduped candidate set, so no finding is lost by skipping the critic.
      logger.error(`Critic phase exceeded the continuation ceiling; failing OPEN to finalize (no critique applied): ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      await resetJobContinuationCount(env, job.id);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'next_phase', phase: 'finalize', delaySeconds: FRESH_INVOCATION_YIELD_SECONDS, jobId: job.id, freshInstance: true };
    } else {
      const message = `Review could not make progress after ${continuationCount} continuation attempts (${reason}). Failing the job to avoid an endless retry loop; re-run it once the underlying provider issue clears.`;
      logger.error(`Review job exceeded the continuation ceiling; failing terminally: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        phase,
        continuationCount,
        reason,
      });
      await failJobAndCheckRun(env, job, checkRunUpdaterFor(vcs), message);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'ack' };
    }
  }

  await releaseJobLease(env, job.id, leaseOwner);
  // A subrequest-limit deferral means THIS instance is saturated and won't get a fresh budget by
  // sleeping (a long-lived instance stops hibernating), so resume the phase in a brand-new instance.
  // A transient model/provider deferral is not budget-related, so it stays in this instance.
  const freshInstance = reason.includes('subrequest');
  return { action: 'next_phase', phase, delaySeconds, jobId: job.id, freshInstance }; // Resume same phase
}

async function resolveQueuedJob(
  env: AppBindings,
  message: ReviewJobMessage,
): Promise<{ job: PersistedReviewJob; phase: 'prepare' | 'review' | 'finalize' | 'critic' } | null> {
  // The WIRE contract (reviewJobMessageSchema.phase) includes 'critic' (D-07). Phase 10 DISPATCHES it
  // — but ONLY for a jobId-bearing message. A critic phase is only ever reached AFTER a job exists
  // (review→critic hands off keyed on the resolved jobId), so a phase:'critic' message WITHOUT a jobId
  // can only be a spoof/premature delivery (Pitfall 5, T-10-11): REJECT it HERE at the boundary
  // (return null → runReviewJob acks it) so a stray critic message can never resolve a job by webhook
  // payload and run against it. A jobId-bearing critic message falls through to the getJobForProcessing
  // branch below and is dispatched normally.
  const requestedPhase = message.phase;
  if (requestedPhase === 'critic' && !message.jobId) {
    logger.warn('Queue message ignored: phase "critic" requires a jobId (a jobId-less critic message is treated as a spoof).');
    return null;
  }

  if (message.jobId) {
    const row = await getJobForProcessing(env, message.jobId);
    return row ? { job: mapJob(row), phase: requestedPhase ?? 'review' } : null;
  }

  if (!message.eventName) {
    logger.warn('Queue message ignored: missing eventName');
    return null;
  }

  let eventName = message.eventName;
  let payload = message.payload as GitHubWebhookPayload | undefined;

  if (payload === undefined) {
    const delivery = await getWebhookDelivery(env, message.deliveryId);
    if (!delivery) {
      logger.warn(`Queue message ignored: webhook delivery not found: ${message.deliveryId}`);
      return null;
    }

    eventName = delivery.event_name;
    payload = delivery.payload as GitHubWebhookPayload;
  }

  if (!isSupportedGitHubWebhookEvent(eventName)) {
    logger.info(`Queue message ignored: unsupported GitHub event ${eventName}`);
    return null;
  }

  const installationId = String(payload.installation?.id ?? '');
  if (!installationId || !('repository' in payload) || !payload.repository) {
    logger.info('Queue message ignored: missing installation or repository info');
    return null;
  }

  const repoConfig = await loadRepoConfig(env, {
    installationId,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
  });

  if (repoConfig.enabled === false) {
    logger.info(`Job ignored: repository ${payload.repository.owner.login}/${payload.repository.name} is disabled`);
    return null;
  }

  const extracted = extractReviewRequest({
    eventName,
    payload,
    botUsername: env.BOT_USERNAME,
    config: repoConfig.parsedJson,
  });

  if (!extracted) {
    if (eventName === 'pull_request') {
      const prPayload = payload as PullRequestWebhookPayload;
      if (prPayload.action === 'closed' && repoConfig.parsedJson.review.labels !== false) {
        const labels = repoConfig.parsedJson.review.labels;
        // No tracker here (finding 8, ZBC): this path runs before runReviewJob's TokenTracker
        // exists, replicating today's tracker-less raw-client construction at this site.
        const cleanupVcs = await VcsService.forProvider(env, { provider: 'github', installationId });
        await cleanupVcs.labels?.removeIfPresent(
          prPayload.repository.owner.login,
          prPayload.repository.name,
          prPayload.pull_request.number,
          [labels.p1, labels.p2, labels.p3],
        );
      }
    }
    return null;
  }

  let resolved = extracted;
  if (eventName === 'issue_comment') {
    // No tracker here (finding 8, ZBC): this path runs before runReviewJob's TokenTracker
    // exists, replicating today's tracker-less raw-client construction at this site.
    const commentVcs = await VcsService.forProvider(env, { provider: 'github', installationId });
    const pr = await commentVcs.getPullRequest(extracted.owner, extracted.repo, extracted.prNumber);
    resolved = {
      ...extracted,
      prTitle: pr.title,
      prAuthor: pr.authorLogin,
      commitSha: pr.headSha,
      baseSha: pr.baseSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
    };
  }

  const duplicateJob = await findExistingJobForHead(env, {
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    commitSha: resolved.commitSha,
    trigger: resolved.trigger,
  });
  if (duplicateJob) {
    if (duplicateJob.status === 'queued' || duplicateJob.status === 'running') {
      logger.info(`Resuming duplicate in-flight job ${duplicateJob.id} for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}.`);
      return { job: duplicateJob, phase: requestedPhase ?? 'prepare' };
    }

    logger.info(`Duplicate terminal job found for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}, skipping.`);
    return null;
  }

  const job = await insertJob(env, {
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    prTitle: resolved.prTitle,
    prAuthor: resolved.prAuthor,
    commitSha: resolved.commitSha,
    baseSha: resolved.baseSha ?? '',
    trigger: resolved.trigger,
    headRef: resolved.headRef,
    baseRef: resolved.baseRef,
    configSnapshot: repoConfig.parsedJson,
  });

  await supersedeOlderJobs(env, {
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    newJobId: job.id,
  });

  return { job, phase: 'prepare' };
}

async function runPreparePhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  vcs: VcsProvider,
) {
  await updateJobStep(env, job.id, 'Preparation', { status: 'running' });
  const pr = await vcs.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;

  // Refresh the cached PR title/author from the live PR: these are snapshotted at job creation and
  // copied onto retries, so a title edited on GitHub afterwards would otherwise stay stale.
  try {
    await setJobPullRequestMeta(env, job.id, {
      prTitle: pr.title ?? null,
      prAuthor: pr.authorLogin ?? null,
    });
  } catch (error) {
    logger.warn(`Failed to refresh PR metadata for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
  }

  let checkRunId = job.checkRunId;
  if (!checkRunId && !job.statusCheckRef) {
    const checkRun = await vcs.createStatusCheck(job.owner, job.repo, {
      headSha: pr.headSha,
      title: 'Review queued',
      summary: 'OpenCodra has started reviewing this pull request.',
    });
    // REV-C-2 (provider-aware ref persistence): the `ref` returned by `createStatusCheck` is
    // PROVIDER-OPAQUE (REV-M-10). Two paths, branched on `vcs.name`:
    //
    //   - GitHub: ref is a numeric check_run_id encoded as a string. Persist it into the numeric
    //     `check_run_id` column via `updateJobCheckRun`. Fail loudly on a non-numeric ref so a
    //     shape drift doesn't silently write NaN (WR-03).
    //
    //   - Bitbucket (and any other provider that returns a non-numeric ref): persist the ref as a
    //     TEXT string via `updateJobStatusCheckRef`. The Bitbucket adapter returns the literal
    //     'codra-review' (D-10), which used to throw `Number.isFinite('codra-review') === false`
    //     before REV-C-2 -- now it is written into status_check_ref unchanged and the prepare
    //     phase completes cleanly.
    if (vcs.name === 'github') {
      const numericCheckRunId = Number(checkRun.ref);
      if (!Number.isFinite(numericCheckRunId)) {
        throw new Error(`Provider ${vcs.name} returned a non-numeric check-run ref: ${checkRun.ref}`);
      }
      checkRunId = numericCheckRunId;
      await updateJobCheckRun(env, job.id, checkRunId);
    } else {
      await updateJobStatusCheckRef(env, job.id, checkRun.ref);
    }
  }

  // Phase 18 (RND-01 / D-01..D-06): always-on round detection at prepare-time, INDEPENDENT of the
  // `rounds.incremental` toggle. The resolved round / mode are persisted on the job and emitted as
  // a `rounds.detected` audit event so the signal is observable at defaults. Consumer paths
  // (compare-diff selection, floor escalation, thread suppression) wire in Plans 02/03/04 and are
  // separately gated on `rounds.incremental` -- THIS plan persists the durable snapshot but does
  // not activate any consumer path. The review-rest short-circuit (D-03) is the only branch that
  // skips state + thread calls entirely.
  //
  // Phase 18 Plan 02 (RND-02): the SELECTED mode (the OUTPUT of selectDiffForRound) is what gets
  // persisted as `review_mode` -- NOT the resolver's mode. The resolver's mode is the constraint
  // (full / incremental / fallback), the selector's output is the actual review behavior
  // (which may downgrade to 'no_changes' on a successful empty compare). The two writes
  // (setJobReviewRoundAndMode + setJobDiffSelection) happen AFTER the compare/fetch so the
  // job row's review_mode can transition from 'incremental' to 'no_changes' inline.
  const roundsIncremental = Boolean(config.review.rounds?.incremental ?? false);
  if (job.reviewScope !== 'rest') {
    // Non-rest path: query pr_review_state for the prior anchor AND (gated on the durable
    // `rounds.incremental` snapshot) call the unresolved-thread listing. `getPrReviewState` is a
    // cheap equality lookup and is ALWAYS called so a never-paused PR resolves to a clean
    // null-state without a separate sentinel column. `getUnresolvedBotThreads` is gated on the
    // capability flag AND on `rounds.incremental` (D-02: detection runs at defaults, but the
    // thread-listing seam is a CONSUMER call that must stay inert at defaults).
    let unresolvedThreads: import('@server/vcs/types').VcsReviewThread[] = [];
    if (roundsIncremental && vcs.capabilities.supportsThreadListing) {
      try {
        unresolvedThreads = await vcs.getUnresolvedBotThreads(job.owner, job.repo, job.prNumber);
      } catch (error) {
        // Capability-flagged degradation (Phase 17 D-02): a thrown listing call degrades to [] so
        // the resolver still resolves. The audit event below records the unavailable capability
        // degradation explicitly.
        logger.warn(
          `Failed to list unresolved bot threads for job ${job.id}; treating as no threads (capability degradation)`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    // Build the pr_review_state lookup key from the durable job identity (matches the
    // pause-state setter key shape: vcs_provider + workspace + repo_slug + pr_number).
    const prReviewStateKey: PrReviewStateKey = {
      vcsProvider: (job.repositoryVcsProvider ?? 'github') as 'github' | 'bitbucket',
      workspace: job.repositoryWorkspace ?? job.owner,
      repoSlug: job.repo,
      prNumber: job.prNumber,
    };
    const priorState = await getPrReviewState(env, prReviewStateKey);

    // Pure resolver call (RND-01 / D-01..D-06): returns the resolved round + mode + boolean flags.
    // Independent of the incremental toggle per D-02.
    const roundContext = resolveRoundContext({
      reviewScope: job.reviewScope ?? null,
      priorState,
      unresolvedThreads,
      roundsIncremental,
    });

    // Emit the detected-event audit record NOW (before the diff fetch) so the round signal is
    // observable at the prepare step regardless of whether the compare fetch succeeds. The
    // best-effort recorder never throws into the caller.
    await recordRoundAudit(env, job.id, [buildRoundsDetectedEvent(roundContext)]);

    // The selected mode (selector's output) is staged for the write below. The selected mode
    // may differ from the resolver's mode (e.g., resolver says 'incremental' but selector says
    // 'no_changes' for an empty compare). The job's review_mode is the SELECTED mode.
    void roundContext;
  } else {
    // D-03 review-rest short-circuit: NO state/thread calls, NO resolver. Persist round 1 / mode
    // 'rest' directly so the dashboard reads the same round/mode pair this job will execute with,
    // and emit a `rounds.detected` audit event with the explicit `rest` mode so the audit trail
    // explains why this run did not participate in round detection.
    try {
      await setJobReviewRoundAndMode(env, job.id, { reviewRound: 1, reviewMode: 'rest' });
    } catch (error) {
      logger.warn(
        `Failed to persist review-rest round for job ${job.id}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    await recordRoundAudit(env, job.id, [
      buildRoundsDetectedEvent({
        round: 1,
        mode: 'rest',
        roundsIncremental,
        anchorSha: null,
        hasUnresolvedThreads: false,
      }),
    ]);
  }

  // Single-parse selection for the NON-rest path (Antigravity/Codex 15-05 MEDIUM): derive BOTH
  // `files = kept` and the drop metadata from ONE selectReviewableFiles call instead of re-parsing the
  // cached diff 2-3× (the former CMD-02 producer re-fetched + re-partitioned on its own). `kept` is
  // byte-identical to what getJobDiffFiles->getDiffFiles->filterReviewableFiles returns for non-rest.
  // The 'rest' path stays unchanged (getJobDiffFiles reconstructs the set from skipped_files) and emits
  // NO file_skipped events (a review-rest job consumes prior skips, it does not re-record drops).
  let files: FileDiff[];
  let dropped: FileSelectionResult['dropped'] | null = null;
  // Phase 18 Plan 02 (RND-02): the durable, immutable diff-selection descriptor. Persisted on
  // the job row IMMEDIATELY after the prepare-time resolver + compare-fetch + selectDiffForRound
  // classify the diff source so review/finalize can re-fetch the EXACT same compare range on
  // fresh-instance handoff / lease recovery (Codex/Antigravity HIGH: incremental-mode cache miss
  // MUST NOT call the implicit full-diff helper). The descriptor is the durable fact; the
  // cache is only a best-effort accelerator.
  let selectionDescriptor: DiffSelectionDescriptor | null = null;
  if (job.reviewScope === 'rest') {
    files = await getJobDiffFiles(env, job, vcs, config);
  } else {
    // Build the descriptor against the prepare-time round context. The full diff is fetched on
    // 'full' (the default round 1 path) AND on the thrown-compare fallback path for 'incremental'.
    // 'fallback' mode (thread-only D-04 path) uses the full diff as the source directly.
    const roundContextForSelection = await resolveRoundContextForJob(env, job, vcs, config);
    let compareDiff = '';
    let compareFiles: FileDiff[] = [];
    let compareThrew = false;
    let fullDiff = '';
    let fullFiles: FileDiff[] = [];

    // For incremental mode (anchor + rounds.incremental), attempt the compare fetch first.
    if (roundContextForSelection.mode === 'incremental' && roundContextForSelection.anchorSha) {
      try {
        compareDiff = await vcs.getCompareDiff(job.owner, job.repo, roundContextForSelection.anchorSha, pr.headSha);
        compareFiles = parseUnifiedDiff(compareDiff, config.review);
      } catch (error) {
        // Thrown compare -> fall back to the full diff. The LOGGER + the descriptor's
        // compareThrew flag flag this case distinctly from a successful empty compare.
        compareThrew = true;
        logger.warn(
          `getCompareDiff threw for job ${job.id}; falling back to full PR diff`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    // Always fetch the full diff in fallback mode (D-04) and on the thrown-compare path
    // (the only legal fallback triggers). 'full' mode also fetches the full diff (today's path).
    // 'incremental' with a successful compare does NOT fetch the full diff (the plan's "no full
    // fetch" rule for legitimate empty compares).
    const needsFullDiff =
      roundContextForSelection.mode === 'full' ||
      roundContextForSelection.mode === 'fallback' ||
      compareThrew;
    if (needsFullDiff) {
      fullDiff = await vcs.getPullRequestDiff(job.owner, job.repo, job.prNumber);
      fullFiles = parseUnifiedDiff(fullDiff, config.review);
    }

    selectionDescriptor = selectDiffForRound({
      roundContext: { ...roundContextForSelection, round: roundContextForSelection.round },
      compareThrew,
      compareDiff,
      compareFiles,
      fullDiff,
      fullFiles,
      toSha: pr.headSha,
    });

    // Persist the SELECTED mode (not the resolver's mode) so the job row's review_mode
    // reflects the ACTUAL review behavior. A selector that downgrades 'incremental' to
    // 'no_changes' on an empty compare writes 'no_changes' here -- the placeholder finalize
    // path sees the no_changes descriptor and short-circuits cleanly. Best-effort: a failed
    // write is logged + swallowed so the prepare phase can continue.
    try {
      await setJobReviewRoundAndMode(env, job.id, {
        reviewRound: roundContextForSelection.round,
        reviewMode: selectionDescriptor.mode,
      });
    } catch (error) {
      logger.warn(
        `Failed to persist selected round/mode for job ${job.id}; round will be re-resolved on next prepare`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    // Persist the descriptor on the job row. Best-effort: a failed write is logged + swallowed
    // so the prepare phase can continue (the descriptor is also captured in the audit trail,
    // so an operational-state drift between jobs row and audit trail is recoverable).
    try {
      await setJobDiffSelection(env, job.id, selectionDescriptor);
    } catch (error) {
      logger.warn(
        `Failed to persist diff-selection descriptor for job ${job.id}; finalize will re-resolve on next phase`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    // Now drive the file selection off the SELECTED source. `no_changes` short-circuits the
    // review phase (placeholder finalize) — emit the audit event, skip file selection, and the
    // review/finalize phases will see the no_changes descriptor and bail out cleanly.
    if (selectionDescriptor.mode === 'no_changes') {
      try {
        await recordRoundAudit(env, job.id, [
          buildRoundsNoChangesEvent({
            from: selectionDescriptor.fromSha,
            to: selectionDescriptor.toSha,
            round: roundContextForSelection.round,
          }),
        ]);
      } catch (error) {
        logger.warn(
          `Failed to record rounds.no_changes audit for job ${job.id}`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      // Mark preparation complete with zero files; the gate below enqueues finalize, which
      // short-circuits on the no_changes descriptor.
      await completePreparationStep(env, job.id, 0);
      heartbeatJobLease(env, job.id, leaseOwner, JOB_LEASE_SECONDS).catch(() => undefined);
      await enqueueJobPhase(env, job.id, 'finalize');
      return;
    }

    // Use the SELECTED raw diff for the file selection. The KV cache is keyed on the SELECTED
    // mode + range so a cache miss never silently substitutes a different source (Codex HIGH).
    const rawDiff = selectDiffForSelection(selectionDescriptor, compareDiff, fullDiff);
    const selection = selectReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review);
    files = selection.kept;
    dropped = selection.dropped;
  }

  // CMD-02 / D-10 skipped-for-size producer: when the commands feature is active, persist the files
  // this full review DROPPED past max_files so a later `review-rest` job (a different job_id) can
  // re-review exactly them via listSkippedFilesForHead by PR identity + head. Only for a NORMAL full
  // review (scope !== 'rest' -- a review-rest job CONSUMES the skips, it must not re-record them) and
  // only when we have a concrete head to key on. It now consumes the already-computed `dropped.overCap`
  // (no re-parse). Generated files are in `dropped.generated`, NOT overCap, so a generated file is
  // NEVER inserted into the review-rest queue (T-15-03-03 / would be wrongly re-reviewed). Best-effort:
  // a bookkeeping-write failure must never block enqueuing the review phase. When the feature is off
  // this whole block is skipped, so the disabled path is byte-identical (NREG-01).
  const commandsEnabled = config.review.interactive?.commands?.enabled ?? false;
  if (commandsEnabled && dropped && job.commitSha) {
    try {
      const omitted = dropped.overCap;
      if (omitted.length > 0) {
        await insertSkippedFiles(env, {
          jobId: job.id,
          ...skippedFilesKeyForJob(job),
          files: omitted.map((file) => ({ filePath: file.path, reason: 'max_files' })),
        });
      }
    } catch (error) {
      logger.warn(`Failed to record skipped-for-size files for job ${job.id}; review-rest may be unavailable for this head`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // PRIO-03 (D-11/D-12/D-13): surface a per-file reason for every drop THIS PHASE owns via the
  // file_skipped audit variant, INDEPENDENT of the commands feature (the CMD-02 producer above is
  // commands-gated; this deliberately is not — over_cap events appear with commands off). Gated on
  // file_selection.enabled so the DISABLED path emits ZERO file_skipped events even though the selector
  // still preserves `dropped.overCap` for review-rest reconstruction (Codex 15-03 HIGH — suppress
  // EMISSION here, never the data). Prepare-only, non-'rest' (implied by `dropped` being non-null).
  // Best-effort: recordFileSkips swallows failures and never blocks enqueuing the review phase.
  if (dropped && config.review.file_selection.enabled) {
    await recordFileSkips(env, job.id, buildFileSkipEvents(dropped));
  }

  await completePreparationStep(env, job.id, files.length);
  await heartbeatJobLease(env, job.id, leaseOwner, JOB_LEASE_SECONDS);

  if (files.length === 0) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await enqueueJobPhase(env, job.id, 'finalize');
    return;
  }

  // WT-01/WT-05: post the standalone walkthrough placeholder once we know there is ≥1 reviewable
  // file (D-11: never when files.length === 0 — hence inside the files.length > 0 path). Best-effort,
  // mirroring the check-run cosmetics below: a placeholder failure must not block enqueuing the
  // review phase that does the actual work. postWalkthroughPlaceholder is itself gated on
  // walkthrough.enabled and idempotent on the durable jobs.walkthrough_comment_ref, so a retried
  // prepare / fresh-instance handoff never double-posts. The ACCEPTED RESIDUAL (create-success then
  // ref-write throw) surfaces here as a logged warn so the residual stays observable (not swallowed
  // inside postWalkthroughPlaceholder).
  try {
    await postWalkthroughPlaceholder({ env, job, config, fileCount: files.length, vcs });
  } catch (error) {
    logger.warn(`Failed to post walkthrough placeholder for job ${job.id}; continuing to the review phase anyway`, error instanceof Error ? error : new Error(String(error)));
  }

  if (checkRunId) {
    // Best-effort progress cosmetics only (see runReviewPhase): don't let a failed check-run
    // update block enqueuing the review phase that does the actual work.
    try {
      await vcs.updateStatusCheck(job.owner, job.repo, String(checkRunId), {
        title: `Reviewing (0/${files.length})`,
        summary: 'OpenCodra is analyzing changed files.',
      });
    } catch (error) {
      logger.warn(`Failed to update initial progress check run for job ${job.id}; continuing to the review phase anyway`, error instanceof Error ? error : new Error(String(error)));
    }
  }
  await enqueueJobPhase(env, job.id, 'review');
}

async function runReviewPhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  vcs: VcsProvider,
  model: ModelService,
  tracker: TokenTracker,
) {
  if (!hasCompletedStep(job, 'Preparation')) {
    await runPreparePhase(env, job, leaseOwner, vcs);
    return;
  }

  await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });

  const pr = await vcs.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  const failureModelId = config.model?.main ?? 'unconfigured';
  let failureModelProviderPromise: Promise<string | null> | null = null;
  const resolveFailureModelProvider = () => {
    failureModelProviderPromise ??= resolveModelProviderName(env, failureModelId);
    return failureModelProviderPromise;
  };
  const files = await getJobDiffFiles(env, job, vcs, config);
  const totalLineCount = files.reduce((sum, file) => sum + file.lineCount, 0);
  const { concurrencyLevel } = await getReviewSettings(env);
  const configuredChunkFileLimit = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
  // Cap this chunk's concurrency by the invocation's remaining subrequest budget so a run of
  // model/provider failures can't push it over Cloudflare's per-invocation cap (Workers Free
  // plan: 50) -- but sized (see budgetAwareFileLimit) so the configured concurrency level is
  // honored in full at a healthy budget and only throttled once the budget is actually spent.
  const reviewChunkFileLimit = budgetAwareFileLimit(tracker.remainingSafeBudget(), configuredChunkFileLimit);
  if (reviewChunkFileLimit <= 0) {
    throw new Error('Subrequest budget for this invocation was exhausted before starting the next review chunk.');
  }
  const startedAt = Date.now();
  let processedThisChunk = 0;

  // Build the (file, pass) WORK-UNIT list once. Every eligible file always yields a 'main' unit;
  // when the repo's security pass is enabled it ALSO yields a 'security' unit, scheduled as a
  // separate budget-visible unit alongside main (D-01 / MP-01) rather than a hidden inline second
  // model call. With security off the list is main-only and every downstream path (scheduling,
  // skip, inherit, completion) is byte-identical to v1.0 (NREG-01).
  const securityPassEnabled = config.review.passes?.security?.enabled ?? false;
  const units: Array<{ file: (typeof files)[number]; pass: FileReviewPass }> = [];
  for (const file of files) {
    units.push({ file, pass: 'main' });
    if (securityPassEnabled) units.push({ file, pass: 'security' });
  }

  const jobIdsToQuery = [job.id];
  if (job.retryOfJobId) jobIdsToQuery.push(job.retryOfJobId);
  const allExistingReviews = await getFileReviewsForJobs(env, jobIdsToQuery);
  // Maps are keyed on reviewUnitKey(file_path, pass) -- NOT file_path -- so a file's 'main' and
  // 'security' rows are distinct entries: one pass can never overwrite, skip, or inherit the other
  // (tuple identity, 10-01). Keying on file_path alone here would let a security row clobber a main
  // row and leak orphan security rows into finalize.
  const currentReviews = new Map(allExistingReviews.filter((review) => review.job_id === job.id).map((review) => [reviewUnitKey(review.file_path, review.pass), review]));
  const parentReviews = new Map(allExistingReviews.filter((review) => review.job_id !== job.id && review.file_status === 'done').map((review) => [reviewUnitKey(review.file_path, review.pass), review]));

  const reviewTasks: Array<Promise<void>> = [];
  // Counters shared across the concurrent review tasks below (single-threaded JS, so ++ is safe):
  // `terminalProgress` counts files that reached a terminal state this chunk (reviewed, inherited,
  // or permanently failed); `awaitingAsync` counts files still queued/running on the async batch.
  let terminalProgress = 0;
  let awaitingAsync = 0;

  // Fast path for retries: bulk-copy every reusable parent review in one cheap DB pass instead of
  // re-persisting them one-per-budget-slot through the throttled loop below. Only files with no row
  // yet in this job are bulk-inherited; anything with an existing row falls through to the loop
  // (which handles its own inherit/re-review decision). This lets a fully-inheritable retry finish
  // the whole review phase in a single invocation rather than crawling through ~12 hibernated chunks.
  if (job.retryOfJobId && parentReviews.size > 0) {
    // Build a UNIT list (only the (file, pass) units THIS job actually expects) so the inherit is
    // tuple-keyed: a security-DISABLED retry's unit list is main-only, so it requests only main
    // units and can never inherit a stray parent 'security' row (no orphan security row leaks into
    // finalize). Each unit is inheritable only when it has no current row AND a done parent row for
    // the SAME (path, pass) exists under the current model strategy.
    const inheritableUnits = units
      .filter((unit) => {
        const key = reviewUnitKey(unit.file.path, unit.pass);
        if (currentReviews.has(key)) return false;
        const parent = parentReviews.get(key);
        return Boolean(parent && canInheritParentFileReview(config, parent));
      })
      .map((unit) => ({ filePath: unit.file.path, pass: unit.pass }));

    if (inheritableUnits.length > 0) {
      const inheritedUnits = await bulkInheritFileReviews(env, {
        jobId: job.id,
        parentJobId: job.retryOfJobId,
        units: inheritableUnits,
      });
      // Mark the just-copied units handled (by unit key) so the loop below skips them.
      for (const { filePath, pass } of inheritedUnits) {
        const key = reviewUnitKey(filePath, pass);
        const parent = parentReviews.get(key);
        if (parent) currentReviews.set(key, parent);
      }
      terminalProgress += inheritedUnits.length;
      if (inheritedUnits.length > 0) {
        logger.info(`Bulk-inherited ${inheritedUnits.length} parent file review units for job ${job.id} in one pass`);
      }
    }
  }

  for (const unit of units) {
    const { file, pass } = unit;
    const unitKey = reviewUnitKey(file.path, pass);
    const existingReview = currentReviews.get(unitKey);
    // An in-flight async submission must be polled (not skipped as "handled" and not resubmitted).
    // The skip check is per-UNIT: a completed (file,'main') row never skips the (file,'security')
    // unit and vice-versa, because existingReview is looked up by unitKey.
    const awaitingReview = existingReview && isAwaitingAsyncReview(existingReview) ? existingReview : null;
    if (existingReview && countsAsHandledFileReview(existingReview) && !awaitingReview) {
      continue;
    }

    const inherited = parentReviews.get(unitKey);
    const reviewTask = async () => {
      // (0) Poll an already-submitted async batch review. Only the main pass ever submits to the
      // async batch queue (see below), so awaitingReview is main-only; the pass is threaded anyway.
      if (awaitingReview) {
        const poll = await model.pollReviewBatch({
          model: awaitingReview.async_model ?? awaitingReview.model_used,
          requestId: awaitingReview.async_request_id!,
          file,
          // thread config so the async-batch parse path resolves the severity_engine.enabled escape
          // hatch from this repo's config, matching the sync path (13-04)
          config,
          // EVID-01 (Codex 15-04 HIGH): the same compact-prompt derivation submitReviewBatch used, so
          // pollReviewBatch reconstructs the EXACT bounded (truncated) file the model saw before the
          // evidence gate builds its haystack — truncated-away evidence correctly emits not_in_hunk.
          compactPrompt: (awaitingReview.transient_error_count ?? existingReview?.transient_error_count ?? 0) > 0,
        });
        if (poll.status === 'pending') {
          awaitingAsync += 1;
          return;
        }
        if (poll.status === 'failed') {
          // The batch errored/expired -- fall back to a synchronous review so the file still gets done.
          logger.warn(`Async batch poll failed for ${file.path}; falling back to synchronous review`, {
            error: poll.error instanceof Error ? poll.error.message : String(poll.error),
          });
          await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview, pass);
          terminalProgress += 1;
          return;
        }
        await persistCompletedReview(env, job, file, poll.response, pass);
        terminalProgress += 1;
        return;
      }

      if (!inherited) {
        // (1) The MAIN pass tries the async batch queue first; on any unavailability it falls back
        // to a synchronous review. The SECURITY pass is a separate scheduled unit that always runs
        // through the synchronous reviewFile path -- it is never submitted to the async batch queue.
        if (pass === 'main') {
          const submitted = await model.submitReviewBatch({
            file,
            prTitle: pr.title ?? null,
            prDescription: pr.body ?? null,
            config,
            totalLineCount,
            compactPrompt: (existingReview?.transient_error_count ?? 0) > 0,
          });
          if (submitted) {
            await upsertFileReview(env, job.id, {
              filePath: file.path,
              pass,
              fileStatus: 'pending',
              modelUsed: submitted.model,
              modelProvider: null,
              diffLineCount: file.lineCount,
              diffInput: null,
              rawAiOutput: null,
              parsedComments: [],
              inputTokens: null,
              outputTokens: null,
              durationMs: null,
              verdict: null,
              fileSummary: null,
              overallCorrectness: null,
              confidenceScore: null,
              errorMessage: null,
              asyncRequestId: submitted.requestId,
              asyncModel: submitted.model,
            });
            awaitingAsync += 1;
            return;
          }
        }
        await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview, pass);
        terminalProgress += 1;
        return;
      }

      if (!canInheritParentFileReview(config, inherited)) {
        logger.info(`Ignoring inherited review for ${file.path} (${pass}); parent model ${inherited.model_used} is not in the current model strategy`);
        await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview, pass);
        terminalProgress += 1;
      } else {
        await upsertFileReview(env, job.id, {
          filePath: file.path,
          pass,
          fileStatus: 'done',
          modelUsed: inherited.model_used,
          modelProvider: inherited.model_provider,
          diffLineCount: inherited.diff_line_count,
          diffInput: inherited.diff_input,
          rawAiOutput: inherited.raw_ai_output,
          parsedComments: inherited.parsed_comments as ParsedReviewComment[],
          inputTokens: inherited.input_tokens,
          outputTokens: inherited.output_tokens,
          durationMs: inherited.duration_ms,
          verdict: inherited.verdict,
          fileSummary: inherited.file_summary,
          overallCorrectness: inherited.overall_correctness,
          confidenceScore: inherited.confidence_score,
          errorMessage: null,
        });
        currentReviews.set(unitKey, inherited);
        terminalProgress += 1;
      }
    };

    reviewTasks.push(reviewTask());
    processedThisChunk += 1;

    if (processedThisChunk >= reviewChunkFileLimit || Date.now() - startedAt >= REVIEW_CHUNK_WALL_CLOCK_MS) {
      break;
    }
  }

  const results = await Promise.allSettled(reviewTasks);
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  // Terminal progress means a file reached a terminal state this chunk (reviewed, inherited, or
  // marked permanently failed). Clear the no-progress continuation counter so a slow-but-advancing
  // job never trips the MAX_JOB_CONTINUATIONS safety net. A chunk that only *submitted* or *polled*
  // still-pending async batches made no terminal progress, so it must NOT reset the counter --
  // that's what bounds polling of a batch that never completes.
  if (terminalProgress > 0) {
    await resetJobContinuationCount(env, job.id);
  }

  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected.length > 0) {
    rejected.forEach((result, index) => {
      logger.error(`Review chunk task ${index + 1}/${rejected.length} failed`, result.reason);
    });
    
    // If any rejected task was a transient model error or a per-invocation subrequest-budget
    // hit, surface that single error so the job orchestrator reschedules the chunk on a fresh
    // budget, instead of failing the job with an AggregateError.
    const deferrableError = rejected.map(r => r.reason).find(r => isRetryableModelError(r) || isSubrequestBudgetError(r));
    if (deferrableError) {
      throw deferrableError;
    }

    throw rejected.length === 1
      ? rejected[0].reason
      : new AggregateError(rejected.map((result) => result.reason), `${rejected.length} review chunk tasks failed`);
  }

  const latestReviews = await getFileReviewsForJobs(env, [job.id]);
  // A unit still awaiting its async batch result is NOT complete yet -- exclude it so the job
  // doesn't finalize with pending reviews.
  const terminalUnitKeys = new Set(
    latestReviews.filter((review) => countsAsHandledFileReview(review) && !isAwaitingAsyncReview(review)).map((review) => reviewUnitKey(review.file_path, review.pass)),
  );
  // COMPLETION counts terminal (file,pass) UNITS against units.length: with security on, the phase
  // must not finalize until BOTH passes of every eligible file are terminal.
  const completedUnitCount = units.filter((unit) => terminalUnitKeys.has(reviewUnitKey(unit.file.path, unit.pass))).length;
  // PROGRESS stays FILE-based (distinct main-pass terminal files over files.length) so the check-run
  // never shows a value like 3/2 when security doubles the unit count. This is a SEPARATE counter
  // from the completion check above.
  const terminalMainFilePaths = new Set(
    latestReviews.filter((review) => review.pass === 'main' && countsAsHandledFileReview(review) && !isAwaitingAsyncReview(review)).map((review) => review.file_path),
  );
  const completedCount = files.filter((file) => terminalMainFilePaths.has(file.path)).length;

  if (completedUnitCount >= units.length) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    // The next phase (critic when enabled, else finalize) needs its OWN fresh subrequest budget:
    // finalize posts the GitHub review/labels/check run, and the critic makes its single whole-set
    // model call on a clean budget (D-07). Always hibernate into a new invocation first: the review
    // phase that just finished spent this invocation's budget, and TokenTracker under-reports real
    // usage (it doesn't see Hyperdrive/GitHub subrequests), so a conditional yield let the next phase
    // run in the exhausted invocation and die with "Too many subrequests". Unconditional yield trades
    // a one-time delay for reliability. nextPhaseAfterReview routes through the critic when enabled so
    // a healthy completion can never bypass it (MP-03); critic-off stays 'finalize' (NREG-01).
    await enqueueJobPhase(env, job.id, nextPhaseAfterReview(config), FRESH_INVOCATION_YIELD_SECONDS);
    return;
  }

  // If the only thing left is in-flight async batches (no synchronous work remains to advance),
  // poll again after a short delay rather than immediately re-running. Bound the polling with the
  // shared continuation ceiling: markJobContinuationQueued returns the post-increment count, and
  // because a pending-only chunk never reset it (terminalProgress === 0), a batch that never
  // completes will eventually cross MAX_JOB_CONTINUATIONS and degrade to a partial review instead
  // of polling forever.
  if (awaitingAsync > 0 && terminalProgress === 0) {
    const pollCount = await markJobContinuationQueued(env, job.id, ASYNC_BATCH_POLL_DELAY_SECONDS);
    if (pollCount > MAX_JOB_CONTINUATIONS) {
      logger.error(`Async batch reviews did not complete after ${pollCount} polls; degrading to a partial review: ${job.owner}/${job.repo} PR #${job.prNumber}`);
      for (const review of latestReviews.filter(isAwaitingAsyncReview)) {
        await persistFailedFileReview(env, job.id, {
          filePath: review.file_path,
          pass: review.pass,
          modelUsed: review.async_model ?? review.model_used,
          diffLineCount: review.diff_line_count,
          errorMessage: 'Async batch review did not complete in time.',
          clearAsync: true,
        });
      }
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
      // Async-batch exhaustion degrade: route through the critic selector exactly like a healthy
      // completion so a degraded review still enters the critic when enabled (never bypasses it).
      throw new NextPhaseError(nextPhaseAfterReview(config), FRESH_INVOCATION_YIELD_SECONDS);
    }
    throw new NextPhaseError('review', ASYNC_BATCH_POLL_DELAY_SECONDS);
  }

  if (job.checkRunId) {
    // Best-effort progress cosmetics only: the file reviews for this chunk are already
    // persisted, so a failure here (e.g. this invocation's subrequest budget is spent) must
    // not stop us from enqueuing the next chunk that finishes the job.
    try {
      await vcs.updateStatusCheck(job.owner, job.repo, String(job.checkRunId), {
        title: `Reviewing (${completedCount}/${files.length})`,
        summary: 'OpenCodra is continuing this review in the next queue chunk.',
      });
    } catch (error) {
      logger.warn(`Failed to update progress check run for job ${job.id}; continuing to the next chunk anyway`, error instanceof Error ? error : new Error(String(error)));
    }
  }
  // More files remain -- the next chunk needs a fresh subrequest budget, so yield long enough to
  // force the workflow to hibernate into a new invocation rather than looping in this one (which
  // would accumulate subrequests across chunks until the cap is hit).
  await enqueueJobPhase(env, job.id, 'review', FRESH_INVOCATION_YIELD_SECONDS);
}

/**
 * Persist a completed review produced by the async batch poll path. Mirrors the success branch of
 * reviewAndPersistFile and clears the async bookkeeping columns so the row is terminal ('done').
 */
async function persistCompletedReview(
  env: AppBindings,
  job: PersistedReviewJob,
  file: ReturnType<typeof parseUnifiedDiff>[number],
  response: {
    modelUsed: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    rawText: string;
    userPrompt: string;
    parsed: {
      comments: ParsedReviewComment[];
      verdict: 'approve' | 'comment';
      fileSummary: string;
      overallCorrectness?: string;
      confidenceScore?: number;
      // The severity engine's per-finding audit events for this unit (13-02). Optional so existing
      // mocks that return a `parsed` object without this field stay structurally valid; recordUnitAudit
      // treats undefined/missing as "no extra events" (13-04).
      severityAuditEvents?: JobAuditEvent[];
    };
  },
  // Defaults to 'main' (NREG-01). Threaded from the poll call site (IN-03) so a completed row is
  // keyed on the correct (job_id, file_path, pass) tuple. Async batch rows are main-only today
  // (submitReviewBatch gates on pass === 'main'), so this is behavior-preserving now and correct if
  // async batching is ever extended to the security pass.
  pass: FileReviewPass = 'main',
) {
  await upsertFileReview(env, job.id, {
    filePath: file.path,
    pass,
    fileStatus: 'done',
    modelUsed: response.modelUsed,
    modelProvider: response.provider,
    diffLineCount: file.lineCount,
    diffInput: response.userPrompt,
    rawAiOutput: response.rawText,
    parsedComments: response.parsed.comments,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    durationMs: null,
    verdict: response.parsed.verdict,
    fileSummary: response.parsed.fileSummary,
    overallCorrectness: response.parsed.overallCorrectness,
    confidenceScore: response.parsed.confidenceScore,
    errorMessage: null,
    asyncRequestId: null,
    asyncModel: null,
  });

  // AUD-01: record this completed (file, pass) unit's audit trail — one combined drafted+severity
  // append via a SINGLE recordUnitAudit call (13-03/13-04). Best-effort: recordUnitAudit swallows and
  // logs any failure, so a broken audit write can NEVER fail this async-batch persist or the job.
  await recordUnitAudit(env, job.id, file.path, pass, response.parsed.severityAuditEvents);
}

/**
 * Persist a file review as terminally 'failed' with the shared "mostly-null" shape. Collapses the
 * several near-identical failure upserts (transient-retry exhaustion, hard provider limit, async
 * batch giving up, finalize backfilling missing files) into one place. `clearAsync` wipes the
 * async batch bookkeeping columns for rows that had been submitted to the queue.
 */
async function persistFailedFileReview(
  env: AppBindings,
  jobId: string,
  input: {
    filePath: string;
    // Defaults to 'main' (NREG-01). A failed security unit records its OWN failed row keyed on
    // (job_id, file_path, 'security') rather than clobbering the main row for the same file.
    pass?: FileReviewPass;
    modelUsed: string;
    modelProvider?: string | null;
    diffLineCount: number;
    durationMs?: number | null;
    errorMessage: string;
    clearAsync?: boolean;
  },
) {
  await upsertFileReview(env, jobId, {
    filePath: input.filePath,
    pass: input.pass ?? 'main',
    fileStatus: 'failed',
    modelUsed: input.modelUsed,
    modelProvider: input.modelProvider ?? null,
    diffLineCount: input.diffLineCount,
    diffInput: '',
    rawAiOutput: null,
    parsedComments: [],
    inputTokens: null,
    outputTokens: null,
    durationMs: input.durationMs ?? null,
    verdict: null,
    fileSummary: null,
    errorMessage: input.errorMessage,
    ...(input.clearAsync ? { asyncRequestId: null, asyncModel: null } : {}),
  });
}

async function reviewAndPersistFile(
  env: AppBindings,
  job: PersistedReviewJob,
  file: ReturnType<typeof parseUnifiedDiff>[number],
  pr: VcsPullRequest,
  config: RepoConfig,
  totalLineCount: number,
  model: ModelService,
  resolveFailureModelProvider: () => Promise<string | null>,
  previousReview?: { transient_error_count: number },
  // Which review PASS this call persists. Defaults to 'main' (NREG-01: existing behavior). 'security'
  // routes the SAME resolved model through the security prompt (10-04) and persists a row keyed on
  // (job_id, file_path, 'security'); all failure bookkeeping below is threaded with this pass so a
  // security-unit failure never touches the main row.
  pass: FileReviewPass = 'main',
) {
  const startedAt = Date.now();
  const compactPrompt = (previousReview?.transient_error_count ?? 0) > 0;
  try {
    const response = await model.reviewFile({
      file,
      prTitle: pr.title ?? null,
      prDescription: pr.body ?? null,
      config,
      totalLineCount,
      compactPrompt,
      pass,
    });

    await upsertFileReview(env, job.id, {
      filePath: file.path,
      pass,
      fileStatus: 'done',
      modelUsed: response.modelUsed,
      modelProvider: response.provider,
      diffLineCount: file.lineCount,
      diffInput: response.userPrompt,
      rawAiOutput: response.rawText,
      parsedComments: response.parsed.comments,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: Date.now() - startedAt,
      verdict: response.parsed.verdict,
      fileSummary: response.parsed.fileSummary,
      overallCorrectness: response.parsed.overallCorrectness,
      confidenceScore: response.parsed.confidenceScore,
      errorMessage: null,
    });

    // AUD-01: record this completed (file, pass) unit's audit trail — one combined drafted+severity
    // append via a SINGLE recordUnitAudit call (13-03/13-04). Best-effort: recordUnitAudit swallows and
    // logs any failure, so a broken audit write can NEVER fail this synchronous persist or the job.
    await recordUnitAudit(env, job.id, file.path, pass, response.parsed.severityAuditEvents);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown file review error';
    const modelId = config.model?.main ?? 'unconfigured';
    const modelProvider = await resolveFailureModelProvider();

    // Per-invocation subrequest pressure clears on the next Worker invocation, so do not count
    // it as a per-file provider outage. Let the job-level no-progress continuation ceiling bound
    // a genuinely wedged job while this file remains pending for the fresh-budget retry.
    if (isSubrequestBudgetError(error)) {
      logger.warn(`File review deferred for ${file.path}; subrequest budget will retry in a fresh invocation`, {
        error: errorMessage,
      });
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: FRESH_INVOCATION_YIELD_SECONDS,
        configurable: true,
      });
      throw error;
    }

    // Transient model/provider outages count against the file so a single unrecoverable file
    // eventually becomes a partial-review failure instead of blocking the entire job forever.
    if (isRetryableModelError(error)) {
      const failureCount = await recordRetryableFileReviewFailure(env, job.id, {
        filePath: file.path,
        pass,
        modelUsed: modelId,
        modelProvider,
        diffLineCount: file.lineCount,
        diffInput: '',
        durationMs: Date.now() - startedAt,
        errorMessage,
      });

      if (failureCount >= MAX_RETRYABLE_FILE_REVIEW_FAILURES) {
        const finalError = `Review skipped after ${failureCount} repeated model provider outages.`;
        await persistFailedFileReview(env, job.id, {
          filePath: file.path,
          pass,
          modelUsed: modelId,
          modelProvider,
          diffLineCount: file.lineCount,
          durationMs: Date.now() - startedAt,
          errorMessage: finalError,
        });
        logger.error(`File review failed permanently for ${file.path} after transient retries`, {
          attempts: failureCount,
          error: errorMessage,
        });
        return;
      }

      logger.warn(`File review deferred for ${file.path}; transient model/provider failure will retry later`, {
        error: errorMessage,
        attempts: failureCount,
      });
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: retryableModelFailureDelaySeconds(failureCount),
        configurable: true,
      });
      throw error;
    }

    logger.error(`File review failed for ${file.path}`, { error });

    // A genuine provider allocation exhaustion (e.g. Cloudflare Workers AI daily free
    // allocation, error 4006) won't clear by retrying within this job, so mark the file failed
    // and let the PR review complete as a partial review. (Per-invocation subrequest limits are
    // NOT hard limits -- they're handled as deferrals above and retried on a fresh budget.)
    const isHardLimit =
      errorMessage.includes('4006') ||
      errorMessage.toLowerCase().includes('allocation');

    if (isHardLimit) {
      logger.warn(`File review hit hard provider allocation limit for ${file.path}, marking as failed to allow partial PR review.`, { error: errorMessage });
      // We don't throw here; we just fall through and let it be marked as failed
      // so the PR review can continue and complete as a partial review.
    }

    await persistFailedFileReview(env, job.id, {
      filePath: file.path,
      pass,
      modelUsed: modelId,
      modelProvider,
      diffLineCount: file.lineCount,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
  }
}

/**
 * Fail-open confidence floor for the finalize gate. A finding whose confidence is null OR undefined
 * is ALWAYS kept — a provider that omits confidence (or a review produced before the hardened prompt
 * took effect) must never be zeroed out. Only a finding that carries an explicit confidence below the
 * floor is dropped.
 */
export function passesConfidenceFloor(comment: ParsedReviewComment, minConfidence: number): boolean {
  if (comment.confidence == null) return true;
  return comment.confidence >= minConfidence;
}

async function runFinalizePhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  vcs: VcsProvider,
  formatter: FormatterService,
) {
  await updateJobStep(env, job.id, 'Generating Summary', { status: 'running' });

  // Phase 18 Plan 02 (RND-02 / D-05 / D-13): the no_changes placeholder short-circuits the
  // finalize phase. The audit event was already emitted in prepare; here we only need to:
  //   (a) complete the provider status check with a neutral terminal result (D-05),
  //   (b) complete the job with a NEUTRAL terminal payload (D-13: idempotent so retries do
  //       not append duplicate audit events or repeat completion),
  //   (c) advance the anchor once (D-07: round counter + anchor move in lockstep).
  // NO submitReview, NO walkthrough edit, NO summary comment. The user sees nothing new on the
  // PR; the audit trail shows the round happened.
  if (job.reviewMode === 'no_changes') {
    await finalizeNoChangesPlaceholder(env, job, vcs, leaseOwner);
    return;
  }

  const pr = await vcs.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  const files = await getJobDiffFiles(env, job, vcs, config);
  let reviews = await getFileReviewsForJobs(env, [job.id]);

  // MP-04 / Pitfall 2: pass-aware missing-row reconciliation. Build the EXPECTED set of (path, pass)
  // UNITS — every file has a 'main' unit, plus a 'security' unit when the security pass is on — and
  // compare it against the PRESENT reviewUnitKey(file_path, pass) rows. This replaces the old
  // `reviews.length < files.length` + path-Set check, which could not distinguish passes: once a file
  // can carry both a 'main' and a 'security' row, a security row would pad the count and mask an absent
  // main row (or vice versa). A security row must NEVER satisfy a missing main unit.
  const securityEnabled = config.review.passes?.security?.enabled ?? false;
  const expectedUnits: Array<{ filePath: string; pass: FileReviewPass; diffLineCount: number }> = files.flatMap(
    (file) => {
      const units: Array<{ filePath: string; pass: FileReviewPass; diffLineCount: number }> = [
        { filePath: file.path, pass: 'main', diffLineCount: file.lineCount },
      ];
      if (securityEnabled) {
        units.push({ filePath: file.path, pass: 'security', diffLineCount: file.lineCount });
      }
      return units;
    },
  );

  if (reviews.length < expectedUnits.length) {
    const presentUnitKeys = new Set(reviews.map((review) => reviewUnitKey(review.file_path, review.pass)));
    const missingUnits = expectedUnits.filter(
      (unit) => !presentUnitKeys.has(reviewUnitKey(unit.filePath, unit.pass)),
    );

    if (missingUnits.length > 0) {
      logger.warn(`Job ${job.id} reached finalize phase with ${missingUnits.length} missing (file, pass) review units. Forcing them to failed state.`);
      // Batch the backfill into one INSERT. Doing it per-unit (a transaction each) scales the
      // subrequest cost with the number of missing units and, on a large/growing PR, exhausts the
      // per-invocation budget right before the review is posted (finalize can't safely hibernate --
      // it posts the review -- so it must stay within one invocation's budget). The UNIT-keyed
      // bulkMarkFilesFailed (10-01) writes one 'failed' row per (path, pass), so a missing main unit
      // and a missing security unit are backfilled independently — a security row never satisfies a
      // missing main unit.
      await bulkMarkFilesFailed(
        env,
        job.id,
        missingUnits,
        { modelUsed: config.model?.main ?? 'unconfigured', errorMessage: 'This file was not reviewed before the review run completed.' },
      );

      // Refresh reviews list after inserting the missing ones
      reviews = await getFileReviewsForJobs(env, [job.id]);
    } else {
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });
      // Bounce back to review on a fresh invocation/budget (finalize already spent this one).
      await enqueueJobPhase(env, job.id, 'review', FRESH_INVOCATION_YIELD_SECONDS);
      return;
    }
  }

  // Finalize is now committed to finishing, so the review phase is over. Defensively mark
  // "Reviewing Files" done: some paths into finalize (notably the continuation-ceiling degrade in
  // continueOrFailWedgedJob) don't set it, which otherwise leaves the step stuck showing
  // "In progress" on a job that's actually done. updateJobStep keeps the first finish time, so this
  // no-ops the timestamp when the review phase already marked it done.
  await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });

  // D-09 / MP-04: resolve the finalize candidate set that feeds the (untouched) deterministic floor
  // block below. Precedence:
  //   (i)   a persisted critic result  -> reviewedComments = criticResult.kept. This is READ-ONLY:
  //         finalize NEVER issues a critic model call (D-07); the kept set was computed once in the
  //         critic phase (10-06) and is consumed here (and on any finalize retry) idempotently.
  //   (ii)  else, security pass on      -> dedupeFindings(union(main, security)). This also covers a
  //         FAIL-OPEN wedged critic that left criticResult null (10-06): nothing is lost — the deduped
  //         union still posts. Dedup is gated on passes.security (Pitfall 4): deduping a single main
  //         source would suppress two genuinely similar main-pass findings that post today (NREG).
  //   (iii) else                        -> the v1.0 main-only flatMap, byte-identical to the
  //         pre-multipass engine (NREG-01).
  // Pruned findings are never re-surfaced here (D-08): they live only in jobs.critic_result.pruned.
  //
  // Phase 14 (FILT-03) escape-hatch routing [D-04/D-05, review findings #1/#5]. `dedup.enabled`
  // defaults true and governs the DEDUP dimension ONLY — it selects which dedup function runs inside
  // applyNoiseFilter; the always-on FILT-01 tiered cap, FILT-02 per-category floors, and the FR-180
  // confidence-desc sort apply regardless of the flag.
  //   dedupEnabled === true (default): chosenDedup = dedupeComposite, which runs IN-CHAIN (FR-180
  //     position) on WHICHEVER candidate set is selected — INCLUDING the critic-kept set. So ALL THREE
  //     candidate branches stay UN-deduped at selection time (the legacy pre-chain dedupeFindings call
  //     is dropped for the security branch); a critic review's kept set now gets always-on composite
  //     dedup at finalize (FILT-03 "every review") and any merges emit `deduped` audit events (FILT-04).
  //   dedupEnabled === false: preserve TODAY's exact DEDUP behavior — the legacy security-gated
  //     dedupeFindings(union) stays in its pre-chain position for the non-critic security path ONLY
  //     (RESEARCH Pitfall 1 / A6 — preserves survivor-vs-floor ordering); critic-kept and main-only are
  //     consumed as-is; a no-op dedup is passed into applyNoiseFilter so the floors/sort/cap still run
  //     but no re-dedup happens. This is a provable pre-v1.2 revert of the DEDUP dimension (SC3).
  const dedupEnabled = config.review.dedup?.enabled ?? true;
  const chosenDedup: NoiseFilterOptions['dedup'] = dedupEnabled
    ? dedupeComposite
    : (comments) => ({ survivors: comments, merges: [] });
  let reviewedComments: ParsedReviewComment[];
  if (job.criticResult) {
    reviewedComments = job.criticResult.kept;
  } else if (securityEnabled) {
    reviewedComments = dedupEnabled
      ? reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[])
      : dedupeFindings(reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]));
  } else {
    reviewedComments = reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]);
  }
  // Pitfall 3 (NREG): split the reviews into the main pass for every Phase-9 surface. mainReviews
  // feeds fileSummaries, the verdict aggregation, successfulReviews/confidence/correctness, and the
  // walkthrough — so toggling passes.security/critic never changes the summary narrative inputs, the
  // verdict, or the walkthrough coverage/counts/ordering. ALL `reviews` rows feed ONLY the token
  // totals (security tokens were really spent) and the finding candidate union (reviewedComments).
  // When passes.security is off, mainReviews === reviews so everything below is byte-identical (NREG-01).
  const mainReviews = reviews.filter((review) => review.pass === 'main');

  const fileSummaries = mainReviews.map((review) => ({
    path: review.file_path,
    summary: review.file_status === 'failed'
      ? `Review failed: ${review.error_msg ?? 'Unknown file review error'}`
      : (review.file_summary ?? ''),
    verdict: review.file_status === 'failed' ? 'failed' : (review.verdict ?? 'comment'),
  }));

  if (fileSummaries.length > 0 && fileSummaries.every((file) => file.verdict === 'failed')) {
    await updateJobStep(env, job.id, 'Generating Summary', { status: 'failed', error: 'All files failed to review' });

    throw new Error('All files failed to review');
  }

  const hasFailures = fileSummaries.some((file) => file.verdict === 'failed');
  const failedFileCount = fileSummaries.filter((file) => file.verdict === 'failed').length;
  const { maxComments: globalMaxComments } = await getReviewSettings(env);
  const effectiveMaxComments = Math.min(config.review.max_comments, globalMaxComments);

  // FR-180 always-on noise filter (FILT-01/02 + FR-180 sort + escape-hatched FILT-03 dedup). Both
  // finalize paths call the SAME applyNoiseFilter over their respective candidate sets (SC5). The
  // posting path keeps `dropped` for the posting-path-only audit emission below; omittedCount is the
  // tiered-cap trim count ONLY (dropped.cap.length) — the "N comments trimmed to {max}" footer counts
  // P3/nit cap trims exclusively, NOT confidence/severity/dedup drops nor the exempt P0/P1/P2
  // (Pitfall 2 / A4 / review finding #3).
  const composedFloors = composeRoundFloors({
    reviewRound: job.reviewRound ?? 1,
    reviewMode: job.reviewMode ?? 'full',
    roundsIncremental: job.roundsIncremental ?? false,
    escalateFloors: config.review.rounds?.escalate_floors ?? true,
    base: {
      minConfidence: config.review.min_confidence,
      categoryConfidence: config.review.category_confidence,
      minSeverity: config.review.min_severity,
    },
  });
  const noiseFilterOptions: NoiseFilterOptions = {
    minConfidence: composedFloors.minConfidence,
    categoryConfidence: composedFloors.categoryConfidence,
    minSeverity: composedFloors.minSeverity,
    effectiveMaxComments,
    dedup: chosenDedup,
  };
  const postingResult = applyNoiseFilter(reviewedComments, noiseFilterOptions);
  const finalComments = postingResult.kept;
  const omittedCount = postingResult.dropped.cap.length;

  // Pitfall 3 (corrected): buildWalkthroughData ALREADY filters its `reviews` arg to pass==='main'
  // internally (walkthrough.ts), but it derives per-file counts and global severity counts from its
  // `finalComments` arg — so passing the MIXED finalComments (main + security + critic-kept) would
  // leak security findings into the Phase-9 walkthrough counts and file ordering. Compute a SEPARATE
  // main-only finalComments by applying the EXACT SAME floor block (min_severity rank filter ->
  // confidence floor -> severity sort -> slice to effectiveMaxComments) to the main-pass findings.
  // This is the exact v1.0 main-only finalComments computation, so the walkthrough coverage, per-file
  // + global severity counts, and file ordering are identical whether or not security/critic is on.
  // The verdict is likewise driven by this main-only set (a Phase-9 surface — security findings post
  // as inline comments but must not change the overall approve/comment verdict). When both toggles are
  // off, mainReviews === reviews and reviewedComments is the main-only flatMap, so mainFinalComments
  // is element-wise identical to finalComments (NREG-01).
  // SC5: the walkthrough path runs the IDENTICAL applyNoiseFilter (same transformation, same escape-
  // hatched dedup) over the main-pass candidate set. D-11: its `dropped` is DISCARDED and nothing is
  // recorded — audit suppression is caller-side, the pure fn has no I/O to suppress. Agreement with the
  // posting path is asserted on the MAIN-PASS SUBSET (the walkthrough is intentionally main-only;
  // posted totals include security).
  const mainCandidateComments = mainReviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]);
  const mainFinalComments = applyNoiseFilter(mainCandidateComments, noiseFilterOptions).kept;

  const verdictSummary = formatter.summarizeVerdict(mainFinalComments, hasFailures);
  await updateJobStep(env, job.id, 'Generating Summary', { status: 'done' });
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  // Aggregate job-level confidence/correctness from the already-loaded `reviews` rows,
  // independent of the best-effort AI narrative call below. This fixes a latent bug: completeJob
  // has always accepted overallConfidenceScore/overallCorrectness but finalize never computed or
  // passed them, so both columns were always null. Only successfully-reviewed (non-failed) files
  // count toward the aggregate -- a failed file's null confidence/correctness would otherwise
  // silently drag the average/verdict down.
  const successfulReviews = mainReviews.filter((review) => review.file_status !== 'failed');
  const confidenceScores = successfulReviews
    .map((review) => review.confidence_score)
    .filter((score): score is number => score !== null && score !== undefined);
  const confidenceScore = confidenceScores.length > 0
    ? confidenceScores.reduce((sum, score) => sum + score, 0) / confidenceScores.length
    : null;
  const overallCorrectness = successfulReviews.some((review) =>
    (review.overall_correctness ?? '').toLowerCase().includes('incorrect'),
  )
    ? 'patch is incorrect'
    : 'patch is correct';

  // Best-effort AI narrative synthesizing the review. Finalize posts the review and cannot safely
  // hibernate/retry, so ANY failure here (including RetryableModelError) must be caught and must
  // never fail or retry the job -- we simply fall back to a recap-only overview (narrative: null).
  const summaryTracker = new TokenTracker();
  const summaryModelService = new ModelService(env, summaryTracker, { jobId: job.id });
  let narrative: string | null = null;
  let summaryModelUsed: string | null = null;
  let summaryInputTokens = 0;
  let summaryOutputTokens = 0;
  try {
    const summaryResponse = await summaryModelService.generateSummary({
      prTitle: pr.title,
      verdict: verdictSummary.verdict,
      fileSummaries,
      config,
    });
    narrative = parseSummaryResponse(summaryResponse.rawText);
    summaryModelUsed = summaryResponse.modelUsed;
    summaryInputTokens = summaryResponse.inputTokens;
    summaryOutputTokens = summaryResponse.outputTokens;
  } catch (error) {
    logger.warn(
      `generateSummary failed for job ${job.id}; falling back to a recap-only overview`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  const severityCounts: Record<ParsedReviewComment['severity'], number> = { P0: 0, P1: 0, P2: 0, P3: 0, nit: 0 };
  for (const comment of finalComments) {
    severityCounts[comment.severity] = (severityCounts[comment.severity] ?? 0) + 1;
  }
  const topFindings = finalComments.slice(0, 5).map((c) => ({ severity: c.severity, title: c.title, path: c.path }));

  // D-10/D-11 footer inputs: surface the commands hint whenever the commands feature is enabled, and
  // the skipped-for-size line when a full review recorded omissions for this head. The skip count is
  // read from skipped_files (best-effort -- a read failure degrades to no skipped line, never fails
  // finalize) and only for a NORMAL full review (a review-rest job IS the rest pass, so it shows the
  // hint but never the "N skipped" line). When commands is off, both stay inert and the footer is
  // byte-identical to today (NREG-01).
  const commandsEnabled = config.review.interactive?.commands?.enabled ?? false;
  let skippedForSizeCount = 0;
  if (commandsEnabled && job.reviewScope !== 'rest' && job.commitSha) {
    try {
      const skipped = await listSkippedFilesForHead(env, skippedFilesKeyForJob(job));
      skippedForSizeCount = skipped.length;
    } catch (error) {
      logger.warn(`Failed to read skipped-for-size count for job ${job.id}; omitting the review-rest footer line`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  const formattedSummary = formatter.formatReviewOverview(
    {
      commitSha: pr.headSha,
      botUsername: env.BOT_USERNAME,
      narrative,
      verdict: verdictSummary.verdict,
      confidenceScore,
      severityCounts,
      topFindings,
      filesReviewed: files.length,
      omittedCount,
      maxComments: effectiveMaxComments,
      commandsEnabled,
      skippedForSizeCount,
    },
    { provider: vcs.name },
  );

  // If a prior finalize attempt already reached the posting stage (the 'Completing' step was
  // started) and then died before completeJob recorded the review id, the review may already be on
  // GitHub. Re-posting would duplicate it, so reuse the existing one. This GitHub read is only paid
  // on an actual finalize re-run, never on the common first pass.
  const finalizeRetriedPastPost = job.steps.some(
    (step) => step.name === 'Completing' && (step.status === 'running' || step.status === 'done'),
  );
  await updateJobStep(env, job.id, 'Completing', { status: 'running' });

  // FILT-04 / review finding #7: emit finalize drop audit events on the POSTING path ONLY and
  // AT-MOST-ONCE across finalize retries. Gated on !finalizeRetriedPastPost and positioned AFTER the
  // 'Completing' running transition was persisted: appendJobAuditEvents has no idempotency key and
  // always concatenates, so a finalize retry that already reached posting (finalizeRetriedPastPost ===
  // true) MUST skip re-appending or it would double the drop trail. buildFinalizeDropEvents derives the
  // per-record confidence threshold from each DropRecord's effectiveFloor (review finding #2), so it
  // takes only { severityFloor, cap }. recordFinalizeDrops is best-effort (never rethrows), so a broken
  // audit write can never fail the already-posting review. The walkthrough path emits nothing (D-11).
  // A crash between this persisted 'Completing' transition and the recorder loses these events (best-
  // effort telemetry, accepted) while at-most-once still holds.
  if (!finalizeRetriedPastPost) {
    await recordFinalizeDrops(
      env,
      job.id,
      buildFinalizeDropEvents(postingResult.dropped, {
        severityFloor: composedFloors.minSeverity,
        cap: effectiveMaxComments,
      }),
    );
    if (composedFloors.effectiveChanged) {
      await recordRoundAudit(env, job.id, [
        buildRoundsEscalatedEvent({
          from: {
            minConfidence: config.review.min_confidence,
            minSeverity: config.review.min_severity,
          },
          to: composedFloors.roundFloor,
          effective: {
            minConfidence: composedFloors.minConfidence,
            minSeverity: composedFloors.minSeverity,
          },
          round: job.reviewRound ?? 1,
          droppedAtEffectiveFloor:
            postingResult.dropped.confidenceFloor.length + postingResult.dropped.severityFloor.length,
        }),
      ]);
    }
  }
  // The interface omits botLogin (Pitfall 5) -- the adapter injects env.BOT_USERNAME internally.
  const existingReview = finalizeRetriedPastPost
    ? await vcs.findExistingReviewForCommit(job.owner, job.repo, job.prNumber, pr.headSha)
    : null;
  const review = existingReview ?? await vcs.submitReview(job.owner, job.repo, job.prNumber, {
    commitSha: pr.headSha,
    verdict: verdictSummary.verdict,
    summaryBody: formattedSummary,
    jobIdHint: job.id,
    comments: finalComments.map(comment => ({
      path: comment.path,
      position: comment.position ?? undefined,
      body: formatter.formatInlineComment(comment, { provider: vcs.name }),
    })),
  });

  const fileInputTokens = reviews.reduce((sum, review) => sum + (review.input_tokens ?? 0), 0) + summaryInputTokens;
  const fileOutputTokens = reviews.reduce((sum, review) => sum + (review.output_tokens ?? 0), 0) + summaryOutputTokens;

  const partialErrorMessage = hasFailures
    ? `Partial review: ${failedFileCount} of ${files.length} file${files.length === 1 ? '' : 's'} could not be reviewed.`
    : null;
  // The review is already on GitHub at this point (submitReview above). completeJob below is the
  // critical, must-not-lose write that records the posted review id and marks the job done. Between
  // here and completeJob run best-effort steps: the walkthrough edit (which now precedes completeJob
  // BY DESIGN so the supersede re-check is effective — see the block comment there — NOT "immediately
  // after createReview" as this comment once claimed), its optional one-shot diagram model call, and
  // the remaining label/check-run cosmetics. Any of these can consume this invocation's shared
  // subrequest budget on a large PR; we must not let them exhaust it and leave the job stranded as
  // 'failed' with review_id null. The diagram call is additionally skipped when the finalize budget
  // is already tight (WR-01) so it cannot push the invocation over the cap ahead of completeJob.
  // Guard the ref -> id conversion (WR-03): a non-numeric ref (the Bitbucket case this seam
  // anticipates) would otherwise write NaN into review_id unguarded. Fail loudly here until
  // review_id becomes `text` to hold opaque refs (Phase 4/5 schema decision).
  const numericReviewId = Number(review.ref);
  if (!Number.isFinite(numericReviewId)) {
    throw new Error(`Provider ${vcs.name} returned a non-numeric review ref: ${review.ref}`);
  }

  // WT-01/WT-05/D-06: edit the placeholder into the complete walkthrough. This runs AFTER
  // submitReview (the review is already posted, and the finalizeRetriedPastPost double-post guard
  // above covers a finalize retry) and BEFORE completeJob (the job is still `running`, so the
  // supersede re-check is EFFECTIVE and a natural finalize re-run re-attempts the idempotent edit) —
  // cross-AI blockers 1 + 3. It is its OWN best-effort try/catch, separate from the cosmetics block
  // below: a walkthrough failure must NEVER re-throw out of finalize, because a generic throw here
  // would fail an already-posted review at the runReviewJob catch (review.ts failJobAndCheckRun).
  //
  // Gated on files.length > 0 to stay symmetric with the D-11 placeholder gate: a 0-file job posts
  // no placeholder in prepare, so finalize must not fall into editWalkthroughComment's defensive
  // "no ref -> create" branch and post a walkthrough for a job that legitimately has nothing to show.
  // (The defensive branch still fires for the real case — files exist but the ref write failed in
  // prepare — because files.length > 0 there.)
  // WT-03 (Plan 09-03): the optional Mermaid diagram is ONE whole-diff, best-effort model call whose
  // tokens must reach completeJob. These accumulate 0 unless the diagram is actually attempted AND
  // succeeds — so with the diagram gated off they stay 0 and the completeJob totals are byte-identical
  // to before (NREG-01). Declared here (function scope) so they are in scope at completeJob below.
  let diagramInputTokens = 0;
  let diagramOutputTokens = 0;

  if (config.review.walkthrough.enabled && files.length > 0) try {
    // (a) Supersede re-check INLINE (D-06): the private heartbeatAndCheckSuperseded is already in
    // scope here, so core/walkthrough.ts never imports it (no core/ module cycle — cross-AI blocker
    // 4). A superseded (stale-commit) job must not edit the walkthrough; catch JOB_SUPERSEDED
    // LOCALLY and skip only the edit — the already-posted review must still reach completeJob, so we
    // never re-throw.
    let superseded = false;
    try {
      await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);
    } catch (error) {
      if (error instanceof Error && error.message === 'JOB_SUPERSEDED') {
        superseded = true;
        logger.info(`Job ${job.id} superseded at the walkthrough edit; skipping the walkthrough (review already posted)`);
      } else {
        throw error;
      }
    }
    if (!superseded) {
      // (b) WT-03: the OPTIONAL Mermaid diagram. Gated on BOTH the provider capability
      // (capabilities.supportsMermaid — GitHub true / Bitbucket false, D-13) AND the sequence_diagram
      // sub-toggle (D-09). When gated OFF the diagram model call is NOT made at all — Bitbucket and the
      // sub-toggle-off path skip the outbound request entirely (Pitfall #7, saves the subrequest), and
      // mermaid stays null so formatWalkthrough emits no fence. Its OWN best-effort try/catch: any model
      // error OR a null parse (WT-04) omits the diagram and posts the walkthrough without it — it never
      // fails the job (D-07, D-04a). It is exactly ONE outbound request (generateWalkthroughDiagram is
      // primary-model-only) and never touches the per-file subrequest budget (Pitfall #1).
      let mermaid: string | null = null;
      if (
        vcs.capabilities.supportsMermaid &&
        config.review.walkthrough.sequence_diagram.enabled &&
        // WR-01: graceful omission. The diagram is one more outbound model fetch that counts against
        // this invocation's shared Cloudflare subrequest cap AND runs BEFORE the must-not-lose
        // completeJob write. If finalize's budget is already tight, skip the diagram entirely rather
        // than risk pushing the invocation over the cap ahead of completeJob — the walkthrough simply
        // posts without a diagram (best-effort, D-07). summaryTracker is finalize's own tracker,
        // reused for the diagram call below so this guard reflects the subrequests finalize has
        // actually spent instead of a fresh, always-empty tracker's false sense of isolation.
        !summaryTracker.isNearLimit()
      ) {
        try {
          // Reuse summaryTracker (the finalize-level tracker) rather than a fresh one: the diagram
          // fetch shares this invocation's subrequest budget, so it must be accounted against the
          // same tracker the near-limit guard above reads (WR-01). It is still exactly ONE
          // primary-model-only call (generateWalkthroughDiagram) — no fallback fan-out, and it never
          // touches the per-file subrequest budget. Diagram tokens are read from the response below,
          // not the tracker, so folding them into completeJob stays correct.
          const diagramModelService = new ModelService(env, summaryTracker, { jobId: job.id });
          const diagramResponse = await diagramModelService.generateWalkthroughDiagram({
            prTitle: pr.title,
            files, // the ACTUAL parsed diff (FileDiff[]), not only fileSummaries (cross-AI blocker 2)
            fileSummaries,
            config,
          });
          mermaid = parseWalkthroughDiagram(diagramResponse.rawText); // tolerant parse -> null on garbage
          // Fold the diagram call's tokens into the completeJob totals (token-accounting MEDIUM).
          diagramInputTokens = diagramResponse.inputTokens;
          diagramOutputTokens = diagramResponse.outputTokens;
        } catch (error) {
          logger.warn(
            `generateWalkthroughDiagram failed for job ${job.id}; posting the walkthrough without a diagram`,
            error instanceof Error ? error : new Error(String(error)),
          );
          mermaid = null;
        }
      }
      // (c) deterministic aggregation over the main-pass reviews + the floored/capped finalComments.
      const data = buildWalkthroughData({ reviews: mainReviews, finalComments: mainFinalComments });
      // (d) single in-place edit (delete-recovery + bounded transient retry live in the helper). The
      // mermaid fence is added GitHub-only by formatWalkthrough (Plan 01), filling the Plan 02 seam.
      await editWalkthroughComment({ env, job, config, vcs, formatter, data, mermaid });
    }
  } catch (error) {
    // (d) Best-effort: the review is posted; a persistent walkthrough failure logs a warn and the
    // job still completes. The block MUST NOT re-throw.
    logger.warn(`Walkthrough edit failed for job ${job.id}; review is posted, leaving it best-effort`, error instanceof Error ? error : new Error(String(error)));
  }

  await completeJob(env, job.id, {
    verdict: verdictSummary.verdict,
    fileCount: files.length,
    commentCount: finalComments.length,
    // Diagram tokens (0 unless the WT-03 diagram was attempted and succeeded) are folded in here so
    // the optional diagram's usage is not lost from persisted job accounting (token-accounting MEDIUM).
    // Critic tokens (0 when the critic is off — criticResult is null — so byte-identical to v1.0) are
    // folded in alongside the file, summary, and diagram tokens so the critic's usage is not dropped
    // from persisted job accounting (token-accounting MEDIUM). Finalize only READS these persisted
    // values; it never re-calls the critic model (D-07).
    totalInputTokens: fileInputTokens + diagramInputTokens + (job.criticResult?.inputTokens ?? 0),
    totalOutputTokens: fileOutputTokens + diagramOutputTokens + (job.criticResult?.outputTokens ?? 0),
    summaryMarkdown: formattedSummary,
    // ref -> id at this boundary (D-02); the numeric review_id column stays canonical.
    reviewId: numericReviewId,
    summaryModel: summaryModelUsed,
    overallConfidenceScore: confidenceScore,
    overallCorrectness,
    errorMessage: partialErrorMessage,
  });
  logger.info(`Review job completed: ${job.owner}/${job.repo} PR #${job.prNumber}`);

  // The cached PR diff is only needed while the job is being reviewed. Drop it now the job is done
  // so completed jobs don't leave large diff blobs sitting in KV until the 6h TTL expires.
  try {
    await env.APP_KV.delete(diffCacheKey(job.id));
  } catch (error) {
    logger.warn(`Failed to delete cached diff for completed job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
  }

  // Cosmetics: labels and the check-run conclusion. Best-effort -- the review is posted and the job
  // is already 'done', so a failure here (e.g. subrequest budget spent, GitHub blip) must not fail
  // the job. completeTerminalCheckRuns / a re-run can reconcile a check run left un-updated.
  try {
    // Check-run conclusion first: it drives the PR's status badge, so it matters more than labels
    // if the budget only allows one of them.
    // R-02: the gate is widened to (statusCheckRef || checkRunId) so the Bitbucket path -- which
    // only ever writes the TEXT status_check_ref (D-10) and never has a numeric check_run_id --
    // still reaches the cosmetic-update try/catch block. The inner ref-string source is also
    // provider-aware: GitHub passes String(checkRunId) (numeric), Bitbucket passes the TEXT
    // status_check_ref directly. `markJobCheckRunCompleted` is intentionally NOT called for the
    // Bitbucket path (it updates the GitHub check_run_completed_at column; Bitbucket tracks its
    // own completion via Code Insights / build-status); the Bitbucket path's `updateStatusCheck`
    // already issues a PUT + POST that completes the review.
    if (job.statusCheckRef || job.checkRunId) {
      const statusRef = job.statusCheckRef ?? (job.checkRunId !== null ? String(job.checkRunId) : '');
      await vcs.updateStatusCheck(job.owner, job.repo, statusRef, {
        status: 'completed',
        conclusion: hasFailures ? 'failure' : (verdictSummary.verdict === 'approve' ? 'success' : 'neutral'),
        title: hasFailures ? 'Review partially failed' : (verdictSummary.verdict === 'approve' ? 'LGTM' : 'Comments posted'),
        summary: `${finalComments.length} inline comments across ${files.length} files.${hasFailures ? ` ${failedFileCount} file${failedFileCount === 1 ? '' : 's'} could not be reviewed.` : ''}`,
      });
      // Only now is the check run genuinely completed -- record it so the maintenance sweep doesn't
      // redo it. If the update above threw, this line is skipped and completeTerminalCheckRuns will
      // finish the check run on a later invocation with a fresh budget.
      // NOTE: this column is GitHub-specific (completeTerminalCheckRuns reads check_run_id). For
      // Bitbucket jobs, `markJobCheckRunCompleted` is a no-op against a row with check_run_id NULL
      // (the row's status_check_ref is the source of truth for completion); the maintenance sweep
      // routes through VcsService.forRepo so the Bitbucket adapter's updateStatusCheck is called.
      await markJobCheckRunCompleted(env, job.id);
    }

    // Bitbucket Cloud has no native PR-labels feature (Pattern 2) -- feature-detect rather than
    // assume every provider has labels.
    if (vcs.labels && config.review.labels !== false) {
      const labels = config.review.labels;
      const labelMap = {
        comment: { name: labels.p1, color: 'f79009' },
        approve: { name: labels.p2, color: '027a48' },
      } as const;
      const label = labelMap[verdictSummary.verdict];

      await vcs.labels.removeIfPresent(
        job.owner,
        job.repo,
        job.prNumber,
        [labels.p1, labels.p2, labels.p3].filter(possibleLabel => possibleLabel !== label.name),
      );

      await vcs.labels.ensure(job.owner, job.repo, label.name, label.color);
      await vcs.labels.add(job.owner, job.repo, job.prNumber, [label.name]);
    }
  } catch (error) {
    logger.warn(`Post-review labels/check-run update failed for job ${job.id}; review is posted and job is completed, so leaving it best-effort`, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The dedicated critic phase (D-07 / D-05 / MP-03). Runs BETWEEN review and finalize on its OWN fresh
 * subrequest budget: it assembles the full candidate finding set (union of every (file, pass) review
 * row), dedupes it (only when the security pass is on — Pitfall 4), then makes at most ONE whole-set,
 * ID-based, PRUNE-ONLY model call and reconciles `kept = deduped MINUS pruned-by-index` in code (a
 * model keep-list is never trusted — T-10-10). The result blob { kept, pruned } is persisted to
 * jobs.critic_result for finalize (10-07) to consume.
 *
 * Two hard contracts:
 *   - IDEMPOTENT: a valid persisted job.criticResult short-circuits straight to finalize with NO model
 *     call, so a re-invocation after a persist-then-enqueue-failure never re-critiques (review-verified
 *     HIGH).
 *   - FAIL-OPEN (D-05): the critic is conservative and NEVER terminal-fails or loses a finding. On any
 *     model/parse error (including RetryableModelError) it keeps ALL findings and records
 *     { skipped: true, pruned: [] }; only a subrequest-budget error is re-thrown so it retries on a
 *     fresh instance (continueOrFailWedgedJob's critic ceiling), then fails open to finalize.
 * The critic model call NEVER runs inside finalize (D-07) — it lives only here.
 */
async function runCriticPhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  model: ModelService,
) {
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;

  // (1) IDEMPOTENCY: a valid persisted result means the model call already ran (or was skipped) on a
  // prior invocation that then died before finalize picked up. mapJob has already safeParsed the blob
  // (a malformed one degrades to null), so a non-null criticResult is trustworthy. Skip straight to
  // finalize with NO model call so a re-entry after hibernation never re-critiques (T-10-12 / cost).
  if (job.criticResult) {
    logger.info(`Critic result already persisted for job ${job.id}; skipping the model call and transitioning to finalize.`);
    await enqueueJobPhase(env, job.id, 'finalize', FRESH_INVOCATION_YIELD_SECONDS);
    return;
  }

  // (2) TOGGLE-OFF fail-open: a critic phase reached with passes.critic off (config drift / a stale
  // in-flight message after the toggle was turned off) must NOT run — fail open straight to finalize
  // so behavior is byte-identical to the critic-off engine (NREG-01, Pitfall 5).
  if (!config.review.passes?.critic?.enabled) {
    logger.info(`Critic phase reached for job ${job.id} but passes.critic is off; failing open to finalize.`);
    await enqueueJobPhase(env, job.id, 'finalize', FRESH_INVOCATION_YIELD_SECONDS);
    return;
  }

  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  // (3) TERMINAL-ROWS ASSERTION (Pitfall 5 / OpenCode #3): the critic assembles the candidate set from
  // the persisted (file, pass) review rows and assumes the review phase FULLY completed — every row is
  // terminal (done/failed/skipped). A 'pending' row means the review phase is not actually finished
  // (an async batch still in flight), so critiquing now would judge an incomplete set. This is an
  // invariant violation, not a transient: the review-completion / degrade paths mark any lingering
  // async row failed before handing off to the critic, so a pending row here is a scheduling bug.
  const reviews = await getFileReviewsForJobs(env, [job.id]);
  const pendingRow = reviews.find((review) => review.file_status === 'pending');
  if (pendingRow) {
    throw new Error(`Critic phase reached with a non-terminal review row (${pendingRow.file_path}/${pendingRow.pass}); the review phase did not fully complete.`);
  }

  // (4) Candidate set = union of EVERY row's findings (main + security), in stable row order. dedup is
  // applied ONLY when the security pass is on: a single main source has no cross-pass duplicates, and
  // deduping it would change the main-only finding set — an NREG-01 violation (Pitfall 4).
  const candidateSet = reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]);
  const securityEnabled = config.review.passes?.security?.enabled ?? false;
  // Phase 14: intentionally unchanged — critic dedup runs in the critic phase (Phase 19 scope); its
  // legacy merges are not Phase-14-audited (14-03 known gap). When security+critic are both on, this
  // legacy dedupeFindings pre-dedups BEFORE persisting criticResult.kept, so those critic-stage merges
  // emit no Phase-14 `deduped` event — the finalize composite dedup only audits merges among the
  // already-pruned kept set.
  const dedupedSet = securityEnabled ? dedupeFindings(candidateSet) : candidateSet;

  // (5) SKIP conditions (D-06): a trivially small set isn't worth a round-trip, and an oversized set
  // can't be chunked — both keep ALL findings and record skipped:true (nothing lost, audit-visible).
  const skipThreshold = config.review.passes.critic.skip_threshold ?? CRITIC_SKIP_THRESHOLD;
  const charBudget = config.review.passes.critic.input_char_budget ?? CRITIC_INPUT_CHAR_BUDGET;
  const serializedChars = JSON.stringify(dedupedSet).length;
  if (dedupedSet.length <= skipThreshold || serializedChars > charBudget) {
    logger.info(`Critic skipping the model call for job ${job.id} (keep-all).`, {
      dedupedCount: dedupedSet.length,
      skipThreshold,
      serializedChars,
      charBudget,
      reason: dedupedSet.length <= skipThreshold ? 'below-skip-threshold' : 'over-char-budget',
    });
    await updateJobCriticResult(env, job.id, {
      kept: dedupedSet,
      pruned: [],
      skipped: true,
      dedupedCount: dedupedSet.length,
    });
    await enqueueJobPhase(env, job.id, 'finalize', FRESH_INVOCATION_YIELD_SECONDS);
    return;
  }

  // (6) The single whole-set, ID-based, PRUNE-ONLY model call + in-code reconciliation. Wrapped in a
  // fail-open try/catch (7): any error EXCEPT a subrequest-budget hit keeps all findings and continues.
  let criticResult: CriticResult;
  try {
    const response = await model.critiqueFindings({
      findings: dedupedSet.map((finding) => ({
        path: finding.path,
        line: finding.line ?? null,
        severity: finding.severity,
        title: finding.title,
        body: finding.body,
      })),
      prTitle: job.prTitle,
      config,
    });

    // RECONCILE IN CODE (T-10-10): map each pruned INDEX id back to a finding. Ignore out-of-range and
    // duplicate ids; a model keep-list is never trusted — kept = deduped MINUS pruned-by-index. This is
    // what makes a hallucinated/injected finding structurally unable to enter the posted set.
    const pruneList = parseCriticPruneResponse(response.rawText);
    const prunedIndices = new Set<number>();
    const pruned: CriticResult['pruned'] = [];
    for (const { id, reason } of pruneList) {
      if (!Number.isInteger(id) || id < 0 || id >= dedupedSet.length) continue; // out-of-range id ignored
      if (prunedIndices.has(id)) continue; // duplicate id ignored
      prunedIndices.add(id);
      pruned.push({ finding: dedupedSet[id], reason });
    }
    const kept = dedupedSet.filter((_finding, index) => !prunedIndices.has(index));

    criticResult = {
      kept,
      pruned,
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      dedupedCount: dedupedSet.length,
      skipped: false,
    };
    logger.info(`Critic pruned ${pruned.length}/${dedupedSet.length} findings for job ${job.id}.`, {
      kept: kept.length,
      pruned: pruned.length,
      model: response.modelUsed,
    });
  } catch (error) {
    // (7) A subrequest-budget error is NOT a critic failure — it clears on a fresh invocation. Re-throw
    // so runReviewJob's catch routes it through continueOrFailWedgedJob (critic ceiling), which retries
    // on a fresh instance and ultimately fails OPEN to finalize. Everything else (including
    // RetryableModelError, a parse failure, a resolveModel miss) fails open HERE: keep all findings.
    if (isSubrequestBudgetError(error)) {
      throw error;
    }
    logger.warn(
      `Critic model call failed for job ${job.id}; failing open (keeping all findings, no prune applied)`,
      error instanceof Error ? error : new Error(String(error)),
    );
    criticResult = {
      kept: dedupedSet,
      pruned: [],
      skipped: true,
      dedupedCount: dedupedSet.length,
    };
  }

  // Persist BEFORE the (throwing) finalize hand-off so a persist-then-enqueue-failure re-enters this
  // phase, hits the idempotency short-circuit (1), and never re-critiques.
  await updateJobCriticResult(env, job.id, criticResult);
  await enqueueJobPhase(env, job.id, 'finalize', FRESH_INVOCATION_YIELD_SECONDS);
}

async function heartbeatAndCheckSuperseded(env: AppBindings, jobId: string, leaseOwner: string) {
  await heartbeatJobLease(env, jobId, leaseOwner, JOB_LEASE_SECONDS);
  const currentJob = await getJobForProcessing(env, jobId);
  if (currentJob?.status === 'superseded') {
    throw new Error('JOB_SUPERSEDED');
  }
}

export class NextPhaseError extends Error {
  constructor(public phase: 'prepare' | 'review' | 'finalize' | 'critic', public delaySeconds: number) {
    super(`NextPhase: ${phase}`);
  }
}

/**
 * Single source of truth for where the review phase hands off (D-07 / MP-03). When the critic pass is
 * enabled the critic runs as its OWN fresh-budget phase BETWEEN review and finalize; otherwise the
 * review goes straight to finalize exactly as it did pre-critic. EVERY review-exit path — normal
 * completion, async-batch exhaustion, and the continuation-ceiling degrade in continueOrFailWedgedJob
 * — routes through this selector, so a degraded review can NEVER bypass the critic when it is enabled.
 * With passes.critic off this returns 'finalize' unconditionally, so routing is byte-identical to the
 * pre-critic engine (NREG-01).
 */
function nextPhaseAfterReview(config: RepoConfig): 'critic' | 'finalize' {
  return config.review.passes?.critic?.enabled ? 'critic' : 'finalize';
}

async function enqueueJobPhase(
  env: AppBindings,
  jobId: string,
  phase: 'prepare' | 'review' | 'finalize' | 'critic',
  delaySeconds = 0,
) {
  await markJobContinuationQueued(env, jobId, delaySeconds);
  throw new NextPhaseError(phase, delaySeconds);
}

function hasCompletedStep(job: PersistedReviewJob, stepName: string) {
  return job.steps.some((step) => step.name === stepName && step.status === 'done');
}

function diffCacheKey(jobId: string) {
  return `diff:${jobId}`;
}

/**
 * Phase 18 Plan 02 (RND-01 / D-01..D-06): re-resolve the round context for the prepare phase
 * using the SAME inputs `resolveRoundContext` consumes (review scope, prior pr_review_state,
 * unresolved bot threads, rounds.incremental). Centralized here so the diff-selection block
 * above stays terse and the helper can be unit-tested in isolation. Returns the locked
 * ResolvedRoundContext shape (mode + round + anchorSha + hasUnresolvedThreads +
 * roundsIncremental).
 */
async function resolveRoundContextForJob(
  env: AppBindings,
  job: PersistedReviewJob,
  vcs: VcsProvider,
  config: RepoConfig,
): Promise<import('@server/core/rounds').ResolvedRoundContext> {
  const roundsIncremental = Boolean(config.review.rounds?.incremental ?? false);
  if (job.reviewScope === 'rest') {
    // D-03 short-circuit: review-rest is never subject to round detection.
    return {
      round: 1,
      mode: 'rest',
      roundsIncremental,
      anchorSha: null,
      hasUnresolvedThreads: false,
    };
  }

  let unresolvedThreads: import('@server/vcs/types').VcsReviewThread[] = [];
  if (roundsIncremental && vcs.capabilities.supportsThreadListing) {
    try {
      unresolvedThreads = await vcs.getUnresolvedBotThreads(job.owner, job.repo, job.prNumber);
    } catch (error) {
      logger.warn(
        `Failed to list unresolved bot threads for job ${job.id}; treating as no threads (capability degradation)`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  const prReviewStateKey: PrReviewStateKey = {
    vcsProvider: (job.repositoryVcsProvider ?? 'github') as 'github' | 'bitbucket',
    workspace: job.repositoryWorkspace ?? job.owner,
    repoSlug: job.repo,
    prNumber: job.prNumber,
  };
  const priorState = await getPrReviewState(env, prReviewStateKey);

  return resolveRoundContext({
    reviewScope: job.reviewScope ?? null,
    priorState,
    unresolvedThreads,
    roundsIncremental,
  });
}

/**
 * Phase 18 Plan 02 (RND-02 / D-08): pick the raw diff string for the SELECTED mode. The
 * caller has already fetched both the compare diff and the full diff (when applicable) and
 * passed the strings in; this helper just chooses which one to feed into the file selector.
 * The 'no_changes' branch is excluded by the caller (no_changes short-circuits before the
 * file selection runs).
 */
function selectDiffForSelection(
  descriptor: DiffSelectionDescriptor,
  compareDiff: string,
  fullDiff: string,
): string {
  if (descriptor.mode === 'incremental') return compareDiff;
  if (descriptor.mode === 'fallback') return fullDiff;
  // 'full' or 'rest' round-trips through the same full diff (today's behavior).
  return fullDiff;
}

/**
 * Phase 18 Plan 02 (RND-02 / D-05 / D-07 / D-13): the no_changes placeholder finalize. When
 * the prepare-time selector classified the diff as no_changes (a legitimate empty compare, a
 * zero-file compare, or a thrown-compare + empty full diff), the finalize phase MUST:
 *
 *   1. Complete the provider status check with a NEUTRAL terminal result (D-05). The status
 *      is updated to `completed` with the existing `neutral` conclusion; the user sees no new
 *      content on the PR — the audit trail records the round.
 *   2. Complete the job with a NEUTRAL terminal payload (idempotent, D-13). A retry MUST NOT
 *      append a duplicate `rounds.no_changes` audit event or repeat the completion. The
 *      existing `completeJob` is idempotent on the row state (re-running after completion is
 *      a no-op), and the audit event was already emitted in prepare. The terminal payload is
 *      verdict 'comment' (no findings => no approve), zero file/comment/token counts, no
 *      review id, no summary model.
 *   3. Advance the anchor once (D-07: round counter + anchor move in lockstep). The anchor
 *      write uses the EXACT prepare-time head SHA captured on the descriptor (D-08), not the
 *      live head. The setter is monotonic, so a stale redelivery is a no-op.
 *   4. Drop the diff cache (the descriptor is no_changes; the cached diff is empty anyway,
 *      but this mirrors the existing non-placeholder post-completion cleanup).
 *
 * NO submitReview, NO walkthrough edit, NO summary comment: the user sees nothing new on the PR.
 * The lease is released on the standard path; the runFinalizePhase caller's completion boundary
 * handles the lease return.
 */
async function finalizeNoChangesPlaceholder(
  env: AppBindings,
  job: PersistedReviewJob,
  vcs: VcsProvider,
  leaseOwner: string,
) {
  // Best-effort status check update. The status-check handler on every provider expects a
  // terminal `completed` state; we send the existing neutral conclusion so the PR's status
  // badge reflects "no findings, no error" and the check-run reconciliation sweep does not
  // re-process this job.
  const neutralStatusRef = job.statusCheckRef ?? (job.checkRunId !== null ? String(job.checkRunId) : '');
  if (neutralStatusRef) {
    try {
      await vcs.updateStatusCheck(job.owner, job.repo, neutralStatusRef, {
        status: 'completed',
        conclusion: 'neutral',
        title: 'No changes',
        summary: 'Codra reviewed this push and found no changes to comment on.',
      });
      await markJobCheckRunCompleted(env, job.id);
    } catch (error) {
      logger.warn(
        `Failed to update no_changes status check for job ${job.id}; completing anyway`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // D-13 idempotent completion. completeJob is idempotent on the row state (re-running after
  // completion is a no-op), so a freeze/crash + retry of finalize lands the same done state +
  // same payload. The audit event was emitted once in prepare; `recordRoundAudit` has its own
  // append guard so even a retry that reaches the recorder would not duplicate the event.
  await completeJob(env, job.id, {
    verdict: 'comment',
    fileCount: 0,
    commentCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    summaryMarkdown: '',
    reviewId: null,
    summaryModel: null,
    overallConfidenceScore: null,
    overallCorrectness: null,
    errorMessage: null,
  });

  // D-07: advance the anchor once. The empty head guard (D-15) is honored by the setter's
  // own trim/null check; the recorded anchor is the EXACT prepare-time head SHA captured on
  // the descriptor (D-08), not the live head.
  const prReviewStateKey: PrReviewStateKey = {
    vcsProvider: (job.repositoryVcsProvider ?? 'github') as 'github' | 'bitbucket',
    workspace: job.repositoryWorkspace ?? job.owner,
    repoSlug: job.repo,
    prNumber: job.prNumber,
  };
  try {
    await setLastReviewedSha(env, prReviewStateKey, {
      headSha: job.roundsToSha ?? null,
      reviewRound: job.reviewRound ?? 1,
    });
  } catch (error) {
    logger.warn(
      `Failed to advance anchor for no_changes finalize of job ${job.id}; next push will see the prior anchor`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // Diff cache cleanup (the cached diff is empty for no_changes, but mirror the existing
  // post-completion cleanup to keep the cache footprint tight).
  try {
    await env.APP_KV.delete(`diff:${job.id}:no_changes`);
  } catch (error) {
    logger.warn(`Failed to delete cached diff for no_changes job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
  }

  // Lease release is the caller's responsibility (runFinalizePhase's outer try/catch). The
  // helper returns so the caller's normal completion path runs.
  logger.info(`No-changes placeholder finalized for job ${job.id}`);
  void leaseOwner;
}

/**
 * Fetches and parses the PR diff from the VCS only once per job (cached in KV) instead of once per
 * phase invocation. Extracted from getDiffFiles so both getDiffFiles and the scope-aware
 * getJobDiffFiles / the prepare-phase skipped-for-size producer share one cached fetch (the diff is
 * immutable for a job's head, so re-reading it from KV never hits the VCS again).
 *
 * Phase 18 Plan 02 (RND-02 / D-08): the function is now SELECTION-AWARE. The cache key is
 * scoped to the (jobId, mode) tuple so an incremental-mode cache entry can never be silently
 * hit by a full-diff request (Codex/Antigravity HIGH). When the persisted descriptor is
 * 'incremental' or 'no_changes', the cache miss path re-fetches the compare range — NEVER the
 * implicit full-diff helper. When the descriptor is 'full' / 'rest' / null, the cache miss
 * falls back to the full PR diff (today's behavior, NREG-01).
 */
async function getCachedRawDiff(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'prNumber' | 'reviewMode' | 'roundsFromSha' | 'roundsToSha'>,
  vcs: Pick<VcsProvider, 'getPullRequestDiff' | 'getCompareDiff'>,
): Promise<string> {
  const mode = job.reviewMode ?? 'full';
  // Per-mode cache key so a 'full' cache entry can never satisfy an 'incremental' request.
  const cacheKey = `diff:${job.id}:${mode}`;

  // 'no_changes' short-circuits: the descriptor already classifies the diff as empty, so the
  // consumer never inspects raw content. Return an empty string and skip the VCS round-trip.
  if (mode === 'no_changes') return '';

  // 'incremental' mode: re-fetch the EXACT compare range from the durable descriptor. The
  // compare response is cached separately from the full diff so a misconfigured cache miss can
  // never splice in a different source (Codex HIGH).
  if (mode === 'incremental' && job.roundsFromSha && job.roundsToSha) {
    const cached = await env.APP_KV.get(cacheKey);
    if (cached !== null) return cached;
    const compareDiff = await vcs.getCompareDiff(job.owner, job.repo, job.roundsFromSha, job.roundsToSha);
    try {
      await env.APP_KV.put(cacheKey, compareDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
    } catch (error) {
      logger.warn(`Failed to cache compare diff for job ${job.id}; it will be re-fetched on the next phase`, error instanceof Error ? error : new Error(String(error)));
    }
    return compareDiff;
  }

  // 'fallback' / 'full' / 'rest' / null: the full PR diff is the source. Today's cache path.
  const cached = await env.APP_KV.get(cacheKey);
  if (cached !== null) return cached;
  const fullDiff = await vcs.getPullRequestDiff(job.owner, job.repo, job.prNumber);
  try {
    await env.APP_KV.put(cacheKey, fullDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
  } catch (error) {
    logger.warn(`Failed to cache PR diff for job ${job.id}; it will be re-fetched on the next phase`, error instanceof Error ? error : new Error(String(error)));
  }
  return fullDiff;
}

/**
 * Returns the job's reviewable files, fetching and parsing the PR diff from
 * GitHub only once per job (cached in KV) instead of once per phase invocation.
 */
export async function getDiffFiles(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'prNumber' | 'reviewMode' | 'roundsFromSha' | 'roundsToSha'>,
  vcs: Pick<VcsProvider, 'getPullRequestDiff' | 'getCompareDiff'>,
  config: RepoConfig,
) {
  const rawDiff = await getCachedRawDiff(env, job, vcs);
  return filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review);
}

/**
 * The PR-identity + head key for a job's skipped_files rows. For GitHub `repositoryWorkspace` is
 * null, so the workspace falls back to `owner` (the login); Bitbucket rows carry the workspace slug.
 * `headSha` is the job's current head (jobs.commit_sha, hex). Used by BOTH the prepare-phase producer
 * (insertSkippedFiles) and the review-rest consumer (listSkippedFilesForHead) so a review-rest job --
 * a DIFFERENT job_id -- finds the original full-review job's skips by PR+head (REVIEW: Codex 11-01 HIGH).
 */
function skippedFilesKeyForJob(
  job: Pick<PersistedReviewJob, 'owner' | 'repo' | 'prNumber' | 'commitSha' | 'repositoryVcsProvider' | 'repositoryWorkspace'>,
): SkippedFilesHeadKey {
  return {
    vcsProvider: job.repositoryVcsProvider ?? 'github',
    workspace: job.repositoryWorkspace ?? job.owner,
    repoSlug: job.repo,
    prNumber: job.prNumber,
    headSha: job.commitSha,
  };
}

/**
 * Scope-aware wrapper around getDiffFiles that honors the review scope persisted on the JOB ROW
 * (jobs.review_scope, surfaced by mapJob -- Plan 01). It REPLACES the three getDiffFiles call sites
 * (prepare/review/finalize) so 'rest' scoping is applied in EVERY phase, not just prepare (REVIEW:
 * Codex 11-05 HIGH -- every phase refetches the file set). Because scope lives on the persisted job,
 * it survives fresh-instance handoff (workflows/review.ts) and lease recovery (job-recovery.ts) with
 * NO queue-message threading -- those paths preserve only jobId/deliveryId/phase and mapJob rehydrates
 * review_scope.
 *
 *  - 'rest'  -> the review-rest set: the files a prior full review OMITTED for size, read from
 *               skipped_files by PR identity + current head (listSkippedFilesForHead) and matched
 *               against the current diff, bypassing the max_files slice for this run. A head with
 *               zero recorded skips yields an empty set -> a no-op review (NOT an error); Plan 06
 *               short-circuits before creating such a job, so this is defense-in-depth.
 *  - 'no_changes' -> the selected diff was a LEGITIMATE empty compare (Plan 02 / D-05). Return
 *               an empty reviewable set so the review/finalize phases short-circuit on the
 *               no_changes placeholder path (no model call, no review post, no walkthrough edit).
 *  - 'all' / 'head' / undefined -> delegate to getDiffFiles unchanged (undefined is byte-identical
 *               to today, NREG-01).
 */
export async function getJobDiffFiles(
  env: AppBindings,
  job: PersistedReviewJob,
  vcs: Pick<VcsProvider, 'getPullRequestDiff' | 'getCompareDiff'>,
  config: RepoConfig,
) {
  if (job.reviewMode === 'no_changes') {
    return [];
  }

  if (job.reviewScope === 'rest') {
    const restPaths = new Set(await listSkippedFilesForHead(env, skippedFilesKeyForJob(job)));
    if (restPaths.size === 0) return [];

    const rawDiff = await getCachedRawDiff(env, job, vcs);
    const { kept, omitted } = partitionReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review);
    // The recorded skips are a subset of the full reviewable set; restrict the current diff to
    // exactly those paths that are still present. Combining kept+omitted (the whole filtered set,
    // unsliced) makes the match robust even if a repo's max_files changed between runs.
    return [...kept, ...omitted].filter((file) => restPaths.has(file.path));
  }

  return getDiffFiles(env, job, vcs, config);
}

/**
 * Local structural type for failJobAndCheckRun's injected collaborator. Deliberately NOT typed
 * against the (now-removed) direct provider service type, and NOT `Pick<VcsProvider,
 * 'updateStatusCheck'>` either (review finding 2): test/review-resilience.spec.ts (a PROTECTED
 * spec) injects `{ updateCheckRun }` and asserts it's called with a NUMERIC checkRunId, so this
 * collaborator key and call shape must stay byte-identical.
 */
type CheckRunUpdater = {
  updateCheckRun(owner: string, repo: string, checkRunId: number, input: VcsUpdateStatusCheckInput): Promise<void>;
};

/**
 * Binds a VcsProvider's string-ref `updateStatusCheck` under the numeric-id `updateCheckRun` key
 * failJobAndCheckRun's DI contract expects (review finding 2). The `String(checkRunId)` here is
 * the ref<->id conversion (D-02); end behavior is byte-identical since the adapter maps it back
 * via `Number(ref)`.
 */
function checkRunUpdaterFor(vcs: VcsProvider): CheckRunUpdater {
  return {
    updateCheckRun: (owner, repo, checkRunId, input) => vcs.updateStatusCheck(owner, repo, String(checkRunId), input),
  };
}

export async function failJobAndCheckRun(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'checkRunId'>,
  github: CheckRunUpdater,
  message: string,
) {
  // Marking the job failed in the DB is the critical, must-not-lose write: it's what
  // makes the job terminal so it stops being retried, and it's what makes it eligible
  // for completeTerminalCheckRuns() to pick up later if the GitHub call below fails.
  try {
    await failJob(env, job.id, message);
  } catch (dbError) {
    logger.error(`Critical: failed to mark job ${job.id} as failed in the DB; it may remain stuck until lease-expiry recovery reclaims it`, dbError);
    return;
  }

  // Updating the GitHub check run is best-effort here. If it fails (e.g. the Worker's
  // subrequest budget for this invocation is already exhausted from the review itself),
  // the job is still durably marked failed above, and the opportunistic maintenance sweep
  // (completeTerminalCheckRuns) will retry this update on a later invocation with a fresh budget.
  try {
    const latest = await getJobForProcessing(env, job.id);
    const checkRunId = latest?.check_run_id ?? job.checkRunId;
    if (checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        status: 'completed',
        conclusion: 'failure',
        title: 'Review failed',
        summary: message,
      });
      await markJobCheckRunCompleted(env, job.id);
    }
  } catch (checkRunError) {
    logger.warn(`Failed to update GitHub check run for failed job ${job.id}; opportunistic maintenance will retry it`, checkRunError);
  }
}
