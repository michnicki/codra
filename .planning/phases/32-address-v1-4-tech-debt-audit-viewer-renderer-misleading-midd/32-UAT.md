---
status: complete
phase: 32-address-v1-4-tech-debt-audit-viewer-renderer-misleading-midd
source: 32-01-SUMMARY.md, 32-02-SUMMARY.md, 32-03-SUMMARY.md, 32-04-SUMMARY.md, 32-05-SUMMARY.md, 32-06-SUMMARY.md
started: 2026-07-31T11:17:14Z
updated: 2026-07-31T11:18:00Z
---

## Current Test

[testing complete]

## Tests

### 1. FileReviewPass type used consistently in getFileReviewsForJobs
expected: No hardcoded 'main' | 'security' | 'cross_file_security' union in file-reviews.ts
result: pass
source: automated
coverage_id: D1-32-01

### 2. Middleware comments accurately describe group-level /api/* protection
expected: No 'explicit.*requireSession' claims in repos.ts
result: pass
source: automated
coverage_id: D2-32-01

### 3. nextPhaseAfterCrossFileSecurity selector unit tests (6 cases)
expected: All branch paths covered in phase-routing.spec.ts
result: pass
source: automated
coverage_id: D1-32-02

### 4. Config-default drift detection covering all leaf nodes
expected: Per-field assertions for repoConfigSchema.parse({}) in schema-contract-inertness.spec.ts
result: pass
source: automated
coverage_id: D2-32-02

### 5. Delete broken scripts/apply_migrations.js orphan
expected: File no longer exists on disk
result: pass
source: automated
coverage_id: D1-32-03

### 6. Logger message argument passes through scrubEmbeddedSecrets
expected: scrubEmbeddedSecrets(message) called in logger.ts log() method
result: pass
source: automated
coverage_id: D2-32-03

### 7. EMBEDDED_SECRET_PATTERNS includes Google AI and Bitbucket token patterns
expected: AIza and ATCTT regex patterns in logger.ts
result: pass
source: automated
coverage_id: D3-32-03

### 8. D-10 Bitbucket webhook non-PR events return 202
expected: repo:push payload accepted with 202
result: pass
source: automated
coverage_id: D4-32-03

### 9. Webhook URL derived from APP_URL with guard against undefined
expected: No request-origin URL construction, explicit APP_URL guard
result: pass
source: automated
coverage_id: D1-32-04

### 10. Repo-slug validation documented as accepted risk
expected: Comment in repos.ts explaining accepted risk
result: pass
source: automated
coverage_id: D2-32-04

### 11. Unused workspace credential exports deleted
expected: No listVcsWorkspaceCredentials or deleteVcsWorkspaceCredential in vcs-workspace-credentials.ts
result: pass
source: automated
coverage_id: D3-32-04

### 12. Audit-trail-viewer renders learned_rule_suppressed events
expected: case 'learned_rule_suppressed' in audit-trail-viewer.tsx
result: pass
source: automated
coverage_id: D1-32-05

### 13. All withRetry exponential backoff tests use fake timers
expected: vi.useFakeTimers() in model-service.spec.ts and bitbucket-client.spec.ts
result: pass
source: automated
coverage_id: D2-32-05

### 14. ROADMAP.md Phase 32 fully documented with 6 plans all checked
expected: No 'To be planned' text, all 32-01 through 32-06 checked
result: pass
source: automated
coverage_id: D1-32-06

### 15. REQUIREMENTS.md traceability table current
expected: All 6 v1.4 requirements show Done
result: pass
source: automated
coverage_id: D2-32-06

### 16. Typecheck passes with zero errors
expected: tsc --noEmit exits cleanly
result: pass
source: automated
coverage_id: verification

## Summary

total: 16
passed: 16
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none]
