// Phase 11, Plan 11-04 — the lightweight, read-only, rate-limited PR Q&A handler (QA-01/QA-02).
//
// answerQuestion answers a reviewer's free-form (non-command) mention grounded ONLY in the PR title,
// description, and diff, and posts a single reply. It is a NON-Workflow call (~4 subrequests:
// getPullRequest + getPullRequestDiff + one model call + the reply post) invoked directly by the
// queue consumer (Plan 06) for kind='qa' messages with a provider constructed via
// VcsService.forProvider (Plan 02 jobless factory).
//
// READ-ONLY (QA-02 / T-11-04-4): the ONLY side effects are the single reply — posted via the provider
// comment/reply primitive (createPrComment top-level, or replyToPrComment when threadable, Phase 12) —
// and the APP_KV rate-limit counter. No job creation, no pause/resume, no status-check or label
// mutation, no DB write. The whole path is gated behind review.interactive.qa.enabled (default false,
// NREG-01).

import type { AppBindings } from '../env';
import type { RepoConfig } from '@shared/schema';
import type { VcsProvider } from '../vcs/types';
import { ModelService } from '../services/model';
import { buildQaPrompt, type QaIndexChunk } from '../prompts/qa';
import { parseUnifiedDiff, filterReviewableFiles, type FileDiff } from './diff';
import { logger } from './logger';
// Phase 29 / QA-IDX-01. All three imports serve the ONE fail-open retrieval block below.
// findRepositoryIdByIdentity is deliberately the read-only lookup, never getOrCreateRepository.
import { buildQueryExpression, buildQueryTerms } from './code-index';
import { getCodeIndexState, retrieveCodeIndexChunks } from '@server/db/code-index';
import { findRepositoryIdByIdentity } from '@server/db/repositories';

// The classified Q&A context handed to answerQuestion. `provider` is the VCS platform name (used
// only to namespace the rate-limit key); the actual provider client is injected separately so this
// handler never constructs credentials itself (Plan 02/06 own that).
export type QaContext = {
  provider: 'github' | 'bitbucket';
  workspace: string;
  repo: string;
  prNumber: number;
  question: string;
  authorId: string;
  // Phase 12 (D-01/D-03): the opaque provider ref of the ORIGINATING comment, threaded through from
  // the queue payload by the consumer (index.ts). Today Q&A carried no reply target (Pitfall #4).
  // When `threadable && commentRef` are both present, answerQuestion replies under it via
  // provider.replyToPrComment; otherwise it falls back to a top-level createPrComment.
  commentRef?: string;
  // Phase 12: webhook-set threadability capability flag — true when the originating comment can be
  // threaded under (GitHub inline review comment / all Bitbucket → true; GitHub issue_comment →
  // false). Absent (undefined) ⇒ top-level posting, byte-identical to today (NREG-01).
  threadable?: boolean;
};

export type QaResult = { answered: boolean; reason?: string };

// Rate-limit KV TTL. One hour (seconds); the key already embeds the hour bucket so a fresh bucket
// starts a fresh count and the TTL just garbage-collects the previous bucket's key.
const QA_RATE_TTL_SECONDS = 3_600;

// Encode a rate-limit key component so a workspace/repo containing the ':' , '/' or '#' delimiters
// cannot collide with a different PR's key (REVIEW: OpenCode/Antigravity KV-key note). encodeURIComponent
// escapes all three delimiters, so the composed key is unambiguous.
function encodeKeyComponent(value: string): string {
  return encodeURIComponent(value);
}

// Compose the per-PR hourly rate-limit KV key `qa-rate:{provider}:{workspace}/{repo}#{pr}:{hourBucket}`.
// The key embeds the hour bucket so a fresh hour starts a fresh count and the TTL garbage-collects the
// previous bucket. Kept as a helper so the read (gate) and the increment (record) share ONE key.
function rateLimitKey(ctx: QaContext): string {
  const hourBucket = Math.floor(Date.now() / (QA_RATE_TTL_SECONDS * 1_000));
  return `qa-rate:${encodeKeyComponent(ctx.provider)}:${encodeKeyComponent(ctx.workspace)}/${encodeKeyComponent(
    ctx.repo,
  )}#${ctx.prNumber}:${hourBucket}`;
}

