# Roadmap: Codra

## Milestones

- ✅ **v1.2 Review Engine Quality & Re-review Lifecycle** — shipped 2026-07-25: 9 phases (13-20 + 20.1), 49 plans including 19-10, 31/31 requirements satisfied, milestone audit `passed`. Full history: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md)

### Phase 21: Evidence-missing aggregate summary event (schema + audit writer)

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
**Plans:** 1 plan

Plans:

- [ ] 23-01-PLAN.md — modelLineCap persistence: migration 014 + upsertFileReview COALESCE + COMPACT_REVIEW_PROMPT_LINE_CAP export + submitReviewBatch return extension + pollReviewBatch optional param + dual-param poll call site (modelLineCap + compactPrompt retained for legacy row fallback) + bulk mock updates + dedicated unit test file (model-line-cap.spec.ts) + integration test + migration idempotency test

### Phase 24: Dashboard surface for new audit events

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 23
**Plans:** 0 plans

Plans:

- [ ] TBD (run /gsd-plan-phase 24 to break down)

### Phase 25: Milestone closeout (audit, verification, sign-off)

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 24
**Plans:** 0 plans

Plans:

- [ ] TBD (run /gsd-plan-phase 25 to break down)
