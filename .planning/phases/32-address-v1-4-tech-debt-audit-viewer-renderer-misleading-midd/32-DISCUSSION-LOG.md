# Phase 32: Address v1.4 tech debt - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-31
**Phase:** 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
**Areas discussed:** Audit viewer renderer, Test-hygiene scope, Phase 31 warnings scope, Stale planning docs scope, Additional CONCERNS items

---

## Audit Viewer Renderer (W-1)

| Option | Description | Selected |
|--------|-------------|----------|
| Fix the missing case | Add `case 'learned_rule_suppressed'` to audit-trail-viewer.tsx | |
| Already resolved | W-1 was fixed by quick task 260727-hvc before this phase | ✓ |

**User's choice:** All areas selected for discussion
**Notes:** Upon investigation, W-1 is already resolved. The `learned_rule_suppressed` case exists at `audit-trail-viewer.tsx:223-242` (commit `c94aeb6`). The v1.4 milestone audit ran before this fix landed.

---

## Test-Hygiene Scope

| Option | Description | Selected |
|--------|-------------|----------|
| withRetry only | Just fix the 2 withRetry backoff test cases (~6.4s savings) | ✓ |
| withRetry + config drift test | Also add the cheap config-default drift test | |
| Broad test coverage pass | withRetry + config drift + heartbeat lease-loss + recovered-job | |
| Full CONCERNS.md coverage | Address all CONCERNS.md test gaps | |

**User's choice:** withRetry only
**Notes:** User chose minimal test scope. Config-default drift test was later added as a separate area (D-07). Heartbeat lease-loss and recovered-job tests deferred.

---

## Phase 31 (WS-01) Warnings Scope

| Option | Description | Selected |
|--------|-------------|----------|
| All 4 warnings | Fix webhook URL, repo-slug validation, stale-discovery UI, unused exports | ✓ |
| Code defects only | Fix webhook URL and repo-slug only; defer UI gap and exports | |
| Defer all WS-01 | Defer to a future phase | |

**User's choice:** All 4 warnings
**Notes:** User wants complete WS-01 cleanup in this phase.

---

## Stale Planning Docs Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Tracking tables only | Reconcile ROADMAP traceability, REQUIREMENTS status, STATE counters | |
| Tracking + PROJECT.md | Also update PROJECT.md Current State section | |
| Full documentation sweep | All of the above + clean up resolved CONCERNS.md items | ✓ |

**User's choice:** Full documentation sweep
**Notes:** User wants comprehensive doc reconciliation including marking resolved CONCERNS.md items.

---

## Additional CONCERNS.md Items

| Option | Description | Selected |
|--------|-------------|----------|
| Config-default drift test | Assert repoConfigSchema.parse({}) deep-equals expected object | ✓ |
| Delete broken migration script | Delete scripts/apply_migrations.js | ✓ |
| Logger redaction hardening | Redact message arg + extend secret patterns | ✓ |
| Webhook route non-PR events | Return 202 instead of 400 for non-PR Bitbucket events | ✓ |

**User's choice:** All 4 items selected
**Notes:** User wants all CONCERNS.md items addressed. These were presented as additional gray areas after the primary 4 areas were discussed.

---

## Claude's Discretion

- Exact test mocking strategy for withRetry (vi.useFakeTimers vs. injecting a delay override)
- Stale-discovery UI gap: minimal adequate fix (text note vs. full UI indicator)
- Whether unused workspace-credential exports should be deleted or kept with comments
- Config-default drift test structure (monolithic vs. per-toggle-block)
- Whether webhook route fix needs a new test case or can extend existing structure

## Deferred Ideas

- `review.ts` extraction (3,790-line module split) — acknowledged tradeoff
- Heartbeat lease-loss test — deferred per user's minimal test scope choice
- Recovered-job phase test — deferred
- Zero-file chunks at budget exhaustion test — deferred
- PR description dropped by file-review prompt — out of scope (behavior change)
- Bitbucket auto-review jobs ignore per-repo config — too large for tech-debt cleanup
