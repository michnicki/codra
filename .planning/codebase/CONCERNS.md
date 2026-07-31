---
last_mapped_commit: fe9c2570b1a16c453497f2cd3e35748518f6f603
---
# Codebase Concerns

**Analysis Date:** 2026-07-27

Every item below is grounded in code read during this pass, with a `path:line` reference.
Items are tagged:

- **[DEFECT]** — a genuine bug or gap that can produce wrong behavior.
- **[TRADEOFF]** — a deliberate, documented decision. Listed because it constrains future work, *not* because it should be "fixed".
- **[RUNTIME]** — a constraint imposed by Cloudflare Workers, not by this code.

This codebase annotates nearly every tuning constant with a rationale comment explaining
which regression it prevents. Those comments are load-bearing: treat the constants as
**pinned contracts**, not as debt. See `src/server/core/review.ts:118-209`.

---

## Tech Debt

**Untracked, broken migration script:** [DEFECT] — deleted. [RESOLVED — Phase 32 Plan 32-03 Task 1]
- Issue: `scripts/apply_migrations.js` is an untracked working-tree file that duplicates the
  sanctioned `scripts/migrate.mjs`, and it cannot work:
  - It imports `{ pool }` from `@server/db/client` (`scripts/apply_migrations.js:1`), but that
    module exports no `pool` — it is a postgres.js wrapper (`src/server/db/client.ts:66-101`).
    It is also a `.js` file using a TS path alias, so Node cannot resolve it at all.
  - It reads/writes `schema_migrations` as an integer `version` column
    (`scripts/apply_migrations.js:8`, `:24`), while the real table is keyed on a text `name`
    (`scripts/migrate.mjs:80`, `:208`, `:223`). If it ever ran, it would insert into a column
    that does not exist.
  - It takes no advisory lock (contrast `scripts/migrate.mjs:427-428`) and applies **all**
    pending migrations inside one transaction (`scripts/apply_migrations.js:7`, `:31`).
- Files: `scripts/apply_migrations.js`, `scripts/migrate.mjs:80,203-223,427-461`
- Impact: a contributor who runs it gets a confusing crash; worse, it advertises a second,
  divergent migration protocol next to the real one. Migration state is currently at `017`
  (`db/migrations/017_cross_file_security_pass.sql`) and consistent under `migrate.mjs`.
- Fix approach: delete `scripts/apply_migrations.js`. `npm run migrate` is the only path.

**`review.ts` is a 3,790-line module:** [TRADEOFF, drifting]
- Issue: `src/server/core/review.ts` holds the whole phase state machine (prepare, review,
  critic, verify_fixes, walkthrough_enrichment, cross_file_security, finalize), the
  continuation-ceiling policy, lease handling, and budget arithmetic in one file.
- Files: `src/server/core/review.ts` (3,790 lines; next-largest server module is
  `src/server/core/github.ts` at 1,167)
- Impact: the per-phase degrade branches (`:624-733`) are near-identical blocks repeated per
  phase; adding a phase means touching the phase union (`:116`), `resolveQueuedJob`'s spoof
  gate (`:757-779`), the degrade switch, and the `nextPhaseAfter*` selectors.
- Fix approach: extract each phase runner into `src/server/core/phases/<name>.ts` and table-drive
  the degrade policy keyed on phase. Do **not** change the constants while doing it.

**Config defaults must be hand-mirrored across three sites:** [DEFECT, latent] — drift detection test added. [RESOLVED — Phase 32 Plan 32-02 Task 2]
- Issue: the installed Zod (v4, `package.json:81`) does not re-parse an object `.default({...})`
  literal — it short-circuits and returns the literal verbatim. This is acknowledged in-source at
  `src/shared/schema.ts:328-332`. Consequently a single config key needs **three** coordinated
  edits: (1) the field's own `.default()`, (2) the enclosing block's `.default({...})` literal,
  (3) the top-level `repoConfigSchema.review.default({...})` literal.
  Concrete example for `interactive.commands.bitbucket_bot_account_id`:
  `src/shared/schema.ts:214` (field), `:216` (`commands` block literal), `:227`
  (`interactive` block literal), `:336` (top-level `review` literal) — four sites.
