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
    - src/server/core/code-index-build.ts
    - src/server/db/code-index.ts
    - src/server/routes/api/repos.ts
    - src/server/core/token-tracker.ts
    - test/code-index-api.spec.ts

key-decisions:
  - "29-09: the panel fetches status itself and polls (5s) only while status is 'building' or a build press is in flight — a null delay stops the interval but keeps the mount-time read, which is exactly the use-polling runtime behavior that its type previously failed to admit"
  - "29-09: the index toggle draft merges through mergeReviewPatch's interactive argument (its real config path), overlaid last so it wins over an InteractivePanel draft composed from the stale repo prop"
  - "29-09: coalesced build presses are toasted as informational ('already running'), never as errors — 29-08 defined coalesced: true as a benign double-click/handoff signal (T-29-09-05)"
  - "29-09: the Bitbucket hint keys on mode === 'full' alone — the only observable signature of a hand-created webhook subscription that never gained the push event; absent for GitHub and absent once mode reaches 'incremental' (proof the subscription works)"
  - "29-09 Task 3 UAT: six real bugs found and fixed against a live deploy (see Deviations) — a stuck build on the deployed opencodra repository (frozen at status: building with no working instance) is what surfaced the first three; the remaining three surfaced only once opencodra's real build was pushed all the way to completion and reach's Bitbucket build was attempted"

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
        ref: "29-09 Task 3 UAT session, 2026-07-29: real deploy + real build on both providers"
        status: pass
      - kind: human
        ref: "Panel visual review (both providers) — reads cleanly, matches learned-rules-panel styling"
        status: pass
      - kind: human
        ref: "Rebuild-twice check — pressing build after a completed build creates a genuine second Workflow instance"
        status: pass
      - kind: human
        ref: "Fresh-instance handoff at MAX_INDEX_CONTINUATIONS — confirmed on reach (Bitbucket)"
        status: pass
      - kind: human
        ref: "Build cost vs ~12 files/min estimate — observed ~8-10 files/min per continuation, same order of magnitude"
        status: pass
      - kind: human
        ref: "Real index size in Postgres — 15 MB combined code_index_chunks for both repos (383+344 files, 1909+1546 chunks), well under the ~20-30 MB/500-files projection"
        status: pass
      - kind: human
        ref: "GitHub retrieval-backed Q&A, positive case — asked '@codraapp what machine-readable reason string does redactErrorMessage return for an HTTP 503 error, and which file defines that function?' on PR michnicki/opencodra#13 with the index enabled; bot answered correctly ('provider_5xx', src/server/core/audit-redact.ts) citing a file entirely outside the PR's diff"
        status: pass
      - kind: human
        ref: "GitHub retrieval-backed Q&A, negative case — toggled the index off, re-asked the identical question; bot correctly refused, citing only the diff ('The PR diff does not include the source code for redactErrorMessage...'). Index re-enabled afterward, index state unaffected by the toggle"
        status: pass
      - kind: human
        ref: "GitHub post-merge incremental refresh (mode flips from dashboard-rebuild to push-refresh wording) — NOT YET DONE, needs a real merge to main"
        status: pending
      - kind: human
        ref: "Bitbucket retrieval-backed Q&A, webhook push-event edit, and post-edit incremental refresh — NOT YET DONE, needs a real Bitbucket PR/question and a real webhook subscription edit"
        status: pending
      - kind: human
        ref: "A2 (real Bitbucket repo:push payload shape) — still unconfirmed; needs one real push delivery"
        status: pending
    human_judgment: true

# Metrics
duration: 15min (Tasks 1-2) + ~3h (Task 3 UAT session, 2026-07-29)
completed: 2026-07-29
status: checkpoint-pending
---

# Phase 29 Plan 09: Dashboard code-index panel and the end-to-end human gate Summary

**QA-IDX-01 now has its operator surface: a Codebase Index panel in the repository config modal that renders the three real states (disabled / never-built / built), posts one build and refetches status from the server, tells the operator what produced the index and when it is partial or failed, and — for a Bitbucket repository whose freshness path has never fired — says exactly which webhook event is missing. Tasks 1-2 shipped the panel; a same-day Task 3 UAT session deployed it, found and fixed six real production bugs (see below), confirmed a full build completes end to end on both GitHub and Bitbucket, and confirmed the retrieval-backed Q&A itself answers correctly from outside the diff when the index is enabled and correctly refuses to when it is disabled. Two items remain before Task 3 can be marked fully verified: GitHub's post-merge incremental-refresh test, and the full Bitbucket-side set (Q&A, webhook edit, incremental refresh, A2) — all requiring GitHub/Bitbucket write actions the assistant either cannot perform (Bitbucket, no login) or hasn't yet been asked to (the GitHub merge).**

