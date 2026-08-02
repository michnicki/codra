# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.2 — Review Engine Quality & Re-review Lifecycle

**Shipped:** 2026-07-25
**Phases:** 9 (13-20 + 20.1) | **Plans:** 49 | **Timeline:** 2026-07-21 → 2026-07-25 (5 calendar days, 164 commits, 5 days vs the 7 days v1.1 took for 29 plans)
**Audit:** `passed` after Phase 20.1 closure (all 5 BLOCKERs + 1 WARNING closed; 31/31 requirements satisfied; NREG-01 + NREG-02 + AUD-01 standing gates pass; AUD-01 human signature/date pair signed 2026-07-25 by Thomas Michnicki)

### What Was Built

- **Contracts, Severity Engine & Audit Foundation (Phase 13, 4 plans):** all v1.2 contract shapes in `src/shared/schema.ts` (`existingCode`, open `jobAuditEventSchema` discriminated union, exported severity band map, `severity_engine.enabled` toggle); pure deterministic `core/severity.ts` rules (SEV-01..03 — exploit-keyword promotion to P0, security-category cap at P2, style downgrade to nit); real model-assigned categories (SEV-04, hardcoded `'quality'` removed); migration 010 `jobs.audit` JSONB with per-job ring-buffer cap; `core/audit.ts` best-effort recorder helpers (`recordUnitAudit` never rethrows).
- **Noise Filter v2 & Always-On Dedup (Phase 14, 3 plans):** severity-tiered comment cap exempting P0/P1/P2; per-category confidence floors (`category_confidence` map); composite-rule dedup (same path+line+category; overlapping title-Jaccard ≥0.2; non-overlapping ≥0.6; cross-path title ≥0.8 AND body ≥0.5) with `dedup.enabled` escape hatch; per-drop audit events on the posting path only (`buildFinalizeDropEvents`, gated on `!finalizeRetriedPastPost`).
- **Priority File Selection, Generated Detection & Evidence Gate (Phase 15, 5 plans):** pure `core/priority.ts` scoring (sensitive-paths +5; tests/docs/examples/generated/dist/build −5; lockfiles/minified/sourcemaps −100; size bonus +min(5, changes/50); changeType +1/+0.5/−1); content-based `isGeneratedFile` detector (bounded 500-char × first-two-hunks upper-cased String.includes); soft `existingCode` evidence gate (`normalizeForEvidence` + `evidence_missing{absent|not_in_hunk}` audit emission; still posts, audit-only).
- **Dashboard Catch-Up (Phase 16, 6 plans):** `ReviewSettingsPanel` edits every persisted + v1.2 key with immutable nested spreads + 4-arg `api.updateRepoConfig`; `comment-card.tsx` category tag + confidence chip + line-clamp-2 title + break-all path; `job-severity-summary.tsx` 5-band strip + duration; `critic-panel.tsx` kept/pruned + skipped state; `audit-trail-viewer.tsx` grouped by stage + truncation banner; `stats.tsx` severity/category/performance charts; visual backstops under Nix/Chromium (deferred to Phase 20 closure).
- **Provider Groundwork (Phase 17, 4 plans):** `VcsProvider.getFileContent(path, ref)` + `getCompareDiff(base, head)` + `getUnresolvedBotThreads` + `resolveThread` on both providers; GitHub gains a GraphQL reviewThreads/resolveReviewThread path; Bitbucket via comments+resolve; capability flags (`threadResolutionSupported` downgrades on 403/404/501) for safe degradation; SC4 grep test ensures no consumers wired prematurely.
- **Incremental Re-review & Rounds (Phase 18, 6 plans):** migration 011 `pr_review_state.last_reviewed_sha/last_review_round/last_reviewed_at`; pure `resolveRoundContext` round detection (round 1 vs round 2+); pure `selectDiffForRound` (try compare → fallback on throw/empty → full-diff fallback → no_changes on empty); pure `composeRoundFloors` (round 2 = 0.8/P2, round 3+ = 0.85/P2, user-set wins, `rounds.escalate_floors: false` disables); pure `overlapsOpenThread` + `suppressByOpenThreads` (range-inclusion match, outdated/empty-line ignored); atomic anchor write at finalize; head-SHA-empty guard.
- **Verify-Fixes, Critic v2, Ensemble & Walkthrough Enrichment (Phase 19, 10 plans including gap-closure 19-10):** migration 013 (three nullable JSONB columns); `core/verify-fixes.ts` windowed content (full ≤500 lines / 50-line windows); `core/critic-v2.ts` canonical one-row-per-candidate decision ledger; `core/ensemble.ts` majority vote + `matchCompositeRule` reused from dedup.ts; `core/walkthrough-enrichment.ts` `projectEnrichment` + `clampConfidenceDownward`; provider-neutral ensemble temperature; Google subrequest accounting once per actual fetch; pinned default oracle from detached pre-Phase-19 commit `3d5f4150f8ff88787c10a3067ddc59176285eb25`; Plan 19-10 closed a post-verification gap (FULL_CONTENT_LINE_CAP restored from 100 to 500; dead `processVerifyFixesBatch` placeholder + types removed; misleading test header comment fixed).
- **v1.2 Closure (Phase 20, 3 plans):** `STAGE_ORDER` adds synthetic `ensemble` stage after `critic`; `normalizeAuditDisplayStage` maps `ensemble.voted -> ensemble` + `walkthrough.enrichment -> walkthrough` (GAP-INT-01 closure); `buildWalkthroughEnrichmentAuditEvent` (pure, bounded) + `recordWalkthroughAudit` (best-effort, never-throws) + `parseWalkthroughEnrichmentResponse.malformedFields` provenance preserves `partial` status (GAP-INT-02 closure); AUD-01 sign-off structure with human signature/date gate (D-07); visual backstops against production Vite/Tailwind CSS (D-08/D-09).
- **v1.2 Gap Closure (Phase 20.1, 8 plans):** all 5 BLOCKERs + 1 WARNING closed by separate plans — `redactFindingTitle` (16-char fixed marker for non-empty titles) + `redactErrorMessage` (5-machine-error enumeration) routed through all 8 audit producer sites (BLOCKER-1); `nextPhaseAfterReview` selector walks all successors including `walkthrough.enabled` (BLOCKER-2); `nextPhaseAfterVerifyFixes` selector wired into terminal handler; critic ceiling + verify_fixes ceiling both use canonical selectors (BLOCKER-3); verify-fixes idempotency + review-rest guards schedule successor via `markJobContinuationQueued` + `NextPhaseError` (BLOCKER-4); critic skip paths (empty input / explicit threshold / over-budget) emit `critic.decisions` audit event AND route through `nextPhaseAfterCritic` (BLOCKER-5); `loadProductionStylesheet` helper + scoped `vitest.config.ts:91` `globalSetup` + per-test try/finally `ServeHandle` lifecycle (WARNING-1); pre-existing test assertions asserting raw titles updated by commit `4b0b2ad` (BLOCKER-1 durable closure confirmation).

