import type { ParsedReviewComment } from '@shared/schema';
import type { FileDiff } from './diff';

/**
 * Evidence drop entry: a single finding that was hard-dropped by EVID-02.
 * Each entry carries the reason the evidence check failed:
 * - 'absent': evidence was null, undefined, or whitespace-only
 * - 'not_in_hunk': evidence was present but not found in the diff hunk
 */
export interface EvidenceDropEntry {
  path: string;
  line: number | null;
  title: string;
  reason: 'absent' | 'not_in_hunk';
}

/**
 * Result of a single checkEvidence call. Three parallel arrays:
 * - kept: findings that passed the evidence check (or are exempt)
 * - dropped: findings that failed the evidence check
 * - entries: EvidenceDropEntry for each dropped finding (for audit event construction)
 */
export interface EvidenceCheckResult {
  kept: ParsedReviewComment[];
  dropped: ParsedReviewComment[];
  entries: EvidenceDropEntry[];
}

/**
 * Normalizer for the soft evidence gate (EVID-01, D-16). Collapses every whitespace run to a single
 * space, trims, AND lower-cases — the substring match is therefore whitespace- AND case-INSENSITIVE,
 * so trivial `Const` vs `const` / indentation differences do NOT inflate the `not_in_hunk` count and
 * pollute the EVID-02 go/no-go signal (OpenCode C4 / Antigravity). No Unicode normalization.
 *
 * This is DELIBERATELY NOT `cleanText` (D-16 Anti-Pattern): cleanText strips leading tag/emoji
 * prefixes (SECURITY/BUG/P0/…), which are meaningless for diff-line evidence and would corrupt the
 * haystack/needle comparison. Never reuse cleanText here.
 */
export function normalizeForEvidence(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * WR-02: The evidence haystack is built from hunk `content`, which is already diff-prefix-stripped
 * (diff.ts strips the leading +/-/space marker). The needle (`existing_code`) is only produced by the
 * model, which is merely ASKED not to prepend a `+`/`-` marker. When it disobeys (common), the needle
 * keeps that leading char and fails the `includes()` test, producing a FALSE `not_in_hunk` that
 * inflates the exact count EVID-02 reads as a go/no-go signal. Strip a single leading `+`/`-` from EACH
 * line (evidence may be multi-line) so the needle is normalized the same way the haystack already is.
 * Whitespace markers need no handling — normalizeForEvidence collapses/trims them anyway. Audit-only:
 * no posting behavior changes.
 */
export function stripLeadingDiffMarkers(s: string): string {
  return s.split('\n').map((line) => line.replace(/^[+-]/, '')).join('\n');
}

/**
 * Shared evidence check function used by both EVID-01 (parse-time soft gate) and EVID-02 (finalize-time
 * hard gate). For each finding in `comments`, builds the haystack from `files` hunks and tests whether
 * the finding's existingCode matches. Findings in exempt categories (case-insensitive comparison) are
 * always kept regardless of evidence quality.
 *
 * @param files - Array of FileDiff to build haystack from (typically the current file only for EVID-01,
 *                or all files for EVID-02)
 * @param comments - ParsedReviewComment array to check
 * @param exemptCategories - Category names whose findings bypass the evidence check (case-insensitive).
 *                           Defaults to ['security'] when empty (Zod default).
 * @returns EvidenceCheckResult with kept/dropped/entries
 */
export function checkEvidence(
  files: FileDiff[],
  comments: ParsedReviewComment[],
  exemptCategories: string[] = ['security'],
): EvidenceCheckResult {
  const kept: ParsedReviewComment[] = [];
  const dropped: ParsedReviewComment[] = [];
  const entries: EvidenceDropEntry[] = [];

  // Build per-file haystack from FileDiff hunks (same construction as model-output.ts:440-442).
  const haystacks = new Map<string, string>();
  for (const file of files) {
    haystacks.set(
      file.path,
      normalizeForEvidence(
        file.hunks.flatMap((h) => h.lines).map((l) => l.content).join('\n'),
      ),
    );
  }

  for (const comment of comments) {
    // Case-insensitive exemption check (PROHIBITION from must_haves).
    const isExempt = exemptCategories.some(
      (cat) => cat.toLowerCase() === (comment.category ?? '').toLowerCase(),
    );
    if (isExempt) {
      kept.push(comment);
      continue;
    }

    const evidence = comment.existingCode;
    const needle = evidence == null ? '' : normalizeForEvidence(stripLeadingDiffMarkers(evidence));

    // null / undefined / whitespace-only -> 'absent'
    if (evidence == null || needle.length === 0) {
      entries.push({
        path: comment.path ?? '',
        line: comment.line ?? null,
        title: comment.title,
        reason: 'absent',
      });
      dropped.push(comment);
      continue;
    }

    // Check if the file is in the haystack
    const haystack = comment.path ? haystacks.get(comment.path) : undefined;
    if (haystack === undefined || !haystack.includes(needle)) {
      // File not in diff, or evidence not found in hunk -> 'not_in_hunk'
      entries.push({
        path: comment.path ?? '',
        line: comment.line ?? null,
        title: comment.title,
        reason: 'not_in_hunk',
      });
      dropped.push(comment);
      continue;
    }

    // Evidence passed the check
    kept.push(comment);
  }

  return { kept, dropped, entries };
}
