# Codra

## What This Is

Codra is self-hosted AI code review for pull requests, running entirely on Cloudflare (Workers, Queues, KV, Hyperdrive, Workers AI) with an external PostgreSQL database. It reviews pull requests on **both GitHub and Bitbucket Cloud** from a single deployed instance: a per-provider webhook enqueues review jobs, a durable Cloudflare Workflow runs a **multi-pass** LLM review (a main pass plus a dedicated security pass, near-duplicate suppression, a critic pass, optional ensemble majority vote, and an optional verify-fixes pass over unresolved bot threads) over the PR diff through a shared `VcsProvider` abstraction, then posts back a **streamed walkthrough** (with a deterministically clamped confidence score, effort estimate, and change groups), inline findings, a summary report, and a merge-gating status on whichever platform the PR came from. Repo members can also **drive the bot in-PR** — `review` / `review-rest` / `pause` / `resume` / `help` / `reject` / `ignore` commands and free-form Q&A via @mention, with threaded replies — on both providers. Every interactive/multi-pass capability is config-gated (default off except three documented correctness fixes — `severity_engine`, `dedup`, `file_selection` — each with a single escape hatch) and byte-identical to the base review when disabled. Every drop in the engine is now explained by a per-stage `jobs.audit` trail surfaced in the dashboard's job-detail audit-trail viewer.

## Current State (as of v1.5 — Phase 33)

**v1.5 Phase 33 Quality Fixes** complete 2026-07-31 (4/4 plans, PRD-01/02/03 satisfied, 24/24 must-haves verified, code review clean). The review pipeline now: retries each inline comment individually on a batch-review 422 (GitHub summary-only retry + per-comment fallback with a budget guard), skip-and-continues on per-comment 422s (Bitbucket) with body-free warning logs, surfaces posted-vs-skipped comments via an `inline_comment_skipped` aggregate audit event per review round (dashboard-visible in its own audit-trail group), truncates parsed comment titles to 80 chars (including off-diff orphans), clears suggestions equal to `existingCode` (stripping the redundant fence), drops suggestion-only-empty-body comments behind a `suggestion_dropped` aggregate, treats `code_suggestion: ""` as absent (closing a whole-file parse throw), and repairs nested double quotes in Mermaid walkthrough diagram labels (`engine["core/"engine.py""]` → `engine["core/engine.py"]`). Zero new npm dependencies, zero migrations.

**v1.4 Deferred Candidates + Phase 32 Tech Debt Cleanup** — all 6 v1.4 feature phases (26-31) shipped, plus Phase 32 tech-debt cleanup closing audit-viewer renderer verification, misleading middleware comment correction, hardcoded type union replacement, test-hygiene improvements, integration-test gap closure, logger redaction hardening, broken migration script deletion, and stale planning doc reconciliation. Milestone archived 2026-07-31.



**v1.2 Review Engine Quality & Re-review Lifecycle** closed 2026-07-25 (Phases 13-20 + 20.1, 49 plans, 31/31 requirements satisfied). On top of the v1.0 dual-provider foundation and v1.1 interactive/multi-pass surface, the review engine now has deterministic severity classification (exploit-keyword promotion to P0, security-category cap at P2, style downgrade to nit), real model-assigned categories (the hardcoded `'quality'` is gone), a severity-tiered noise filter with always-on composite dedup, priority-ordered file selection with content-based generated detection, a soft `existingCode` evidence gate (audit-only, hard-drop deferred to v2/EVID-02), an incremental round-2+ re-review with round-escalated floors and open-thread suppression, verify-fixes (windowed file content, ≤500 lines full / 50-line windows), critic v2 (evidence-graded proven/plausible/unsupported verdicts), ensemble majority vote (1-5 runs, partial-failure tolerant, runs-aware subrequest budget), walkthrough enrichment (clamped confidence + effort + change groups), and an audit-trail viewer in job detail — all config-gated, byte-identical when disabled, across both GitHub and Bitbucket, with **zero new npm dependencies**. NREG-01 (defaults byte-identical) and NREG-02 (GitHub+Bitbucket parity) held continuously; full suite green at 1550 node tests + 102 browser tests under nix-shell; AUD-01 human signature/date pair signed 2026-07-25 (Thomas Michnicki); milestone audit `passed` after Phase 20.1 closure of all 5 BLOCKERs + 1 WARNING.

**v1.1 Interactive Multi-Pass Review** shipped 2026-07-21 (Phases 7-12). On top of the v1.0 dual-provider foundation, review became richer and interactive: a multi-pass engine (main + security + critic), a streamed in-place walkthrough (with an optional GitHub-only Mermaid sequence diagram), and webhook-layer bot commands + injection-resistant, rate-limited Q&A with threaded replies — all config-gated, byte-identical when disabled, across both GitHub and Bitbucket, with **zero new npm dependencies**.

**v1.0 Bitbucket Cloud Support** shipped 2026-07-14 (Phases 1-6): Bitbucket Cloud as a first-class second provider at full parity with GitHub — webhook ingestion, diff-based review, inline findings, Code Insights report, build status, encrypted bot-credential storage, dashboard OAuth login, and a provider-aware "add repo" flow.

See `.planning/milestones/` for full phase-by-phase detail and closeout audits (`v1.0-*`, `v1.1-*`, `v1.2-*`).

## Current Milestone: v1.5 — PRD Parity (Agentic Context, Outbound Events & Quality Fixes)

**Goal:** Close the remaining 8 gaps between the review-engine PRD and Codra's implementation.

