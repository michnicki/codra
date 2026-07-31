---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: tech debt — audit viewer renderer, misleading middleware comment, hardcoded type unions, test-hygiene improvements, integration test gap, and stale planning docs
current_phase: 28
current_phase_name: LRN-01 Learned-rule synthesis from reject feedback
status: executing
stopped_at: Phase 32 context gathered
last_updated: "2026-07-31T08:13:09.862Z"
last_activity: 2026-07-31
last_activity_desc: Phase 27 complete, transitioned to Phase 28
progress:
  total_phases: 11
  completed_phases: 10
  total_plans: 31
  completed_plans: 31
  percent: 91
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-25 for v1.2 closure)

**Core value:** A Bitbucket Cloud PR gets the same AI review a GitHub PR gets, from one instance, without breaking GitHub — held end-to-end since v1.0, extended by v1.1 (every interactive/multi-pass capability shipped on both providers), extended by v1.2 (deterministic severity + real categories, audit-backed noise filter, priority file selection, incremental rounds, verify-fixes, critic v2, ensemble, walkthrough enrichment — all on both providers, every drop explainable from `jobs.audit`).
**Current focus:** Phase 27 — sec-xdiff-01-whole-diff-cross-file-security-reasoning

## Current Position

Phase: 28 — LRN-01 Learned-rule synthesis from reject feedback
Plan: Not started
Status: Executing Phase 27
Last activity: 2026-07-31 — Phase 27 complete, transitioned to Phase 28

### Phase 27 Plan 27-01 Decisions (SEC-XDIFF-01)

- cross_file_security is FIRST hop after review (before verify_fixes)
- nextPhaseAfterCrossFileSecurity does NOT re-check toggle (Pitfall 1)
- Fail-open: model errors persist skipped row + audit event
- __cross_file__ sentinel path for synthetic file_review row
- callVerifierRaw for single model call
- CROSS_FILE_DIFF_MAX_LINES = 3000 (~12K tokens)
- Priority-based diff truncation (security-sensitive paths first)
- SENSITIVE_KEYWORDS extended: middleware, routes, session

### Phase 27 Plan 27-02 Decisions (SEC-XDIFF-01)

- No manual __cross_file__ append in finalize — automatic via reviews.flatMap / criticResult.kept
- Walkthrough cross-file section identified by cross_references presence, NOT path === '__cross_file__'
- __cross_file__ intentionally excluded from expected-units builder (synthetic row, not real file)
- Main walkthrough severity counts stay main-only (NREG-01 preserved)
- crossFileComments passed to buildWalkthroughData as optional parameter
- Formatter "Also affects" links rendered inline after finding body

## Performance Metrics

**Velocity:**

- Total plans completed (v1.0): 19
- Total plans completed (v1.1): 29 (Phases 7-12)
- v1.2 plans completed: 49 (9 phases, including Plan 19-10 and all 8 Phase 20.1 plans)
- Average duration: — (carried per-plan metrics below)

**Per-Plan Metrics (v1.1, carried for reference — archives in .planning/milestones/):**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 07 P01 | 8min | 3 tasks | 5 files |
| Phase 07 P02 | 4min | 3 tasks | 4 files |
| Phase 07 P03 | 6min | 3 tasks | 6 files |
| Phase 07 P04 | 15min | 3 tasks | 4 files |
| Phase 08 P02 | 12min | 3 tasks | 5 files |
| Phase 08 P03 | 4min | 3 tasks | 5 files |
| Phase 09 P01 | 6min | 3 tasks | 7 files |
| Phase 09 P02 | 12min | 3 tasks | 3 files |
| Phase 09 P03 | 18min | 3 tasks | 5 files |
| Phase 10 P01 | 9min | 3 tasks | 8 files |
| Phase 10 P02 | 12min | 1 tasks | 2 files |
| Phase 10 P03 | 6min | 2 tasks | 4 files |
| Phase 10 P04 | 7min | 2 tasks | 5 files |
| Phase 10 P05 | 10min | 3 tasks | 3 files |
| Phase 10 P06 | 25min | 3 tasks | 3 files |
| Phase 10 P07 | 22min | 3 tasks | 2 files |
| Phase 11 P01 | 30min | 3 tasks | 11 files |
| Phase 11 P02 | 45min | 4 tasks | 13 files |
| Phase 11 P03 | 25min | 2 tasks | 2 files |
| Phase 11 P04 | 35min | 2 tasks | 6 files |
| Phase 11 P05 | 11min | 3 tasks | 5 files |
| Phase 11 P06 | 40min | 2 tasks | 9 files |
| Phase 11 P07 | 55min | 2 tasks | 7 files |
| Phase 12 P01 | 6min | 3 tasks | 12 files |
| Phase 12 P02 | 8min | 3 tasks | 6 files |
| Phase 12 P03 | 6min | 2 tasks | 6 files |
| Phase 12 P04 | 5min | 3 tasks | 4 files |
| Phase 12 P05 | 15min | 3 tasks | 3 files |
| Phase 31 P03 | 45min | 2 tasks | 5 files |

*Updated after each plan completion*
| Phase 13 P01 | 9m | 2 tasks | 3 files |
| Phase 13 P02 | 7 min | 2 tasks | 6 files |
| Phase 13 P3 | 20m | 2 tasks | 3 files |
| Phase 13 P13-04 | 30 min | 2 tasks | 3 files |
| Phase 14 P01 | 8min | 2 tasks | 3 files |
| Phase 14 P02 | 12min | 2 tasks | 3 files |
| Phase 14 P03 | 30min | 2 tasks | 2 files |
| Phase 15 P01 | 6min | 3 tasks | 4 files |
| Phase 15 P02 | 8min | 1 tasks | 2 files |
| Phase 15 P03 | 12min | 2 tasks | 2 files |
| Phase 15 P04 | 20min | 4 tasks | 8 files |
| Phase 15 P05 | 9min | 3 tasks | 4 files |
| Phase 16 P01 | 4min | 3 tasks | 2 files |
| Phase 16 P02 | 3min | 3 tasks | 6 files |
| Phase 16 P03 | 22 | 3 tasks | 4 files |
| Phase 16-dashboard-catch-up P04 | 7min | 3 tasks | 7 files |
| Phase 16 P05 | 18min | 2 tasks | 2 files |
| Phase 16 P06 | 14m | 2 tasks | 3 files |
| Phase 19 P01 | 1624 | 2 tasks | 6 files |
| Phase 19 P06 | 12min | 2 tasks | 7 files |
| Phase 19 P03 | 23min | 2 tasks | 11 files |
| Phase 19 P05 | 1500 | - tasks | - files |
| Phase 19 P04 | 30 | 2 tasks | 11 files |
| Phase 19 P08 | 32min | 2 tasks | 13 files |
| Phase 19 P09 | 23min | 2 tasks | 9 files |
| Phase 20 P01 | 13 | 2 tasks | 11 files |
| Phase 20 P02 | 15min | 2 tasks | 2 files |
| Phase 20 P03 | 10min | 1 task | 1 file |
| Phase 21 P01 | 7min | 2 tasks | 3 files |
| Phase 21 P02 | 12min | 3 tasks | 5 files |
| Phase 24 P01 | 4min | 4 tasks | 4 files |
| Phase 27 P01 | ~45min | 2 tasks (merged) | 16 files |
| Phase 28 P04 | 18min | 3 tasks | 10 files |
| Phase 29 P01 | 25min | 2 tasks | 11 files |
| Phase 29 P03 | 14min | 3 tasks | 11 files |
| Phase 29 P04 | 16min | 3 tasks | 2 files |
| Phase 29 P02 | 22min | 2 tasks | 6 files |
| Phase 29 P07 | 35 min | 2 tasks | 3 files |
| Phase 29 P05 | 22min | 3 tasks | 9 files |
| Phase 29 P08 | 14min | 2 tasks | 2 files |
| Phase 30 P01 | 35min | 3 tasks | 6 files |
| Phase 30 P02 | 30min | 2 tasks | 3 files |
| Phase Phase 30 PP03 | 20min | 3 tasks tasks | 4 files files |
| Phase 30 P04 | 25min | 2 tasks | 2 files |
| Phase 31 P01 | 55min | 2 tasks | 9 files |
| Phase 31 P02 | 40min | 2 tasks | 6 files |
| Phase 31 P04 | 35min | 2 tasks | 4 files |
| Phase 31 P05 | 22min | 2 tasks | 4 files |

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md Key Decisions table. v1.2 roadmap decisions:

