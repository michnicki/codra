// Phase 19 Plan 19-08 (PASS-03, D-14..D-19): the durable walkthrough enrichment phase.
//
// This phase sits BETWEEN the critic (or verify_fixes) and finalize, on its OWN fresh-budget
// invocation. It is gated on `review.walkthrough.enabled` (NREG-01: a disabled walkthrough emits
// no model call, no DB write, no audit event). When enabled:
//
//   1. It re-reads the persisted main-pass file reviews from Postgres so the inputs are the same
//      final main-pass rows the rest of finalize consumes.
//   2. It makes EXACTLY ONE outbound enrichment model call (primary model only — no fallback
//      fan-out, see ModelService.generateWalkthroughEnrichment) so the phase stays inside the
//      per-invocation subrequest budget (D-13 / PASS-03).
//   3. It parses the response with parseWalkthroughEnrichmentResponse (independent per-field
//      tolerance) and persists the validated payload via setJobWalkthroughEnrichment BEFORE the
//      (throwing) hand-off to finalize so a fresh-instance retry short-circuits on the idempotency
//      guard below.
//   4. It ALWAYS hands off to finalize with a NextPhaseError('finalize', ...). Finalize performs
//      zero enrichment work — it reads the persisted blob and feeds it through buildWalkthroughData
//      without a model call (D-13). A whole-call LLM failure degrades to a `status: 'failed'`
//      blob so finalize still publishes the deterministic coverage walkthrough (D-17 fail-open).
//
// Threat model mitigations enforced here:
//   - T-19-08-01 (Tampering): grouping is validated against the KNOWN reviewed-path set; invented
//     / duplicate paths drop, "Other changes" bucket carries every unassigned path.
//   - T-19-08-02 (Tampering): confidence clamp is owned by buildWalkthroughData's projection
//     (downward only) — this phase persists the model score verbatim and trusts the projection.
//   - T-19-08-03 (DoS): formatter body cap shrinks the row counter monotonically; finalize never
//     sees a body larger than WALKTHROUGH_BODY_MAX (handled in formatter.ts).
//   - T-19-08-SC (Supply chain): no new dependencies added by this phase.

import { logger } from './logger';
import type { AppBindings } from '@server/env';
import {
  updateJobWalkthroughCommentRef,
  setJobWalkthroughEnrichment,
} from '@server/db/jobs';
import { getFileReviewsForJobs } from '@server/db/file-reviews';
import { NextPhaseError } from './next-phase-error';
import { parseWalkthroughEnrichmentResponse } from './model-output';
import {
  buildWalkthroughEnrichmentAuditEvent,
  recordWalkthroughAudit,
} from './audit';
import {
  walkthroughEnrichmentSchema,
  type RepoConfig,
  type WalkthroughEnrichment,
} from '@shared/schema';
import type { ModelService } from '../services/model';

type JobLike = {
  id: string;
  walkthroughEnrichment?: WalkthroughEnrichment | null;
  walkthroughCommentRef?: string | null;
};

type MainReviewRow = {
  file_path: string;
  file_summary: string | null;
  file_status: 'pending' | 'done' | 'skipped' | 'failed';
  error_msg: string | null;
  verdict: 'approve' | 'comment' | null;
  pass: 'main' | 'security';
};

// Deterministic yield between the enrichment model call and finalize. Same value as the critic
// hand-off so the durable chain keeps a uniform rhythm; the enrichment call is small (one
// primary-only inference) and consumes a small fraction of the new invocation's budget.
const ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS = 60;

// Phase 20 (D-05 reviewer LOW #6): a local helper that consolidates persist + audit emission so
// every terminal branch writes the durable blob AND emits exactly one bounded audit event. The
// helper owns the throwable surface — it never rethrows (recordWalkthroughAudit is best-effort) so
// a broken audit write can never fail the caller. The next-phase hand-off is the caller's
// responsibility, the helper only owns the (persist, audit) pair.
async function persistAndAudit(
  env: AppBindings,
  jobId: string,
  persistence: Parameters<typeof setJobWalkthroughEnrichment>[2],
  auditStatus: 'completed' | 'partial' | 'failed',
  auditReason?: string,
  auditGroupCount?: number,
): Promise<void> {
  await setJobWalkthroughEnrichment(env, jobId, persistence);
  const event = buildWalkthroughEnrichmentAuditEvent(
    auditStatus,
    auditReason,
    auditGroupCount,
  );
  await recordWalkthroughAudit(env, jobId, [event]);
}

