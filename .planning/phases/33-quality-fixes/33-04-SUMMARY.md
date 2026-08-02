---
phase: 33-quality-fixes
plan: 04
subsystem: core
tags: [model-output, audit, truncation, suggestion, dashboard]

requires:
  - phase: 33 (plan 02)
    provides: sanitizeMermaidLabels in model-output.ts (different region, no line drift here)
  - phase: 33 (plan 03)
    provides: jobAuditEventSchema arms, STAGE_ORDER 13 entries, audit-trail viewer patterns
  - phase: 15
    provides: severityAuditEvents accumulator + recordUnitAudit channel, EVID-01 evidence gate
provides:
  - COMMENT_TITLE_MAX = 80 + FR-153/FR-154 producer-side normalization in parseFileReviewResponse
  - suggestion_dropped audit arm, builder, STAGE_ORDER/viewer wiring
affects: [33 verification, future parse-pipeline consumers]

tech-stack:
  added: []
  patterns:
    - "Producer-side normalization ahead of an unchanged schema (drop-before-clear, truncate-last)"
    - "Fail-open hardening: empty-string code_suggestion treated as absent (never throws the per-file parse)"

key-files:
  created: []
  modified:
    - src/shared/schema.ts
    - src/server/core/audit.ts
    - src/server/core/model-output.ts
    - src/client/lib/audit-grouping.ts
    - src/client/components/features/job-detail/audit-trail-viewer.tsx
    - test/model-output.spec.ts
    - test/audit-trail.spec.ts
    - test/audit-grouping.spec.ts

key-decisions:
  - "D-05: non-empty suggestion + empty cleaned body -> dropped + audited (suggestion_dropped aggregate)"
  - "D-06/D-07: cleaned suggestion == trimmed existingCode -> codeSuggestion null + fence stripped from body"
  - "D-09/D-10/D-11: title slice(0, 80), truncation LAST before parse; orphan titles get cleanText first (fold-in (c))"
  - "OD-6: code_suggestion: '' treated as absent (fail-open hardening)"
  - "D-08: drops ride the severityAuditEvents accumulator as one aggregate per (file, pass)"

patterns-established:
  - "cleanText hoisted out of the map callback so the orphan bucket shares the inline-title normalization"
  - "Resolved local codeSuggestion (null/undefined/string) passed to the parse, never finding.code_suggestion directly"

requirements-completed: [PRD-02]

coverage:
  - id: D1
    description: "Titles > 80 chars truncated to exactly 80 on every title-bearing parse surface, including off-diff orphans (cleanText + slice(0,80)); severity/category engine still saw the full title"
    requirement: PRD-02
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts#an 81-char title truncates to exactly 80 chars; an exactly-80-char title is unchanged (D-09/D-10)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#an off-diff 81-char title lands in the orphan bucket truncated to 80 chars (D-11)"
        status: pass
    human_judgment: false
  - id: D2
    description: "suggestion == existingCode (after trim, incl. fenced suggestions) clears to null and strips the redundant body fence; differing suggestions stay unchanged"
    requirement: PRD-02
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts#suggestion == existingCode clears codeSuggestion to null and strips the fence from the body (D-06)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#a FENCED suggestion identical to existingCode still clears (D-07 — the fence cannot dodge the check)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Non-empty suggestion + empty body drops the comment and emits a suggestion_dropped aggregate that renders between learned_rule_suppressed and rounds; code_suggestion ''/whitespace treated as absent (no whole-file parse throw)"
    requirement: PRD-02
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts#non-empty suggestion + whitespace-only body drops the comment and audits suggestion_dropped (D-05/D-08)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#code_suggestion: \"\" is treated as absent — the per-file parse never throws (fail-open hardening)"
        status: pass
      - kind: unit
        ref: "test/audit-grouping.spec.ts#Phase 33 (PRD-02 / FR-153, D-08) — suggestion_dropped is its own display group"
        status: pass
    human_judgment: false
  - id: D4
    description: "Clean findings round-trip byte-identically (NREG-01, REVIEWS R12)"
    requirement: PRD-02
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts#a clean finding round-trips byte-identically (NREG-01, REVIEWS R12)"
        status: pass
    human_judgment: false

duration: ~30min
completed: 2026-07-31
status: complete
---

# Phase 33 Plan 4: FR-153/FR-154 parse normalization Summary

