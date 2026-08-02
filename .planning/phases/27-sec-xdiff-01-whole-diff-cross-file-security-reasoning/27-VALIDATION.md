---
phase: 27
slug: sec-xdiff-01-whole-diff-cross-file-security-reasoning
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-30
---

# Phase 27 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 (two projects: `node`, `browser`) |
| **Config file** | `vitest.config.mts` |
| **Quick run command** | `npx vitest run test/cross-file-security.spec.ts` |
| **Full suite command** | `npm test` (applies migrations to `TEST_DATABASE_URL`, then `vitest run --project node`) |
| **Estimated runtime** | ~2 minutes (full suite, 135 files / 1999 tests) |

---

## Sampling Rate

- **After every task commit:** `npx vitest run test/cross-file-security.spec.ts`
- **After every plan wave:** `npm test` (full suite — shared DB, `fileParallelism: false`)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~130 seconds (full suite)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------------|-----------|--------------------|-------------|--------|
| 27-01-01 | 01 | 1 | SEC-XDIFF-01, NREG-01 | Schema (`cross_file` toggle, `cross_references`, `cross_file_security` pass/audit variant), `SENSITIVE_KEYWORDS`, `buildCrossFileDiff` priority-truncation, prompt template, audit builders | unit | `npx vitest run test/cross-file-security.spec.ts` | ✅ | ✅ green |
| 27-01-02 | 01 | 1 | SEC-XDIFF-01, NREG-01 | Phase routing (`nextPhaseAfterReview`/`nextPhaseAfterCrossFileSecurity`), dispatch wiring, `parseCrossFileSecurityResponse` fail-open parsing, `runCrossFileSecurityPhase` idempotency/skip/fail-open | unit | `npx vitest run test/cross-file-security.spec.ts` | ✅ | ✅ green |
| 27-02-01 | 02 | 2 | SEC-XDIFF-01, NREG-01 | Finalize candidate-set inclusion (no manual append), expected-units exclusion of `__cross_file__`, walkthrough "Cross-file Security" section, formatter "Also affects" rendering | unit | `npx vitest run test/cross-file-security.spec.ts` | ✅ | ✅ green |
| 27-02-02 | 02 | 2 | SEC-XDIFF-01, NREG-01 | End-to-end pipeline: multi-file happy path, single-file skip, model-error fail-open, default-off byte-identical, exactly-once posting, "Also affects" + walkthrough section reaching real posted output | integration | `npm test` (test/review-flow.spec.ts, `cross-file security integration` describe block) | ✅ | ✅ green |
| N/A | — | — | NREG-02 | `runCrossFileSecurityPhase` never calls a VCS-provider API (reads persisted `diff_input`, calls `model.callVerifierRaw` only) — provider-neutral by construction, no toggle/branch to test | structural | N/A (no provider-specific code path exists to exercise) | N/A | ✅ satisfied by design |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure (Vitest + `test/helpers.ts` DB-backed test harness) covers all phase requirements. No new framework/scaffolding needed.*

---

## Validation Audit 2026-07-30

Retroactive audit (State B — no `VALIDATION.md` existed; reconstructed from `27-01-PLAN.md`/`27-02-PLAN.md`/`27-01-SUMMARY.md`/`27-02-SUMMARY.md`).

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated (bugs found, now fixed) | 2 |

### Gaps found and resolved

1. **MISSING — no-duplication proof** (27-02-PLAN.md Verification Criterion #9: cross-file findings post EXACTLY ONCE). The 27-02-SUMMARY.md had only a code-inspection argument, not a runtime assertion. **Fixed**: extended `test/review-flow.spec.ts`'s multi-file integration test with a `createReview` spy (the same pattern as the existing MP-02 test) asserting the cross-file finding appears exactly once among 3 total posted comments.
2. **PARTIAL — "Also affects" link + walkthrough "Cross-file Security" section never exercised end-to-end** (27-02-PLAN.md Task 2 Step 1). Both were only unit-tested against hand-built mock objects (`test/cross-file-security.spec.ts`), never through the real `runReviewJob` finalize pipeline. **Fixed**: extended the same multi-file test to assert "Also affects" + the cross-referenced path appear in the real posted comment body, and added a new test (`cross_file: true + walkthrough enabled posts a Cross-file Security section`) that seeds `walkthrough.enabled`, spies on the actual comment-posting call, and asserts the rendered walkthrough body contains "Cross-file Security" and the cross-referenced path.

### Real bugs found and fixed while closing gap 2 (not test gaps — shipped-code defects)

1. **`cross_references` silently dropped on every DB round-trip.** `insertFileReview`/`upsertFileReview`/`bulkInheritFileReviews` (`src/server/db/file-reviews.ts`) never wrote `cross_references` to `review_comments` (no such column existed — added in `db/migrations/020_review_comment_cross_references.sql`), and `getFileReviewsForJobs`'s read query never selected it back. Every cross-file finding lost its `cross_references` the instant it round-tripped through Postgres, so the formatter's "Also affects" link and the walkthrough's "Cross-file Security" section (both gated on `cross_references` presence) could never fire in production — only the pure-function unit tests (which skip the DB) passed. **Fixed**: added the migration, wired `cross_references` through both write paths (JSON-stringified per-row for `UNNEST(...::jsonb[])`) and the read path.
2. **Regression introduced by fix #1, found and fixed in the same pass**: naively adding `'cross_references', rc.cross_references` to the read query's `JSON_BUILD_OBJECT` made every comment object carry an explicit JSON `null` for rows that never set it. `parsedReviewCommentSchema.cross_references` is a bare `z.array(...).optional()` (accepts `undefined`, NOT `null` — unlike `line`/`position`/`confidence`/`existingCode`, which are `.nullable().optional()`). Re-validating persisted comments against schemas built on `parsedReviewCommentSchema` (notably `criticResultSchema.kept`) now failed silently (fail-soft `safeParse` → warn + treat as absent), breaking 9 previously-green `multi-pass critic phase (MP-03)` tests in `test/review-flow.spec.ts` — confirmed deterministic (reproduced identically across 2 full-suite reruns, including after a `TRUNCATE jobs CASCADE`, ruling out DB-state flakiness) and independently root-caused by reading the schema and query directly, not just trusting the fixing agent's report. **Fixed**: wrapped the read-side `JSON_BUILD_OBJECT` in `JSON_STRIP_NULLS(...)`, turning "present with null" into "absent" for every field — schema-legal everywhere since every field here is either genuinely nullable or now correctly optional-only.

### Verification after fixes

- `npm run typecheck` — 0 errors
- `npm test` — 135 files, **1999/1999 tests passing** (full suite, includes the new/extended cross-file integration tests and the previously-regressed MP-03 tests)
- `npx vitest run test/cross-file-security.spec.ts` — 42/42 passing

### Descoped (by explicit user decision during this audit)

- "Incremental re-run" integration test (27-02-PLAN.md Task 2 Step 4, flagged as a known gap in 27-02-SUMMARY.md) — descoped as low-value: the cross-file idempotency guard is scoped to `job.id`, so a new job (a new push/round) cannot collide with a prior job's `__cross_file__` row regardless of a dedicated test.

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have automated verify
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none were missing — existing infra sufficed)
- [x] No watch-mode flags
- [x] Feedback latency < 180s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-30
