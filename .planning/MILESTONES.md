# Milestones

## v1.4 Deferred Candidates (Shipped: 2026-07-31)

**Phases completed:** 11 phases, 37 plans, 85 tasks

**Key accomplishments:**

- EvidenceMissingEntry.line in evidence_missing_summary sample now carries the pre-orphan-remap original model-cited line instead of the post-remap orphan-resolved line
- Persist modelLineCap at async submit time into file_reviews.model_line_cap so pollReviewBatch uses the exact submit-time haystack boundary, with COALESCE preservation through persistCompletedReview, dual-param fallback for legacy rows, and three-layer test coverage
- normalizeAuditDisplayStage maps evidence_missing_summary to the existing evidence_missing display group; the DecisionEvent switch renders file+pass identifiers, absentCount/notInHunkCount metrics, and up to 20 sample entries in the audit-trail viewer
- Direct instruction — "automate this for me" at Phase 25 Task 3 checkpoint
- Evidence config schema (bounded at 20), shared checkEvidence module extracted from model-output.ts, buildEvidenceHardDroppedEvent audit builder, and load-time Zod default injection — the contract layer for the hard-drop gate wired in 26-02
- Evidence hard-drop gate wired into finalize (drop-before-dedup, persisted at-most-once audit), config PATCH deep-merge fix, 3 integration tests, dashboard evidence section + audit renderer, and migration 015 persisting existing_code for immutable retry re-evaluation
- Completed.
- Completed.
- Cross-file security toggle added to the Passes section of ReviewSettingsPanel, wired to passes.security.cross_file with full dirty tracking
- Contract-first schema for learned-rule synthesis: learning config toggle, learned_rule_suppressed audit event, 4 denormalized columns on reject_feedback, VCS getInlineCommentDetails interface with GitHub/Bitbucket implementations, and reject handler enrichment
- Learned-rule synthesis algorithm, suppression logic, finalize pipeline wiring, audit event emission, and API endpoints for rule management
- LearnedRulesPanel and RuleCard components wired into repo config modal with learning toggle dirty-tracking, synthesize button, rule status transitions, and audit stage normalization for learned_rule_suppressed
- GitHub reject enrichment now joins `review_comments.position` (the diff offset Codra actually posts by) while Bitbucket keeps joining `line`, with a body-based tiebreak for colliding coordinates — closing G-28-3, the blocker that made every GitHub rejection enrich to NULL and left LRN-01 unreachable.
- Postgres-native codebase index proved end to end: migration 018's tsvector+GIN tables, one shared non-backtracking identifier splitter, an A/D-weighted upsert with ranked repository-scoped retrieval, and retrieved hunks fenced in their own untrusted-context pair inside a real `buildQaPrompt` call.
- `review.interactive.qa.index.{enabled, max_files, chunk_lines, top_k}` lands default-off with `.max()` bounds of 2000/500/50, materialized at all four Zod resolution paths and pinned by 14 parse assertions including a 2000/2001 boundary pair.
- One `listDefaultBranchTree` seam method on both adapters — GitHub in three fixed subrequests, Bitbucket in an SSRF-guarded, cycle-guarded, budget-aware, page-capped `/src` walk that degrades to a flagged partial tree — plus `scorePath` and `isGeneratedContent` extracted additively so the indexer can rank a bare path and classify bare content without fabricating a `FileDiff`.
- The index DB module is now complete for both consumers — refresh, atomic per-repository rebuild with deleted-row counts, per-file resumability including zero-chunk skips, a hibernation-safe build lease whose release also resolves the operator-visible status, and already-redacted terminal failure — with all four DB-level guarantees pinned by 25 named cases against the live test Postgres.
- The codebase index now builds on its own `INDEX_WORKFLOW` binding at all four wiring sites, with an index-specific per-file subrequest estimate re-derived from first principles rather than inherited, per-file resumability read at the in-progress sha, a lease that coalesces a concurrent start without letting the loser truncate, and 27 named cases pinning every one of those properties.
- A merge to the default branch now refreshes exactly the changed files on BOTH providers — GitHub's `push` and Bitbucket's `repo:push` each route through one provider-symmetric path into an incremental `INDEX_WORKFLOW` build keyed on the shared `codeIndexInstanceId` — and the Bitbucket route's identity contract no longer rejects a `repo:push` delivery before it is ever verified, with the verification order byte-identical and a bad signature still returning 401.
- Task 1 — `findRepositoryIdByIdentity` + the fail-open retrieval block
- The codebase index now has the only thing that can bring it into existence — a session- and CSRF-guarded `POST .../code-index/build` that claims the build lease under the very instance id it keys the Workflow on, plus a `GET .../code-index/status` that gives a never-built repository a well-defined answer instead of a 404 — both working for a Bitbucket repository with a NULL installation, and both pinned by 12 cases that re-read every persisted claim from Postgres.
- QA-IDX-01 now has its operator surface: a Codebase Index panel in the repository config modal that renders the three real states (disabled / never-built / built), posts one build and refetches status from the server, tells the operator what produced the index and when it is partial or failed, and — for a Bitbucket repository whose freshness path has never fired — says exactly which webhook event is missing. Tasks 1-2 shipped the panel; a same-day Task 3 UAT session deployed it, found and fixed eleven real production bugs/gaps (see below), confirmed a full build completes end to end on both GitHub and Bitbucket, confirmed the retrieval-backed Q&A mechanism itself works correctly on BOTH providers in BOTH toggle directions, found and fixed a real cross-provider full-text-search ranking-quality issue on Bitbucket (a code-vocabulary stopword gap, pinned with a regression test AND re-verified live in production against the exact repo/file that originally failed), and — after finding and fixing a bigger-scope bug that had silently disabled push-triggered incremental refresh on BOTH providers, a pre-existing Bitbucket repo misconfiguration, AND a GitHub App webhook subscription that had never included the `push` event at all — confirmed a real push-triggered incremental refresh completes end to end on BOTH GitHub and Bitbucket, resolving A2 and the GitHub post-merge check. Every item on Task 3's checklist is now technically verified; the checkpoint itself awaits the developer's explicit sign-off.
- `review.bitbucket.annotations_enabled` config toggle plus the pinned `ANNOTATION_REPORT_ID`/severity-map constants and `reportAnnotationSchema` contract that Plans 30-02/30-03/30-04 build on
- `BitbucketClient.bulkUpsertAnnotations`/`deleteCodeInsightsReport` plus a widened `upsertCodeInsightsReport(reportId)` and `links`-carrying comment types, ready for Plan 30-03's adapter layer
- `BitbucketAdapter.postAnnotations` (delete-then-recreate, collision-resistant `external_id`, chunked bulk-POST) plus the `VcsProvider.postAnnotations?` seam and the `submitReview`/`buildDedupIndex` widening that closes the D-11 link-following gap
- `vcs.postAnnotations` wired into `runFinalizePhase` — the last hop from a fully-built Bitbucket annotation capability to a real PR seeing per-line Code Insights annotations, closing out ANNO-01
- Real end-to-end Bitbucket workspace-repo discovery: dashboard form -> `/api/repos/bitbucket/workspaces/discover` -> live Bitbucket API -> already-onboarded annotation, with zero rows written to any table.
- Net-new `vcs_workspace_credentials` table + DB accessor module mirroring `vcs_credentials` 1:1, plus a shared `bitbucket-credential-resolution.ts` implementing the D-03 per-repo-wins precedence rule and the always-both webhook-candidate list -- disjoint from Plan 31-01's files, ready for Wave 2 to wire into the finalize endpoint and webhook route.
- `POST /api/repos/bitbucket/workspaces` persists the workspace credential and onboards ONLY the operator's explicitly selected repos in one transaction, then creates the workspace webhook idempotently outside it, returning a distinct 502 (not a bare 500) when webhook creation fails after the DB write has already committed.
- `webhook-bitbucket.ts` and `BitbucketAdapter.create` both now resolve credentials through the shared `bitbucket-credential-resolution.ts` helper from Plan 31-02 — the webhook route tries every candidate secret (per-repo and/or workspace-level) during HMAC verification, and the adapter resolves the bot-posting credential with per-repo-wins precedence — fully regression-tested with zero behavioral change to any path that doesn't yet have a workspace credential.
- A hand-rolled `Checkbox` primitive plus a fully interactive Bitbucket workspace repo-selection checklist -- select/deselect, Select all/none, already-onboarded badges, and a submit that finalizes onboarding via `POST /api/repos/bitbucket/workspaces` with a deterministic sorted payload.
- Replaced hardcoded type union with canonical FileReviewPass import and corrected misleading middleware comments on learned-rules API routes
- nextPhaseAfterCrossFileSecurity selector unit tests (6 cases covering all branches) and config-default drift detection covering every leaf node of repoConfigSchema.parse({})
- Broken migration script removed from disk and logger message argument now scrubbed through secret-redaction patterns; Google AI and Bitbucket token patterns added to embedded secret detection
- Webhook URL derived from APP_URL with undefined guard, repo-slug validation documented as accepted risk, and unused workspace credential exports deleted
- Verified stale D-01 audit finding already fixed; added fake timers to 2 slow withRetry tests reducing wall-clock by ~7s
- Reconciled all stale tracking across ROADMAP, STATE, PROJECT, and CONCERNS to reflect the shipped state of v1.4 and Phase 32 completion