- [v1.2 roadmap]: Phases 13-19 follow the approved gap-analysis dependency order — contracts/severity/audit (13) → noise filter (14) and priority+evidence (15) and provider groundwork (17, any time after 13, parallelizable) → dashboard catch-up (16) → incremental rounds (18, needs 14+17, riskiest) → LLM pass upgrades (19, last). NREG-01/NREG-02 are cross-cutting standing gates across all seven phases (v1.0/v1.1 convention), not owned by any single phase.
- [v1.2 roadmap]: Standing decisions from REQUIREMENTS.md: keep P0-P3/nit with an exported PRD band map (no historical-row migration); defaults opt-in except always-on dedup (`dedup.enabled` escape hatch + release note); EVID-01 ships soft/audit-only before any hard-drop; every engine stage emits audit events so drops are explainable. Migration numbering continues: 010 (`jobs.audit`), 011 (`pr_review_state` last_reviewed_sha/last_review_round/last_reviewed_at).
- [v1.2 roadmap]: The Cloudflare 50-subrequest/invocation budget governs all new pass scheduling — ensemble (PASS-02) must shrink per-invocation chunks via a runs-aware `ESTIMATED_SUBREQUESTS_PER_FILE`, re-derived deliberately against `chunk-concurrency.spec.ts` (the Phase 10 convention), never silently.
- [v1.2 roadmap]: SEV-04 is owned by Phase 13 (real model-assigned categories persisted + exposed); its "rendered in job detail" clause is delivered by Phase 16's UI-02 surface. Both finalize comment paths (`finalComments` AND `mainFinalComments`, core/review.ts:1568-1602) must run the reworked Phase-14 filter chain so walkthrough counts and posted comments agree.

Decisions carried from v1.1 execution (still load-bearing for v1.2 — Phase 14 reworks dedup.ts, Phases 18-19 build on the critic/finalize/budget machinery):

