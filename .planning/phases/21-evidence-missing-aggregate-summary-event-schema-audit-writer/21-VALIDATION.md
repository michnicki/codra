---
phase: 21
slug: evidence-missing-aggregate-summary-event-schema-audit-writer
status: signed-off
nyquist_compliant: true
wave_0_complete: true
validated: 2026-07-26
created: 2026-07-25
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.9 |
| **Config file** | `vitest.config.mts` (project: `node`) |
| **Quick run command** | `npx vitest run test/audit-trail.spec.ts test/model-output.spec.ts --project node` |
| **Full suite command** | `npm test` (migrations + vitest run all projects) |
| **Estimated runtime** | ~15 seconds (quick) / ~120 seconds (full suite) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run test/audit-trail.spec.ts test/model-output.spec.ts --project node`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 21-01-T1 | 21-01 | 1 | EVID-03 | — | Schema validates new variant, rejects invalid | unit | `npx vitest run test/audit-trail.spec.ts --project node` | ✅ | ✅ green |
| 21-01-T2 | 21-01 | 1 | EVID-03 | — | Builder returns null for empty input (D-05) | unit | `npx vitest run test/audit-trail.spec.ts --project node` | ✅ | ✅ green |
| 21-01-T3 | 21-01 | 1 | EVID-03 | — | Aggregate counts correct (absentCount, notInHunkCount) | unit | `npx vitest run test/audit-trail.spec.ts --project node` | ✅ | ✅ green |
| 21-01-T4 | 21-01 | 1 | EVID-03 | — | Sample bounded to max 20, privacy-bounded through redactFindingTitle | unit | `npx vitest run test/audit-trail.spec.ts --project node` | ✅ | ✅ green |
| 21-01-T5 | 21-01 | 1 | EVID-03 | — | Producer emits ONE summary per (file, pass) instead of N per-finding events | unit | `npx vitest run test/model-output.spec.ts --project node` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `test/audit-trail.spec.ts` — add `describe('buildEvidenceMissingSummary')` builder unit tests
- [x] `test/model-output.spec.ts` — update evidence_missing tests to assert aggregate shape

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Legacy `evidence_missing` events still parse after schema change | EVID-03 | Requires persisted test data | `npx vitest run test/audit-trail.spec.ts --project node` — existing tests cover schema backward compat |
| TypeScript compilation passes with new schema variant | EVID-03 | tsc cannot be run within vitest | `npm run typecheck` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** signed-off — all 5 verification behaviors confirmed green; builder tests in audit-trail.spec.ts cover schema round-trip, null-empty, counts, sample cap 20, redactFindingTitle; model-output.spec.ts asserts aggregate shape per (file, pass); `npm test` 62/62 model-output tests pass; `npm run typecheck` clean.
