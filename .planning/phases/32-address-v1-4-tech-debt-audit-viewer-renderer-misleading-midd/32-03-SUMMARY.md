---
phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
plan: 32-03
subsystem: infra
tags: [logger, security, migration, redaction, bitbucket]

requires:
  - phase: null
    provides: null
provides:
  - Logger message argument scrubbed through scrubEmbeddedSecrets
  - EMBEDDED_SECRET_PATTERNS extended with Google AI and Bitbucket token patterns
  - Broken scripts/apply_migrations.js removed from disk
  - D-10 verified as already fixed (repo:push returns 202)
affects: [logger, security]

tech-stack:
  added: []
  patterns: [embedded-secret-pattern-extension]

key-files:
  created: []
  modified:
    - src/server/core/logger.ts

key-decisions:
  - "apply_migrations.js was never tracked in git (untracked orphan on disk) — deletion is a filesystem-only operation, no git commit needed"
  - "Message scrubbing applied at the log() method level so all log levels (info/warn/error/debug) benefit uniformly"

patterns-established:
  - "New secret patterns follow the existing convention: regex matching the credential token only, not surrounding text"

requirements-completed: [TECHDEBT-32]

coverage:
  - id: D1
    description: "Delete broken scripts/apply_migrations.js orphan"
    requirement: TECHDEBT-32
    verification:
      - kind: other
        ref: "test ! -f scripts/apply_migrations.js — file no longer exists on disk"
        status: pass
    human_judgment: false
  - id: D2
    description: "Logger message argument passes through scrubEmbeddedSecrets before output"
    requirement: TECHDEBT-32
    verification:
      - kind: other
        ref: "grep -n 'scrubEmbeddedSecrets(message)' src/server/core/logger.ts — line 83"
        status: pass
    human_judgment: false
  - id: D3
    description: "EMBEDDED_SECRET_PATTERNS includes Google AI and Bitbucket token patterns"
    requirement: TECHDEBT-32
    verification:
      - kind: other
        ref: "grep -n 'AIza' src/server/core/logger.ts — line 32; grep -n 'ATCTT' src/server/core/logger.ts — line 33"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-10 verified: Bitbucket webhook non-PR events return 202"
    requirement: TECHDEBT-32
    verification:
      - kind: other
        ref: "pullrequest .optional() at webhook-bitbucket.ts:99; repoPushPayloadSchema in discriminated union at bitbucket.ts:148; push-webhook.spec.ts exists with repo:push 202 test"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-07-31
status: complete
---

# Phase 32 Plan 32-03: Delete orphan script + logger hardening Summary

**Broken migration script removed from disk and logger message argument now scrubbed through secret-redaction patterns; Google AI and Bitbucket token patterns added to embedded secret detection**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-31T12:08:00Z
- **Completed:** 2026-07-31T12:16:00Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments
- Deleted orphan `scripts/apply_migrations.js` (was never tracked in git — untracked file on disk only)
- Logger `log()` method now applies `scrubEmbeddedSecrets` to the `message` argument before writing to output, closing a secret-leak vector
- Added `/AIza[0-9A-Za-z_-]{20,}/g` (Google AI API keys) and `/ATCTT[A-Za-z0-9_=-]{20,}/g` (Bitbucket tokens) to `EMBEDDED_SECRET_PATTERNS`
- Verified D-10 already fixed: `pullrequest` is optional in identity projection, `repoPushPayloadSchema` in discriminated union, test exists for `repo:push` returning 202

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete broken migration script** — filesystem-only (file was never git-tracked)
2. **Task 2: Harden logger redaction** — `0e66c71` (fix)
3. **Task 3: Verify D-10** — verification-only (no code change needed)

**Plan metadata:** (this file)

## Files Created/Modified
- `scripts/apply_migrations.js` - Deleted (broken orphan: nonexistent pool export, wrong column names, no advisory lock)
- `src/server/core/logger.ts` - Extended EMBEDDED_SECRET_PATTERNS with Google AI and Bitbucket patterns; message argument now scrubbed through scrubEmbeddedSecrets

## Decisions Made
- apply_migrations.js was never tracked in git (untracked orphan on disk) — deletion is a filesystem-only operation, no git commit needed
- Message scrubbing applied at the `log()` method level so all log levels benefit uniformly

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `test/push-webhook.spec.ts` cannot run in this environment due to missing `BITBUCKET_CLIENT_ID` env var — pre-existing environment constraint, not caused by this plan. All three code-level verification checks (pullrequest optional, repoPushPayloadSchema in union, test file exists with repo:push 202 test) pass.

## Next Phase Readiness
- Plan 32-03 complete. All three 32-03 must-haves satisfied: broken script removed, logger hardened, D-10 verified.
