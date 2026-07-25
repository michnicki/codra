import type { ParsedReviewComment } from '@shared/schema';

/**
 * Deterministic near-duplicate suppression (MP-02 / D-03 / D-04).
 *
 * A second finding source (the security pass) can surface the same issue the main pass already
 * reported. `dedupeFindings` collapses those same-file near-duplicates BEFORE anything is posted,
 * using nothing but the parsed findings — no model call, no I/O, no network, no DB (D-03: zero cost,
 * fully unit-testable). It is a pure, UNCONDITIONAL function: the `passes.security` gate that decides
 * WHETHER to call it lives at the review.ts / runCriticPhase call site (Pitfall 4), not here.
 *
 * Similarity is hand-rolled character-trigram Jaccard (~50 LOC), deliberately avoiding the
 * unmaintained / isolate-incompatible similarity libraries (RESEARCH § Don't Hand-Roll).
 */

// Tuned start value for near-duplicate collapse. 0.7 is high enough that only genuine paraphrases
// of the SAME issue merge (two unrelated findings on the same file rarely share 70% of their
// character trigrams) yet low enough to catch main-vs-security restatements of one bug. It is a
// documented tunable: if paraphrased duplicates leak through, raise/lower this rather than changing
// the algorithm.
export const DEDUP_SIMILARITY_THRESHOLD = 0.7;

// Max line distance (inclusive) for two same-file findings to be considered the "same location".
// 10 absorbs the small line drift between how the main and security passes anchor the same issue
// (a finding on the function signature vs. one line into the body) without merging distinct issues
// that merely happen to be textually similar elsewhere in the file. Also a documented tunable.
export const DEDUP_LINE_PROXIMITY = 10;

// Severity ranking (lower rank = higher severity). SINGLE SOURCE OF TRUTH — `review.ts` imports
// this constant rather than keeping its own copy (dedup.ts is a low-level, cycle-free module, so
// review.ts can safely depend on it). Previously this was hand-duplicated in both modules with a
// stale line reference; consolidating here removes the drift hazard.
export const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

/**
 * Normalize a finding's comparison text so that surface differences (case, markdown, backticks,
 * punctuation, whitespace, unicode composition) don't defeat the similarity comparison.
 * Order matters: NFC first so accented letters compose into a single \p{L} code point that the
 * punctuation strip below keeps, then lowercase, strip fenced code / inline backticks, strip any
 * remaining non-letter/number/space char, and collapse whitespace.
 */
