import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';
import type { VcsProvider } from '@server/vcs/types';
import type { RepoConfig } from '@shared/schema';
import { getBotIdentity, type BotIdentityResolver } from '@server/core/bot-identity';
import { markPrPaused, markPrResumed, type PrReviewStateKey } from '@server/db/pr-review-state';
import { insertRejectFeedback, findReviewCommentByCoordinate } from '@server/db/reject-feedback';

/**
 * Phase 11 Plan 03 — core/commands.ts: the webhook-layer command parser + dispatcher that is the
 * heart of Phase 11 (CMD-01..05, CMD-07, CMD-08). Provider-agnostic (D-03): one module serves both
 * GitHub and Bitbucket.
 *
 * `classifyComment` is the load-bearing echo-loop defense (D-03): line one resolves the bot's OWN
 * immutable accountId and self-filters the bot's own comments BEFORE any command/Q&A parse — the
 * summary footer embeds `@codra-app review`, so without this the bot would re-trigger itself forever
 * (T-11-03-1). It then parses a minimal, injection-safe `@mention`-PREFIX grammar into the D-02
 * command set, or falls through to Q&A (Plan 04) when a mention is not a recognized complete command.
 *
 * `classifyComment` returns an EXCLUSIVE, feature-aware result: every non-command / non-qa outcome is
 * an explicit `kind='ignored'` with a `reason`. A caller (Plan 06 webhook-ingest) maps every
 * `ignored` reason to an ignored ingest outcome — an `ignored` result can NEVER fall through to any
 * legacy `issue_comment`→review resolution (REVIEW: Codex 11-03/11-06 HIGH, T-11-03-6).
 */

export type CommandName = 'review' | 'review-rest' | 'pause' | 'resume' | 'help' | 'reject';

/**
 * The untrusted comment + its immutable author id, flattened from the provider webhook by Plan 06.
 *
 * - `authorId` is the IMMUTABLE provider id (GitHub numeric user id as a string / Bitbucket
 *   `account_id`) — the ONLY value the self-filter and authorization key on (NREG-02).
 * - `authorLogin` is the renameable @mention handle, used ONLY to form a GitHub permission URL.
 * - `workspace` is the canonical per-provider pause-key workspace (GitHub owner/login, Bitbucket
 *   workspace slug), matching the `pr_review_state`/`reject_feedback` NOT NULL workspace column.
 * - `commentRef` is this comment's opaque provider ref — used as `reject_feedback.source_comment_ref`
 *   for replay idempotency.
 * - `parentRef` / `findingRef` are the reply-thread parent (Bitbucket `comment.parent.id`, GitHub
 *   `pull_request_review_comment.in_reply_to_id`) resolved to the finding the reject dismisses.
 * - `threadable` is the webhook-set capability flag (Phase 12, D-01): whether the ORIGINATING comment
 *   can be threaded under. GitHub inline review comment → true; GitHub `issue_comment` (top-level) →
 *   false; Bitbucket → true (both general + inline thread via `parent:{id}`). Set by the webhook
 *   builders in Plan 03. When `threadable && commentRef`, `executeCommand`'s help reply threads via
 *   `provider.replyToPrComment(...)`; otherwise it falls back to top-level `createPrComment` (the
 *   GitHub issue-comment asymmetry). Absent (undefined) ⇒ top-level, byte-identical to today (NREG-01).
 */
export type CommentContext = {
  authorId: string;
  authorLogin?: string;
  body: string;
  prNumber: number;
  commentRef?: string;
  parentRef?: string;
  findingRef?: string;
  owner: string;
  repo: string;
  workspace: string;
  threadable?: boolean;
};

/**
 * Exclusive classification result. `ignored` replaces the ambiguous `kind='none'` with an explicit
 * reason so Plan 06 never routes a self-filtered / unresolved / non-mention / feature-off comment
 * into legacy resolution (REVIEW: Codex 11-03/11-06 HIGH).
 */
export type ClassifiedComment =
  | { kind: 'command'; name: CommandName; args: string; findingRef?: string }
  | { kind: 'qa'; question: string }
  | { kind: 'ignored'; reason: 'self_filtered' | 'identity_unresolved' | 'not_mention' | 'feature_disabled' };

/**
 * Command variant of `ClassifiedComment` — the input to `executeCommand`.
 */
export type ClassifiedCommand = Extract<ClassifiedComment, { kind: 'command' }>;

