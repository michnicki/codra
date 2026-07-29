---
phase: 29-qa-idx-01-codebase-index-backed-q-a
plan: 09
subsystem: dashboard
tags: [react, panel, code-index, browser-spec, checkpoint, ui-waived]

# Dependency graph
requires:
  - phase: 29-qa-idx-01-codebase-index-backed-q-a
    provides: "29-08's POST /code-index/build + GET /code-index/status endpoints and their camelCase wire shapes, 29-02's review.interactive.qa.index config block, 28's learned-rules panel as the structural authority (UI-SPEC waived via --skip-ui)"
provides:
  - "CodeIndexPanel: the operator surface for QA-IDX-01 — three branch states, build action, mode freshness line, Bitbucket push-subscription hint, partial-index and failure indications"
  - "api.buildCodeIndex / api.getCodeIndexStatus typed client calls (no hand-set CSRF header)"
  - "The add-Bitbucket webhook instruction to include the repository push event"
  - "test/browser/code-index-panel.spec.tsx: 8 rendered-state cases"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Index status is SERVER state, not config state — the panel owns a status read and polls only while a build is live (delay: number|null on the shared polling idiom), rather than deriving display from the config draft"
    - "A toggle that lives inside review.interactive.qa.index merges through the interactive patch path and is overlaid LAST, because the InteractivePanel's draft spreads qa from the repo prop and would otherwise clobber a later index edit (same stale-draft class as REVIEW #4)"

key-files:
  created:
    - src/client/components/features/repos/code-index-panel.tsx
    - test/browser/code-index-panel.spec.tsx
  modified:
    - src/client/lib/api.ts
    - src/client/pages/repos.tsx
    - src/client/pages/repos/add-bitbucket.tsx
    - src/client/hooks/use-polling.ts

key-decisions:
  - "29-09: the panel fetches status itself and polls (5s) only while status is 'building' or a build press is in flight — a null delay stops the interval but keeps the mount-time read, which is exactly the use-polling runtime behavior that its type previously failed to admit"
  - "29-09: the index toggle draft merges through mergeReviewPatch's interactive argument (its real config path), overlaid last so it wins over an InteractivePanel draft composed from the stale repo prop"
  - "29-09: coalesced build presses are toasted as informational ('already running'), never as errors — 29-08 defined coalesced: true as a benign double-click/handoff signal (T-29-09-05)"
  - "29-09: the Bitbucket hint keys on mode === 'full' alone — the only observable signature of a hand-created webhook subscription that never gained the push event; absent for GitHub and absent once mode reaches 'incremental' (proof the subscription works)"

requirements-completed: [QA-IDX-01]

coverage:
  - id: D1
    description: "Toggle off renders the disabled card and no build control; enabled-never-built renders the never-built card plus an enabled build action; built renders short commit, last-built time, counts, status"
    requirement: QA-IDX-01
    verification:
      - kind: browser
        ref: "test/browser/code-index-panel.spec.tsx#toggle off / toggle on with no index / built status"
        status: pass
    human_judgment: false
  - id: D2
    description: "Build press posts exactly once, control enters pending affordance, status is refetched from the server rather than optimistically mutated"
    requirement: QA-IDX-01
    verification:
      - kind: browser
        ref: "test/browser/code-index-panel.spec.tsx#pressing build issues exactly one post"
        status: pass
    human_judgment: false
  - id: D3
    description: "Truncated flag renders the honest partial-index copy (partial coverage, provider-chosen omission, rebuild truncates identically); recorded failure renders unmodified"
    requirement: QA-IDX-01
    verification:
      - kind: browser
        ref: "test/browser/code-index-panel.spec.tsx#truncated status / failed status"
        status: pass
    human_judgment: false
  - id: D4
    description: "mode full/incremental/null render three distinct freshness strings; Bitbucket hint shows at mode full on Bitbucket only, with both negative renders asserted"
    requirement: QA-IDX-01
    verification:
      - kind: browser
        ref: "test/browser/code-index-panel.spec.tsx#distinct freshness string / Bitbucket push-subscription hint"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full gates: typecheck clean; browser suite 19 files / 128 tests green under nix shell; npm test 132 files / 1912 tests green; ci.yml confirmed to already install Chromium --with-deps and run test:browser (no edit)"
    requirement: QA-IDX-01
    verification:
      - kind: command
        ref: "npm run typecheck — exit 0"
        status: pass
      - kind: command
        ref: "nix-shell shell.nix --run npm run test:browser — 19 files / 128 tests pass"
        status: pass
      - kind: command
        ref: "npm test (TEST_DATABASE_URL -> :5455) — 132 files / 1912 tests pass"
        status: pass
    human_judgment: false
  - id: D6
    description: "Task 3 blocking human gate: real deploy, real build + retrieval-backed answer + incremental refresh on BOTH providers, five flagged observations (A1 re-confirm, A2 payload shape, A3/A4 Bitbucket tree-walk max_depth/555, build cost vs ~12 files/min, real index size in Postgres), plus the only visual review of the un-spec'd panel"
    requirement: QA-IDX-01
    verification:
      - kind: human
        ref: "29-09 Task 3 checkpoint — PENDING (returned to orchestrator)"
        status: pending
    human_judgment: true