---

## v1.3 Bounded Evidence Audit Telemetry (Shipped: 2026-07-26)

**Delivered:** Per-finding `evidence_missing` audit events are replaced with one bounded aggregate `evidence_missing_summary` per (file, pass) unit, WR-01 resolved by design, modelLineCap persisted at submit time, and the dashboard renders the new events alongside legacy ones — closing the ring-buffer flood vector and making EVID-02's eventual hard-drop signal reliable.

**Phases completed:** 5 phases (21-25), 6 plans
**Timeline:** 2026-07-25 → 2026-07-26 (2 calendar days)
**Verification:** 3/3 requirements satisfied; 4/4 phases Nyquist-compliant; milestone audit `passed`; `npm run typecheck` exit 0; human sign-off recorded 2026-07-26.
**Closeout type:** verified_closeout — 3 open audit artifacts acknowledged as documented (debug false-positive, newly-signed UAT, WR-01 resolved by design).

**Key accomplishments:**

- Aggregate `evidence_missing_summary` per (file, pass) with ≤20 sample cap and privacy-redacted titles (EVID-03, Phase 21)
- Original-line capture before orphan remap in summary sample (EVID-04, Phase 22)
- modelLineCap persisted at submit time, not re-derived from mutable state (AUD-03, Phase 23)
- Dashboard surface: normalizer mapping, grouping, and browser-verified renderer for evidence_missing_summary (Phase 24)
- Full milestone closeout: Nyquist validation (4/4 phases), formal scored audit matching v1.2 depth, human sign-off, archive (Phase 25)

