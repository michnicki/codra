---
phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
plan: 32-04
subsystem: api
tags: [webhook, bitbucket, env-vars, dead-code, tech-debt]

requires:
  - phase: 31
    provides: WS-01 workspace-level Bitbucket token/webhook (finalize endpoint with webhook URL derivation)
provides:
  - Webhook URL derived from APP_URL instead of request origin
  - APP_URL guard preventing "undefined/webhook/bitbucket" string
  - Repo-slug validation documented as accepted risk (no behavior change)
  - Unused workspace credential exports deleted
affects: [repos, workspace-credentials, bitbucket-webhook]

tech-stack:
  added: []
  patterns: [APP_URL guard for webhook URL construction]

key-files:
  created: []
  modified:
    - src/server/routes/api/repos.ts - Webhook URL fix + APP_URL guard + accepted-risk comment
    - src/server/db/vcs-workspace-credentials.ts - Unused exports deleted
    - test/vcs-workspace-credentials.spec.ts - Removed tests for deleted exports

key-decisions:
  - "Webhook URL uses c.env.APP_URL instead of new URL(c.req.url).origin — prevents CDN/proxy URL influence"
  - "APP_URL guard throws explicit error if undefined rather than silently producing bad URL"
  - "Repo-slug validation documented as accepted risk — no behavior change per review consensus"
  - "Deleted unused exports over intentional-export comments — can be re-added from git history"

patterns-established:
  - "APP_URL guard pattern: check c.env.APP_URL before constructing URLs from it"

requirements-completed:
  - TECHDEBT-32

coverage:
  - id: D1
    description: "Webhook URL derived from APP_URL with guard against undefined"
    requirement: TECHDEBT-32
    verification:
      - kind: automated
        ref: "grep -c 'new URL(c.req.url).origin' src/server/routes/api/repos.ts returns 0"
        status: pass
      - kind: automated
        ref: "npm run typecheck"
        status: pass
    human_judgment: false
  - id: D2
    description: "Repo-slug validation documented as accepted risk"
    requirement: TECHDEBT-32
    verification:
      - kind: automated
        ref: "grep 'Accepted risk' src/server/routes/api/repos.ts"
        status: pass
      - kind: automated
        ref: "npm run typecheck"
        status: pass
    human_judgment: false
  - id: D3
    description: "Unused exports listVcsWorkspaceCredentials and deleteVcsWorkspaceCredential deleted"
    requirement: TECHDEBT-32
    verification:
      - kind: automated
        ref: "grep -c 'listVcsWorkspaceCredentials\\|deleteVcsWorkspaceCredential' src/server/db/vcs-workspace-credentials.ts returns 0"
        status: pass
      - kind: automated
        ref: "npm run typecheck"
        status: pass
    human_judgment: false
  - id: D4
    description: "Stale-discovery UI gap assessed — no edit-credential flow for workspace credentials"
    requirement: TECHDEBT-32
    verification:
      - kind: manual_procedural
        ref: "Reviewed vcs-credentials.tsx (has edit for per-repo) and add-bitbucket-workspace.tsx (no edit flow)"
        status: pass
    human_judgment: true
    rationale: "Assessment of whether edit-credential flow exists requires reading client pages — deferred until flow is built"

duration: 8min
completed: 2026-07-31
status: complete
---

# Plan 32-04: WS-01 warnings — webhook URL, repo-slug accepted risk, stale UI, unused exports

**Webhook URL derived from APP_URL with undefined guard, repo-slug validation documented as accepted risk, and unused workspace credential exports deleted**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-31T10:13:00Z
- **Completed:** 2026-07-31T10:21:00Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Webhook URL now derived from `c.env.APP_URL` instead of `new URL(c.req.url).origin`, preventing CDN/proxy URL influence
- APP_URL guard throws explicit error if the env var is undefined, preventing silent "undefined/webhook/bitbucket" string
- Repo-slug validation documented as accepted risk near the `selectedRepoSlugs` iteration — no behavior change
- Deleted `listVcsWorkspaceCredentials` and `deleteVcsWorkspaceCredential` (dead code, never imported) plus their test cases
- Stale-discovery UI gap assessed: no edit-credential flow exists for workspace credentials (deferred)

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix webhook URL derivation with APP_URL guard** - `dc472db` (fix) — also includes Task 2 accepted-risk comment (same file, both edits before first commit)
2. **Task 2: Document repo-slug validation as accepted risk** - `dc472db` (docs) — committed with Task 1
3. **Task 3: Delete unused exports** - `57803c7` (refactor)

**Plan metadata:** (included in task commits)

## Files Created/Modified
- `src/server/routes/api/repos.ts` - Webhook URL fix (APP_URL), APP_URL guard, accepted-risk comment for repo-slug validation
- `src/server/db/vcs-workspace-credentials.ts` - Deleted `listVcsWorkspaceCredentials` and `deleteVcsWorkspaceCredential`
- `test/vcs-workspace-credentials.spec.ts` - Removed test cases for deleted exports, cleaned up imports

## Decisions Made
- Webhook URL uses `c.env.APP_URL` instead of `new URL(c.req.url).origin` — prevents CDN/proxy header influence (T-32-04-01)
- APP_URL guard throws explicit error rather than silently producing bad URL (T-32-04-02)
- Repo-slug validation documented as accepted risk — no behavior change per review consensus (both reviewers MEDIUM)
- Deleted unused exports over intentional-export comments — prefer deletion, re-add from git history if needed

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Pre-existing test infrastructure issue: `test/review-flow.spec.ts` fails with Postgres "too many clients already" connection pool exhaustion. Not related to these changes. `npm run typecheck` passes; specific tests for modified code pass when database is available.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- WS-01 warnings addressed; ready for remaining phase 32 plans
- Stale-discovery UI gap documented as deferred until an edit-credential flow is built for workspace credentials

---
*Phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd*
*Completed: 2026-07-31*
