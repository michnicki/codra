---
phase: 24
slug: dashboard-surface-for-new-audit-events
status: signed-off
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-25
validated: 2026-07-26
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.9 (two projects: `node` and `browser`) |
| **Config file** | `vitest.config.mts` |
| **Quick run command** | `npx vitest run test/audit-grouping.spec.ts test/browser/job-detail.spec.tsx` |
| **Full suite command** | `npm test` (both node and browser projects) |
| **Estimated runtime** | ~10 seconds (quick) / ~120 seconds (full suite) |

---

## Sampling Rate

- **After every task commit:** `npx vitest run test/audit-grouping.spec.ts test/browser/job-detail.spec.tsx`
- **After every plan wave:** `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 24-01-T1 | 24-01 | 1 | D-01 | — | normalizeAuditDisplayStage('evidence_missing_summary') returns 'evidence_missing' | unit | `npx vitest run test/audit-grouping.spec.ts` | ✅ | ✅ green |
| 24-01-T2 | 24-01 | 1 | D-02 | — | groupAuditByStage groups evidence_missing_summary under evidence_missing group | unit | `npx vitest run test/audit-grouping.spec.ts` | ✅ | ✅ green |
| 24-01-T3 | 24-01 | 1 | D-02 | — | Renderer shows file, pass, absentCount, notInHunkCount, ≤20 sample entries | browser | `npx vitest run test/browser/job-detail.spec.tsx --project browser` | ✅ | ✅ green |
| 24-01-T4 | 24-01 | 1 | D-02 | — | Legacy evidence_missing per-finding events render unchanged | browser | `npx vitest run test/browser/job-detail.spec.tsx --project browser` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `test/audit-grouping.spec.ts` — file exists, `describe` block added for `evidence_missing_summary` normalization
- [x] `test/browser/job-detail.spec.tsx` — file exists, `describe` block added for `evidence_missing_summary` rendering
- [x] No new test files needed — both additions go into existing test files following existing patterns

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| No `model_line_cap` data surfaced in dashboard | D-03 | Negative check — verify absence of a data surface | Manual code inspection: `grep -r "model_line_cap\|modelLineCap" src/client/` returns no render paths |
| TypeScript compilation passes with new render paths | D-01/D-02 | tsc cannot be run within vitest | `npm run typecheck` |
| Legacy `evidence_missing` per-finding events render unchanged | D-02 | Requires visual comparison with prior behavior | Existing browser tests cover the legacy render path |

---

## Success Criteria

1. [x] `normalizeAuditDisplayStage('evidence_missing_summary')` returns `'evidence_missing'`
2. [x] `groupAuditByStage` emits an `evidence_missing` group for `evidence_missing_summary` events
3. [x] `evidence_missing_summary` events render under "Evidence missing" group with file, pass, absentCount, notInHunkCount, and ≤20 sample entries (path:line, title, reason)
4. [x] Legacy `evidence_missing` per-finding events render unchanged
5. [x] No `model_line_cap` data surfaced in dashboard (D-03)
6. [x] All existing tests pass, `npm run typecheck` is clean

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** signed-off — all 6 success criteria confirmed; D-01/D-02 verified by audit-grouping unit tests + browser renderer tests; D-03 verified (no modelLineCap surface in client/); all 4 verification tasks green.