- [v1.1 roadmap]: Ordering invariants: schema before consumers; dedup before critic; critic and Q&A model calls kept OFF the budget-fragile `finalize`.
- [Research]: Zero new npm dependencies — every feature is new client methods, prompts, Zod shapes, additive numbered migrations.
- [Research]: Security pass modeled as `(file, pass)` `file_reviews` rows (unique index `(job_id, file_path, pass)`) so `budgetAwareFileLimit` throttles it unchanged; critic as its own phase with result persisted to `jobs.critic_result`. Do NOT add a second model call inside one per-file task without deliberately re-deriving `ESTIMATED_SUBREQUESTS_PER_FILE`/`SAFE_MARGIN`/concurrency-cap against `chunk-concurrency.spec.ts`.
- [Research]: Streamed walkthrough state (comment ref) lives in `jobs.walkthrough_comment_ref` (Postgres), never Workflow memory — the pipeline hibernates + hands off to fresh instances. Idempotent create keyed on stored ref; 404-on-edit (human deleted) → re-post, never fail the job.
- [Research]: Commands dispatch at the webhook/queue layer, NOT the review Workflow. Self-filter the bot's own comments FIRST. Pause state is DB-backed + provider-agnostic. Q&A is a lightweight `{ kind: 'qa' }` non-Workflow model call, read-only, injection-resistant, rate-limited, token-capped.
- [v1.0 carryover]: GitHub's pipeline runs through a `VcsProvider` interface + single `VcsService.forRepo/forProvider` branch point; every new PR interaction must be an interface method returning opaque `{ ref }`, keyed on immutable `account_id`, never `username`.
- [Phase 10]: 10-02: dedup is same-file-only — different-path pairs never merge even at similarity 1.0 (ParsedReviewComment has no line_range). *(v1.2 FILT-03 composite rules add cross-path merging — this is a deliberate behavior change to that module, gated per NREG-01.)*
- [Phase 10]: 10-02: PINNED proximity gate — merge iff both lines within DEDUP_LINE_PROXIMITY(10) OR both null; exactly-one-null keeps both separate.
- [Phase 10]: 10-02: clustering is one greedy pass vs already-KEPT survivors; D-04 tie-break (severity→confidence(explicit>null)→stable-first) resolved in place, position preserved.
- [Phase 10]: 10-05: security pass scheduled as a separate (file,pass) work unit; ESTIMATED_SUBREQUESTS_PER_FILE stays 5 (per-unit cost) so the 2x load is absorbed by more chunks, not a higher per-unit cost.
- [Phase 10]: 10-06: single nextPhaseAfterReview(config) selector routes ALL review-exit paths through the critic when enabled; critic-off returns 'finalize' byte-identically (NREG-01).
- [Phase 10]: 10-06: runCriticPhase is idempotent on a persisted job.criticResult (no model re-call after hibernation) and FAIL-OPEN; only subrequest-budget errors reschedule, then fail open to finalize (never terminal-fails).
- [Phase 10]: 10-07: finalize resolves reviewedComments by precedence criticResult.kept → dedup(union(main,security)) [security on] → main-only flatMap; finalize is READ-ONLY over jobs.critic_result (zero critic model calls on retry).
- [Phase 10]: 10-07: Phase-9 surfaces read mainReviews; a separate mainFinalComments feeds buildWalkthroughData; ALL rows feed only token totals + candidate union.
- [Phase 11]: 11-02: Bitbucket authorization is the per-repo account_id allow-list; getUserRepoPermission-bitbucket is best-effort fail-closed-to-null and never grants write on membership.
- [Phase 12]: 12-01: repoConfigRecordSchema.installationId nullable; getOrCreateRepository/upsertRepoConfig param widened to string|null.
- [Phase 12]: 12-04: listRepoConfigs materializes a default repo_config for every config-less Bitbucket repositories row; GET/PATCH config routes are provider-addressed via optional ?provider (same-named GitHub+Bitbucket pairs isolated).
- [Phase 13]: 13-03: audit writes are best-effort/non-blocking (T-13-03-04) — recordUnitAudit never fails its caller
- [Phase 13]: 13-03: $2::text::jsonb param binding required to defeat postgres.js double-encoding for server-side jsonb ring-buffer ops
- [Phase ?]: 14-02: DropRecord holds per-category effectiveFloor + finding metrics so buildFinalizeDropEvents emits one filtered event per distinct effective floor (review #2/#4)
- [Phase 14]: 14-03: dedup.enabled default-true runs composite dedup in-chain incl. critic-kept; false reverts DEDUP dimension only (cap/floors/sort still apply)
- [Phase 14]: 14-03: finalize drop audit emitted on posting path only, gated on !finalizeRetriedPastPost for at-most-once; omittedCount = dropped.cap.length
- [Phase ?]: 15-01: file_selection is a single combined toggle (default-on, D-02) governing BOTH priority sort and generated detector — third documented NREG-01 always-on exception
- [Phase ?]: 15-01: existing_code is z.string().nullable().optional() so a JSON null never throws the per-file parse before the 15-04 evidence check (Codex HIGH, fail-open soft gate)
- [Phase ?]: 15-01: jobAuditEventSchema stays discriminatedUnion('stage') — file_skipped/evidence_missing added as additive .passthrough() arms; unknown stage still rejects per-event
- [Phase ?]: 15-03: One shared selectReviewableFiles routine drives both public selectors (D-04); disabled branch overCap preserves the legacy remainder so review-rest reconstruction stays byte-identical (Codex 15-03 HIGH)
- [Phase ?]: 15-03: isGeneratedFile uses String.includes over a bounded upper-cased 500-char/first-two-hunks window (no regex); diff.ts stays pure returning drop metadata for the 15-05 recorder
- [Phase ?]: 15-04: existingCode evidence gate is audit-only (D-14) — evidence_missing{absent|not_in_hunk} rides the shared severityAuditEvents accumulator (D-18); finding always posts, no output change
- [Phase ?]: 15-04: pollReviewBatch reconstructs the exact bounded (truncated) file the model saw before the evidence check — async never validates against unseen code (Codex 15-04 HIGH)
- [Phase 15]: 15-05: file_skipped over_cap aggregate carries the COMPLETE overCap count + first-20 highest-priority-OMITTED sample (Open-Q1, supersedes D-12 'lowest-priority' phrasing)
- [Phase 15]: 15-05: recordFileSkips gated on file_selection.enabled and INDEPENDENT of commands (D-13) — disabled toggle emits zero events while selector still preserves overCap data
- [Phase 16]: 16-01: mergeReviewPatch applies interactive LAST (current->settingsFields->interactive) so a fresh Interactive-panel edit is never clobbered by a stale interactive key inside a full settings draft (REVIEW #4); buildCategoryConfidence is a sparse partialRecord that drops out-of-range/non-numeric and never backfills absent categories
- [Phase ?]: [Phase 16]: 16-02: three pure render-side transform families extracted before JSX — countSeverities summarizes the VISIBLE candidate set not commentCount (D-05); jobDurationMs/normalizers/barPercent close REVIEW #7/#1/LOW; consumed by 16-04/16-05/16-06
- [Phase 16-dashboard-catch-up]: getJobDetail SELECTs rc.confidence so per-finding confidence round-trips to the client (REVIEW #2); scoped to the JSON_BUILD_OBJECT — no migration/schema/route change
- [Phase 16-dashboard-catch-up]: Job-detail telemetry (category tag, confidence chip, severity strip, critic panel) renders fail-open from the already-fetched payload via Plan 16-02 helpers; browser-spec execution deferred to orchestrator (libgbm.so.1 blocker)
- [Phase 16]: 16-05: severity/category distributions consume normalize*Counts (static-enum zero-fill), never the raw GROUP-BY payload, so absent bands still render at 0
- [Phase 16]: 16-05: KPI tiles pinned to a single text-2xl value size (UI-SPEC Dimension-4 FLAG); null perf renders em-dash
- [Phase ?]: AUD-02 SC3: outer 'Audit trail' section + drafted group are native <details> so browser collapse is asserted via .open; truncation banner rendered independently of the empty-array branch (REVIEW #9)
- [Phase 19]: Migration 013 is the sole owner of exactly three nullable Phase-19 JSONB columns; config_snapshot remains authoritative for toggles.
- [Phase 19]: Thread verdict and audit reasons are non-empty and bounded to 200 characters; thread bodies and provider payloads are not persisted.
- [Phase 19]: Recognized future durable phases are rejected before their workers land so they cannot fall through to normal review dispatch.
- [Phase 19]: Malformed thread_verifications JSONB degrades only threadVerification to null.
- [Phase 19]: 19-06: Undefined temperature preserves provider defaults; only explicit ensemble-extra requests override it.
- [Phase 19]: 19-06: Google increments subrequest accounting once per actual fetch and reuses the same optional temperature on retries.
- [Phase 19]: Completed thread-verification totals render only from logically consistent persisted results; fail-open, in-flight, or impossible totals render as degraded rather than fabricated zeros or clamped claims.
- [Phase 19]: threads.* audit variants normalize into one Threads display group, and opaque provider refs are truncated at browser sinks while bounded paths/reasons remain escaped React text.
- [Phase ?]: D-10: failed ensemble calls removed from the denominator; strict majority votes > successfulRuns/2; one survivor degrades to that run output (locked in 19-05 reconcileEnsembleRuns carve-out for successfulRuns <= 1)
- [Phase ?]: D-11: vote clusters reuse matchCompositeRule from dedup.ts; one vote per run per cluster (T-19-05-01 mitigation enforced via usedInThisRun tracking in clusterEnsembleRuns)
- [Phase ?]: D-12: winning cluster uses primary-run finding by reference; severity → confidence → stable-first fallback via pickSurvivor (locked in 19-05 pickClusterRepresentative)
- [Phase ?]: Critic v2 produces a canonical one-row-per-candidate decision ledger (D-05); verdict-only model output; reviewer cannot invent a candidate
- [Phase ?]: D-06 v2 revision: implicit small-set skip is REMOVED; only explicit skip_threshold keeps the model call
- [Phase 19]: Phase 19 default oracle is captured only from detached pre-Phase-19 commit 3d5f4150f8ff88787c10a3067ddc59176285eb25
- [Phase 19]: Phase 19 closes with provider-neutral AST seam checks and independent fail-soft JSONB readers
- [Phase ?]: Phase 20 D-01: synthetic 'ensemble' display stage in STAGE_ORDER immediately after 'critic' (audit-grouping.ts), maps 'ensemble.voted' -> 'ensemble' in normalizeAuditDisplayStage. Pairs with D-06 amended for walkthrough. — Closes GAP-INT-01: persisted ensemble.voted events now render in the audit-trail viewer instead of being filtered by groupAuditByStage.
- [Phase ?]: Phase 20 D-05 (amended): parser preserves malformed-field provenance (malformedFields: readonly ('groups' | 'confidence' | 'effort')[]). A field is malformed ONLY when supplied but failed validation; absent fields are not malformed. Status derived from provenance: completed (empty list), partial (some fields malformed, some survived), failed (fail_open). — Codex HIGH finding: the previous parser could not derive 'partial' status because malformed-field provenance was not retained. The amend makes the schema-defined 'partial' status reachable from real malformed-field cases.
- [Phase 20]: Phase 20 D-07: AUD-01 remains STRUCTURE READY — HUMAN SIGNATURE REQUIRED until a human fills both signature/date pairs; plan completion is not milestone attestation.
- [Phase 20]: Phase 20 D-08/D-09: visual backstops run as four real-surface light/dark suites with Chromium computed styles; browser infrastructure failures are never conditionally skipped.
- [Phase 20]: Plan 20-02: because vitest.config.ts omits the Tailwind Vite plugin, the visual spec supplies exact installed-Tailwind declarations and separately asserts production utility classes without changing config.
- [Phase 20]: Plan 20-03 records 31/31 requirements and 8/8 phase verification coverage while preserving AUD-01 as STRUCTURE_READY_HUMAN_SIGNATURE_REQUIRED until authentic signatures and dates are supplied.
- [Phase 20]: MILESTONES.md remains owned by /gsd-complete-milestone; EVID-02, WR-01, cleanup items, and Phase 17 deployment checkpoints remain deferred.
- [Phase 28]: D-01/D-02: Denormalize finding metadata (title, category, file_path, severity) into reject_feedback at reject time via VCS API lookup (Option 1 over research-recommended Option 2 — avoids review_comments schema change). All columns nullable.
- [Phase 28]: D-03: Cluster by exact (finding_category, finding_file_path) — no embedding/semantic similarity.
- [Phase 28]: D-04: Minimum cluster size of 2 rejections (excludes singletons).
- [Phase 28]: D-05: Clustering happens at synthesis time, not at reject time (on-demand, not streaming).
- [Phase 28]: D-06: Rule fields — id (crypto.randomUUID), category, file_pattern (picomatch glob), status, source_rejection_ids, created_at, updated_at.
- [Phase 28]: D-07: pending → active → disabled lifecycle; no auto-expiration.
- [Phase 28]: D-08: Rules stored in repo_configs.parsed_json.learned_rules (default []), normalized via parseJsonColumn/normalizeRepoConfig.
- [Phase 28]: D-09: learning config block in reviewConfigSchema — enabled boolean (default false), min_cluster_size integer (default 2).
- [Phase 28]: D-10: POST /api/repos/:id/learned-rules/synthesize — on-demand trigger from dashboard.
- [Phase 28]: D-11: PATCH /api/repos/:id/learned-rules/:ruleId — status transitions.
- [Phase 28]: D-12: Suppression in finalize, after EVID-02 hard-drop but before dedup.
- [Phase 28]: D-13: learned_rule_suppressed audit event (per (file, pass) aggregate).
- [Phase 28]: D-14: Suppression order: EVID-02 → learned rules → dedup → posting.
- [Phase 28]: D-15: Dashboard rule management UI (toggle, synthesize button, rule list with approve/disable/re-enable).
- [Phase 20.1]: Phase 20.1 D-01: redactFindingTitle returns `[title-redacted]` for every non-empty title and `[clamped:empty]` for nullish input — every title-bearing audit event now routes through this helper (9 references in audit.ts, 4 in model-output.ts). Closes BLOCKER-1.
- [Phase 20.1]: Phase 20.1 D-02: redactErrorMessage maps arbitrary Error.message to one of 5 MACHINE_ERROR_REASONS codes (transient/network/rate_limit/auth/malformed); ModelService.runFileWithEnsemble derives failedRunReasons via this helper. Closes BLOCKER-1 ensemble producer site.
- [Phase 20.1]: Phase 20.1 D-03: nextPhaseAfterReview selector now walks ALL successors including walkthrough.enabled — closed BLOCKER-2 (walkthrough-only review was unreachable).
- [Phase 20.1]: Phase 20.1 D-04: nextPhaseAfterVerifyFixes selector wired into verify-fixes terminal handler (review.ts:2982-2990); critic ceiling (review.ts:679) and verify_fixes ceiling (review.ts:698) both use canonical selectors. Closes BLOCKER-3 (verify-fixes bypassed critic).
- [Phase 20.1]: Phase 20.1 D-05: verify-fixes idempotency guard at verify-fixes.ts:441-448 + review-rest guard at :435-439 call markJobContinuationQueued and throw NextPhaseError. Closes BLOCKER-4 (terminal stop no successor scheduled).
- [Phase 20.1]: Phase 20.1 D-06: critic skip paths (empty input / explicit threshold / over-budget) emit critic.decisions audit event AND route through nextPhaseAfterCritic; jobAuditEventSchema accepts status: skipped. Closes BLOCKER-5.
- [Phase 20.1]: Phase 20.1 D-07: visual-backstops.spec.tsx loads production Vite/Tailwind CSS via loadProductionStylesheet; vitest.config.ts:91 globalSetup scoped to browser project's nested test block; per-test try/finally ServeHandle lifecycle. Closes WARNING-1.
- [Phase 20.1]: Phase 20.1 D-08: all pre-existing test assertions asserting raw titles (test/noise-filter.spec.ts lines 291/303/320-326/344-345 and test/review-flow.spec.ts:4266-4273) updated by commit 4b0b2ad to assert [title-redacted] / [clamped:empty]; npm test reports 113 files / 1550 tests / 0 failures. Confirms BLOCKER-1 closure is durable.
- [v1.2 closeout]: v1.2 closed 2026-07-25 — 31/31 requirements satisfied, all 5 BLOCKERs + 1 WARNING closed by Phase 20.1, milestone audit promoted from gaps_found to passed (re-run after Phase 20.1 closure), MILESTONES.md entry owned by /gsd-complete-milestone (entry content prepared in this milestone's final response for review before the irreversible archive CLI).
- [Phase 28]: 28-04: GitHub reject enrichment joins review_comments.position (the coordinate createReview posts by); Bitbucket keeps joining review_comments.line — each provider matches on the coordinate it actually anchors by (NREG-02). No migration: position existed since migration 001 and was already persisted on both file-reviews write paths. Closes G-28-3.
- [Phase 28]: 28-04: NO cross-provider coordinate fallback — a GitHub position miss leaves enrichment NULL rather than re-matching on line, because a line match is the exact defect G-28-3 documents (correctness over match rate).
- [Phase 28]: 28-04: ambiguous same-coordinate matches resolve via pickReviewCommentByCommentBody (the rejected comment body carries the finding title verbatim from formatInlineComment); LIMIT 1 replaced by a bound LIMIT with COORDINATE_CANDIDATE_LIMIT=20, ordered by (j.created_at DESC, rc.id ASC) for a total order. Body is in-memory only — never bound into SQL, persisted, or logged.
- [Phase 28]: 28-04 (deviation, Rule 1): body/title normalizers are deliberately ASYMMETRIC — the posted body is tag-stripped and entity-decoded, the stored title is not. A symmetric normalizer strips angle brackets out of a title like Guard <input> so it stops matching the body the formatter rendered it into.
- [Phase 29]: 29-01: buildQueryTerms drops an explicit JS stopword list (not Postgres's dictionary) so buildQueryExpression returns null for an all-stopword question and the caller issues NO statement
- [Phase 29]: 29-01: QA_MAX_INDEX_CHARS caps the EXCERPT text inside the retrieved-context fence, not the marker-bearing block, so an oversized chunk can never truncate away the closing UNTRUSTED_INDEX_END sentinel
- [Phase 29]: 29-01: CODE_INDEX_MAX_CHUNK_BYTES stays 32_768 with no pg_column_size guard — the 16 KB review findings were rejected on the measured 134 KB (12.8% of the 1 048 575-byte ceiling) worst case, recorded in the constant's comment so it cannot be re-litigated as hardening
- [Phase 29]: 29-01: one pure splitter serves BOTH directions and upsertCodeIndexChunks derives contentTokens from buildIndexTokens when omitted, so the shared-normalizer rule is a real import rather than a convention a caller can forget
- [Phase 29]: 29-01 (deviation, Rule 3): AppBindings.INDEX_WORKFLOW declared OPTIONAL — required for test/helpers.ts to typecheck, and honest because the wrangler binding + IndexWorkflow class land in 29-05, which should tighten it to required
- [Phase ?]: 29-03: the GitHub tree listing returns the branch head COMMIT sha from a third subrequest, not the trees endpoint's response sha (the TREE object id) — migration 018 defines indexed_sha as a commit and a tree sha is not a valid compare operand
- [Phase ?]: 29-03: no capability flag for listDefaultBranchTree — both providers can list a tree and differ only in cost, which truncated plus the adapter-internal page budget already express (NREG-02)
- [Phase ?]: 29-03: the Bitbucket /src walk returns a flagged PARTIAL listing on page-cap AND budget exhaustion instead of throwing, deliberately diverging from listRawPullRequestComments' fail-closed choice
- [Phase ?]: 29-03: selection helpers extracted additively (scorePath, isGeneratedContent) rather than fabricating a FileDiff, which type-checks but silently collapses ranking to keyword tiers
- [Phase ?]: 29-04: truncateCodeIndexForRepo clears indexed_sha/indexed_at alongside the counters — after the delete the repository genuinely has zero chunks, so a surviving indexed_sha would tell the operator panel an index exists at that commit; markCodeIndexBuildCompleted stays the only accessor that ADVANCES it
- [Phase ?]: 29-04: releaseCodeIndexBuildLease resolves status as well as clearing the lease (a still-'building' row becomes 'idle', 'ready'/'failed' preserved by CASE) — lease expiry guards correctness but nothing repaired the operator DISPLAY
- [Phase ?]: 29-04: the db/code-index 'no core/ import' rule is narrowed to 'nothing from core/ except the pure splitter and its weight labels' — 29-01 deliberately made the shared-splitter rule a real import; the load-bearing half is that audit-redact is NOT imported, so AUD-01 redaction cannot be silently absorbed by the db layer
- [Phase ?]: 29-02: D-16-R (developer-confirmed at blocking checkpoint) — nested-index-block at review.interactive.qa.index.{enabled,max_files,chunk_lines,top_k}; flat-qa-keys rejected; defaults false/500/50/8
- [Phase ?]: 29-02: max_files ceiling is .max(2_000) not the drafted 5_000 — bounds the worst legal build to ~3h at the derived ~12-files-per-minute rate; pinned by a 2000/2001 boundary spec PAIR so it cannot drift looser silently
- [Phase ?]: 29-02: the index key lands at FOUR Zod resolution paths, not the three the plan named (the z.object plus the qa, interactive and outer reviewConfigSchema .default literals) — each independently mutation-verified, since Zod 4 returns a .default literal without re-parsing it
- [Phase ?]: 29-02: NO .refine() cross-checking the build-budget constants — shared/schema.ts is imported by the dashboard client, so importing core/code-index-build.ts would drag server constants into the browser bundle and invert the layering; the bound plus documented arithmetic is the whole mitigation
- [Phase ?]: 29-02 (deviation, Rule 1): the dashboard Interactive sub-editor rebuilt its qa draft from scratch and mergeReviewPatch applies interactive LAST, so every Apply would have wiped the operator index config — repos.tsx now spreads interactive.qa first
- [Phase ?]: 29-02: the new NREG-01 parse assertions sit OUTSIDE dbDescribe in repo-configs.spec.ts — the file is entirely DB-gated, so gating pure schema assertions would silently skip the whole default-off proof on a host without TEST_DATABASE_URL (T-29-02-02)
- [Phase 29]: Q&A index retrieval gates on status === 'ready' only; no PR-base staleness check (no well-defined comparison, push-bounded freshness D-08, D-15 fails open) with the D-14 variant prompt carrying the disclosure — Plan 29-07 Task 1, incorporating OpenCode 29-07 MEDIUM as a required comment rather than a check
- [Phase 29]: findRepositoryIdByIdentity added as a read-only provider-filtered SELECT so the documented read-only Q&A path never calls the inserting getOrCreateRepository — Plan 29-07 Task 1; QA-02 read-only invariant plus T-29-07-03 cross-tenant isolation
- [Phase 29]: 29-08: the build endpoint claims the lease under codeIndexInstanceId(repositoryId), the same id it keys the Workflow instance on, because IndexWorkflow re-claims under event.instanceId and a mismatched owner would coalesce the build away silently
- [Phase 29]: 29-08: the index status response uses camelCase wire keys (matching mapJob) and returns status 'idle' with a 200 for a never-built repository rather than a 404
- [Phase 29]: 29-06: A1 CONFIRMED on a real GitHub push delivery (temporary repository-webhook capture, 2026-07-28) — repository.default_branch AND master_branch both present; A2 (Bitbucket repo:push push.changes[].new.target.hash) deferred to 29-09's end-to-end gate with developer approval because no CF/prod/Bitbucket credentials exist in this environment (probe preserved at scratchpad/probe-a2-bitbucket.mjs; scratch spec moved to scratchpad/ so npm test stays green)
- [Phase 29]: 29-06: the Bitbucket identity projection is event-aware — repository.name + workspace.slug hard-required, pullrequest present-but-optional — with the verification order (projection → credentials → decrypt → HMAC → full parse) byte-identical; repo:push validates only after the verified parse
- [Phase 29]: 29-06: repoPushPayloadSchema joins the union via catchall(z.any()) at the member top level, not z.looseObject — runtime-identical looseness, but the union's unnarrowed property-access inference is preserved (Rule 3)
- [Phase 29]: 29-06: Bitbucket main branch resolves through the adapter's getRepositoryMetadata (mainbranch.name) — the VcsProvider optional method + adapter delegation were added (Rule 3: the plan referenced a client-only method); GitHub reads default_branch ?? master_branch off the payload and warns + ignores when both are absent
- [Phase 29]: 29-06: recordWebhookDelivery deliberately stays BEFORE the supported-event gate (every push delivery is recorded — diagnosability over row count); branch-creation pushes (zero/null before) start a FULL rebuild, never a zero-sha compare
- [Phase 29]: 29-09 UAT: `codeIndexInstanceId`'s stable per-repository id plus Cloudflare's permanent instance-id reservation silently disabled PUSH-triggered incremental refresh on BOTH providers after a repository's first-ever build (bigger scope than the dashboard-only fix 29-08 shipped) — fixed by extracting the lease-claim/create/stale-instance-retry logic into a shared `startIndexBuild()` helper used by all three trigger sites
- [Phase 29]: 29-09 UAT: two real-world configuration gaps, neither a Codra bug, both discovered only by live end-to-end testing: `reach`'s Bitbucket repo had its "Main branch" designation pointed at a leftover scratch branch instead of `main`; CodraApp's GitHub App had never subscribed to the `push` webhook event at the app level (zero deliveries, ever)
- [Phase 29]: 29-09 UAT: Q&A retrieval ranking was weak for natural-language questions — `ts_rank_cd` has no IDF-like signal, so a near-universal reserved word (`function`, `return`) surviving into the OR-joined query could outrank the chunk containing the actually-distinctive identifier. Fixed via a new `CODE_VOCABULARY_STOPWORDS` set (reserved words/literals only, deliberately excluding generic-but-distinctive nouns like `get`/`id`/`data`), pinned with a regression test, and re-verified live in production against the exact repo/file that originally failed
- [Phase 29]: 29-09: Task 3's blocking human-verify checkpoint closed via real production UAT rather than mocks — every sub-check (full build both providers, Q&A retrieval both providers both toggle directions, push-triggered incremental refresh both providers, A2 payload confirmation) verified against the live deployed instance, not `npm test` alone
- [Phase ?]: ANNO-01: report_id = codra-annotations, config key = review.bitbucket.annotations_enabled (confirmed at Task 1 checkpoint)
- [Phase ?]: 30-02: deleteCodeInsightsReport swallows 404-only (not 410) -- Bitbucket's DELETE report endpoint is not documented to also return 410
- [Phase ?]: 30-02: no accumulate-across-rounds mechanism at the client level (D-09) -- only delete-whole-report + plain bulk-POST exist
- [Phase ?]: 30-03: buildDedupIndex widened Set->Map so both submitReview branches (fresh+dedup-matched) populate postedComments with a link (D-11 Pitfall 1 fix)
- [Phase ?]: 30-03: postAnnotations does not catch its own errors -- fail-open is the caller's (Plan 30-04) responsibility
- [Phase ?]: 30-03: external_id includes a fnv1aHash(finding.title) suffix so two findings sharing (path,line,category) with different titles never collide (OpenCode Concern #4)
- [Phase ?]: 30-03: postAnnotations uses a FIFO-per-key join against postedComments, depending on Plan 30-04 passing the SAME finalComments array to both submitReview and postAnnotations
- [Phase ?]: Phase 30 Plan 04: Explicitly typed the existingReview ?? submitReview() 'review' declaration -- TS's union-reduction silently collapses { ref } | { ref; postedComments? } to { ref }, defeating an 'in' guard (would type the property unknown)
- [Phase ?]: Phase 30 Plan 04: no vcs.name === 'bitbucket' check at the postAnnotations call site -- mirrors the existing vcs.labels feature-detect convention exactly
- [Phase 30]: 30 UAT Test 1: Assumption A1 (Bitbucket report-DELETE cascades to child annotations) CONFIRMED live against the connected repo (thomas_michnicki/reach), 2026-07-30. No live encryption key was available locally to decrypt the stored bot credential (local `.env` key ≠ the deployed Worker's `LLM_CONFIG_ENCRYPTION_KEY`, which the developer no longer has), so verification ran via a temporary session-gated debug route deployed to the live Worker (used the already-decrypted credential server-side, returned only status codes/booleans, removed + redeployed immediately after). Result: PUT report → POST annotation → DELETE report → GET report (404) → GET annotations (404). D-09's full-replace design is confirmed safe.
- [Phase 31]: 31-01: listWorkspaceRepositories fails CLOSED on page-cap/later-page/SSRF-guard failure (never a partial array) — A partial repo list would silently hide real repos from the onboarding picker
- [Phase 31]: 31-01: requestRaw preserves request()'s retry/timeout/tracker machinery for a response-supplied absolute next-link, applied to EVERY page not just the first — Closes OpenCode HIGH review finding that the prior absolute-URL-fetch approach lost retry parity
- [Phase 31]: 31-01: alreadyOnboarded computed via a lowercased slug match against repositories.repo — Bitbucket's returned slug casing is not guaranteed lowercase (Antigravity review finding)
- [Phase 31]: 31-02: No secondary index on vcs_workspace_credentials -- every reader filters on (vcs_provider, workspace) together, verified by grep, so the UNIQUE constraint's own index already serves every lookup
- [Phase 31]: 31-02: resolveBitbucketBotCredential short-circuits (per-repo wins, D-03); resolveBitbucketWebhookSecretCandidates always queries both sources via Promise.all -- deliberately different control-flow shapes for different consumers
- [Phase 31]: 31-03: webhook creation kept OUTSIDE queryTransaction (external HTTP call), distinct 502 on post-commit failure (T-31-03-06), never a compensating rollback — D-06 resubmission is safe-by-construction; partial state (credential+repos saved, no webhook) causes zero incorrect review behavior
- [Phase 31]: 31-03: concurrent-request DB race proven safe (row-count + updated_at > created_at via SQL bool_and, not JS Date, to avoid millisecond-precision false-equality); webhook-subscription duplication under the same race is an accepted, documented risk (T-31-03-05)
- [Phase 31]: 31-04: webhook Step 5-7 loops over ALL resolveBitbucketWebhookSecretCandidates results, decrypting+verifying each in turn (catch-and-continue on decrypt failure), stopping at the first HMAC match; zero candidates still returns the byte-identical 'Webhook secret not configured.' 401 (NREG-01)
- [Phase 31]: 31-04: BitbucketAdapter.create's existing null/encryptedAccessToken guard and decryptSecret call needed zero changes to consume resolveBitbucketBotCredential's union return type -- both VcsCredentialSecret and VcsWorkspaceCredentialSecret share encryptedAccessToken
- [Phase 31]: 31-05: Checkbox's Check icon must be a direct sibling of the native input (not nested inside the styled square div) -- Tailwind's peer-checked general-sibling selector only matches true DOM siblings of the peer, not descendants of another sibling
- [Phase 31]: 31-05: selectedRepoSlugs submitted as Array.from(selectedSlugs).sort(), not raw Set insertion order, for a deterministic finalize payload regardless of check order

### Roadmap Evolution

- Phase 12 added (2026-07-20): interactive polish — threaded command/Q&A replies + Bitbucket repo config in dashboard/settings UI (v1.1 Phase-11 UAT follow-ups)
- v1.2 roadmap created (2026-07-21): Phases 13-19 from the approved gap-analysis plan — 29 feature requirements mapped 1:1 to phases, NREG-01/NREG-02 cross-cutting; REQUIREMENTS.md coverage count corrected 26→31 (tally error found during coverage validation)
- Phase 17 expanded from 3 to 4 plans (2026-07-23): Plan 17-04 added for SC4 grep test + capability-flag spec + 17-VERIFICATION.md deployment checkpoints (per `17-VERIFICATION-FINAL.md`). ROADMAP progress table never reflected this addition (undercount 3 → 4).
- Phase 19 expanded from 9 to 10 plans (2026-07-25): Plan 19-10 added as gap-closure — restored FULL_CONTENT_LINE_CAP from 100 to 500 (executor deviation from 19-02), removed dead `processVerifyFixesBatch` placeholder export + `VerifyFixesBatchDeps`/`VerifyFixesBatchResult` types, corrected misleading test header comment. ROADMAP progress table never reflected this addition (undercount 9 → 10).
- Phase 20 added (2026-07-24): v1.2 closure: audit-trail viewer parity + AUD-01 sign-offs + visual backstops
- Phase 20.1 inserted after Phase 20 (2026-07-24): Close gap: BLOCKERs 1-5 + WARNING 1 — successor routing + privacy redaction (URGENT). Phase 20.1 expanded from 5 to 8 plans during execution (added 20.1-06 visual backstop build helper, 20.1-07 redaction wiring, 20.1-08 configured fail-open preservation). ROADMAP progress table never reflected this addition (undercount 5 → 8).
- v1.2 archived (2026-07-25): 9 phases, 49 plans, 31/31 requirements satisfied; audit passed after Phase 20.1 and AUD-01 was signed.

### Roadmap Evolution

- Phase 32 added (2026-07-31): Address v1.4 tech debt — audit viewer renderer (W-1), misleading middleware comment (W-2), hardcoded type unions, test-hygiene improvements, integration test gap (nextPhaseAfterCrossFileSecurity selector), and stale planning docs. From v1.4 milestone audit.
- Phase 30 complete (2026-07-30): 4/4 plans; ANNO-01 satisfied. UAT Test 1 (Assumption A1 — Bitbucket report-DELETE cascade) confirmed live against the connected repo via a temporary session-gated debug route (removed after use, two clean deploys) since the deployed Worker's encryption key is no longer known locally. Security review (`/gsd-secure-phase 30`): 17 threats registered across the 4 plans' threat models (register authored at plan time, ASVS L1), all closed — 12 by verified in-code/in-test mitigation, 5 by documented accepted risk (see 30-SECURITY.md).
- Phase 29 complete (2026-07-30): 9/9 plans; QA-IDX-01 satisfied. Task 3's blocking human-verify checkpoint (29-09) closed via a real same-day production UAT session (deploy + real GitHub + real Bitbucket repositories) rather than mocks: full index build, push-triggered incremental refresh, and Q&A retrieval (both toggle directions) all confirmed on BOTH providers. 11 real bugs/gaps found and fixed along the way, including two that were pre-existing misconfigurations outside Codra's code (a Bitbucket repo's main-branch designation; a GitHub App's missing push-event subscription) and one cross-provider Q&A ranking-quality issue (fixed with a pinned regression test). Developer sign-off: "approved". See `.planning/phases/29-qa-idx-01-codebase-index-backed-q-a/29-09-SUMMARY.md`.
- Phase 28 complete (2026-07-27): 4/4 plans; UAT 6/6; verification `passed` (29/29 must-haves). Tests 1/3/4/6 were closed by automation rather than manual observation at the user's request — 3 new/extended specs (27 tests), all mutation-verified. One leg is deliberately recorded as un-run, not verified: live end-to-end suppression on a real GitHub PR.
- Phase 26 complete (landed 2026-07-26, closed out 2026-07-29): 2/2 plans; verification `passed` (10/10 must-haves, EVID-02 satisfied). Safe-resume closeout — executors never wrote SUMMARY.md files, so ROADMAP/REQUIREMENTS tracking stayed stale until the summaries were authored retroactively from commits 6c4256b..a891d02 + 26-VERIFICATION.md; no code re-executed. Includes post-plan deviation fix a891d02 (migration 015 persists existing_code for immutable finalize re-checks).
- Phase 21 added (2026-07-25): Evidence-missing aggregate summary event (schema + audit writer) — v1.3
- Phase 21 complete (2026-07-25): Both plans (21-01 builder + 21-02 producer/coalescing/tests) executed; EVID-03 requirement satisfied; producer emits single aggregate evidence_missing_summary per (file, pass); multi-chunk coalescing resolves Codex HIGH REVIEWS finding
- Phase 22 added (2026-07-25): WR-02 original-line capture in summary sample — v1.3
- Phase 23 added (2026-07-25): IN-01 modelLineCap persistence at submit time — v1.3
- Phase 24 added (2026-07-25): Dashboard surface for new audit events — v1.3
- Phase 25 added (2026-07-25): Milestone closeout (audit, verification, sign-off) — v1.3
- Phase 12 added (2026-07-20): interactive polish — threaded command/Q&A replies + Bitbucket repo config in dashboard/settings UI (v1.1 Phase-11 UAT follow-ups)
- v1.2 roadmap created (2026-07-21): Phases 13-19 from the approved gap-analysis plan — 29 feature requirements mapped 1:1 to phases, NREG-01/NREG-02 cross-cutting; REQUIREMENTS.md coverage count corrected 26→31 (tally error found during coverage validation)
- Phase 20 added: v1.2 closure: audit-trail viewer parity + AUD-01 sign-offs + visual backstops
- Phase 20.1 inserted after Phase 20: Close gap: BLOCKERs 1-5 + WARNING 1 — successor routing + privacy redaction (URGENT)

### Pending Todos

(none — WR-01 resolved by v1.3 Phases 21-23, marked completed 2026-07-31)

### Blockers/Concerns

- [Env] `npm run test:browser` requires `nix-shell shell.nix --run "..."` on this NixOS host (missing libgbm.so.1 for headless Chromium) — pre-existing environment quirk, not a code issue. Carried forward.
- [Env] Test DB accumulates rows — review-flow check-run tests flake once terminal jobs exceed LIMIT 500; fix with `TRUNCATE jobs CASCADE`, not a code change. Pre-flight for v1.2 closure audit re-run (test/severity-audit-integration.spec.ts case 6 and BLOCKER-1/5 test groups required clean DB state).
- [Bookkeeping] Phase 26 (EVID-02) has 2 PLAN files and ZERO SUMMARY files, yet the code ships and `test/review-flow.spec.ts` "evidence hard-drop" passes — its ROADMAP plan boxes are still `[ ]` and it reads as `0/2 plans complete`. Phase 28 depended on it and is now closed, so the roadmap understates real progress. Needs reconciling before milestone close (surfaced during Phase 28 verification, 2026-07-27; not touched then, since inventing summaries after the fact would be worse than the gap).
- [Bookkeeping] STATE `progress:` counters (total_phases 10 / completed_phases 6 / total_plans 12 / completed_plans 10) disagree with `progress.bar` (12/14 plans) and with v1.4's actual scope (phases 26-31 = 6 phases, 2 complete). Left as-is at the 28→29 transition rather than guessed at — the intended counting scope is ambiguous. See MEMORY.md "milestone-complete CLI undercounts".
- [Audit] v1.2 milestone audit re-run on 2026-07-25 promoted status from `gaps_found` to `passed`; AUD-01 human acknowledgment signed (Thomas Michnicki, 2026-07-25); 13-UAT.md carries authentic signature/date pair. MILESTONES.md v1.2 shipped entry repaired after the CLI undercounted decimal Phase 20.1.
- [Env] The `LLM_CONFIG_ENCRYPTION_KEY` set on the deployed Worker (`codra.tmichnicki.workers.dev`, via `wrangler secret put`) is no longer known locally — it differs from the value in local `.env` (dev-only) and cannot be retrieved from Cloudflare once set. Any future task needing to decrypt a stored secret (VCS credentials, LLM API keys) from OUTSIDE the Worker will hit the same wall; the workaround used for the Phase 30 UAT (a temporary session-gated debug route run server-side, then removed) is the reusable pattern.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260720-p12 | Repo-settings UI for interactive (bot commands & PR Q&A) config — single-Apply Edit modal; verified via Playwright + prod-DB persistence | 2026-07-20 | 2c29b86 | [260720-p12-add-a-repo-settings-ui-panel-for-the-int](./quick/260720-p12-add-a-repo-settings-ui-panel-for-the-int/) |
| 260720-rah | Fix bot mention: classifyComment accepts @BOT_USERNAME so real bot handle triggers commands out-of-box (default mention_trigger @codra-app ≠ deployed @codraapp); verified live — reject_feedback captured on PR #8 | 2026-07-20 | e512ce2 | [260720-rah-fix-bot-mention-commands-classifycomment](./quick/260720-rah-fix-bot-mention-commands-classifycomment/) |
| 260720-sjn | Config-based Bitbucket bot identity (bitbucket_bot_account_id) + getBotIdentity graceful-degrade on GET /user 403; fixes Bitbucket command dispatch with repo access tokens | 2026-07-20 | 168e74e | [260720-sjn-config-based-bitbucket-bot-identity-add-](./quick/260720-sjn-config-based-bitbucket-bot-identity-add-/) |
| 260720-tcx | Address PR #8 findings: fix CodeQL js/incomplete-sanitization #3/#4 in formatMarkdownTableCell (escape backslash first, T-09-11) + remove commentContext non-null assertion; ~18 other automated findings verified as false positives (out of scope) | 2026-07-20 | d8a8879 | [260720-tcx-fix-codeql-incomplete-sanitization-in-fo](./quick/260720-tcx-fix-codeql-incomplete-sanitization-in-fo/) |
| 260721-ck9 | /settings version now derived from the latest git tag at build time (vite `__APP_VERSION__` via `git describe --tags`, leading `v` stripped, fallback to package.json) instead of the stale hardcoded 0.9.4 | 2026-07-21 | 964e738 | [260721-ck9-dashboard-settings-version-reflects-late](./quick/260721-ck9-dashboard-settings-version-reflects-late/) |
| 260721-dvh | Fix PR #9 CI browser-test failures (run 29812072387): add static `__APP_VERSION__` define to vitest.config.ts + update stale 3-arg `updateRepoConfig` assertion in repos.spec.tsx to the real 4-arg call (`vcsProvider`); full browser suite 62/62 green | 2026-07-21 | 0e6e4ae | [260721-dvh-fix-ci-browser-test-failures-add-app-ver](./quick/260721-dvh-fix-ci-browser-test-failures-add-app-ver/) |
| 260721-dvh (fast) | Bump GitHub Actions to Node 24 runtimes: checkout v7.0.1, setup-node v7.0.0, cache v6.1.0 (SHA-pinned), codeql-action v4.37.1; all SHAs verified node24 via GitHub API | 2026-07-21 | b061c80 | _(gsd-fast — no task dir)_ |
| 260727-hvc | Fix G-28-4: `learned_rule_suppressed` now renders in its own audit-trail group (dropped the collapse into `evidence_missing`, added the `DecisionEvent` case) so suppressions are visible and no longer inflate the "Evidence missing" badge; discriminating node + browser assertions added | 2026-07-27 | c94aeb6 | [260727-hvc-fix-g-28-4-render-learned-rule-suppresse](./quick/260727-hvc-fix-g-28-4-render-learned-rule-suppresse/) |

## Deferred Items

Items acknowledged and carried forward:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| debug | knowledge-base | Acknowledged at v1.1 close, re-confirmed at v1.2 close — NOT an open investigation; this is the GSD Debug Knowledge Base index file (audit heuristic flags any `.planning/debug/*.md` lacking `resolved` frontmatter). The only real session entry (bitbucket-review-incomplete, 2026-07-14) is the resolved session whose frontmatter summary lives in the index. Benign false-positive — same audit-flagged pattern carried from v1.1 closure with no new debug sessions during v1.2. | v1.2 close, 2026-07-25 |
| UAT | audit-viewer long-text (E6) | Audit-open false-positive (16-UAT.md test 3) — recorded as `result: pass / source: human-approved proxy evidence` on 2026-07-25 because no live audit-bearing job was available at UAT time. Browser suite renders the audit viewer grouped by stage with sample paths; `audit-trail-viewer.tsx` applies `font-mono break-all` at every long-path surface (lines 52/66/346); same wrapping idiom independently proven live in Test 1 (E1/E2) in both light and dark. The PASS is durable; future UAT with an audit-bearing job would close via direct observation but proxy evidence was the best available. | v1.2 close, 2026-07-25 |
| UAT | visual mechanism backstop (Phase 20 visual backstops) | Audit-open false-positive (20-UAT.md test path / 20-02-SUMMARY.md) — visual backstop browser spec passed 8/8 under Nix/Chromium on 2026-07-24; the "structure ready" wording on `.planning/milestones/v1.2-ROADMAP.md` was honest-by-design because the human signature gate (13-UAT.md) was still pending. Now SIGNED on 2026-07-25 (Thomas Michnicki); the visual backstop is durable. | v1.2 close, 2026-07-25 |
| v2 evidence | EVID-02: hard-drop hallucinated `existingCode` evidence (promote EVID-01 after telemetry) | Deferred to v2 at v1.2 requirements | v1.2 requirements, 2026-07-21 |
| v2 evidence | WR-01 / WR01: bound per-unit `evidence_missing` ring-buffer flood (additive aggregate `evidence_missing` shape with bounded count, mirroring `file_skipped` pattern) | Deferred to v2 — tracked at `.planning/todos/pending/wr01-evidence-missing-ring-buffer-bound.md` from Phase 15 code review; carries into v2 with EVID-02 work (per-unit bound requires a schema/design decision, not a mechanical hotfix) | v1.2 close, 2026-07-25 |
| v2 review-quality | SEC-XDIFF-01: whole-diff cross-file security reasoning (REV-05) | Deferred to v2 (land after per-file security proves out) | v1.1 requirements, 2026-07-19 |
| v2 review-quality | LRN-01: learned-rule synthesis from `reject` feedback + approval queue | Deferred to v2 (CMD-05 captures the input signal only) | v1.1 requirements, 2026-07-19 |
| v2 review-quality | QA-IDX-01: codebase-index-backed Q&A | Deferred to v2 (whole indexing subsystem) | v1.1 requirements, 2026-07-19 |
| v2 Differentiator | ANNO-01: Per-line Code Insights annotations | Deferred to v2 (not v1.1/v1.2) | v1.0 close, 2026-07-12 |
| v2 Differentiator | WS-01: Workspace-level token/webhook | Deferred to v2 (not v1.1/v1.2) | v1.0 close, 2026-07-12 |

## Session Continuity

Last session: 2026-07-31T08:13:09.849Z
Stopped at: Phase 32 context gathered
Resume file: .planning/phases/32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd/32-CONTEXT.md

## Operator Next Steps

- Phase 29 (QA-IDX-01) and Phase 30 (ANNO-01) are both complete — no further action needed on either.
- Phase 31 (WS-01, workspace-level token/webhook) is not planned yet (`Plans: TBD` in ROADMAP.md) — the only remaining v1.4 phase. Start with `/gsd-plan-phase 31`.
- Two pre-existing bookkeeping items remain unrelated to Phase 30 (see Blockers/Concerns): LRN-01/Phase 28's stale `Planned` traceability status, and the ambiguous STATE `progress:` counter scope — both flagged for reconciliation before v1.4's milestone close, not touched here to avoid guessing at their intended semantics.
- [Env] If a future task needs to decrypt a stored secret from outside the deployed Worker, the local `.env`'s `LLM_CONFIG_ENCRYPTION_KEY` will NOT match — see Blockers/Concerns.
