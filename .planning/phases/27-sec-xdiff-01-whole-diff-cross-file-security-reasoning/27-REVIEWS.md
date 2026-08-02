---
phase: 27
reviewers: [opencode, antigravity]
reviewed_at: 2026-07-26T16:30:00Z
plans_reviewed: [27-01-PLAN.md, 27-02-PLAN.md]
---

# Cross-AI Plan Review — Phase 27

## OpenCode Review

Both plans are **well-structured and align closely with the existing codebase patterns**. Plan 27-01 covers the core implementation (schema, routing, phase handler, diff construction, prompt, parsing, audit) and Plan 27-02 handles integration (finalize merge, walkthrough, formatter, integration tests). The plans correctly identify all the touchpoints across `schema.ts`, `phase-routing.ts`, `next-phase-error.ts`, `review.ts`, `diff.ts`, `model-output.ts`, `audit.ts`, `walkthrough.ts`, `formatter.ts`, and the new prompt file. The dependency on Phase 26 (EVID-02) is properly acknowledged.

### Strengths

- **Contract-first schema changes** — All 7 schema modifications target the exact locations: `fileReviewPassSchema` (L759), `reviewJobMessageSchema.phase` (L347), `reviewConfigSchema.passes.security` (L165), `repoConfigSchema` default (L296), `parsedReviewCommentSchema` (L40-58), `jobAuditEventSchema` (after L1203), `PhaseName` union (L5-11)
- **Phase routing insertion point** — `nextPhaseAfterReview` correctly inserts `cross_file_security` as FIRST check before `verify_fixes` (phase-routing.ts:30-44), and `nextPhaseAfterCrossFileSecurity` delegates to existing chain without re-checking the toggle (avoids loop)
- **Fail-open pattern consistency** — `runCrossFileSecurityPhase` mirrors `runCriticPhase`/`runWalkthroughEnrichmentPhase`: idempotency check → toggle check → `heartbeatAndCheckSuperseded` BEFORE model call → model call → persist → audit → hand off via `enqueueJobPhase`
- **Synthetic sentinel row** — `__cross_file__` with pass `'cross_file_security'` works with existing `(job_id, file_path, pass)` unique constraint; `upsertFileReview` ON CONFLICT handles idempotency
- **Priority scoring reuse** — `buildCrossFileDiff` correctly uses `scoreFile` from `priority.ts` and `isGeneratedFile` for generated detection
- **Audit event pattern** — New `'cross_file_security'` stage variant follows existing discriminated union pattern with `.passthrough()`; recorder is best-effort try/catch
- **NREG-01 byte-identical defaults** — `cross_file: z.boolean().default(false)` in schema + default literal; `repoConfigSchema.parse({})` yields `false`; all new behavior gated behind this toggle
- **PhaseName widening** — All 5 locations identified: `ReviewJobRunResult`, dispatch, `freshInstance`, `enqueueJobPhase`, `continueOrFailWedgedJob`, `resolveQueuedJob`
- **Integration test coverage** — 5 integration test scenarios + byte-identical assertion + walkthrough/formatter unit tests

### Concerns

#### HIGH

1. **Finalize candidate set merge logic gap** (Plan 27-02 Task 1 Step 1)
   - At `review.ts:2183-2192`, the candidate set is built from `reviews.flatMap(...)`. The `__cross_file__` row WILL be in `reviews` (loaded by `getFileReviewsForJobs`), but the security-enabled branch (L2186-2189) only runs when `securityEnabled` is true.
   - Per D-02, cross-file security can run WITHOUT per-file security enabled. If `passes.security.enabled=false` but `passes.security.cross_file=true`, the cross-file findings would fall through to the `else` branch (L2190-2191) which only includes main-pass findings.
   - **Fix needed**: The candidate set merge must explicitly include `__cross_file__` findings regardless of `securityEnabled`.

2. **Walkthrough main-pass filter excludes cross-file** (Plan 27-02 Task 1 Step 3)
   - `walkthrough.ts:375` filters `review.pass === 'main'`. Cross-file findings have `pass === 'cross_file_security'`, so they're excluded from `mainReviews` and won't appear in the walkthrough at all.
   - The plan says to add a "Cross-file Security" section, but `buildWalkthroughData` doesn't currently accept cross-file findings as a separate input.
   - **Fix needed**: Modify `buildWalkthroughData` to accept optional `crossFileReviews` parameter, or load them separately inside the function.

3. **Token budget constant location** (Plan 27-01 Task 1 Step 8)
   - Plan puts `CROSS_FILE_DIFF_MAX_LINES = 3000` in the prompt file, but `buildCrossFileDiff` in `diff.ts` also needs it. Should be a shared constant (e.g., in `diff.ts` or a constants module) to avoid drift.

#### MEDIUM

4. **Model output schema for cross-file not defined** (Plan 27-01 Task 2 Step 9)
   - `parseCrossFileSecurityResponse` needs a Zod schema that extends `fileReviewModelOutputSchema` with `cross_references`. This schema should be defined (in `model-output.ts` or `schema.ts`) before the parser uses it.

