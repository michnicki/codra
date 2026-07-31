---
phase: 33
slug: quality-fixes
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-31
---

# Phase 33 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.mts` |
| **Quick run command** | `npx vitest run test/model-output.spec.ts test/vcs-github-adapter.spec.ts test/bitbucket-adapter.spec.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~120 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run test/model-output.spec.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 33-01 | 33-01 | 1 | PRD-01 (FR-031) | T-33-01 / — | N/A — no auth/input-boundary change; retry path only | unit | `npx vitest run test/vcs-github-adapter.spec.ts test/bitbucket-adapter.spec.ts` | ✅ | ✅ green |
| 33-03 | 33-03 | 2 | PRD-01 (FR-031) | — | N/A — audit event + additive schema arm, no security boundary | unit | `npx vitest run test/review-flow.spec.ts test/audit-trail.spec.ts test/audit-grouping.spec.ts` | ✅ | ✅ green |
| 33-02 | 33-02 | 1 | PRD-03 (FR-155) | — | N/A — pure string sanitization | unit | `npx vitest run test/model-output.spec.ts` | ✅ | ✅ green |
| 33-04 | 33-04 | 3 | PRD-02 (FR-153/FR-154) | — | N/A — output normalization, no security boundary | unit | `npx vitest run test/model-output.spec.ts test/audit-trail.spec.ts test/audit-grouping.spec.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements (vitest + DB-gated test harness already installed; model-output specs are pure, no DB).

---

## Manual-Only Verifications

All phase behaviors have automated verification. Nothing escalated.

Known pre-existing (not Phase 33): `test/add-bitbucket-workspace.spec.ts` "Test 3" and the `review-flow` modelLineCap persistence test fail on a shared test DB that has accumulated rows across runs — documented STATE.md "Test DB accumulates rows" blocker, reproduced at base commit `a9dc7cc`. Manual DB reset (`dropdb`/recreate of TEST_DATABASE_URL) clears it.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-31

---

## Validation Audit 2026-07-31

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

**Audit method:** State A (existing VALIDATION.md) — cross-referenced all 4 PLAN/SUMMARY requirement maps against test files; ran all 6 phase-33 suites; verified all 17 SUMMARY coverage refs exist by title.

**Evidence (run 2026-07-31):**
- `npx vitest run test/model-output.spec.ts` — 82/82 pass (sanitizer FR-155 + FR-153/FR-154 normalization)
- `npx vitest run test/vcs-github-adapter.spec.ts test/bitbucket-adapter.spec.ts` — 78/78 pass (fallback, skip, NREG-01, rethrow, dedup-not-poisoned, summary-fail-hard)
- `npx vitest run test/audit-trail.spec.ts test/audit-grouping.spec.ts` — 63/63 pass (builders, STAGE_ORDER 14-entry, own-group)
- `npx vitest run test/review-flow.spec.ts` — 94/95 pass; the 1 failure is the pre-existing Phase-26 `modelLineCap persistence` shared-DB accumulation flake (expects 1 row, DB holds 3), verified at base commit `a9dc7cc`, NOT introduced by Phase 33
- `npm run typecheck` — clean (0 errors, per 33-VERIFICATION.md)