## Status: Tasks 1–2 complete; Task 3 substantially verified via a real UAT session, two items still open

This plan is `autonomous: false` and its Task 3 is `checkpoint:human-verify` with `gate="blocking"`. Tasks 1 and 2 are executed, verified and committed below.

**Task 3 UAT session (2026-07-29, same day as Tasks 1-2):** the developer deployed to the live instance (`codra.tmichnicki.workers.dev`) and worked through Task 3's checklist with the assistant driving verification via Playwright MCP and Cloudflare/wrangler CLI access. The `opencodra` (GitHub) build was found already stuck at `status: building` from an earlier attempt; investigating why led to six real bugs being found and fixed (see Deviations), after which **both** `opencodra` and `reach` (Bitbucket) completed a real, full build end to end. Once the developer authenticated the assistant's browser session on GitHub.com, the assistant posted the in-PR Q&A test itself on `michnicki/opencodra#13` (both the positive and negative case — see "Retrieval-backed Q&A" above) and confirmed it works correctly. See the coverage table above (id D6) for exactly which of Task 3's sub-checks are now `pass` vs. still `pending`.

**Not yet done, and not something the assistant can do unassisted:** the post-merge incremental-refresh test on GitHub (needs an actual merge to `main`, not yet requested), and the equivalent Q&A/webhook-edit/incremental-refresh/A2 set on Bitbucket (the assistant has no Bitbucket.org login). STATE/ROADMAP plan-completion marking remains deliberately deferred until these close.

## Performance

