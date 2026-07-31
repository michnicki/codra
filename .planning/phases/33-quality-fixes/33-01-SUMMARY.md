---
phase: 33-quality-fixes
plan: 01
subsystem: vcs
tags: [github, bitbucket, 422-fallback, skippedComments, vcs-adapter]

requires:
  - phase: 30
    provides: VcsProvider.submitReview return shapes ({ ref, postedComments? }), VcsPostedComment, adapter seam conventions
provides:
  - GitHub batch-422 per-comment fallback (createReviewComment + createReview loop)
  - Bitbucket inline-422 skip-and-continue (summary/approve stay fail-hard)
  - VcsSkippedComment type + skippedComments? on both adapters (omit-when-empty)
affects: [33-03 (inline_comment_skipped audit event consumes review.skippedComments), 33-04]

tech-stack:
  added: []
  patterns:
    - "Batch-422 fallback: summary-only review + per-comment posts, budget-guarded via hasRemainingSafeBudget(1)"
    - "Omit-when-empty optional return members on both VCS adapters (byte-identical clean paths)"

key-files:
  created: []
  modified:
    - src/server/core/github.ts
    - src/server/services/github.ts
    - src/server/vcs/types.ts
    - src/server/vcs/github.ts
    - src/server/vcs/bitbucket.ts
    - test/github-fetch-mock.ts
    - test/vcs-github-adapter.spec.ts
    - test/bitbucket-adapter.spec.ts

key-decisions:
  - "D-01: GitHub batch 422 -> summary-only retry + per-comment fallback; per-comment 422 skips with warn; non-422 rethrows"
  - "D-02: Bitbucket inline 422 skip-and-continue; summary/approve stay fail-hard (proven by summary-422-reject spec)"
  - "R3: skipped comments never dedup-indexed (dedup.set stays on success path)"
  - "R1: skippedComments omitted-when-empty on both adapters"
  - "R4: per-comment wire body is a fixed 4-key literal { body, commit_id, path, position } — title never on the wire"

patterns-established:
  - "createReviewComment mirrors createReviewCommentReply exactly; position REQUIRED at signature level via & { position: number } intersection + type-guard filter"
  - "Budget guard before each per-comment post prevents stranding an already-posted summary review behind a subrequest-budget failure"

requirements-completed: [PRD-01]

coverage:
  - id: D1
    description: "GitHub batch-422 fallback posts each positioned inline comment individually; per-comment 422s skip with a body-free warn; clean path performs exactly one /reviews POST and zero /comments POSTs"
    requirement: PRD-01
    verification:
      - kind: unit
        ref: "test/vcs-github-adapter.spec.ts#batch 422 retries summary-only then posts each comment individually with a fixed 4-key body (FR-031)"
        status: pass
      - kind: unit
        ref: "test/vcs-github-adapter.spec.ts#per-comment 422 skips with a warning (no body in payload) and surfaces skippedComments"
        status: pass
      - kind: unit
        ref: "test/vcs-github-adapter.spec.ts#clean batch 200 posts once and omits skippedComments entirely (NREG-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Bitbucket inline 422 skip-and-continue with warn; summary/approve 422s still reject; skipped comments never poison the dedup map"
    requirement: PRD-01
    verification:
      - kind: unit
        ref: "test/bitbucket-adapter.spec.ts#submitReview skip-and-continues on an inline 422, surfacing skippedComments (FR-031, D-02)"
        status: pass
      - kind: unit
        ref: "test/bitbucket-adapter.spec.ts#submitReview REJECTS when the SUMMARY post 422s — summary stays fail-hard (REVIEWS R12)"
        status: pass
      - kind: unit
        ref: "test/bitbucket-adapter.spec.ts#a 422-skipped comment never poisons the dedup map — an identical later comment still posts (REVIEWS R3)"
        status: pass
    human_judgment: false
  - id: D3
    description: "VcsSkippedComment exported from vcs/types; submitReview returns skippedComments? on both adapters, omitted when empty (the D-03/D-04 seam Plan 33-03 consumes)"
    requirement: PRD-01
    verification:
      - kind: unit
        ref: "test/vcs-github-adapter.spec.ts#clean batch 200 posts once and omits skippedComments entirely (NREG-01)"
        status: pass
      - kind: unit
        ref: "test/bitbucket-adapter.spec.ts#submitReview posts the combined marker+summary as the FINAL comment (REV-R-A)"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-07-31
status: complete
---

# Phase 33 Plan 1: GitHub/Bitbucket per-comment 422 fallback Summary

