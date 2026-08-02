# Roadmap — v1.5 PRD Parity

## Milestone: v1.5 — PRD Parity (Agentic Context, Outbound Events & Quality Fixes)

**8 requirements** | **4 phases** | All covered

---

| Phase | Name | Goal | Requirements | Success Criteria |
|-------|------|------|--------------|-----------------|
| 33 | Quality Fixes | 4/4 | Complete    | 2026-07-31 |
| 34 | Context Enhancement | 3/3 | Complete    | 2026-08-01 |
| 35 | Agentic Tools | 6/6 | Complete   | 2026-08-02 |
| 36 | Outbound Webhooks + Blast Radius | Event delivery and cross-repo dependency tracking | PRD-07, PRD-08 | 1. Events fire on review completion/failure 2. HTTPS + SSRF guard + 5s timeout 3. Blast radius computed from manifests 4. Visibility filtering works |

---

## Phase Details

### Phase 33: Quality Fixes

**Goal:** Fix three small but important quality gaps in the review pipeline.

**Requirements:** PRD-01, PRD-02, PRD-03

**Success criteria:**

1. On GitHub/Bitbucket batch review 422, each inline comment is retried individually; skipped comments are logged with warning
2. Parsed review comment `title` is truncated to 80 characters
3. `suggestion` equal to `existingCode` (after trim) is cleared to null
4. Mermaid diagram labels with nested double quotes are repaired

**Key files:**

- `src/server/core/github.ts` — Replace batch-discard with per-comment retry (lines 867-885)
- `src/server/core/model-output.ts` — Add title truncation + suggestion validation in parse pipeline
- `src/server/core/model-output.ts` — Add Mermaid label sanitizer in `parseWalkthroughDiagram`

---

### Phase 34: Context Enhancement

**Goal:** Enrich review context with file history and support per-repo YAML configuration.

**Requirements:** PRD-04, PRD-05

**Success criteria:**

1. Per-touched-file commit history (up to 5 commits) is fetched via VCS provider and included in review prompts
2. `.review.yaml` / `.review.yml` in repo root is discovered, parsed, and merged with DB config (YAML overrides DB)
3. Merged config validates against existing Zod schema

**Key files:**

- `src/server/services/vcs.ts` — Add `getFileHistory(path, maxCommits)` to VCS providers
- `src/server/core/github.ts` / `src/server/vcs/bitbucket.ts` — Implement file history fetch
- `src/server/core/config.ts` — Add YAML file discovery and merging
- `src/shared/schema.ts` — Ensure config schema supports YAML-parsed fields

---

### Phase 35: Agentic Tools

**Goal:** Implement an agentic tool loop that provides on-demand cross-file context for repos without indexed summaries.

**Requirements:** PRD-06

**Success criteria:**

1. `read_file` and `grep_repo` tool schemas defined as OpenAI-compatible function definitions
2. Agentic executor runs up to 6 hops, feeding tool results back to the model
3. Byte limits enforced: 12KB per read, 30 grep hits, 240 bytes/hit, 50KB total, 15 files max
4. Falls back to single review call if loop returns no content
5. Gated on `config.review.agentic_tools` (default: **disabled**) and skipped when the repo already has a built code index

> **Amended at plan time (35-CONTEXT.md D-15).** Criterion 5 previously read "default: enabled".
> D-13 deliberately ships the toggle default-OFF, matching the `file_history` / `learning`
> convention: the loop spends real money and subrequests on every review, and existing instances
> must not start making extra model calls on upgrade. D-14 adds the second gate — an indexed repo
> already has cross-file context, so the loop is redundant there.

> **Amended at replan (35-REVIEWS.md, OpenCode Concern #3 + Suggestion #2).** Criterion 4's fallback is
> also the **expected steady state on Bitbucket**, and the phase gate must not read that as a
> regression. `grep_repo` is backed by provider code-search APIs (D-05); Atlassian has confirmed that
> Workspace and Repository Access Tokens — the only credential class Codra stores — cannot call the
> Bitbucket code-search endpoint (BCLOUD-22586), and that endpoint is marked deprecated with a removal
> date of **2026-11-01** and no published replacement. A Bitbucket job is therefore expected to report
> `grep_supported: false` and run `read_file`-only. That is the designed D-05 degradation, verified by a
> passing test case in `35-04-PLAN.md` and by a blocking live-credential checkpoint before ship — not a
> defect, and not a criterion-4 failure. GitHub is where `grep_repo` is live (`35-03-PLAN.md`).

**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 35-01-PLAN.md — Tracer: end-to-end bounded agentic-context phase (read_file slice)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 35-02-PLAN.md — Integration proof: pipeline behaviours and toggle-off byte identity
- [x] 35-03-PLAN.md — GitHub code-search backing for `grep_repo`
- [x] 35-04-PLAN.md — Bitbucket code-search backing and its designed degradation
- [x] 35-05-PLAN.md — `.review.yaml` toggle path and the Tier-1 reference corpus

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 35-06-PLAN.md — `agentic_context` audit event, redaction, and dashboard visibility

**Key files:**

- `src/server/core/agentic-tools.ts` — New module: pure tool executor with the six FR-132 bounds
- `src/server/prompts/agentic-context.ts` — New module: protocol prompts and untrusted-output fencing
- `src/server/core/review.ts` — New `agentic_context` phase between prepare and review
- `src/server/vcs/types.ts` — New optional `searchCode?()` seam backing `grep_repo`
- `src/shared/schema.ts` — Add `agentic_tools` config field, the phase value, and the audit arm

> **Note on `completeWithTools()`.** The original key-files list named
> `src/server/services/model.ts — Add completeWithTools() support`. D-01 defers native provider
> function-calling (four adapters, four response shapes, Workers AI weakest) and drives the loop over
> the existing `ModelService.callVerifierRaw()` text path instead. `services/model.ts` is therefore
> **not** modified by this phase; D-02 keeps the OpenAI-compatible tool definitions drop-in for a
> future native path.

---

### Phase 36: Outbound Webhooks + Blast Radius

**Goal:** Enable external integrations via outbound event delivery and cross-repo dependency awareness.

**Requirements:** PRD-07, PRD-08

**Success criteria:**

1. Outbound webhooks fire for: review.completed, review.high_severity, review.failed, indexing.completed
2. Delivery uses HTTPS (with SSRF guard), 5s timeout, 1 transient retry, no 4xx retry
3. Events fire asynchronously — delivery failures never affect the review
4. Blast radius computed from package manifests (package.json, go.mod, requirements.txt)
5. Dependents filtered by visibility (private repos hidden for public reviews)
6. Both features config-gated (default: enabled)

**Key files:**

- `src/server/core/outbound-webhooks.ts` — New module: event delivery
- `src/server/db/outbound-webhooks.ts` — New module: webhook registration CRUD
- `src/server/core/blast-radius.ts` — New module: dependency graph computation
- `src/server/services/vcs.ts` — Add `getRepositoryTree()` for dependency discovery
- `src/server/core/review.ts` — Wire events at review completion + blast radius into context
- `src/server/routes/api/settings.ts` — API endpoints for webhook management

---

## Traceability Matrix

| Requirement | Phase | Status |
|-------------|-------|--------|
| PRD-01 | 33 | Pending |
| PRD-02 | 33 | Pending |
| PRD-03 | 33 | Pending |
| PRD-04 | 34 | Pending |
| PRD-05 | 34 | Pending |
| PRD-06 | 35 | Pending |
| PRD-07 | 36 | Pending |
| PRD-08 | 36 | Pending |