### What Worked

- **A dedicated contract-first foundation phase (Phase 13) paid off again** — same pattern as v1.1's Phase 7. Every later phase compiled against a stable substrate; the schema widening (audit union, severity band map, v1.2 config keys, ensemble/threads/rounds toggles) was inert at first commit and accreted only via `.passthrough()` additions. The full existing suite stayed green the whole time.
- **Build-the-primitive-once-before-two-consumers (Phase 17)** — same house pattern as v1.1's Phase 8. `getFileContent` / `getCompareDiff` / thread listing / resolution were frozen behind the capability-flagged seam before any consumer wired them. Phase 18 (rounds) and Phase 19 (verify-fixes) plugged into primitives that already worked on both providers, with capability-flagged degradation for Bitbucket's `/resolve` repo-token permission gap.
- **Subrequest-budget-aware pass scheduling (Phase 19, ensemble)** — `ESTIMATED_SUBREQUESTS_PER_FILE` re-derived deliberately against `chunk-concurrency.spec.ts` (the Phase 10 convention), never silently. Runs-aware budget admission kept the 50-subrequest/invocation budget honest under N=1..5 ensemble runs. Same pattern carried to verify-fixes windowed content and walkthrough enrichment.
- **Audit-trail discipline (Phases 13, 14, 15, 19, 20.1)** — every engine stage emits a per-stage event (`recordUnitAudit` / `recordWalkthroughAudit` / `recordRoundAudit` / `recordVerifyFixesAudit` / `recordFileSkips` / `buildFinalizeDropEvents`) to `jobs.audit`. The privacy contract held: titles route through `redactFindingTitle` ([title-redacted] / [clamped:empty]); error events route through `redactErrorMessage` (5-machine-error enumeration). The audit trail became a structurally safe operator surface — readable without SQL, groupable by stage, explainable per drop.
- **Canonical phase-routing selectors (`core/phase-routing.ts`)** — single source of truth for `nextPhaseAfterReview` / `nextPhaseAfterVerifyFixes` / `nextPhaseAfterCritic` (Phase 20.1 closure). Every ceiling and terminal handler routes through the canonical selector; loop-prevention asserted (verify_fixes never re-enters critic); all-toggle-combination integration tests in `test/review-flow.spec.ts`.
- **The pre-Phase-19 pinned default oracle (commit `3d5f4150f8ff88787c10a3067ddc59176285eb25`)** — captured the review output before Phase 19's LLM pass upgrades so NREG-01 byte-identity has a stable reference. Phase 19's regression spec verifies that the default-oracle output is unchanged. The plan 19-10 gap-closure was the kind of discipline this oracle enabled — restoring FULL_CONTENT_LINE_CAP from 100 to 500 because the boundary test pinned the wrong value.
- **Live UAT on the deployed instance (16-UAT.md)** — the four visual long-text backstops (E1/E2 repo-settings, E4 comment-card, E6 audit-viewer, E8 KPI tiles) were closed via live Playwright against `codra.tmichnicki.workers.dev`. E6 (audit-viewer) was a user-approved proxy because no live audit-bearing job was available at UAT time — but the source-level layout contract (`font-mono break-all` at every long-path surface) was independently corroborated live in Test 1 (E1/E2) using the same idiom.

