---
phase: 33-quality-fixes
status: passed
date: 2026-07-31
must_haves_total: 24
must_haves_passed: 24
must_haves_failed: 0
---

# Phase 33 Verification Report

**Phase:** 33 — Quality Fixes (v1.5 PRD Parity)
**Requirements:** PRD-01 (FR-031), PRD-02 (FR-153/FR-154), PRD-03 (FR-155)
**Plans:** 4/4 complete (33-01, 33-02, 33-03, 33-04)
**Verification method:** inline (no gsd-verifier agent in this runtime); all must-haves cross-checked against the codebase with grep + full test suite

## Score

**24/24 must-haves verified** across the 4 plan files (6 truths + 0 prohibitions per plan, all checked).

## Requirement Traceability

| REQ-ID | FR | Plan(s) | Status | Evidence |
|--------|-----|---------|--------|----------|
| PRD-01 | FR-031 (per-comment 422 fallback) | 33-01, 33-03 | ✓ | `createReviewComment` (core/github.ts:1031), fallback loop + `hasRemainingSafeBudget` (6 refs), Bitbucket 422 skip (vcs/bitbucket.ts:516), `inline_comment_skipped` audit arm (schema.ts:1399) + builder (audit.ts:825) + finalize wiring (review.ts:2594) + STAGE_ORDER (audit-grouping.ts:33) |
| PRD-02 | FR-153/FR-154 (title truncation, suggestion clear/drop) | 33-04 | ✓ | `COMMENT_TITLE_MAX = 80` (model-output.ts:622), drop clause (model-output.ts:490), `suggestion_dropped` arm (schema.ts:1151) + builder call (model-output.ts:592) + STAGE_ORDER (audit-grouping.ts:25) |
| PRD-03 | FR-155 (Mermaid label sanitization) | 33-02 | ✓ | `sanitizeMermaidLabels(text)` wired at D-14 position (model-output.ts:687) |

## Plan-Level Must-Have Verification

### Plan 33-01 — Posting-path 422 fallback (PRD-01)

- ✓ **D-01 (GitHub)**: batch 422 → summary-only retry + per-comment fallback via `createReviewComment`; per-comment 422 caught and skipped, never rethrown; single review ref contract preserved. Wire body is the fixed 4-key literal `{ body, commit_id, path, position }` — no `title` key (spec-asserted).
- ✓ **D-02 (Bitbucket)**: skip-and-continue only on `BitbucketError.status === 422`; try/catch wraps only the inline POST; `postedComments.push`/`dedup.set` on success path; summary/approve fail-hard (spec-pinned: summary-422-reject spec passes).
- ✓ **D-03/D-04 (seam)**: `VcsSkippedComment` exported (vcs/types.ts:97); both adapters' `submitReview` returns widened with `skippedComments?`; GitHub maps `position` → `line` via `s.position ?? null`. Aggregate `inline_comment_skipped` consumption is Plan 33-03's (delivered).
- ✓ **FR-031 warn**: one `logger.warn` per skipped comment at client (github.ts:928, reason: 'unprocessable') / adapter (bitbucket.ts:517), payload `{ path, line/position, title }` — body never included (spec-asserted via warn spy).
- ✓ **NREG-01**: clean batch 200 → exactly one POST /reviews, zero /comments POSTs, `skippedComments` omitted (spec-asserted).
- ✓ **Budget guard**: `hasRemainingSafeBudget(1)` consulted before each per-comment post; budget exhaustion stops the loop with `reason: 'budget_exhausted'` warn and records un-attempted comments in `skippedComments`.

### Plan 33-02 — Mermaid label sanitizer (PRD-03)

- ✓ **D-12**: canonical `engine["core/"engine.py""]` → `engine["core/engine.py"]` (spec-asserted via `toBe`, bare + fenced).
- ✓ **D-13**: scope is label tokens only — message/note text untouched (spec-asserted: `A->>B: say "hi"` round-trips).
- ✓ **D-14**: sanitizer runs after fence-unwrap, before first-token validation + length cap (line 687, before line 688 `const source`).
- ✓ **NREG-01**: clean diagrams — including clean labels and quoted message text — pass through byte-identically.
- ✓ **REVIEWS R7**: unterminated token copied verbatim, scan always advances (no-hang spec passes); multi-label lines handled per token.

### Plan 33-03 — inline_comment_skipped audit surface (PRD-01)

