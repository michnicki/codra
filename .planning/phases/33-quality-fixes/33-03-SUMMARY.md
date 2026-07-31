---
phase: 33-quality-fixes
plan: 03
subsystem: audit
tags: [audit, dashboard, schema, viewer]

requires:
  - phase: 33 (plan 01)
    provides: VcsSkippedComment + widened VcsProvider.submitReview return ({ ref, skippedComments? })
  - phase: 13
    provides: jobAuditEventSchema discriminated-union convention, recordRoundAudit recorder
provides:
  - jobAuditEventSchema 'inline_comment_skipped' additive arm
  - buildInlineCommentSkippedEvent builder + INLINE_COMMENT_SKIPPED_SAMPLE_CAP
  - runFinalizePhase aggregate skip-event recording (immediately after review assignment)
  - Dashboard audit-trail viewer stage (STAGE_ORDER/STAGE_LABELS/DecisionEvent)
affects: [33-04 (schema arm insert + STAGE_ORDER index-7 insert + viewer case)]

tech-stack:
  added: []
  patterns:
    - "Additive .passthrough() audit arm appended at the discriminated-union END"
    - "Own display group for a posting-boundary aggregate (learned_rule_suppressed precedent)"

key-files:
  created: []
  modified:
    - src/shared/schema.ts
    - src/server/core/audit.ts
    - src/server/core/review.ts
    - src/client/lib/audit-grouping.ts
    - src/client/components/features/job-detail/audit-trail-viewer.tsx
    - test/audit-grouping.spec.ts
    - test/audit-trail.spec.ts
    - test/review-flow.spec.ts

key-decisions:
  - "D-03/D-04: ONE aggregate inline_comment_skipped event per review round, sample capped at 20"
  - "OD-2: recording placed immediately after the review assignment, BEFORE the suppression audit (REVIEWS R9)"
  - "OD-3: stage literal inline_comment_skipped; own STAGE_ORDER entry appended after walkthrough (R10)"
  - "Builder param deliberately structural (NOT VcsSkippedComment) so core/audit.ts gains no vcs/types import"

patterns-established:
  - "review declaration annotation widened with skippedComments?: VcsSkippedComment[] (Plan 30-04 union-reduction trap)"

requirements-completed: [PRD-01]

coverage:
  - id: D1
    description: "inline_comment_skipped aggregate audit event lands once per review round on the job, consuming Plan 33-01's skippedComments seam, with AUD-01-redacted sample titles"
    requirement: PRD-01
    verification:
      - kind: unit
        ref: "test/review-flow.spec.ts#records an inline_comment_skipped aggregate audit event when submitReview returns skippedComments (PRD-01, D-03/D-04)"
        status: pass
      - kind: unit
        ref: "test/audit-trail.spec.ts#buildInlineCommentSkippedEvent (PRD-01, D-03/D-04)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The event renders in its own dashboard display group appended after walkthrough (own STAGE_ORDER entry, STAGE_LABELS, DecisionEvent case)"
    requirement: PRD-01
    verification:
      - kind: unit
        ref: "test/audit-grouping.spec.ts#Phase 33 (PRD-01 / FR-031, D-03/D-04) — inline_comment_skipped is its own display group"
        status: pass
      - kind: unit
        ref: "test/audit-grouping.spec.ts#is the fixed thirteen-stage order including learned_rule_suppressed, rounds, threads, critic, ensemble, walkthrough, and inline_comment_skipped"
        status: pass
    human_judgment: false
  - id: D3
    description: "NREG-01: a clean round records no skip event; finalize retry past posting emits no skip event (existingReview branch never carries skippedComments)"
    requirement: PRD-01
    verification:
      - kind: unit
        ref: "test/review-flow.spec.ts#reuses an already-posted review instead of double-posting when finalize re-runs past the posting stage"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-07-31
status: complete
---

# Phase 33 Plan 3: inline_comment_skipped audit surface Summary

**Posted-vs-skipped inline comments are now visible in the dashboard: one aggregate `inline_comment_skipped` audit event per review round, built from Plan 33-01's `skippedComments` adapter seam, recorded in finalize immediately after the review assignment, and rendered in its own audit-trail group**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-31T14:08:00Z
- **Completed:** 2026-07-31T14:16:00Z
- **Tasks:** 1
- **Files modified:** 8

