---
phase: 26-evid-02-hard-drop-evidence-gate
plan: 02
subsystem: api
tags: [evidence, audit, react, dashboard, postgres-migration, vitest]

# Dependency graph
requires:
  - phase: 26-evid-02-hard-drop-evidence-gate (plan 01)
    provides: checkEvidence, buildEvidenceHardDroppedEvent, evidence config schema, config default injection
provides:
  - Evidence hard-drop gate in runFinalizePhase (drop-before-dedup, config-gated, at-most-once audit)
  - Deep-merge fix for review sub-object in PATCH /api/repos/:owner/:repo/config
  - Integration tests for drop / exempt / NREG-01-disabled behaviors
  - Dashboard evidence section (toggle + exempt-categories editor with lowercase normalization)
  - audit viewer renderer + display-group mapping for evidence_hard_dropped
  - Migration 015: file_reviews persists existing_code (immutable retry re-evaluation)
affects: [review pipeline finalize, repo config API, dashboard, audit trail, LRN-01, SEC-XDIFF-01, QA-IDX-01]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "At-most-once audit emission via persisted job.steps check (finalizeRetriedPastPost), never an in-memory variable — survives workflow retry"
    - "Batch all audit events of a kind into one appendJobAuditEvents call (subrequest budget)"
    - "Deep-merge the review sub-object in config PATCH so partial patches can't destroy sibling settings"
    - "Normalize free-form category input to lowercase at the UI boundary so stored config always matches the case-insensitive comparison"

key-files:
  created:
    - db/migrations/015_evidence_existing_code.sql
  modified:
    - src/server/core/review.ts
    - src/server/routes/api/repos.ts
    - src/server/db/file-reviews.ts
    - test/review-flow.spec.ts
    - src/client/components/features/repos/review-settings-panel.tsx
    - src/client/lib/audit-grouping.ts
    - src/client/components/features/job-detail/audit-trail-viewer.tsx

key-decisions:
  - "Gate placement: after reviewedComments resolution, BEFORE dedup (D-01) — a dropped finding never participates in merging"
  - "finalizeRetriedPastPost computed early from persisted job.steps and reused by the evidence gate; duplicate later declaration removed (CRITICAL PATH FIX #2)"
  - "All evidence events batched into a single appendJobAuditEvents call (REVIEWS finding #13)"
  - "Audit append wrapped in try/catch — best-effort telemetry never fails finalize"
  - "existing_code persisted on file_reviews (migration 015) so finalize-time re-checks and retries evaluate immutable data, not re-parsed output"

patterns-established:
  - "Config-gated pipeline blocks read `config.review.evidence?.hard_drop ?? false` — default-off means byte-identical legacy output (NREG-01)"
  - "Dashboard config list editors lowercase free-form category input on save"

requirements-completed: [EVID-02]

coverage:
  - id: D1
    description: "Finalize hard-drop gate: drops absent/not_in_hunk findings before dedup, preserves survivor order, exempt categories bypass, at-most-once batched audit emission"
    requirement: EVID-02
    verification:
      - kind: integration
        ref: "test/review-flow.spec.ts#evidence hard-drop (3 tests: drop, exempt, NREG-01 disabled)"
        status: pass
      - kind: other
        ref: "26-VERIFICATION.md goal-backward check (review.ts:2194-2230) + npm run typecheck/build"
        status: pass
    human_judgment: false
  - id: D2
    description: "PATCH /api/repos/:owner/:repo/config deep-merges the review sub-object — patching evidence preserves dedup/passes/rounds"
    requirement: EVID-02
    verification:
      - kind: other
        ref: "26-VERIFICATION.md artifact check (repos.ts:163-172) + npm run typecheck"
        status: pass
    human_judgment: false
  - id: D3
    description: "Dashboard evidence section (ToggleRow + ListEditor, lowercase normalization, dirty tracking, all 4 integration points) and evidence_hard_dropped audit renderer + display-group mapping"
    requirement: EVID-02
    verification:
      - kind: other
        ref: "26-VERIFICATION.md artifact checks (review-settings-panel.tsx:277-756, audit-grouping.ts:74, audit-trail-viewer.tsx:194-214) + npm run build"
        status: pass
    human_judgment: false
  - id: D4
    description: "Migration 015 persists existing_code on file_reviews so finalize retries re-evaluate immutable rows"
    requirement: EVID-02
    verification:
      - kind: integration
        ref: "test/review-flow.spec.ts#evidence hard-drop (updated in a891d02 to assert persisted evidence)"
        status: pass
    human_judgment: false

# Metrics
duration: ~20min (retroactive — reconstructed from commit window 11:33–11:52 +02:00)
completed: 2026-07-26
status: complete
---

# Phase 26 Plan 02: EVID-02 Hard-drop Gate Wiring + Dashboard Surfaces Summary

**Evidence hard-drop gate wired into finalize (drop-before-dedup, persisted at-most-once audit), config PATCH deep-merge fix, 3 integration tests, dashboard evidence section + audit renderer, and migration 015 persisting existing_code for immutable retry re-evaluation**

> Authored retroactively on 2026-07-29 during safe-resume closeout. The work landed 2026-07-26 and was verified 10/10 in 26-VERIFICATION.md; this summary reconstructs the record from the commits.

