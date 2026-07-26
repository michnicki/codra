# Requirements: Codra v1.4

**Defined:** 2026-07-26
**Core Value:** A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.
**Milestone scope:** Promote EVID-02 (hard-drop existingCode evidence), SEC-XDIFF-01 (whole-diff security reasoning), LRN-01 (learned-rule synthesis), QA-IDX-01 (codebase-index-backed Q&A), ANNO-01 (Bitbucket Code Insights annotations), WS-01 (workspace-level token/webhook) from deferred to active candidates. Full scoping to be determined via /gsd-discuss-phase.

**Standing decisions (apply to all requirements):**

- Contract-first: all data shapes defined in `src/shared/schema.ts` before implementation
- NREG-01: defaults byte-identical — every new capability is config-gated, default off, with a documented escape hatch; the pinned default oracle must produce byte-identical output when all v1.4 toggles are disabled
- NREG-02: provider neutrality — every v1.4 capability works on both GitHub and Bitbucket through the `VcsProvider` seam
- AUD-01: privacy redaction — all audit events route through `redactFindingTitle`/`redactErrorMessage`
- Cloudflare 50-subrequest/invocation budget governs all scheduling decisions

## v1.4 Candidate Requirements

These are candidates promoted from deferred items. Scoping, ordering, and REQ-ID assignment to be finalized during /gsd-discuss-phase and /gsd-plan-phase.

### Evidence & Learning

- [ ] **EVID-02**: Hard-drop findings with hallucinated `existingCode` evidence — promote EVID-01 from soft/audit-only to hard-drop after v1.3 bounded telemetry (WR-01 resolved). The `evidence_missing_summary` aggregate now provides the bounded signal this decision depends on.
- [ ] **LRN-01**: Learned-rule synthesis from clustered `reject` feedback + approval queue (carried from v1.1; `reject` capture already ships via CMD-05)

### Review Quality

- [ ] **SEC-XDIFF-01**: Whole-diff cross-file security reasoning (carried from v1.1 — land after per-file security pass proves out)
- [ ] **QA-IDX-01**: Codebase-index-backed Q&A (carried from v1.1 — whole indexing subsystem)

### Bitbucket Differentiators

- [ ] **ANNO-01**: Per-line Code Insights annotations (diff-gutter markers) mirroring inline comments (carried from v1.0)
- [ ] **WS-01**: Workspace-level token/webhook covering many repos to reduce per-repo onboarding friction (carried from v1.0)

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TBD | TBD | TBD |

---
*Requirements defined: 2026-07-26 — v1.4 preparation*
*Full scoping pending /gsd-discuss-phase*
