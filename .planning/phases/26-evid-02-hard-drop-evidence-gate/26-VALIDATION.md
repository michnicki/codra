---
phase: 26
slug: evid-02-hard-drop-evidence-gate
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-26
validated: 2026-07-30
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
| 26-01-01 | 01 | 1 | EVID-02 | T-26-01 | Config has .max(20) array bound + default false | unit | `npx vitest run test/schema-contract-inertness.spec.ts` | ✅ | ✅ green |
| 26-01-02 | 01 | 1 | EVID-02 | T-26-03 | Evidence extraction preserves EVID-01 behavior | unit | `npx vitest run test/model-output.spec.ts` | ✅ existing | ✅ green |
| 26-01-03 | 01 | 1 | EVID-02 | T-26-02 | 17 unit tests (checkEvidence + buildEvidenceHardDroppedEvent + cross-consistency) | unit | `npx vitest run test/evidence.spec.ts` | ✅ | ✅ green |
| 26-02-01 | 02 | 1 | EVID-02 | T-26-06 | PATCH /:owner/:repo/config deep-merges `review` so patching `evidence` preserves `dedup`/`passes`/`rounds` | integration | `npx vitest run test/api.spec.ts -t "PATCHing review.evidence"` | ✅ | ✅ green |
| 26-02-02 | 02 | 1 | EVID-02 | T-26-06 | Finalize hard-drop gate: drop / exempt-category bypass / NREG-01 disabled-mode byte-identical | integration | `npx vitest run test/review-flow.spec.ts -t "evidence hard-drop"` | ✅ | ✅ green |
| 26-02-03 | 02 | 1 | EVID-02 | — | Dashboard evidence UI (ToggleRow + ListEditor) | manual | — | ✅ | see Manual-Only |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Validation Audit 2026-07-30

Ran `/gsd-validate-phase 26` against a stale pre-execution draft (this file was never updated after Phase 26 executed on 2026-07-26). Cross-referenced 26-01/26-02 PLAN + SUMMARY against live test runs.

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |

**Gap 1 — 26-01-01 (schema defaults/bound):** The task's automated command ran green but never asserted the declared secure behavior. `test/schema-contract-inertness.spec.ts` SC3 block covered other toggles but not `evidence`. Added two tests: default `hard_drop: false` / `hard_drop_exempt_categories: ['security']`, and `.max(20)` boundary (20 accepted, 21 rejected).

**Gap 2 — 26-02-01 (PATCH deep-merge) — real implementation bug found, not a test gap:** Writing the regression test for the "CRITICAL PATH FIX #3" deep-merge exposed that the fix was ineffective. `repoConfigPatchSchema.review` was bound to the full `reviewConfigSchema` (every field carries its own Zod `.default()`), just wrapped in `.optional()` — not a deep-partial. Parsing `{ review: { evidence: { hard_drop: true } } }` through it back-filled every omitted sibling field (`dedup`, `passes`, `rounds`, ...) with its schema default *before* the merge ran, so the merge silently overwrote real persisted settings with defaults on every partial `review` PATCH (not just evidence — this affected every reviewable field). Fixed in `src/server/routes/api/repos.ts`: added a `deepMergePlain` helper that recursively merges the **raw** patch body (pre-Zod-default) onto the existing config, and the PATCH handler now uses it for the `review` sub-object instead of the Zod-parsed `configPatch.review`. Verified via the new `test/api.spec.ts` regression test (seeds `dedup`/`passes`/`rounds`, PATCHes only `evidence`, asserts siblings survive) plus full re-run of `test/api.spec.ts` (42/42), `test/repo-configs.spec.ts` (19/19), and `test/review-flow.spec.ts -t "evidence hard-drop"` (3/3) — no regressions. `npm run typecheck` clean.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dashboard config UI evidence section renders correctly | EVID-02 | Browser-rendered config panel — requires visual verification or Playwright browser test | Navigate to repo settings, verify evidence toggle + exempt categories editor are present and functional |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-07-30
