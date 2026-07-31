# Roadmap — v1.5 PRD Parity

## Milestone: v1.5 — PRD Parity (Agentic Context, Outbound Events & Quality Fixes)

**8 requirements** | **4 phases** | All covered

---

| Phase | Name | Goal | Requirements | Success Criteria |
|-------|------|------|--------------|-----------------|
| 33 | Quality Fixes | 4/4 | Complete   | 2026-07-31 |
| 34 | Context Enhancement | File history and .review.yaml config | PRD-04, PRD-05 | 1. File history fetched and injected into prompts 2. .review.yaml discovered and merged with DB config |
| 35 | Agentic Tools | read_file/grep_repo tool loop for unindexed repos | PRD-06 | 1. Tool loop runs up to 6 hops 2. Byte limits enforced 3. Falls back to single review on failure 4. Config-gated |
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
5. Gated on `config.review.agentic_tools` (default: enabled)

**Key files:**

- `src/server/core/agentic-tools.ts` — New module: tool executor with bounds
- `src/server/services/model.ts` — Add `completeWithTools()` support
- `src/server/core/review.ts` — Wire agentic loop before file review
- `src/shared/schema.ts` — Add `agentic_tools` config field

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
