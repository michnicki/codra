
## 29-09: code-index Q&A retrieval ranking is weak for natural-language questions (cross-provider, not fixed)

**Found during:** the 29-09 Task 3 UAT session, 2026-07-30, live Q&A testing on
`thomas_michnicki/reach` PR #5 (Bitbucket).

Three real questions about a confirmed-indexed file (`src/lib/utils/formatters.ts`) all got
confidently wrong answers — a fabricated file path, wrong return values, invented array contents.
This looked at first like a Bitbucket-specific retrieval failure. A temporary diagnostic log
(`src/server/core/qa.ts`, commit `a0f2ca8`: chunk count + retrieved paths, logged unconditionally
right after retrieval — the existing code only logs on the *failure* path, so a wrong answer and a
silently-empty retrieval are indistinguishable in the logs otherwise) resolved it: retrieval ran
correctly and filled all 8 `top_k` slots with real repository content. It just never retrieved
`formatters.ts`.

**Root cause:** `buildQueryExpression` (`src/server/core/code-index.ts`) OR-joins every non-stopword
query term with equal weight (`terms.join(' OR ')`). `QUERY_STOPWORDS` filters English question words
(`what`, `does`, `the`, `for`) but NOT near-universal *code* vocabulary (`function`, `return`, and
likely others like `value`, `const`, `export`). A natural-language question like "what does the
truncate function return for truncate(...)?" tokenizes (after stopword removal) to roughly
`['truncate', 'function', 'return', 'hello', 'world', '5']`. Since `function`/`return` appear in
nearly every source file, `ts_rank_cd` can rank a chunk dense with generic code vocabulary above the
one chunk containing the actually-distinctive term (`truncate`) — confirmed live: the 8 retrieved
chunks were from three completely unrelated files (`vault.ts`, `ansible.ts`, `tofu.ts`), none of them
`formatters.ts`.

**This is cross-provider, not Bitbucket-specific.** The equivalent GitHub tests in this same UAT
session (asking about `INDEX_BUILD_LEASE_SECONDS` and `redactErrorMessage`) happened to use rare,
proper-noun-like identifiers that dominate ranking regardless of the OR-join weakness — they never
exercised this failure mode. A similarly natural-language-phrased question on GitHub would very
likely hit the same issue. A second research agent traced the Bitbucket-specific comment/config path
end to end (`webhook-bitbucket.ts`, `findRepositoryIdByIdentity`'s workspace-vs-owner branching,
`retrieveCodeIndexChunks`) and found it fully symmetric with GitHub's — no provider-specific plumbing
bug, confirming the ranking algorithm itself is the shared root cause.

