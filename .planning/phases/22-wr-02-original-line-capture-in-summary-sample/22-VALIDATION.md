---
phase: 22
slug: wr-02-original-line-capture-in-summary-sample
status: signed-off
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-25
validated: 2026-07-26
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.9 |
| **Config file** | `vitest.config.mts` (project: `node`) |
| **Quick run command** | `npx vitest run test/model-output.spec.ts -t "EVID-04" --project node` |
| **Full suite command** | `npm test` (migrations + vitest run all projects) |
| **Estimated runtime** | ~5 seconds (quick) / ~120 seconds (full suite) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run test/model-output.spec.ts -t "EVID-04" --project node`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 22-01-T1 | 22-01 | 1 | EVID-04 | — | originalLine captured before orphan remap (model-output.ts:451), used in evidenceMissingEntries | unit | `npx vitest run test/model-output.spec.ts -t "EVID-04" --project node` | ✅ | ✅ green |
| 22-01-T2 | 22-01 | 1 | EVID-04 | — | Comment `line` field continues using post-remap line (model-output.ts:541) | unit | `npx vitest run test/model-output.spec.ts -t "EVID-04" --project node` | ✅ | ✅ green |
| 22-01-T3 | 22-01 | 1 | EVID-04 | — | Schema comment states pre-remap capture (schema.ts ~line 930) | manual | `grep -q "pre-orphan-remap" src/shared/schema.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `test/model-output.spec.ts` — EVID-04 test already exists (lines 479-507), asserts `sample[0].line === 5` (original) vs `comments[0].line === 3` (remapped)
- [x] `src/shared/schema.ts` — Comment updated to present tense ("carries the pre-orphan-remap original line")
- [x] `.planning/REQUIREMENTS.md` — EVID-04 checkbox set to `[x]`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| TypeScript compilation passes with originalLine typed correctly | EVID-04 | tsc cannot be run within vitest | `npm run typecheck` |
| Schema comment correctness (present tense, no "will swap" remnant) | EVID-04 | Static text verification, not runtime behavior | `grep -A1 "pre-orphan-remap" src/shared/schema.ts` |
| REQUIREMENTS.md checkbox completed | EVID-04 | Static text, outside test suite | `grep "EVID-04" .planning/REQUIREMENTS.md` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** signed-off — 4/4 must-haves verified in 22-VERIFICATION.md; EVID-04 test (`test/model-output.spec.ts:479-507`) asserts sample[0].line === 5 (original, captured before orphan remap) vs comments[0].line === 3 (remapped); `npm test` 62/62 model-output tests pass; `npm run typecheck` clean.

---

## Reference

- **Behavior record:** `22-VERIFICATION.md` — authoritative 4/4 must-haves verification (status: passed, score: 4/4)
- **Source file:** `src/server/core/model-output.ts:451` — `originalLine` captured before orphan remap block (lines 454-464)
- **Producer sites:** `model-output.ts:533, 536` — both `evidenceMissingEntries.push()` calls use `originalLine ?? null`
- **Comment preservation:** `model-output.ts:541` — `line: line` continues using post-remap `line` variable
- **Schema comment:** `src/shared/schema.ts ~line 930` — states "carries the pre-orphan-remap original line" (present tense)