- Files: `src/shared/schema.ts:139-347`, consumed via
  `export const defaultRepoConfig = repoConfigSchema.parse({})` at `src/shared/schema.ts:1536`
- Impact: omitting a site does **not** fail `tsc` (nested defaulted keys are optional in Zod's
  *input* type) but the key silently vanishes at runtime from `defaultRepoConfig`. Since
  `defaultRepoConfig` is what `src/server/routes/webhook-bitbucket.ts:233-240` snapshots for every
  Bitbucket job, a missing key becomes an `undefined` read in the pipeline.
- Fix approach: replace the literal defaults with a single source of truth — either derive each
  block default from `blockSchema.parse({})`, or keep the literals and add one test asserting
  `repoConfigSchema.parse({})` deep-equals an explicitly-declared expected object. The latter is
  the smaller change and makes drift fail loudly.

---

## Known Bugs

**Bitbucket webhook route cannot accept any non-pull-request event:** [DEFECT] — identity projection made pullrequest optional, schema includes repoPushPayloadSchema. [RESOLVED — Phase 29, verified Phase 32 Plan 32-03 Task 3]
- Symptoms: `POST /webhook/bitbucket` returns `400 Invalid webhook payload.` for every Bitbucket
  event that has no `pullrequest` object — `repo:push`, `repo:commit_status_updated`,
  `repo:commit_comment_created`, `issue:*`, and the workspace/project events.
- Files: `src/server/routes/webhook-bitbucket.ts:66-95`
- Trigger: the pre-verification identity projection hard-requires
  `pullrequest: { id: number().int().positive() }` (`:73-75`) and a failed `safeParse` returns
  `400` at `:93-95` — before the credential lookup and before HMAC verification. The projection is
  documented as extracting only `{workspace, repo_slug}` (`:63-65`), yet it demands
  `pullrequest.id`, which is not part of the identity it needs.
- Impact: purely a capability ceiling today (the worker only reviews PRs), but any future
  `repo:push`-driven feature is blocked at the route, and a Bitbucket admin who subscribes the
  webhook to extra events sees a stream of 400s with no diagnostic.
- Workaround: subscribe the webhook to `pullrequest:*` events only.
- Fix approach: drop `pullrequest` from `bitbucketIdentityProjectionSchema`; let the *post-verify*
  `pullRequestWebhookPayloadSchema.safeParse` (`:146`) be the thing that rejects non-PR shapes,
  and return `202 ignored` rather than `400` for an authenticated-but-unhandled event key.

**PR description is accepted by the file-review prompt builder and then dropped:** [DEFECT]
- Symptoms: the review model never sees the PR body when reviewing a file, so findings cannot use
  stated intent ("this is intentional, see the description") as context.
- Files: `src/server/prompts/file-review.ts:57` declares `prDescription: string | null` in the
  input type; the assembled `userPrompt` (`:69-117`) references `input.prTitle` at `:70` and
  never references `input.prDescription`. Three call sites dutifully pass it:
  `src/server/core/review.ts:1388`, `:1719`, `:1883`.
- Trigger: every file review.
- Fix approach: emit the description inside the existing untrusted fence — it is PR-supplied text,
  so it must go through `sanitizeUntrusted` (`src/server/prompts/file-review.ts:140-145`) and sit
  between the `UNTRUSTED_*` sentinels, never in the system prompt.

---

## Security Considerations

**Webhook signature verification is fail-closed — verified:** [not a concern]
- `src/server/core/verify.ts:29-31` rejects a missing/non-`sha256=` header, `:36-39` rejects a
  non-hex body, and the `catch` at `:51-54` returns `false` rather than throwing.
  Both providers route through the same primitive (`:57-64` for GitHub;
  `src/server/routes/webhook-bitbucket.ts:124-132` for Bitbucket). Bitbucket additionally fails
  closed when no secret row exists (`:109-111`) and when decryption throws (`:116-120`).
  HMAC is computed over the raw body captured before any `JSON.parse`
  (`src/server/routes/webhook-bitbucket.ts:80`), and the union discriminator comes from the trusted
  `X-Event-Key` header rather than the body (`:145`). No changes needed.