// Phase 19 Plan 19-08 (PASS-03): run the walkthrough enrichment phase. Idempotent on re-entry —
// a persisted `walkthrough_enrichment` blob means a prior invocation reached either 'completed',
// 'partial', or 'failed' state, and the phase skips the model call and hands off directly to
// finalize (mirrors runCriticPhase's idempotency posture, D-07 / D-17).
export async function runWalkthroughEnrichmentPhase(params: {
  env: AppBindings;
  job: JobLike & { owner: string; repo: string; prNumber: number; prTitle?: string | null };
  config: RepoConfig;
  model: ModelService;
}): Promise<void> {
  const { env, job, config, model } = params;

  // NREG-01: disabled default emits no new call / write / event. A drift (the toggle off but the
  // phase somehow reached) degrades to a silent hand-off so finalize still runs.
  if (!config.review.walkthrough?.enabled) {
    throw new NextPhaseError('finalize', ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS);
  }

  // Idempotent re-entry: a persisted blob means a prior invocation already ran the enrichment
  // (whether it succeeded, partially succeeded, or fail-opened). Skip straight to finalize so a
  // hibernated retry never re-spends model budget. The blob is the durable source of truth;
  // buildWalkthroughData's projection handles every status branch.
  if (job.walkthroughEnrichment) {
    logger.info(`Walkthrough enrichment already persisted for job ${job.id}; skipping the model call and transitioning onward.`);
    throw new NextPhaseError('finalize', ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS);
  }

  // Read the main-pass reviews from Postgres — the SAME source of truth the finalize phase
  // consumes (per row: path, summary, file_status, error_msg, verdict). Filtering to `pass ===
  // 'main'` matches buildWalkthroughData's contract so the projection sees an identical input
  // set whether the enrichment ran or not (D-04 main-only counts).
  const reviews = (await getFileReviewsForJobs(env, [job.id])) as MainReviewRow[];
  const mainReviews = reviews.filter((review) => review.pass === 'main');

  if (mainReviews.length === 0) {
    // No reviewed files means there is nothing to enrich. Persist a `status: 'failed'` blob so the
    // job detail surface can render a truthful "no files to enrich" reason without ambiguity. The
    // buildWalkthroughData projection treats this as no-op (no groups / no assessment).
    await persistAndAudit(env, job.id, {
      version: 1,
      status: 'failed',
      reason: 'no_files_to_enrich',
    }, 'failed', 'no_files_to_enrich');
    throw new NextPhaseError('finalize', ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS);
  }

  // Build the sanitized prompt input from the deterministic main-pass aggregation. Per-file counts
  // are sourced from the file_status (a failed file emits `verdict: 'failed'`) — the model needs
  // to see the same signal the renderer will display, no more (D-14 grouping is over file-level
  // semantics, not finding-level).
  const files = mainReviews.map((review) => {
    const summary = review.file_status === 'failed'
      ? `Review failed: ${review.error_msg ?? 'Unknown file review error'}`
      : (review.file_summary ?? '');
    return {
      path: review.file_path,
      summary: firstLine(summary),
      counts: {},
    };
  });

  let response: { rawText: string; modelUsed: string; inputTokens: number; outputTokens: number };
  try {
    response = await model.generateWalkthroughEnrichment({
      prTitle: job.prTitle ?? null,
      files,
      config,
    });
  } catch (error) {
    // Whole-call LLM failure (model rejected, retryable exhausted, resolveModel miss, etc.):
    // persist a `status: 'failed'` blob so finalize still publishes the deterministic coverage
    // walkthrough. NEVER throw out of the phase — finalize must run (D-17 fail-open contract).
    logger.warn(
      `Walkthrough enrichment model call failed for job ${job.id}; failing open (no groups / no assessment)`,
      error instanceof Error ? error : new Error(String(error)),
    );
    await persistAndAudit(env, job.id, {
      version: 1,
      status: 'failed',
      reason: 'model_call_failed',
    }, 'failed', 'model_call_failed');
    throw new NextPhaseError('finalize', ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS);
  }

  // Independent per-field parse (D-17). A `fail_open` result is a whole-call parse failure
  // (empty / non-object / all three fields invalid) — persist as `status: 'failed'` so finalize
  // can still publish the deterministic coverage walkthrough.
  const parsed = parseWalkthroughEnrichmentResponse(response.rawText);

  let enrichment: WalkthroughEnrichment;
  let auditStatus: 'completed' | 'partial' | 'failed';
  let auditReason: string | undefined;
  let auditGroupCount: number | undefined;
  if (parsed.kind === 'fail_open') {
    enrichment = {
      version: 1,
      status: 'failed',
      reason: parsed.reason,
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
    auditStatus = 'failed';
    auditReason = parsed.reason;
  } else {
    // Phase 20 (D-05 reachability): use the parser's malformed-field provenance to derive
    // status. Completed means every supplied field survived validation; partial means at least
    // one supplied field was malformed but some valid fields survived. Empty groups array is
    // fine — the projection appends every unassigned path to "Other changes" (D-16). The
    // auditGroupCount is the parser's surviving group count (NOT the validated blob's), so a
    // fully-validated completed run reports the same number the finalize projection will use.
    const completed = parsed.malformedFields.length === 0;
    auditStatus = completed ? 'completed' : 'partial';
    auditReason = completed ? undefined : `parse_partial: ${parsed.malformedFields.join(',')}`;
    auditGroupCount = parsed.groups.length > 0 ? parsed.groups.length : undefined;
    enrichment = {
      version: 1,
      status: completed ? 'completed' : 'partial',
      groups: parsed.groups.length > 0 ? parsed.groups : undefined,
      confidence: parsed.confidence,
      effort: parsed.effort,
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }

  // Validate the assembled payload against the schema before persisting (sanity check the parser
  // produced well-formed Zod-shaped output; a malformed value degrades to a `failed` blob rather
  // than poisoning the job summary parse).
  const validated = walkthroughEnrichmentSchema.safeParse(enrichment);
  if (!validated.success) {
    logger.warn(
      `Walkthrough enrichment blob failed schema validation for job ${job.id}; failing open`,
      validated.error,
    );
    await persistAndAudit(env, job.id, {
      version: 1,
      status: 'failed',
      reason: 'schema_validation_failed',
    }, 'failed', 'schema_validation_failed');
    throw new NextPhaseError('finalize', ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS);
  }

  await persistAndAudit(env, job.id, validated.data, auditStatus, auditReason, auditGroupCount);
  logger.info(`Walkthrough enrichment persisted for job ${job.id}; transitioning to finalize.`, {
    status: validated.data.status,
    groups: validated.data.groups?.length ?? 0,
    hasConfidence: validated.data.confidence !== null,
    hasEffort: validated.data.effort !== null,
    auditStatus,
    auditGroupCount,
  });

  // Always hand off to finalize. Finalize performs ZERO enrichment model work — it reads the
  // persisted blob via buildWalkthroughData and feeds it through formatWalkthrough (D-13).
  throw new NextPhaseError('finalize', ENRICHMENT_FRESH_INVOCATION_YIELD_SECONDS);
}

// First-line collapse mirror of core/walkthrough.ts. Kept local to this module so the enrichment
// phase never imports from core/walkthrough.ts (which would couple two core/* files for no gain).
function firstLine(value: string): string {
  const nl = value.search(/\r?\n/);
  return (nl === -1 ? value : value.slice(0, nl)).trim();
}

// Re-export for the tests so they can verify the phase without spinning up the durable schema.
export { updateJobWalkthroughCommentRef };
