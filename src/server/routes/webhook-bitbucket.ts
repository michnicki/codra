import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import { jsonError } from '@server/core/http';
import { verifyWebhookSignature } from '@server/core/verify';
import { decryptSecret } from '@server/core/crypto';
import { getVcsCredentialSecrets } from '@server/db/vcs-credentials';
import { findRepositoryByBitbucketIdentity } from '@server/db/repositories';
import { getRepoConfigByRepositoryId } from '@server/db/repo-configs';
import { mostRecentJobForPullRequest } from '@server/db/jobs';
import { recordWebhookDelivery, deleteWebhookDelivery } from '@server/db/webhook-deliveries';
import { ingestReviewWebhookEvent, isTransientCommentError } from '@server/core/webhook-ingest';
import { logger } from '@server/core/logger';
import { getGlobalConfig } from '@server/core/config';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { bytesToHex } from '@server/db/jobs';
import { pullRequestWebhookPayloadSchema } from '@shared/bitbucket';
import { codeIndexInstanceId, type IndexBuildParams } from '@server/core/code-index-build';
import { VcsService } from '@server/services/vcs';
import type { CommentContext } from '@server/core/commands';

// POST /webhook/bitbucket — the live entry point that closes the Phase-3 deferred item
// (REVIEW finding 3 of Phase 3 — `ingestReviewWebhookEvent` was extracted provider-agnostic
// but never made provider-aware for concrete jobs).
//
// 16-step handler flow (the bit-locked surface documented in 05-04-PLAN.md):
//
//   1.  Capture raw body via c.req.text() BEFORE any JSON.parse (preserve byte-identity
//       for HMAC).
//   2.  Read X-Event-Key; missing -> 400.
//   3.  REV-M-6: parse JUST the identity-bearing projection as a small Zod projection
//       (NOT the full payload schema) to obtain {workspace, repo_slug} for credential
//       lookup. Order: identity-projection parse -> getVcsCredentialSecrets -> decryptSecret
//       -> verifyWebhookSignature -> full payload parse. Phase 29 (QA-IDX-01, D-08): the
//       projection identifies the REPOSITORY for ANY event kind — `repository.name` and
//       `repository.workspace.slug` stay hard-required, while the pull-request half is
//       optional so a `repo:push` delivery (which carries no `pullrequest`) can be
//       identified. Event-specific fields are validated only AFTER verification, at the
//       step-8 full parse.
//   4.  D-19: lowercase `workspace + repo_slug` defensively to match the stored
//       credential key (Phase 4 storage normalization).
//   5.  getVcsCredentialSecrets; null OR encryptedWebhookSecret null -> 401 (D-05 fail-closed).
//   6.  decryptSecret; on throw -> 401.
//   7.  Read X-Hub-Signature; verifyWebhookSignature -> 401 (D-05 fail-closed).
//   8.  REV-M-1: parse the FULL payload as {eventName: xEventKey, ...JSON.parse(rawBody)}
//       and validate against pullRequestWebhookPayloadSchema.safeParse. eventName was
//       injected from the trusted X-Event-Key header so the discriminated union matches.
//   9.  D-20: findRepositoryByBitbucketIdentity; null -> 202 ignored (short-circuit).
//  10.  D-04: if eventName === 'pullrequest:updated', mostRecentJobForPullRequest; if its
//       commitSha == payload.pullrequest.source.commit.hash -> 200 ignored metadata_only_edit.
//  11.  Read X-Request-UUID (or crypto.randomUUID()) as the deliveryId; log context.
//  12.  REV-R-D: recordWebhookDelivery with repositoryId passthrough so the delivery is
//       attributed to the Bitbucket repository row.
//  13.  Construct an inline `ReviewRequest`-shaped value carrying the Bitbucket identity
//       (repositoryVcsProvider: 'bitbucket', repositoryWorkspace, baseSha from
//       payload.pullrequest.destination.commit.hash with '' fallback).
//  14.  Call ingestReviewWebhookEvent with provider: 'bitbucket'.
//  15.  Pattern-match the result union per D-17:
//         - queued:           200 { ok, eventName, reviewed: true }
//         - duplicate:        202 { ok, eventName, duplicate: true, message: 'queued' }
//         - queued_event:     202 { ok, eventName, queued_event: true }
//  16.  Logger redaction of token/secret keys is the trust boundary (T-04-02 carry-over);
//       the raw body is never logged.
//
// All 401/400 paths fail closed (D-05, D-06). With one exception the route makes no
// api.bitbucket.org calls: the Phase-29 `repo:push` branch spends ONE subrequest on
// `getRepositoryMetadata` to resolve the repository's main branch, because Bitbucket's push
// payload carries no default-branch field (GitHub's does, so the GitHub side of D-08 needs no
// call). Everything else — the actual external work — happens in the worker, not the route.

