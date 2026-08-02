# Phase 25: Milestone Closeout (Audit, Verification, Sign-off) - Context

**Gathered:** 2026-07-26
**Status:** Ready for planning

## Phase Boundary

Close out the v1.3 "Bounded Evidence Audit Telemetry" milestone: run a full formal milestone audit, Nyquist-validate all four deliverable phases, sign off, archive v1.3, and prepare for v1.4.

**In scope:** Formal milestone audit (scored MILESTONE-AUDIT.md matching v1.2 depth — requirements coverage, flow traces, Nyquist compliance, integration check), Nyquist validation of phases 21-24 (filling any missing VALIDATION.md gaps), human sign-off, `/gsd-complete-milestone` archive, `/gsd-new-milestone` for v1.4.

**Out of scope:** Any new code changes (this is a process/closeout phase), re-auditing v1.2 tech debt (carried forward as-is), EVID-02 hard-drop implementation (v1.4 scoping), any Bitbucket or GitHub provider changes.

## Implementation Decisions

### Closeout Scope & Depth
- **D-01:** Full formal milestone audit — same depth as v1.2. Produce a scored `v1.3-MILESTONE-AUDIT.md` with: requirements coverage (3/3: EVID-03, EVID-04, AUD-03), phase verification coverage (4/4: phases 21-24), Nyquist compliance per phase, integration check, and at least 2 flow traces (evidence_missing_summary end-to-end flow, modelLineCap async submit→poll roundtrip). — **Reversibility:** reversible — audit depth is a process choice, not a code artifact.