### What Was Inefficient

- **Post-verification gap closure on Phase 19 (Plan 19-10):** the executor deviated from the 19-02 spec by setting `FULL_CONTENT_LINE_CAP = 100` instead of 500; verification caught it because the boundary test pinned the wrong value (a self-policing failure). Plan 19-10 restored the cap, removed the dead `processVerifyFixesBatch` placeholder export + types, and corrected the misleading test header comment. **Lesson:** the pinned default oracle convention caught a regression a normal review would have missed — it paid for itself within one phase. The cost was ~10 minutes for one extra plan; the saving was not shipping a verify-fixes regression to production.
- **5 BLOCKERs + 1 WARNING found post-Phase-20 (Phase 20.1 gap closure, 8 plans):** the integration audit caught defects that each per-phase verification missed — `nextPhaseAfterReview` did not check `walkthrough.enabled` (BLOCKER-2 walkthrough-only review was unreachable); `nextPhaseAfterVerifyFixes` had no caller (BLOCKER-3 verify-fixes bypassed critic); verify-fixes idempotency guards returned normally without scheduling successor (BLOCKER-4 terminal stop); persisted skipped Critic ledgers skipped audit emission + walkthrough routing (BLOCKER-5); raw finding titles + arbitrary Error.message reached `jobs.audit` after Phases 14/15/19 (BLOCKER-1 audit privacy); visual backstops used hardcoded utility CSS rather than loading production CSS (WARNING-1). **Lesson:** per-phase verification is necessary but not sufficient for cross-phase flows (especially toggle combinations and audit-projection paths). The 20-UAT re-run + cross-flow integration tests in `test/review-flow.spec.ts` (6 new cases for all toggle combinations + loop-prevention) close the cross-phase gap going forward.
- **Plan-count undercounts in ROADMAP.md + STATE.md:** ROADMAP progress table claimed 8 phases / 42 plans for v1.2; the actual count is 9 phases / 49 plans (Phase 17 expanded from 3 to 4 plans; Phase 19 expanded from 9 to 10; Phase 20.1 expanded from 5 to 8 during execution). STATE.md's `progress:` block carried the stale count. **Lesson:** the milestone-complete CLI undercounts when phase structure changes mid-milestone (an inserted phase, or plan additions during execution) — same pattern as v1.1's milestone-complete CLI undercounting Phase 12. Verify the generated stats against the actual `phases/*/` artifact directories, not the ROADMAP progress table.
- **Phase 19 reviewer disagreed with executor on FULL_CONTENT_LINE_CAP value (Plan 19-10 root cause):** the executor's deviation from the 19-02 spec was the kind of thing a stricter plan-executor handoff would have caught before commit. **Lesson:** the Phase-19 boundary-test pin (`FULL_CONTENT_LINE_CAP` constant import in test fixtures, parameterized 499/500/501/575) caught the deviation — but only because verification ran AFTER the wrong value landed. Earlier lint-time or commit-time checks against spec text would have caught it before commit.

