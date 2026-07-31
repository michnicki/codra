# Roadmap: Codra

## Milestones

- 🚧 **v1.4 Deferred Candidates** — Phases 26-31 (scoped 2026-07-26) — 6 requirements: EVID-02, SEC-XDIFF-01, LRN-01, QA-IDX-01, ANNO-01, WS-01
- ✅ **v1.3 Bounded Evidence Audit Telemetry** — Phases 21-25 (shipped 2026-07-26): [milestones/v1.3-ROADMAP.md](milestones/v1.3-ROADMAP.md)
- ✅ **v1.2 Review Engine Quality & Re-review Lifecycle** — shipped 2026-07-25: 9 phases (13-20 + 20.1), 49 plans including 19-10, 31/31 requirements satisfied, milestone audit `passed`. Full history: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md)

### 🚧 v1.4 (Planned)

**Initiated:** 2026-07-26
**Scope:** 6 requirements (EVID-02, SEC-XDIFF-01, LRN-01, QA-IDX-01, ANNO-01, WS-01) — all 6 deferred candidates promoted
**Dependency order:** EVID-02 → SEC-XDIFF-01 → LRN-01 → QA-IDX-01 → ANNO-01 ∥ WS-01

### Phase 26: EVID-02 Hard-drop evidence gate

**Goal:** Promote EVID-01 from soft/audit-only to hard-drop — findings with hallucinated `existingCode` evidence are dropped from posted comments (not just recorded in audit). Config-gated (`evidence.hard_drop`, default off). Per-category opt-out.
**Requirements**: EVID-02
**Depends on:** v1.3 (Phase 21 EVID-03 bounded telemetry)
**Plans:** 2/2 plans complete

Plans:

**Wave 1**

- [x] 26-01-PLAN.md — Schema + evidence block (bounded at 20) + checkEvidence extraction + audit builder + config.ts default injection + 17 unit tests

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 26-02-PLAN.md — Finalize wiring (persisted finalizeRetriedPastPost gate) + API shallow-merge fix + integration tests + dashboard config UI + audit viewer renderer

### Phase 27: SEC-XDIFF-01 Whole-diff cross-file security reasoning

**Goal:** New LLM pass that sees the entire PR diff and reasons about security implications across file boundaries — e.g., auth middleware change + new unprotected route. Findings enter dedup → critic → post pipeline. Subject to subrequest budget.
**Requirements**: SEC-XDIFF-01
**Depends on:** Phase 26 (benefits from EVID-02 hard-drop being in place, structurally independent)
**Plans:** 3/3 plans complete

Plans:

**Wave 1**

- [x] 27-01-PLAN.md — Schema additions (7 changes) + PhaseName union + new prompt template + buildCrossFileDiff helper + audit builders + runCrossFileSecurityPhase handler + model output parser + unit tests (committed aa0c434)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 27-02-PLAN.md — Finalize candidate set merge (__cross_file__ findings) + walkthrough cross-file section + formatter cross-reference rendering + integration tests + NREG-01 byte-identical assertion

### Phase 28: LRN-01 Learned-rule synthesis from reject feedback

**Goal:** Cluster `reject` feedback (CMD-05 already captures) by similarity, synthesize suppression rules stored in repo config, dashboard-reviewable before activation. Config-gated (`learning.enabled`, default off).
**Requirements**: LRN-01
**Depends on:** Phase 26 (independent of SEC-XDIFF-01, benefits from EVID-02 signal)
**Plans:** 4/4 plans complete

Plans:

**Wave 1**

- [x] 28-01-PLAN.md — Schema additions (learning config block, audit event, RejectFeedbackRow) + migration 016 + VCS getInlineCommentDetails + reject handler enrichment

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 28-02-PLAN.md — Core learned-rules.ts (clustering + synthesis + suppression) + finalize wiring + audit event builder + API routes (POST synthesize, PATCH rule status)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 28-03-PLAN.md — Dashboard UI (LearnedRulesPanel + RuleCard) + repo config page integration + audit stage normalization

**Wave 4** *(gap closure — G-28-3 blocker from 28-UAT.md)*

- [x] 28-04-PLAN.md — Provider-aware coordinate enrichment (GitHub matches review_comments.position, Bitbucket keeps line) + deterministic collision tiebreak + the missing discriminating regression test

### Phase 29: QA-IDX-01 Codebase-index-backed Q&A

**Goal:** Index default-branch tree into embeddings/keyword index (KV or Postgres) on repo install. Q&A queries index for relevant code beyond PR diff. Index freshness via webhook push events. Config-gated (`qa.index_enabled`, default off).
**Requirements**: QA-IDX-01
**Depends on:** Phase 26 (independent, heaviest lift)
**Plans:** 9/9 plans complete