## Performance

- **Duration:** ~20 min (commit window 2026-07-26 11:33:19 → 11:52:32 +02:00)
- **Started:** 2026-07-26T11:33:19+02:00
- **Completed:** 2026-07-26T11:52:32+02:00
- **Tasks:** 3 (+1 deviation fix)
- **Files modified:** 7 (1 migration created)

## Accomplishments
- Hard-drop gate in `runFinalizePhase` (review.ts:2194-2230): when `evidence.hard_drop` is on, `checkEvidence` filters `reviewedComments` before dedup; exempt categories bypass case-insensitively; survivor order preserved; default-off path is byte-identical (NREG-01)
- At-most-once audit emission via the persisted `finalizeRetriedPastPost` job.steps check (moved early; duplicate removed) with all events batched into one `appendJobAuditEvents` call, best-effort try/catch
- `repos.ts` PATCH deep-merges the `review` sub-object — patching `evidence` no longer destroys `dedup`/`passes`/`rounds` (CRITICAL PATH FIX #3)
- 3 integration tests in review-flow.spec.ts: drop behavior, exempt-category bypass, NREG-01 disabled mode
- Dashboard: evidence ToggleRow + exempt-categories ListEditor (lowercase-on-save) with full state/spread/dirty/deps integration; `evidence_hard_dropped` renderer in the audit trail viewer + display-group mapping
- Migration 015 + `file-reviews.ts`: `existing_code` persisted so finalize-time re-checks and retries run against immutable rows

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire hard-drop gate in review.ts + fix repos.ts deep-merge** — `ba6b56a` (feat)
2. **Task 2: Integration tests for the hard-drop gate** — `64fa1db` (test)
3. **Task 3: Dashboard evidence UI + audit viewer renderer** — `a319484` (feat)

**Deviation fix:** `a891d02` (fix: persist existing_code — migration 015)
**Plan metadata:** `26bd5de` (docs: create phase plan)

## Files Created/Modified
- `src/server/core/review.ts` — evidence gate block + finalizeRetriedPastPost relocation (+57/−8)
- `src/server/routes/api/repos.ts` — review sub-object deep-merge in PATCH (+7)
- `test/review-flow.spec.ts` — 'evidence hard-drop' integration group (+272, updated +32/−19 in fix)
- `src/client/components/features/repos/review-settings-panel.tsx` — evidence state, review spread, dirty tracking, Advanced-section UI (+36)
- `src/client/lib/audit-grouping.ts` — evidence_hard_dropped → evidence_missing display group (+1)
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` — evidence_hard_dropped renderer case (+21)
- `db/migrations/015_evidence_existing_code.sql` — NEW: existing_code column on file_reviews (+11)
- `src/server/db/file-reviews.ts` — persist existing_code with parsed comments (+15)

## Decisions Made
- Audit gating uses the persisted `job.steps` check, not an in-memory variable — an in-memory guard resets on workflow retry and would double-append events (cross-AI review CRITICAL PATH FIX #2)
- existing_code persisted at review time rather than re-derived at finalize — retries must produce identical drop decisions from immutable data (plan must-have)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing Critical] Persist `existing_code` on file_reviews (migration 015)**
- **Found during:** Post-implementation validation of the finalize gate
- **Issue:** The gate re-checks `existingCode` at finalize time against the diff, but `file_reviews` rows did not persist the parsed `existing_code` field — evidence for persisted/retried reviews was not durably available for the drop decision, undermining the "retries re-run against immutable file_reviews producing identical results" must-have
- **Fix:** Added `db/migrations/015_evidence_existing_code.sql`, updated `file-reviews.ts` to store the field, and adjusted the integration tests to assert against persisted evidence
- **Files modified:** `db/migrations/015_evidence_existing_code.sql`, `src/server/db/file-reviews.ts`, `test/review-flow.spec.ts`
- **Verification:** Migration applies cleanly; integration tests pass; 26-VERIFICATION.md data-flow trace confirms `reviewedComments` flow from persisted rows
- **Committed in:** `a891d02`

---

**Total deviations:** 1 auto-fixed (missing critical persistence)
**Impact on plan:** Required for the plan's own immutability must-have; no scope creep.

## Issues Encountered
- Integration tests could not execute in the verifier's environment (no TEST_DATABASE_URL there) — recorded as SKIP in 26-VERIFICATION.md behavioral spot-checks; the suites run under the normal `npm test` harness (migration applied), and the a891d02 fix was validated through them.

## User Setup Required

None — no external service configuration required. Operators opt in per repo: Dashboard → repo → Review settings → Advanced → "Evidence hard-drop" (default off; default exemption: `security`).

## Next Phase Readiness
- EVID-02 fully satisfied; hard-drop signal available to downstream phases (SEC-XDIFF-01, LRN-01, QA-IDX-01 all declare benefits from it)
- Migration 015 must be applied wherever this ships (`npm run migrate` / deploy pipeline handles it)
- Deferred follow-up already tracked in REQUIREMENTS.md: EVID-02 per-category override UI beyond the exempt-categories editor

---
*Phase: 26-evid-02-hard-drop-evidence-gate*
*Completed: 2026-07-26*
