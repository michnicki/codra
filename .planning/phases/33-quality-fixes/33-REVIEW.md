---
phase: 33
status: clean
depth: standard
files_reviewed: 18
critical: 0
warning: 0
info: 0
total: 0
date: 2026-07-31
---

# Phase 33 Code Review — Quality Fixes

## Review Scope

18 files reviewed (8 production, 10 test), diff base `a9dc7cc..HEAD`:

- `src/server/core/github.ts` — `createReviewComment`, batch-422 fallback loop, widened return/tracker types
- `src/server/services/github.ts` — widened constructor tracker type
- `src/server/vcs/types.ts` — `VcsSkippedComment`, widened `submitReview` return
- `src/server/vcs/github.ts` — adapter `skippedComments` mapping (`position` → `line`)
- `src/server/vcs/bitbucket.ts` — per-comment 422 skip-and-continue, omit-when-empty return
- `src/server/core/model-output.ts` — `COMMENT_TITLE_MAX`, FR-153 drop/clear clauses, `''`-suggestion hardening, hoisted `cleanText`, `suggestion_dropped` producer
- `src/server/core/audit.ts` — `buildSuggestionDroppedEvent`, `buildInlineCommentSkippedEvent` + caps
- `src/server/core/review.ts` — aggregate skip-event recording in `runFinalizePhase`
- `src/shared/schema.ts` — `suggestion_dropped` + `inline_comment_skipped` audit arms
- `src/client/lib/audit-grouping.ts`, `src/client/components/features/job-detail/audit-trail-viewer.tsx` — viewer stages
- Test files: `github-fetch-mock.ts`, `vcs-github-adapter.spec.ts`, `bitbucket-adapter.spec.ts`, `model-output.spec.ts`, `audit-trail.spec.ts`, `audit-grouping.spec.ts`, `review-flow.spec.ts`

## Findings

No Critical, Warning, or Info findings.

### Verified sound (spot-checked during review)

- **GitHub fallback loop** (`core/github.ts:883-937`): budget check precedes each post and uses the loop index (`slice(i)` = exactly the un-attempted comments); `response.json()` is consumed at most once per path (skip branch returns early); position-less comments produce an empty loop with no skip accounting; non-422 per-comment errors rethrow (fail loud). The 403-based rethrow spec avoids `withRetry` backoff sleeps while keeping the proof.
- **Bitbucket skip** (`vcs/bitbucket.ts:500-524`): try/catch wraps ONLY the inline POST; `postedComments.push`/`dedup.set` stay on the success path (a skipped comment is never dedup-indexed — REVIEWS R3); `continue` inside catch is correct; summary/approve stay unwrapped (fail-hard, REVIEWS R12 — pinned by spec).
- **Widen-return discipline** (REVIEWS R1): both adapters omit `skippedComments` when empty; clean-path specs assert zero extra subrequests (`vcs-github-adapter.spec.ts` NREG-01 spec asserts exactly one `/reviews` POST and zero `/comments` POSTs).
- **FR-153 order** (REVIEWS R6 HIGH): drop clause evaluates the ORIGINAL suggestion + CLEANED body, positioned after the body-prefix strip and before the severity engine; clear-before-drop impossible by construction (drop returns early).
- **`''`-suggestion hardening** (OD-6): `hasSuggestion` is `typeof === 'string' && trim().length > 0`, so `''`/whitespace → `undefined` — the `z.string().min(1)` whole-file parse throw is closed; pinned by two no-throw specs.
- **D-10 truncation placement**: `truncatedTitle` computed immediately before the schema parse, after the severity engine — the engine sees the full title (pinned by the severity-equality spec).
- **Orphan truncation** (D-11 + fold-in (c)): hoisted `cleanText` is a pure parameter-only function (behavior-neutral); orphan bodies stay raw per pre-existing behavior.
- **Audit builders**: both `satisfies JobAuditEvent` (compile-checked), titles redacted via `redactFindingTitle` (which maps `null/undefined` → `[clamped:empty]`, schema-valid), caps 20, null-on-empty, `Extract`-typed return (33-03).
- **Review.ts wiring**: skip-event recording gated on `review.skippedComments?.length`; existingReview branch never carries `skippedComments` (no phantom event on finalize retry); `recordRoundAudit` never throws.
- **Mock discrimination**: `/pulls/{n}/comments` handler parses the body try/catch-guarded and discriminates `in_reply_to` vs `commit_id` — reply specs stay byte-identical (REVIEWS R2/R11); omitted fixture keeps the unconditional 201 default (NREG-01).

## Verification Status

- `npm run typecheck` — clean
- `npm test` — 1 failure, pre-existing at base commit `a9dc7cc` (`add-bitbucket-workspace.spec.ts` Test 3, shared-DB flake documented in STATE.md); all 2065 other tests pass
