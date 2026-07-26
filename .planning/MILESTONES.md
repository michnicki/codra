# Milestones

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
