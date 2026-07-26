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
**Plans:** 2 plans

Plans:

**Wave 1**

- [ ] 26-01-PLAN.md — Schema definitions + evidence check extraction + audit builder + unit tests

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 26-02-PLAN.md — Finalize wiring + integration tests + dashboard config UI + audit viewer renderer

### Phase 27: SEC-XDIFF-01 Whole-diff cross-file security reasoning

**Goal:** New LLM pass that sees the entire PR diff and reasons about security implications across file boundaries — e.g., auth middleware change + new unprotected route. Findings enter dedup → critic → post pipeline. Subject to subrequest budget.
**Requirements**: SEC-XDIFF-01
**Depends on:** Phase 26 (benefits from EVID-02 hard-drop being in place, structurally independent)
**Plans:** TBD

### Phase 28: LRN-01 Learned-rule synthesis from reject feedback

**Goal:** Cluster `reject` feedback (CMD-05 already captures) by similarity, synthesize suppression rules stored in repo config, dashboard-reviewable before activation. Config-gated (`learning.enabled`, default off).
**Requirements**: LRN-01
**Depends on:** Phase 26 (independent of SEC-XDIFF-01, benefits from EVID-02 signal)
**Plans:** TBD

### Phase 29: QA-IDX-01 Codebase-index-backed Q&A

**Goal:** Index default-branch tree into embeddings/keyword index (KV or Postgres) on repo install. Q&A queries index for relevant code beyond PR diff. Index freshness via webhook push events. Config-gated (`qa.index_enabled`, default off).
**Requirements**: QA-IDX-01
**Depends on:** Phase 26 (independent, heaviest lift)
**Plans:** TBD

### Phase 30: ANNO-01 Bitbucket Code Insights annotations

**Goal:** Per-line Code Insights `ANNOTATION` reports on Bitbucket Cloud PRs — gutter-level severity markers mirroring inline comments. Separate from existing summary report. Bitbucket-only. Config-gated (`bitbucket.annotations_enabled`, default off).
**Requirements**: ANNO-01
**Depends on:** v1.0 Bitbucket adapter (independent of all review-quality phases)
**Plans:** TBD

### Phase 31: WS-01 Workspace-level token/webhook

**Goal:** Workspace Access Token + workspace-level webhook auto-discovers repos in a Bitbucket workspace. Reduces per-repo onboarding friction to "add workspace, select repos." Dashboard workspace management UI. Bitbucket-only.
**Requirements**: WS-01
**Depends on:** v1.0 Bitbucket adapter (can run parallel with Phase 30)
**Plans:** TBD

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