### Patterns Established

- **Pure-rule + pure-writer + one-wire-site pattern (Phase 13 severity + audit):** `core/severity.ts` (pure, TDD-pinnable, 23 cases), `core/audit.ts` (pure builders + best-effort recorders), one-call-each wire sites in `model-output.ts` and `services/model.ts`. The same shape extended to ensemble (`core/ensemble.ts`), walkthrough enrichment (`core/walkthrough-enrichment.ts`), phase routing (`core/phase-routing.ts`), and rounds (`core/rounds.ts`).
- **Open discriminated union + `.passthrough()` for additive audit variants** — `jobAuditEventSchema` stayed a discriminated union on `stage`; Phases 14/15/18/19 added additive variants (`filtered`, `deduped`, `severity_adjusted`, `file_skipped`, `evidence_missing`, `rounds.*`, `walkthrough.enrichment`, `critic.decisions`) without back-migrations. Unknown stages still reject per-event.
- **Migration-numbering continues** — 010 (`jobs.audit` + `jobs.audit_truncated`), 011 (`pr_review_state.last_reviewed_*` + `jobs.review_round`/`review_mode`), 012 (rounds diff selection descriptor), 013 (Phase-19 durable results: `jobs.thread_verifications`, `jobs.walkthrough_enrichment`, `file_reviews.ensemble_result`). Each migration is the SOLE owner of its columns — no back-migrations.
- **Capability-flagged degradation for VCS seam widening** — `threadResolutionSupported` downgrades on first observed 403/404/501 per-invocation isolation; `supportsMermaid` continues from v1.1. Consumers never see a silent GitHub-only failure; the failure surfaces as a no-op + a capability-flag report.
- **Pinned default oracle for LLM-pass upgrade regressions** — `scripts/capture-phase19-baseline.mjs --check` verifies the default-oracle output is unchanged since the detached pre-Phase-19 commit `3d5f4150f8ff88787c10a3067ddc59176285eb25`. The convention is reusable for any future LLM-pass upgrade phase.
- **Always-on correctness fixes with single-key escape hatches** — `severity_engine.enabled`, `dedup.enabled`, `file_selection.enabled` (Phase 13/14/15). Each is default-on, has one escape hatch that reverts to byte-identical pre-fix behavior, and ships with a release note documenting the expected operator-visible shift. NREG-01 stays consistent because the changes are framed as correctness fixes, not new opt-in capabilities.
- **Production-CSS visual backstops, scoped globalSetup** — `loadProductionStylesheet` helper loads the real Vite/Tailwind build; `vitest.config.ts:91` globalSetup is scoped to the browser project's nested `test` block so node-only specs do not build `dist/client`; per-test try/finally `ServeHandle` lifecycle prevents port leaks. Hardcoded utility CSS is now treated as a false-positive backstop.
- **Privacy-redacted audit events as a first-class contract** — `redactFindingTitle` ([title-redacted] / [clamped:empty]) + `redactErrorMessage` (5-machine-error enumeration). All 8 audit producer sites route through the helpers; pre-existing test assertions asserting raw titles are updated to assert the redacted shape.

### Key Lessons

