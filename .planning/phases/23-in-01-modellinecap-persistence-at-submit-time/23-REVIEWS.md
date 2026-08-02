---
phase: 23
reviewers: [opencode, antigravity]
reviewed_at: 2026-07-25T22:40:00Z
plans_reviewed: [23-01-PLAN.md]
---

# Cross-AI Plan Review — Phase 23

## OpenCode Review

### Summary

The plan is well-structured and addresses a genuine race condition (AUD-03) where `pollReviewBatch` re-derives `modelLineCap` from the mutable `transient_error_count`, causing evidence classification errors when `compactPrompt` toggles between submit and poll. The fix — persisting the resolved numeric `modelLineCap` at submit time — is correctly scoped to the async batch path only, uses an additive nullable column with `COALESCE` preservation, and follows established patterns (`async_request_id`/`async_model` from migration 002). The three-layer test strategy (migration idempotency, unit, integration) aligns with prior phases.

### Strengths

1. **Correct root-cause identification** — The plan correctly traces the bug to `model.ts:680-684` re-deriving `modelLineCap` from `params.compactPrompt` (itself derived from `transient_error_count` at poll time) instead of using the submit-time value. The fix at the persistence layer eliminates the race.

2. **Proper use of `COALESCE` in DO UPDATE SET** — The plan explicitly requires `COALESCE(EXCLUDED.model_line_cap, file_reviews.model_line_cap)` rather than bare `EXCLUDED.model_line_cap`, preserving the submit-time value across `persistCompletedReview` (which nulls `asyncRequestId`/`asyncModel` but omits `modelLineCap`) and `persistFailedFileReview` (which only clears async columns via `clearAsync`). This is the critical correctness detail that differs from `async_request_id`/`async_model`.

3. **Backward-compatible nullable column** — Migration 014 uses `ADD COLUMN IF NOT EXISTS model_line_cap INTEGER` with no default, matching the `async_request_id`/`async_model` precedent. Old rows get `NULL`; poll path falls back to derivation (D-05).

4. **Complete threading through call sites** — The plan correctly identifies both call sites in `review.ts`: submit (line 1360-1379) adds `modelLineCap: submitted.modelLineCap` to the existing `upsertFileReview` call; poll (line 1316-1327) replaces `compactPrompt: ...` with `modelLineCap: awaitingReview.model_line_cap ?? undefined`.

5. **Test strategy matches Phase 22 pattern** — Migration idempotency test replicates the 013 pattern; unit test asserts the derivation formula; integration test mutates `transient_error_count` between submit and poll and asserts persisted value survives `persistCompletedReview`.

### Concerns

| Severity | Concern | Evidence |
|----------|---------|----------|
| **HIGH** | **COMPACT_REVIEW_PROMPT_LINE_CAP is not exported** — The unit test in `async-batch-review.spec.ts` (Task 3, action 2g) proposes importing `COMPACT_REVIEW_PROMPT_LINE_CAP` from `@server/services/model`, but `model.ts:28` shows it's a module-level `const`, not exported. The test will fail to compile unless the constant is exported or the derivation is tested indirectly. | `model.ts:28` — `const COMPACT_REVIEW_PROMPT_LINE_CAP = 400;` (no `export`) |
| **HIGH** | **Multiple mock sites need updating** — The plan identifies 1 mock in `async-batch-review.spec.ts`, but Research.md §388 lists 6+ test files with `submitReviewBatch` mocks: `async-batch-review.spec.ts`, `review-flow.spec.ts`, `vcs-regression.spec.ts`, `severity-audit-integration.spec.ts`, `file-selection-audit-integration.spec.ts`, possibly `model-output.spec.ts`. All must include `modelLineCap` in their return objects or TypeScript will error. | `grep -r "submitReviewBatch" test/` shows 6 files; plan only updates 1 |
| **MEDIUM** | **`pollReviewBatch` still accepts `compactPrompt` for fallback** — The plan correctly keeps `compactPrompt?: boolean` for backward compat (D-04), but the fallback derivation at lines 671-685 uses `params.compactPrompt`. If a caller provides both `modelLineCap` and `compactPrompt`, the `modelLineCap ?? fallback` pattern correctly prefers the persisted value. This is correct but the comment block at 671-677 (EVID-01 rationale) references `compactPrompt` as the sole derivation source — it should be updated to mention the persisted override. | `model.ts:671-677` comment block |
| **MEDIUM** | **Integration test setup complexity** — The integration test (Task 3 action 3) requires: (a) spying on `ModelService.prototype.submitReviewBatch` to return `modelLineCap: 800`, (b) running review phase to submit, (c) manually SQL-updating `transient_error_count = 1`, (d) running review phase again to poll. The `vi.spyOn` pattern from `severity-audit-integration.spec.ts:289` works, but the test must ensure the mock `pollReviewBatch` respects the passed `modelLineCap`. The current mock at `review-flow.spec.ts:76-78` ignores all params and returns `pending`/`done`. | `review-flow.spec.ts:76-78` — mock ignores params |
| **LOW** | **Migration number coupling** — Plan assumes migration 014 follows 013. If another migration is added before this phase, the number changes. Minor but worth noting for automation. | — |