/**
 * D-02 alias table for commands that take NO argument. The ENTIRE normalized remainder (after
 * mention, whitespace-collapsed, trailing-punctuation-stripped, lowercased) must EXACTLY equal one of
 * these keys — a partial-alias-plus-extra ('review this code?') is NOT a command, it is Q&A
 * (REVIEW: Codex/OpenCode 11-03 MED — require a complete normalized command).
 */
const NO_ARG_ALIASES: Readonly<Record<string, CommandName>> = {
  review: 'review',
  'review this': 'review',
  'review this pr': 'review',
  'review rest': 'review-rest',
  rest: 'review-rest',
  continue: 'review-rest',
  pause: 'pause',
  resume: 'resume',
  '?': 'help',
  commands: 'help',
  help: 'help',
};

/**
 * D-02/D-09 alias table for commands that DO take a trailing argument: only the FIRST token must
 * match. `reject`/`dismiss` are invoked as `@mention reject [reason]` in a reply thread; the reason
 * is captured from the FULL reply body (ctx.body) at execute time, not from these parsed args.
 */
const ARG_COMMAND_ALIASES: Readonly<Record<string, CommandName>> = {
  reject: 'reject',
  dismiss: 'reject',
};

// Trailing punctuation we tolerate on an otherwise-complete alias (CMD-03 encoding edge). Applied to
// the WHOLE remainder for no-arg aliases and to the first token for arg-commands.
const TRAILING_PUNCT = /[?.!,;:]+$/;

function stripTrailingPunct(s: string): string {
  return s.replace(TRAILING_PUNCT, '');
}

// Mirrors the `src/shared/schema.ts` `mention_trigger` default. Kept local because the schema default
// is not exported; used only to decide whether a configured trigger is a CUSTOM override worth
// advertising verbatim in the help text (a still-at-default trigger yields to the real bot handle).
const DEFAULT_MENTION_TRIGGER = '@codra-app';

/**
 * Classify an untrusted comment. Self-filter FIRST (D-03), then feature-gate, then prefix-mention,
 * then a bounded alias match. No `eval`, no regex over untrusted content beyond a bounded token
 * match; the mention is compared with `String.startsWith` (never a constructed RegExp), so a custom
 * `mention_trigger` cannot inject regex behavior (T-11-03-4 / T-rah-01).
 *
 * The mention prefix is accepted from TWO sources: the configured `config.review.mention_trigger`
 * AND this deployment's real bot handle (`'@' + env.BOT_USERNAME`). This makes bot-mention commands
 * work out-of-the-box on any deployment whose handle differs from the `@codra-app` default, without
 * touching the schema default. A `mention_trigger === false` opt-out is ABSOLUTE: the guard returns
 * before the bot-handle candidate is built, so the fallback can never re-enable disabled mentions
 * (T-rah-02).
 *
 * `provider` + `resolver` are constructed by Plan 06 (VcsService.forProvider + the Plan 02 bot
 * identity resolver factory). `resolver` may be `undefined` when identity cannot be resolved — that
 * yields a null accountId and an `identity_unresolved` outcome (the defense cannot be guaranteed, so
 * classification must not proceed).
 */