1. **Audit-trail privacy is a first-class contract, not an afterthought** — when the integration audit caught raw finding titles + arbitrary Error.message reaching `jobs.audit` (BLOCKER-1), the fix was structurally simple (route every title-bearing producer through `redactFindingTitle`; route every error-message-bearing producer through `redactErrorMessage`) but the durable contract now lives in code (`src/server/core/audit-redact.ts`) and tests (18 `audit-redact.spec.ts` cases + `audit-events.spec.ts` BLOCKER 1 group + 60 `model-output.spec.ts` cases + 28 `ensemble.spec.ts` cases). The audit trail is now a structurally safe operator surface on both providers — readable without SQL, explainable per drop, privacy-redacted by default.
2. **Per-phase verification is necessary but not sufficient for cross-phase flows** — the post-Phase-20 integration audit caught 5 BLOCKERs + 1 WARNING that each per-phase verification missed. The fix was cross-flow integration tests in `test/review-flow.spec.ts` (6 new cases for all toggle combinations + loop-prevention). Going forward, every LLM-pass-upgrade phase needs an integration-audit re-run before its own `passed` status is durable.
3. **Pinned default oracles catch regressions a normal review would miss** — Plan 19-10 (FULL_CONTENT_LINE_CAP restoration from 100 to 500) was enabled by the pre-Phase-19 oracle convention. The boundary test pinned the wrong value because the executor's spec-deviating commit landed first; verification caught it via the oracle check. **Lesson:** when a phase adds a tuned constant, the test fixtures must import the constant verbatim (not the literal value) so a future change to the constant doesn't silently de-pin the test.
4. **The audit-trail-viewer parity lesson** — every persisted audit variant needs a STAGE_ORDER entry + a normalizeAuditDisplayStage mapping + a DecisionEvent renderer case. The Phase 20 GAP-INT-01 closure (ensemble.voted → ensemble) and GAP-INT-02 closure (walkthrough.enrichment → walkthrough) added both stages AND the corresponding renderers. **Lesson:** when designing an audit variant, ship the viewer wiring in the same plan, not as a separate closure phase.
5. **Verify interactive/provider-specific behavior live, even when tests cover it** — Phase 16's four visual backstops (E1/E2 repo-settings, E4 comment-card, E6 audit-viewer, E8 KPI tiles) were closed via live Playwright against the deployed instance. Three were direct observation; E6 was user-approved proxy evidence because no live audit-bearing job was available. **Lesson:** visual contracts ship a proxy-evidence backstop but the durable fix is the production-CSS loading (Phase 20.1 WARNING-1 closure) so future UAT runs against the real bundle.
6. **Capability-flagged seam widening before consumer wiring** — Phase 17 built `getFileContent` / `getCompareDiff` / thread listing + resolution on both providers behind capability flags, with NO consumers wired. Phases 18 and 19 plugged into primitives that already worked. **Lesson:** the VcsProvider-widening-before-consuming pattern from v1.0 (`VcsService.forRepo`/`forProvider` branch point) carries forward — extract-before-second-caller is the load-bearing discipline for any provider-abstraction widening.

### Cost Observations

- **Velocity signal:** 164 commits / 49 plans over 5 calendar days for a milestone touching the engine core, the durable pipeline, the audit trail, the webhook/queue layer, prompts, four migrations, dashboard UI, and a new ensemble/walkthrough LLM-pass surface — with zero GitHub regressions and zero new npm dependencies at any point. **164 commits / 49 plans / 5 days = ~3.3 plans/day** vs v1.1's **178 commits / 29 plans / 7 days = ~4.1 plans/day**. v1.2 was ~20% slower per plan, reflecting the higher per-plan cost of contract-first widening + audit-trail discipline + cross-phase integration audits.
- **Phase 20.1 was an 8-plan unplanned gap-closure** — 5 BLOCKERs + 1 WARNING caught by the integration audit. Phase 20.1 added ~30% to the v1.2 plan count. The cost is real but bounded — every gap-closure plan was scoped to a specific BLOCKER with full evidence.
- **Model mix and per-session token cost** still not tracked in phase artifacts (carried from v1.0, v1.1). The `verify-fixes` LLM call (THR-01) and the ensemble `runs` extra calls (PASS-02) are the new token-cost surfaces introduced in v1.2; both are bounded by `chunk-concurrency.spec.ts` re-derivation against `ESTIMATED_SUBREQUESTS_PER_FILE`.

---

## Milestone: v1.0 — Bitbucket Cloud Support

**Shipped:** 2026-07-14
**Phases:** 6 | **Plans:** 19 | **Timeline:** 2026-07-12 → 2026-07-14 (2 days)

### What Was Built
- Additive schema foundation (`vcs_provider`, provider-agnostic job reference columns) with zero risk to existing GitHub rows
- A `VcsProvider` interface + `VcsService` branch point carrying GitHub's existing pipeline with zero behavior change
- A shared, provider-agnostic webhook ingestion module (`core/webhook-ingest.ts`) reused byte-identical by both providers
- Encrypted (AES-GCM) Bitbucket bot credential storage with a 4-state dashboard status panel
- A full Bitbucket Cloud adapter: REST client, signature-verified webhook route, diff fetch, inline findings, Code Insights report, build status
- Bitbucket OAuth dashboard login and a provider-aware "add repo" onboarding flow