**Pre-verification response bodies form a repo-onboarding oracle:** [DEFECT, low severity]
- Risk: an unauthenticated caller can distinguish, per `(workspace, repo_slug)`, whether Codra has
  a Bitbucket webhook secret configured. `401 Webhook secret not configured.`
  (`src/server/routes/webhook-bitbucket.ts:110`) fires when no credential row exists;
  `401 Invalid webhook signature.` (`:131`) fires when one does. The distinct bodies are the leak,
  not the status code. Similarly, `400 Invalid webhook payload.` at `:94` is returned before any
  authentication and confirms only that the body lacked the identity/`pullrequest.id` shape — it
  reveals nothing about a repo, but it is an unauthenticated shape oracle.
- Files: `src/server/routes/webhook-bitbucket.ts:93-95`, `:109-111`, `:130-132`
- Current mitigation: the raw body is never logged; no provider API call is made on these paths
  (`:59-60`), so there is no amplification primitive.
- Recommendations: collapse every pre-dispatch failure to one opaque body
  (`{"error":"unauthorized"}`, 401) and log the specific reason server-side instead. Ordering the
  credential lookup before verification is unavoidable (the secret is per-repo), so uniform
  responses are the right mitigation.

**Prompt-injection fencing is sound — verified:** [not a concern]
- `sanitizeUntrusted` (`src/server/prompts/file-review.ts:140-145`) strips C0/C1 control characters,
  breaks every backtick run with U+200B (so untrusted text cannot close the ```diff fence), and
  breaks `<<<`/`>>>` runs so content cannot forge the `UNTRUSTED_*` sentinels at `:127-130`.
  It is applied to the PR title (`:70`), file path (`:71`, `:96`), each custom rule (`:62`), and
  every diff header/hunk/content line (`:148-155`). Untrusted content only ever enters the **user**
  role; the system prompt is a static template plus a `max_comments` integer (`:48-52`). The
  helpers are exported specifically so the security-review prompt reuses the same fencing rather
  than forking it (`:125-126`, `:139`). No escape found.

**Logger redaction: the `message` argument is never redacted:** [DEFECT, latent] — message scrubbing + extended patterns added. [RESOLVED — Phase 32 Plan 32-03 Task 2]
- Risk: `Logger.log` redacts the AsyncLocalStorage store, the logger context, and the `data`
  payload (`src/server/core/logger.ts:85-87`) but passes `message` through verbatim (`:82`).
  Separately, `EMBEDDED_SECRET_PATTERNS` (`:24-32`) covers Bearer/JWT/OpenAI `sk-`/GitHub/Slack/AWS
  but **not** Google AI keys (`AIza…`) or Bitbucket tokens (`ATCTT…`, app passwords) — both of which
  this codebase stores and uses.
- Files: `src/server/core/logger.ts:24-32`, `:76-97`
- Current mitigation: no current call site interpolates a credential into a message. The provider
  adapters pass credentials as headers, not query strings — checked
  `src/server/models/google.ts:95` (`x-goog-api-key` header; the base URL at `:21` carries no
  `?key=`), and the Gemini failure log emits only the response text via `providerErrorMessage`
  (`src/server/models/google.ts:126-149`). So this is a hardening gap, not an active leak.
- Recommendations: run `message` through `scrubEmbeddedSecrets`, and add `AIza[0-9A-Za-z_-]{20,}`
  and `ATCTT[A-Za-z0-9_=-]{20,}` to the pattern list.

**LLM key encryption at rest — verified:** [not a concern]
- `src/server/core/llm-crypto.ts` is a 15-line delegation to the shared AES-GCM primitive in
  `core/crypto.ts`, keeping one code path for LLM keys and VCS credentials
  (`src/server/core/llm-crypto.ts:4-7`). No decrypt path logs the plaintext.

---

## Performance Bottlenecks

**Every invocation opens a fresh Postgres pool:** [RUNTIME, with a test-only mitigation]
- Problem: `runWithDb` calls `createDbClient(env)` per invocation
  (`src/server/db/client.ts:66-68`), and each client is a postgres.js pool with `max: 5` (`:14`).
  Cloudflare's "no I/O across request contexts" rule makes this mandatory — a shared pool is not
  an option — which is exactly why the comment at `:79-85` scopes the reuse map to the store-less
  path only.
- Files: `src/server/db/client.ts:13-19`, `:66-93`
- Cause: Hyperdrive is the intended connection multiplexer in production. Locally and in tests
  there is no Hyperdrive, so concurrent invocations multiply real backend connections.
- Impact: on a default `max_connections = 100` Postgres, roughly 20 concurrent invocations
  saturate the server. In the test suite this manifests as scattered, non-reproducible failures
  that each pass in isolation. `vitest.config.ts:36` sets `fileParallelism: false` and
  `src/server/db/client.ts:73` memoizes a fallback client per connection string precisely to bound
  this — but the fallback only covers calls made *outside* `runWithDb`, and tests that go through
  `app.fetch()` still enter `runWithDb`.
- Improvement path: raise `max_connections` on the test database, or drop `max` to 1-2 when
  `ENVIRONMENT === 'test'`. Do not remove the per-invocation client — that breaks the Workers
  I/O rule.

---

## Fragile Areas

**A worker that silently loses its lease keeps working:** [DEFECT]
- Files: `src/server/db/jobs.ts:782-800` (`heartbeatJobLease`),
  `src/server/core/review.ts:3117-3123` (`heartbeatAndCheckSuperseded`),
  `src/server/core/review.ts:1134`, `:1184` (call sites)
- Why fragile: the lease *claim* is correctly atomic — one `UPDATE … WHERE lease_expires_at IS NULL
  OR lease_expires_at < now() OR lease_owner = $2` (`src/server/db/jobs.ts:726-748`), so two
  workers cannot both claim. The gap is on the **renew** side. `heartbeatJobLease` is
  `UPDATE … WHERE id = $1 AND lease_owner = $2` and returns nothing (`:788-800`); when the row no
  longer belongs to this owner it updates zero rows and the caller cannot tell. One call site even
  discards the promise entirely: `heartbeatJobLease(...).catch(() => undefined)`
  (`src/server/core/review.ts:1134`). `heartbeatAndCheckSuperseded` re-reads the job but only
  inspects `status === 'superseded'` (`:3120`) — never `lease_owner`.
  Sequence: worker A's lease expires (`JOB_LEASE_SECONDS = 15 * 60`,
  `src/server/core/review.ts:119`) while a slow model call is in flight → the ~2-minute cron runs
  `recoverExpiredJobLeases` (`src/server/core/job-recovery.ts:10`) → worker B claims → worker A
  finishes, writes file reviews, and can reach finalize. Both believe they own the job.
- Safe modification: make `heartbeatJobLease` return the affected row count and have
  `heartbeatAndCheckSuperseded` throw `JOB_LEASE_LOST` on zero, treated like `JOB_SUPERSEDED`
  (which already has a clean abort path at `src/server/core/review.ts:543-544`). Never swallow the
  heartbeat promise.
- Partial mitigations already present: per-file review results are persisted and idempotent
  (`src/server/db/file-reviews.ts`), and finalize checks `findExistingReviewForCommit`, so
  duplicate *posting* is unlikely — duplicate model spend and duplicate audit rows are not
  prevented.
- Test coverage: the claim race is covered; the heartbeat-loses-lease path is not.

**Lease recovery rewinds every job to the `review` phase:** [DEFECT, self-healing but wasteful]
- Files: `src/server/core/job-recovery.ts:11-21`, `src/server/core/review.ts:781-784`
- Why fragile: recovery re-enqueues with a hardcoded `phase: 'review'`
  (`src/server/core/job-recovery.ts:15`), and the phase is taken **only** from the queue message —
  `resolveQueuedJob` does `phase: requestedPhase ?? 'review'` (`src/server/core/review.ts:783`) and
  consults no persisted phase cursor. A job whose lease expired during `finalize`, `critic`,
  `verify_fixes`, or `cross_file_security` therefore restarts at `review` and re-walks the chain.
- Safe modification: persist the current phase on the job row and have recovery resume from it.
  The individual phases claim idempotency on re-entry (e.g. the `__cross_file__` persisted-row
  check at `src/server/core/review.ts:3134-3136`), so the rewind is *correct* — it is an avoidable
  full replay that burns continuation budget.
- Test coverage: no test asserts the recovered phase.

**The 50-subrequest ceiling: where the workarounds are still thin:** [RUNTIME + TRADEOFF]
- Files: `src/server/core/review.ts:126-147`, `:192-224`, `:598-733`
- The mechanism is sound and heavily justified — do **not** retune these constants casually:
  `FRESH_INVOCATION_YIELD_SECONDS = 60` (`:136`) is deliberately long enough to force Workflow
  hibernation, because a short `step.sleep` keeps the instance in the *same* invocation and the
  budget accumulates until "Too many subrequests" (`:127-135`).
  `ESTIMATED_SUBREQUESTS_PER_FILE = 5` (`:209`) is pinned at 5 even though the true worst case is
  ~6, because bumping it to 6 makes `floor(22/6) == 3` and silently caps the user's concurrency
  slider — the regression `chunk-concurrency.spec.ts` guards (`:194-209`).
- Remaining fragility, and what happens at the ceiling:
  1. `budgetAwareFileLimit` can return **0**. `Math.min(configured, floor(remainingSafeBudget / 5))`
     (`:223-225`) yields 0 once fewer than 5 subrequests of safe budget remain. A chunk that
     processes zero files makes no progress, and a reschedule with no completed file is exactly
     what `markJobContinuationQueued` counts (`:612`).
  2. At `continuationCount > MAX_JOB_CONTINUATIONS` (20, `:147`) the review phase does **not** fail:
     it degrades to a partial review and hands finalize a *reset* continuation budget with
     `freshInstance: true` (`:630-664`). Critic, `verify_fixes`, and `cross_file_security` each
     fail **open** — they reset the counter and skip to their configured successor without applying
     their output (`:667-719`), so a budget-starved job silently ships an un-critiqued,
     un-verified review. That is intentional and logged at `error` level, but the PR itself carries
     no signal that a pass was skipped.
  3. Finalize gets `MAX_FINALIZE_CONTINUATIONS = 3` (`:157`) and then terminally fails
     (`:721-730`); the check-run reconciler (`src/server/core/job-recovery.ts:34-115`) is the only
     backstop that closes the status check.
- Safe modification: when a pass fails open, record it in the posted review body so the reader
  knows the critic/verify pass did not run. Leave the constants alone.

---

## Scaling Limits

**Job admission concurrency is a check-then-claim race:** [TRADEOFF, documented]
- Current capacity: `REVIEW_CONCURRENCY_LIMITS[concurrencyLevel]`, gated only for jobs in status
  `'queued'` (`src/server/core/review.ts:447-456`).
- Limit: `getOtherRunningJobsCount` is read before the lease claim, so the count can be stale and
  the effective limit exceeded transiently.
- Why this is deliberate, not a bug: the comment at `:442-446` states that re-gating an
  already-`running` job would make in-flight jobs retry forever *without* incrementing the
  continuation counter — the lease would go stale and recovery would force-fail them.
  Admission-only gating is the correct posture; the over-count is the accepted cost.

**Maintenance sweep processes one job per invocation:** [RUNTIME]
- `completeTerminalCheckRuns` hardcodes a limit of 1 (`src/server/core/job-recovery.ts:38`) because
  each reconciliation costs several subrequests (KV + provider API + Hyperdrive). With a 2-minute
  cron, a backlog of N stuck check runs takes ~2N minutes to drain.
- Scaling path: batch by repository and reuse one adapter per repo, then raise the limit — the
  current cost is dominated by re-constructing `VcsService.forRepo` per job (`:64-71`).

---

## Provider Parity (GitHub vs Bitbucket)

Checked `src/server/vcs/github.ts`, `src/server/vcs/bitbucket.ts`, `src/server/vcs/types.ts`.
**Capability differences are flagged, not silently GitHub-only** — this is in good shape:

- `capabilities` is a **required** interface member, so no adapter can omit it
  (`src/server/vcs/types.ts:119-127`), with `supportsMermaid`, `supportsThreadListing`,
  `supportsThreadResolution` (`:103-105`). Bitbucket declares `supportsMermaid: false` and an
  observed-downgrade `supportsThreadResolution` (`src/server/vcs/bitbucket.ts:130-134`).
- Labels are absent from Bitbucket by design: the interface makes `labels?` optional
  (`src/server/vcs/types.ts:326-330`) so callers branch on `if (vcs.labels)` rather than no-op
  silently (`src/server/vcs/bitbucket.ts:137-139`).
- Status checks are unified behind `createStatusCheck`/`updateStatusCheck` with a provider-opaque
  `ref` (`src/server/vcs/bitbucket.ts:321-393`), and the maintenance sweep routes through
  `VcsService.forRepo` rather than constructing a GitHub service directly
  (`src/server/core/job-recovery.ts:52-71`).

**Residual trap (documented, not enforced):** inline-comment coordinates are **not**
interchangeable across providers — GitHub anchors by diff `position` and reports a re-derived
`line`; Bitbucket anchors by `line` and reports `position: null`
(`src/server/vcs/types.ts:304-313`). The docstring names matching a GitHub comment on `line` as the
exact defect `G-28-3` records. Any new consumer of `getInlineCommentDetails` must select the
coordinate per provider. Consider making the return type a discriminated union on provider so the
compiler enforces this instead of a comment.

**Largest real parity gap — Bitbucket auto-review jobs ignore per-repo `review` config:** [DEFECT]
- `src/server/routes/webhook-bitbucket.ts:233-240` builds the job's `configSnapshot` from
  `defaultRepoConfig` plus the global model strategy plus **only** `review.interactive` from the
  repo row. The comment at `:215-231` explains why `loadRepoConfig` is avoided (its
  `getOrCreateRepository` side effect is GitHub-shaped and would create a spurious
  `vcs_provider='github'` row).
- Consequence: every other per-repo `review` setting a Bitbucket user configures —
  `skip_files`, `max_files`, `max_comments`, `min_confidence`, `min_severity`, `custom_rules`,
  and all pass toggles — is ignored on the **auto** path. The comment branch deliberately *does*
  load the full `review` block (`:262-267`), which makes the asymmetry easy to miss.
- Fix approach: extract a provider-agnostic `loadRepoConfigByRepositoryId` that reads the config by
  the authoritative `repositoryId` and skips the GitHub-shaped repository upsert, then use it on
  both branches.

---

## Test Coverage Gaps

**Heartbeat lease loss:**
- What's not tested: a worker whose lease is stolen mid-phase continuing to write results.
- Files: `src/server/db/jobs.ts:782-800`, `src/server/core/review.ts:3117-3123`
- Risk: the dual-ownership window above stays invisible.
- Priority: High

**Config default drift:**
- What's not tested: that `repoConfigSchema.parse({})` contains every key declared in
  `reviewConfigSchema` — the exact failure mode the three-site duplication invites.
- Files: `src/shared/schema.ts:118-347`, `:1536`
- Priority: High (cheap test, live regression risk)

**Recovered-job phase:**
- What's not tested: that a job recovered from `finalize` resumes somewhere sane.
- Files: `src/server/core/job-recovery.ts:15`, `src/server/core/review.ts:783`
- Priority: Medium

**Zero-file chunks at budget exhaustion:**
- What's not tested: `budgetAwareFileLimit(remainingSafeBudget < 5, n) === 0` and the resulting
  no-progress reschedule crossing the continuation ceiling.
- Files: `src/server/core/review.ts:223-226`, `:598-624`
- Priority: Medium

**Non-PR Bitbucket events:**
- What's not tested: `POST /webhook/bitbucket` with `X-Event-Key: repo:push`. The current 400 is
  unasserted, so fixing the projection would not be caught either way.
- Files: `src/server/routes/webhook-bitbucket.ts:66-95`
- Priority: Medium

**No linter, and `npm test` does not typecheck:**
- There is no `eslint.config.*` / `.eslintrc*` / `.prettierrc*` in the repo, and `npm test` runs no
  lint step. `tsc --noEmit` (`npm run typecheck`) is the only static gate — and Vitest does **not**
  typecheck, so `npm test` passing does not imply the code compiles. Always run
  `npm run typecheck` alongside `npm test`.
- Priority: Low (a real gap, but the codebase is internally consistent without it)

---

*Concerns audit: 2026-07-27*
