import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  isSupportedGitHubWebhookEvent,
  type GitHubWebhookPayload,
  type IssueCommentWebhookPayload,
  type PullRequestReviewCommentWebhookPayload,
  type PullRequestWebhookPayload,
  type PushWebhookPayload,
} from '@shared/github';
import type { AppEnv } from '@server/env';
import { loadRepoConfig } from '@server/core/config';
import { extractReviewRequest, type ReviewRequest } from '@server/core/review';
import { verifyGitHubWebhookSignature } from '@server/core/verify';
import { jsonError } from '@server/core/http';
import { ingestReviewWebhookEvent, isTransientCommentError, type WebhookIngestResult } from '@server/core/webhook-ingest';
import { startIndexBuild } from '@server/core/code-index-build';
import type { CommentContext } from '@server/core/commands';
import { recordWebhookDelivery, deleteWebhookDelivery } from '@server/db/webhook-deliveries';
import { findRepositoryIdByIdentity } from '@server/db/repositories';
import { logger } from '@server/core/logger';

// A mention-shaped ReviewRequest carrying the installationId the GitHub comment branch in the shared
// seam needs to construct the provider + insert a command review job (the seam reads it via
// input.reviewRequest?.installationId — Bitbucket carries none). SHAs/refs are empty because a comment
// event carries no PR head/base; the seam hydrates them from the live PR when a review command runs.
function buildMentionReviewRequest(input: {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): ReviewRequest {
  return {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    prTitle: null,
    prAuthor: null,
    commitSha: '',
    baseSha: '',
    headRef: null,
    baseRef: null,
    trigger: 'mention',
  };
}

// Project a GitHub comment payload into the provider-agnostic CommentContext. authorId is the
// IMMUTABLE numeric user id (as a string) — the ONLY id the self-filter/authorization key on (NREG-02),
// NEVER the renameable login. `in_reply_to_id` maps to findingRef so a reply left under an inline
// finding dismisses that finding (D-09, parity with Bitbucket comment.parent.id). workspace = owner
// login (the canonical GitHub pause-key workspace).
//
// `isInline` (Phase 12, D-03) is the webhook-set threadable capability flag. It is passed EXPLICITLY
// from the event type — true for `pull_request_review_comment` (inline review comments thread) and
// false for `issue_comment` (top-level PR comments are NOT threadable on GitHub) — and is NOT inferred
// from parentRef/findingRef, which are undefined for the common top-level-inline case (a first inline
// review comment carries no in_reply_to_id) and so are an unreliable proxy (research Pitfall #2).
function buildGithubCommentContext(input: {
  prNumber: number;
  owner: string;
  repo: string;
  comment: { id: number; body: string; user: { id: number; login: string }; in_reply_to_id?: number };
  isInline: boolean;
}): CommentContext {
  const inReplyTo = input.comment.in_reply_to_id;
  const findingRef = inReplyTo !== undefined ? String(inReplyTo) : undefined;
  return {
    authorId: String(input.comment.user.id),
    authorLogin: input.comment.user.login,
    body: input.comment.body,
    prNumber: input.prNumber,
    commentRef: String(input.comment.id),
    parentRef: findingRef,
    findingRef,
    owner: input.owner,
    repo: input.repo,
    workspace: input.owner,
    threadable: input.isInline,
  };
}

// Map every ingest outcome to the response shape. The pull_request auto path keeps its pre-Phase-11
// bytes (`queued` -> { ok, message:'queued', job }; `queued_event`/duplicate unchanged, NREG-01); the
// Phase-11 comment outcomes surface as explicit dispatched/ignored responses.
function respondToIngest(c: Context<AppEnv>, result: WebhookIngestResult): Response {
  switch (result.outcome) {
    case 'duplicate':
      return c.json({
        ok: true,
        duplicate: true,
        message: result.job.status === 'queued' ? 'queued' : 'duplicate',
        job: result.job,
      }, 202);
    case 'queued':
      return c.json({ ok: true, message: 'queued', job: result.job }, 202);
    case 'command_enqueued':
      return c.json({ ok: true, message: 'command_enqueued' }, 202);
    case 'qa_enqueued':
      return c.json({ ok: true, message: 'qa_enqueued' }, 202);
    case 'ignored_comment':
      return c.json({ ok: true, ignored: true, reason: result.reason }, 202);
    case 'ignored_paused':
      return c.json({ ok: true, ignored: true, reason: 'paused' }, 202);
    case 'ignored_directive':
      return c.json({ ok: true, ignored: true, reason: 'ignore_directive' }, 202);
    case 'queued_event':
    default:
      return c.json({ ok: true, message: 'queued' }, 202);
  }
}

// WR-03: run a comment-branch ingest so a TRANSIENT failure (bot-identity resolve / PR hydration /
// provider network) does not permanently drop the command. `recordWebhookDelivery` already ran its
// idempotent insert before this point, so a bare throw here returns a 5xx whose retry is short-
// circuited by the duplicate-delivery guard BEFORE classification re-runs. On a transient failure we
// delete the delivery record first, so the provider's retry re-processes cleanly; a deterministic
// failure keeps the record (retrying would not help) and still surfaces as a 5xx.
async function ingestCommentEventOrRetry(
  c: Context<AppEnv>,
  deliveryId: string,
  input: Parameters<typeof ingestReviewWebhookEvent>[1],
): Promise<Response> {
  try {
    const result = await ingestReviewWebhookEvent(c.env, input);
    return respondToIngest(c, result);
  } catch (error) {
    if (isTransientCommentError(error)) {
      try {
        await deleteWebhookDelivery(c.env, deliveryId);
      } catch (deleteError) {
        logger.error(
          'Failed to delete webhook delivery after a transient comment-ingest failure; the retry may be swallowed by the dedup guard',
          deleteError instanceof Error ? deleteError : new Error(String(deleteError)),
        );
      }
    }
    throw error;
  }
}

export async function handleGitHubWebhook(c: Context<AppEnv>) {
    const eventName = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');
    const signature = c.req.header('x-hub-signature-256');
    const rawBody = await c.req.text();

    if (!eventName || !deliveryId) {
      return jsonError('Missing GitHub webhook headers.', 400);
    }

    const verified = await verifyGitHubWebhookSignature(c.env.GITHUB_APP_WEBHOOK_SECRET, signature ?? null, rawBody);
    if (!verified) {
      return jsonError('Invalid webhook signature.', 401);
    }

    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubWebhookPayload;
    } catch {
      return jsonError('Invalid webhook JSON payload.', 400);
    }

    const insertedDelivery = await recordWebhookDelivery(c.env, {
      deliveryId,
      eventName,
      owner: 'repository' in payload ? payload.repository.owner.login : null,
      repo: 'repository' in payload ? payload.repository.name : null,
      payload,
    });

    if (!insertedDelivery) {
      return c.json({ ok: true, duplicate: true }, 202);
    }

    const installationId = String(payload.installation?.id ?? '');
    if (!installationId || !('repository' in payload) || !payload.repository) {
      return c.json({ ok: true, ignored: true }, 202);
    }

    if (!isSupportedGitHubWebhookEvent(eventName)) {
      return c.json({ ok: true, ignored: true, eventName }, 202);
    }

    const repoConfig = await loadRepoConfig(c.env, {
      installationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    if (repoConfig.enabled === false) {
      return c.json({ ok: true, ignored: true, reason: 'repository_disabled' }, 202);
    }

    const config = repoConfig.parsedJson;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    // ── push (Phase 29, QA-IDX-01 / D-08): a default-branch push refreshes the codebase index.
    //
    // THE PLACEMENT OF THIS BRANCH IS LOAD-BEARING. `recordWebhookDelivery` runs BEFORE the
    // supported-event gate above, so adding 'push' to the supported-event list immediately changes
    // which deliveries flow into this part of the handler — and everything below this branch assumes
    // a pull-request-shaped payload (`extractReviewRequest`, `payload.pull_request.body`). A push
    // payload has no pull request, so the branch sits before that tail and EVERY path inside it
    // returns.
    //
    // THE STORAGE CONSEQUENCE OF THAT ORDERING (review: OpenCode 29-06 MEDIUM, accepted and
    // disclosed): every `push` delivery to every configured repository is now RECORDED, including
    // pushes to branches this handler immediately ignores, so `webhook_deliveries` grows with total
    // push traffic rather than with pull-request traffic. The recorder is deliberately NOT moved
    // after the gate — recording before the gate is what makes an unrecognized or misrouted delivery
    // diagnosable at all, and that diagnosability is worth more than the row count.
    if (eventName === 'push') {
      const push = payload as PushWebhookPayload;
      // Every ignore path logs the event kind so an operator tracing a missing refresh can tell
      // which event produced which decision. It is deliberately NOT in the response body: the event
      // kind arrives on a client-supplied header from an unauthenticated caller, and reflecting
      // unvalidated input into a response gains nothing an operator reads (review: OpenCode 29-06
      // LOW, adopted with that deliberate change).
      const logPushIgnore = (reason: string) =>
        logger.info('GitHub push delivery ignored', { owner, repo, eventKind: eventName, ref: push.ref, reason });
      const pushIgnored = (reason: string) => {
        logPushIgnore(reason);
        return c.json({ ok: true, ignored: true, reason }, 202);
      };

      // A deletion has no `after` commit to index — check before any ref reasoning, because deleting
      // the DEFAULT branch would otherwise pass the ref equality check below.
      if (push.deleted) {
        return pushIgnored('deleted');
      }
      // Tags (and any other non-branch ref) can never be the default branch.
      if (!push.ref.startsWith('refs/heads/')) {
        return pushIgnored('non_branch_ref');
      }
      // ASSUMPTION A1: `repository.default_branch` is not documented for the push event, so read
      // `default_branch ?? master_branch` and SKIP rather than guess when both are absent. This is
      // the one branch whose failure is otherwise completely invisible: if the field turns out to be
      // absent in practice, every default-branch push silently becomes an ignored acknowledgement
      // and index freshness never fires with no error anywhere. The warning's payload carries the
      // owner, the repo, the event kind and the ref — and nothing else; no commit list, no committer
      // identity, no payload body.
      const defaultBranch = push.repository.default_branch ?? push.repository.master_branch;
      if (!defaultBranch) {
        logger.warn('GitHub push delivery ignored: payload carries no default-branch field, so the default branch cannot be resolved', {
          owner,
          repo,
          eventKind: eventName,
          ref: push.ref,
        });
        return c.json({ ok: true, ignored: true, reason: 'default_branch_unknown' }, 202);
      }
      if (push.ref !== `refs/heads/${defaultBranch}`) {
        return pushIgnored('non_default_branch');
      }
      // NREG-01 / T-29-06-03: the freshness path is inert for a repository that has not opted in.
      if (!config.review.interactive.qa.index.enabled) {
        return pushIgnored('index_disabled');
      }

      const repositoryId = await findRepositoryIdByIdentity(c.env, {
        vcsProvider: 'github',
        ownerOrWorkspace: owner,
        repo,
      });
      if (repositoryId === null) {
        return pushIgnored('repository_not_registered');
      }

      // A CREATED branch has an all-zeros before-sha, so a compare is meaningless — start a full
      // rebuild instead of passing a zero sha to the build's compare call as if it were a real
      // ancestor.
      // A FORCED push may leave the before-sha not an ancestor of the after-sha, so the compare can
      // be large or fail; the incremental build's own failure handling covers that and the reason is
      // recorded rather than silently swallowed.
      const mode = push.created ? 'full' : 'incremental';
      // The lease claim, instance-id derivation (the SHARED helper both push branches and the
      // dashboard trigger key on), and the `instance.already_exists` stale-instance retry all live in
      // `startIndexBuild` — see its doc comment for why a per-repository-stable id would otherwise
      // mean a repository's index could only ever be refreshed once.
      const outcome = await startIndexBuild(c.env, {
        repositoryId,
        vcsProvider: 'github',
        owner,
        repo,
        workspace: null,
        installationId,
        mode,
        ...(mode === 'incremental' ? { baseSha: push.before, headSha: push.after } : {}),
      });
      if (!outcome.started) {
        if (outcome.coalesced) {
          logger.info('Codebase index refresh coalesced: workflow instance already exists', {
            owner,
            repo,
            eventKind: eventName,
            repositoryId,
            reason: outcome.reason,
          });
          return c.json({ ok: true, coalesced: true, reason: outcome.reason }, 202);
        }
        throw outcome.error;
      }
      logger.info('GitHub push triggered a codebase index refresh', {
        owner,
        repo,
        eventKind: eventName,
        ref: push.ref,
        mode,
        repositoryId,
      });
      return c.json(
        mode === 'full'
          ? { ok: true, refreshed: true, mode, reason: 'branch_created_full_rebuild' }
          : { ok: true, refreshed: true, mode },
        202,
      );
    }

    // The interactive comment surface (commands / Q&A) is only wired when at least one toggle is on.
    // With BOTH off, issue_comment keeps its pre-Phase-11 legacy `@mention` review path (extract ->
    // queued_event -> Workflow) so mention-triggers-review stays byte-identical (NREG-01); we do NOT
    // thread commentContext there.
    const interactiveEnabled =
      config.review.interactive.commands.enabled || config.review.interactive.qa.enabled;

    // ── pull_request_review_comment (D-09, OQ2): a reply left UNDER an inline review finding. This is a
    //    net-new subscription with no legacy path — always project a CommentContext and hand off to the
    //    seam, which self-filters/classifies (feature on) or returns ignored_comment with no job / no
    //    side effect (feature off, NREG-01). in_reply_to_id -> findingRef is the reply-under-finding
    //    reject linkage (parity with Bitbucket comment.parent.id).
    if (eventName === 'pull_request_review_comment') {
      const reviewComment = payload as PullRequestReviewCommentWebhookPayload;
      if (reviewComment.action !== 'created') {
        return c.json({ ok: true, ignored: true, eventName }, 202);
      }
      const prNumber = reviewComment.pull_request.number;
      const commentContext = buildGithubCommentContext({
        prNumber,
        owner,
        repo,
        comment: reviewComment.comment,
        // pull_request_review_comment is an inline review comment — threadable (D-03).
        isInline: true,
      });
      return ingestCommentEventOrRetry(c, deliveryId, {
        reviewRequest: buildMentionReviewRequest({ installationId, owner, repo, prNumber }),
        configSnapshot: config,
        deliveryId,
        requestId: c.get('requestId'),
        eventName,
        commentContext,
      });
    }

    // ── issue_comment WITH interactive on: a PR-level comment. Project a CommentContext and hand off
    //    to the seam (self-filter -> command / qa / ignored). Only PR comments (issue.pull_request
    //    present) with action 'created' are relevant; anything else is ignored.
    if (eventName === 'issue_comment' && interactiveEnabled) {
      const issueComment = payload as IssueCommentWebhookPayload;
      if (!issueComment.issue?.pull_request || issueComment.action !== 'created') {
        return c.json({ ok: true, ignored: true, eventName }, 202);
      }
      const prNumber = issueComment.issue.number;
      const commentContext = buildGithubCommentContext({
        prNumber,
        owner,
        repo,
        comment: issueComment.comment,
        // issue_comment is a top-level PR comment — NOT threadable on GitHub (D-03).
        isInline: false,
      });
      return ingestCommentEventOrRetry(c, deliveryId, {
        reviewRequest: buildMentionReviewRequest({ installationId, owner, repo, prNumber }),
        configSnapshot: config,
        deliveryId,
        requestId: c.get('requestId'),
        eventName,
        commentContext,
      });
    }

    // ── pull_request AUTO path (+ issue_comment legacy mention path when interactive is off). Behavior
    //    is byte-identical to pre-Phase-11 (NREG-01) except the pull_request branch now forwards
    //    prBody = pull_request.body so the commands-gated CMD-06 ignore gate has the PR description on
    //    AUTO events too (REVIEW: Codex 11-06/11-07).
    const extracted = extractReviewRequest({
      eventName,
      payload,
      botUsername: c.env.BOT_USERNAME,
      config,
    });

    const prBody =
      eventName === 'pull_request'
        ? (payload as PullRequestWebhookPayload).pull_request.body ?? undefined
        : undefined;

    const result = await ingestReviewWebhookEvent(c.env, {
      reviewRequest: extracted,
      configSnapshot: config,
      deliveryId,
      requestId: c.get('requestId'),
      eventName,
      prBody,
    });

    return respondToIngest(c, result);
}

export function createWebhookRouter() {
  const app = new Hono<AppEnv>();

  app.post('/', handleGitHubWebhook);

  return app;
}
