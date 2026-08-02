import { createApp } from './app';
import { ReviewWorkflow } from './workflows/review';
import { IndexWorkflow } from './workflows/index-build';
import type { AppBindings } from './env';
import { reviewJobMessageSchema } from '@shared/schema';
import { logger } from '@server/core/logger';
import { runWithDb } from '@server/db/client';
import { failJob, hasPendingMaintenanceWork, clearSystemActive } from '@server/db/jobs';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';
import { VcsService } from '@server/services/vcs';
import { executeCommand, type ClassifiedCommand, type CommentContext } from '@server/core/commands';
import { answerQuestion, type QaContext } from '@server/core/qa';
import { loadRepoConfig } from '@server/core/config';
import { isRetryableModelError } from '@server/services/model';
import { isTimeoutMessage, matchesAnyTransientSubstring } from '@shared/transient-errors';

// Classify an interactive-dispatch failure as transient (retry) vs deterministic (ack). Mirrors the
// model layer's isTransientModelFailure disposition (REVIEW: Codex 11-06 MED): a transient DB /
// provider / model error must be retried (bounded by the 3-attempt consumer) rather than
// acked-and-lost, while a deterministic failure (bad payload, permanent 4xx) is logged and acked.
// Timeouts deliberately fail fast (consistent with the shared classifier), and a RetryableModelError
// is always transient.
function isTransientDispatchError(error: unknown): boolean {
  if (isRetryableModelError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (isTimeoutMessage(lower)) return false;
  return (
    matchesAnyTransientSubstring(lower) ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('temporar') ||
    lower.includes('connection') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('too many connections') ||
    /\b50[0-9]\b/.test(lower) ||
    lower.includes('internal error')
  );
}

// Dispatch a classified command/qa message INLINE (non-Workflow, CMD-07/D-03/D-05). Constructs the
// provider via the jobless VcsService.forProvider factory, rebuilds a full CommentContext (body +
// workspace included so reject persists reason=body, D-09), and calls executeCommand / answerQuestion
// each with its own fresh 50-subrequest budget. NEVER creates a REVIEW_WORKFLOW instance.
async function dispatchInteractiveMessage(
  env: AppBindings,
  data: ReturnType<typeof reviewJobMessageSchema.parse>,
): Promise<void> {
  const interactive = data.interactive;
  if (!interactive) {
    // The schema superRefine guarantees this for kind command/qa, but guard defensively.
    throw new Error('Interactive message missing interactive payload');
  }
  const owner = data.owner ?? interactive.workspace;
  const repo = data.repo;
  const prNumber = data.prNumber;
  if (!repo || typeof prNumber !== 'number') {
    throw new Error('Interactive message missing owner/repo/prNumber');
  }

  // WR-01: prefer the PROVIDER-SAFE config snapshot the webhook route resolved and carried on the
  // message. Re-deriving it here via loadRepoConfig({ owner, repo }) is unsafe for Bitbucket: `owner`
  // is the workspace slug and getRepoConfigRecord matches on (owner, repo) with NO vcs_provider
  // filter (LIMIT 1), so it can return a same-text GitHub repo's config (breaking a legitimate
  // Bitbucket admin's pause/resume/reject — fail-closed — or silently dropping a Bitbucket Q&A), and
  // loadRepoConfig additionally triggers a GitHub-shaped getOrCreateRepository side effect. The
  // carried snapshot is present for every Phase-11 producer; fall back to loadRepoConfig ONLY for
  // in-flight pre-deploy messages (GitHub is collision-free, so that legacy path stays safe there).
  const config =
    interactive.configSnapshot ??
    (
      await loadRepoConfig(env, {
        installationId: data.installationId ?? '',
        owner,
        repo,
      })
    ).parsedJson;

  const provider = await VcsService.forProvider(env, {
    provider: data.provider,
    installationId: data.installationId,
    workspace: interactive.workspace,
    repo,
  });

  if (data.kind === 'qa') {
    const qaCtx: QaContext = {
      provider: data.provider,
      workspace: interactive.workspace,
      repo,
      prNumber,
      question: interactive.question ?? interactive.body,
      authorId: interactive.authorId,
      // Phase 12: thread the reply target through inertly — undefined ⇒ top-level posting until the
      // producer (Plan 03) sets commentRef/threadable on the queue payload (NREG-01).
      commentRef: interactive.commentRef,
      threadable: interactive.threadable,
    };
    await answerQuestion(env, provider, qaCtx, config);
    return;
  }

  // kind === 'command'
  const ctx: CommentContext = {
    authorId: interactive.authorId,
    authorLogin: interactive.authorLogin,
    body: interactive.body,
    prNumber,
    commentRef: interactive.commentRef,
    parentRef: interactive.parentRef,
    findingRef: interactive.findingRef,
    owner,
    repo,
    workspace: interactive.workspace,
    // Phase 12: thread the threadability flag through inertly — undefined ⇒ top-level help reply
    // until the producer (Plan 03) sets it on the queue payload (NREG-01). commentRef already flows above.
    threadable: interactive.threadable,
  };
  const cmd: ClassifiedCommand = {
    kind: 'command',
    // The producer (webhook-ingest) only enqueues kind='command' for pause/resume/help/reject; a
    // missing commandName is a malformed message (deterministic — will be acked).
    name: interactive.commandName ?? 'help',
    args: '',
    findingRef: interactive.findingRef,
  };
  await executeCommand(env, provider, cmd, ctx, config);
}

const app = createApp();

// Both Workflow classes are re-exported from the Worker's entry module so the `class_name` values in
// wrangler.jsonc's `workflows` array resolve. Phase 29 / QA-IDX-01 (D-06-R): `IndexWorkflow` is bound as
// INDEX_WORKFLOW / `codra-index-workflow`, a second Workflow provisioned by `wrangler deploy` alongside
// the review one -- NOT a new payload kind inside ReviewWorkflow.
export { ReviewWorkflow, IndexWorkflow };

export default {
  fetch(request: Request, env: AppBindings, ctx: ExecutionContext) {
    return runWithDb(env, () => app.fetch(request, env, ctx));
  },

  async scheduled(_controller: ScheduledController, env: AppBindings, _ctx: ExecutionContext) {
    // The cron fires every 2 minutes, but its only job is maintenance (recovering stuck jobs and
    // finishing check runs). Touching Postgres on every tick would keep the serverless DB awake
    // 24/7. So gate the DB work on a KV flag that is set whenever a job is created/claimed and
    // cleared below once there is genuinely nothing left to maintain. When the flag is absent we
    // return without ever opening a DB connection, letting Postgres suspend.
    try {
      const active = await env.APP_KV.get('system:active_jobs');
      if (!active) {
        return;
      }
    } catch (error) {
      logger.warn('Failed to read active jobs flag from KV, proceeding with maintenance', error instanceof Error ? error : new Error(String(error)));
    }

    return runWithDb(env, async () => {
      await runBestEffortJobMaintenance(env);
      // As soon as no jobs are running/recoverable and no check runs are outstanding, drop the
      // flag so the next tick skips Postgres entirely (instead of waiting out the 20-minute TTL).
      // A new job re-sets the flag on insert/claim, so this only trims the idle tail.
      try {
        if (!(await hasPendingMaintenanceWork(env))) {
          await clearSystemActive(env);
        }
      } catch (error) {
        logger.warn('Failed to evaluate pending maintenance work; leaving active-jobs flag to expire via TTL', error instanceof Error ? error : new Error(String(error)));
      }
    });
  },

  async queue(batch: MessageBatch<unknown>, env: AppBindings, _ctx: ExecutionContext) {
    return runWithDb(env, async () => {
      try {
        await runBestEffortJobMaintenance(env);
      } catch (error) {
        logger.error('Pre-batch maintenance task failed', error instanceof Error ? error : new Error(String(error)));
      }

      for (const message of batch.messages) {
        const parseResult = reviewJobMessageSchema.safeParse(message.body);

        if (!parseResult.success) {
          logger.error('Invalid queue message schema; dropping message', {
            body: message.body,
            error: parseResult.error.flatten(),
          });
          // A malformed message can't be processed and retrying won't help, so ack it -- but if it
          // still carries a recognizable jobId, fail that job so it doesn't sit 'queued' forever
          // (lease recovery only revives 'running' rows).
          const strandedId = (message.body as { jobId?: unknown })?.jobId;
          if (typeof strandedId === 'string' && /^[0-9a-f-]{36}$/i.test(strandedId)) {
            try {
              await failJob(env, strandedId, 'Review dropped: the queue message failed schema validation.');
            } catch (failError) {
              logger.error('Failed to fail job stranded by an invalid queue message', failError instanceof Error ? failError : new Error(String(failError)));
            }
          }
          message.ack();
          continue;
        }

        // ── Phase 11 (CMD-07): command/qa messages are dispatched INLINE (non-Workflow) BEFORE the
        //    REVIEW_WORKFLOW.create block. A no-kind / kind==='review' message skips this branch and
        //    reaches the Workflow path byte-identically (NREG-01, T-11-06-3).
        if (parseResult.data.kind === 'command' || parseResult.data.kind === 'qa') {
          try {
            await dispatchInteractiveMessage(env, parseResult.data);
            message.ack();
          } catch (error) {
            // REVIEW: Codex 11-06 MED — a TRANSIENT failure must retry (bounded by the 3-attempt
            // consumer), never ack-and-lose; a DETERMINISTIC failure is logged and acked. Neither
            // falls through to REVIEW_WORKFLOW.create.
            const err = error instanceof Error ? error : new Error(String(error));
            if (isTransientDispatchError(error) && message.attempts < 3) {
              logger.warn('Transient interactive-dispatch failure; retrying', {
                kind: parseResult.data.kind,
                deliveryId: parseResult.data.deliveryId,
                attempts: message.attempts,
                error: err.message,
              });
              message.retry();
            } else {
              logger.error('Interactive dispatch failed; acking message', err);
              message.ack();
            }
          }
          continue;
        }

        try {
          // Recovery re-enqueues a stuck job under its original jobId; keying the instance on jobId
          // would collide with the dead instance (instance.already_exists) and get dropped as a
          // duplicate, so recovery sets forceFreshInstance to key the new instance on the (fresh)
          // deliveryId. deliveryId is a UUID, matching the workflow_instance_id column type.
          const id = parseResult.data.forceFreshInstance
            ? parseResult.data.deliveryId
            : (parseResult.data.jobId ?? parseResult.data.deliveryId);
          if (!id) {
            logger.error('Message missing identifiers; dropping', { body: message.body });
            message.ack();
            continue;
          }
          await env.REVIEW_WORKFLOW.create({
             id,
             params: parseResult.data,
          });
          message.ack();
        } catch (error) {
          if (error instanceof Error && error.message.includes('instance.already_exists')) {
            logger.info('Workflow instance already exists; dropping duplicate queue message.', {
              jobId: parseResult.data.jobId,
              deliveryId: parseResult.data.deliveryId,
            });
            message.ack();
            continue;
          }

          logger.error('Failed to create workflow', error instanceof Error ? error : new Error(String(error)));
          if (message.attempts >= 3) {
            const id = parseResult.data.jobId ?? parseResult.data.deliveryId;
            if (id) {
              try {
                await failJob(env, id, 'Failed to start Cloudflare Workflow after multiple attempts. The Cloudflare infrastructure might be experiencing an outage.');
              } catch (failError) {
                logger.error('Critical: Failed to mark job as failed in DB', failError instanceof Error ? failError : new Error(String(failError)));
              }
            }
            message.ack();
          } else {
            message.retry();
          }
        }
      }

      try {
        await runBestEffortJobMaintenance(env);
      } catch (error) {
        logger.error('Post-batch maintenance task failed', error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
} satisfies ExportedHandler<AppBindings>;