// Small Zod projection used to extract only the identity-bearing prefix of the raw body.
// Strict-by-default; documented provider fields beyond `{repository.workspace.slug,
// repository.name, pullrequest.id}` are dropped here on purpose — the full payload parse
// at step 8 uses the (now passthrough) pullRequestWebhookPayloadSchema.
//
// Phase 29 (QA-IDX-01, D-08): `pullrequest` is present-but-OPTIONAL so the projection identifies
// the repository for ANY event kind — a `repo:push` delivery carries no `pullrequest` and was
// rejected here with a 400 BEFORE the HMAC verify (BLOCKER-1). The repository half stays
// hard-required: the credential lookup still keys on `{repository.name, repository.workspace.slug}`,
// both of which a `repo:push` body carries. The field is kept (not deleted) so type inference for
// the three pull-request event kinds is preserved rather than widened away (review: Antigravity
// S-02). Event-specific fields are validated only after verification, at the step-8 full parse.
const bitbucketIdentityProjectionSchema = z.object({
  repository: z.object({
    name: z.string().min(1),
    workspace: z.object({
      slug: z.string().min(1),
    }),
  }),
  pullrequest: z.object({
    id: z.number().int().positive(),
  }).optional(),
});

export async function handleBitbucketWebhook(c: Context<AppEnv>) {
  // Step 1: raw body BEFORE any JSON.parse — HMAC verifies on the exact byte sequence.
  const rawBody = await c.req.text();

  // Step 2: X-Event-Key — without it we don't know which schema variant to validate.
  const xEventKey = c.req.header('x-event-key');
  if (!xEventKey) {
    return jsonError('Missing Bitbucket webhook headers.', 400);
  }

  // Step 3: REV-M-6 — identity-projection parse. This is BEFORE HMAC verify because we
  // need {workspace, repo_slug} to look up the per-repo secret to feed into verify. A parse
  // failure here yields a 400 because the route cannot identify the source repo (and so
  // cannot safely branch on a 'good' secret lookup).
  const identityParse = bitbucketIdentityProjectionSchema.safeParse(safeJsonParse(rawBody));
  if (!identityParse.success) {
    return jsonError('Invalid webhook payload.', 400);
  }
  const projectedWorkspace = identityParse.data.repository.workspace.slug;
  const projectedRepoSlug = identityParse.data.repository.name;

  // Step 4: D-19 — defensive lowercase to match the Phase-4 storage normalization.
  const workspace = projectedWorkspace.toLowerCase();
  const repoSlug = projectedRepoSlug.toLowerCase();

  // Step 5: per-repo secret lookup — null row OR null secret fails closed (D-05).
  const credentials = await getVcsCredentialSecrets(c.env, {
    vcsProvider: 'bitbucket',
    workspace,
    repoSlug,
  });
  if (!credentials?.encryptedWebhookSecret) {
    return jsonError('Webhook secret not configured.', 401);
  }

  // Step 6: decrypt the stored secret. A decryption failure (wrong key, corrupted
  // ciphertext, version mismatch) is a 401 — the HMAC cannot verify and we fail closed.
  let decryptedSecret: string;
  try {
    decryptedSecret = await decryptSecret(c.env, credentials.encryptedWebhookSecret);
  } catch {
    return jsonError('Webhook secret could not be decrypted.', 401);
  }

  // Step 7: HMAC verify on the byte-identical raw body. Missing header or bad signature -> 401.
  const signature = c.req.header('x-hub-signature');
  const verified = await verifyWebhookSignature({
    secret: decryptedSecret,
    signatureHeaderName: 'x-hub-signature',
    signature,
    rawBody,
  });
  if (!verified) {
    return jsonError('Invalid webhook signature.', 401);
  }

  // Step 8: REV-M-1 — full payload parse. The eventName is injected from the TRUSTED
  // header (X-Event-Key was not part of rawBody — it was a separate header); an attacker
  // cannot forge an eventName inside the body because the body's eventName field is
  // ignored (the header value is the source of truth).
  //
  // THE VERIFICATION ORDER IS FIXED AND MUST NOT BE "SIMPLIFIED": identity projection, then
  // credential lookup, then decrypt, then HMAC verify, then full parse. A new event type
  // (Phase 29 added `repo:push`) is validated only AFTER verification — a new event adds
  // payload-validation work, never verification work, and `src/server/core/verify.ts` is
  // event-agnostic precisely so it needs no change here. Moving the full parse earlier
  // would run schema validation on unauthenticated input; do not do it.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return jsonError('Invalid webhook JSON payload.', 400);
  }

  const envelope = { eventName: xEventKey, ...(typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : {}) };
  const parsed = pullRequestWebhookPayloadSchema.safeParse(envelope);
  if (!parsed.success) {
    return jsonError('Invalid webhook payload.', 400);
  }

  // Step 9: D-20 — short-circuit when no repositories row matches the (workspace, repo)
  // identity. The HMAC verified, but we don't know which repo to attribute this delivery
  // to — return 202 ignored.
  const repositoryId = await findRepositoryByBitbucketIdentity(c.env, { workspace, repoSlug });
  if (repositoryId === null) {
    return c.json({
      ok: true,
      ignored: true,
      eventName: xEventKey,
      reason: 'repository_not_registered',
    }, 202);
  }

  // Step 10: D-04 — metadata-only-edit dedup. If the most-recent job for this PR carries
  // the same commit hash as the incoming pullrequest.source.commit.hash, treat this event
  // as a UI/PR-edit re-delivery and skip enqueueing. This matches the Bitbucket semantics
  // where `pullrequest:updated` fires on title/body/description edits too.
  //
  // Phase 29 (QA-IDX-01, D-08): the pull-request field reads are GUARDED BY THE EVENT KIND.
  // Only the three pull-request event kinds carry `pullrequest`; a `repo:push` delivery has
  // none, so reading these unconditionally would throw (and before that, would fail the
  // typecheck). The repo:push branch below returns for that event, so these values are never
  // consumed for it.
  const prNumber = parsed.data.eventName !== 'repo:push' ? parsed.data.pullrequest.id : 0;
  const incomingCommitSha = parsed.data.eventName !== 'repo:push' ? parsed.data.pullrequest.source.commit.hash : '';
  if (xEventKey === 'pullrequest:updated') {
    const recent = await mostRecentJobForPullRequest(c.env, {
      vcsProvider: 'bitbucket',
      workspace,
      owner: workspace,
      repo: repoSlug,
      prNumber,
    });
    if (recent) {
      const recentCommitSha = bytesToHex(recent.commit_sha);
      if (recentCommitSha === incomingCommitSha) {
        return c.json({
          ok: true,
          ignored: true,
          eventName: xEventKey,
          reason: 'metadata_only_edit',
        }, 200);
      }
    }
  }

  // Step 11: derive the deliveryId. Use the X-Request-UUID header (Bitbucket includes it)
  // when present; fall back to a random UUID for anonymous deliveries.
  const xRequestUUID = c.req.header('x-request-uuid') ?? crypto.randomUUID();

  // Step 12: REV-R-D — record the webhook delivery attributed to the resolved
  // Bitbucket repository row. owner/repo are null (R-10) so the legacy SELECT-by-owner/
  // repo lookup (which would collide with a same-text GitHub repo) is bypassed; the
  // resolved repositoryId is passed directly.
  const insertedDelivery = await recordWebhookDelivery(c.env, {
    deliveryId: xRequestUUID,
    eventName: xEventKey,
    owner: null,
    repo: null,
    repositoryId,
    payload: parsed.data,
  });
  if (!insertedDelivery) {
    return c.json({
      ok: true,
      duplicate: true,
      eventName: xEventKey,
    }, 202);
  }

  // Step 13b (relocated): resolve the review model strategy snapshot ONCE — both the Phase-11
  // comment branch below and the auto (created/updated) branch need it. defaultRepoConfig's model
  // section is empty ({ main: null, fallbacks: [], size_overrides: [] }), so snapshotting it verbatim
  // makes ModelService.selectModel throw "No review model strategy is configured" and fail every
  // Bitbucket review before finalize. Fall back to the GLOBAL model strategy — the same source
  // loadRepoConfig uses for a repo with no per-repo override (KV key config:global_model) — so
  // Bitbucket jobs resolve a model chain exactly like GitHub jobs. We intentionally do NOT call
  // loadRepoConfig here: its syncRepoConfig -> getOrCreateRepository side effect is GitHub-shaped
  // and would create a spurious vcs_provider='github' row for this Bitbucket repo.
  const globalModel = await getGlobalConfig(c.env);
  // Phase 11 (CMD-05/06/07): merge the per-repo interactive (commands / qa) config so Bitbucket
  // commands + Q&A + reply-under-finding reject can be ENABLED per-repo (NREG-02 parity with GitHub).
  // Read provider-safely by the authoritative repositoryId (NOT owner/repo, which collides across
  // providers). ONLY the `review.interactive` section is merged — everything else stays at
  // defaultRepoConfig so the existing Bitbucket AUTO-review paths are byte-identical when no per-repo
  // interactive config exists (NREG-01): defaultRepoConfig.review.interactive has both toggles off, so
  // the commands-gated pause/ignore gate never fires for a repo without a config row.
  const repoConfigRecord = await getRepoConfigByRepositoryId(c.env, repositoryId);
  // 29-09 UAT fix: this used to overwrite `model` with `globalModel` unconditionally, silently
  // discarding any per-repo model override -- confirmed live testing that a Bitbucket repo's own
  // model strategy is never honored regardless of what the operator configures on the dashboard,
  // unlike GitHub's `loadRepoConfig` (`hasRepoModelOverride` in this same file). Mirror that check
  // here: only fall back to the global model when the repo genuinely has no override configured,
  // same "empty sentinel" shape (`{ main: null, fallbacks: [], size_overrides: [] }`) `getGlobalConfig`
  // itself guards against.
  const repoModel = repoConfigRecord?.parsedJson.model;
  const hasRepoModelOverride = Boolean(
    repoModel?.main ||
      (Array.isArray(repoModel?.fallbacks) && repoModel.fallbacks.length > 0) ||
      (Array.isArray(repoModel?.size_overrides) && repoModel.size_overrides.length > 0),
  );
  const configSnapshot: RepoConfig = {
    ...defaultRepoConfig,
    model: hasRepoModelOverride ? repoModel! : globalModel,
    review: {
      ...defaultRepoConfig.review,
      interactive: repoConfigRecord?.parsedJson.review.interactive ?? defaultRepoConfig.review.interactive,
    },
  };

  // Phase 11 (CMD-07, D-12): EARLY pullrequest:comment_created branch. Placed AFTER the HMAC verify +
  // repo resolution + recordWebhookDelivery idempotency guard, but BEFORE the source-SHA dedupe /
  // automatic ReviewRequest construction. A comment event is NOT a metadata-only PR edit, so it does
  // NOT enter the step-10 pullrequest:updated short-circuit (that gate is keyed on
  // xEventKey === 'pullrequest:updated', which a comment event never matches — REVIEW: Antigravity #3).
  // The route ONLY projects the provider payload into a provider-agnostic CommentContext; the shared
  // seam self-filters (on the bot's immutable account_id) + classifies + authorizes + dispatches (D-03).
  // It never bypasses HMAC/idempotency — both gates already ran above.
  if (parsed.data.eventName === 'pullrequest:comment_created') {
    // WR-02: classification (classifyComment) and the CMD-06 ignore gate must see the FULL per-repo
    // `review` config — most importantly a custom `mention_trigger`, but also skip_files /
    // max_total_diff_chars — otherwise a Bitbucket repo with a custom trigger would have its
    // commands/Q&A silently never fire (NREG-02 parity break vs GitHub, whose route feeds the full
    // per-repo config). It also keeps classification consistent with the consumer, which re-loads the
    // FULL per-repo config at answer time (WR-01). This enriched snapshot is COMMENT-branch-only and
    // used solely for classification/gating (the actual review job re-loads config), so the shared
    // `configSnapshot` handed to the AUTO-review branch below stays byte-identical (NREG-01). With no
    // per-repo row, `?? defaultRepoConfig.review` reproduces the default exactly.
    // Spread the FULL per-repo `review` (which already carries `interactive`); `model` is preserved
    // from the shared snapshot (the global-model overlay resolved above — `model` lives outside `review`).
    const commentConfigSnapshot: RepoConfig = {
      ...configSnapshot,
      review: {
        ...(repoConfigRecord?.parsedJson.review ?? defaultRepoConfig.review),
      },
    };
    const comment = parsed.data.comment;
    const commentPrNumber = parsed.data.pullrequest.id;
    const parentId = comment.parent?.id;
    // finding/parent ref uses the provider-OPAQUE `${prNumber}:${id}` convention that
    // BitbucketAdapter.createPrComment emits (vcs/bitbucket.ts:339), NOT a bare String(parent.id), so a
    // persisted reject ref is adapter-consistent across PRs (REVIEW: Codex 11-01/11-07; T-11-07-5).
    const parentRef = parentId !== undefined ? `${commentPrNumber}:${parentId}` : undefined;
    const prDescription = (parsed.data.pullrequest as { description?: unknown }).description;

    const commentContext: CommentContext = {
      // authorId is the IMMUTABLE account_id — the ONLY id the self-filter/authorization key on (NREG-02).
      authorId: comment.user.account_id,
      authorLogin: comment.user.nickname,
      body: comment.content.raw,
      prNumber: commentPrNumber,
      commentRef: `${commentPrNumber}:${comment.id}`,
      parentRef,
      // reply-under-finding reject: comment.parent.id encoded as the opaque finding ref (D-09).
      findingRef: parentRef,
      owner: workspace,
      repo: repoSlug,
      workspace,
      // Bitbucket threads BOTH general and inline comments, so every Bitbucket comment is threadable
      // regardless of whether it is a reply (parentRef present) or top-level (D-03).
      threadable: true,
    };

    // WR-03: a TRANSIENT failure in the synchronous comment path (bot-identity resolve / PR
    // hydration / provider network) must not permanently drop the command. recordWebhookDelivery
    // already ran its idempotent insert above, so a bare throw returns a 5xx whose retry is short-
    // circuited by the duplicate-delivery guard before classification re-runs. Delete the delivery
    // record on a transient failure so the provider's retry re-processes; deterministic failures keep
    // the record and still surface as a 5xx (retrying would not help).
    let result;
    try {
      result = await ingestReviewWebhookEvent(c.env, {
        reviewRequest: null,
        configSnapshot: commentConfigSnapshot,
        deliveryId: xRequestUUID,
        requestId: c.get('requestId'),
        eventName: xEventKey,
        provider: 'bitbucket',
        commentContext,
        prBody: typeof prDescription === 'string' ? prDescription : undefined,
      });
    } catch (error) {
      if (isTransientCommentError(error)) {
        try {
          await deleteWebhookDelivery(c.env, xRequestUUID);
        } catch (deleteError) {
          logger.error(
            'Failed to delete Bitbucket webhook delivery after a transient comment-ingest failure; the retry may be swallowed by the dedup guard',
            deleteError instanceof Error ? deleteError : new Error(String(deleteError)),
          );
        }
      }
      throw error;
    }

    if (result.outcome === 'queued') {
      return c.json({ ok: true, eventName: xEventKey, reviewed: true }, 200);
    }
    if (result.outcome === 'duplicate') {
      return c.json({ ok: true, eventName: xEventKey, duplicate: true, message: 'queued' }, 202);
    }
    if (result.outcome === 'command_enqueued' || result.outcome === 'qa_enqueued') {
      return c.json({ ok: true, eventName: xEventKey, dispatched: true }, 202);
    }
    // ignored_comment / ignored_paused / ignored_directive (the exclusive comment branch never
    // returns queued_event — map any other outcome defensively as an ignore).
    const reason = result.outcome === 'ignored_comment' ? result.reason : result.outcome;
    return c.json({ ok: true, eventName: xEventKey, ignored: true, reason }, 202);
  }

  // Phase 29 (QA-IDX-01, D-08): the `repo:push` branch — a push to the repository's main branch
  // refreshes the codebase index. Placed AFTER the full-payload parse (step 8), the repository
  // resolution (step 9), the delivery idempotency record (step 12) and the config resolution
  // (step 13b), so it runs only on verified, schema-valid input; and BEFORE step 13, which reads
  // pull-request fields a push delivery does not carry. Every path inside returns.
  if (parsed.data.eventName === 'repo:push') {
    const pushData = parsed.data;
    // As with the GitHub branch: the event kind goes in the LOG payload for every ignore path
    // (an operator tracing a missing refresh reads logs), never in the response body (it arrives
    // on a client-supplied header from an unauthenticated caller).
    const pushIgnored = (reason: string) => {
      logger.info('Bitbucket repo:push delivery ignored', {
        workspace,
        repo: repoSlug,
        eventKind: xEventKey,
        reason,
      });
      return c.json({ ok: true, ignored: true, reason }, 202);
    };

    // NREG-01 / T-29-06-03: checked FIRST so an opted-out repository spends no subrequest on the
    // metadata read below. `configSnapshot.review.interactive` already carries the per-repo row
    // (relocated step 13b), so this is the same toggle the GitHub branch reads.
    if (!configSnapshot.review.interactive.qa.index.enabled) {
      return pushIgnored('index_disabled');
    }

    // Resolve the repository's main branch through the adapter's getRepositoryMetadata
    // (`mainbranch.name`) — the SAME adapter-resolves-its-own-default-branch shape the GitHub
    // side of D-08 uses and the same client read `listDefaultBranchTree` resolves through. Do NOT
    // introduce a third resolution path (a payload field, a hardcoded 'master'). THE ASYMMETRY
    // THAT REMAINS, and why it is unavoidable: GitHub's push payload carries the default branch
    // on the payload so no extra call is needed there, while Bitbucket's does not — so this
    // branch spends one subrequest to learn it. A failed read or a missing main branch gets the
    // same failure discipline as the GitHub both-absent path: a warning and an ignored
    // acknowledgement, so neither provider can skip a refresh silently.
    let mainBranch: string | null = null;
    try {
      const provider = await VcsService.forProvider(c.env, { provider: 'bitbucket', workspace, repo: repoSlug });
      const metadata = await provider.getRepositoryMetadata?.(workspace, repoSlug);
      mainBranch = metadata?.mainbranch?.name ?? null;
    } catch (error) {
      logger.warn('Bitbucket repo:push ignored: main-branch metadata read failed', {
        workspace,
        repo: repoSlug,
        eventKind: xEventKey,
        reason: error instanceof Error ? error.message : String(error),
      });
      return c.json({ ok: true, ignored: true, reason: 'default_branch_unknown' }, 202);
    }
    if (!mainBranch) {
      logger.warn('Bitbucket repo:push ignored: repository reports no main branch', {
        workspace,
        repo: repoSlug,
        eventKind: xEventKey,
      });
      return c.json({ ok: true, ignored: true, reason: 'default_branch_unknown' }, 202);
    }

    // THE INSTANCE ID COMES FROM THE SHARED HELPER, never a hand-built string — the GitHub push
    // branch and the dashboard trigger key on the same helper, and the `instance.already_exists`
    // coalescing all three rely on can only fire when the ids are byte-identical.
    const workflowInstanceId = codeIndexInstanceId(repositoryId);
    let startedMode: 'full' | 'incremental' | null = null;
    let coalesced = false;
    let firstIgnoreReason: string | null = null;

    for (const change of pushData.push.changes) {
      // A null `new` is a ref deletion — nothing to index.
      if (!change.new) {
        firstIgnoreReason ??= 'deleted';
        logger.info('Bitbucket repo:push change ignored', { workspace, repo: repoSlug, eventKind: xEventKey, reason: 'deleted' });
        continue;
      }
      // `repo:push` fires for tags too; only branch pushes can refresh the default-branch index.
      if (change.new.type !== 'branch') {
        firstIgnoreReason ??= 'non_branch_ref';
        logger.info('Bitbucket repo:push change ignored', { workspace, repo: repoSlug, eventKind: xEventKey, reason: 'non_branch_ref' });
        continue;
      }
      if (change.new.name !== mainBranch) {
        firstIgnoreReason ??= 'non_default_branch';
        logger.info('Bitbucket repo:push change ignored', { workspace, repo: repoSlug, eventKind: xEventKey, reason: 'non_default_branch' });
        continue;
      }

      // A null `old` means the push CREATED the branch, so there is no ancestor to compare
      // against — start a full rebuild instead of a compare against a missing sha. A FORCED push
      // may leave the old hash not an ancestor of the new one; the incremental build's own
      // failure handling covers that and records the reason.
      const mode = change.old ? 'incremental' : 'full';
      const params: IndexBuildParams = {
        repositoryId,
        vcsProvider: 'bitbucket',
        owner: workspace,
        repo: repoSlug,
        workspace,
        installationId: null,
        mode,
        ...(mode === 'incremental'
          ? { baseSha: change.old!.target.hash, headSha: change.new.target.hash }
          : {}),
        workflowInstanceId,
        continuation: 0,
      };
      try {
        await c.env.INDEX_WORKFLOW.create({ id: workflowInstanceId, params });
        startedMode ??= mode;
      } catch (error) {
        if (error instanceof Error && error.message.includes('instance.already_exists')) {
          // Benign coalesced duplicate — the same disposition the queue consumer gives this
          // rejection. A second actionable change for the same branch lands here too.
          coalesced = true;
          logger.info('Codebase index refresh coalesced: workflow instance already exists', {
            workspace,
            repo: repoSlug,
            eventKind: xEventKey,
            repositoryId,
            reason: 'instance_already_exists',
          });
        } else {
          throw error;
        }
      }
    }

    if (startedMode !== null) {
      logger.info('Bitbucket repo:push triggered a codebase index refresh', {
        workspace,
        repo: repoSlug,
        eventKind: xEventKey,
        mode: startedMode,
        repositoryId,
      });
      return c.json(
        startedMode === 'full'
          ? { ok: true, refreshed: true, mode: startedMode, reason: 'branch_created_full_rebuild' }
          : { ok: true, refreshed: true, mode: startedMode },
        202,
      );
    }
    if (coalesced) {
      return c.json({ ok: true, coalesced: true, reason: 'instance_already_exists' }, 202);
    }
    return c.json({ ok: true, ignored: true, reason: firstIgnoreReason ?? 'no_actionable_change' }, 202);
  }

  // Step 13: construct the ReviewRequest-shaped value carrying the Bitbucket identity.
  // REV-M-7: baseSha tolerates empty string (the Bitbucket route may receive a missing
  // destination.commit.hash from the parsed projection).
  const reviewRequest = {
    installationId: '',
    owner: workspace,
    repo: repoSlug,
    prNumber,
    prTitle: parsed.data.pullrequest.title,
    prAuthor: (typeof parsedBody === 'object' && parsedBody !== null && 'actor' in parsedBody && typeof (parsedBody as { actor?: unknown }).actor === 'object' && (parsedBody as { actor?: { username?: string } }).actor?.username) || null,
    commitSha: incomingCommitSha,
    baseSha: parsed.data.pullrequest.destination.commit.hash ?? '',
    headRef: parsed.data.pullrequest.source.branch.name,
    baseRef: parsed.data.pullrequest.destination.branch.name,
    trigger: 'auto' as const,
    // Bitbucket identity — Task 3 widening:
    repositoryVcsProvider: 'bitbucket' as const,
    repositoryWorkspace: workspace,
  };

  // Step 14: hand off to the provider-aware ingest helper (05-04 widening closes the
  // Phase-3 deferred item — reviewRequest.repositoryVcsProvider + input.provider both
  // resolve through effectiveProvider = 'bitbucket'). prBody = pullrequest.description feeds the
  // commands-gated CMD-06 ignore gate on AUTO events too (REVIEW: Codex 11-06/11-07), so a leading
  // `<mention> ignore` directive in the PR description short-circuits an auto review when commands
  // are enabled. configSnapshot was resolved once above (relocated step 13b).
  const autoPrDescription = (parsed.data.pullrequest as { description?: unknown }).description;
  const result = await ingestReviewWebhookEvent(c.env, {
    reviewRequest,
    configSnapshot,
    deliveryId: xRequestUUID,
    requestId: c.get('requestId'),
    eventName: xEventKey,
    provider: 'bitbucket',
    prBody: typeof autoPrDescription === 'string' ? autoPrDescription : undefined,
  });

  // Step 15: D-17 response shapes. Each variant is mutually exclusive.
  if (result.outcome === 'queued') {
    return c.json({
      ok: true,
      eventName: xEventKey,
      reviewed: true,
    }, 200);
  }
  if (result.outcome === 'duplicate') {
    return c.json({
      ok: true,
      eventName: xEventKey,
      duplicate: true,
      message: 'queued',
    }, 202);
  }
  // queued_event
  return c.json({
    ok: true,
    eventName: xEventKey,
    queued_event: true,
  }, 202);
}

export function createBitbucketWebhookRouter() {
  const app = new Hono<AppEnv>();
  app.post('/', handleBitbucketWebhook);
  return app;
}

// JSON.parse wrapper that returns `undefined` instead of throwing — the identity parse
// is the first guard and we want to map a parse failure to a 400, not crash the route.
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}