> Planning note: the goal line above restates REQUIREMENTS' original wording. Phase 29's locked
> decisions deliberately narrow it — Postgres native full-text search rather than embeddings (D-01),
> Postgres rather than KV (D-01), and an explicit dashboard build action rather than a repo-install
> trigger (D-07). The divergence table in `29-RESEARCH.md` records why each is a satisfaction of the
> requirement rather than a deviation from it.

Plans:

**Wave 1** *(tracer — verified before any expansion plan starts)*

- [x] 29-01-PLAN.md — Tracer: migration 018, the pure splitter/chunker, ranked repository-scoped retrieval, and the retrieved-context prompt fence, proven end to end

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 29-02-PLAN.md — Config contract: the `review.interactive.qa.index` block at all three Zod sites, default-off pinned (one-way decision checkpoint)
- [x] 29-03-PLAN.md — Ingest seam: `listDefaultBranchTree` on both adapters, the SSRF-guarded Bitbucket `/src` walk, and additive `scorePath` / `isGeneratedContent` extractions
- [x] 29-04-PLAN.md — Index refresh, per-file progress, build lease, and the DB guarantee battery (ranking, cross-repository isolation, pathological input)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 29-05-PLAN.md — `IndexWorkflow` on its own `INDEX_WORKFLOW` binding, re-derived subrequest budget, resumable build (one-way decision checkpoint)
- [x] 29-07-PLAN.md — Fail-open retrieval inside the read-only Q&A path, with the byte-identical disabled prompt pinned

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 29-06-PLAN.md — Default-branch push freshness on both providers, including the Bitbucket identity-projection fix that currently rejects `repo:push` before verification (blocking payload-shape verification: both cross-AI reviewers rated the unvalidated GitHub/Bitbucket push payloads the phase's top risk and asked for one real delivery per provider before this plan is considered complete)
- [x] 29-08-PLAN.md — Build-trigger and index-status endpoints, session- and CSRF-guarded, with lease coalescing

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 29-09-PLAN.md — Dashboard index panel, the manual Bitbucket subscription step, and end-to-end human verification

### Phase 30: ANNO-01 Bitbucket Code Insights annotations

**Goal:** Per-line Code Insights `ANNOTATION` reports on Bitbucket Cloud PRs — gutter-level severity markers mirroring inline comments. Separate from existing summary report. Bitbucket-only. Config-gated (`bitbucket.annotations_enabled`, default off).
**Requirements**: ANNO-01
**Depends on:** v1.0 Bitbucket adapter (independent of all review-quality phases)
**Plans:** 4/4 plans complete

Plans:

**Wave 1**

- [x] 30-01-PLAN.md — Config toggle (`review.bitbucket.annotations_enabled`) + pinned Bitbucket wire constants (report_id, severity/type mapping, batch size) + reportAnnotationSchema contract

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 30-02-PLAN.md — BitbucketClient.bulkUpsertAnnotations/deleteCodeInsightsReport + widened upsertCodeInsightsReport(reportId) + links.html.href threaded through comment-carrying client types

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 30-03-PLAN.md — VcsProvider.postAnnotations? seam + BitbucketAdapter.postAnnotations/buildAnnotation + widened buildDedupIndex/submitReview (D-11 link-following fix)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 30-04-PLAN.md — Wire postAnnotations into runFinalizePhase (gated, fail-open, sequenced after submitReview)

### Phase 31: WS-01 Workspace-level token/webhook

**Goal:** Workspace Access Token + workspace-level webhook auto-discovers repos in a Bitbucket workspace. Reduces per-repo onboarding friction to "add workspace, select repos." Dashboard workspace management UI. Bitbucket-only.
**Requirements**: WS-01
**Depends on:** v1.0 Bitbucket adapter (can run parallel with Phase 30)
**Plans:** 5/5 plans complete

Plans:

**Wave 1**

- [x] 31-01-PLAN.md — Tracer: live "discover a Bitbucket workspace's repos" flow end-to-end (dashboard form → new endpoint → BitbucketClient → DB-read annotation), read-only, no persistence
- [x] 31-02-PLAN.md — vcs_workspace_credentials table + DB module (mirrors vcs_credentials) + shared bitbucket-credential-resolution helper (D-03 precedence + webhook-candidate list)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 31-03-PLAN.md — Transactional finalize endpoint: encrypt + persist workspace credential, onboard only selected repos, idempotent workspace webhook creation (D-06/D-07)
- [x] 31-04-PLAN.md — Webhook route credential-resolution widening (tries both candidate secrets) + BitbucketAdapter.create bot-credential resolution (D-03) + D-07 regression test

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 31-05-PLAN.md — Interactive Step 2 checklist UI (hand-rolled Checkbox, select/deselect, already-onboarded badges) wired to the finalize endpoint

<details>
<summary>✅ v1.3 Bounded Evidence Audit Telemetry (Phases 21-25) — SHIPPED 2026-07-26</summary>

**Goal:** Replace per-finding `evidence_missing` audit events with one bounded aggregate `evidence_missing_summary` event per `(file, pass)` unit, preventing a non-compliant model's flood of per-finding events from evicting other telemetry from the ring buffer.
**Requirements**: EVID-03
**Depends on:** v1.2 (Phase 20.1)
**Plans:** 2 plans (revised 2026-07-25 per Cross-AI review feedback)

Plans:

**Wave 1**

- [x] 21-01-PLAN.md — Schema variant (timestamp last) + EvidenceMissingEntry/EvidenceMissingSummaryAuditEvent types + EVIDENCE_MISSING_SAMPLE_CAP (at line ~347) + buildEvidenceMissingSummary builder (via satisfies, not as) + builder unit tests with schema round-trip

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 21-02-PLAN.md — Producer refactoring (accumulate + builder call, line type normalization) + chunk coalescing in model.ts (EVID-03 multi-chunk blocker resolved) + test updates (model-output.spec.ts BOTH helpers, evidence-gate-integration.spec.ts, multi-finding test)

### Phase 22: WR-02 original-line capture in summary sample

**Goal:** The `evidence_missing_summary` sample records the original line the model cited for each finding, captured before the orphan-comment line remap (model-output.ts:450-457), not the post-remap line
**Requirements**: EVID-04
**Depends on:** Phase 21
**Plans:** 1/1 plans complete

Plans:

- [x] 22-01-PLAN.md — Capture originalLine in model-output.ts before orphan remap, substitute into evidenceMissingEntries, update schema comment, add targeted test

### Phase 23: IN-01 modelLineCap persistence at submit time

**Goal:** Persist the `modelLineCap` value used at async submit time so `pollReviewBatch` uses the exact haystack boundary the model saw for evidence reconstruction, fixing a race condition where a mutable `transient_error_count` between submit and poll causes incorrect `not_in_hunk` evidence classification.
**Requirements**: AUD-03
**Depends on:** Phase 22
**Plans:** 1/1 plans complete

Plans:

- [x] 23-01-PLAN.md — modelLineCap persistence: migration 014 + upsertFileReview COALESCE + COMPACT_REVIEW_PROMPT_LINE_CAP export + submitReviewBatch return extension + pollReviewBatch optional param + dual-param poll call site (modelLineCap + compactPrompt retained for legacy row fallback) + bulk mock updates + dedicated unit test file (model-line-cap.spec.ts) + integration test + migration idempotency test

### Phase 24: Dashboard surface for new audit events

**Goal:** Surface `evidence_missing_summary` audit events in the dashboard's job-detail audit trail viewer
**Requirements**: EVID-03, EVID-04, AUD-03 (dashboard catch-up)
**Depends on:** Phase 23
**Plans:** 1/1 plans complete

Plans:

- [x] 24-01-PLAN.md — Add normalizer mapping + renderer + tests for evidence_missing_summary

### Phase 25: Milestone closeout (audit, verification, sign-off)

**Goal:** Close out the v1.3 "Bounded Evidence Audit Telemetry" milestone: Nyquist-validate all 4 deliverable phases, run a formal scored milestone audit (matching v1.2 depth), obtain human sign-off, archive v1.3, and prepare v1.4.
**Requirements**: Process phase (no new requirements — validates EVID-03, EVID-04, AUD-03)
**Depends on:** Phase 24
**Plans:** 1/1 plans complete (process phase)

Plans:

**Wave 1**

- [x] 25-01-PLAN.md — Full closeout sequence: Nyquist validation (4 phases), formal milestone audit, human sign-off checkpoint, archive v1.3, prepare v1.4

</details>

### Phase 32: Address v1.4 tech debt — audit viewer renderer, misleading middleware comment, hardcoded type unions, test-hygiene improvements, integration test gap, and stale planning docs

**Goal:** Address v1.4 tech debt — audit viewer renderer verification, misleading middleware comment correction, hardcoded type union replacement, test-hygiene improvements, integration test gap closure, logger redaction hardening, broken migration script deletion, and stale planning doc reconciliation.
**Requirements**: TECHDEBT-32
**Depends on:** Phase 31
**Plans:** 6/6 plans complete

Plans:

**Wave 1**

- [x] 32-01-PLAN.md — Mechanical code fixes: replace hardcoded type union with FileReviewPass + correct misleading middleware comments
- [x] 32-02-PLAN.md — Test additions: nextPhaseAfterCrossFileSecurity selector coverage + config-default drift detection
- [x] 32-03-PLAN.md — Delete orphan migration script + logger redaction hardening + verify D-10

**Wave 2**

- [x] 32-04-PLAN.md — WS-01 warnings: webhook URL fix with APP_URL guard + repo-slug accepted risk + unused exports
- [x] 32-05-PLAN.md — Verify D-01 audit viewer + mock withRetry delays in slow tests

**Wave 3** *(blocked on Wave 1+2 completion)*

- [x] 32-06-PLAN.md — Stale planning docs full sweep: ROADMAP, REQUIREMENTS, STATE, PROJECT, CONCERNS