export function normalizeForDedup(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`+/g, ' ') // inline backticks
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // markdown/punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

function trigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * Character-trigram Jaccard similarity: |A∩B| / |A∪B|.
 *
 * PINNED empty/short rule: a string shorter than 3 chars has an empty trigram set. Two empty sets
 * are treated as "similar" (1) ONLY when the input strings are exactly equal, else 0; an empty set
 * against a non-empty set is 0. Callers pass already-normalized strings, so the exact-equality
 * check is over normalized text.
 */
export function trigramJaccardSimilarity(a: string, b: string): number {
  const setA = trigramSet(a);
  const setB = trigramSet(b);
  if (setA.size === 0 && setB.size === 0) {
    return a === b ? 1 : 0;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Word-set (token) Jaccard similarity for the Phase 14 composite dedup (FILT-03 / D-01). Tokenizes
 * via `normalizeForDedup` (D-03: NO new normalizer) then a plain space-split, and scores
 * |A∩B| / |A∪B| over the resulting WORD sets — deliberately NOT the char-trigram measure the legacy
 * `dedupeFindings` path uses. Word-set Jaccard is the PRD's near-duplicate measure; it tolerates
 * reordered / reworded phrasings of the same finding better than character trigrams, which is why
 * the composite rule thresholds (0.2 / 0.6 / 0.8, body 0.5) sit far below the trigram path's 0.7.
 *
 * Empty-set rule (ADDRESSES REVIEW FINDING #8a): returns 0 whenever EITHER token set is empty,
 * INCLUDING both-empty. This INTENTIONALLY DIFFERS from the frozen `trigramJaccardSimilarity` (which
 * returns 1 for two equal-empty strings): the composite rules 2/3/4 gate on a POSITIVE threshold, so
 * a title of pure punctuation (which normalizes to '') must never satisfy them and spuriously merge.
 * `wordJaccardSimilarity` is a NEW, non-frozen function, so it does not inherit the trigram rule.
 */
export function wordJaccardSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeForDedup(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeForDedup(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0; // includes both-empty -> 0 (finding #8a)
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * D-04 survivor selection: higher severity wins; equal severity -> higher confidence
 * (confidence ?? -1, so an explicit score always beats null); remaining tie -> keep the existing
 * (stably-earlier) finding. EXPORTED (was private) so the Phase 14 composite tie-break reuses the
 * exact same rule rather than re-deriving it (behavior-neutral change; D-04).
 */
export function pickSurvivor(existing: ParsedReviewComment, candidate: ParsedReviewComment): ParsedReviewComment {
  const rankExisting = SEVERITY_RANK[existing.severity] ?? SEVERITY_RANK.nit;
  const rankCandidate = SEVERITY_RANK[candidate.severity] ?? SEVERITY_RANK.nit;
  if (rankCandidate < rankExisting) return candidate;
  if (rankCandidate > rankExisting) return existing;
  const confExisting = existing.confidence ?? -1;
  const confCandidate = candidate.confidence ?? -1;
  if (confCandidate > confExisting) return candidate;
  return existing; // tie -> keep the earlier finding (stable)
}

/**
 * PINNED proximity gate: a pair merges iff BOTH lines are non-null and within DEDUP_LINE_PROXIMITY,
 * OR both lines are null. If exactly one line is null, proximity cannot be established -> keep both.
 * `line` may be null or undefined on ParsedReviewComment; both are treated as "no line".
 */
function proximityAllowsMerge(a: ParsedReviewComment, b: ParsedReviewComment): boolean {
  const lineA = a.line ?? null;
  const lineB = b.line ?? null;
  if (lineA === null && lineB === null) return true;
  if (lineA === null || lineB === null) return false;
  return Math.abs(lineA - lineB) <= DEDUP_LINE_PROXIMITY;
}

/**
 * Deterministic same-file near-duplicate suppression. Single greedy pass over `findings` in stable
 * input order: each finding is compared against the already-KEPT survivors and, on the first match
 * (same path AND proximity gate AND similarity >= threshold), resolved by the D-04 tie-break IN
 * PLACE — the higher-severity member occupies that survivor's slot, so a later higher-severity
 * finding replaces an earlier survivor without reordering. Findings on different paths are never
 * merged (ParsedReviewComment has no line_range, so no cross-file / range-overlap branch exists).
 * Returns survivors in stable input order.
 */
export function dedupeFindings(findings: ParsedReviewComment[]): ParsedReviewComment[] {
  if (findings.length <= 1) return [...findings];

  const survivors: ParsedReviewComment[] = [];
  const survivorNorms: string[] = [];

  for (const finding of findings) {
    const norm = normalizeForDedup(`${finding.title} ${finding.body}`);
    let merged = false;

    for (let i = 0; i < survivors.length; i++) {
      const survivor = survivors[i];
      if (survivor.path !== finding.path) continue;
      if (!proximityAllowsMerge(survivor, finding)) continue;
      if (trigramJaccardSimilarity(norm, survivorNorms[i]) < DEDUP_SIMILARITY_THRESHOLD) continue;

      const winner = pickSurvivor(survivor, finding);
      survivors[i] = winner;
      survivorNorms[i] = normalizeForDedup(`${winner.title} ${winner.body}`);
      merged = true;
      break;
    }

    if (!merged) {
      survivors.push(finding);
      survivorNorms.push(norm);
    }
  }

  return survivors;
}

/**
 * One near-duplicate merge decided by `dedupeComposite`. The finalize audit builder (Plan 14-02)
 * projects each record into a `deduped` audit event. `titleSimilarity` / `bodySimilarity` are the
 * word-Jaccard scores that CAUSED the merge (ADDRESSES REVIEW FINDING #4 — non-sensitive decision
 * metadata, never raw finding content); either is `null` where its rule did not consult that measure
 * (rule1 has no title check; only rule4 uses a body measure).
 */
export type MergeRecord = {
  survivor: ParsedReviewComment;
  suppressed: ParsedReviewComment;
  rule: 'rule1' | 'rule2' | 'rule3' | 'rule4';
  titleSimilarity: number | null;
  bodySimilarity: number | null;
};

// Phase 19 (PASS-02, D-11): the composite-match vocabulary is reused by ensemble voting so the
// cluster/vote and the post-pass dedup pipeline share ONE rule table. Exported additively
// without changing behavior.
export type CompositeMatch = Omit<MergeRecord, 'survivor' | 'suppressed'>;

/**
 * Evaluate the FILT-03 4-rule table (D-02) for one already-kept survivor against one candidate, both
 * word-Jaccard based (NOT the legacy char-trigram measure). Returns the first matching rule with the
 * similarity scores it consulted, or `null` for no merge. Rule evaluation:
 *
 *   same path, equal-line branch (both lines NON-NULL & exactly equal, OR both null):
 *     - rule1 (no title check) fires ONLY when both lines are non-null-equal AND same category.
 *       ADDRESSES REVIEW FINDING #8b: a null line is NOT an "exact same line" per D-02, and a
 *       text-free both-null merge would be MORE aggressive than the legacy path — so rule1 is
 *       restricted to non-null-equal lines.
 *     - otherwise rule2 if title word-Jaccard >= 0.2. This is the ONLY branch two both-null findings
 *       can merge through, so every null-line merge still requires a title (text) check.
 *   same path, different-line branch (incl. exactly-one-null, A3): rule3 if title >= 0.6.
 *   different path (line-independent): rule4 if title >= 0.8 AND body >= 0.5.
 *
 * Thresholds are inclusive (>=). They are word-Jaccard values per D-01 and sit below the frozen
 * char-trigram 0.7 because word-set Jaccard is a coarser, more forgiving measure of the same-issue
 * relationship (a reworded restatement shares more words than character trigrams).
 */
// Phase 19 (PASS-02, D-11): exported (was module-private) so ensemble voting can build clusters
// against the same 4-rule table without forking a second similarity algorithm. Behavior is
// unchanged from the private predecessor — every threshold and branch is byte-for-byte preserved.
export function matchCompositeRule(
  survivor: ParsedReviewComment,
  candidate: ParsedReviewComment,
): CompositeMatch | null {
  const titleSim = wordJaccardSimilarity(survivor.title, candidate.title);

  if (survivor.path === candidate.path) {
    const lineS = survivor.line ?? null;
    const lineC = candidate.line ?? null;
    const bothNonNullEqual = lineS !== null && lineC !== null && lineS === lineC;
    const bothNull = lineS === null && lineC === null;

    if (bothNonNullEqual || bothNull) {
      // Equal-line branch. rule1 is line-null-excluded (finding #8b).
      if (bothNonNullEqual && survivor.category === candidate.category) {
        return { rule: 'rule1', titleSimilarity: null, bodySimilarity: null };
      }
      if (titleSim >= 0.2) {
        return { rule: 'rule2', titleSimilarity: titleSim, bodySimilarity: null };
      }
      return null;
    }

    // Different-line branch (includes exactly-one-null, A3).
    if (titleSim >= 0.6) {
      return { rule: 'rule3', titleSimilarity: titleSim, bodySimilarity: null };
    }
    return null;
  }

  // Cross-path branch (line-independent).
  const bodySim = wordJaccardSimilarity(survivor.body, candidate.body);
  if (titleSim >= 0.8 && bodySim >= 0.5) {
    return { rule: 'rule4', titleSimilarity: titleSim, bodySimilarity: bodySim };
  }
  return null;
}

/**
 * Phase 14 composite near-duplicate suppressor (FILT-03 / D-01/D-02/D-03). A PURE function (no I/O,
 * never throws) mirroring `dedupeFindings`'s greedy single pass over stable input order: each finding
 * is compared against the already-kept survivors and, on the FIRST matching rule, resolved by the
 * D-04 tie-break (`pickSurvivor`) IN PLACE — the winner occupies the survivor's slot so a later
 * higher-severity finding replaces an earlier survivor without reordering. Unlike the legacy path
 * this DOES merge cross-path (rule4). It is entirely ADDITIVE beside the frozen legacy path — nothing
 * calls it yet (Wave 2/3 wires it), so this lands with zero behavior change (NREG-01 byte-identity of
 * the legacy path is preserved).
 *
 * Returns `{ survivors, merges }`: survivors in stable input order, and one `MergeRecord` per merge
 * (carrying the rule + the word-Jaccard scores that caused it) so the finalize audit builder can emit
 * one `deduped` event per merge (D-07).
 */
export function dedupeComposite(findings: ParsedReviewComment[]): {
  survivors: ParsedReviewComment[];
  merges: MergeRecord[];
} {
  const merges: MergeRecord[] = [];
  if (findings.length <= 1) return { survivors: [...findings], merges };

  const survivors: ParsedReviewComment[] = [];

  for (const finding of findings) {
    let merged = false;

    for (let i = 0; i < survivors.length; i++) {
      const survivor = survivors[i];
      const match = matchCompositeRule(survivor, finding);
      if (!match) continue;

      const winner = pickSurvivor(survivor, finding);
      const suppressed = winner === survivor ? finding : survivor;
      survivors[i] = winner;
      merges.push({
        survivor: winner,
        suppressed,
        rule: match.rule,
        titleSimilarity: match.titleSimilarity,
        bodySimilarity: match.bodySimilarity,
      });
      merged = true;
      break;
    }

    if (!merged) survivors.push(finding);
  }

  return { survivors, merges };
}
