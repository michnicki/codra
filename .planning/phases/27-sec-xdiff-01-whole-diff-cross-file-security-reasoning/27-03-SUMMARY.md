---
phase: 27-sec-xdiff-01-whole-diff-cross-file-security-reasoning
plan: 27-03
subsystem: ui
tags: [react, dashboard, toggle, cross-file-security]

requires:
  - phase: 27
    provides: cross_file schema field and pipeline wiring
provides:
  - Dashboard UI toggle for cross_file security pass
affects: [27-sec-xdiff-01]

tech-stack:
  added: []
  patterns: [toggle-row-pattern]

key-files:
  created: []
  modified:
    - src/client/components/features/repos/review-settings-panel.tsx

key-decisions:
  - "Toggle placed in Passes section immediately after Security pass, before Critic pass — groups related security toggles together"
  - "Follows existing security toggle pattern exactly: state variable + dirty tracking + immutable nested spread + useEffect dep + ToggleRow"

patterns-established:
  - "Cross-file toggle follows the same UI pattern as security.enabled and critic.enabled toggles"

requirements-completed: [SEC-XDIFF-01]

coverage:
  - id: D1
    description: "Cross-file security toggle in dashboard Passes section reading/writing passes.security.cross_file"
    requirement: SEC-XDIFF-01
    verification:
      - kind: unit
        ref: "npm run typecheck — passes with no errors"
        status: pass
      - kind: integration
        ref: "ToggleRow renders between Security pass and Critic pass in review-settings-panel.tsx"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-07-31
status: complete
---

# Phase 27 Plan 27-03: Dashboard UI for Cross-File Security Toggle Summary

**Cross-file security toggle added to the Passes section of ReviewSettingsPanel, wired to passes.security.cross_file with full dirty tracking**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-31T07:26:59Z
- **Completed:** 2026-07-31T07:30:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added `crossFileEnabled` state variable initialized from `current.passes.security.cross_file`
- Updated `review` object construction with `cross_file: crossFileEnabled` in immutable nested spread
- Added dirty tracking for `crossFileEnabled !== current.passes.security.cross_file`
- Added `crossFileEnabled` to useEffect dependency array
- Added ToggleRow labeled "Cross-file security" in Passes section between Security pass and Critic pass
- `npm run typecheck` passes with no errors

## Task Commits

1. **Task 1: Add cross_file toggle to ReviewSettingsPanel** - `168846f` (feat)

## Files Created/Modified
- `src/client/components/features/repos/review-settings-panel.tsx` - Added cross-file security toggle state, dirty tracking, and ToggleRow UI

## Decisions Made
- Toggle placed immediately after Security pass in the Passes section to group related security toggles
- Follows the exact same pattern as existing security.enabled and critic.enabled toggles (state + dirty + spread + dep + ToggleRow)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Phase 27 complete (3/3 plans). All SEC-XDIFF-01 pipeline, walkthrough, and UI components are in place.

---
*Phase: 27-sec-xdiff-01-whole-diff-cross-file-security-reasoning*
*Completed: 2026-07-31*
