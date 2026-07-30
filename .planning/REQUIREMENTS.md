# Requirements: Codra v1.4

**Defined:** 2026-07-26
**Core Value:** A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.
**Milestone scope:** All 6 deferred candidates promoted to active: hard-drop hallucinated evidence (EVID-02), cross-file security reasoning (SEC-XDIFF-01), learned-rule synthesis (LRN-01), codebase-index-backed Q&A (QA-IDX-01), Bitbucket Code Insights annotations (ANNO-01), workspace-level token/webhook (WS-01).
**Dependency order:** EVID-02 → SEC-XDIFF-01 → LRN-01 → QA-IDX-01 → ANNO-01 ∥ WS-01

**Standing decisions (apply to all requirements):**

- Contract-first: all data shapes defined in `src/shared/schema.ts` before implementation
- NREG-01: defaults byte-identical — every new capability is config-gated, default off, with a documented escape hatch; the pinned default oracle must produce byte-identical output when all v1.4 toggles are disabled
- NREG-02: provider neutrality — every v1.4 capability works on both GitHub and Bitbucket through the `VcsProvider` seam
- AUD-01: privacy redaction — all audit events route through `redactFindingTitle`/`redactErrorMessage`
- Cloudflare 50-subrequest/invocation budget governs all scheduling decisions
- Zero new npm dependencies — every feature is additive schema changes, new core modules, new prompts
- Per-file review results persisted so retried jobs skip already-reviewed files (existing Phase 10 convention)

## v1.4 Requirements

### Wave 1 — Evidence Hard-Drop (foundational)

- [x] **EVID-02**: Hard-drop findings with hallucinated `existingCode` evidence. Promote EVID-01 from soft/audit-only to hard-drop now that v1.3 bounded telemetry (EVID-03 evidence_missing_summary) provides a reliable signal. A finding whose `existing_code` is absent or not found in the hunk is dropped from the posted comment set rather than merely recorded in the audit trail. The drop decision is explainable via audit events. Config-gated with `evidence.hard_drop` toggle (default off — NREG-01). Per-category opt-out (e.g., security findings always post regardless). Legacy `evidence_missing` per-finding variant preserved in schema.

### Wave 2 — Review Quality

- [x] **SEC-XDIFF-01**: Whole-diff cross-file security reasoning. A new LLM pass that sees the entire PR diff (not per-file chunks) and reasons about security implications across file boundaries — e.g., an auth middleware change in one file combined with a new unprotected route in another. Scheduled as a separate phase after the per-file security pass. Its findings enter the same dedup → critic → post pipeline. Subject to the same subrequest budget with runs-aware chunk sizing. Provider-agnostic prompt.

- [x] **LRN-01**: Learned-rule synthesis from clustered `reject` feedback + approval queue. The `reject` command (CMD-05) already captures the finding the user rejected and their reason. This requirement clusters rejections by similarity (title, category, file pattern) and synthesizes suppression rules — "if a finding matches this pattern, suppress it" — stored as learned rules in the repo config. Rules are reviewable in the dashboard before activation. Config-gated (`learning.enabled`, default off).

### Wave 3 — Indexing Subsystem

- [x] **QA-IDX-01**: Codebase-index-backed Q&A. v1.1 Q&A uses PR diff + file context only (QA-01/QA-02). This requirement adds a codebase indexing subsystem: on repo install, index the default-branch tree into embeddings (or a cheaper keyword index) stored in KV or Postgres. Q&A queries the index for relevant code sections beyond the PR diff. Index freshness maintained via webhook push events. Provider-agnostic. Config-gated (`qa.index_enabled`, default off).

### Wave 4 — Bitbucket Differentiators

- [ ] **ANNO-01**: Per-line Code Insights annotations (diff-gutter markers) on Bitbucket Cloud PRs. Mirror inline review comments as Bitbucket Code Insights `ANNOTATION` reports — gutter-level severity markers (P0=severe red, P1=orange, P2=yellow, P3/nit=blue-gray) on the affected lines. Separate from the existing `CodeInsightsReport` (summary). Bitbucket-only capability (NREG-02: GitHub doesn't need this — they have inline comments directly). Config-gated (`bitbucket.annotations_enabled`, default off).

- [ ] **WS-01**: Workspace-level token/webhook covering many repos. Today each Bitbucket repo needs its own Repository Access Token + webhook subscription. This requirement adds a Workspace Access Token + workspace-level webhook that auto-discovers repos in the workspace — reducing per-repo onboarding friction to "add workspace, select repos." Token stored in the existing AES-GCM encrypted credential store. Dashboard workspace management UI. Bitbucket-only. Config-gated (token scoping is workspace-level by nature).

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EVID-02 | Phase 26 | Done |
| SEC-XDIFF-01 | Phase 27 | Done |
| LRN-01 | Phase 28 | Planned |
| QA-IDX-01 | Phase 29 | Done |
| ANNO-01 | Phase 30 | Planned |
| WS-01 | Phase 31 | Planned |

## Out of Scope

| Feature | Reason |
|---------|--------|
| GitLab / Azure DevOps / other VCS providers | Not in scope for any current milestone |
| EVID-02 per-category override UI | Dashboard surface deferred to a follow-up catch-up phase |
| QA-IDX-01 vector embedding model choice | Implementation detail — use cheapest available (Workers AI embeddings or keyword fallback) |
| LRN-01 automatic rule activation | Rules are dashboard-reviewable before activation; full-auto deferred |

---
*Requirements defined: 2026-07-26 — v1.4 scoping*