**Target features:**
- Per-comment 422 fallback (FR-031) — don't drop all findings on batch validation error
- Title truncation (80 chars) + suggestion=existingCode clearing (FR-153/154)
- Mermaid label sanitization (FR-155)
- File history / decision archaeology (FR-114)
- .review.yaml per-repo configuration (§15)
- Agentic tools — read_file/grep_repo loop for unindexed repos (FR-131/132)
- Outbound webhook event delivery (FR-401)
- Blast radius / cross-repo dependencies (FR-113)

### v1.4 — Deferred Candidates (Hard-Drop Evidence + Review Quality + Bitbucket Differentiators) — CLOSED 2026-07-31

**Scoped:** 2026-07-26
**Scope:** All 6 deferred candidates promoted — 7 phases (26-32) ordered by dependency.
**Status:** SHIPPED — 7/7 phases complete, 33/33 plans, 6/6 requirements satisfied. Milestone archived to `.planning/milestones/v1.4-ROADMAP.md`.

**Dependency-ordered phases:**

| Phase | Requirement | Description |
|-------|-------------|-------------|
| 26 | EVID-02 | Hard-drop evidence gate — promote EVID-01 from audit-only to hard-drop |
| 27 | SEC-XDIFF-01 | Whole-diff cross-file security reasoning pass |
| 28 | LRN-01 | Learned-rule synthesis from clustered reject feedback |
| 29 | QA-IDX-01 | Codebase-index-backed Q&A (indexing subsystem) |
| 30 | ANNO-01 | Bitbucket Code Insights per-line annotations |
| 31 | WS-01 | Workspace-level token/webhook for multi-repo onboarding |
| 32 | TECHDEBT-32 | Tech debt cleanup (type unions, middleware comments, logger redaction, test hygiene, docs) |

### v1.3 Bounded Evidence Audit Telemetry — CLOSED 2026-07-26

**Status:** `passed` — 5 phases (21-25), 3/3 requirements satisfied, 4/4 phases Nyquist-compliant, 2 E2E flows complete, WR-01 resolved by design. Milestone audit: `.planning/milestones/v1.3-MILESTONE-AUDIT.md`. Signed off 2026-07-26.

## Core Value

A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.

*Still the right priority — the enduring cross-provider parity goal held end-to-end through v1.0, v1.1, and v1.2. v1.1 extended it (every interactive/multi-pass capability — walkthrough, commands, Q&A, threaded replies — shipped on **both** GitHub and Bitbucket through the same `VcsProvider` seam). v1.2 extended it again (every audit-backed filter drop, every incremental round, every ensemble verdict, every walkthrough clamp — same provider parity). The seam is the load-bearing contract; audit-privacy redaction (Phase 20.1 BLOCKER-1) is the privacy discipline that makes the audit trail a safe operator surface on both providers.*

## Requirements

### Validated

<!-- Inferred from existing code (codebase map, 2026-07-12). These already shipped pre-milestone. -->

- ✓ GitHub App webhook ingestion with HMAC signature verification (`core/verify.ts`, `routes/webhook.ts`) — existing
- ✓ Durable, resumable review pipeline over PR diffs (prepare → review → finalize) via Cloudflare Workflows (`workflows/review.ts`, `core/review.ts`) — existing
- ✓ Inline findings + check run posted back to GitHub PRs (`core/github.ts`, `services/github.ts`, `services/formatter.ts`) — existing
- ✓ GitHub OAuth dashboard login with KV-backed sessions (`core/github-oauth.ts`, `core/sessions.ts`) — existing
- ✓ Per-repo model routing (chains, fallbacks, size overrides) across OpenAI/Anthropic/Google/Workers AI (`services/model.ts`, `models/*`) — existing
- ✓ React dashboard for repos, model config, job history, DLQ replay (`src/client/`) — existing

<!-- Shipped this milestone — v1.0, 2026-07-14. -->

