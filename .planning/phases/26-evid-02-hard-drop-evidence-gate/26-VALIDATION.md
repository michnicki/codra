---
phase: 26
slug: evid-02-hard-drop-evidence-gate
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-26
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.mts |
| **Quick run command** | `npx vitest run test/evidence.spec.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run test/evidence.spec.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 26-01-01 | 01 | 1 | EVID-02 | T-26-01 | Config has .max(20) array bound + default false | unit | `npx vitest run test/schema-contract-inertness.spec.ts` | ❌ W0 | ⬜ pending |
| 26-01-02 | 01 | 1 | EVID-02 | T-26-03 | Evidence extraction preserves EVID-01 behavior | unit | `npx vitest run test/model-output.spec.ts -x` | ✅ existing | ⬜ pending |
| 26-01-03 | 01 | 1 | EVID-02 | T-26-02 | 17 unit tests (checkEvidence + buildEvidenceHardDroppedEvent + cross-consistency) | unit | `npx vitest run test/evidence.spec.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/evidence.spec.ts` — stubs for EVID-02 evidence check extraction + hard-drop logic
- [ ] `test/review-flow.spec.ts` — integration test stubs for end-to-end evidence hard-drop behavior

*Existing infrastructure covers all other phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dashboard config UI evidence section renders correctly | EVID-02 | Browser-rendered config panel — requires visual verification or Playwright browser test | Navigate to repo settings, verify evidence toggle + exempt categories editor are present and functional |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