- **Duration:** ~15 min (Tasks 1-2) + ~3 hours (Task 3 UAT session: investigation, six fixes, three deploys, two full real builds)
- **Started:** 2026-07-29T09:42:34Z
- **Completed (Tasks 1–2):** 2026-07-29T09:57:19Z
- **Task 3 UAT session:** 2026-07-29, afternoon/evening (real deploys at commits `04bd5de`, `b075e1f`+`ac49cde`, `c89b46d`, `922578e`, `86b54d1`)
- **Tasks:** 2 of 3 executed (Task 3 = human gate, partially verified)
- **Files modified (Tasks 1-2):** 5 (2 created, 3 modified)
- **Files modified (Task 3 UAT fixes):** 5 (`code-index-build.ts`, `code-index.ts`, `repos.ts`, `token-tracker.ts`, `code-index-api.spec.ts`)
- **Suites:** node **132 files / 1912 tests pass**; browser **19 files / 128 tests pass** (from 18 / 120: +1 file, +8 tests, exactly this plan's spec); `tsc --noEmit` clean — all reconfirmed after the Task 3 UAT fixes
- **Real builds completed:** `michnicki/opencodra` (GitHub) — 379 files, 1909 chunks; `thomas_michnicki/reach` (Bitbucket) — 285 files, 1546 chunks. Combined `code_index_chunks` table size in production: 15 MB (well under the ~20-30 MB/500-files projection)

## Accomplishments

- **The panel treats index status as server state, which is the one structural divergence from its sibling.** `learned-rules-panel.tsx` renders config; this panel renders `code_index_state`. It fetches `getCodeIndexStatus` at mount, polls on a 5-second interval only while a build is live, and after every build press refetches from the server rather than mutating local state — the stale-view hazard the sibling's refresh callback exists to avoid. The shared `usePolling` hook already handled a `null` delay at runtime (stop the interval, keep the mount read); its type simply didn't admit it, so the signature was widened rather than the idiom re-invented.

- **Every honesty requirement is a rendered, asserted string.** The truncated state says coverage is partial, that the provider's tree listing chose the omitted part, and that rebuilding truncates identically (the remedy is a smaller scope). The failure state renders `lastError` byte-identically — it was redacted at the single server write site, and the panel adds no enrichment (T-29-09-02). The `mode` line distinguishes dashboard rebuild / push refresh / never built, which is the answer to "the index looks old" that a capped `indexed_at` alone cannot give.

- **The Bitbucket hint fires only on a real condition.** `mode === 'full'` on a Bitbucket repository is the *only* observable signature of a hand-created webhook subscription that never gained the push event — there is no error anywhere else. The spec asserts the positive render and both negatives (GitHub at `full`, Bitbucket at `incremental`), because a hint that always shows is as wrong as one that never does. The same requirement is written where the operator will read it first: the add-Bitbucket page now lists the push event among the webhook triggers and states that an existing subscription must be edited.

- **The toggle is a dirty-tracked config edit through the correct merge path.** `review.interactive.qa.index` lives inside the `interactive` object, so the draft merges through `mergeReviewPatch`'s interactive argument — and it is overlaid *last*, because the InteractivePanel's reported draft spreads `qa` from the repo prop and would otherwise silently restore the pre-edit index block on every Apply (the same stale-draft clobber class as REVIEW #4, this time prevented at the merge site rather than discovered in review).

- **No header is set by hand anywhere.** Both client calls go through the shared `request` helper, which attaches `x-requested-with` to every non-safe method; the browser spec asserts the exact call signature, and 29-08's server-side CSRF case already proves the route rejects a headerless POST (T-29-09-01).

## Task 3 UAT Session: Six Real Bugs Found and Fixed (2026-07-29)

Deploying to the live instance and pushing a real build to completion on both providers surfaced six
real production bugs, none of which any test in this phase's automated suite could have caught (all
require Cloudflare's actual subrequest accounting, a real Workflow instance lifecycle, or a real
provider tree with real file content). Fixed, tested, and deployed one at a time:

1. **Cloudflare subrequest exhaustion was a permanent failure, not a retry.** `isTransientBuildError`
   didn't recognize "too many subrequests" as transient, so the first budget hit during a real build
   permanently failed it even though the budget resets on the Workflow's next invocation. Fixed in
   `04bd5de`.
2. **The binary-file NULL-byte check only scanned the first 8 KB.** A larger file with a NULL byte past
   that point still crashed the chunk insert with a raw `PostgresError`. `CODE_INDEX_MAX_FILE_BYTES`
   already bounds content to 1 MB, so scanning the whole string is cheap. Fixed in `04bd5de`.
3. **`instance.already_exists` always meant "coalesce," even for a terminated instance.** Cloudflare
   rejects a Workflow `create` on an id that already has a record, even after that instance finished —
   so once a repository's first build completed (or died), every later press silently did nothing
   forever. This is `deferred-items.md`'s 29-08 concern, confirmed live. Fixed in `b075e1f`: detect the
   case, release the stale lease, retry under a fresh `{id}-{timestamp}` instance id.
4. **The fresh-instance handoff renewed the outgoing lease instead of releasing it.** At
   `MAX_INDEX_CONTINUATIONS`, the outgoing instance renewed its own lease right before creating the
   handoff instance under a new id — so the handoff's own lease claim always found a lease it didn't
   own and coalesced away, doing no work. This is `deferred-items.md`'s other 29-08 concern, also
   confirmed live (on `reach`, at continuation 20). Fixed in `c89b46d`: release the lease instead of
   renewing it when handing off; the existing "no progress rows at the build sha" guard already makes
   this safe.
5. **`TokenTracker.hasRemainingSafeBudget` didn't exist.** `core/bitbucket.ts`'s tree-walk pagination
   guards on `tracker?.hasRemainingSafeBudget?.(1)`, which silently no-ops via optional chaining when
   the method is missing — this is `deferred-items.md`'s 29-05 concern, confirmed live. The Bitbucket
   `/src` tree walk paginated with zero budget awareness; on an unlucky invocation it consumed the
   entire 50-subrequest budget just enumerating the tree, leaving nothing for the file-processing loop
   that ran afterward (confirmed via temporary diagnostic logging, `922578e`: the failing continuation
   had zero "fetching file" log lines before the error). Fixed in `86b54d1` by adding the method.
6. **(Diagnostic, not a bug)** Commit `922578e` added a log line before every file fetch (path +
   remaining budget) specifically to localize bug #5. Left in place rather than reverted — it is
   low-noise, structured, and immediately useful for diagnosing any future build stall, though it is
   chatty at file-count scale and a future pass may want to gate it behind a debug flag.

All six fixes were verified against the real `opencodra` and `reach` builds as they happened (not just
`npm test`), which is the strongest verification this phase's Task 3 gate could realistically ask for
short of the still-open in-PR Q&A and incremental-refresh checks.

### Retrieval-backed Q&A: confirmed working, plus one real observation (not a bug)

With both builds complete, the in-PR Q&A retrieval test was run on `michnicki/opencodra#13` (see
coverage id D6). The **first** attempt asked about `INDEX_BUILD_LEASE_SECONDS`
(`src/server/core/code-index-build.ts`) and got a diff-only-looking answer even with the index
enabled and ready. Investigating (with a background research agent tracing the Q&A path in
`src/server/core/qa.ts` end to end, then confirming against production data) found the real cause: a
direct production query showed `code_index_files` has **zero rows at all** for that path — not
skipped for content reasons, simply never selected as a candidate. `core/priority.ts`'s
`LOW_PRIORITY_KEYWORDS` list includes `'build'`, and `code-index-build.ts`'s own filename contains
that substring, so it scores -5 in `selectIndexablePaths`'s ranking — combined with `opencodra`
exceeding the default `max_files: 500` cap, this specific (and slightly ironic — the code-index
*build* file, deprioritized by the word "build") file lost its slot. This is the documented,
intentional `±5`-tier substring-FP tolerance (`priority.ts`'s own D-08 comment) working exactly as
designed, not a bug — but it is a genuine, real consequence worth knowing about for a repo this size.

Re-running the test against a file confirmed actually indexed (`src/server/core/audit-redact.ts`,
verified via direct production query first) gave a clean, fully correct result in both directions:
with the index enabled, the bot answered `redactErrorMessage`'s HTTP-503 behavior correctly, citing
the exact file, from outside the diff; with the index disabled, it correctly refused to look beyond
the diff. **The retrieval mechanism itself works correctly end to end.**

## Task Commits

1. **Task 1: typed client calls + panel component** — `fbd0ab6` (feat)
2. **Task 2: mount, Bitbucket instruction, browser spec** — `5dca68d` (feat)
3. **Task 3 UAT fix 1: subrequest-exhaustion retry + binary NULL-byte full scan** — `04bd5de` (fix)
4. **Task 3 UAT fix 2: fresh-instance-id retry on `instance.already_exists`** — `b075e1f` (fix)
5. **Task 3 UAT fix 3: NULL-byte check corrected to scan the whole file** — `ac49cde` (fix)
6. **Task 3 UAT fix 4: release (not renew) the lease on fresh-instance handoff** — `c89b46d` (fix)
7. **Task 3 UAT diagnostic: log path + remaining budget before each fetch** — `922578e` (debug)
8. **Task 3 UAT fix 5: add the missing `TokenTracker.hasRemainingSafeBudget`** — `86b54d1` (fix)
9. **Task 3 UAT docs: close out three confirmed `deferred-items.md` concerns** — `5202f50` (docs)

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

- **The two known liveness questions carried from 29-08 both manifested for real, and are now fixed.** The static per-repository Workflow instance id did permanently freeze rebuilds after a first build (fixed `b075e1f`), and the fresh-instance handoff did coalesce itself away against its own inherited lease (fixed `c89b46d`). See "Task 3 UAT Session" above for the full list of six bugs found and fixed during the same-day UAT session; `deferred-items.md` has been updated to close out both entries plus the related 29-05 `hasRemainingSafeBudget` gap.
- **The React `act(...)` warning appears once in the full browser suite output.** It is a warning, not a failure (128/128 pass), and originates from the panel's status refetch resolving after an assertion — the same shape the learned-rules spec already produces. Not a regression; left as-is rather than wrapping production polling in test-only act choreography.

## Known Stubs

None. Every rendered value flows from the live status endpoint response (stubbed only in tests, via the module mock the repo's browser specs always use).

## User Setup Required (the Task 3 checkpoint) — UPDATED after the 2026-07-29 UAT session

**Already done, confirmed live (see coverage id D6 and "Task 3 UAT Session" above):** the three
automated gates, `npm run deploy` (both `codra-review-workflow` and `codra-index-workflow` confirmed
present), a real full build to completion on **both** GitHub (`opencodra`) and Bitbucket (`reach`), the
panel's visual review, the rebuild-twice check, the fresh-instance-handoff check, build cost vs. the
~12 files/min estimate, the real Postgres index size, and — both directions — the in-PR GitHub Q&A
retrieval test (positive: correct out-of-diff answer with file citation; negative: correctly refused
when the index was toggled off). Six real bugs plus one real-but-intentional priority-scoring
observation were found along the way (see above) and `deferred-items.md` is updated.

**Still needed — two items, each requiring a real GitHub.com/Bitbucket.org write action:**

1. **GitHub post-merge incremental refresh.** Merge something small to `main` on `michnicki/opencodra`
   (PR #13 itself is a scratch PR meant to be closed unmerged, per its own description — use a
   different small change); confirm the panel's indexed commit advances and the "what produced this
   index" line flips from dashboard-rebuild to push-refresh wording.
2. **Bitbucket Q&A, webhook edit, and incremental refresh.** Same Q&A test (both directions) on a
   Bitbucket PR against `thomas_michnicki/reach`. Before merging, edit the repository's real Bitbucket
   webhook subscription to add the repository push event (the panel's hint — confirmed rendering
   correctly — says exactly this is needed). Confirm the hint disappears and an incremental refresh
   fires after the edit. This also resolves A2 (whether the real `repo:push` payload parses without a
   schema error) — observable from the same merge (probe preserved at
   `scratchpad/probe-a2-bitbucket.mjs` if a scripted capture is preferred instead).

While at it: watch the Worker logs during the Bitbucket build for the `/src` tree-walk's real page
count and any HTTP 555 retry (A3/A4) — not yet specifically observed during the UAT session, though the
build completed without hitting the page cap (`truncated: false`).

**Resume signal:** type "approved" once all three are done, or describe what did not behave as stated.

## Self-Check: PASSED (Tasks 1-2 + Task 3 UAT fixes; Task 3 checkpoint itself remains open)

**Tasks 1-2:**
- `src/client/components/features/repos/code-index-panel.tsx` — FOUND, created
- `test/browser/code-index-panel.spec.tsx` — FOUND, created
- `src/client/lib/api.ts`, `src/client/pages/repos.tsx`, `src/client/pages/repos/add-bitbucket.tsx`, `src/client/hooks/use-polling.ts` — FOUND, modified
- Commits `fbd0ab6`, `5dca68d` — both resolve in `git log`
- `git diff --name-only fbd0ab6^..5dca68d` returns exactly the six files above; zero deletions; none of the pre-existing unrelated working-tree modifications staged

**Task 3 UAT session fixes (2026-07-29):**
- Commits `04bd5de`, `b075e1f`, `ac49cde`, `c89b46d`, `922578e`, `86b54d1`, `5202f50` — all resolve in `git log`
- `npm run typecheck` exits 0 (re-run after every fix, and again after the final fix)
- `npm test`: **132 files / 1912 tests passing** (re-run after every fix)
- `npm run test:browser` under `nix-shell shell.nix`: **19 files / 128 tests passing**, including all 8 new cases (re-confirmed at Tasks 1-2 closeout, not re-run during the UAT session since no browser-facing code changed)
- `.github/workflows/ci.yml` unmodified
- Real production evidence (not just `npm test`): both `michnicki/opencodra` and `thomas_michnicki/reach` completed a real full build after all six fixes were deployed, confirmed via the dashboard panel, the raw status API, `wrangler workflows instances describe`, and a direct production-database query (383 + 344 file rows, 1909 + 1546 chunks, 15 MB combined `code_index_chunks` table)

**Not self-checked — genuinely open, not a gap in this check:** GitHub post-merge incremental refresh, and the Bitbucket Q&A/webhook-edit/incremental-refresh/A2 set. These require GitHub.com/Bitbucket.org write actions and are the developer's remaining checklist (see "User Setup Required" above).

---
*Phase: 29-qa-idx-01-codebase-index-backed-q-a*
*Completed (Tasks 1–2): 2026-07-29. Task 3 UAT session same day: six real bugs found and fixed, both providers' builds now complete end to end, GitHub Q&A retrieval confirmed working in both directions. Task 3 checkpoint remains open pending two developer-only actions (see "User Setup Required").*