**Deferred items:** EVID-02, SEC-XDIFF-01, LRN-01, QA-IDX-01, ANNO-01, WS-01 promoted to Active for v1.4.

---

## v1.2 Review Engine Quality & Re-review Lifecycle (Shipped: 2026-07-25)

**Delivered:** Codra gained deterministic severity and categories, an explainable audit-backed noise filter, priority file selection, incremental re-review rounds, verify-fixes, critic v2, ensemble voting, walkthrough enrichment, and dashboard visibility across both GitHub and Bitbucket Cloud.

**Phases completed:** 9 phases (13-20 + 20.1), 49 plans, including gap-closure Plan 19-10 and all eight Phase 20.1 plans
**Timeline:** 2026-07-21 → 2026-07-25 (5 calendar days, 164 commits)
**Verification:** 31/31 requirements satisfied; NREG-01, NREG-02, and signed AUD-01 passed; milestone audit `passed` after Phase 20.1 closed all 5 BLOCKERs + 1 WARNING.
**Test evidence:** 1550 node tests and 102 browser tests passed; `npm run typecheck` exited 0.

**Key accomplishments:**

- Deterministic severity/category correction, composite dedup, severity-tiered caps, category confidence floors, generated-file detection, and soft evidence validation, with explainable audit events for every engine-owned drop.
- Full review-config editing, finding telemetry, audit-trail rendering, and severity/category/performance statistics in the dashboard.
- Provider-neutral file-content, compare-diff, unresolved-thread, and thread-resolution primitives on GitHub and Bitbucket, followed by incremental round-2+ reviews and verify-fixes.
- Critic v2, partial-failure-tolerant ensemble voting, and deterministically clamped walkthrough confidence, effort, and change groups under the Cloudflare subrequest budget.
- Phase 20.1 repaired audit privacy, canonical successor routing, verify-fixes crash recovery, critic skip-path auditing, and production-CSS visual backstops.