**Not fixed here, deliberately.** This is a real design tradeoff, not a quick patch: extending
`QUERY_STOPWORDS` with code-vocabulary words risks filtering out legitimate searches (e.g. "how does
this framework's function decorator work"); weighting rare terms higher or AND-biasing the query
would change ranking behavior broadly and needs its own test coverage. Worth a deliberate look in a
future phase, not a rushed change at the tail of an already-large UAT session.

**Suggested fix directions (any could work, none evaluated in depth):** (a) extend `QUERY_STOPWORDS`
with the most common code-vocabulary noise words; (b) use `setweight()` + a two-tier query (rare
identifier-shaped terms required, common words optional) instead of a flat OR-join; (c) prefer terms
that appear in fewer total indexed chunks (an IDF-like signal) when ranking. Whichever direction is
chosen, add a regression test asking a natural-language question (not just a bare identifier) against
a small fixture index with both a relevant and several irrelevant-but-generic-code-heavy files, and
assert the relevant one ranks first.

## RESOLVED at 29-09's Task 3 UAT (2026-07-29): `hasRemainingSafeBudget` fixed live

Confirmed exactly as predicted below: `reach`'s real Bitbucket build stalled repeatedly at a fixed
continuation with "too many subrequests", and diagnostic logging (path + remaining budget logged
before every file fetch, commit `922578e`) showed the failing continuation had **zero** `fetching
file` log lines before the error — the enumeration/tree-walk step alone consumed the entire
per-invocation budget, leaving nothing for the file loop. Fixed in commit `86b54d1` by adding
`hasRemainingSafeBudget(needed = 1)` to `TokenTracker` exactly as suggested below. After redeploy the
same already-running instance picked up the fix on its next retry (Cloudflare Workflows execute each
step against the currently-deployed code, not a pinned version) and completed successfully: 285 files,
1546 chunks. Original write-up preserved below for context.

## 29-05: `hasRemainingSafeBudget` is not a `TokenTracker` method (out of scope, pre-existing)

**Found during:** plan 29-05 Task 2, while reasoning about whether tree enumeration can starve the file loop.

`src/server/core/bitbucket.ts` guards its paginated walks with `tracker?.hasRemainingSafeBudget?.(1)`
(added by 29-03 for `listSrcTree`, and pre-existing on the thread walk). But `TokenTracker`
(`src/server/core/token-tracker.ts`) exposes `hasRemainingSubrequests`, `isNearLimit` and
`remainingSafeBudget` — there is **no `hasRemainingSafeBudget`**. Because the call is optional-chained,
the guard silently evaluates to "no opinion" and is a **no-op with the real tracker**; it only fires for
the hand-rolled tracker objects the specs pass in. So 29-03's "live subrequest-budget consult" is
proven by its spec but inert in production, and `MAX_SRC_TREE_PAGES = 50` is the only real bound on a
Bitbucket `/src` walk.

**Not fixed here** — it is in `core/bitbucket.ts`, outside plan 29-05's `files_modified`, and it is not
caused by this plan's changes. It is also not blocking: `MIN_INDEX_FILES_PER_INVOCATION` in
`core/code-index-build.ts` was added precisely so a budget-draining enumeration cannot stop the build
from making forward progress, and it carries this reasoning in its comment.

**Suggested fix:** either add `hasRemainingSafeBudget(needed = 1)` to `TokenTracker` (returning
`remainingSafeBudget() >= needed`) or change the call sites to `remainingSafeBudget() >= 1`. Prefer the
former — two call sites already assume the method exists.

## RESOLVED at 29-09's Task 3 UAT (2026-07-29, then FULLY closed 2026-07-30): confirmed real, fixed live

The live check this entry calls for happened: after `opencodra`'s first build, a second dashboard
press (and every push-triggered rebuild afterward) returned `coalesced: true` against a Workflow
instance that had already terminated hours earlier — exactly the frozen-index failure predicted below.
Fixed in commit `b075e1f`: on `instance.already_exists`, release the stale lease and retry under a
fresh `{constantId}-{Date.now()}` instance id (the suggested commit-suffix approach was considered but
the timestamp suffix was simpler and sufficient — freshness is about the *lease*, not identifying which
commit a build targets). Confirmed live: pressing build again after a completed build now returns
`coalesced: false` with a new instance id and a second Workflow instance actually appears.

**Correction, 2026-07-30: the above only fixed the dashboard press, not the two push branches this
entry itself warns about.** `b075e1f` patched only `routes/api/repos.ts`'s `instance.already_exists`
catch; `webhook.ts` (GitHub push) and `webhook-bitbucket.ts` (Bitbucket push) still did a bare `create`
and treated ANY `instance.already_exists` as benign coalescing — exactly the "every later push refresh
is dropped the same way" failure this entry predicted, just not yet tested. It reproduced live: once
`reach`'s Bitbucket main-branch misconfiguration was fixed (see the new entry below) and a real push
finally reached the push-refresh branch, it coalesced against `reach`'s own already-completed dashboard
build and started nothing. Fully closed in commit `a014df8` by extracting the lease-claim + create +
stale-instance-retry logic into a shared `startIndexBuild()` helper (`core/code-index-build.ts`) and
wiring all three sites — dashboard, GitHub push, Bitbucket push — to call it. Confirmed live: the same
push that previously coalesced now logs `"instance already exists; retrying with fresh instance id"`
followed by `"triggered a codebase index refresh, mode: incremental"`, and `code_index_state.indexed_sha`
advances to the pushed commit. Original write-up preserved below for context.

## 29-08: a static per-repository Workflow instance id may permit only ONE build per repository, ever

**Found during:** plan 29-08 Task 2, while modelling what Cloudflare actually does on a duplicate
`create` in order to write the double-press case honestly.

`codeIndexInstanceId(repositoryId)` → `code-index:{repositoryId}` is a **constant** for a repository,
and 29-05 exported it precisely so the dashboard trigger and both 29-06 push branches coalesce on one
id. That is exactly what makes a *concurrent* double press safe. But Cloudflare Workflows instance ids
are unique **for the lifetime of the instance record, not just while it is running**: a `create` with an
id that already exists is rejected with `instance.already_exists` even after that instance has
COMPLETED. If that is so, then after the first successful build of a repository:

- every later dashboard press is reported as "coalesced" and starts nothing, and
- every later push refresh (29-06) is dropped the same way,

so a repository's index would be frozen at its first build until the instance record ages out of
retention. The failure is silent and looks exactly like correct coalescing from the response body, which
is what makes it worth writing down.

**Not fixed here, deliberately.** Plan 29-08's acceptance criteria *mandate* `codeIndexInstanceId` and
forbid building an id locally; the helper is a three-site cross-plan contract established by 29-05 and
consumed by 29-06. Changing the id scheme is an architectural change spanning 29-05/29-06/29-08 and is
not this plan's call to make unilaterally. The durable lease remains the authoritative concurrency guard
either way, so nothing is *incorrect* — the risk is liveness, not consistency.

**Cannot be observed in the suite.** `test/helpers.ts`'s `MockWorkflow` never rejects a duplicate id, and
`test/code-index-api.spec.ts`'s deduplicating mock uses a fresh instance per test, so neither can tell us
Cloudflare's real retention behavior. **This needs a live check in 29-09 UAT:** build a repository's index,
let it finish, then press Build again and confirm a *second* Workflow instance appears in the Cloudflare
dashboard. If it does not, the fix is to suffix the id with the build's target commit — e.g.
`code-index:{repositoryId}:{headSha}` — which keeps push-vs-dashboard coalescing meaningful *per commit*
while letting a later build for a different commit through.

## RESOLVED at 29-09's Task 3 UAT (2026-07-29): confirmed real, fixed live

`reach`'s Bitbucket build hit `MAX_INDEX_CONTINUATIONS` for real and handed off exactly as predicted:
the outgoing instance completed gracefully, the fresh handoff instance also completed within 2 seconds
having done no real work, and the build was left permanently stuck at `status: building`. Fixed in
commit `c89b46d` using the exact approach suggested below: the outgoing instance releases its lease
instead of renewing it when `freshInstance` is true, so the handoff's own claim lands on a free lease.
The "no progress rows at the build sha" guard already made this safe, as predicted. Original write-up
preserved below for context.

## 29-08: a fresh-instance handoff appears to coalesce itself away against the lease it inherited

**Found during:** plan 29-08 Task 1, while verifying that this endpoint's lease claim and
`IndexWorkflow`'s own claim use the same `workflow_instance_id` (they must, or the endpoint would
coalesce away the build it just started).