- ✓ A VCS-provider abstraction so review, webhook, and posting logic are not GitHub-specific — v1.0 (`VcsProvider` interface, `VcsService.forRepo`/`forProvider` branch point)
- ✓ Bitbucket Cloud webhook ingestion (PR created/updated) with verification appropriate to Bitbucket Cloud — v1.0 (`POST /webhook/bitbucket`, HMAC via per-repo secret, fail-closed)
- ✓ Bitbucket Cloud "review bot" authentication — v1.0 (Repository/Workspace Access Token, Bearer; AES-GCM encrypted storage mirroring `core/llm-crypto.ts`)
- ✓ Fetch Bitbucket Cloud PR diffs into the existing review pipeline — v1.0 (`core/diff.ts` generalized for Bitbucket's 200-file/8,000-line caps)
- ✓ Post inline review findings back onto Bitbucket Cloud PRs (comments + summary/status) — v1.0 (path/line-anchored comments, Code Insights report, build status)
- ✓ Bitbucket OAuth dashboard login — v1.0 (second OAuth consumer, `account_id`-keyed allow-list, never `username`)
- ✓ Repos declare their provider (github | bitbucket) in config/DB; dashboard supports adding Bitbucket repos — v1.0 (provider picker + transactional `POST /api/repos/bitbucket`)
- ✓ Existing GitHub flows remain fully working (no regression) after the abstraction is introduced — v1.0 (NREG-02, held through all 6 phases + milestone audit)

<!-- Shipped this milestone — v1.1 Interactive Multi-Pass Review, 2026-07-21. Full REQ-IDs archived in .planning/milestones/v1.1-REQUIREMENTS.md. -->

- ✓ Multi-pass review engine — dedicated security pass + near-duplicate suppression + fail-open critic pass; pipeline `union(main,security) → dedup → critic → deterministic floors → post` within the 50-subrequest/invocation budget, critic off `finalize` (MP-01..05) — v1.1
- ✓ Streaming walkthrough — placeholder edited in place into a file-coverage / per-severity-count walkthrough, optional GitHub-only Mermaid diagram, malformed-item recovery, durable comment ref surviving fresh-instance handoff (WT-01..05) — v1.1
- ✓ Bot commands — `review` / `review-rest` / `pause` / `resume` / `help` / `reject` / `ignore` dispatched at the webhook layer, self-filtering the bot's own comments first, member-authorized by immutable id, DB-backed provider-agnostic pause (CMD-01..08) — v1.1
- ✓ PR Q&A — free-form @mention answered from PR + diff context, injection-resistant, read-only, rate-limited, token-capped (QA-01/QA-02) — v1.1
- ✓ Threaded command/Q&A replies (GitHub `in_reply_to` / Bitbucket `parent`) + Bitbucket dashboard repo-config (nullable `installationId`, lazy default config, provider-conditional Interactive settings UI) — v1.1 (Phase 12)
- ✓ Zero regression, every feature config-gated default-off, all capabilities working on both GitHub and Bitbucket through the `VcsProvider` seam keyed on opaque refs / immutable ids (NREG-01, NREG-02) — v1.1

<!-- Shipped in v1.2 Review Engine Quality & Re-review Lifecycle, 2026-07-25. Full REQ-IDs are archived in .planning/milestones/v1.2-REQUIREMENTS.md. -->

- ✓ Severity engine v2: deterministic, explainable severity classification post-parse (SEV-01..03); real model-assigned categories (SEV-04, hardcoded `'quality'` removed) — v1.2 (Phase 13)
- ✓ Noise filter v2: severity-tiered comment cap (P0/P1/P2 exempt from `max_comments`), per-category confidence floors, always-on composite-rule dedup with `dedup.enabled` escape hatch, audit event for every drop — v1.2 (Phase 14)
- ✓ Priority file selection: sensitive-path scoring replaces alphabetical order; content-based generated-file detection; per-file skip reasons surfaced on the job result — v1.2 (Phase 15)
- ✓ Soft `existingCode` evidence gate: every finding's evidence checked against the cleaned hunk content; `evidence_missing` audit event on mismatch; still posts (audit-only, hard-drop is EVID-02 v2 deferral) — v1.2 (Phase 15)
- ✓ Dashboard catch-up: review-settings UI for every persisted + v1.2 key; job-detail category/confidence/severity-strip/duration/critic-verdict; audit-trail viewer grouped by stage; stats severities/categories/performance charts — v1.2 (Phase 16)
- ✓ VcsProvider groundwork: `getFileContent`, `getCompareDiff`, unresolved-bot-thread listing, thread resolution on both providers (GitHub GraphQL reviewThreads/resolveReviewThread; Bitbucket comments+resolve) behind capability flags with safe degradation — v1.2 (Phase 17)
- ✓ Incremental re-review: round detection in prepare, incremental diff via `getCompareDiff` with full-diff fallback, round-escalated floors, open-thread suppression, `last_reviewed_sha` anchor written on successful finalize only — v1.2 (Phase 18)
- ✓ Verify-fixes: windowed file content (full ≤500 lines / 50-line windows otherwise) judging fixed-or-not at head; auto-resolve gated on `threads.auto_resolve`; provider-capability-degraded — v1.2 (Phase 19)
- ✓ Critic v2: evidence-graded proven/plausible/unsupported verdicts; canonical one-row-per-candidate decision ledger; fail-open on LLM error — v1.2 (Phase 19)
- ✓ Ensemble: N-1 extra parallel review calls at `ensemble_temperature`, majority vote, partial-failure tolerant, runs-aware subrequest budget — v1.2 (Phase 19)
- ✓ Walkthrough enrichment: deterministically clamped confidence score, effort estimate, change groups; parser provenance preserves malformed-field status — v1.2 (Phase 19)
- ✓ Per-stage audit trail: `jobs.audit` JSONB ring-buffer (migration 010) with open event union; every drop explainable; privacy-redacted titles (`[title-redacted]` for non-empty, `[clamped:empty]` for nullish) + machine-error-reason enumeration (`redactErrorMessage`); recordUnitAudit never rethrows — v1.2 (Phases 13, 14, 15, 19, 20.1)
- ✓ NREG-01 defaults byte-identical (with three documented always-on correctness fixes — `severity_engine`, `dedup`, `file_selection` — each with a single escape hatch) — v1.2 (Phases 13-20 + 20.1, pinned default oracle from detached pre-Phase-19 commit `3d5f4150f8ff88787c10a3067ddc59176285eb25`)
- ✓ NREG-02 GitHub + Bitbucket parity for every v1.2 capability; capability-flagged degradation only, never GitHub-only silently — v1.2 (Phases 13-20 + 20.1, both-provider parity spec)

<!-- Shipped in v1.3 Bounded Evidence Audit Telemetry, closed 2026-07-26. Full audit: .planning/milestones/v1.3-MILESTONE-AUDIT.md. -->

- ✓ EVID-03: Aggregate `evidence_missing_summary` event per (file, pass) with bounded sample ≤20 — v1.3 (Phase 21)
- ✓ EVID-04: originalLine captured before orphan remap in evidence_missing_summary sample — v1.3 (Phase 22)
- ✓ AUD-03: modelLineCap persisted at submit time, not re-derived from mutable state — v1.3 (Phase 23)
- ✓ Dashboard surface for evidence_missing_summary audit events — v1.3 (Phase 24)
- ✓ Nyquist compliance for all 4 deliverable phases, formal scored milestone audit, WR-01 resolved by design — v1.3 (Phase 25)

<!-- Shipped in v1.4 Deferred Candidates, 2026-07-31. Full archive: .planning/milestones/v1.4-ROADMAP.md, v1.4-REQUIREMENTS.md. -->

- ✓ EVID-02: Hard-drop evidence gate — findings with hallucinated `existingCode` dropped from posted comments before dedup, config-gated (`evidence.hard_drop`, default off), per-category opt-out (default `security`), at-most-once `evidence_hard_dropped` audit, dashboard toggle + audit renderer — v1.4 (Phase 26, 10/10 must-haves)
- ✓ SEC-XDIFF-01: Whole-diff cross-file security reasoning — new LLM pass seeing entire PR diff, findings enter dedup → critic → post pipeline, config-gated (`security.cross_file`, default off) — v1.4 (Phase 27)
- ✓ LRN-01: Learned-rule synthesis from clustered reject feedback — similarity clustering, suppression rule synthesis, dashboard-reviewable before activation, config-gated (`learning.enabled`, default off) — v1.4 (Phase 28)
- ✓ QA-IDX-01: Codebase-index-backed Q&A — Postgres-native full-text search index of default-branch tree, incremental push-triggered refresh, dashboard build/status panel, config-gated (`qa.index_enabled`, default off) — v1.4 (Phase 29)
- ✓ ANNO-01: Per-line Bitbucket Code Insights `ANNOTATION` reports mirroring inline findings — dedicated `codra-annotations` report, config-gated (`review.bitbucket.annotations_enabled`, default off), full-replace-per-round (delete-then-recreate), fail-open in finalize, `external_id` collision-resistant, `result` always `PASSED` (never merge-gating) — v1.4 (Phase 30, UAT 1/1 passed incl. live Assumption-A1 cascade confirmation; security review 17/17 threats closed)
- ✓ WS-01: Workspace-level Bitbucket Access Token + webhook auto-discovers and onboards many repos from one workspace credential — `vcs_workspace_credentials` table + D-03 per-repo-wins credential resolution, transactional finalize endpoint (encrypt + persist + selective onboard + idempotent webhook), webhook route verifies against per-repo OR workspace secret, two-step discover/checklist dashboard UI — v1.4 (Phase 31, 25/25 must-haves; code review found 2 blockers — both fixed and regression-tested before verification)

<!-- Active requirements for v1.5 — PRD Parity. Full REQ-IDs will be defined in .planning/REQUIREMENTS.md. -->

### Active (v1.5)

- [ ] **PRD-01**: Per-comment 422 fallback — on batch review 422, retry each comment individually, skip any that still 422 with warning log (FR-031)
- [ ] **PRD-02**: Title truncation to 80 chars + suggestion=existingCode clearing (FR-153/154)
- [ ] **PRD-03**: Mermaid label sanitization — escape nested double quotes in walkthrough diagram labels (FR-155)
- [ ] **PRD-04**: File history / decision archaeology — per-touched-file commit history as review context (FR-114)
- [ ] **PRD-05**: .review.yaml per-repo configuration — YAML file discovery and merge with DB config (§15)
- [ ] **PRD-06**: Agentic tools — read_file/grep_repo tool loop for on-demand cross-file context (FR-131/132)
- [ ] **PRD-07**: Outbound webhook event delivery — review.completed, review.high_severity, review.failed events (FR-401)
- [ ] **PRD-08**: Blast radius / cross-repo dependencies — compute related repos, filter by visibility (FR-113)

### Out of Scope

- Bitbucket Data Center / Server (self-hosted Bitbucket) — different API dialect and auth; Cloud only, confirmed correct through v1.0
- Atlassian Connect app model — end-of-support 2026-12, no new registrations since Feb 2026; would have been overweight for single-tenant self-hosted (confirmed by AUTH-01 research; Repository/Workspace Access Token used instead)
- App passwords for Bitbucket bot auth — fully removed by Atlassian on 2026-07-28; access-token model avoids this cliff entirely
- GitLab, Azure DevOps, or other VCS providers — not in scope
- Replacing or deprecating GitHub support — GitHub and Bitbucket coexist, confirmed by continuous NREG-02 compliance
- Bitbucket Pipelines / CI integration — not part of the PR-review use case
- Upstream-contribution polish (exhaustive docs, CLA, broad config surface) — nice-to-have, not required; target is the user's own self-hosted deployment
- **v1.1 review-quality deferrals (v2 candidates):** whole-diff cross-file security reasoning (SEC-XDIFF-01, land after per-file security proves out); learned-rule synthesis from clustered `reject` feedback + approval queue (LRN-01 — only the `reject` **capture** signal shipped, via CMD-05); codebase-index-backed Q&A (QA-IDX-01) — v1.1 Q&A uses PR + diff context only
- **v1.2 evidence-gate v2 candidates:** hard-drop promotion of `existingCode` evidence (EVID-02, after telemetry supports it); bound per-unit `evidence_missing` ring-buffer flood (WR-01, requires a schema/design decision)
- **v1.4 deferred:** EVID-02 per-category override UI (dashboard surface); LRN-01 automatic rule activation (rules are dashboard-reviewable before activation); QA-IDX-01 vector embedding model (Workers AI embeddings or keyword fallback — implementation detail)
- **Broader deferrals (candidate future milestones):** codebase indexing + dependency/blast-radius graph, vulnerability monitoring + package search, GitLab / Azure DevOps / other VCS providers, AWS Bedrock + `providers.json` registry, analytics/ops dashboards, outbound Slack/Teams/webhook notifications, user management — none selected for v1.0 or v1.1 (full itemized list in `.planning/milestones/v1.1-REQUIREMENTS.md`)

## Business Context

<!-- Internal/self-hosted use — not a monetized feature. -->

- **Customer**: The user's own team, reviewing PRs on their Bitbucket Cloud workspace via a self-hosted Codra instance.
- **Success metric**: Bitbucket Cloud PRs get AI review at parity with GitHub, GitHub unaffected. **Achieved and held through v1.4** — 22/22 v1.0 + 22/22 v1.1 + 31/31 v1.2 + 3/3 v1.3 + 6/6 v1.4 requirements satisfied; every v1.4 capability (hard-drop evidence, cross-file security, learned rules, codebase-index Q&A, Code Insights annotations, workspace tokens) config-gated and shipped on both providers; milestone audit `passed` for all 4 milestones.

## Context

- **Brownfield**: mature codebase; see `.planning/codebase/` for the full map (STACK, ARCHITECTURE, INTEGRATIONS, STRUCTURE, CONVENTIONS, TESTING, CONCERNS as of 2026-07-12).
- **Two coexisting VCS providers**: GitHub and Bitbucket Cloud both run through the same `VcsProvider` interface and `VcsService` branch point (`core/review.ts`); webhook dedup/insert/supersede/enqueue is shared (`core/webhook-ingest.ts`); credentials for both are encrypted at rest (AES-GCM).
- **Bot auth resolved**: Bitbucket bot authentication uses a Repository/Workspace Access Token (Bearer), not Atlassian Connect and not app passwords — lighter-weight than GitHub's App/JWT model, encrypted alongside LLM provider keys.
- **Webhook verification**: Bitbucket Cloud uses `X-Hub-Signature` HMAC via a per-repo secret (repo identified from payload before verification, fails closed) — same shape as GitHub's, generalized in `core/verify.ts`.
- **Contract-first**: all wire/queue/DB-JSON shapes live in `src/shared/schema.ts` (Zod), now with a `provider` discriminator throughout.
- **Resource constraints carry over**: the Cloudflare Workers 50-subrequest/invocation limit and the durable-Workflow fresh-instance handoff already shaped the GitHub pipeline; Bitbucket's diff caps (200 files/8,000 lines) and ~1,000 req/hr rate limit are budgeted the same way.
- **Current scale (as of v1.4 close):** TypeScript across `src/server` / `src/client` / `src/shared`; 62,534 LOC. v1.4 added +7,804/−160 lines across 54 source files over 130 commits (2026-07-26 → 2026-07-31, 5 calendar days), with **zero new npm dependencies** — additive migrations (015/016/017/018), new server/core modules (evidence-hard-drop, cross-file-security, learned-rules, codebase-index, annotations, workspace-credentials), new client components (LearnedRulesPanel, CodebaseIndexPanel), and dashboard UI surfaces only. `npm run typecheck` exit 0.
- **v1.1 interactive/multi-pass surfaces:** security pass + critic as budget-aware `(file, pass)` work units and a dedicated `critic` phase (`core/review.ts`); streamed walkthrough state in `jobs.walkthrough_comment_ref` (Postgres, never Workflow memory); command/Q&A dispatch at the webhook/queue layer (never the review Workflow), self-filtering the bot's own comments first; DB-backed provider-agnostic pause (`pr_review_state`).
- **v1.2 audit trail discipline:** every engine stage (`recordUnitAudit` / `recordWalkthroughAudit` / `recordRoundAudit` / `recordVerifyFixesAudit` / `recordFileSkips` / `buildFinalizeDropEvents`) emits a per-stage event to `jobs.audit` (migration 010, JSONB ring-buffer cap 500). Title-bearing events route through `redactFindingTitle` ([title-redacted] for non-empty, [clamped:empty] for nullish); error events route through `redactErrorMessage` (5-machine-error enumeration). The audit trail is structurally a privacy-safe operator surface — readable without SQL, groupable by stage, explainable per drop.
- **v1.2 phase routing discipline:** a single `core/phase-routing.ts` module exports `nextPhaseAfterReview`, `nextPhaseAfterVerifyFixes`, `nextPhaseAfterCritic` — every phase exit walks the canonical selector (Phase 20.1 BLOCKER-2/3/4/5 closure). Routing invariants are tested with all-toggle-combination integration tests in `test/review-flow.spec.ts`. Loop-prevention is asserted (verify_fixes never re-enters critic).
- **Known v1.0 tech debt** (non-blocking, see `.planning/milestones/v1.0-MILESTONE-AUDIT.md`): a cosmetic vitest hoisting warning in `test/webhook-ingest.spec.ts`; `computeCredentialStatus` fails open on an unparseable expiry string (unreachable via the write path, Zod rejects malformed dates with 400); Phase 5 has no recorded Nyquist `VALIDATION.md` (process gap, not functional); SUMMARY.md frontmatter omits `requirements-completed` for AUTH-02/BB-04/REV-01/02/03 (documentation-consistency only — all independently verified in each phase's VERIFICATION.md).
- **Known v1.1 tech debt** (non-blocking, see `.planning/milestones/v1.1-MILESTONE-AUDIT.md`): phases 08/10/11/12 carry `draft` Nyquist `VALIDATION.md` (coverage TODO, not a failure — full suite green, every phase VERIFICATION passed; promote via `/gsd-validate-phase 08 10 11 12`); `forProvider` Bitbucket jobless path uses an inert placeholder `prNumber:0`; `dispatchInteractiveMessage` prefers the carried `configSnapshot`, falling back to `loadRepoConfig` only for pre-deploy in-flight messages (deliberate Bitbucket collision guard).
- **Known v1.2 tech debt** (non-blocking, see `.planning/v1.2-MILESTONE-AUDIT.md` `tech_debt:` frontmatter): Phase 17 deployment checkpoints A1/A2/A3/A5 are code-verified but require deployment-time verification (runbook items, not code gaps); Phase 18 dead-code fallback at `review.ts:917-918` + `selectDiffForRound` `fromSha: ''` convention (INFO); Phase 19 `recordVerifyFixesAudit` dead import in `review.ts:63` (INFO; WARNING-4 from prior review); Phase 20 W2/W3/W5 walkthrough audit edge cases (parser provenance mitigates W2; persistAndAudit helper mitigates W3; NREG-01 unaffected by W5); Phase 20.1 INFO harness LSP "unused export" warnings for `VERIFY_FIXES_FIXED_REASONS`/`VERIFY_FIXES_UNFIXED_REASONS`/`VerifyFixesWindow` in `src/server/core/verify-fixes.ts` (per-module contract surface, `tsc --noEmit` authoritative per CLAUDE.md "Codra LSP lags behind tsc" convention). Phase 16 is PARTIAL by Nyquist plan design (telemetry-payload-only, no validation prompt); Phase 20 had no Nyquist validation cycle (closure documentation-only); Phase 20.1 was a gap-closure phase that did not run a Nyquist validation cycle but inherits and exercises the structure validated in Phase 13.
- **Known v1.4 tech debt** (non-blocking, see `.planning/v1.4-MILESTONE-AUDIT.md` `tech_debt:` frontmatter): Phase 27 minor hardcoded type union in file-reviews.ts (resolved by Phase 32); Phase 28 minor prompts/cross-file-security-review.ts does not import CROSS_FILE_DIFF_MAX_LINES from diff.ts (not needed — constant used by buildCrossFileDiff). Phase 32 resolved all items from the v1.4 milestone audit tech_debt list.

## Constraints

- **Tech stack**: Cloudflare Workers + Workflows + Queues + KV + Hyperdrive, external PostgreSQL, Hono, React 19, TypeScript, Zod, raw SQL (no ORM). Bitbucket support fits this stack with no new hosting dependency — confirmed through v1.0.
- **Compatibility**: Zero regression to existing GitHub review flows; GitHub and Bitbucket run in the same deployed Worker — held continuously through v1.0.
- **Platform**: Bitbucket **Cloud** only (bitbucket.org), not Data Center/Server.
- **Pattern**: Hand-rolled REST client (no heavy SDK) — `core/bitbucket.ts` mirrors `core/github.ts`; provider adapter behind a shared interface; contract shapes in `src/shared/`; one DB module per domain; migrations as numbered SQL files.
- **Data shapes first**: `src/shared/schema.ts` changes precede implementation when introducing provider tagging.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bitbucket **Cloud** only (not Data Center) | User's workspace is on Bitbucket Cloud; DC is a separate API dialect | ✓ Good |
| **Coexist** with GitHub (multi-provider), don't replace | Keep existing GitHub capability; one instance serves both | ✓ Good |
| **Full parity** in v1 (webhook review + inline comments + Bitbucket OAuth login) | Bitbucket users should get the same experience as GitHub users | ✓ Good |
| Bot auth: **Repository/Workspace Access Token** (Bearer), not Atlassian Connect or app passwords | Connect is EOL 2026-12 and heavyweight for single-tenant; app passwords removed 2026-07-28 | ✓ Good |
| Target = user's **own self-hosted deployment** | Sets the quality bar (parity, tests) without requiring full upstream polish | ✓ Good |
| `VcsProvider` interface + single `VcsService` branch point in `core/review.ts` (Phase 2) | Zero-behavior-change refactor gated by a pre-flip regression net, rather than a big-bang rewrite | ✓ Good — full suite passed unmodified through the flip |
| Shared `core/webhook-ingest.ts` extracted before Bitbucket existed (Phase 3) | GitHub's dedup/insert/supersede/enqueue logic reused byte-identical by the second caller instead of duplicated | ✓ Good |
| Bitbucket credentials AES-GCM encrypted, mirroring `core/llm-crypto.ts` (Phase 4) | Reuse a proven crypto pattern rather than invent a new one for a second secret type | ✓ Good |
| D-29: APP_KV `updates-email` key format changed to `updates-email:${provider}:${id}` (Phase 6) | Needed provider-scoped keys for dual-login; old keys orphan and users re-subscribe on next login | ✓ Good — intentional, documented tradeoff, not a regression |
| Security pass modeled as `(file, 'security')` `file_reviews` work units, not a second model call inside one per-file task (Phase 10) | Existing `budgetAwareFileLimit` chunk-concurrency math throttles the 2× load unchanged; `ESTIMATED_SUBREQUESTS_PER_FILE` stays 5 (per-unit) | ✓ Good — budget invariants held; `chunk-concurrency.spec.ts` re-derived deliberately |
| Critic runs as its own phase (between `review` and `finalize`), fail-open, read-only on finalize retry (Phase 10) | Keep the critic model call off the budget-fragile `finalize`; a degraded review can never bypass it, and a retry never re-spends model budget | ✓ Good — `nextPhaseAfterReview` routes every exit through it; idempotent on persisted `critic_result` |
| Dedup before critic; near-duplicate suppression is same-file-only with a pinned line-proximity gate (Phase 10) | A second finding source (security) must not produce duplicate comments; determinism preserved (no model in the dedup path) | ✓ Good |
| Streamed walkthrough comment ref persisted in `jobs.walkthrough_comment_ref` (Postgres), never Workflow memory (Phase 9) | Pipeline hibernates + hands off to fresh instances; idempotent create keyed on the stored ref, 404-on-edit → re-post, never fail the job | ✓ Good |
| Commands + Q&A dispatch at the webhook/queue layer (not the review Workflow), self-filtering the bot's own comments first by immutable id (Phase 11) | The echo loop is latent (the summary embeds `@bot review`); Q&A is a lightweight non-Workflow read-only model call, rate-limited + injection-fenced | ✓ Good |
| Authorization + all interactive identity keyed on immutable id (GitHub numeric user id / Bitbucket `account_id`), Bitbucket permission read best-effort fail-closed-to-null (Phase 11) | Repo access tokens can't introspect; membership must never map to write; `username` is renameable | ✓ Good |
| Threaded replies: `threadable` set at the webhook boundary per event type (GitHub `in_reply_to` inline only / Bitbucket `parent` always), never inferred downstream (Phase 12) | Reply threading is a provider/event capability, not derivable from `parentRef`/`findingRef`; top-level fallback keeps it inert when unavailable | ✓ Good — confirmed live on a real Bitbucket PR |
| Bitbucket dashboard repo-config: nullable `installationId`, lazy default `repo_config` materialization on read, provider-addressed (`?provider`) read/write (Phase 12) | Bitbucket repos have no installation id and no auto-created config; a same-named GitHub+Bitbucket pair must be read/toggled/written in isolation | ✓ Good — verified live via Playwright on the deployed instance |
| Severity/category correctness fix ships always-on (D-01), with a `severity_engine.enabled` escape hatch (D-02) (Phase 13) | Framed as a correctness fix to an already-running assignment, not a new opt-in capability — mirrors the Phase-14 always-on-dedup precedent; the escape hatch exists for a repo that finds the reclassification disruptive | ✓ Good — existing repos should expect some findings to shift P-level on next deploy (release note) |
| Priority file selection + content-based generated detection ship always-on (D-01), governed by a single combined `file_selection.enabled` escape hatch (default true) (Phase 15) | Third documented NREG-01 always-on exception alongside `severity_engine` and `dedup`; one key reverts BOTH the priority sort and the generated detector at once (D-02); framed as a correctness improvement to which files get reviewed, not a new opt-in capability | ✓ Good — **release note:** on next deploy existing repos should expect (a) different files reviewed above `max_files` (priority order, not new-first), (b) generated files dropped from review, and (c) under the cap, review SCHEDULING / persisted-read / tie order may shift — posted output is unchanged (comments anchor to path+line and the walkthrough sorts independently). PRIO-03 satisfied at the DROP-CLASS level: `generated` → per-file `file_skipped` reason; `over_cap` → one aggregate carrying the EXACT total count + a bounded (≤20) priority-ordered sample naming the highest-priority OMITTED files; `skip_glob` intentionally NOT surfaced (user-configured, expected — locked D-11/D-12/D-13). |
| Composite-rule dedup ships always-on (FILT-03, D-01), with `dedup.enabled` escape hatch (Phase 14) | Composite rules (same path+line+category; overlapping title-Jaccard ≥0.2; non-overlapping ≥0.6; cross-path title ≥0.8 AND body ≥0.5) catch more duplicate findings than the v1.1 same-file-only proximity gate; framed as a correctness improvement, with `dedup.enabled: false` reverting to byte-identical v1.1 behavior | ✓ Good — release note: existing repos may see slightly fewer comments per review where composite dupes were slipping through |
| Always-on correctness fixes are documented exceptions, not regressions: `severity_engine`, `dedup`, `file_selection` (each default-on, single-key escape hatch, release note) (v1.2) | The NREG-01 default-byte-identical posture would forbid always-on behavior changes; framing each as a "correctness fix to an already-running assignment" makes the posture consistent — every change is either config-gated (opt-in capability) or a documented always-on correction with a single escape hatch | ✓ Good — three release notes are the load-bearing operator signal; escape hatches cover the rare repo that finds the correction disruptive |
| Migration 010 (`jobs.audit`) + open `jobAuditEventSchema` discriminated union + per-job ring-buffer cap (Phase 13) | Every drop in the engine is explainable from a single operator surface; the open union keeps Phase 14/15/18/19 additive (`.passthrough()` for new variants) without back-migrations | ✓ Good — drop-oldest cap protects against evidence_missing flood (WR-01 tracks the per-unit bound for EVID-02 v2) |
| Severity engine and audit writers are pure (`core/severity.ts`, `core/audit.ts`) — wired into `model-output.ts` and `services/model.ts` (Phase 13) | Pure rules are TDD-pinnable; the wire sites are one-call-each so the engine stays deterministic and testable | ✓ Good — 23 severity.spec.ts cases + 9 audit-trail.spec.ts cases + 6 severity-audit-integration.spec.ts cases pin the contract |
| `VcsProvider` widened to `getFileContent(path, ref)` + `getCompareDiff(base, head)` + `getUnresolvedBotThreads` + `resolveThread` on both providers behind capability flags, with no consumers wired (Phase 17) | Build the seam before the consumers; Phases 18 and 19 plug into primitives that already work on both providers, and capability-flagged degradation (Bitbucket `threadResolutionSupported` downgrades on 403/404/501) protects against silent GitHub-only failure | ✓ Good — 4 plans + capability spec + SC4 grep test + 17-VERIFICATION-FINAL.md deployment-checkpoint consolidation; deployment-time verification is a runbook item, not a code gap |
| `last_reviewed_sha` anchor written ONLY on successful finalize; never when head SHA is empty (Phase 18, RND-05) | Round detection must not advance the anchor on a failed/empty review — that would suppress all future round-2 incremental diffs; the empty-SHA guard prevents a degenerate "no head" final state from poisoning the anchor | ✓ Good — atomic write at finalize; pure `resolveRoundContext` decides round 1 vs round 2+ from `pr_review_state` + bot-thread existence |
| Round-escalated floors (round 2 = 0.8/P2; round 3+ = 0.85/P2; user-set wins; `rounds.escalate_floors: false` disables) (Phase 18) | Stricter floors for round 2+ filter noise more aggressively without ever lowering a stricter user-set value; explicit escape hatch for repos that want round-2+ behavior to match round 1 | ✓ Good — `composeRoundFloors` is pure and re-derived deliberately |
| Verify-fixes windowed file content: full file when ≤500 lines, merged 50-line windows otherwise; `threads.verify_fixes` opt-in, `threads.auto_resolve` opt-in (Phase 19) | Full file context is too expensive above 500 lines; merged 50-line windows around each issue keep the prompt compact while preserving local context; auto-resolve is a separate toggle so verify-only mode reports counts without resolving | ✓ Good — boundary tests pin 499/500/501/575 lines; `shouldAttemptResolution` accepts only explicit `fixed` verdicts |
| Critic v2 canonical one-row-per-candidate decision ledger; verdict-only model output (Phase 19) | The reviewer cannot invent a candidate; verdicts (proven/plausible/unsupported/missing) are recorded per candidate so the finalize chain can deterministically keep/drop | ✓ Good — fail-open on LLM error; missing verdict → drop with audit reason |
| Ensemble majority vote (1-5 runs), strict majority > successfulRuns/2, partial-failure tolerant (Phase 19, PASS-02) | Ensemble only adds value when N>1; failed calls are removed from the denominator; one survivor degrades to that run output; runs-aware `ESTIMATED_SUBREQUESTS_PER_FILE` re-derived against `chunk-concurrency.spec.ts` keeps the 50-subrequest budget honest | ✓ Good — `chunk-concurrency.spec.ts` re-derived deliberately; `matchCompositeRule` reused from dedup.ts (one matcher, both places) |
| Walkthrough confidence is deterministically clamped DOWNWARD (any P0 → 2 "Do not merge"; ≥3 P2 with no P0 → ≤3 "Needs review"); the LLM-supplied score is never raised (Phase 19, PASS-03) | The walkthrough is the operator's at-a-glance summary; we never want the LLM to make the verdict look rosier than the findings warrant; the clamp is the load-bearing honesty contract | ✓ Good — `clampConfidenceDownward` is pure; effort + change groups flow through the formatter |
| Audit-trail viewer parity: synthetic `ensemble` stage in `STAGE_ORDER` after `critic`; `normalizeAuditDisplayStage` maps `ensemble.voted -> ensemble` (Phase 20, GAP-INT-01) | Persisted ensemble.voted events must render in the dashboard's audit-trail viewer; without the synthetic stage they were filtered by `groupAuditByStage` | ✓ Good — `DecisionEvent` cases at audit-trail-viewer.tsx:269-311 render file/runs/winners/dropped/failed |
| `buildWalkthroughEnrichmentAuditEvent` (pure, bounded) + `recordWalkthroughAudit` (best-effort, never-throws); `parseWalkthroughEnrichmentResponse.malformedFields` provenance preserves `partial` status (Phase 20, GAP-INT-02) | Walkthrough enrichment must persist once before recording exactly one bounded audit event per terminal outcome; parser provenance makes `partial` reachable from real malformed-field cases (Codex HIGH finding) | ✓ Good — `persistAndAudit` helper at walkthrough-enrichment.ts:78-93 emits exactly one event per terminal branch |
| AUD-01 privacy redaction: `redactFindingTitle` returns `[title-redacted]` (16 chars) for every non-empty title; `redactErrorMessage` maps arbitrary Error.message to one of 5 machine-error codes (Phase 20.1, BLOCKER-1) | Title-bearing audit events can leak source-derived content; machine-error enumeration prevents raw stack traces / secrets / matched PII from reaching the audit trail | ✓ Good — all 8 producer sites route through helper; pre-existing test assertions asserting raw titles updated by commit `4b0b2ad`; AUD-01 now factually signable |
| Canonical phase-routing selectors: `nextPhaseAfterReview` / `nextPhaseAfterVerifyFixes` / `nextPhaseAfterCritic` in `core/phase-routing.ts`, wired into every ceiling and terminal handler (Phase 20.1, BLOCKERs 2/3/5) | Single source of truth for phase exits; every toggle combination routes through the same selector; loop-prevention is asserted (verify_fixes never re-enters critic) | ✓ Good — 6 new integration tests in `test/review-flow.spec.ts` cover all toggle combinations |
| Verify-fixes idempotency guard + review-rest guard schedule successor via `markJobContinuationQueued` + `NextPhaseError` (Phase 20.1, BLOCKER-4) | Crash recovery must not stop the pipeline; terminal handlers must enqueue the next phase rather than return normally | ✓ Good — crash-recovery integration tests pass |
| Production-CSS visual backstop: `loadProductionStylesheet` helper loads the real Vite/Tailwind build, `vitest.config.ts:91` globalSetup scoped to browser project's nested `test` block, per-test try/finally `ServeHandle` lifecycle (Phase 20.1, WARNING-1) | Hardcoded utility CSS is a false-positive backstop; loading the production bundle tests what the dashboard actually ships; scoped globalSetup prevents the node project from building `dist/client` | ✓ Good — 17 browser files / 102 tests / 0 failures under nix-shell |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-31 — v1.5 milestone in progress: Phase 33 quality fixes complete (PRD-01/02/03), 3 of 8 PRD-parity requirements shipped. Next: Phase 34 context enhancement (PRD-04/05).*
