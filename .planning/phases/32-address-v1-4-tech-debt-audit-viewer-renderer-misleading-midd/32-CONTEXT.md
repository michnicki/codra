# Phase 32: Address v1.4 tech debt — Context

**Gathered:** 2026-07-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Address all tech debt flagged by the v1.4 milestone audit (`.planning/v1.4-MILESTONE-AUDIT.md`) plus high-value concerns from `.planning/codebase/CONCERNS.md`. This is a cleanup phase — no new features, no schema changes, no new capabilities. Every item is a fix, deletion, test addition, comment correction, or documentation reconciliation.

**In scope:** 10 audit-flagged items (2 minor, 4 warnings, 4 info/other) across Phases 27/28/30/31; the `nextPhaseAfterCrossFileSecurity` integration test gap; 4 CONCERNS.md items (config-default drift test, broken migration script deletion, logger redaction hardening, Bitbucket webhook route non-PR events); stale planning doc reconciliation (ROADMAP.md, REQUIREMENTS.md, STATE.md, PROJECT.md).

**Out of scope:** New features, new config keys, new migrations, new npm dependencies, any change to the review pipeline's behavior, splitting `review.ts` (acknowledged tradeoff, not a tech-debt item for this phase), addressing the lease-loss or recovered-job-phase test coverage gaps (deferred — user chose minimal test scope).

</domain>

<decisions>
## Implementation Decisions

### Audit Viewer Renderer (W-1) — Already Resolved
- **D-01:** W-1 (`audit-trail-viewer.tsx` missing `case 'learned_rule_suppressed'`) is **already fixed** by quick task `260727-hvc` (commit `c94aeb6`, 2026-07-27). The case exists at `audit-trail-viewer.tsx:223-242`. The v1.4 milestone audit ran before this fix landed. **No work needed.**

### Test-Hygiene (WR-1)
- **D-02:** Fix only the 2 test cases exercising real `withRetry` exponential backoff (~6.4s wall-clock). Scope limited to mocking the retry delay — no broader test coverage pass. The exact test cases need to be located during research (the audit references Phase 30/ANNO-01 tests; the bitbucket-client tests already use `retry-after: '0'`). If the tests have already been fixed, verify and close.

### Phase 31 (WS-01) Warnings — All 4
- **D-03:** Fix all 4 WS-01 warnings:
  1. **Webhook URL from origin:** webhook URL derived from request origin instead of `APP_URL` — use the configured `APP_URL` env var.
  2. **Unvalidated repo-slug at finalize:** add a re-check of the repo-slug against the payload at finalize time.
  3. **Stale-discovery UI gap:** when a workspace credential is edited, the discovered repo list may be stale — add a UI indicator or re-discovery prompt.
  4. **Unused exports:** remove or mark as intentionally exported the unused `listWorkspaceCredentials` / `deleteWorkspaceCredential` exports if they have no callers.

### Hardcoded Type Unions
- **D-04:** Replace hardcoded `'main' | 'security' | 'cross_file_security'` union in `file-reviews.ts:472` with the imported `FileReviewPass` type. Direct mechanical fix.

### Misleading Middleware Comment (W-2)
- **D-05:** Correct the comment on learned-rules API routes that claims explicit per-route `requireSession + requireCsrfHeader` middleware — the routes are actually protected by the `app.use('/api/*')` middleware applied earlier in the chain. The comment should describe the actual protection mechanism.

### Integration Test Gap
- **D-06:** Add a unit test for `nextPhaseAfterCrossFileSecurity` selector in `phase-routing.ts:100-113`. Currently only covered indirectly by E2E tests in `review-flow.spec.ts`. Follow the existing pattern of the `nextPhaseAfterReview` / `nextPhaseAfterVerifyFixes` / `nextPhaseAfterCritic` selector tests in `phase-routing.spec.ts`.

### Config-Default Drift Test
- **D-07:** Add a test asserting `repoConfigSchema.parse({})` deep-equals an explicitly-declared expected object. This catches the drift risk from the three-site default-mirroring pattern in `src/shared/schema.ts` (field `.default()`, enclosing block `.default({...})`, top-level `review.default({...})`). Cheap, high-value. Per CONCERNS.md recommendation.

### Delete Broken Migration Script
- **D-08:** Delete `scripts/apply_migrations.js` — an untracked, broken duplicate of `scripts/migrate.mjs` that imports a non-existent `pool` export, uses the wrong schema (`version` integer vs `name` text), takes no advisory lock, and applies all pending migrations in one transaction. `npm run migrate` is the only sanctioned path.

### Logger Redaction Hardening
- **D-09:** Two improvements to `src/server/core/logger.ts`:
  1. Run the `message` argument through `scrubEmbeddedSecrets` (currently only the store/context/data are redacted, not the message itself).
  2. Extend `EMBEDDED_SECRET_PATTERNS` to cover Google AI keys (`AIza[0-9A-Za-z_-]{20,}`) and Bitbucket tokens (`ATCTT[A-Za-z0-9_=-]{20,}`).

### Webhook Route Non-PR Events
- **D-10:** Fix `src/server/routes/webhook-bitbucket.ts:66-95` so non-pull-request Bitbucket events (`repo:push`, `issue:*`, etc.) return `202 ignored` instead of `400 Invalid webhook payload.` Drop `pullrequest` from the pre-verification `bitbucketIdentityProjectionSchema`; let the post-verify `pullRequestWebhookPayloadSchema.safeParse` be the thing that rejects non-PR shapes. This unblocks Phase 29's `repo:push` webhook handling at the route level.