export async function classifyComment(
  env: Pick<AppBindings, 'APP_KV' | 'BOT_USERNAME'>,
  provider: VcsProvider,
  resolver: BotIdentityResolver | undefined,
  ctx: CommentContext,
  config: RepoConfig,
): Promise<ClassifiedComment> {
  // ── Line one: self-filter on the resolved NON-NULL immutable accountId (D-03, echo-loop defense).
  const scope = provider.name === 'bitbucket' ? { workspace: ctx.workspace, repo: ctx.repo } : undefined;
  const identity = await getBotIdentity(env, provider.name, resolver, scope);
  if (!identity.accountId) {
    // Cannot guarantee the self-filter without a non-null immutable id — do NOT parse (NREG-02).
    return { kind: 'ignored', reason: 'identity_unresolved' };
  }
  if (ctx.authorId === identity.accountId) {
    return { kind: 'ignored', reason: 'self_filtered' };
  }

  // ── Feature gate: if neither interactive capability is on, this comment is inert.
  const commandsEnabled = config.review.interactive.commands.enabled;
  const qaEnabled = config.review.interactive.qa.enabled;
  if (!commandsEnabled && !qaEnabled) {
    return { kind: 'ignored', reason: 'feature_disabled' };
  }

  // ── Mention must be a PREFIX (D-01), anchored after optional leading whitespace — NOT body.includes.
  const mentionTrigger = config.review.mention_trigger;
  if (typeof mentionTrigger !== 'string') {
    // mention_trigger === false: mention-triggered commands are disabled. This guard runs BEFORE the
    // bot-handle candidate is built, so the fallback can NEVER re-enable a deliberately disabled
    // trigger (T-rah-02).
    return { kind: 'ignored', reason: 'not_mention' };
  }
  const leading = ctx.body.replace(/^\s+/, '');
  // Accept EITHER the configured mention_trigger OR this deployment's real bot handle
  // ('@' + env.BOT_USERNAME). The bot-handle candidate is appended ONLY when BOT_USERNAME is a
  // non-empty string (an empty handle must NOT produce a bare '@' that matches everything — T-rah-04)
  // AND it differs from the trigger (avoid a duplicate). Matched with String.startsWith ONLY — no
  // RegExp is constructed from either candidate, so a regex-special handle/trigger (e.g. '@my-bot.v2')
  // cannot inject regex behavior (T-rah-01). The /^\s/ boundary test below is a fixed literal.
  const mentionCandidates = [mentionTrigger];
  if (typeof env.BOT_USERNAME === 'string' && env.BOT_USERNAME !== '') {
    const botHandle = '@' + env.BOT_USERNAME;
    if (botHandle !== mentionTrigger) {
      mentionCandidates.push(botHandle);
    }
  }
  let rest: string | null = null;
  for (const token of mentionCandidates) {
    if (!leading.startsWith(token)) {
      continue;
    }
    const after = leading.slice(token.length);
    // Require a boundary after the mention so '@codra-appreview' is NOT a mention.
    if (after !== '' && !/^\s/.test(after)) {
      continue;
    }
    rest = after;
    break;
  }
  if (rest === null) {
    return { kind: 'ignored', reason: 'not_mention' };
  }
  const remainder = rest.trim().replace(/\s+/g, ' ');
  if (remainder === '') {
    return { kind: 'ignored', reason: 'not_mention' };
  }

  // ── Command parse (only when the commands capability is enabled).
  if (commandsEnabled) {
    const command = matchCommand(remainder, ctx);
    if (command) {
      return command;
    }
  }

  // ── Fall through: a mention that is not a recognized complete command is Q&A when enabled (D-04).
  if (qaEnabled) {
    return { kind: 'qa', question: remainder };
  }
  return { kind: 'ignored', reason: 'feature_disabled' };
}

/**
 * Match the post-mention remainder against the D-02 alias tables. Returns a command result or null
 * (null => fall through to Q&A). `remainder` is whitespace-collapsed, original-case.
 */
function matchCommand(remainder: string, ctx: CommentContext): ClassifiedCommand | null {
  const lower = remainder.toLowerCase();

  // No-arg aliases: the WHOLE normalized remainder must equal an alias (check the exact form first so
  // the bare '?' help alias is not stripped to empty, then the trailing-punctuation-tolerant form).
  const noArg = NO_ARG_ALIASES[lower] ?? NO_ARG_ALIASES[stripTrailingPunct(lower)];
  if (noArg) {
    return { kind: 'command', name: noArg, args: '' };
  }

  // Arg-commands (reject/dismiss): only the FIRST token must match; the rest is the arg remainder.
  const firstSpace = lower.indexOf(' ');
  const firstToken = stripTrailingPunct(firstSpace === -1 ? lower : lower.slice(0, firstSpace));
  const argCommand = ARG_COMMAND_ALIASES[firstToken];
  if (argCommand === 'reject') {
    const args = firstSpace === -1 ? '' : remainder.slice(firstSpace + 1).trim();
    // Reply-thread refs (findingRef/parentRef) win; a top-level single-token ref is a documented
    // fallback (D-09). A multi-word remainder is a reason, never a ref, so no findingRef is inferred.
    const fallbackRef = args && !args.includes(' ') ? args : undefined;
    const findingRef = ctx.findingRef ?? ctx.parentRef ?? fallbackRef;
    return { kind: 'command', name: 'reject', args, findingRef };
  }

  return null;
}

/**
 * Authorize a state-changing command (review / review-rest / pause / resume / reject) to a
 * write-access member (CMD-08, D-06/D-07, REVIEW: A1 redesign). Fail-CLOSED: only a resolved
 * 'admin'/'write' (or Bitbucket allow-list membership) authorizes; every other outcome
 * (read/none/null/not-listed) is unauthorized and the caller SILENTLY ignores (no reply).
 *
 * - GitHub: `getUserRepoPermission(owner, repo, authorId, authorLogin)` — decided on the immutable
 *   `authorId` (the adapter re-verifies the login→id), NEVER on the login alone.
 * - Bitbucket: the AUTHORITATIVE gate is the deterministic per-repo `account_id` allow-list
 *   (`config.review.interactive.commands.bitbucket_allowed_account_ids`). A live permission read is a
 *   best-effort SECONDARY only; workspace membership is NEVER mapped to write (A1). A null read means
 *   "defer to the allow-list", so a not-listed actor with a null/none read is unauthorized.
 */