### What Worked
- **Regression-net-before-refactor** (Phase 2): writing tests that pin GitHub's lease/heartbeat, `forceFreshInstance`, and supersede-on-new-push invariants *before* touching `core/review.ts` made the `VcsService` flip land the same day with zero incidents — the same tests stayed green through and after the change.
- **Extract-before-second-caller** (Phase 3): pulling webhook dedup/insert/supersede/enqueue into `core/webhook-ingest.ts` while GitHub was still the only caller avoided any risk of the two providers' ingestion logic silently diverging.
- **Reuse over invention**: Bitbucket credential encryption reused `core/llm-crypto.ts`'s AES-GCM pattern instead of a new one; `core/bitbucket.ts` mirrored `core/github.ts`'s hand-rolled-REST-client shape. Both meant less new surface to get wrong.
- **NREG-02 held continuously**: every phase's own success criteria plus a final milestone-audit re-run (387/387 tests, clean typecheck) confirm GitHub's behavior never regressed across the whole milestone.
- **Wave-gated TDD** (Phases 4 and 6 Wave 0): RED test scaffolds for the whole phase's contracts were written and confirmed failing before any implementation wave began.

### What Was Inefficient
- RED-phase test scaffolds themselves contained bugs that had to be fixed before they could correctly gate implementation: a missing `repository.name` field (05-04), a sentinel-value collision (06-04), and a BitbucketAdapter test that silently skipped assertions because a diff cache wasn't seeded (05-03). Each cost a debugging cycle before the "real" implementation work could start.
- Two mid-implementation Edit/reconstruction incidents (`supersedeOlderJobs` section broken by a partial edit in 05-01; a stale orphaned `vcs_credentials` table left in the test DB in 04-03) required a follow-up fix-and-verify pass rather than landing clean the first time.
- A real `queryTransaction` atomicity bug was found and fixed during Phase 6 (06-04) — the transaction client wasn't being installed into `AsyncLocalStorage`, so "atomic" transactions weren't actually atomic until fixed.

### Patterns Established
- Provider branch point: `VcsService.forRepo`/`forProvider` as the single dispatch point for all VCS operations — future providers plug in here, not by threading conditionals through `core/review.ts`.
- Discriminated-union session types (`DashboardSessionUser`) for multi-provider dashboard auth, with a JSON allow-list parser (`parseAllowedUsersByProvider`) that falls back to the legacy single-provider format.
- Encrypt-at-boundary, never-return-ciphertext as the standard shape for any new secret-storage REST API (mirrored from `routes/api/models.ts` for `/api/vcs-credentials`).
- KV keys that need to vary by provider get a `${provider}:${id}` prefix (D-29) rather than a schema migration, accepting that pre-existing keys under the old format silently orphan.

### Key Lessons
1. Pin existing invariants with regression tests *before* refactoring shared infrastructure that a second consumer will depend on — it turns a risky flip into a same-day, zero-incident change (Phase 2).
2. Extract shared logic before the second caller exists, not after both callers are written and need reconciling — avoids divergence risk entirely (Phase 3).
3. TDD RED scaffolds need their own scrutiny — a RED test with a bug (missing field, bad sentinel, unseeded cache) can look like a passing gate for the wrong reason. Budget time to sanity-check the test itself, not just watch it fail red.
4. When a new capability needs a pattern the codebase already solved well (encryption, hand-rolled REST client, credential status API shape), copy that pattern rather than design a new one — it was consistently the fastest and safest path this milestone.

### Cost Observations
- Model mix and per-session token cost were not tracked in this milestone's phase artifacts (STATE.md's performance-metrics table has empty duration fields) — instrument this for the next milestone if cost tracking matters.
- Notable efficiency signal: 83 commits / 19 plans over 2 calendar days for a milestone touching schema, a provider abstraction, a new REST client, encrypted credential storage, and two new UI flows, with zero GitHub regressions at any point.

---

## Milestone: v1.1 — Interactive Multi-Pass Review

**Shipped:** 2026-07-21
**Phases:** 6 (07-12) | **Plans:** 29 | **Timeline:** 2026-07-14 → 2026-07-21 (7 days, 178 commits)

