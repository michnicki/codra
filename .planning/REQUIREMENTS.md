# Requirements — v1.5 PRD Parity

## Milestone: v1.5 — PRD Parity (Agentic Context, Outbound Events & Quality Fixes)

**Goal:** Close the remaining 8 gaps between the review-engine PRD and Codra's implementation.

---

### Quality Fixes (Quick Wins)

- [x] **PRD-01**: Per-comment 422 fallback — on batch review HTTP 422 from GitHub/Bitbucket, retry each inline comment individually via the review API, skip any individual 422 with a warning log, track which comments were posted vs skipped (FR-031)
- [ ] **PRD-02**: Title truncation to 80 chars — truncate `title` field of parsed review comments exceeding 80 characters; clear `suggestion` to null when it equals `existingCode` after trim (FR-153/154)
- [x] **PRD-03**: Mermaid label sanitization — repair nested double quotes in walkthrough Mermaid diagram labels (e.g. `engine["core/"engine.py""]` → `engine["core/engine.py"]`) (FR-155)

### Context Enhancement

- [ ] **PRD-04**: File history / decision archaeology — fetch per-touched-file commit history (up to 5 commits per file) via VCS provider, inject as context into review prompts (FR-114)
- [ ] **PRD-05**: .review.yaml per-repo configuration — discover and parse `.review.yaml` / `.review.yml` from repo root, merge with DB-stored config (YAML overrides DB), validate against schema (§15)

### Major Features

- [ ] **PRD-06**: Agentic tools — implement read_file and grep_repo tool loop that runs up to 6 hops before structured review when JIT context flags the repo as needing on-demand reads; enforce limits (12KB reads, 30 grep hits, 240 bytes/hit, 50KB total, 15 files max); gate on `config.review.agentic_tools` (FR-131/132)
- [ ] **PRD-07**: Outbound webhook event delivery — fire events (review.completed, review.high_severity, review.failed, indexing.completed) to registered webhook URLs; HTTPS-only with SSRF guard, 5s timeout, 1 transient retry, no 4xx retry, non-blocking (FR-401)

### Advanced

- [ ] **PRD-08**: Blast radius / cross-repo dependencies — compute related repositories from package manifests (package.json, go.mod, requirements.txt), filter dependents by visibility (private repos hidden for public reviews), inject dependency context into review prompts (FR-113)

---

## Traceability

| Requirement | PRD Reference | Priority | Estimated Effort |
|-------------|---------------|----------|-----------------|
| PRD-01 | FR-031 | High | 1 day |
| PRD-02 | FR-153/154 | Medium | 1 day |
| PRD-03 | FR-155 | Low | 0.5 day |
| PRD-04 | FR-114 | Low | 2 days |
| PRD-05 | §15 | Low | 2 days |
| PRD-06 | FR-131/132 | Medium | 1 week |
| PRD-07 | FR-401 | Medium | 1 week |
| PRD-08 | FR-113 | Low | 2+ weeks |