**The parse pipeline now truncates titles to 80 chars (including off-diff orphans), drops comments with a suggestion-but-empty body, clears suggestions equal to existingCode (stripping the redundant fence), treats `code_suggestion: ""` as absent — and audits every FR-153 drop via a `suggestion_dropped` aggregate that renders in the dashboard**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-31T14:18:00Z
- **Completed:** 2026-07-31T14:28:00Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- `COMMENT_TITLE_MAX = 80` exported (orphan bucket + map callback both consume it, REVIEWS R8)
- FR-153 drop clause (non-empty suggestion + empty cleaned body → `return null` + audit) positioned AFTER the body-prefix strip and BEFORE the severity engine (REVIEWS R6 HIGH); drop evaluates the ORIGINAL suggestion + CLEANED body (D-07 order)
- D-06/D-07 clear clause: cleaned suggestion == trimmed existingCode → `codeSuggestion = null` + ```suggestion fence stripped from the posted body (reuses the `withSuggestion` normalization, so a fenced suggestion cannot dodge)
- Fail-open hardening (OD-6): `code_suggestion: ''` and whitespace-only treated as absent → `undefined` — closes the latent `z.string().min(1)` whole-file parse throw
- D-10 truncation runs LAST (after cleanText, body-prefix strip, severity engine, EVID-01 gate; immediately before the parse); resolved LOCAL `codeSuggestion` (null/undefined/string) passed, never `finding.code_suggestion`
- D-11 + consensus fold-in (c): orphan titles get the same `cleanText` normalization before `slice(0, 80)` — `cleanText` hoisted out of the map callback (behavior-neutral for inline comments)
- `suggestion_dropped` audit surface: schema arm (after `learned_rule_suppressed`), `buildSuggestionDroppedEvent` + `SUGGESTION_DROP_SAMPLE_CAP` + `SuggestionDropEntry`, accumulator wiring next to `buildEvidenceMissingSummary` (rides `severityAuditEvents` → `recordUnitAudit`, D-08); STAGE_ORDER 13 → 14 entries with `suggestion_dropped` at index 7, STAGE_LABELS + DecisionEvent case
- 12 new parse-pipeline tests + 4 builder tests + 2 grouping tests; the `./audit` imports were extended in place (REVIEWS R2 — no new import lines)

## Task Commits

Each task was committed atomically:

1. **Task 1: suggestion_dropped audit arm — schema, builder, builder tests** - `b42d55b` (feat)
2. **Task 2: Parse-pipeline producer + boundary specs** - `3d4e050` (feat)
3. **Task 3: suggestion_dropped viewer wiring** - `3d2a0f0` (feat)

## Files Created/Modified
- `src/shared/schema.ts` - `suggestion_dropped` arm after `learned_rule_suppressed`
- `src/server/core/audit.ts` - `buildSuggestionDroppedEvent`, `SuggestionDropEntry`, `SUGGESTION_DROP_SAMPLE_CAP`
- `src/server/core/model-output.ts` - `COMMENT_TITLE_MAX`, drop/clear clauses, truncation, ''-hardening, hoisted `cleanText`, accumulator + builder call
- `src/client/lib/audit-grouping.ts` - STAGE_ORDER 14 entries, `suggestion_dropped` at index 7
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` - STAGE_LABELS + DecisionEvent case
- `test/model-output.spec.ts` - 12 new FR-153/154 cases
- `test/audit-trail.spec.ts` - 5 builder cases incl. negative-droppedCount rejection
- `test/audit-grouping.spec.ts` - 14-entry toEqual + own-group describe

## Decisions Made
- OD-5: D-06 body revert reuses the inline `cleanBody` computation (`body.split('```suggestion')[0].trim()`), NOT `withSuggestion(body, null)` (which returns the body unchanged)
- OD-6: `code_suggestion: ''` IS treated as absent (fail-open, consistent with `coerceExistingCode`)
- OD-3 (for this event): stage literal `suggestion_dropped`, own STAGE_ORDER entry at index 7 (parse/finalize-drop family)

## Deviations from Plan

None - plan executed exactly as written. (One test-fixup: the orphan-title tests initially anchored findings at line 999, which `findClosestValidLine` remaps to the closest valid line when within 20 lines — the raw fixture was corrected so the finding's own `code_location` is honored; the code change itself matched the plan.)

## Issues Encountered
- Pre-existing (NOT caused by this plan): `test/add-bitbucket-workspace.spec.ts` "Test 3" fails at base commit `a9dc7cc` too (shared-DB test-state flake, documented in STATE.md). Untouched per the scope-boundary rule.
- The test helper `rawWith` initially overwrote a supplied `code_location` with the default line 2 — fixed to honor a finding-supplied location for the off-diff cases.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 33 complete: all 4 plans delivered. Final STAGE_ORDER is the planned 14-entry array; `parsedReviewCommentSchema` deliberately unchanged (producer-side normalization per RESEARCH §5.1); zero migrations, zero new dependencies.
- Ready for phase verification (VERIFICATION.md) and ROADMAP completion.

---
*Phase: 33-quality-fixes*
*Completed: 2026-07-31*
