# Requirements: Codra v1.3 — Bounded Evidence Audit Telemetry

**Defined:** 2026-07-25
**Core Value:** A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.
**Milestone scope source:** Pending todo `.planning/todos/pending/wr01-evidence-missing-ring-buffer-bound.md` (Phase 15 code review, WR-01), decided-approach brainstorm 2026-07-25.

**Standing decisions (apply to all requirements):**

- Contract-first: the new `evidence_missing_summary` stage literal is added to `src/shared/schema.ts` before implementation; the legacy per-finding `evidence_missing` variant is never re-shaped or removed — old persisted audit rows must still parse.
- Information-equivalence: for ≤20 affected findings, `count` + bounded `sample` carries the same information as today's per-finding events — nothing lost in the common case, bounded in the flood case.
- Per-unit aggregation (not per-file-all-passes): matches `recordUnitAudit`'s existing `(file, pass)` keying.
- EVID-02 (hard-drop promotion of `existingCode` evidence) is explicitly out of scope for this milestone — this milestone only bounds the telemetry EVID-02 will eventually read.

## v1 Requirements

### Evidence Audit Telemetry

- [x] **EVID-03**: `evidence_missing` audit events are aggregated into one `evidence_missing_summary` event per `(file, pass)` unit — carrying `absentCount`, `notInHunkCount`, and a bounded sample (≤20 of `{path, line, title, reason}`, `title` passed through `redactFindingTitle`) — instead of one event per finding; the legacy per-finding `evidence_missing` variant remains a valid schema member so previously persisted events still parse
- [x] **EVID-04**: The `evidence_missing_summary` sample records the original line the model cited for each finding, captured before the orphan-comment line remap (`model-output.ts:450-457`), not the post-remap line

### Audit Trail

- [x] **AUD-03**: `pollReviewBatch` persists `modelLineCap` at submit time instead of re-deriving it from the mutable `transient_error_count` during haystack reconstruction

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Evidence & Learning

- **EVID-02**: Hard-drop findings with hallucinated `existingCode` evidence (promote EVID-01 after this milestone's telemetry supports it)
- **LRN-01**: Learned-rule synthesis from clustered `reject` feedback + approval queue (carried from v1.1; `reject` capture already ships)

### Review Quality

- **SEC-XDIFF-01**: Whole-diff cross-file security reasoning (carried from v1.1)
- **QA-IDX-01**: Codebase-index-backed Q&A (carried from v1.1)

### Bitbucket Differentiators

- **ANNO-01**: Per-line Code Insights annotations (diff-gutter markers) mirroring inline comments (carried from v1.0)
- **WS-01**: Workspace-level token/webhook covering many repos (carried from v1.0)

## Out of Scope

| Feature | Reason |
|---------|--------|
| EVID-02 hard-drop promotion | This milestone only bounds the telemetry signal EVID-02 depends on; the hard-drop decision itself is a separate, future scoping question |
| Lossy per-unit `slice(0, 20)` cap without an aggregate count | The count IS the signal EVID-02 needs — a model failing on 50 findings would look identical to one failing on 20 under a pure slice |
| Derivability-only approach (drop `absent`, keep `not_in_hunk`) | Couples EVID-02 to comment persistence and `not_in_hunk` can still flood on its own; useful only as a cross-check, not a replacement |
| Bounding at the ring-buffer/recorder layer (`appendJobAuditEvents`, `recordUnitAudit`) | Wrong layer — the recorder can't distinguish stages without sniffing, and per-stage ring quotas would break the drop-oldest atomicity invariant (`jobs.ts:1660-1688`) |

## Traceability

Filled in by the roadmapper during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| EVID-03 | Phase 21 (plans 21-01 + 21-02) | Complete |
| EVID-04 | Phase 22 (plan 22-01) | Complete |
| AUD-03 | Phase 23 (plan 23-01) | Complete |

---
*Requirements defined: 2026-07-25*
