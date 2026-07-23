import type {
  PrReviewStateRow,
} from '@server/db/pr-review-state';
import type { VcsReviewThread } from '@server/vcs/types';
import type {
  JobAuditEvent,
  ParsedReviewComment,
  RepoConfig,
  ReviewMode,
  ReviewSeverity,
} from '@shared/schema';
import { SEVERITY_RANK } from './dedup';

/**
 * Phase 18 (RND-01 / RND-02 / RND-03 / RND-04 / RND-05) round / anchor helpers. EVERY function in
 * this module is PURE -- no I/O, no time-source, no logger. The callers (Plan 02's runPreparePhase,
 * Plan 03's finalize-time floor composition, Plan 04's open-thread suppression) own all I/O and
 * pass plain data into these helpers. Mirrors the `core/noise-filter.ts` "single pure function
 * pipeline" pattern (Phase 14 D-09).
 *
 * Centralizing the helpers in their own module keeps `core/review.ts` from gaining another
 * ~600 lines and lets the round / anchor decisions be tested in isolation (test/rounds.spec.ts,
 * pure -- no DB).
 */

// ───────────────────────────────────────────────────────────────────────────────────────
// D-01/D-02 round resolver (RND-01).
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Inputs to `resolveRoundContext`. Every field is OPTIONAL because the resolution paths diverge:
 *   - review-rest / head-scope: no anchor, no threads, force round 1 / rest (D-03).
 *   - no prior anchor + no threads (a fresh PR): round 1 (full-diff review).
 *   - prior anchor only: round = last_review_round + 1 (D-06).
 *   - unresolved threads only (D-04): round 2 (fallback to full diff).
 *   - prior anchor + threads: round = last_review_round + 1 (anchor wins over threads when both
 *     are present, because the anchor-derived round is already strictly greater than round 1).
 */
export type ResolveRoundInputs = {
  /** Whether the current job's reviewScope is 'rest' (review-rest command, force round 1 / rest). */
  reviewScope?: 'all' | 'rest' | 'head' | null;
  /** The PR's durable last_reviewed_sha / last_review_round row, or null for a never-reviewed PR. */
  priorState: Pick<PrReviewStateRow, 'last_reviewed_sha' | 'last_review_round'> | null;
  /** Unresolved bot threads for the PR (provider-neutral `VcsReviewThread[]`). */
  unresolvedThreads: ReadonlyArray<VcsReviewThread>;
  /** Durable `rounds.incremental` snapshot from the config at prepare time. */
  roundsIncremental: boolean;
};

/**
 * The resolved round context. `round` is the integer counter (>= 1), `mode` is the diff source
 * ('full' | 'incremental' | 'fallback' | 'no_changes' | 'rest'), and the boolean flags capture
 * the two resolution signals (prior anchor / unresolved threads) so the producer can emit a
 * `rounds.detected` audit event that explains WHY this round was chosen.
 */
export type ResolvedRoundContext = {
  round: number;
  mode: ReviewMode;
  roundsIncremental: boolean;
  anchorSha: string | null;
  hasUnresolvedThreads: boolean;
};

/**
 * Pure round resolver (RND-01 / D-01..D-06). Decision tree:
 *
 *   review-rest (reviewScope === 'rest'):
 *     -> round 1, mode 'rest'. The lock D-03: review-rest is the manual escape hatch, always
 *     round 1, NEVER participates in round detection.
 *
 *   prior anchor exists (last_reviewed_sha IS NOT NULL):
 *     -> round = last_review_round + 1 (D-06: round counter advances on every push; the increment
 *        is monotonic against the prior round). Mode depends on the rounds-incremental flag:
 *          - roundsIncremental && prior anchor => 'incremental' (review against the compare-diff seam)
 *          - otherwise                       => 'fallback' (review against the full-diff seam)
 *     threads don't override the anchor-derived round (anchor-derived round >= 2, and the OR
 *     detection in D-01 still trips when an anchor exists because the round is already >= 2).
 *
 *   no prior anchor + unresolved threads (D-04):
 *     -> round 2, mode 'fallback' (no anchor to diff against; full-diff fallback runs).
 *
 *   no prior anchor + no threads:
 *     -> round 1, mode 'full'.
 */