/**
 * Read the current per-PR hourly count (best-effort). A KV read failure is treated as "no prior
 * calls" (return 0) so a transient KV blip never wedges Q&A.
 */
async function readRateLimitCount(env: Pick<AppBindings, 'APP_KV'>, key: string): Promise<number> {
  try {
    const raw = await env.APP_KV.get(key);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch (error) {
    logger.warn('Q&A rate-limit KV read failed; proceeding as if uncounted', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return 0;
}

/**
 * Record one consumed Q&A call (best-effort, non-throwing).
 *
 * WR-04: this is called ONLY AFTER a successful reply is posted. The queue consumer retries a
 * kind='qa' message on a transient failure (getPullRequest / diff fetch / model call), and the OLD
 * increment-before-fetch order re-consumed the budget on every retry — at `rate_limit_per_hour: 1` a
 * retried question would see `count >= cap` and self-drop (answered:false). Incrementing only after
 * the post means a retried-then-succeeded question consumes exactly one unit of budget.
 *
 * The read-then-write is NOT atomic, but the review queue runs with max_concurrency:1 so Q&A
 * invocations for the same PR are effectively serialized; the worst case under a rare race is one
 * extra reply, never a privileged side effect (documented disposition, REVIEW: Codex 11-04 LOW).
 */
async function recordRateLimitIncrement(env: Pick<AppBindings, 'APP_KV'>, key: string): Promise<void> {
  const count = await readRateLimitCount(env, key);
  try {
    await env.APP_KV.put(key, String(count + 1), { expirationTtl: QA_RATE_TTL_SECONDS });
  } catch (error) {
    // Best-effort: a failed increment means this call may not be counted, but we already answered.
    logger.warn('Q&A rate-limit KV write failed; answered without recording the increment', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Answer a free-form PR question. READ-ONLY except the single reply + the KV rate counter.
 *
 * Order of operations (rate-limit GATE first so an over-limit question costs no model call, but the
 * counter INCREMENT happens only after a successful post — WR-04):
 *   1. Gate on config.review.interactive.qa.enabled — return early if off (NREG-01).
 *   2. Read the config-driven per-PR hourly KV count and silent no-op if already at the cap (D-07).
 *      Do NOT increment here: a transient failure below triggers a queue retry, and incrementing up
 *      front would burn the budget on every retry (at rate_limit_per_hour:1 it would self-drop the retry).
 *   3. Fetch the PR + diff via the INJECTED provider; a diff-fetch failure degrades to an empty
 *      diff so the model still answers scope-honestly (QA-01/D-04) rather than erroring.
 *   4. Phase 29 (QA-IDX-01): when review.interactive.qa.index.enabled is on AND this repository has a
 *      READY codebase index, retrieve the top-K ranked excerpts for the question. EVERY failure mode —
 *      toggle off, no repository row, no/unfinished/failed index, unusable question, zero hits, or a
 *      thrown DB error — degrades silently to the diff-only answer of step 3 (D-15). READ-ONLY: this
 *      step adds no DB write, no job and no audit event.
 *   5. Build the capped, fenced prompt (buildQaPrompt) and run ModelService.answerPrQuestion — the
 *      single public prose path; this handler NEVER touches the private selectModel/callResolvedModel.
 *   6. Post the answer via the provider comment/reply primitive (createPrComment top-level, or
 *      replyToPrComment when ctx.threadable && ctx.commentRef — Phase 12), THEN record the rate-limit
 *      increment. A thrown post propagates BEFORE the increment, so a failed post consumes no budget.
 */
export async function answerQuestion(
  env: AppBindings,
  provider: VcsProvider,
  ctx: QaContext,
  config: RepoConfig,
): Promise<QaResult> {
  if (!config.review.interactive.qa.enabled) {
    return { answered: false, reason: 'disabled' };
  }

  const cap = config.review.interactive.qa.rate_limit_per_hour;
  const key = rateLimitKey(ctx);
  // Gate on the CURRENT count without incrementing (WR-04). Boundary: allow the Nth call
  // (count 0..cap-1) and drop the (N+1)th (count === cap).
  const count = await readRateLimitCount(env, key);
  if (count >= cap) {
    logger.info('Q&A rate limit reached for PR; dropping question silently', {
      provider: ctx.provider,
      workspace: ctx.workspace,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
    });
    return { answered: false, reason: 'rate_limited' };
  }

  // Fetch PR metadata. If this fails we cannot answer at all — let it propagate to the caller.
  const pr = await provider.getPullRequest(ctx.workspace, ctx.repo, ctx.prNumber);

  // Fetch + parse the diff. An empty or unavailable diff is NOT fatal: the model still answers from
  // the PR title/description and states the scope limit (QA-01/D-04 scope honesty).
  let files: FileDiff[] = [];
  try {
    const rawDiff = await provider.getPullRequestDiff(ctx.workspace, ctx.repo, ctx.prNumber);
    files = filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review);
  } catch (error) {
    logger.warn('Q&A diff fetch failed; answering from PR metadata only (scope-honest)', {
      error: error instanceof Error ? error.message : String(error),
      prNumber: ctx.prNumber,
    });
    files = [];
  }

  // -------------------------------------------------------------------------------------------
  // Phase 29 / QA-IDX-01: config-gated, FAIL-OPEN retrieval of ranked repository excerpts, so a
  // question can reach code this PR's diff does not contain. The shape below is copied from the
  // diff-fetch degrade DIRECTLY ABOVE rather than inventing a second error-handling idiom in the
  // same function.
  //
  // THREE CONSTRAINTS make this block correct, and all three are load-bearing:
  //
  //  1. ANY retrieval problem degrades SILENTLY to today's diff-only answer (D-15): the toggle off, no
  //     repositories row, no index-state row, a build still running, a failed build, a question that
  //     normalizes to nothing, zero hits, or a thrown database error. A reviewer must never be met with
  //     silence — or with an error — because a BACKGROUND subsystem is not ready; the answer without
  //     the excerpts is still exactly the useful answer this handler shipped before Phase 29.
  //  2. NO audit event and NO database write may be added here. This module's header pins the QA-02
  //     read-only invariant, and D-15 declined BOTH explicitly — an audit event IS a write, and a write
  //     on this path means asking a question mutates state. That is also why the repository id is
  //     resolved with findRepositoryIdByIdentity and NEVER with getOrCreateRepository, whose every
  //     branch inserts.
  //  3. The rate-limit increment at the bottom of this function must STAY LAST (WR-04). Nothing here
  //     can reach it, so a retrieval failure costs no rate-limit budget.
  //
  // WHAT THIS DELIBERATELY DOES NOT CHECK: the only index-state gate is `status === 'ready'`. NO
  // staleness comparison against the pull request's BASE commit is made, for three reasons.
  //   (a) There is no cheap correct comparison to make. The index tracks the DEFAULT BRANCH at
  //       `indexed_sha`, while a pull request's base is a different commit and frequently a different
  //       branch, so "stale relative to this PR" has no single well-defined meaning.
  //   (b) Staleness is already bounded by push-event frequency (D-08) — that is the freshness mechanism
  //       the requirement asks for, and it is the one that actually keeps the index current.
  //   (c) D-15 already fails open on staleness BY NAME. A half-defined staleness check would therefore
  //       degrade MORE answers to diff-only than this gate does, for no gain in accuracy.
  // The honest consequence, kept visible rather than hidden: a retrieved excerpt CAN be newer than the
  // pull request's base. That is exactly why the variant system prompt states the excerpts come from
  // the default branch at a named commit and may be stale or incomplete relative to the change under
  // review (D-14) — the disclosure carries what a check cannot.
  // -------------------------------------------------------------------------------------------
  let indexChunks: QaIndexChunk[] = [];
  let indexedSha: string | null = null;
  try {
    // FIRST statement in the block (NREG-01): a repository that has not opted in performs no
    // repository lookup, no state read and no query — it does not touch the index tables at all.
    if (config.review.interactive.qa.index.enabled) {
      const repositoryId = await findRepositoryIdByIdentity(env, {
        vcsProvider: ctx.provider,
        ownerOrWorkspace: ctx.workspace,
        repo: ctx.repo,
      });

      // null = no repositories row for this identity yet. A NORMAL absence, not an error (D-15).
      if (repositoryId !== null) {
        const state = await getCodeIndexState(env, { repositoryId });

        // 'ready' is the ONLY status that means a completed, queryable index. 'building' and 'failed'
        // degrade to diff-only exactly like a missing index (D-15): a partially populated table would
        // otherwise answer from an arbitrary fraction of the repository, which is worse than answering
        // from the diff and saying so.
        if (state !== null && state.status === 'ready') {
          const queryExpression = buildQueryExpression(buildQueryTerms(ctx.question));

          // DELIBERATE DEFENSE IN DEPTH, not redundancy: retrieveCodeIndexChunks ALSO returns [] for a
          // null expression (added in 29-01). This caller guard skips a call that provably cannot
          // match; the accessor's guard protects every FUTURE call site. Neither may later be deleted
          // as duplicated logic — removing either one leaves a single point of failure behind a policy
          // (D-15) that makes the resulting total retrieval miss completely silent.
          if (queryExpression !== null) {
            const hits = await retrieveCodeIndexChunks(env, {
              repositoryId,
              queryExpression,
              limit: config.review.interactive.qa.index.top_k,
            });
            // Map rather than pass through, so the retrieval `rank` is dropped here at the boundary: an
            // ordinal in the prompt would invite the model to reason about scores it cannot interpret.
            indexChunks = hits.map((hit) => ({
              path: hit.path,
              chunkStart: hit.chunkStart,
              chunkEnd: hit.chunkEnd,
              content: hit.content,
            }));
            // Provenance for the variant prompt: the commit the excerpts were indexed at (D-14).
            indexedSha = state.indexed_sha;
          }
          // DIAGNOSTIC (29-09 UAT): qa.ts otherwise only logs on the failure path, so there is no way
          // to tell "retrieved zero/wrong chunks silently" from "retrieved correctly but the model
          // answered wrong anyway" from the logs alone. Log the outcome unconditionally here.
          logger.info('Q&A index retrieval outcome', {
            prNumber: ctx.prNumber,
            provider: ctx.provider,
            queryExpressionWasNull: queryExpression === null,
            chunksFound: indexChunks.length,
            paths: indexChunks.map((c) => c.path),
          });
        }
      }
    }
  } catch (error) {
    // D-15: degrade to diff-only — silently for the REVIEWER, never silently for the OPERATOR.
    indexChunks = [];
    indexedSha = null;
    logger.warn('Q&A index retrieval failed; answering from the PR diff only (fail-open)', {
      // ONLY the error message and the PR number (T-29-07-05). No chunk content, no file content, no
      // question text and no retrieved path may reach the log; the logger's redaction applies on top.
      error: error instanceof Error ? error.message : String(error),
      prNumber: ctx.prNumber,
    });
  }

  const { systemPrompt, userPrompt } = buildQaPrompt({
    question: ctx.question,
    prTitle: pr.title,
    prBody: pr.body,
    files,
    config: config.review,
    indexChunks,
    indexedSha,
  });

  const modelService = new ModelService(env);
  const answer = await modelService.answerPrQuestion({ systemPrompt, userPrompt, config });

  // Caller-decides threading (Phase 12, D-01): thread under the originating comment when the webhook
  // flagged it threadable AND we carry its opaque ref; otherwise post top-level (byte-identical to
  // today, NREG-01). A thrown post propagates here — BEFORE the increment below — so a failed post
  // consumes no rate-limit budget (WR-04).
  if (ctx.threadable && ctx.commentRef) {
    await provider.replyToPrComment(ctx.workspace, ctx.repo, ctx.prNumber, answer, ctx.commentRef);
  } else {
    await provider.createPrComment(ctx.workspace, ctx.repo, ctx.prNumber, answer);
  }

  // WR-04: consume budget only now that the reply is posted, so a transient failure above (which the
  // queue retries) never burns the rate-limit budget or self-drops the retried question.
  await recordRateLimitIncrement(env, key);

  return { answered: true };
}