export async function authorizeActor(
  _env: AppBindings,
  provider: VcsProvider,
  owner: string,
  repo: string,
  authorId: string,
  authorLogin: string | undefined,
  config: RepoConfig,
): Promise<boolean> {
  void _env;
  if (provider.name === 'bitbucket') {
    // Allow-list is primary + authoritative (A1).
    const allowList = config.review.interactive.commands.bitbucket_allowed_account_ids ?? [];
    if (allowList.includes(authorId)) {
      return true;
    }
    // Best-effort secondary: a live 'admin'/'write' read (never membership). null/none => unauthorized.
    const perm = await provider.getUserRepoPermission(owner, repo, authorId, authorLogin);
    return perm === 'admin' || perm === 'write';
  }

  // GitHub: id-verified permission read.
  const perm = await provider.getUserRepoPermission(owner, repo, authorId, authorLogin);
  return perm === 'admin' || perm === 'write';
}

/**
 * The pause-state key for a PR under the effective provider. `workspace` is the canonical non-null
 * value the `pr_review_state` table expects (GitHub owner/login, Bitbucket workspace slug), carried
 * on `ctx.workspace`.
 */
function pauseKey(provider: VcsProvider, ctx: CommentContext): PrReviewStateKey {
  return {
    vcsProvider: provider.name,
    workspace: ctx.workspace,
    repoSlug: ctx.repo,
    prNumber: ctx.prNumber,
  };
}

/**
 * The help message: the FULL D-02 command set in a STABLE deterministic order, documenting `reject`
 * as `@mention reject [reason]` replied under an inline finding (identical on both providers). The
 * advertised mention token is the handle that actually TRIGGERS: a custom (non-default) string
 * `mention_trigger` is advertised verbatim; otherwise the real bot handle (`'@' + botUsername`) is
 * used so the help never advertises the `@codra-app` default on a deployment whose handle differs
 * (falling back to the default only when `botUsername` is empty). Byte-identical regardless of which
 * help alias (`help` / `?` / `commands`) triggered it (CMD-04).
 */
export function buildHelpText(config: RepoConfig, botUsername: string): string {
  const configured = config.review.mention_trigger;
  const mention =
    typeof configured === 'string' && configured !== DEFAULT_MENTION_TRIGGER
      ? configured
      : botUsername
        ? '@' + botUsername
        : DEFAULT_MENTION_TRIGGER;
  return [
    'Codra commands — reply with the mention prefix at the start of your comment:',
    '',
    `- \`${mention} review\` — review this PR (aliases: \`review this\`, \`review this pr\`)`,
    `- \`${mention} review rest\` — review the files skipped by the last review (aliases: \`rest\`, \`continue\`)`,
    `- \`${mention} pause\` — pause automatic reviews on this PR`,
    `- \`${mention} resume\` — resume automatic reviews on this PR`,
    `- \`${mention} help\` — show this message (aliases: \`?\`, \`commands\`)`,
    `- \`${mention} reject [reason]\` — reply under an inline finding to dismiss it as a false positive`,
  ].join('\n');
}

/**
 * Execute a non-Workflow command (pause / resume / help / reject). `review` / `review-rest` are NOT
 * executed here — they enqueue a review job via the existing path (wired in Plan 06), so this is a
 * no-op for them.
 *
 * Effects are scoped to exactly D-03/D-08/D-09/D-11:
 * - pause/resume/reject are gated by `authorizeActor`; an unauthorized actor gets NO reply and NO DB
 *   write (D-07 silent ignore) — not even a "not allowed" message that confirms the bot is present.
 * - resume clears the pause flag only (UPDATE-only, NO retro-trigger enqueue, D-08).
 * - help posts the full command list with NO authorization (read-only discovery, D-11).
 * - reject is capture-only: `insertRejectFeedback` with `reason = ctx.body` (the FULL reply body,
 *   never the parsed args) and `sourceCommentRef = ctx.commentRef` for idempotency; a missing
 *   findingRef OR commentRef is a capture-skip (the accessor returns null), never an error (D-09).
 */
