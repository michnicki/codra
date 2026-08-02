---
phase: 26-evid-02-hard-drop-evidence-gate
plan: 01
subsystem: api
tags: [zod, evidence, audit, hallucination-guard, vitest]

# Dependency graph
requires:
  - phase: 21-evid-03-bounded-evidence-telemetry
    provides: EVID-01 parse-time evidence check in model-output.ts + evidence_missing_summary audit event (the algorithm extracted here)
provides:
  - evidence config block in reviewConfigSchema (hard_drop toggle + hard_drop_exempt_categories bounded at 20)
  - evidence_hard_dropped variant in jobAuditEventSchema
  - core/evidence.ts shared checkEvidence module (EVID-01 and EVID-02 consume one algorithm)
  - buildEvidenceHardDroppedEvent audit builder
  - loadRepoConfig re-parse through repoConfigSchema.parse() so pre-evidence DB configs get Zod defaults
affects: [26-02 finalize wiring, EVID-01, audit trail, repo config]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared-algorithm extraction: parse-time (EVID-01) and finalize-time (EVID-02) evidence checks consume one checkEvidence implementation to prevent drift"
    - "Load-time Zod default injection: DB-loaded configs re-parsed through repoConfigSchema.parse() so keys added after a config was stored always materialize defaults"
    - "Bounded config arrays: hard_drop_exempt_categories capped at .max(20), mirroring the custom_rules .max(50) precedent"

key-files:
  created:
    - src/server/core/evidence.ts
    - test/evidence.spec.ts
  modified:
    - src/shared/schema.ts
    - src/server/core/model-output.ts
    - src/server/core/config.ts
    - src/server/core/audit.ts
    - test/model-output.spec.ts
    - test/model-service.spec.ts

key-decisions:
  - "Bound hard_drop_exempt_categories at 20 items (defense-in-depth against config bloat; custom_rules .max(50) precedent)"
  - "Default exemption ['security'] — security findings always post regardless of evidence quality; operators can set [] for no exemptions"
  - "Exempt-category comparison is case-insensitive on both sides ('SECURITY'/'Security' match 'security') — a case-sensitive check would silently bypass exemptions"
  - "Extract, don't duplicate: model-output.ts EVID-01 path refactored onto the shared module with byte-identical haystack construction"
  - "Config default injection placed in loadRepoConfig after the model override, covering every DB config regardless of age"

patterns-established:
  - "checkEvidence returns { kept, dropped, entries } — callers choose filter-vs-audit posture (EVID-01 uses entries only; EVID-02 uses kept + entries)"
  - "Audit builders return null for empty entry sets (no zero-count events) and cap samples at 20"

requirements-completed: [EVID-02]

coverage:
  - id: D1
    description: "Evidence config schema (bounded) + evidence_hard_dropped audit event + repoConfigSchema inline default + config.ts load-time default injection"
    requirement: EVID-02
    verification:
      - kind: unit
        ref: "test/schema-contract-inertness.spec.ts#repoConfigSchema"
        status: pass
      - kind: other
        ref: "npm run typecheck && npm run build"
        status: pass
    human_judgment: false
  - id: D2
    description: "checkEvidence extracted to core/evidence.ts; model-output.ts EVID-01 behavior unchanged (62/62 regression tests)"
    requirement: EVID-02
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts"
        status: pass
      - kind: unit
        ref: "test/evidence.spec.ts#checkEvidence (12 tests incl. case-insensitive exemption + cross-consistency)"
        status: pass
    human_judgment: false
  - id: D3
    description: "buildEvidenceHardDroppedEvent produces schema-valid events, null on empty, sample capped at 20 with redacted titles + reason"
    requirement: EVID-02
    verification:
      - kind: unit
        ref: "test/evidence.spec.ts#buildEvidenceHardDroppedEvent (5 tests)"
        status: pass
    human_judgment: false

# Metrics
duration: ~10min (retroactive — reconstructed from commit window 11:19–11:25 +02:00)
completed: 2026-07-26
status: complete
---

# Phase 26 Plan 01: EVID-02 Evidence Gate Building Blocks Summary

**Evidence config schema (bounded at 20), shared checkEvidence module extracted from model-output.ts, buildEvidenceHardDroppedEvent audit builder, and load-time Zod default injection — the contract layer for the hard-drop gate wired in 26-02**