- ✓ **D-03/D-04**: ONE aggregate event per review round (count + sample capped at 20); titles redacted at build time via `redactFindingTitle` (AUD-01); per-comment events prohibited.
- ✓ **Schema arm**: `z.literal('inline_comment_skipped')` at schema.ts:1399, `.max(20)` sample, `.max(100)` titles.
- ✓ **Builder**: `buildInlineCommentSkippedEvent` (audit.ts:825) — null-on-empty, `satisfies JobAuditEvent`, structural param (no vcs/types import).
- ✓ **Wiring**: recording immediately after the `review` assignment (review.ts:2594), gated on `review.skippedComments?.length`, BEFORE suppression audit (REVIEWS R9); `review` annotation widened with `skippedComments?: VcsSkippedComment[]` (Plan 30-04 union-reduction trap avoided).
- ✓ **NREG-01**: clean round records nothing; finalize retry past posting (existingReview branch) never carries `skippedComments` → no phantom event (flow-test proven).
- ✓ **Viewer**: own STAGE_ORDER entry appended after `walkthrough` (audit-grouping.ts:33), STAGE_LABELS + DecisionEvent case; 13-entry `toEqual` updated (later 14 by 33-04).

### Plan 33-04 — Parse-pipeline normalization (PRD-02)

- ✓ **D-05/D-08**: non-empty suggestion + empty cleaned body → dropped (`return null` at model-output.ts:490) + `suggestion_dropped` aggregate per (file, pass) via `buildSuggestionDroppedEvent` call (model-output.ts:592) riding `severityAuditEvents`.
- ✓ **D-06/D-07**: cleaned suggestion == trimmed existingCode → `codeSuggestion = null` + ```suggestion fence stripped from posted body (reuses `withSuggestion` normalization; fenced suggestion cannot dodge — spec-pinned both variants).
- ✓ **REVIEWS R6**: drop clause AFTER body-prefix strip, BEFORE severity engine; uses CLEANED body (`body.length === 0`); parse payload passes resolved LOCAL `codeSuggestion`.
- ✓ **D-09/D-10/D-11**: `COMMENT_TITLE_MAX = 80` exported (model-output.ts:622); truncation last before parse (after EVID-01); orphan titles get `cleanText` + `slice(0, 80)` (consensus fold-in (c)); severity/category engine sees full title (spec-pinned).
- ✓ **OD-6 fail-open**: `code_suggestion: ''`/whitespace → absent (`hasSuggestion` checks `trim().length > 0`) — the `z.string().min(1)` whole-file parse throw is closed (spec-pinned, no-throw).
- ✓ **REVIEWS R2/R8**: `./audit` imports extended in place (no new import lines); `COMMENT_TITLE_MAX` exported for both consumers.
- ✓ **NREG-01**: clean findings round-trip byte-identically (full-object `toEqual` spec).

## Automated Test Evidence

- `npm run typecheck` — clean (0 errors).
- `npx vitest run test/vcs-github-adapter.spec.ts test/bitbucket-adapter.spec.ts` — 78/78 pass (fallback, skip, NREG-01, rethrow, reply-discrimination, dedup-not-poisoned, summary-fail-hard).
- `npx vitest run test/model-output.spec.ts` — 82/82 pass (sanitizer + FR-153/154 normalization).
- `npx vitest run test/audit-trail.spec.ts test/audit-grouping.spec.ts` — 63/63 pass (both builders, STAGE_ORDER 14-entry, own-group).
- `npx vitest run test/review-flow.spec.ts` — 95/95 pass (incl. end-to-end skip-event landing).
- **Regression gate**: 8 prior-phase test files (review-flow, bitbucket-adapter, vcs-github-adapter, model-output, audit-trail, audit-grouping, rounds-review-flow, async-batch-review) — 330/330 pass.
- `npm test` (full suite) — 2065/2066 pass. **1 pre-existing failure** at `test/add-bitbucket-workspace.spec.ts` "Test 3" — verified identical at the pre-phase base commit `a9dc7cc` (shared-DB test-state flake, documented in STATE.md "Test DB accumulates rows" blocker). NOT introduced by Phase 33.

## Code Review

`33-REVIEW.md`: status **clean** — 0 findings across 18 files (8 production, 10 test). Key correctness properties spot-checked: fallback-loop budget accounting, `response.json()` single-consume, Bitbucket dedup non-poisoning, FR-153 ordering, `''`-suggestion hardening, builder `satisfies` checks, mock route discrimination.

## Human Verification Items

None — all must-haves are automation-verifiable (unit/integration specs + grep-verified code state). No manual testing required.
