---
phase: 23
slug: in-01-modellinecap-persistence-at-submit-time
status: signed-off
nyquist_compliant: true
wave_0_complete: true
validated: 2026-07-26
created: 2026-07-25
---

# Phase 23 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.9 |
| **Config file** | `vitest.config.mts` |
| **Quick run command** | `npx vitest run test/async-batch-review.spec.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run test/async-batch-review.spec.ts -t "submitReviewBatch"`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 23-01-T1 | 23-01 | 1 | AUD-03 | — | N/A | unit | `npx vitest run test/async-batch-review.spec.ts -t "submitReviewBatch.*modelLineCap"` | ✅ | ✅ green |
| 23-01-T2 | 23-01 | 1 | AUD-03 | — | N/A | integration | `npx vitest run test/review-flow.spec.ts -t "modelLineCap.*persisted"` | ✅ | ✅ green |
| 23-01-T3 | 23-01 | 1 | AUD-03 | — | N/A | migration | `npx vitest run test/migration-014-idempotency.spec.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `test/migration-014-idempotency.spec.ts` — verify migration 014 column exists, is nullable, is idempotent
- [x] `test/async-batch-review.spec.ts` — unit test: submitReviewBatch returns modelLineCap for both compact states
- [x] `test/review-flow.spec.ts` — integration test: submit→poll roundtrip with changing transient_error_count
- [x] Mock updates: every submitReviewBatch mock includes modelLineCap in return object

---

## Manual-Only Verifications

*None — all phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** signed-off — all 3 test files confirmed present and covering AUD-03 requirements; migration-014-idempotency.spec.ts verifies column exists/is nullable/idempotent; async-batch-review.spec.ts tests modelLineCap return for both compact states; review-flow.spec.ts tests submit→poll roundtrip; all submitReviewBatch mocks include modelLineCap.