5. **Priority scoring matches substrings, not directory patterns** (D-14 vs `priority.ts`)
   - D-14 specifies paths matching `auth/`, `middleware/`, `routes/`, `config/`, `crypto/`, `session/` patterns. Current `SENSITIVE_KEYWORDS` uses substring matching. `middleware`, `routes`, `session` are NOT in `SENSITIVE_KEYWORDS`.
   - **Fix**: Add `middleware`, `routes`, `session` to `SENSITIVE_KEYWORDS` in `priority.ts` (or create cross-file-specific scoring).

6. **`ModelService.callRaw` method assumption** (Plan 27-01 Task 2 Step 8)
   - Plan assumes `model.callRaw({ systemPrompt, userPrompt })` exists. Need to verify `ModelService` has this method or use the correct API.

7. **Formatter cross-reference rendering** (Plan 27-02 Task 1 Step 4)
   - `formatInlineComment` (formatter.ts:105) formats a single comment. Adding "Also affects" links requires modifying this method or handling at a higher level.

8. **Missing `cross_references` in `ParsedReviewComment` type usage**
   - Adding `cross_references` to `parsedReviewCommentSchema` automatically widens the type, but code that constructs `ParsedReviewComment` objects manually (e.g., in tests) may need updates.

#### LOW

9. **`continueOrFailWedgedJob` ceiling for cross_file_security** — correct usage of `MAX_FINALIZE_CONTINUATIONS`
10. **`resolveQueuedJob` spoof guard** — correct, phase only reached after job creation
11. **Evidence gate on cross-file findings** — D-19 correctly states evidence check on primary file only
12. **Walkthrough `pass` hardcoded check** — only `walkthrough.ts:375` has `review.pass === 'main'`

### Suggestions

1. Add cross-file findings to finalize candidate set unconditionally (not gated on `securityEnabled`)
2. Extend `buildWalkthroughData` signature to accept optional `crossFileFindings` parameter
3. Define cross-file model output schema in `model-output.ts`
4. Add `middleware`, `routes`, `session` to `SENSITIVE_KEYWORDS` in `priority.ts`
5. Move `CROSS_FILE_DIFF_MAX_LINES` to `diff.ts` as a shared constant
6. Verify `ModelService` API for the raw call

### Risk Assessment: MEDIUM

The plans are comprehensive and follow established patterns correctly. Two HIGH concerns (finalize merge logic, walkthrough exclusion) are implementation gaps that would cause cross-file findings to be silently dropped in certain configs. These are fixable during implementation but must be addressed. No architectural risks; all changes are additive and config-gated.

---

## Antigravity Review

Phase 27 introduces a whole-diff cross-file security reasoning pass that runs after per-file review units finish and before downstream post-review processing. The architecture follows Codra's established multi-pass conventions: contract-first schema updates, phase routing, synthetic sentinel storage under `__cross_file__`, strict NREG-01 default-off gating, and fail-open model error handling.

Overall, the plan design is clear and well-structured. However, two significant technical concerns exist in **Plan 27-02** regarding finding duplication in the `finalize` candidate set and walkthrough data model alignment, as well as a method signature mismatch in **Plan 27-01**.

### Plan 27-01 Strengths

- **Strict NREG-01 Default-Off Gating** — `passes.security.cross_file` defaults to `false` in both the schema definition at `schema.ts:165` and the `repoConfigSchema` default object at `schema.ts:296`. Calling `repoConfigSchema.parse({})` evaluates to `false`, guaranteeing zero behavior change when unconfigured.
- **Priority-Weighted Diff Concatenation** — `buildCrossFileDiff` leverages the existing `scoreFile` helper from `priority.ts` to prioritize security-sensitive paths when diffs exceed `CROSS_FILE_DIFF_MAX_LINES = 3000`.
- **Fail-Open Resilience & Idempotency** — Implements idempotency checks against the synthetic sentinel and wraps LLM calls in fail-open handlers that record audit events and proceed to the next phase without failing the overall review job.
- **Race Condition Prevention** — Explicitly calls `heartbeatAndCheckSuperseded` prior to issuing model calls to prevent waste on superseded jobs.

### Plan 27-01 Concerns

- **`ModelService.callRaw` Method Mismatch** (MEDIUM) — Plan 27-01 Task 2 Step 8 states: *"Model call via `model.callRaw({ systemPrompt, userPrompt })`"*. In `model.ts`, no `callRaw` method exists on `ModelService`. Calling `model.callRaw` will trigger a TypeScript compiler error.
- **Un-widened Local Type Signature in `file-reviews.ts`** (LOW) — In `file-reviews.ts:472`, `getFileReviewsForJobs` hardcodes `pass: 'main' | 'security'`. Updating `fileReviewPassSchema` does not automatically update local inline type assertions.

### Plan 27-02 Concerns