`IndexWorkflow.execute` renews the lease under `event.instanceId` before returning `continue`, then — at
the continuation ceiling — creates the handoff instance under a **fresh random UUID**. The handed-off
instance calls `runIndexBuild` with `workflowInstanceId = event.instanceId` (its own new UUID), so
`claimCodeIndexBuildLease` sees `status = 'building'` with a live `lease_expires_at` owned by a
*different* instance id, fails the claim, and returns `{ action: 'ack', reason: 'coalesced' }`. The
handoff would therefore do no work, and nothing re-triggers the build after the 15-minute lease expires.

Only reachable for a build exceeding `MAX_INDEX_CONTINUATIONS` (20) continuations — roughly 240+ files —
which is why 29-05's two-invocation integration cases do not hit it.

**Not fixed here:** `src/server/core/code-index-build.ts` and `src/server/workflows/index-build.ts` are
outside plan 29-08's `files_modified`, and this is not caused by this plan's changes.

**Suggested fix:** have the handing-off instance `releaseCodeIndexBuildLease` immediately before it
creates the handoff (it is already breaking out of its loop, and the destructive reset is independently
guarded by the "no progress rows at the build sha" check, so releasing is safe), or pass the handoff the
outgoing instance id to claim under. Pin whichever with a case that asserts the handed-off instance
actually indexes a file.

## RESOLVED at 29-09's Task 3 UAT (2026-07-30): A2 confirmed

Multiple real `repo:push` deliveries were captured in production (`webhook_deliveries` rows,
`repository_id = 18`, `event_name = 'repo:push'`) across a merge and two direct-to-`main` commits.
`push.changes[0].new.name` and `.new.target.hash` extract cleanly every time — no schema error, no
`repoPushPayloadSchema` mismatch. The reason this took until 2026-07-30 to observe cleanly:
`reach`'s Bitbucket repository had its own pre-existing "Main branch" designation pointed at a
leftover scratch branch (`bantam-e2e-verify-mpwc2nkf`) rather than `main` (see the new entry below),
so every push to the literally-named `main` was legitimately ignored as `non_default_branch` until
that was fixed — a repo-config problem, not a payload-shape problem. Once fixed, a push to `main`
correctly resolved `mainBranch` from `getRepositoryMetadata()` and matched. **A2 is confirmed; no
schema change needed.** Original write-up preserved below for context (`scratchpad/probe-a2-*` and the
associated capture spec are stale exploratory artifacts from before this live confirmation and can be
deleted).

## NEW, resolved outside Codra: `reach`'s Bitbucket "Main branch" pointed at a scratch branch

**Found during:** 29-09 Task 3 UAT, 2026-07-30, while investigating why pushes to `main` never
triggered a refresh.

