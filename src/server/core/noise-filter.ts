import type { ParsedReviewComment, ReviewCategory, ReviewSeverity } from '@shared/schema';
import { SEVERITY_RANK, type MergeRecord } from './dedup';

/**
 * FR-180 always-on noise filter (FILT-01 / FILT-02). ONE pure function both finalize paths call
 * (Wave 3 wires it) — no I/O, never throws for any input shape [D-09, SC5].
 *
 * Chain order is FR-180 canonical and MUST run in exactly this sequence [D-10]:
 *   1. per-category effective confidence floor  -> dropped.confidenceFloor
 *   2. severity floor (min_severity)            -> dropped.severityFloor
 *   3. optional pre-cap suppression             -> suppressed
 *   4. sort severity desc, then confidence desc (stable — earlier input wins a full tie)
 *   5. dedup (INJECTED via opts.dedup so this module stays pure; the caller resolves the
 *      composite-vs-legacy selection — D-04)  -> dropped.merges
 *   6. tiered cap: EXEMPT P0/P1/P2 (SEVERITY_RANK <= 2), cap ONLY P3/nit (rank >= 3) [D-13].
 *      So 8 P0 + 5 P2 + 10 nit with cap 3 posts 16 comments — the cap trims the already-sorted
 *      P3+nit sub-list (P3-before-nit, highest-confidence first) to effectiveMaxComments.
 *
 * The optional suppression seam runs after eligibility floors but before dedup/cap. This lets
 * round-thread suppression backfill capped slots without reclassifying confidence/severity drops,
 * while callers that omit it retain the original byte-identical filter behavior.
 *
 * Effective confidence floor = max(global min_confidence, category_confidence[category]) — a category
 * floor only TIGHTENS and never loosens the global (FILT-02, locked). null/absent confidence is
 * ALWAYS kept (fail-open) and never recorded. Each DropRecord records "the values that dropped it" as
 * NON-SENSITIVE metrics only (effectiveFloor + category + confidence for the confidence floor; the
 * finding's severity for severity/cap) alongside the privacy-bounded identifier { path, line, title }
 * — NEVER body/diff/existingCode/codeSuggestion (review findings #2/#4, T-14-02-01).
 */

/**
 * One dropped finding, reduced to the privacy-bounded identifier PLUS the non-sensitive decision
 * metrics that record WHY it dropped (review findings #2/#4). `effectiveFloor`/`category`/`confidence`
 * are set for confidence-floor drops; `severity` is set for every record. NEVER carries raw finding
 * body / diff / existingCode / codeSuggestion.
 */
export type DropRecord = {
  path: string;
  line?: number | null;
  title: string;
  severity: ReviewSeverity;
  category?: ReviewCategory;
  confidence?: number | null;
  effectiveFloor?: number;
};

export type PreCapSuppressionResult = {
  survivors: ParsedReviewComment[];
  suppressed: ParsedReviewComment[];
};

export type NoiseFilterOptions = {
  minConfidence: number;
  categoryConfidence: Partial<Record<ReviewCategory, number>>;
  minSeverity: ReviewSeverity;
  effectiveMaxComments: number;
  // Optional round-thread seam. It receives only floor-eligible findings and must remain pure.
  preCapSuppress?: (comments: ParsedReviewComment[]) => PreCapSuppressionResult;
  // Injected so the filter stays pure and I/O-free; a no-op dedup returns { survivors: input, merges: [] }.
  dedup: (comments: ParsedReviewComment[]) => { survivors: ParsedReviewComment[]; merges: MergeRecord[] };
};

export type NoiseFilterResult = {
  kept: ParsedReviewComment[];
  suppressed: ParsedReviewComment[];
  dropped: {
    confidenceFloor: DropRecord[];
    severityFloor: DropRecord[];
    cap: DropRecord[];
    merges: MergeRecord[];
  };
};

function rankOf(severity: ReviewSeverity): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.nit;
}

export function applyNoiseFilter(comments: ParsedReviewComment[], opts: NoiseFilterOptions): NoiseFilterResult {
  const confidenceFloor: DropRecord[] = [];
  const severityFloor: DropRecord[] = [];
  const cap: DropRecord[] = [];

  // Convert min_severity to a rank ONCE (Nemotron LOW — never compare the enum string directly).
  const minRank = rankOf(opts.minSeverity);

  // Step 1 — effective per-category confidence floor (fail-open on null/undefined).
  const afterConfidence: ParsedReviewComment[] = [];
  for (const c of comments) {
    if (c.confidence == null) {
      afterConfidence.push(c); // fail-open: an omitted confidence is always kept, never recorded.
      continue;
    }
    const categoryFloor = opts.categoryConfidence[c.category] ?? -Infinity;
    const effectiveFloor = Math.max(opts.minConfidence, categoryFloor); // max() -> tighten-only.
    if (c.confidence >= effectiveFloor) {
      afterConfidence.push(c);
    } else {
      confidenceFloor.push({
        path: c.path,
        line: c.line,
        title: c.title,
        severity: c.severity,
        category: c.category,
        confidence: c.confidence,
        effectiveFloor, // review finding #2: the RECORD holds the per-category effective floor.
      });
    }
  }

  // Step 2 — severity floor: keep rank <= minRank; drop the rest into dropped.severityFloor.
  const afterSeverity: ParsedReviewComment[] = [];
  for (const c of afterConfidence) {
    if (rankOf(c.severity) <= minRank) {
      afterSeverity.push(c);
    } else {
      severityFloor.push({ path: c.path, line: c.line, title: c.title, severity: c.severity });
    }
  }

  // Step 3 — optional suppression after eligibility but before dedup/cap. The default preserves the
  // pre-RND-04 chain exactly. Suppressed findings are returned separately from the existing drop
  // categories so finalize can emit its posting-only rounds.suppressed audit without treating them
  // as confidence, severity, dedup, or cap drops.
  const suppression = opts.preCapSuppress?.(afterSeverity) ?? {
    survivors: afterSeverity,
    suppressed: [],
  };

  // Step 4 — sort severity desc then confidence desc. Array.prototype.sort is stable (ES2019+), so a
  // full severity+confidence tie preserves earlier-input order -> deterministic cap trimming [D-12].
  const sorted = [...suppression.survivors].sort((a, b) => {
    const rankDiff = rankOf(a.severity) - rankOf(b.severity);
    if (rankDiff !== 0) return rankDiff;
    return (b.confidence ?? -1) - (a.confidence ?? -1);
  });

  // Step 5 — dedup (injected). A no-op dedup returns its input unchanged with no merges.
  const { survivors, merges } = opts.dedup(sorted);

  // Step 6 — tiered cap: exempt P0/P1/P2 (rank <= 2), cap only P3/nit (rank >= 3) [D-13]. The exempt
  // set precedes the kept-capped set, and every exempt rank sorts before every capped rank, so `kept`
  // stays globally sorted severity desc.
  const exempt: ParsedReviewComment[] = [];
  const capped: ParsedReviewComment[] = [];
  for (const c of survivors) {
    if (rankOf(c.severity) <= 2) exempt.push(c);
    else capped.push(c);
  }
  const keptCapped = capped.slice(0, opts.effectiveMaxComments);
  for (const c of capped.slice(opts.effectiveMaxComments)) {
    cap.push({ path: c.path, line: c.line, title: c.title, severity: c.severity });
  }

  return {
    kept: [...exempt, ...keptCapped],
    suppressed: suppression.suppressed,
    dropped: { confidenceFloor, severityFloor, cap, merges },
  };
}