# Metrics
duration: 15min
completed: 2026-07-29
status: checkpoint-pending
---

# Phase 29 Plan 09: Dashboard code-index panel and the end-to-end human gate Summary

**QA-IDX-01 now has its operator surface: a Codebase Index panel in the repository config modal that renders the three real states (disabled / never-built / built), posts one build and refetches status from the server, tells the operator what produced the index and when it is partial or failed, and — for a Bitbucket repository whose freshness path has never fired — says exactly which webhook event is missing; the only remaining task is the blocking human verification of the whole feature on real repositories.**

## Status: Tasks 1–2 complete, Task 3 returned as a blocking checkpoint

This plan is `autonomous: false` and its Task 3 is `checkpoint:human-verify` with `gate="blocking"`. Tasks 1 and 2 are executed, verified and committed below. Task 3 requires `npm run deploy` plus real GitHub and Bitbucket repositories and is **not** marked complete — the checkpoint structure was returned to the orchestrator for the developer. STATE/ROADMAP plan-completion marking is deliberately left to the orchestrator's checkpoint continuation, since the plan completes only after the human verifies.

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-29T09:42:34Z
- **Completed (Tasks 1–2):** 2026-07-29T09:57:19Z
- **Tasks:** 2 of 3 executed (Task 3 = human gate)
- **Files modified:** 5 (2 created, 3 modified)
- **Suites:** node **132 files / 1912 tests pass**; browser **19 files / 128 tests pass** (from 18 / 120: +1 file, +8 tests, exactly this plan's spec); `tsc --noEmit` clean

## Accomplishments

- **The panel treats index status as server state, which is the one structural divergence from its sibling.** `learned-rules-panel.tsx` renders config; this panel renders `code_index_state`. It fetches `getCodeIndexStatus` at mount, polls on a 5-second interval only while a build is live, and after every build press refetches from the server rather than mutating local state — the stale-view hazard the sibling's refresh callback exists to avoid. The shared `usePolling` hook already handled a `null` delay at runtime (stop the interval, keep the mount read); its type simply didn't admit it, so the signature was widened rather than the idiom re-invented.

- **Every honesty requirement is a rendered, asserted string.** The truncated state says coverage is partial, that the provider's tree listing chose the omitted part, and that rebuilding truncates identically (the remedy is a smaller scope). The failure state renders `lastError` byte-identically — it was redacted at the single server write site, and the panel adds no enrichment (T-29-09-02). The `mode` line distinguishes dashboard rebuild / push refresh / never built, which is the answer to "the index looks old" that a capped `indexed_at` alone cannot give.

- **The Bitbucket hint fires only on a real condition.** `mode === 'full'` on a Bitbucket repository is the *only* observable signature of a hand-created webhook subscription that never gained the push event — there is no error anywhere else. The spec asserts the positive render and both negatives (GitHub at `full`, Bitbucket at `incremental`), because a hint that always shows is as wrong as one that never does. The same requirement is written where the operator will read it first: the add-Bitbucket page now lists the push event among the webhook triggers and states that an existing subscription must be edited.

- **The toggle is a dirty-tracked config edit through the correct merge path.** `review.interactive.qa.index` lives inside the `interactive` object, so the draft merges through `mergeReviewPatch`'s interactive argument — and it is overlaid *last*, because the InteractivePanel's reported draft spreads `qa` from the repo prop and would otherwise silently restore the pre-edit index block on every Apply (the same stale-draft clobber class as REVIEW #4, this time prevented at the merge site rather than discovered in review).

- **No header is set by hand anywhere.** Both client calls go through the shared `request` helper, which attaches `x-requested-with` to every non-safe method; the browser spec asserts the exact call signature, and 29-08's server-side CSRF case already proves the route rejects a headerless POST (T-29-09-01).

## Task Commits

1. **Task 1: typed client calls + panel component** — `fbd0ab6` (feat)
2. **Task 2: mount, Bitbucket instruction, browser spec** — `5dca68d` (feat)

## Files Created/Modified

- `src/client/lib/api.ts` — `buildCodeIndex` / `getCodeIndexStatus` mirroring `synthesizeLearnedRules` (`pathSegment` on every segment, optional `?provider=`, shared `request` helper); exported `CodeIndexStatus` / `CodeIndexStatusResponse` / `CodeIndexBuildResponse` wire types.
- `src/client/components/features/repos/code-index-panel.tsx` — new. `CodeIndexPanel` with the props/state/interaction shape of the learned-rules sibling, the three branch states, build action with spinner swap, `aria-busy` root, accessible labels on both controls, mode freshness line, Bitbucket hint, truncated indication, failure alert.
- `src/client/pages/repos.tsx` — panel mounted after `LearnedRulesPanel` in the config modal; `indexDraft` state wired into the existing dirty tracking and the Apply merge; `onRefreshed` re-reads config from the server (C7 pattern). No other panel's mount or the page's dirty-tracking changed.
- `src/client/pages/repos/add-bitbucket.tsx` — webhook instructions now include the repository push event and the edit-an-existing-subscription sentence; existing instructions and their order intact.
- `src/client/hooks/use-polling.ts` — `delay` widened to `number | null` (see deviation 1).
- `test/browser/code-index-panel.spec.tsx` — new. 8 cases covering the plan's eight browser bullets, including the single-post assertion and both hint negatives; header records that the Chromium constraint is local-only because CI installs with `--with-deps`.

## Decisions Made

- **Polling cadence 5s while building.** The sibling panels use the hook's 10s default for config reads; a build's `building → ready` transition is the one thing the operator is watching for, so the panel polls at 5s and only during a live build. No constant was extracted — the value is local to one call site and not a tuned budget figure.
- **`coalesced: true` is toasted as info, not success or error.** 29-08 defined it as the benign double-click/handoff signal; presenting it as an error would contradict the server's own semantics (T-29-09-05 accepted risk).
- **The status vocabulary maps to four display labels** (`ready → Ready`, `building → Building`, `failed → Build failed`, `idle → Idle`) in the built-state card; `idle` is unreachable there (no `indexedSha`) but the mapping is total so a future state never renders blank.
- **`.github/workflows/ci.yml` was read, not edited** (acceptance criterion): its `verify` job installs Playwright Chromium with `--with-deps` and runs `npm run test:browser`, so the new spec is picked up by CI as-is; the nix-shell requirement is local-only and is recorded in the spec header.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `usePolling`'s type rejected the null delay its runtime already implements**

- **Found during:** Task 1, wiring status polling.
- **Issue:** The plan requires polling *while* a build is in progress and none otherwise. The hook's body already implements exactly that (`if (delay === null) return;` after the initial call), but its signature typed `delay` as `number`, so the only correct call (`buildInProgress ? 5_000 : null`) failed `tsc`. Alternatives — a giant delay, a second hook, or conditional hook calls (illegal) — would all have been worse code to satisfy a stale annotation.
- **Fix:** widened the signature to `delay: number | null = 10_000`. One line; no runtime change; no other call site affected (both existing callers pass numbers).
- **Files modified:** `src/client/hooks/use-polling.ts`
- **Verification:** `npm run typecheck` exit 0; full node suite 132/1912 and browser suite 19/128 green.
- **Committed in:** `fbd0ab6`

---

**Total deviations:** 1 auto-fixed (blocking). No Rule 4 architectural decisions, no package installs (T-29-09-SC holds), and the changed-file set is the plan's `files_modified` plus the one-line hook widening.

## Issues Encountered

- **None blocking.** The two known liveness questions carried from 29-08 (the static per-repository Workflow instance id possibly permitting only one build per repository ever, and fresh-instance handoff coalescing) are *not* observable by any test and are part of what Task 3's numbered steps exist to answer — the rebuild-twice check is step 6 of the human gate. They remain logged in `deferred-items.md`.
- **The React `act(...)` warning appears once in the full browser suite output.** It is a warning, not a failure (128/128 pass), and originates from the panel's status refetch resolving after an assertion — the same shape the learned-rules spec already produces. Not a regression; left as-is rather than wrapping production polling in test-only act choreography.

## Known Stubs

None. Every rendered value flows from the live status endpoint response (stubbed only in tests, via the module mock the repo's browser specs always use).

## User Setup Required (the Task 3 checkpoint)

The full numbered verification is in the plan's Task 3. In brief: run the three automated gates; `npm run deploy` (first deploy that provisions the `codra-index-workflow` — confirm the second Workflow exists); then on a **GitHub** repository enable the toggle, build, watch building → ready with counts, ask a Q&A question whose answer lives outside the diff, toggle off and confirm the answer no longer reaches outside the diff, merge to the default branch and confirm the indexed commit advances with the mode line flipping to push refresh. Repeat build/Q&A/refresh on a **Bitbucket** repository, where the panel should first show the push-subscription hint, then — after the operator edits the real Bitbucket webhook subscription to add the repository push event — the incremental refresh fires and the hint disappears. While the Bitbucket build runs, watch the Worker logs for the `/src` tree walk (page count, page-cap truncation, any HTTP 555 retry at smaller depth).

**Report back on the five flagged observations:** (1) GitHub push delivery carried a default-branch field (re-confirming A1 in the deployed app); (2) Bitbucket push payload parsed without a schema error (A2, deferred from 29-06 — probe preserved at `scratchpad/probe-a2-bitbucket.mjs`); (3) the Bitbucket tree-walk observations (A3 `max_depth`, A4 HTTP 555); (4) real build cost against the planned ~12 files/minute; (5) actual index size in Postgres (projected ~20–30 MB for 500 files). Also report anything that reads wrong on the panel itself — the UI design contract was waived for this phase (`--skip-ui`), so the human gate is its only visual review. **Also do the rebuild-twice check** from `deferred-items.md`: after a first successful build, press Build again and confirm a *second* Workflow instance appears.

**Resume signal:** type "approved" or describe what did not behave as stated.

## Self-Check: PASSED

- `src/client/components/features/repos/code-index-panel.tsx` — FOUND, created
- `test/browser/code-index-panel.spec.tsx` — FOUND, created
- `src/client/lib/api.ts`, `src/client/pages/repos.tsx`, `src/client/pages/repos/add-bitbucket.tsx`, `src/client/hooks/use-polling.ts` — FOUND, modified
- Commits `fbd0ab6`, `5dca68d` — both resolve in `git log`
- `git diff --name-only fbd0ab6^..5dca68d` returns exactly the six files above; zero deletions; none of the pre-existing unrelated working-tree modifications staged
- `npm run typecheck` exits 0
- `npm test` (with `TEST_DATABASE_URL` pointed at the live :5455 container): **132 files / 1912 tests passing**
- `npm run test:browser` under `nix-shell shell.nix`: **19 files / 128 tests passing**, including all 8 new cases — not a 127, not skipped
- `.github/workflows/ci.yml` unmodified (verified by `git diff` and by reading lines 65–90)

---
*Phase: 29-qa-idx-01-codebase-index-backed-q-a*
*Completed (Tasks 1–2): 2026-07-29 — Task 3 pending the blocking human gate*