**Deferred items:** EVID-02/WR-01, SEC-XDIFF-01, LRN-01, QA-IDX-01, ANNO-01, and WS-01 remain explicitly deferred in `STATE.md` and `PROJECT.md`.

---

## v1.1 Interactive Multi-Pass Review (Shipped: 2026-07-21)

**Delivered:** Codra's PR review is now richer and interactive — a multi-pass engine (main + dedicated security pass + critic), a streamed in-place walkthrough, and in-PR bot commands + free-form Q&A with threaded replies — across both GitHub and Bitbucket Cloud, with zero regression (every feature config-gated, default off, byte-identical when disabled) and zero new npm dependencies.

**Phases completed:** 6 phases (07-12), 29 plans, 795/795 tests green
**Git range:** `3d7c2cd`..`964e738` (178 commits, 212 files changed, +18,621/-1,738 lines)
**Timeline:** 2026-07-14 → 2026-07-21 (7 days)
**Verification:** 22/22 v1.1 requirements satisfied (20 feature + NREG-01/NREG-02 cross-cutting gates), 6/6 phases independently verified `passed`, full milestone audit passed with zero gaps (`.planning/milestones/v1.1-MILESTONE-AUDIT.md`).
**Closeout type:** override_closeout — Known verification overrides: 1 (a benign artifact-audit false-positive: the debug knowledge-base *index* file, not an open investigation — see STATE.md Deferred Items). Substantively a clean closeout.

**Key accomplishments:**

- **Multi-pass review engine (Phase 10):** a dedicated security pass runs as `(file, 'security')` work units alongside the main pass, deterministic near-duplicate suppression sits ahead of a fail-open `critic` phase on its own fresh subrequest budget — pipeline `union(main, security) → dedup → critic → deterministic floors → post`, all held within the Cloudflare 50-subrequest/invocation budget with the critic kept off the budget-fragile `finalize`.
- **Streaming walkthrough (Phase 9):** a placeholder comment posted in `prepare` and edited in place into a walkthrough (file coverage + per-severity counts + an optional GitHub-only Mermaid sequence diagram), durable across fresh-instance handoff via `jobs.walkthrough_comment_ref`, best-effort with tolerant malformed-item recovery, and gracefully omitting the diagram on Bitbucket.
- **Bot commands + PR Q&A (Phase 11):** webhook-layer dispatch of `review` / `review-rest` / `pause` / `resume` / `help` / `reject` / `ignore` plus injection-resistant, rate-limited, read-only free-form Q&A — self-filtering the bot's own comments first (echo-loop defense), DB-backed provider-agnostic pause, member authorization by immutable id, and a new Bitbucket `pullrequest:comment_created` subscription.
- **Shared `VcsProvider` comment primitive (Phases 8 & 12):** `createPrComment` / `editPrComment` / `listPrComments` / `replyToPrComment` on both GitHub and Bitbucket adapters, returning provider-opaque `{ ref }` keyed on immutable ids — built once behind the interface before any consumer wired it.
- **Contract-first schema & toggle foundation (Phase 7):** additive migrations (`file_reviews.pass` + widened unique index, `jobs.walkthrough_comment_ref` / `jobs.critic_result`, DB-backed `pr_review_state` pause table), the `critic` phase enum, `ReviewJobMessage` `+kind`/`+reviewScope`, all default-off feature toggles, the `supportsMermaid` capability flag, and the pre-flip regression net — contract-first, zero behavior change.
- **Interactive polish + Bitbucket dashboard config (Phase 12):** threaded command/Q&A replies under the originating comment (GitHub `in_reply_to` for inline review comments, Bitbucket `parent`), plus a Bitbucket-aware dashboard repo-config path (nullable `installationId`, lazy default `repo_config` materialization, provider-addressed read/write, and a provider-conditional Interactive settings UI) — so Bitbucket repos are configurable at GitHub parity.

