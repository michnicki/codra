---
phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
plan: 32-02
subsystem: testing
tags: [vitest, phase-routing, schema, config-defaults, drift-detection]

requires:
  - phase: 27
    provides: nextPhaseAfterCrossFileSecurity selector in phase-routing.ts
provides:
  - Unit test coverage for nextPhaseAfterCrossFileSecurity selector (6 test cases)
  - Config-default drift detection covering all leaf nodes of repoConfigSchema
affects: [32]

tech-stack:
  added: []
  patterns: [per-field-assertion-drift-test]

key-files:
  created: []
  modified:
    - test/phase-routing.spec.ts
    - test/schema-contract-inertness.spec.ts

key-decisions:
  - "Each config leaf gets its own it() block so drift failures pinpoint the exact field"
  - "Pre-existing env issue (BITBUCKET_CLIENT_ID missing) in runReviewJob critic test is not addressed — out of scope"

patterns-established:
  - "Config-default drift detection pattern: per-field assertions in their own it() blocks covering all leaf nodes of a Zod schema's .parse({}) output"

requirements-completed:
  - TECHDEBT-32

coverage:
  - id: D1
    description: "nextPhaseAfterCrossFileSecurity selector unit tests — 6 dedicated test cases covering all branch paths"
    requirement: TECHDEBT-32
    verification:
      - kind: unit
        ref: "test/phase-routing.spec.ts#phase-routing: nextPhaseAfterCrossFileSecurity"
        status: pass
    human_judgment: false
  - id: D2
    description: "Config-default drift detection covering all leaf nodes of repoConfigSchema.parse({})"
    requirement: TECHDEBT-32
    verification:
      - kind: unit
        ref: "test/schema-contract-inertness.spec.ts#D-07: config-default drift detection"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-07-31
status: complete
---

# Phase 32 Plan 32-02: Test additions — selector coverage + config-default drift Summary

**nextPhaseAfterCrossFileSecurity selector unit tests (6 cases covering all branches) and config-default drift detection covering every leaf node of repoConfigSchema.parse({})**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-31T09:59:00Z
- **Completed:** 2026-07-31T10:04:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Added 6 dedicated unit tests for nextPhaseAfterCrossFileSecurity selector covering all branch paths (finalize, verify_fixes, critic, walkthrough_enrichment, all-on, cross_file-off+verify_fixes-on)
- Extended full-chain test to assert cross_file_security feeds into the same chain
- Added D-07 config-default drift detection with per-field assertions for every leaf node of repoConfigSchema.parse({}) — 20+ it() blocks covering review scalars, exec, walkthrough, passes, interactive, severity_engine, dedup, file_selection, category_confidence, threads, rounds, evidence, learning, bitbucket, and model defaults

## Task Commits

1. **Task 1: nextPhaseAfterCrossFileSecurity selector tests** - `18cf5c1` (test)
2. **Task 2: config-default drift detection** - `4641128` (test)

## Files Created/Modified
- `test/phase-routing.spec.ts` - Added nextPhaseAfterCrossFileSecurity import + 6 test cases + cross_file_security assertion in full-chain block
- `test/schema-contract-inertness.spec.ts` - Added D-07 describe block with 20+ per-field assertion it() blocks

## Decisions Made
- Each config leaf gets its own it() block so drift failures pinpoint the exact field that changed (not a monolithic deep-equal)
- Pre-existing env issue (BITBUCKET_CLIENT_ID missing) in the runReviewJob critic test is not addressed — out of scope for this plan

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test `runReviewJob acks a phase:"critic" message before any DB access` fails in this environment due to missing `BITBUCKET_CLIENT_ID` env var. Not caused by this plan's changes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both test files pass (28 + 32 new tests in phase-routing, 32 passing in schema-contract-inertness)
- typecheck passes (tsc --noEmit exit 0)
- Ready for next plan in Phase 32

---
*Phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd*
*Completed: 2026-07-31*