- **Candidate Set Finding Duplication in `finalize`** (HIGH)
  - In `review.ts:2085`, `reviews = await getFileReviewsForJobs(env, [job.id])` fetches **all** `file_reviews` rows for the job, including `(file_path: '__cross_file__', pass: 'cross_file_security')`.
  - When `critic` is OFF, `reviews.flatMap(...)` at `review.ts:2187-2191` **already contains** `__cross_file__` findings.
  - When `critic` is ON, `runCriticPhase` loaded `reviews.flatMap(...)` (which included `__cross_file__`) into `candidateSet` and graded them. Thus, `job.criticResult.kept` **already contains** kept cross-file findings.
  - Manually appending `__cross_file__` findings to `reviewedComments` in `finalize` will cause cross-file findings to be **duplicated** and bypass critic pruning.

- **Walkthrough Aggregation & Data Model Mismatch** (HIGH)
  - In `walkthrough.ts:375`, `buildWalkthroughData` filters `mainReviews = reviews.filter((r) => r.pass === 'main')`.
  - Per D-18/D-21, a cross-file finding's primary `path` is set to the target file (e.g. `src/auth/middleware.ts`), NOT `__cross_file__`.
  - `finalComments` passed into `buildWalkthroughData` attributes comments by `comment.path` (the primary file path). Searching for `comment.path === '__cross_file__'` will yield zero comments.
  - The `WalkthroughData` type does not currently contain a cross-file section field, which will require type definition updates.

### Plan 27-02 Suggestions

- **Finalize Merge:** Do NOT manually append `__cross_file__` findings in `finalize`. Rely on the automatic inclusion via `reviews.flatMap(...)` when critic is off, and `job.criticResult.kept` when critic is on.
- **Walkthrough Section:** Extend `WalkthroughData` schema to support the new section, and identify cross-file comments by checking `Boolean(comment.cross_references?.length)` rather than checking `path === '__cross_file__'`.

### Risk Assessment: MEDIUM to HIGH

Implementing Task 27-01 as written without adjusting the `ModelService` method reference will cause TypeScript errors. Implementing Task 27-02 as written without adjusting the candidate set merge and walkthrough logic will lead to duplicate findings in PR reviews and TypeScript/runtime errors in walkthrough formatting.

---

## Consensus Summary

Both reviewers independently converged on the same critical issues. The plans are architecturally sound and follow established patterns well, but have specific implementation gaps that must be addressed before execution.

### Agreed Strengths

- Contract-first schema changes targeting exact codebase locations
- NREG-01 byte-identical default-off gating throughout
- Fail-open pattern consistency with existing critic/walkthrough phases
- Priority-weighted diff concatenation reusing existing `scoreFile` helper
- Synthetic sentinel row approach leveraging existing `file_reviews` unique constraint
- Comprehensive integration test coverage (5 scenarios + byte-identical assertion)

### Agreed Concerns

1. **`ModelService.callRaw` does not exist** (both reviewers, MEDIUM) — Plan 27-01 Task 2 Step 8 references a method that doesn't exist on `ModelService`. Must use an existing method or add a new one.

2. **Finalize candidate set double-counting** (both reviewers, HIGH) — Plan 27-02 Task 1 Step 1 instructs manually appending `__cross_file__` findings, but they're already included via `reviews.flatMap(...)` / `criticResult.kept`. Manual append = duplication + bypasses critic pruning. **Fix: remove the manual append.**

3. **Walkthrough cross-file section** (both reviewers, HIGH) — `buildWalkthroughData` filters on `pass === 'main'`, and cross-file findings' `path` is the primary file (not `__cross_file__`). The plan's approach won't find them. **Fix: filter by `cross_references` presence or pass, and extend `WalkthroughData` type.**

4. **Token budget constant should be shared** (OpenCode, MEDIUM) — `CROSS_FILE_DIFF_MAX_LINES` belongs in `diff.ts`, not the prompt file.

5. **`file-reviews.ts` hardcoded pass type** (Antigravity, LOW) — `getFileReviewsForJobs` at L472 hardcodes `'main' | 'security'`, needs widening.

### Divergent Views

None — both reviewers aligned on all major findings. Minor difference in risk rating (OpenCode: MEDIUM overall, Antigravity: MEDIUM to HIGH) reflects the same concerns weighted slightly differently.

### Recommended Plan Adjustments

| Plan | Section | Severity | Fix |
|------|---------|----------|-----|
| 27-01 | Task 2 Step 8 | MEDIUM | Replace `model.callRaw` with correct `ModelService` method |
| 27-01 | Task 1 Step 8 | MEDIUM | Move `CROSS_FILE_DIFF_MAX_LINES` to `diff.ts` as shared constant |
| 27-02 | Task 1 Step 1 | HIGH | Remove manual `__cross_file__` append — rely on automatic inclusion via `reviews.flatMap`/`criticResult.kept` |
| 27-02 | Task 1 Step 3 | HIGH | Filter cross-file comments by `cross_references` presence, extend `WalkthroughData` type |
| 27-01 | file-reviews.ts | LOW | Widen `pass` type to `FileReviewPass` import |