**Known tech debt (non-blocking):**

- **Intentional v2 deferrals** (per REQUIREMENTS.md): SEC-XDIFF-01 (whole-diff cross-file security reasoning), LRN-01 (learned-rule synthesis — only the `reject` capture signal shipped via CMD-05), QA-IDX-01 (codebase-index-backed Q&A).
- **Nyquist coverage:** phases 08, 10, 11, 12 carry `draft` VALIDATION.md (seeded by plan-phase, never reconciled by validate-phase) — a coverage TODO, not a compliance failure; full suite is green and every phase VERIFICATION passed. Optionally run `/gsd-validate-phase 08 10 11 12` to promote to `validated`.
- **Integration advisories** (documented, no action needed): `forProvider` Bitbucket jobless path uses an inert placeholder `prNumber:0`; `dispatchInteractiveMessage` prefers the carried `configSnapshot` (deliberate Bitbucket collision guard).

---

## v1.0 Bitbucket Cloud Support (Shipped: 2026-07-14)

**Delivered:** Bitbucket Cloud PRs now receive the same automated AI review — inline findings, Code Insights report, build status — that GitHub PRs already get, from one Codra instance, with zero GitHub regression.

**Phases completed:** 6 phases, 19 plans, 43 tasks
**Git range:** `0ae4f61`..`8552cbc` (83 commits, 88 files changed, +10,928/-304 lines)
**Timeline:** 2026-07-12 → 2026-07-14 (2 days)
**Verification:** 22/22 v1 requirements satisfied, 6/6 phases independently verified `passed`, full milestone audit passed with zero gaps (`.planning/milestones/v1.0-MILESTONE-AUDIT.md`)

**Key accomplishments:**

- Additive schema migration (`repositories.vcs_provider`, `jobs.status_check_ref`/`review_ref`) with zero risk to existing GitHub rows, verified by an old-fixture-replay test (Phase 1)
- GitHub's review pipeline re-pointed through a new `VcsProvider` interface and `VcsService` branch point with zero behavior change, gated by a regression net written before the refactor (Phase 2)
- Webhook dedup/insert/supersede/enqueue logic extracted into a shared, provider-agnostic `core/webhook-ingest.ts`, reused byte-identical by both providers (Phase 3)
- Bitbucket bot authentication via AES-GCM encrypted Repository/Workspace Access Tokens (mirroring `core/llm-crypto.ts`), with a 4-state credential status panel in the dashboard (Phase 4)
- Full Bitbucket Cloud adapter shipped end-to-end: hand-rolled REST client, signature-verified webhook route, diff fetch respecting Bitbucket's 200-file/8,000-line caps, inline findings, Code Insights report, and build status (Phase 5)
- Bitbucket OAuth dashboard login and a provider-aware "add repo" onboarding flow, at parity with the existing GitHub UX (Phase 6)

**Known tech debt (non-blocking):** see `.planning/PROJECT.md` Context section and `.planning/milestones/v1.0-MILESTONE-AUDIT.md` for the full itemized list (cosmetic vitest hoisting warning, unreachable fail-open edge case, missing Phase 5 Nyquist validation, SUMMARY.md frontmatter gaps).

---
