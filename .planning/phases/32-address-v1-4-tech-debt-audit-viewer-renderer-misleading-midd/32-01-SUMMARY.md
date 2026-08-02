---
phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
plan: 32-01
subsystem: database, api
tags: [typescript, types, middleware, comments]

requires:
  - phase: 32
    provides: plan scope from v1.4 milestone audit
provides:
  - FileReviewPass type used consistently in getFileReviewsForJobs
  - Middleware comments accurately describe group-level /api/* protection
affects: [file-reviews, repos-api, type-safety]

tech-stack:
  added: []
  patterns: [canonical-type-import, accurate-middleware-documentation]

key-files:
  created: []
  modified:
    - src/server/db/file-reviews.ts
    - src/server/routes/api/repos.ts

key-decisions:
  - "Use imported FileReviewPass type instead of hardcoded union to prevent schema drift"
  - "Middleware comments must describe actual protection mechanism (group-level app.use), not claim per-route middleware"

patterns-established:
  - "Canonical type import: always use the imported type from @shared/schema rather than duplicating the union inline"

requirements-completed: [TECHDEBT-32]

coverage:
  - id: D1
    description: "FileReviewPass type used consistently in getFileReviewsForJobs query row type"
    requirement: TECHDEBT-32
    verification:
      - kind: unit
        ref: "npm run typecheck"
        status: pass
      - kind: unit
        ref: "grep check: no hardcoded 'main' | 'security' | 'cross_file_security' union in file-reviews.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Middleware comments accurately describe group-level /api/* protection on learned-rules endpoints"
    requirement: TECHDEBT-32
    verification:
      - kind: unit
        ref: "grep check: no 'explicit.*requireSession' claims in repos.ts"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-07-31
status: complete
---

# Plan 32-01: Mechanical code fixes — type union + misleading comment

**Replaced hardcoded type union with canonical FileReviewPass import and corrected misleading middleware comments on learned-rules API routes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-31
- **Completed:** 2026-07-31
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Replaced hardcoded `'main' | 'security' | 'cross_file_security'` type union at file-reviews.ts:477 with the already-imported `FileReviewPass` type to prevent schema drift
- Corrected two misleading comments on learned-rules API routes that claimed explicit per-route `requireSession + requireCsrfHeader` middleware when protection comes from the group-level `app.use('/api/*')` middleware in app.ts

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace hardcoded type union with FileReviewPass** - `84940a1` (fix)
2. **Task 2: Correct misleading middleware comments** - `6208087` (fix)

**Plan metadata:** (docs: complete plan)

## Files Created/Modified
- `src/server/db/file-reviews.ts` - Replaced hardcoded type union with FileReviewPass at line 477
- `src/server/routes/api/repos.ts` - Corrected misleading middleware comments at lines 509-510 and 576

## Decisions Made
- Use the imported `FileReviewPass` type from `@shared/schema` instead of duplicating the union inline — prevents the type annotation from drifting when new pass types are added to the schema
- Middleware comments must describe the actual protection mechanism (group-level `app.use('/api/*', requireSession, requireCsrfHeader)` in app.ts), not claim per-route middleware that doesn't exist

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both mechanical fixes complete; typecheck passes; no runtime behavior change
- Ready for remaining Phase 32 plans

---
*Phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd*
*Completed: 2026-07-31*