### What Was Built
- Contract-first schema/toggle foundation (Phase 7): additive migrations (`file_reviews.pass` + widened index, `jobs.walkthrough_comment_ref`/`critic_result`, DB-backed `pr_review_state`), `critic` phase enum, `ReviewJobMessage` `+kind`/`+reviewScope`, default-off toggles, `supportsMermaid` capability, and a pre-flip regression net — zero behavior change.
- The shared `VcsProvider` comment primitive built once before any consumer (Phase 8) — `createPrComment`/`editPrComment`/`listPrComments` on both providers, opaque `{ ref }` — later extended with `replyToPrComment` (Phase 12).
- Streaming walkthrough (Phase 9): placeholder → in-place walkthrough (coverage + severity counts + optional GitHub-only Mermaid), durable across fresh-instance handoff, tolerant malformed-item recovery.
- Multi-pass engine (Phase 10): security pass as `(file, 'security')` work units, deterministic near-duplicate suppression, and a fail-open `critic` phase — `union(main,security) → dedup → critic → floors → post`, within the 50-subrequest budget, critic off `finalize`.
- Bot commands + PR Q&A (Phase 11): webhook-layer dispatch, self-filter-first echo-loop defense, DB-backed pause, member-auth by immutable id, injection-resistant read-only Q&A, Bitbucket `pullrequest:comment_created`.
- Interactive polish (Phase 12): threaded replies (GitHub `in_reply_to` / Bitbucket `parent`) + a Bitbucket-aware dashboard repo-config path (nullable `installationId`, lazy default config, provider-conditional UI).

### What Worked
- **A dedicated contract-first enabler phase (Phase 7) paid off:** landing all migrations, enum/message widening, and default-off toggles inert *before* any consumer meant every later phase compiled against a stable substrate, and the v1.0 suite stayed byte-identical the whole time.
- **Regression-net-before-refactor, repeated:** the pre-flip net was warmest for the highest-blast-radius change (Phase 10's multi-pass engine), so the security pass + critic landed without a GitHub regression — the same house pattern that carried v1.0's `VcsService` flip.
- **Build-the-primitive-once-before-two-consumers (Phase 8):** the comment primitive was frozen behind the interface before both the walkthrough (Phase 9) and commands (Phase 11) needed it — no divergence between the two callers.
- **Config-gated default-off discipline (NREG-01) held continuously** across all six phases; features are byte-identical when disabled, verified by both-provider parity tests.
- **Live verification on real PRs/deployed instance** caught what tests couldn't: the Bitbucket `parent:{id}` threaded reply (MEDIUM research confidence) and the Phase-12 dashboard round-trip were confirmed against a real Bitbucket PR and the deployed instance via Playwright.

### What Was Inefficient
- **Phase 12 was added mid-milestone** as a Phase-11 UAT follow-up (threaded replies + Bitbucket dashboard config) — the interactive UX gaps surfaced only during hands-on UAT, after Phase 11 was "done"; ideally those would have been scoped into Phase 11.
- **A run of post-hoc quick-fix tasks** (bot-mention trigger mismatch, config-based Bitbucket bot identity, CodeQL sanitization, dashboard version) addressed real gaps discovered after the owning phase closed rather than within it.
- **The milestone-complete CLI undercounted** (5 phases/24 plans, Phase 12 omitted, 2 garbage accomplishment bullets) because it trusted STATE.md's stale progress counters and the ROADMAP Progress table (which didn't list the inserted Phase 12) — the MILESTONES.md entry had to be corrected by hand against ground truth.
- **Nyquist `VALIDATION.md` left at `draft`** for phases 08/10/11/12 (seeded, never reconciled) — non-blocking, but a recurring process gap (Phase 5 had the same issue in v1.0).

### Patterns Established
- `(file, pass)` work-unit modeling to add a second review pass within a *fixed* subrequest budget — more chunks, not a higher per-unit cost; re-derive the budget constants deliberately against `chunk-concurrency.spec.ts`, never silently.
- Fail-open, idempotent, own-phase model calls for anything expensive and non-critical (critic): persist the result, read-only on retry, never on the budget-fragile `finalize`.
- Webhook-layer dispatch with **self-filter-the-bot-first** as the load-bearing echo-loop defense, keyed on immutable id.
- Capability signals (`threadable`, `supportsMermaid`) set at the boundary that owns the fact (webhook event type / provider), never inferred downstream.
- Provider-addressed (`?provider`) dashboard config reads/writes so a same-named GitHub+Bitbucket pair never cross-binds.
- Injection-fence all untrusted PR/comment/diff text through one shared sanitizer reused across review, walkthrough, and Q&A prompts.

### Key Lessons
1. A dedicated contract-first foundation phase (schema + toggles + regression net, all inert) is worth it before a multi-phase feature wave — later phases compile against a stable substrate and the base suite never goes red.
2. Verify interactive/provider-specific features **live**, not just in tests — the Bitbucket threaded reply and dashboard round-trip were only truly confirmed on a real PR and the deployed instance.
3. Don't trust a milestone-close tool's auto-counts when phase structure changed mid-milestone (an inserted Phase 12) and STATE.md counters are stale — verify the generated MILESTONES.md against the actual phase/plan set.
4. When UAT of an interactive phase keeps surfacing polish gaps, budget an explicit follow-up/polish phase up front rather than discovering it after the phase closes.