### Stale Planning Docs — Full Sweep
- **D-11:** Reconcile all stale tracking:
  1. **ROADMAP.md:** Phase 26 plan boxes still unchecked (2 plans executed but never marked); Phase 32 goal still "[To be planned]".
  2. **REQUIREMENTS.md:** traceability table — all 6 v1.4 requirements are Done but some traceability rows may be stale.
  3. **STATE.md:** `progress:` counters disagree with actual phase/plan counts (10/6 vs actual 6 phases in v1.4); `progress.bar` disagrees too.
  4. **PROJECT.md:** "Current State" section should reflect v1.4 completion (all 6 phases shipped).
  5. **CONCERNS.md:** items resolved by this phase should be marked as such or removed.

### Claude's Discretion
- Exact test mocking strategy for withRetry (vi.useFakeTimers vs. injecting a delay override vs. mocking setTimeout).
- Whether the stale-discovery UI gap (D-03.3) needs a full UI indicator or just a text note — plan should propose the minimal adequate fix.
- Whether `listWorkspaceCredentials` / `deleteWorkspaceCredential` (D-03.4) should be deleted or kept as intentional future-use exports with a comment.
- How to structure the config-default drift test (D-07): one monolithic deep-equal assertion vs. per-toggle-block assertions — the latter is more granular but more maintenance surface.
- Whether the webhook route fix (D-10) needs a new test case for `repo:push` returning 202, or if the existing test structure can be extended.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone Audit
- `.planning/v1.4-MILESTONE-AUDIT.md` — the source of all 10 tech-debt items; tech_debt section details each item with file:line references

### Codebase Concerns
- `.planning/codebase/CONCERNS.md` — "Config defaults must be hand-mirrored across three sites" (latent defect, D-07 target), "Logger redaction: message argument never redacted" (D-09 target), "Bitbucket webhook route cannot accept any non-pull-request event" (D-10 target), "scripts/apply_migrations.js broken duplicate" (D-08 target)

### Planning Docs to Reconcile
- `.planning/ROADMAP.md` — Phase 26 plan boxes, Phase 32 goal
- `.planning/REQUIREMENTS.md` — v1.4 traceability table
- `.planning/STATE.md` — progress counters, session info
- `.planning/PROJECT.md` — Current State section

### Source Files Modified
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` — D-01 (already fixed, verify only)
- `src/server/core/file-reviews.ts:472` — D-04 hardcoded type union
- `src/server/core/phase-routing.ts:100-113` — D-06 test gap
- `src/shared/schema.ts` — D-07 config-default test target
- `scripts/apply_migrations.js` — D-08 deletion target
- `src/server/core/logger.ts:24-32,76-97` — D-09 redaction hardening
- `src/server/routes/webhook-bitbucket.ts:66-95` — D-10 non-PR event handling

### Prior Phase Context
- `.planning/phases/29-qa-idx-01-codebase-index-backed-q-a/29-CONTEXT.md` — D-08 push webhook handling that the current route blocks

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`phase-routing.spec.ts`** — existing selector test pattern for `nextPhaseAfterReview` / `nextPhaseAfterVerifyFixes` / `nextPhaseAfterCritic`; D-06 adds `nextPhaseAfterCrossFileSecurity` following the same structure
- **`schema-contract-inertness.spec.ts`** — existing `defaultRepoConfig` assertion pattern; D-07 extends it with a deep-equal expected-object check
- **`redactFindingTitle` / `redactErrorMessage`** (`core/audit-redact.ts`) — the AUD-01 redaction helpers; D-09 extends the sibling `scrubEmbeddedSecrets` path
- **`installBitbucketFetchMock`** (`test/bitbucket-fetch-mock.ts`) — mock installer for Bitbucket HTTP; D-10's test uses it to drive a `repo:push` payload

### Established Patterns
- **Pure test for pure logic:** every config/schema/selector test is unit-level with no DB; D-04, D-06, D-07 all follow this
- **Delete-orphan convention:** untracked scripts that duplicate sanctioned paths should be deleted, not fixed; D-08 follows this
- **NREG-01 invariant:** no behavior change to the review pipeline; all changes are fixes/cleanup/tests/docs

### Integration Points
- `src/server/routes/webhook-bitbucket.ts` — D-10 modifies the pre-verification identity projection
- `src/server/core/logger.ts` — D-09 modifies the redaction pipeline
- `test/phase-routing.spec.ts` — D-06 adds a new selector test
- `test/schema-contract-inertness.spec.ts` — D-07 adds a drift-detection test

</code_context>

<specifics>
## Specific Ideas

No outside references were cited. Every item is a direct response to either the v1.4 milestone audit or the CONCERNS.md codebase analysis. The user chose minimal test scope (withRetry only) but broad cleanup scope (all WS-01 warnings, all CONCERNS.md items, full doc sweep).

</specifics>

<deferred>
## Deferred Ideas

- **`review.ts` extraction** — CONCERNS.md notes the 3,790-line module could be split into per-phase runners. Not this phase — acknowledged tradeoff, not flagged by the audit.
- **Heartbeat lease-loss test** — CONCERNS.md lists this as a high-priority test gap. Deferred — user chose minimal test scope.
- **Recovered-job phase test** — CONCERNS.md lists this as medium-priority. Deferred.
- **Zero-file chunks at budget exhaustion test** — CONCERNS.md lists this as medium-priority. Deferred.
- **PR description dropped by file-review prompt** — CONCERNS.md flags this as a defect. Not in scope for this cleanup phase — would change review pipeline behavior.
- **Bitbucket auto-review jobs ignore per-repo config** — CONCERNS.md flags this as the largest real parity gap. Requires a new `loadRepoConfigByRepositoryId` function — too large for a tech-debt cleanup.

</deferred>

---

*Phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd*
*Context gathered: 2026-07-31*
