---
phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
plan: 32-05
subsystem: testing
tags: [vitest, fake-timers, withRetry, exponential-backoff, test-hygiene, audit-trail-viewer]

requires:
  - phase: 28
    provides: learned_rule_suppressed audit event rendering in audit-trail-viewer
provides:
  - Verified D-01 stale audit finding already fixed
  - All withRetry exponential backoff tests use fake timers with proper cleanup
affects: []

tech-stack:
  added: []
  patterns: [vi.useFakeTimers with try/finally cleanup for withRetry tests]

key-files:
  created:
    - .planning/phases/32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd/32-05-SUMMARY.md
  modified:
    - test/model-service.spec.ts
    - test/bitbucket-client.spec.ts

key-decisions:
  - "D-01 verified as stale: audit-trail-viewer.tsx already has case 'learned_rule_suppressed' at line 223 (commit c94aeb6, 2026-07-27)"
  - "Fake timers scoped with try/finally blocks per review concern (Antigravity LOW)"
  - "Only tests actually exercising real withRetry delays were modified — no broader test coverage pass"

patterns-established:
  - "vi.useFakeTimers() + promise.catch() + vi.runAllTimersAsync() + await promise pattern for retry tests"

requirements-completed: [TECHDEBT-32]

coverage:
  - id: D1
    description: "audit-trail-viewer renders learned_rule_suppressed events"
    requirement: TECHDEBT-32
    verification:
      - kind: unit
        ref: "grep -q 'learned_rule_suppressed' src/client/components/features/job-detail/audit-trail-viewer.tsx"
        status: pass
    human_judgment: false
  - id: D2
    description: "All withRetry exponential backoff tests use fake timers with proper cleanup"
    requirement: TECHDEBT-32
    verification:
      - kind: unit
        ref: "test/model-service.spec.ts - retries Google once for transient 524 edge timeouts (33ms, was 991ms)"
        status: pass
      - kind: unit
        ref: "test/bitbucket-client.spec.ts - deleteCodeInsightsReport rethrows a non-404 BitbucketError (7ms, was 6009ms)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-31
status: complete
---

# Plan 32-05: Verification + test hygiene — audit viewer & withRetry mocking

**Verified stale D-01 audit finding already fixed; added fake timers to 2 slow withRetry tests reducing wall-clock by ~7s**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-31T10:20:00Z
- **Completed:** 2026-07-31T10:32:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Verified D-01: `audit-trail-viewer.tsx` already renders `learned_rule_suppressed` events (case at line 223, label at line 22, comment at line 216) — fix landed in commit c94aeb6 (quick task 260727-hvc, 2026-07-27)
- Added `vi.useFakeTimers()` with `try/finally` cleanup to `model-service.spec.ts` "retries Google once for transient 524 edge timeouts" (991ms → 33ms)
- Added `vi.useFakeTimers()` with `try/finally` cleanup to `bitbucket-client.spec.ts` "deleteCodeInsightsReport rethrows a non-404 BitbucketError (500)" (6009ms → 7ms)
- No other tests >1s found via `--reporter=verbose` scan of all node tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Verify D-01** - (verification only, no code change, no commit needed)
2. **Task 2: Mock withRetry delays** - `pending` (test: add fake timers to slow withRetry tests)

**Plan metadata:** `pending` (docs: complete plan)

## Files Created/Modified

- `test/model-service.spec.ts` — Added `vi.useFakeTimers()`/`try/finally` to "retries Google once for transient 524 edge timeouts" test
- `test/bitbucket-client.spec.ts` — Added `vi.useFakeTimers()`/`try/finally` to "deleteCodeInsightsReport rethrows a non-404 BitbucketError (500)" test

## Decisions Made

- D-01 verified as already fixed: the audit-trail-viewer has had `learned_rule_suppressed` rendering since commit c94aeb6 (2026-07-27). The v1.4 milestone audit ran before this fix landed, making the W-1 warning stale.
- Only 2 tests were identified as >1s via `--reporter=verbose` scan: model-service (991ms) and bitbucket-client (6009ms). The bitbucket-adapter.spec.ts file has no retry-related tests. The ensemble-temperature.spec.ts already uses fake timers.
- Fake timers scoped with `try/finally` blocks per review concern (Antigravity LOW) to prevent state leakage.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Many tests fail due to missing `BITBUCKET_CLIENT_ID` env var (pre-existing environment issue — DB-gated tests require `TEST_DATABASE_URL`). This is documented in STATE.md Blockers/Concerns.
- Browser tests fail due to missing `libgbm.so.1` (pre-existing NixOS environment issue). Node tests pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 32-05 complete. All slow retry tests now use fake timers.
- Test suite wall-clock improvement: ~7s saved from the two fixed tests.

---
*Phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd*
*Completed: 2026-07-31*