Not a Codra bug. `getRepositoryMetadata().mainbranch.name` — Bitbucket's own repository-level
designation, independent of any branch's literal name — resolved to `bantam-e2e-verify-mpwc2nkf`
(a leftover scratch branch from earlier E2E-verify testing) rather than `main`, so Codra's
`repo:push` handler's `change.new.name !== mainBranch` check was correctly ignoring every push to
`main` as `non_default_branch`. Confirmed via Bitbucket's branches list UI: the scratch branch (not
`main`) carried both the "main" and "development" tags before the fix. The developer fixed the
designation via Bitbucket's admin **Advanced** section (`/admin`, not the branching-model page's
"Development branch" dropdown, which this session tried first and could not get to take effect even
after disabling "Enable inherited settings"). Confirmed fixed: the branches list now tags `main`
correctly, and a subsequent push resolved and processed as expected. Nothing to fix or watch for in
Codra's code — worth recording only because it caused ~15 minutes of live UAT time to be spent
investigating what turned out to be entirely outside the application.

## RESOLVED, outside Codra: CodraApp's GitHub App had never subscribed to the `push` webhook event

**Found during:** 29-09 Task 3 UAT, 2026-07-30, while running the GitHub post-merge
incremental-refresh test.

Not a Codra bug. A direct query of `webhook_deliveries` for `michnicki/opencodra` showed every event
kind Codra's routes actually handle (`pull_request`, `check_suite`, `issue_comment`,
`pull_request_review`, etc.) but **zero `push` rows, ever** — the GitHub App (`CodraApp`) was simply
never subscribed to the `push` event at the app level, so no merge to `main` could have triggered an
incremental refresh regardless of any code fix. This is the exact GitHub-App-level counterpart to the
per-repo Bitbucket webhook-subscription gap this session also investigated (see the `reach` entries
above), just configured in a different place: GitHub Apps' webhook event subscriptions live on the
app's own Permissions & events settings page, not per-repository.

Confirmed via `https://github.com/settings/apps/CodraApp/permissions` → "Subscribe to events": `Push`
was unchecked. The developer added it (GitHub's sudo-mode confirm page initially blocked the
assistant's own authenticated browser session; the developer re-authenticated it, after which the
assistant located and checked the box directly). A test merge immediately after produced a real `push`
delivery, `mode: incremental`, and `code_index_state.indexed_sha` correctly advancing to the merge
commit — confirmed both via direct production-database query and visually in the panel (`Last refresh:
push refresh`).

**Nothing to fix in Codra's code.** Worth recording because — like the `reach` main-branch
misconfiguration — it could otherwise be misdiagnosed as a code defect in `webhook.ts`'s push handler
(which was, separately, genuinely buggy — see the `codeIndexInstanceId` entry above — but that bug was
never even reachable here until this subscription was added).

## 29-06: A2 (real Bitbucket `repo:push` payload shape) confirmed nowhere yet — deferred to 29-09's gate

**Deferred at:** plan 29-06 closeout, 2026-07-29, with developer approval.

29-06 Task 4 was a blocking checkpoint requiring one real delivery per provider to confirm the two
community-sourced payload assumptions. **A1 is confirmed** (real GitHub push carries both
`repository.default_branch` and `master_branch`; capture at `scratchpad/captures/a1-github-push.json`).
**A2 is not**: the capture probe (`scratchpad/probe-a2-bitbucket.mjs`) was fully scripted but cannot run
in an environment without CF API credentials, a prod DB URL, or Bitbucket auth.

**Where it closes:** 29-09 Task 3 step 7 (operator adds the repository push event to the real Bitbucket
subscription — required anyway) plus its reporting item 2 ("did the Bitbucket push payload parse without
a schema error"). The exact field paths to confirm: `push.changes[].new.type`, `.new.name`,
`.new.target.hash` (and `old.target.hash` on the deletion leg). If the shape is wrong, the fix is
confined to `src/shared/bitbucket.ts` (`repoPushPayloadSchema`) plus the fixture in
`test/push-webhook.spec.ts` — route logic and verification ordering do not change.

**Harness preserved:** `scratchpad/probe-a2-bitbucket.mjs` (capture + optional `--flip-codra-hook`
operator step) and `scratchpad/scratch-a2-capture.spec.ts` (parses `scratchpad/captures/a2-*.json`
against the shipped contracts — moved out of `test/` at closeout because it fails `npm test` while the
captures do not exist; move it back or run it directly once they do).

**Accepted risk:** if A2 is wrong (a *renamed* field), the failure is a silent ignored-acknowledgement
on Bitbucket pushes — Bitbucket freshness simply never fires, discovered at 29-09's gate one plan later
rather than here. No route error is possible: a parse failure degrades to the same response vocabulary
as a correctly-ignored delivery.