### Suggestions

1. **Export `COMPACT_REVIEW_PROMPT_LINE_CAP`** (or test via the public API) — Add `export const COMPACT_REVIEW_PROMPT_LINE_CAP = 400;` at `model.ts:28`, or restructure the unit test to invoke the real `submitReviewBatch` with spied I/O and assert the returned `modelLineCap` value.

2. **Bulk-update all `submitReviewBatch` mocks** — Before running tests, grep for all mock implementations and add `modelLineCap: 800` (or appropriate value) to each return object.

3. **Update the EVID-01 comment block in `pollReviewBatch`** — At `model.ts:671-677`, add a line noting that `modelLineCap` param (when provided) overrides the `compactPrompt`-based derivation, preserving the exact submit-time haystack boundary.

4. **Strengthen the integration test mock** — The `pollReviewBatch` mock in `review-flow.spec.ts` should capture the `modelLineCap` parameter and use it in its internal logic (or at least verify it's passed).

5. **Add a typecheck verification step in Task 1** — The plan includes `npm run typecheck` in Task 2 verify, but the DB layer changes (Task 1) also affect types (`FileReviewRow`, `upsertFileReview` input). Run typecheck after Task 1 completes to catch column/type mismatches early.

### Risk Assessment: **MEDIUM**

**Justification:**
- The core fix is sound and follows established patterns (COALESCE preservation, nullable additive column, optional param fallback).
- **Primary risk**: Test mock breakage across 6+ test files will cause `npm run typecheck` and `npm test` failures if not all updated. This is a mechanical fix but easy to miss one.
- **Secondary risk**: The `COMPACT_REVIEW_PROMPT_LINE_CAP` export issue blocks the unit test as written; requires a one-line export or test redesign.
- No security, performance, or architectural risks identified. The change is internal to the async batch path, adds no new trust boundaries, and persists a value derived from existing trusted config.

### Key Files to Verify During Implementation

| File | Line(s) | What to Check |
|------|---------|---------------|
| `db/migrations/014_model_line_cap.sql` | — | Single `ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS model_line_cap INTEGER;` with Phase 23 header comment |
| `src/server/db/file-reviews.ts` | 127, 151, 171, 193, 479 | Input type adds `modelLineCap?`, INSERT column list, DO UPDATE SET uses `COALESCE`, params array includes it, `FileReviewRow` has `model_line_cap: number \| null` |
| `src/server/services/model.ts` | 596, 632, 649, 678-685 | `submitReviewBatch` return type includes required `modelLineCap: number`, return statement includes it, `pollReviewBatch` params add `modelLineCap?: number`, haystack uses `params.modelLineCap ?? fallback` |
| `src/server/core/review.ts` | 1378, 1326 | Submit call site passes `modelLineCap: submitted.modelLineCap`; poll call site uses `modelLineCap: awaitingReview.model_line_cap ?? undefined` |
| `test/async-batch-review.spec.ts` | 38 | Mock return includes `modelLineCap: 800` |
| `test/review-flow.spec.ts` | 73-78 | Mock updated or spy overrides `submitReviewBatch` to return `modelLineCap` |

**Verdict:** Plan is solid and implementable. Primary effort will be mechanical mock updates across test files and the constant export for testability.

---

## Antigravity Review

### Summary

Plan `23-01-PLAN.md` provides a well-structured, targeted implementation plan addressing requirement **AUD-03**. It accurately diagnoses the race condition where `transient_error_count` mutating between async batch submission and polling causes `pollReviewBatch` to re-derive a smaller `modelLineCap` than the model actually saw, misclassifying evidence referencing the truncated tail as `not_in_hunk`. The plan introduces a clean PostgreSQL migration (014) adding `model_line_cap INTEGER` to `file_reviews`, updates `upsertFileReview` with a state-preserving `COALESCE` clause, and threads `modelLineCap` from `submitReviewBatch` through `upsertFileReview` to `pollReviewBatch`. The plan is sound and ready for execution with minor adjustments needed for legacy row fallback and test mock isolation.

### Strengths

- **Surgical State Preservation via `COALESCE`**: In `src/server/db/file-reviews.ts:155-172`, specifying `COALESCE(EXCLUDED.model_line_cap, file_reviews.model_line_cap)` in `DO UPDATE SET` guarantees that subsequent non-submit upserts (such as `persistCompletedReview` at `src/server/core/review.ts:1591-1611` and `persistFailedFileReview` at `src/server/core/review.ts:1625-1658`) do not clobber the submit-time `model_line_cap` value when `modelLineCap` is omitted.

- **Accurate Fix for the Submit-Poll Race Condition**: Reconstructing the evidence haystack in `src/server/services/model.ts:678-685` using `params.modelLineCap` directly eliminates the race condition where `transient_error_count` increments between submit (`src/server/core/review.ts:1351-1358`) and poll (`src/server/core/review.ts:1316-1327`).

- **Comprehensive 3-Layer Test Coverage Strategy**: The plan incorporates migration idempotency testing (replicating the pattern in `test/migration-013-idempotency.spec.ts:231-281`), unit-level formula assertions, and an integration test in `test/review-flow.spec.ts:65-105` asserting that `model_line_cap` survives intermediate `transient_error_count` mutations.

- **Strict Backward Compatibility (D-05)**: Leaving `model_line_cap` nullable in `db/migrations/014_model_line_cap.sql` ensures pre-existing rows and non-async review paths continue operating safely without requiring database backfills.

### Concerns

- **[MEDIUM] Loss of `compactPrompt` Fallback for Legacy In-Flight Rows (`model_line_cap IS NULL`)**:
  - **File / Line**: `src/server/core/review.ts:1316-1327` and `src/server/services/model.ts:649-685`
  - **Mechanism**: Task 2 removes `compactPrompt` from the `pollReviewBatch` call site in `review.ts`, replacing it with `modelLineCap: awaitingReview.model_line_cap ?? undefined`. If a legacy row in `file_reviews` has `model_line_cap = NULL` and `transient_error_count > 0`, `pollReviewBatch` receives `modelLineCap: undefined` and `compactPrompt: undefined`. In `model.ts`, `params.compactPrompt` evaluates to `undefined` (falsy), causing the fallback calculation to pick `configuredLineCap` (e.g. 800) instead of the compact line cap (400) under which the legacy batch was submitted.
  - **Impact**: In-flight async reviews submitted in compact mode prior to Migration 014 will be polled using uncompact truncation boundaries, mis-reconstructing the haystack for those legacy rows.

- **[MEDIUM] Vitest Module Mock Collision in `test/async-batch-review.spec.ts`**:
  - **File / Line**: `test/async-batch-review.spec.ts:35-60`
  - **Mechanism**: Task 3 instructs adding unit tests for real `ModelService.submitReviewBatch` return value derivation into `test/async-batch-review.spec.ts`. However, `test/async-batch-review.spec.ts` defines a top-level `vi.mock('@server/services/model', ...)` module mock at line 35.
  - **Impact**: Attempting to instantiate `new ModelService(...)` inside `test/async-batch-review.spec.ts` will instantiate `MockModelService` rather than the real implementation, causing the new unit test to evaluate mock code instead of testing real line cap derivation.

- **[LOW] Missing `modelLineCap` in Secondary Test Mocks**:
  - **File / Line**: `test/severity-audit-integration.spec.ts:290,373`
  - **Mechanism**: Task 2 updates the mock return in `test/async-batch-review.spec.ts:38`, but `test/severity-audit-integration.spec.ts` also contains `spyOn` mocks returning `{ requestId: 'req-async-on', model: 'test-model' }` without `modelLineCap`.
  - **Impact**: When those integration tests run, `submitted.modelLineCap` evaluates to `undefined`, writing `NULL` to `file_reviews.model_line_cap` during test execution.

### Suggestions

- **Retain `compactPrompt` in `review.ts` Poll Call Site**: In `src/server/core/review.ts:1316-1327`, pass both `modelLineCap: awaitingReview.model_line_cap ?? undefined` AND `compactPrompt: (awaitingReview.transient_error_count ?? existingReview?.transient_error_count ?? 0) > 0`. This guarantees that when `model_line_cap` is `NULL` on legacy rows, `pollReviewBatch`'s fallback re-derivation evaluates `compactPrompt` correctly.

- **Isolate `ModelService` Unit Tests in a Dedicated Test File**: Place the unit tests for `ModelService.submitReviewBatch` derivation in a dedicated, unmocked test file (e.g. `test/model-line-cap.spec.ts`) or use `vi.importActual` to prevent collision with the top-level `vi.mock` in `test/async-batch-review.spec.ts:35-60`.

- **Include `modelLineCap` across All Test Mocks**: Add `modelLineCap: 800` to `submitReviewBatch` spy mocks in `test/severity-audit-integration.spec.ts:290,373` alongside `test/async-batch-review.spec.ts:38` for consistency across integration test suites.

### Risk Assessment: **LOW**

**Justification:** The plan is purely additive, strictly scoped to internal DB columns and internal service parameters, and introduces no public API schema changes. The mechanism directly resolves the bug while preserving overall backward compatibility. Incorporating the suggested adjustments will ensure seamless handling of legacy rows and clean test execution.

---

## Consensus Summary

### Agreed Strengths

- **COALESCE preservation in upsertFileReview** — Both reviewers independently verified this is the critical correctness detail: `COALESCE(EXCLUDED.model_line_cap, file_reviews.model_line_cap)` prevents `persistCompletedReview` and `persistFailedFileReview` from clobbering the submit-time value. This is the key insight that differs from the bare `EXCLUDED` pattern used by `async_request_id`/`async_model`.

- **Accurate root-cause diagnosis** — Both agree the plan correctly identifies the submit→poll race condition at `model.ts:678-685` and fixes it at the right layer (persistence, not workaround at the derivation site).

- **Backward-compatible nullable column** — Both confirm the migration pattern (nullable INTEGER, no backfill, fallback to derivation for NULL) is sound.

- **Three-layer test strategy** — Both approve the migration idempotency + unit + integration approach, matching Phase 22's pattern.

- **Plan is implementable** — Both verdict the plan as sound and ready for execution. No architectural redesigns needed.

### Agreed Concerns

1. **Multiple test mock sites need updating (both reviewers, HIGH severity)** — Both independently identified that the plan underestimates the number of test files with `submitReviewBatch` mocks. OpenCode found 6+ files; Antigravity specifically cited `severity-audit-integration.spec.ts:290,373`. A grep-and-bulk-update pass is needed before `npm run typecheck` will pass.

2. **Legacy in-flight row fallback (both reviewers, MEDIUM severity)** — Both raised the same concern: removing `compactPrompt` from the poll call site breaks fallback for legacy rows where `model_line_cap IS NULL` but `transient_error_count > 0`. **Resolution:** Retain `compactPrompt` alongside `modelLineCap` at the poll call site. The `modelLineCap ?? fallback` pattern already handles the precedence; the missing piece is ensuring `compactPrompt` is still available when the fallback fires.

3. **Test isolation for unit tests (both reviewers, MEDIUM severity)** — Both identified that adding real-ModelService tests into `async-batch-review.spec.ts` collides with the existing `vi.mock` at the top of the file. **Resolution:** Either (a) place the unit tests in a dedicated file without module mocking, or (b) use `vi.importActual` within the test block.

### Divergent Views

- **Risk level**: OpenCode assessed MEDIUM (citing mock breakage as primary risk); Antigravity assessed LOW (citing the additive, internal-only nature of the change). Both are reasonable — the difference is in how heavily each weights the mechanical mock-update effort vs. the architectural safety.

- **EVID-01 comment block**: OpenCode flagged that the comment at `model.ts:671-677` should mention the `modelLineCap` override (MEDIUM); Antigravity did not mention this. This is a documentation polish item, not a correctness issue.

- **Typecheck after Task 1**: OpenCode suggested adding `npm run typecheck` to Task 1's verify step (since DB type changes also need validation); Antigravity didn't flag this but it's a practical workflow improvement.

### Action Items for Plan Revision

1. **[HIGH]** Retain `compactPrompt` param at poll call site alongside `modelLineCap` for legacy in-flight row fallback
2. **[HIGH]** Export `COMPACT_REVIEW_PROMPT_LINE_CAP` or restructure unit test to use spied real service
3. **[HIGH]** Add a bulk mock-update step: grep all `submitReviewBatch` mocks and add `modelLineCap: 800`
4. **[MEDIUM]** Move unit tests to a dedicated file (avoid `vi.mock` collision) or use `vi.importActual`
5. **[MEDIUM]** Update the EVID-01 comment block in `pollReviewBatch` to mention `modelLineCap` override
6. **[LOW]** Add `npm run typecheck` to Task 1 verify
