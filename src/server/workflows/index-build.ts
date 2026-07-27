import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { AppBindings } from '@server/env';
import { runIndexBuild, type IndexBuildParams } from '@server/core/code-index-build';
import { logger } from '@server/core/logger';
import { runWithDb } from '@server/db/client';

/**
 * Phase 29 / QA-IDX-01 (D-05, D-06): the durable execution vehicle for a codebase index build.
 *
 * Structurally mirrors `workflows/review.ts` and is deliberately just as thin: every decision lives in
 * `core/code-index-build.ts` and this class only translates the returned action into `step.do`,
 * `step.sleep` or a fresh-instance handoff.
 *
 * D-06: this is a SEPARATE Workflow binding (`INDEX_WORKFLOW` / `codra-index-workflow`), not a new
 * payload kind inside `ReviewWorkflow`. It therefore runs NO review-job maintenance -- an index build is
 * not a review job, and adding an `index` branch to the review phase-routing selectors is the class of
 * routing hole Phase 20.1 spent eight plans hardening those selectors against.
 */

// The continuation number a HANDED-OFF instance starts at. It MUST NOT be 0.
//
// `runIndexBuild` treats continuation 0 as "this is the build's first invocation" and, on that branch
// only, performs the destructive reset (a full rebuild's truncate, an incremental refresh's changed-path
// delete). A handoff continues a build that is already partly done, so starting it at 0 would delete
// everything the handing-off instance indexed and restart from zero on every handoff -- meaning a
// repository large enough to need a handoff would never finish. Starting at 1 also gives the new
// instance a full MAX_INDEX_CONTINUATIONS budget of its own, which is the point of handing off.
//
// `runIndexBuild` carries a second, independent guard on the same reset (no progress rows at the build
// sha), so this constant is the primary defense rather than the only one.
const INDEX_HANDOFF_START_CONTINUATION = 1;

export class IndexWorkflow extends WorkflowEntrypoint<AppBindings, IndexBuildParams> {
  async run(event: WorkflowEvent<IndexBuildParams>, step: WorkflowStep) {
    // Share one DB client/connection for this entire invocation instead of opening a new Hyperdrive
    // connection per query (the default behavior of getDb() outside any runWithDb() context). On
    // workflow replay after a step.sleep or a resumed retry, this simply runs again and creates a fresh
    // client for that new invocation.
    return runWithDb(this.env, () => this.execute(event, step));
  }

  private async execute(event: WorkflowEvent<IndexBuildParams>, step: WorkflowStep) {
    const env = this.env;
    const params = event.payload;

    let continuation = params.continuation ?? 0;
    let delaySeconds = 0;
    let attempt = 0;

    for (;;) {
      attempt += 1;

      if (delaySeconds > 0) {
        // Forced minimum of one second: the sleep is what YIELDS EXECUTION BACK TO CLOUDFLARE, and that
        // yield is the only thing that resets the 50-subrequest per-invocation limit between batches.
        // `runIndexBuild` asks for INDEX_FRESH_INVOCATION_YIELD_SECONDS (60) precisely because a very
        // short sleep keeps the instance warm in the SAME invocation, so the real budget accumulates
        // across every batch until it is exhausted and the build stalls on "Too many subrequests".
        await step.sleep(`index-sleep-${attempt}`, `${Math.max(delaySeconds, 1)} seconds`);
      }

      const currentContinuation = continuation;

      const result = await step.do(
        `index-build-c${currentContinuation}-a${attempt}`,
        {
          retries: { limit: 5, delay: '60 seconds', backoff: 'exponential' },
          timeout: '15 minutes',
        },
        async () =>
          runIndexBuild(env, {
            ...params,
            continuation: currentContinuation,
            // The LIVE instance id, not whatever the trigger put on the payload. The build lease is
            // keyed on it, and `claimCodeIndexBuildLease` treats a re-claim by the SAME instance id as
            // a legal re-entry -- which is exactly what a post-hibernation resume is. Keying the lease
            // on a stale payload value would make a resumed build lock itself out of its own lease.
            workflowInstanceId: event.instanceId,
          }),
      );

      if (result.action === 'continue') {
        if (result.freshInstance) {
          // Hand the rest of the build to a BRAND-NEW instance. A long-lived instance (a 500-file build
          // spans many continuations over ~40 minutes) eventually stops hibernating between steps, so
          // its per-invocation subrequest budget never resets and every subsequent step immediately hits
          // Cloudflare's 50-subrequest cap. A fresh instance's first step always gets a clean budget.
          //
          // The id is a FRESH RANDOM UUID and deliberately NOT `codeIndexInstanceId(repositoryId)`: a
          // handoff must create a new instance, and keying it on the shared per-repository id would
          // collide with the instance that is handing off and be dropped as a benign
          // `instance.already_exists` duplicate -- stalling the build at the exact point the handoff
          // exists to rescue it.
          await step.do(`index-handoff-c${currentContinuation}-a${attempt}`, async () => {
            await env.INDEX_WORKFLOW.create({
              id: crypto.randomUUID(),
              params: { ...params, continuation: INDEX_HANDOFF_START_CONTINUATION },
            });
          });
          logger.info('Codebase index build handed off to a fresh workflow instance', {
            repositoryId: params.repositoryId,
            continuation: currentContinuation,
          });
          break;
        }

        continuation = currentContinuation + 1;
        delaySeconds = Math.max(result.delaySeconds, 1);
        continue;
      }

      if (result.action === 'retry') {
        // Same continuation, just a delay: a transient failure has NOT been recorded as a terminal build
        // failure, so the state row still reads `building` and the lease is still held.
        delaySeconds = Math.max(result.delaySeconds, 1);
        continue;
      }

      // 'ack' -- terminal in every one of its flavors (completed / disabled / coalesced / nothing_to_do).
      break;
    }
  }
}