> Authored retroactively on 2026-07-29 during safe-resume closeout. The work landed 2026-07-26 and was verified 10/10 in 26-VERIFICATION.md; this summary reconstructs the record from the commits. Unit suites re-confirmed green at closeout (79/79: evidence 17 + model-output 62).

## Performance

- **Duration:** ~10 min (commit window 2026-07-26 11:19:39 → 11:25:22 +02:00)
- **Started:** 2026-07-26T11:19:39+02:00
- **Completed:** 2026-07-26T11:25:22+02:00
- **Tasks:** 3
- **Files modified:** 7 (2 created)

## Accomplishments
- `evidence` config block in `reviewConfigSchema` — `hard_drop` (default false) + `hard_drop_exempt_categories` (`.max(20)`, default `['security']`) — plus the matching inline default literal in `repoConfigSchema`
- `evidence_hard_dropped` variant in `jobAuditEventSchema` (file, pass, droppedCount, sample capped at 20 with path/line/title/reason)
- `core/evidence.ts`: shared `checkEvidence(files, comments, exemptCategories)` with case-insensitive exemptions; `model-output.ts` EVID-01 path refactored onto it with zero behavior change (62/62 existing tests pass)
- `config.ts` `loadRepoConfig` re-parses DB-loaded config through `repoConfigSchema.parse()` — pre-evidence DB configs always get Zod defaults (CRITICAL PATH FIX #1 from cross-AI review)
- `buildEvidenceHardDroppedEvent` in `audit.ts` (null on empty, 20-sample cap, `redactFindingTitle`, `satisfies JobAuditEvent`) + 17 unit tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Evidence config schema + audit event + config.ts default injection** — `6c4256b` (feat)
2. **Task 2: Extract checkEvidence to core/evidence.ts + refactor model-output.ts** — `efa6f67` (feat)
3. **Task 3: buildEvidenceHardDroppedEvent + 17 unit tests** — `54ec904` (feat)

**Plan metadata:** `26bd5de` (docs: create phase plan)

## Files Created/Modified
- `src/shared/schema.ts` — evidence config block, audit event variant, inline default literal (+38)
- `src/server/core/evidence.ts` — NEW: checkEvidence, EvidenceCheckResult, EvidenceDropEntry, normalizeForEvidence, stripLeadingDiffMarkers (+134)
- `src/server/core/model-output.ts` — refactored onto shared evidence module (−44 net)
- `src/server/core/config.ts` — repoConfigSchema.parse() default injection in loadRepoConfig (+5)
- `src/server/core/audit.ts` — buildEvidenceHardDroppedEvent + EVIDENCE_HARD_DROP_SAMPLE_CAP (+55)
- `test/evidence.spec.ts` — NEW: 17 unit tests (12 checkEvidence incl. case-insensitive + cross-consistency, 5 builder) (+289)
- `test/model-output.spec.ts`, `test/model-service.spec.ts` — small parity adjustments for the refactor/schema default

## Decisions Made
- Bounded `hard_drop_exempt_categories` at 20 items (Antigravity MEDIUM finding in 26-REVIEWS.md), mirroring the `custom_rules` `.max(50)` precedent
- Case-insensitive exempt-category comparison enforced in checkEvidence (plan prohibition; silent-bypass risk)
- Default injection implemented as a re-parse in `loadRepoConfig` rather than per-key patching — future schema additions get defaults automatically

## Deviations from Plan

None — plan executed as written. (`test/model-service.spec.ts` +1 line rode along in the Task 1 commit: assertion parity for the new schema default. No behavior change.)

## Issues Encountered

None recorded.

## User Setup Required

None — no external service configuration required. The toggle ships default-off (`evidence.hard_drop: false`); operators enable it per-repo via the dashboard UI delivered in 26-02.

## Next Phase Readiness
- All building blocks consumed by 26-02 (checkEvidence, builder, schema types, config defaults) are in place and verified
- EVID-01 parse-time behavior preserved (audit-only soft gate); legacy `evidence_missing` variant untouched

---
*Phase: 26-evid-02-hard-drop-evidence-gate*
*Completed: 2026-07-26*