- **D-02:** Nyquist-validate all 4 v1.3 deliverable phases (21, 22, 23, 24) before the formal audit, so the audit scores them as compliant. Phases 21, 23, and 24 already have VALIDATION.md files; Phase 22 has only VERIFICATION.md. The Nyquist pass should check existing validations for completeness and fill any gaps (particularly Phase 22's missing VALIDATION.md). — **Reversibility:** reversible — Nyquist runs are additive (they produce VALIDATION.md files).

### Closeout Sequence
- **D-03:** Ordered sequence — each step gates the next:
  1. Nyquist-validate phases 21-24 (fill any VALIDATION.md gaps)
  2. Run formal milestone audit (`/gsd-audit-milestone`) — produces scored v1.3-MILESTONE-AUDIT.md
  3. Human sign-off (AUD-01 style attestation that the audit is honest and requirements are satisfied)
  4. `/gsd-complete-milestone` — archive v1.3, update MILESTONES.md
  5. `/gsd-new-milestone` — prepare v1.4 with EVID-02 and other deferred items promoted to Active
  — **Reversibility:** costly — reordering affects artifact dependencies (Nyquist feeds audit, audit feeds sign-off, sign-off gates archive).

### Tech Debt & Carry-Forward
- **D-04:** WR-01 todo (`wr01-evidence-missing-ring-buffer-bound.md` in `.planning/todos/pending/`) marked resolved by v1.3. The evidence_missing_summary aggregate (EVID-03, Phase 21) IS the bound — one event per (file, pass) with a ≤20 sample cap replaces unbounded per-finding events. The todo file stays as historical record; the closeout audit records it as satisfied-by-design. — **Reversibility:** reversible — the todo file can be re-opened if EVID-02 analysis reveals the 20-sample cap is still insufficient.

- **D-05:** All v1.2 tech debt carried forward without re-audit. The v1.3 closeout focuses exclusively on v1.3 deliverables. Prior debt (Phase 17 deployment checkpoints, walkthrough double-post residual, dead-code fallbacks, verify-fixes dead import, test DB accumulation) is documented in `v1.2-MILESTONE-AUDIT.md` and `PROJECT.md` — no re-verification needed. — **Reversibility:** reversible — re-auditing v1.2 items could be added later if needed.

### Next Milestone
- **D-06:** After v1.3 archive, prepare v1.4 via `/gsd-new-milestone`. Promote from deferred: EVID-02 (hard-drop promotion of existingCode evidence, now that telemetry bounding is in place), SEC-XDIFF-01 (whole-diff cross-file security reasoning), LRN-01 (learned-rule synthesis from reject feedback), QA-IDX-01 (codebase-index-backed Q&A), ANNO-01 (Bitbucket Code Insights annotations), WS-01 (workspace-level token/webhook). The v1.4 scoping discussion is a separate `/gsd-new-milestone` step — this phase only ensures the transition happens. — **Reversibility:** reversible — which deferred items get promoted is a v1.4 scoping decision.

### Folded Todos
- **wr01-evidence-missing-ring-buffer-bound** (from `.planning/todos/pending/`, Phase 15 code review): The original problem was unbounded per-finding `evidence_missing` audit events flooding the ring buffer. v1.3 Phases 21-22 delivered the solution — one bounded aggregate `evidence_missing_summary` per (file, pass) with a ≤20 sample cap. Folded into closeout scope as resolved-by-design. The closeout audit records this as the WR-01 closure.

### Claude's Discretion
- Exact Nyquist validation prompts and coverage criteria per phase (21: schema+builder tests, 22: original-line test, 23: column+threading+integration tests, 24: browser+unit renderer tests)
- Milestone audit flow names, trace paths, and scoring thresholds (follow v1.2 precedent)
- Whether to produce `v1.3-MILESTONE-AUDIT.md` as a new file or a section within the existing milestones directory
- Sign-off format — follow v1.2's 13-UAT.md pattern with authentic signature/date pairs
- Whether to delete the resolved wr01 todo file or keep it as historical record (D-04 says keep)
- Exact PROJECT.md update wording for v1.3 closeout and v1.4 prep
- Whether Phase 22's missing VALIDATION.md is a true gap (Nyquist may have run under a different naming convention or the validation was folded into 22-VERIFICATION.md)

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### v1.3 Deliverable Phases (all complete)
- `.planning/phases/21-evidence-missing-aggregate-summary-event-schema-audit-writer/21-CONTEXT.md` — Phase 21 decisions: D-01 event shape design, D-05 no zero-count event, D-06 always-aggregate, D-07 sample preserves emission order, D-08 pure builder pattern
- `.planning/phases/21-evidence-missing-aggregate-summary-event-schema-audit-writer/21-VALIDATION.md` — Phase 21 Nyquist validation (exists — verify completeness)
- `.planning/phases/22-wr-02-original-line-capture-in-summary-sample/22-CONTEXT.md` — Phase 22 decisions: D-01 line_range.start capture, D-02 orphan exclusion, D-03 null normalization
- `.planning/phases/22-wr-02-original-line-capture-in-summary-sample/22-VERIFICATION.md` — Phase 22 verification (no VALIDATION.md — Nyquist gap to fill)
- `.planning/phases/23-in-01-modellinecap-persistence-at-submit-time/23-CONTEXT.md` — Phase 23 decisions: D-01 nullable column, D-02 numeric cap (not boolean), D-03 submit return shape, D-04 optional poll param, D-05 backward compat, D-06 async-only scope
- `.planning/phases/23-in-01-modellinecap-persistence-at-submit-time/23-VALIDATION.md` — Phase 23 Nyquist validation (exists — verify completeness)
- `.planning/phases/24-dashboard-surface-for-new-audit-events/24-CONTEXT.md` — Phase 24 decisions: D-01 same-group normalize mapping, D-02 counts+collapsible sample, D-03 no modelLineCap surfacing
- `.planning/phases/24-dashboard-surface-for-new-audit-events/24-VALIDATION.md` — Phase 24 Nyquist validation (exists — verify completeness)

### v1.2 Closeout Precedent
- `.planning/milestones/v1.2-MILESTONE-AUDIT.md` — The v1.2 closeout audit template: scored report with requirements, phases, integration, flows, gaps, tech_debt, human_verification, Nyquist compliance. Use this as the structural template for v1.3's audit.
- `.planning/milestones/v1.2-ROADMAP.md` — v1.2 full milestone roadmap for reference

### Project-Level
- `.planning/PROJECT.md` — v1.3 milestone scope, current state (Phases 21-24 complete), standing decisions, known tech debt inventory
- `.planning/REQUIREMENTS.md` — v1.3 requirements: EVID-03 (Phase 21), EVID-04 (Phase 22), AUD-03 (Phase 23), all checked off
- `.planning/ROADMAP.md` — Phase 25 definition, v1.3 milestone summary
- `.planning/STATE.md` — Current position: Phase 24 complete, 4/5 phases done, 5/5 plans completed, 80%

### Pending Items
- `.planning/todos/pending/wr01-evidence-missing-ring-buffer-bound.md` — WR-01 todo to be marked resolved by v1.3 (D-04)

### Deferred Items (v1.4 candidates)
- `.planning/REQUIREMENTS.md` §v2 Requirements — EVID-02, SEC-XDIFF-01, LRN-01, QA-IDX-01, ANNO-01, WS-01
- `.planning/PROJECT.md` §Deferred Items table — Full inventory of carried-forward items

## Existing Code Insights

### Reusable Assets
- **v1.2 milestone audit structure** (`v1.2-MILESTONE-AUDIT.md`): Scored template with `scores` (requirements/phases/integration/flows), `gaps[]`, `flows[]` (id/name/status/trace/evidence), `tech_debt` (per-phase items), `human_verification` (per-phase items with expected/status fields), `nyquist` (compliant_phases/partial_phases/not_validated_phases). Copy this structure for v1.3.
- **Nyquist validation workflow** (`/gsd-validate-phase`): Existing GSD command that produces VALIDATION.md per phase. Run on phases 21-24 before the audit.
- **Milestone audit workflow** (`/gsd-audit-milestone`): Existing GSD command that produces a scored MILESTONE-AUDIT.md. Powers step 2 of the closeout sequence.
- **Milestone completion workflow** (`/gsd-complete-milestone`): Existing GSD command that archives the milestone and updates MILESTONES.md. Powers step 4.

### Established Patterns
- **Closeout is a process phase, not a code phase**: No source files change. Artifacts are planning documents (MILESTONE-AUDIT.md, VALIDATION.md files, updated PROJECT.md/STATE.md/REQUIREMENTS.md).
- **Nyquist before audit**: The v1.2 precedent ran Nyquist validation as part of each phase's execution, then the milestone audit scored compliance. v1.3 phases shipped without formal Nyquist — run it before the audit so the audit can score it.
- **Human sign-off is a gate**: v1.2's AUD-01 required an authentic human signature/date pair in 13-UAT.md before the milestone could be declared passed. v1.3 needs its own sign-off attesting the privacy prohibition holds and all requirements are satisfied.
- **Archive is irreversible**: `/gsd-complete-milestone` moves artifacts into the milestones archive. The audit must pass BEFORE archiving.

### Integration Points
- **Nyquist → Audit**: VALIDATION.md files from step 1 feed into the audit's `nyquist` section (compliant/partial/not_validated phases)
- **Audit → Sign-off**: The audit's `human_verification` items define what needs human attestation
- **Sign-off → Archive**: `/gsd-complete-milestone` should only run after sign-off is complete
- **Archive → New milestone**: `/gsd-new-milestone` reads PROJECT.md and REQUIREMENTS.md to scope v1.4

## Specific Ideas

No specific user references — the closeout follows the v1.2 precedent exactly. The key difference is scale: v1.3 is 5 phases with 3 requirements vs v1.2's 9 phases with 31 requirements. The audit should be proportionally faster but equally thorough.

## Deferred Ideas

None — all ideas discussed are in scope for this closeout phase. The wr01 todo is folded (not deferred). v1.2 tech debt is explicitly carried forward (not re-litigated).

---

*Phase: 25-milestone-closeout-audit-verification-sign-off*
*Context gathered: 2026-07-26*