export async function executeCommand(
  env: AppBindings,
  provider: VcsProvider,
  cmd: ClassifiedCommand,
  ctx: CommentContext,
  config: RepoConfig,
): Promise<void> {
  switch (cmd.name) {
    case 'review':
    case 'review-rest':
      // Enqueued via the existing review path in Plan 06; nothing to execute here.
      return;

    case 'help': {
      // Read-only discovery — no authorization (D-11). Caller-decides threading (D-01): when the
      // webhook flagged the originating comment threadable AND we carry its opaque ref, thread the
      // help reply under it via replyToPrComment; otherwise post top-level via createPrComment (the
      // GitHub issue-comment asymmetry — issue comments are not threadable). Ref-absent / flag-off is
      // byte-identical top-level posting (NREG-01).
      const body = buildHelpText(config, env.BOT_USERNAME);
      if (ctx.threadable && ctx.commentRef) {
        await provider.replyToPrComment(ctx.owner, ctx.repo, ctx.prNumber, body, ctx.commentRef);
      } else {
        await provider.createPrComment(ctx.owner, ctx.repo, ctx.prNumber, body);
      }
      return;
    }

    case 'pause': {
      if (!(await authorizeActor(env, provider, ctx.owner, ctx.repo, ctx.authorId, ctx.authorLogin, config))) {
        return; // D-07 silent ignore.
      }
      await markPrPaused(env, pauseKey(provider, ctx), ctx.authorId);
      return;
    }

    case 'resume': {
      if (!(await authorizeActor(env, provider, ctx.owner, ctx.repo, ctx.authorId, ctx.authorLogin, config))) {
        return; // D-07 silent ignore.
      }
      // D-08: clear the pause flag only — NEVER retro-trigger a review.
      await markPrResumed(env, pauseKey(provider, ctx), ctx.authorId);
      return;
    }

    case 'reject': {
      if (!(await authorizeActor(env, provider, ctx.owner, ctx.repo, ctx.authorId, ctx.authorLogin, config))) {
        return; // D-07 silent ignore.
      }

      // Phase 28 (LRN-01): resolve finding metadata from the provider API + review_comments join
      // at reject time. Best-effort — a failure to resolve metadata must NEVER fail the reject
      // command (same posture as the rest of the reject handler). All 4 fields are nullable;
      // NULLs mean the rejection is excluded from clustering (D-02).
      let findingTitle: string | null = null;
      let findingCategory: string | null = null;
      let findingFilePath: string | null = null;
      let findingSeverity: string | null = null;

      try {
        if (cmd.findingRef) {
          const commentDetails = await provider.getInlineCommentDetails(ctx.owner, ctx.repo, ctx.prNumber, cmd.findingRef);
          // A non-empty path is enough to record findingFilePath — it needs no coordinate match.
          // (A file path with a null category still cannot cluster per D-02, so this is strictly
          // more information at no risk.) Both coordinates are forwarded; the lookup selects the
          // one its provider actually anchors by (GitHub -> position, Bitbucket -> line; G-28-3).
          if (commentDetails && commentDetails.path) {
            findingFilePath = commentDetails.path;
            const reviewComment = await findReviewCommentByCoordinate(env, {
              workspace: ctx.workspace,
              repoSlug: ctx.repo,
              vcsProvider: provider.name,
              prNumber: ctx.prNumber,
              path: commentDetails.path,
              line: commentDetails.line,
              position: commentDetails.position,
              // In-memory tiebreak only when two findings share one coordinate — never persisted,
              // never logged, never bound into SQL.
              commentBody: commentDetails.body,
            });
            if (reviewComment) {
              findingTitle = reviewComment.title;
              findingCategory = reviewComment.category;
              findingSeverity = reviewComment.severity;
            }
          }
        }
      } catch (error) {
        // Best-effort: metadata resolution failure must NOT fail the reject command.
        logger.warn('Failed to resolve finding metadata for reject feedback', error);
      }

      // Capture-only (D-09). reason is the FULL reply body, never the parsed args. A missing
      // findingRef / commentRef is a capture-skip inside insertRejectFeedback (returns null).
      await insertRejectFeedback(env, {
        vcsProvider: provider.name,
        workspace: ctx.workspace,
        repoSlug: ctx.repo,
        prNumber: ctx.prNumber,
        findingRef: cmd.findingRef ?? '',
        reason: ctx.body,
        rejectedBy: ctx.authorId,
        sourceCommentRef: ctx.commentRef ?? '',
        findingTitle,
        findingCategory,
        findingFilePath,
        findingSeverity,
      });
      return;
    }
  }
}