### Cost Observations
- Model mix and per-session token cost again not tracked in phase artifacts; STATE.md per-plan durations are partially recorded (phases 07-12, see the metrics table).
- Efficiency signal: 178 commits / 29 plans over 7 calendar days for a milestone touching the engine core, the durable pipeline, the webhook/queue layer, prompts, three migrations, and dashboard UI — with zero GitHub regressions and zero new npm dependencies at any point.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Plans | Days | Commits | Key Change |
|-----------|----------|--------|-------|------|---------|------------|
| v1.0 | not tracked | 6 | 19 | 2 | 83 | First multi-provider milestone; established regression-net-before-refactor and extract-before-second-caller as house patterns for provider-abstraction work |
| v1.1 | not tracked | 6 | 29 | 7 | 178 | Feature-wave milestone on the dual-provider base; added a dedicated contract-first foundation phase and `(file, pass)` budget-aware multi-pass; every new capability shipped on both providers, config-gated default-off |
| v1.2 | not tracked | 9 | 49 | 5 | 164 | Engine-quality milestone on the v1.0/v1.1 dual-provider + interactive base; added deterministic severity + audit-trail foundation, priority file selection, incremental rounds, verify-fixes, critic v2, ensemble, walkthrough enrichment; privacy-redacted audit trail as first-class contract; pinned default oracle + cross-flow integration tests for cross-phase regression catch |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|--------------------|
| v1.0 | 387 (node) + 47 (browser) | not tracked | 0 (no new npm dependencies — hand-rolled REST client and existing crypto pattern reused per constraint) |
| v1.1 | 795 (node + browser) | not tracked | 0 (no new npm dependencies — new client methods, Zod shapes, prompts, and additive migrations 007-009 only) |
| v1.2 | 1550 (node) + 102 (browser) | not tracked | 0 (no new npm dependencies — additive migrations 010-013, new server/core modules, new client libs, new dashboard UI surfaces only) |

### Top Lessons (Verified Across Milestones)

1. Regression-net-before-refactor and extract/build-primitive-before-second-consumer — **cross-validated by v1.1 (Phase 8 comment primitive, Phase 10 multi-pass engine) AND v1.2 (Phase 17 VcsProvider widening)**: the same discipline carried the highest-blast-radius engine changes every time, with zero regression.
2. Config-gated default-off (NREG) as the standing discipline for any feature added to a shared pipeline — held continuously across all 24 phases of v1.0 + v1.1 + v1.2. v1.2's three always-on correctness fixes (`severity_engine`, `dedup`, `file_selection`) are framed as documented exceptions with single-key escape hatches and release notes, NOT as NREG-01 violations.
3. Verify interactive/provider-specific behavior live (real PR + deployed dashboard), not just in tests — **stress-tested by v1.2**: Phase 16's four visual backstops were closed via live Playwright on `codra.tmichnicki.workers.dev`; Phase 20 visual backstops verified against production Vite/Tailwind CSS (Phase 20.1 WARNING-1 closure); the audit-trail-viewer parity was confirmed via the integration audit (Phase 20 GAP-INT-01/02 closure).
4. Contract-first widening before consumer wiring — **cross-validated by v1.1 (Phase 7 schema/migration foundation, Phase 8 comment primitive) AND v1.2 (Phase 13 severity+audit foundation, Phase 17 VcsProvider widening)**: every later phase compiled against a stable substrate; the existing suite stayed green the whole time.
5. Per-phase verification is necessary but not sufficient for cross-phase flows — **introduced by v1.2 (Phase 20.1 gap-closure)**: 5 BLOCKERs + 1 WARNING caught by the post-Phase-20 integration audit that per-phase verification missed. Cross-flow integration tests + pinned default oracles + integration-audit re-runs are the closing discipline.
6. Audit-trail privacy as a first-class contract — **introduced by v1.2 (Phase 20.1 BLOCKER-1 closure)**: every persisted audit variant must route through `redactFindingTitle` + `redactErrorMessage`; the durable contract lives in code and tests. Privacy-redacted audit is now the operator surface, not the leak surface.