## Accomplishments
- `jobAuditEventSchema` arm `stage: 'inline_comment_skipped'` appended at the union END: `count` (full total) + `.max(20)` sample of `{ path, line, title }` (T-13-03-03) with `.max(100)` titles
- `buildInlineCommentSkippedEvent` builder — structural param (no `vcs/types` import in `core/audit.ts`), null-on-empty, `satisfies JobAuditEvent`, titles redacted via `redactFindingTitle` (AUD-01); `INLINE_COMMENT_SKIPPED_SAMPLE_CAP = 20` exported
- `runFinalizePhase`: recording gated on `review.skippedComments?.length`, placed immediately after the `review` assignment and BEFORE the suppression-audit block and walkthrough edit (REVIEWS R9); the `review` annotation widened with `skippedComments?: VcsSkippedComment[]` (Plan 30-04 union-reduction trap); `finalComments.map` now carries `title`
- Viewer: STAGE_ORDER 12 → 13 entries with `'inline_comment_skipped'` appended after `'walkthrough'` (REVIEWS R10); STAGE_LABELS + DecisionEvent case mirroring `learned_rule_suppressed` (plain React text nodes, T-16-06-01)
- Tests: STAGE_ORDER 13-entry `toEqual`, own-group describe, builder describe (null-on-empty/count-cap/redaction/line-null/schema-acceptance), and a finalize-flow test proving end-to-end landing on the job with `line: 3` (adapter maps client `position` → `line`)

## Task Commits

Each task was committed atomically:

1. **Task 1: inline_comment_skipped audit event — schema arm, builder, finalize wiring, viewer stage, flow test** - `9f3af44` (feat)

## Files Created/Modified
- `src/shared/schema.ts` - `inline_comment_skipped` arm appended at union end
- `src/server/core/audit.ts` - `buildInlineCommentSkippedEvent` + `INLINE_COMMENT_SKIPPED_SAMPLE_CAP` + `InlineCommentSkippedAuditEvent` type
- `src/server/core/review.ts` - skip-event recording after review assignment; annotation + title wiring
- `src/client/lib/audit-grouping.ts` - STAGE_ORDER 13th entry
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` - STAGE_LABELS + DecisionEvent case
- `test/audit-grouping.spec.ts` - 13-entry toEqual + own-group describe
- `test/audit-trail.spec.ts` - builder describe (6 cases)
- `test/review-flow.spec.ts` - finalize-flow test with `createReview` spy resolving `{ id: 456, skippedComments }`

## Decisions Made
- OD-2 (audit half): `recordRoundAudit` + `buildInlineCommentSkippedEvent` placed immediately after the `review` assignment; no new recorder
- OD-3: stage literal `inline_comment_skipped`, own STAGE_ORDER entry appended after `walkthrough` (R10)
- `InlineCommentSkippedAuditEvent = Extract<JobAuditEvent, { stage: 'inline_comment_skipped' }>` return type so test assertions narrow the union (the plan's generic `JobAuditEvent | null` return would have left `.sample`/`.count` typed `unknown` in tests — the Extract convention matches the other builders)

## Deviations from Plan

None - plan executed exactly as written. (One additive refinement: the builder return type uses the `Extract`-based event type convention already used by the sibling builders, which the plan's `JobAuditEvent | null` signature implied but did not name.)

## Issues Encountered
- Pre-existing (NOT caused by this plan): `test/add-bitbucket-workspace.spec.ts` "Test 3" fails at base commit `a9dc7cc` too (shared-DB test-state flake, documented in STATE.md). One additional transient failure appeared in one full-suite run and disappeared on re-run — consistent with the documented "Test DB accumulates rows" flake. Untouched per the scope-boundary rule.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Ready for Plan 33-04 (Wave 3): `suggestion_dropped` arm inserts after `learned_rule_suppressed` (schema :1143), STAGE_ORDER inserts at index 7 (13 → 14), and the audit-grouping `toEqual` updates 13 → 14 — no positional conflicts, verified at the edit sites.

---
*Phase: 33-quality-fixes*
*Completed: 2026-07-31*