**GitHub batch-422 reviews now retry each inline comment individually (skip-on-422 with budget guard), Bitbucket inline 422s skip-and-continue without poisoning the dedup map, and both adapters surface posted-vs-skipped via an omit-when-empty `skippedComments` on the `submitReview` return**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-31T13:52:00Z
- **Completed:** 2026-07-31T14:05:00Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- `GitHubClient.createReviewComment` posts `{ body, commit_id, path, position }` (fixed 4-key literal — `title` never on the wire, REVIEWS R4)
- `createReview` 422 branch: summary-only retry preserved as base, then per-comment fallback loop with `hasRemainingSafeBudget(1)` guard and `logger.warn` on per-comment 422 (D-01, FR-031)
- `BitbucketAdapter.submitReview`: try/catch wraps ONLY the inline POST; 422 skips with `{ workspace, repo, path, line, title }` warn (no body); `postedComments.push`/`dedup.set` stay on the success path (R3); summary/approve stay fail-hard (D-02)
- `VcsSkippedComment` exported from `src/server/vcs/types.ts`; `submitReview` return widened on both adapters with omit-when-empty semantics (REVIEWS R1)
- Mock: additive `reviewCommentResponses` fixture; `/pulls/{n}/comments` route discriminates `in_reply_to` vs `commit_id` bodies (reply specs byte-identical, R2/R11); body parse try/catch-guarded (never throws)

## Task Commits

Each task was committed atomically:

1. **Task 1: GitHub per-comment 422 fallback — client, adapter seam, types, mock fixture, adapter specs** - `eede829` (feat)
2. **Task 2: Bitbucket per-comment 422 skip-and-continue — success-path discipline + summary fail-hard** - `c16b995` (feat)

## Files Created/Modified
- `src/server/core/github.ts` - `createReviewComment` method, widened `GitHubReviewComment` (+`title?`), 422 fallback loop with budget guard, widened `createReview` return `{ id, skippedComments? }`, widened tracker type
- `src/server/services/github.ts` - widened constructor tracker type (2-member shape)
- `src/server/vcs/types.ts` - `VcsSkippedComment` type, `VcsReviewComment` +`title?`, `submitReview` return +`skippedComments?`
- `src/server/vcs/github.ts` - `GithubAdapter.submitReview` widened return; `position` → `line` mapping (`s.position ?? null`)
- `src/server/vcs/bitbucket.ts` - per-comment 422 skip-and-continue; omit-when-empty return
- `test/github-fetch-mock.ts` - `reviewCommentResponses` fixture with in_reply_to/commit_id route discrimination
- `test/vcs-github-adapter.spec.ts` - 5 new specs (NREG-01 clean, fallback, skip+warn, non-422 rethrow, reply discrimination)
- `test/bitbucket-adapter.spec.ts` - 3 new specs (422-mid-script, summary-422-reject, dedup-not-poisoned) + omit-when-empty pin on existing spec

## Decisions Made
- OD-1: client-local skipped shape `{ path, position, title }` — `core/github.ts` must NOT import vcs/types
- OD-2: `GithubAdapter.submitReview` returns `{ ref, skippedComments? }`; GitHub does not return `postedComments` (no consumer)
- OD-7: budget guard via `hasRemainingSafeBudget(1)` (TokenTracker, core/token-tracker.ts); un-attempted comments land in skippedComments with `reason: 'budget_exhausted'`
- Review dispositions: OpenCode HIGH #1/#2 rejected as false positives (inferred service return / both sites widened); Antigravity mock-parse safety + warn-redaction + position-required folded in

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing (NOT caused by this plan, verified at base commit `a9dc7cc`): `test/add-bitbucket-workspace.spec.ts` "Test 3: createWorkspaceWebhook is skipped when a matching-URL hook already exists" fails on both the base commit and this branch — a shared-DB test-state flake consistent with the documented "Test DB accumulates rows" blocker in STATE.md. Left untouched per the scope-boundary rule; surfaced for the verifier/operator.
- The GitHub per-comment rethrow spec uses 403 rather than the plan's example 500: a 500 would trigger `withRetry` backoff sleeps (1s/2s) and slow the suite; 403 is non-422 and non-retryable, preserving the same "fails loudly" proof.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Ready for Plan 33-03 (Wave 2): `VcsSkippedComment` exported, both adapters return `skippedComments?` — the three WAVE-GATE grep checks are satisfied (verified during this plan's execution).
- Ready for Plan 33-02 (Wave 1, parallel): disjoint file sets.

---
*Phase: 33-quality-fixes*
*Completed: 2026-07-31*