export function resolveRoundContext(input: ResolveRoundInputs): ResolvedRoundContext {
  const anchorSha = input.priorState?.last_reviewed_sha ?? null;
  const priorRound = input.priorState?.last_review_round ?? null;
  const hasUnresolvedThreads = input.unresolvedThreads.length > 0;

  // D-03: review-rest short-circuits to round 1 / mode 'rest'. No state/thread calls, no
  // resolution. The review-rest command is the manual escape hatch and is NEVER subject to round
  // detection (it would defeat the purpose of being an escape hatch).
  if (input.reviewScope === 'rest') {
    return {
      round: 1,
      mode: 'rest',
      roundsIncremental: input.roundsIncremental,
      anchorSha: null,
      hasUnresolvedThreads: false,
    };
  }

  // Anchor-present path (D-06): round advances monotonically from the prior round. threads don't
  // override because the OR composition already resolved (anchor present => round >= 2). The mode
  // is incremental ONLY when rounds.incremental is true; otherwise the conservative fallback runs.
  if (anchorSha && priorRound && priorRound >= 1) {
    const nextRound = priorRound + 1;
    return {
      round: nextRound,
      mode: input.roundsIncremental ? 'incremental' : 'fallback',
      roundsIncremental: input.roundsIncremental,
      anchorSha,
      hasUnresolvedThreads,
    };
  }

  // Thread-only path (D-04): no anchor to diff against -> fall back to full diff. Round is 2
  // because the OR composition (prior anchor OR unresolved threads) tripped.
  if (hasUnresolvedThreads) {
    return {
      round: 2,
      mode: 'fallback',
      roundsIncremental: input.roundsIncremental,
      anchorSha: null,
      hasUnresolvedThreads: true,
    };
  }

  // No signal: round 1, full-diff review (today's behavior).
  return {
    round: 1,
    mode: 'full',
    roundsIncremental: input.roundsIncremental,
    anchorSha: null,
    hasUnresolvedThreads: false,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// D-09/D-10/D-11/D-12 floor composer (RND-03).
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Pure round-escalated floor composer (RND-03). Returns the EFFECTIVE options that should be
 * passed into BOTH `applyNoiseFilter` calls in `runFinalizePhase` (Plan 03's caller). The chain
 * itself is unchanged (Phase 14 D-09); the floor config is adjusted per-composition:
 *
 *   - round 2  -> confidence 0.80, severity P2.
 *   - round 3+ -> confidence 0.85, severity P2 (D-10: severity stays at P2, no escalation past P2).
 *   - user-set always wins (D-11): max(round, global, category_confidence). The filter chain's
 *     existing per-category max(global, category_confidence) composition stays intact; the
 *     round-escalated global is the new starting minimum that category overrides can ratchet up.
 *
 *   - `rounds.escalate_floors: false` disables the round escalation (D-12): the floor config is
 *     returned unchanged. Round detection still runs (counter + audit) but the floors are NOT
 *     raised.
 */
export type ComposeRoundFloorsOptions = {
  reviewRound: number;
  reviewMode?: ReviewMode;
  roundsIncremental?: boolean;
  base: { minConfidence: number; minSeverity: ReviewSeverity; categoryConfidence: Partial<Record<ParsedReviewComment['category'], number>> };
  escalateFloors: boolean;
};

export type ComposedFloors = {
  minConfidence: number;
  minSeverity: ReviewSeverity;
  categoryConfidence: Partial<Record<ParsedReviewComment['category'], number>>;
  /** True iff the round floor would have changed the global floor (audit-only signal). */
  effectiveChanged: boolean;
  /** The round's own floor (0 for round 1) -- audit-only context. */
  roundFloor: { minConfidence: number; minSeverity: ReviewSeverity };
};

export function composeRoundFloors(opts: ComposeRoundFloorsOptions): ComposedFloors {
  const modeEligible = (opts.reviewMode ?? 'incremental') === 'incremental' || opts.reviewMode === 'fallback';
  const escalationEligible =
    (opts.roundsIncremental ?? true) && modeEligible && opts.escalateFloors && opts.reviewRound >= 2;

  // D-09/D-12: only durable incremental round consumers can raise floors. Full, rest, and
  // no_changes modes stay byte-identical even if their persisted round number is 2+.
  if (!escalationEligible) {
    return {
      minConfidence: opts.base.minConfidence,
      minSeverity: opts.base.minSeverity,
      categoryConfidence: opts.base.categoryConfidence,
      effectiveChanged: false,
      roundFloor: { minConfidence: 0, minSeverity: opts.base.minSeverity },
    };
  }

  // D-10: round 3+ confidence 0.85, round 2 confidence 0.80; severity stays P2 for all round 2+.
  const roundConfidence = opts.reviewRound >= 3 ? 0.85 : 0.80;
  const roundSeverity: ReviewSeverity = 'P2';
  const newGlobalConfidence = Math.max(opts.base.minConfidence, roundConfidence);
  // D-11: severity floor is max(round, user_set) -- tighter of P2 or the user's setting. We use
  // severity RANK (P0=0 < P1=1 < P2=2 < P3=3 < nit=4) so a stricter user-set P1 floors to P1, never
  // loosened by the round's P2.
  const baseRank = SEVERITY_RANK[opts.base.minSeverity] ?? SEVERITY_RANK.nit;
  const roundRank = SEVERITY_RANK[roundSeverity];
  const effectiveSeverity: ReviewSeverity = baseRank <= roundRank ? opts.base.minSeverity : roundSeverity;
  const effectiveChanged = newGlobalConfidence !== opts.base.minConfidence || effectiveSeverity !== opts.base.minSeverity;

  return {
    minConfidence: newGlobalConfidence,
    minSeverity: effectiveSeverity,
    categoryConfidence: opts.base.categoryConfidence,
    effectiveChanged,
    roundFloor: { minConfidence: roundConfidence, minSeverity: roundSeverity },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// D-08 / D-09 RND-04 thread-overlap helper.
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Pure thread-overlap predicate (RND-04). Mirrors the Phase 17 thread contract:
 *   - `lineStart > 0 && lineEnd >= lineStart`: positive, non-reversed range (defensive guards).
 *   - `!thread.outdated`: outdated threads are ignored (D-08). They DO NOT suppress findings.
 *   - `thread.path === finding.path`: exact path match.
 *   - `finding.line != null`: a finding with no line has no current anchor -- keep it.
 *
 * A Codra finding carries a SINGLE `line` (no range); we test it as a point inside the thread's
 * inclusive range [lineStart, lineEnd]. This is the locked D-08 semantic that honors the
 * provider's ranged thread shape without inventing a multi-line finding shape.
 */
export function overlapsOpenThread(
  finding: Pick<ParsedReviewComment, 'path' | 'line'>,
  thread: VcsReviewThread,
): boolean {
  if (finding.line == null) return false;
  if (thread.lineStart <= 0) return false;
  if (thread.lineEnd < thread.lineStart) return false;
  if (thread.outdated) return false;
  if (thread.path !== finding.path) return false;
  return finding.line >= thread.lineStart && finding.line <= thread.lineEnd;
}

/**
 * Filter a finding list to suppress findings that overlap any non-outdated open thread
 * (RND-04 / D-08). Returns the survivors in original order (stable); suppressed findings are
 * collected as `{ finding, thread }` pairs so the caller can emit `rounds.suppressed` audit
 * events on the POSTING path only (the walkthrough path suppresses the same findings but does
 * NOT emit duplicates -- the D-08 producer rule). Threads themselves are untouched.
 */
export function suppressByOpenThreads<T extends Pick<ParsedReviewComment, 'path' | 'line'>>(
  findings: T[],
  threads: ReadonlyArray<VcsReviewThread>,
): { survivors: T[]; suppressed: Array<{ finding: T; thread: VcsReviewThread }> } {
  const survivors: T[] = [];
  const suppressed: Array<{ finding: T; thread: VcsReviewThread }> = [];
  for (const finding of findings) {
    const thread = threads.find((t) => overlapsOpenThread(finding, t));
    if (thread) {
      suppressed.push({ finding, thread });
    } else {
      survivors.push(finding);
    }
  }
  return { survivors, suppressed };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// Round audit-event builders.
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical `rounds.detected` audit event (RND-01 / D-02). Producer is the prepare-phase
 * resolution block (Plan 02). Carries the EXACT producer fields from the locked schema:
 * `{ mode, round, incremental, anchorSha?, hasUnresolvedThreads?, timestamp }`. Timestamp is set
 * by the bounded best-effort recorder (recordRoundAudit below) so this builder only stamps a
 * timestamp on events missing one (the same defensive pattern as buildFinalizeDropEvents).
 */
export function buildRoundsDetectedEvent(
  ctx: ResolvedRoundContext,
  timestamp: string = new Date().toISOString(),
): JobAuditEvent {
  return {
    stage: 'rounds.detected',
    mode: ctx.mode,
    round: ctx.round,
    incremental: ctx.roundsIncremental,
    anchorSha: ctx.anchorSha ?? null,
    hasUnresolvedThreads: ctx.hasUnresolvedThreads,
    timestamp,
  };
}

/**
 * Build the canonical `rounds.no_changes` event (RND-02 / D-08). Producer is the finalize-time
 * placeholder path. D-08 EXACT fields: `{ from, to, round, incremental: true }`. `from` and `to`
 * are SHA anchors; `incremental` is locked `true` (a no_changes placeholder only fires on the
 * incremental path -- the full-diff fallback to empty is also a no_changes, but the producer
 * passes the SAME `incremental: true` shape so the audit-trail UI labels every no_changes event
 * the same way).
 */
export function buildRoundsNoChangesEvent(
  input: { from: string; to: string; round: number },
  timestamp: string = new Date().toISOString(),
): JobAuditEvent {
  return {
    stage: 'rounds.no_changes',
    from: input.from,
    to: input.to,
    round: input.round,
    incremental: true,
    timestamp,
  };
}

/**
 * Build the canonical `rounds.anchor_skipped` event (D-15). Producer is the finalize-time anchor
 * write when `pr.headSha` is empty / zero-length. `reason` is the locked literal `'empty_head'`;
 * kept as a free-form string so a future skip reason can extend without a breaking schema edit.
 */
export function buildRoundsAnchorSkippedEvent(
  input: { reason: string; round: number | null },
  timestamp: string = new Date().toISOString(),
): JobAuditEvent {
  return {
    stage: 'rounds.anchor_skipped',
    reason: input.reason,
    round: input.round,
    timestamp,
  };
}

/**
 * Build the canonical `rounds.escalated` event (RND-03). Producer is the finalize-time floor
 * composer. Carries `{ from, to, effective, round }` so the audit viewer can show both the round's
 * own floor (from/to) AND the COMPOSED user-visible floor (effective = max(round, global,
 * category_confidence)). NEVER carries raw finding content / diff / existingCode (T-13-03-03).
 */
export function buildRoundsEscalatedEvent(
  input: {
    from: { minConfidence: number; minSeverity: ReviewSeverity };
    to: { minConfidence: number; minSeverity: ReviewSeverity };
    effective: { minConfidence: number; minSeverity: ReviewSeverity };
    round: number;
    /** Absolute drops under the composed floor; not a claimed baseline-vs-round delta. */
    droppedAtEffectiveFloor?: number;
  },
  timestamp: string = new Date().toISOString(),
): JobAuditEvent {
  return {
    stage: 'rounds.escalated',
    from: input.from,
    to: input.to,
    effective: input.effective,
    round: input.round,
    ...(input.droppedAtEffectiveFloor === undefined
      ? {}
      : { droppedAtEffectiveFloor: input.droppedAtEffectiveFloor }),
    timestamp,
  };
}

/**
 * Build a single canonical `rounds.suppressed` event (RND-04). One event per suppressed finding,
 * emitted on the POSTING path only (Plan 04). `path`/`line`/`title` mirror the privacy-bounded
 * identifier shape used by the other audit variants; `threadPath` records the thread's path the
 * finding overlapped (the only thread-shaped fact carried -- NEVER the thread body / ref).
 */
export function buildRoundsSuppressedEvent(
  input: {
    finding: Pick<ParsedReviewComment, 'path' | 'line' | 'title'>;
    threadPath: string;
  },
  timestamp: string = new Date().toISOString(),
): JobAuditEvent {
  return {
    stage: 'rounds.suppressed',
    path: input.finding.path,
    line: input.finding.line ?? null,
    title: input.finding.title.slice(0, 100),
    threadPath: input.threadPath,
    timestamp,
  };
}

/**
 * Convenience: a single `RepoConfig` -> resolveRoundContext input helper. The caller passes
 * `rounds.incremental` from the config snapshot at prepare time (durable) and the live
 * unresolved-thread listing result. Keeps the call site at runPreparePhase terse.
 */
export function buildRoundInputsFromConfig(input: {
  reviewScope?: 'all' | 'rest' | 'head' | null;
  priorState: Pick<PrReviewStateRow, 'last_reviewed_sha' | 'last_review_round'> | null;
  unresolvedThreads: ReadonlyArray<VcsReviewThread>;
  config: Pick<RepoConfig, 'review'>;
}): ResolveRoundInputs {
  return {
    reviewScope: input.reviewScope ?? null,
    priorState: input.priorState,
    unresolvedThreads: input.unresolvedThreads,
    roundsIncremental: Boolean(input.config.review?.rounds?.incremental ?? false),
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// D-04 / D-05 / D-06 / D-07 incremental-diff selection (RND-02).
// ───────────────────────────────────────────────────────────────────────────────────────

import type { FileDiff } from './diff';

/**
 * The immutable selection descriptor for a single prepare run. Persisted on the job row as the
 * durable record of "what diff source did this round select, from which exact bases, anchored to
 * which exact head". A consumer (runReviewPhase / runFinalizePhase) reads the descriptor and:
 *
 *   - `incremental` / `fallback`: re-fetch the SAME compare range (not the full PR diff) and use
 *     whatever raw diff the VCS provider returns. The selection is the durable fact; the cache
 *     is a best-effort accelerator that is NEVER allowed to silently switch the source.
 *   - `no_changes`: finalize the placeholder immediately (no model call, no review post, no
 *     walkthrough edit). The review/finalize phases short-circuit on this descriptor.
 *   - `full` / `rest`: the existing pre-Phase-18 paths — keep today's behavior byte-identically.
 *
 * `fromSha` / `toSha` are the EXACT prepare-time anchors (D-08): finalize never anchors a
 * freshly-fetched live head. When `mode === 'no_changes'`, `fromSha` is the prior anchor and
 * `toSha` is the prepare-time head so the audit `rounds.no_changes` event carries the locked
 * `{ from, to }` shape.
 */
export type DiffSelectionDescriptor =
  | { mode: 'full' }
  | { mode: 'rest' }
  | { mode: 'incremental' | 'fallback'; fromSha: string; toSha: string }
  | { mode: 'no_changes'; fromSha: string; toSha: string };

/**
 * Inputs to `selectDiffForRound`. The caller supplies the resolved round context (D-01) plus
 * the raw compare + full-diff results it has already fetched. The helper is PURE: it never
 * makes a VCS call of its own; the caller does the I/O and passes the strings in. The decision
 * tree (D-04 / D-05 / D-06 / D-07):
 *
 *   - mode === 'full' / 'rest'           -> return as-is (pre-Phase-18 paths, byte-identical).
 *   - mode === 'fallback' (no anchor)    -> compare throws -> fetchFull; if non-empty, return
 *                                            'fallback' with selected head; if empty, return
 *                                            'no_changes' anchored to the prepare head.
 *   - mode === 'incremental' (anchor)    -> compare throws -> fetchFull; if non-empty, return
 *                                            'fallback' with the same (from, to) range; if empty,
 *                                            return 'no_changes' with the same (from, to) range.
 *                                          -> compare returns a NON-empty, parseable diff ->
 *                                            return 'incremental' with the (from, to) range.
 *                                          -> compare returns empty / whitespace / junk ->
 *                                            a LEGITIMATE empty compare (per the Phase 17 D-09
 *                                            contract: a successful '' is a valid "no changes"
 *                                            answer, distinct from an HTTP error). The full diff
 *                                            is NOT consulted (the caller did not fetch it).
 *                                            Return 'no_changes' with the (from, to) range.
 *
 * Crucially (Codex/Antigravity HIGH consensus): a successful empty compare is NOT a fallback
 * signal. Only a thrown compare (true HTTP/parse failure) falls back to the full diff. The full
 * diff is then the final source: empty -> no_changes, non-empty -> fallback.
 *
 * `compareFiles` is the parsed result of the raw compare response after `parseUnifiedDiff`
 * (Antigravity/Codex MEDIUM); a successful compare that parses to ZERO files is a legitimate
 * empty compare, NOT a malformed one. The raw string is kept for the whitespace / junk branch.
 *
 * `compareThrew` is the loader's signal that the full diff was actually fetched as a fallback
 * (default false). When true, the caller has already consulted `fullDiff` / `fullFiles` and the
 * helper uses them. When false, the full diff is NEVER consulted and an empty/junk compare
 * resolves to 'no_changes' — the plan's "no full fetch" guarantee.
 */
export type SelectDiffForRoundInputs = {
  /** The resolved round context (mode + anchors + round). */
  roundContext: Pick<ResolvedRoundContext, 'mode' | 'anchorSha'> & { round: number };
  /** True iff the caller caught an exception from `vcs.getCompareDiff(...)` and fetched the full diff. */
  compareThrew?: boolean;
  /** The raw string returned by `vcs.getCompareDiff(anchor, head)`. Empty string is allowed. */
  compareDiff: string;
  /** The parsed files from `parseUnifiedDiff(compareDiff)`. Zero-length is legitimate. */
  compareFiles: ReadonlyArray<FileDiff>;
  /** The full PR diff returned by `vcs.getPullRequestDiff(...)`. Empty string is allowed. */
  fullDiff: string;
  /** The parsed files from `parseUnifiedDiff(fullDiff)`. Zero-length is the empty-full case. */
  fullFiles: ReadonlyArray<FileDiff>;
  /** The prepare-time head SHA (the one captured BEFORE the review started — D-08 anchored). */
  toSha: string;
};

/**
 * Pure selection helper (RND-02 / D-04..D-07). Returns the immutable selection descriptor the
 * caller persists on the job row. NEVER throws — the thrown-compare path is modelled by the
 * caller passing `compareThrew: true` AND the (caught) full diff as `fullDiff`. The helper
 * classifies into one of the four cases documented on `DiffSelectionDescriptor`.
 */
export function selectDiffForRound(input: SelectDiffForRoundInputs): DiffSelectionDescriptor {
  const { mode, anchorSha } = input.roundContext;
  const compareThrew = input.compareThrew ?? false;

  // Pre-Phase-18 paths: keep today's behavior byte-identically (NREG-01).
  if (mode === 'full') return { mode: 'full' };
  if (mode === 'rest') return { mode: 'rest' };

  // 'fallback' (no anchor) has nothing to compare against — the caller requested the full diff
  // (e.g. `rounds.incremental: false` after a prior anchor, or thread-only D-04). The "compare
  // threw" shape is the caller passing `compareDiff = ''` and `compareFiles = []`; the helper
  // passes the full diff through unchanged.
  if (mode === 'fallback') {
    if (input.fullFiles.length > 0) {
      return { mode: 'fallback', fromSha: anchorSha ?? '', toSha: input.toSha };
    }
    return { mode: 'no_changes', fromSha: anchorSha ?? '', toSha: input.toSha };
  }

  // 'incremental' (anchor + rounds.incremental). The thrown-compare shape passes compareDiff='',
  // compareFiles=[], compareThrew=true. Otherwise we inspect the parsed compare output:
  if (input.compareFiles.length > 0) {
    return {
      mode: 'incremental',
      fromSha: anchorSha ?? '',
      toSha: input.toSha,
    };
  }

  // Empty compare + compare did NOT throw -> a legitimate empty compare per Phase 17 D-09. The
  // full diff was NOT fetched (the plan's "no full fetch" rule). Return no_changes immediately.
  if (!compareThrew) {
    return { mode: 'no_changes', fromSha: anchorSha ?? '', toSha: input.toSha };
  }

  // Compare threw and the caller fetched the full diff. The full diff is now the source:
  // empty -> no_changes, non-empty -> fallback. The (from, to) range is preserved so the
  // finalize phase re-fetches the SAME compare range, never a different live head.
  if (input.fullFiles.length > 0) {
    return { mode: 'fallback', fromSha: anchorSha ?? '', toSha: input.toSha };
  }
  return { mode: 'no_changes', fromSha: anchorSha ?? '', toSha: input.toSha };
}