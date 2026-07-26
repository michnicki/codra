# Phase 26: EVID-02 Hard-drop evidence gate - Research

**Researched:** 2026-07-26
**Domain:** Review pipeline evidence validation, audit event shape, config-gated feature toggle
**Confidence:** HIGH

## Summary

This phase promotes the EVID-01 soft/audit-only evidence gate into a **hard-drop**: findings with hallucinated `existingCode` evidence are dropped from posted comments, not merely recorded in the audit trail. The re-check runs at finalize time using the same cleaned-hunk haystack approach EVID-01 uses at parse time (model-output.ts:435-550), but this time findings whose evidence is absent/not-in-hunk are **filtered from the candidate set** before dedup and posting. Config-gated with `evidence.hard_drop` (default false, per NREG-01), per-category opt-out via `evidence.hard_drop_exempt_categories` (default `["security"]`).

The phase is a natural consumer of WR-01's telemetry bound (Phase 21): EVID-03's aggregate `evidence_missing_summary` provides a reliable signal without flooding the ring buffer, so EVID-02 can safely use per-(file, pass) evidence quality data to make drop decisions.

**Primary recommendation:** Extract the evidence re-check from `model-output.ts` into a shared `core/evidence.ts` module; insert the hard-drop gate in `review.ts` finalize at line ~2183 (after `reviewedComments` is resolved, before `applyNoiseFilter` called at line 2288); follow the `evidence_missing_summary` schema/stage pattern for the new `evidence_hard_dropped` audit event.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The hard-drop gate runs in the finalize phase (`core/review.ts`), **before dedup runs**.
- **D-02:** Evidence is **re-checked at finalize time** using the same cleaned-hunk haystack approach from `model-output.ts:435` (whitespace-collapsed, orphan-remapped). Findings with absent/non-matching `existing_code` are dropped before the dedup step.
- **D-03:** Per-category opt-out is a **configurable string array**: `evidence.hard_drop_exempt_categories: string[]`. Default: `["security"]`.
- **D-04:** The opt-out is **category-only** — not severity-aware.
- **D-05:** A new **`evidence_hard_dropped`** audit event produced at finalize time, following the `evidence_missing_summary` pattern (Phase 21): `stage`, `file`, `pass`, `droppedCount`, `sample` (<=20 entries with `title`, `reason`), `timestamp`. Added to the `jobAuditEventSchema` discriminated union.
- **D-06:** Each sample entry carries a **reason field**: `'absent'` or `'not_in_hunk'`.
- **D-07:** Config lives in `repo_configs.parsed_json` under a new `evidence` key:
  ```typescript
  evidence: z.object({
    hard_drop: z.boolean().default(false),
    hard_drop_exempt_categories: z.array(z.string()).default(['security']),
  }).default({ hard_drop: false, hard_drop_exempt_categories: ['security'] })
  ```
- **D-08:** The toggle **IS the escape hatch**. No worker-level env var override.

### Claude's Discretion
- Whether to extract the evidence check from `model-output.ts:435-550` into a shared function in `core/diff.ts` or a new `core/evidence.ts`, vs. duplicating the logic inline in the finalize phase
- Exact `evidence_hard_dropped` schema shape — follow `evidence_missing_summary` precedent
- Where exactly in the finalize phase to insert the drop (before the dedup call)
- Dashboard config UI for the evidence section — follow existing boolean toggle + string-array patterns
- Test strategy: unit test for the re-check function, unit test for audit event emission, integration test in `review-flow.spec.ts`
- Whether `evidence_hard_dropped` event needs dashboard rendering in this phase

### Deferred Ideas (OUT OF SCOPE)
- None — all four areas (drop point, per-category opt-out, audit trail, config shape) were covered.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EVID-02 | Hard-drop findings with hallucinated `existingCode` evidence. Promote EVID-01 from soft/audit-only to hard-drop after v1.3 bounded telemetry provides a reliable signal. Config-gated (`evidence.hard_drop` default off). Per-category opt-out. Explainable via audit events. | Evidence check extraction (core/evidence.ts), finalize insertion point (before dedup), config shape (reviewConfigSchema), audit event shape (jobAuditEventSchema discriminated union). All patterns documented below. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Evidence re-check | API / Backend (core) | — | Pure function: given FileDiff[] and ParsedReviewComment[], returns filtered set. No I/O, service, or DB involvement. |
| Drop logic | API / Backend (core/review.ts) | — | The finalize phase owns the candidate-set assembly and posting pipeline. Insertion between reviewedComments resolution and applyNoiseFilter. |
| Audit event emission | API / Backend (core) | — | Single `appendJobAuditEvents` call per (file, pass) unit as the drop is computed. Follows recordUnitAudit pattern (best-effort). |
| Config toggle | API / Backend (schema.ts) | Dashboard (client) | Schema definition in repoConfigSchema; dashboard UI renders the toggle as a config form section. |
| Dashboard audit rendering | Browser / Client | — | Audit-trail viewer renders the `evidence_hard_dropped` event. Minimal renderer or defer to follow-up phase. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zod | ^4.3.6 | Schema definition for config block + audit event shape | Existing contract-first pattern; all data shapes defined in schema.ts before implementation |
| postgres (postgres.js) | ^3.4.9 | Raw SQL queries | Existing DB layer; evidence check involves no new queries (in-memory re-check) |
| TypeScript | ^6.0.2 | Type safety | Strict mode, entire codebase |

### Supporting
No new npm dependencies required. The evidence check logic uses native string operations (`.replace()`, `.includes()`, `.toLowerCase()`) — all already in use in `model-output.ts:282-310`.

**Installation:** None — zero new npm dependencies per standing requirement.
**Version verification:** No new packages to verify.

## Package Legitimacy Audit

> **Not required** — this phase installs zero external packages. All changes are additive schema edits, new core modules, and new prompts following the established zero-new-npm-deps convention.

| Package | Registry | Verdict | Disposition |
|---------|----------|---------|-------------|
| (none) | — | — | No packages to audit |

## Architecture Patterns

### System Architecture Diagram

```
Webhook (GitHub/Bitbucket)
    |
    v
Queue → Workflow (prepare → review → finalize)
                                  |
    +-----------------------------+
    |
    v
[finalize phase - review.ts:~2080]
    |
    |---1. Load reviews from file_reviews (via getFileReviewsForJobs)
    |---2. Resolve reviewedComments (criticResult.kept | security union | main flatMap)
    |---3. *** EVID-02: evidence hard-drop gate (INSERT HERE) ***
    |       |--- Build haystack from file hunks (FileDiff[].hunks.lines.content)
    |       |--- For each finding: check existingCode against haystack
    |       |--- Drop findings where evidence is absent/not_in_hunk
    |       |--- UNLESS finding.category is in hard_drop_exempt_categories
    |       |--- Emit evidence_hard_dropped audit event per (file, pass)
    |
    |---4. applyNoiseFilter (dedup, confidence, severity, cap)
    |---5. submitReview (post)
    |---6. Walkthrough edit, completeJob, cosmetics
```

### Recommended Project Structure

Changes are additive — no new folders needed:

```
src/
├── server/
│   ├── core/
│   │   ├── evidence.ts         # NEW: shared evidence re-check function
│   │   ├── model-output.ts     # MODIFY: extract evidence logic, import from evidence.ts
│   │   ├── audit.ts            # MODIFY: add buildEvidenceHardDropped builder
│   │   └── review.ts           # MODIFY: insert hard-drop gate in finalize phase
│   └── ...
├── shared/
│   └── schema.ts               # MODIFY: add evidence config block + evidence_hard_dropped event
└── client/
    ├── lib/
    │   └── audit-grouping.ts   # MODIFY: add evidence_hard_dropped to STAGE_ORDER + normalize mapping
    └── components/
        └── features/
            └── job-detail/
                └── audit-trail-viewer.tsx  # MODIFY: add renderer for evidence_hard_dropped (minimal)
```

### Pattern 1: Evidence Check Extraction (Claude's Discretion)

**What:** Extract the haystack construction + needle matching logic from `model-output.ts:435-550` into a shared pure function in `core/evidence.ts` so both the parse-time EVID-01 soft gate and the finalize-time EVID-02 hard-drop gate share the same logic.

**When to use:** RECOMMENDED — avoids duplicating the ~50 lines of haystack/normalization/matching logic. The function signature would be:

```typescript
// core/evidence.ts - NEW
export interface EvidenceCheckResult {
  /** Findings that passed the evidence check */
  kept: ParsedReviewComment[];
  /** Findings whose existing_code was absent or not found in the hunk */
  dropped: ParsedReviewComment[];
  /** Evidence-missing entries for audit event construction */
  entries: Array<{ path: string; line: number | null; title: string; reason: 'absent' | 'not_in_hunk' }>;
}

/**
 * Reusable evidence check: builds a cleaned-hunk haystack from file diffs and
 * tests each finding's existingCode against it. Returns kept + dropped sets and
 * audit entries.
 */
export function checkEvidence(
  files: FileDiff[],
  comments: ParsedReviewComment[],
  exemptCategories: string[],
): EvidenceCheckResult;
```

**Example usage in `model-output.ts` (soft gate):**
```typescript
const result = checkEvidence([file], parsed.findings.filter(Boolean).map(/* to ParsedReviewComment */), []);
// Don't actually drop — only accumulate audit entries
evidenceMissingEntries.push(...result.entries);
```

**Example usage in `review.ts` (hard-drop gate):**
```typescript
const exemptCategories = config.review.evidence?.hard_drop_exempt_categories ?? ['security'];
const evidenceResult = checkEvidence(files, reviewedComments, exemptCategories);
reviewedComments = evidenceResult.kept;
// Emit audit event per (file, pass)
for (const entry of /* group evidenceResult.entries by (file, pass) */) {
  recordEvidenceHardDrop(env, job.id, entry);
}
```

**Alternative:** Duplicate the ~50 lines inline in the finalize phase. Simpler (no new module) but violates DRY. Not recommended unless the extraction introduces circular-import problems.

### Pattern 2: Config Toggle Block (D-07)

**What:** Add `evidence` to `reviewConfigSchema` following the established toggle-block pattern (all Phase 7+).

**When to use:** Default-off toggle per NREG-01, default-exempt categories `["security"]`.

**Example:**
```typescript
// In reviewConfigSchema, alongside existing blocks (schema.ts:~244, before the closing })
evidence: z
  .object({
    hard_drop: z.boolean().default(false),
    hard_drop_exempt_categories: z.array(z.string()).default(['security']),
  })
  .default({ hard_drop: false, hard_drop_exempt_categories: ['security'] }),
```

**Also update the inline default** in `repoConfigSchema` (line ~296):
```typescript
review: reviewConfigSchema.default({
  // ... existing defaults unchanged, add:
  evidence: { hard_drop: false, hard_drop_exempt_categories: ['security'] },
}),
```

### Pattern 3: Audit Event Shape (D-05)

**What:** New `evidence_hard_dropped` variant in `jobAuditEventSchema` discriminated union, following the `evidence_missing_summary` pattern.

**When to use:** Additive variant — never reshape existing variants.

**Example:**
```typescript
// In jobAuditEventSchema discriminatedUnion (schema.ts:~953, after evidence_missing_summary)
z.object({
  stage: z.literal('evidence_hard_dropped'),
  file: z.string(),
  pass: fileReviewPassSchema,
  droppedCount: z.number().int().min(0),
  sample: z.array(
    z.object({
      path: z.string(),
      line: z.number().nullable().optional(),
      title: z.string().max(100),  // AUD-01: redactFindingTitle applied at production time
      reason: z.enum(['absent', 'not_in_hunk']),
    }),
  ).max(20),
  timestamp: dateStringSchema,
}).passthrough(),
```

### Anti-Patterns to Avoid

- **Not extracting the evidence check:** Duplicating the haystack construction + needle matching inline in the finalize phase would create two subtly divergent implementations. The haystack logic has accrued edge cases (WR-02 diff-marker stripping, normalizeForEvidence case-insensitivity) that must be identical in both paths.
- **Dropping after dedup:** Per D-01, the drop must run BEFORE dedup. Dropping after dedup risks a hallucinated evidence finding "winning" dedup over a legitimate one with similar title/body.
- **Severity-aware exempt logic:** Per D-04, opt-out is category-only, not severity-aware. Don't add severity-threshold logic in this phase.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Haystack normalization | Custom whitespace/case normalizer | `normalizeForEvidence` (model-output.ts:291) | Already extracted and tested; handles diff-line markers per WR-02 |
| Audit event append | Custom DB writer | `appendJobAuditEvents` (db/jobs.ts) | Existing ring-buffer logic with 500-event cap; use `recordUnitAudit` pattern |
| Finding title redaction | Custom title cap | `redactFindingTitle` (audit-redact.ts) | Phase 20.1 BLOCKER 1 established the privacy boundary; reuse for sample entry titles |
| Config loading/parsing | Custom config parser | `loadRepoConfig` + `normalizeRepoConfig` (db/repo-configs.ts) | Existing parseJsonColumn + spread-based normalizer handle new keys automatically |
| Diff fetching | Custom diff fetch | `getJobDiffFiles` (review.ts:3353) | Already called at finalize line 2082; provides parsed FileDiff[] with hunks ready for haystack |

**Key insight:** The evidence re-check is a pure transformation over already-loaded data. It does not need new DB queries, new service calls, or new persistence. The diff files are already fetched in finalize, and the `reviewedComments` are already loaded from `file_reviews`. The hard-drop gate slots into the existing pipeline as an in-memory filter step.

## Common Pitfalls

### Pitfall 1: Category comparison mismatch
**What goes wrong:** The exempt-category list contains user-friendly strings like `"security"`, but `ParsedReviewComment.category` uses the enum `reviewCategories` values. If the comparison is case-sensitive or includes unexpected formatting, exempt categories won't match and findings get incorrectly dropped.
**Why it happens:** The config value is a free-form string array (D-03), while `reviewCategories` is a const array: `['security', 'bugs', 'performance', 'correctness', 'quality']`. A config entry `"Security"` (capitalized) would fail an exact match.
**How to avoid:** Compare case-insensitively, or enforce lowercase normalization at the config write boundary (like the existing `workspace`/`repoSlug` `.trim().toLowerCase()` pattern in `schema.ts:1398`).
**Warning signs:** Evidence-hard-drop drops expected `security` findings — the exempt list isn't matching.

### Pitfall 2: Evidence re-check diverging from parse-time check
**What goes wrong:** The finalize-time re-check uses a slightly different haystack (different file set, different normalization) than the parse-time check, producing different results for the same finding. This erodes operator trust — "why did finalize drop this but parse-time recorded it as OK?"
**Why it happens:** Extract the check to `core/evidence.ts` with the exact same `normalizeForEvidence` + `stripLeadingDiffMarkers` + haystack-construction logic. If not extracted, two independently-maintained copies drift.
**How to avoid:** Extract the shared function (Claude's discretion, RECOMMENDED). The model-output.ts caller passes `findings` (pre-persist), the finalize caller passes `ParsedReviewComment[]` (post-persist with `.existingCode`), but the haystack logic is identical.
**Warning signs:** A finding passes the parse-time audit check (no `evidence_missing` event) but gets dropped at finalize, or vice versa.

### Pitfall 3: Inserting the drop at the wrong point in the pipeline
**What goes wrong:** Inserting the drop after `applyNoiseFilter` / dedup means the dedup runs on the full set including hallucinated-evidence findings. Per D-01, this is explicitly disallowed — a hallucinated finding could "win" dedup over a legitimate one.
**How to avoid:** Insert the drop at line ~2183 of `review.ts`, immediately after `reviewedComments` is resolved, before the `noiseFilterOptions` construction at line ~2280.
**Warning signs:** Dedup merges a hallucinated-evidence finding with a legitimate one, suppressing the legitimate one.

### Pitfall 4: Audit event duplication on finalize retry
**What goes wrong:** If a finalize invocation crashes after emitting the `evidence_hard_dropped` events but before `completeJob`, the next finalize retry re-emits the events, doubling the audit trail.
**Why it happens:** `appendJobAuditEvents` has no idempotency key — it always concatenates.
**How to avoid:** Follow the `!finalizeRetriedPastPost` gate (review.ts:2425) pattern. Position the evidence audit emission in the same best-effort, at-most-once block as the existing `recordFinalizeDrops` call. The evidence drop is idempotent (re-running produces the same filtered set), but the audit appends must be gated.
**Warning signs:** `evidence_hard_dropped` events appear multiple times for the same (file, pass) in the audit trail.

## Code Examples

### Evidence Re-check Function (core/evidence.ts)

```typescript
// Source: Derived from model-output.ts:435-550 and audit.ts:605-636
// Extracted into shared module to avoid duplication between parse-time and finalize-time.

import type { FileDiff, ParsedReviewComment, JobAuditEvent } from '@shared/schema';
import { redactFindingTitle } from './audit-redact';

// 20-sample cap, matching EVIDENCE_MISSING_SAMPLE_CAP in audit.ts
const EVIDENCE_HARD_DROP_SAMPLE_CAP = 20;

export interface EvidenceDropEntry {
  path: string;
  line: number | null;
  title: string;
  reason: 'absent' | 'not_in_hunk';
}

export interface EvidenceCheckResult {
  kept: ParsedReviewComment[];
  dropped: ParsedReviewComment[];
  entries: EvidenceDropEntry[];
}

/**
 * Normalize whitespace: collapse every whitespace run to a single space, trim, and lower-case.
 * MUST match normalizeForEvidence in model-output.ts:291 exactly.
 */
function normalizeForEvidence(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strip leading +/- diff markers from each line of a multi-line evidence string.
 * MUST match stripLeadingDiffMarkers in model-output.ts:305 exactly.
 */
function stripLeadingDiffMarkers(s: string): string {
  return s.split('\n').map((line) => line.replace(/^[+-]/, '')).join('\n');
}

export function checkEvidence(
  files: FileDiff[],
  comments: ParsedReviewComment[],
  exemptCategories: string[],
): EvidenceCheckResult {
  // Build per-file haystack: concatenate all hunk lines (content already diff-prefix-stripped
  // by diff.ts), then normalizeForEvidence.
  const haystackByPath = new Map<string, string>();
  for (const file of files) {
    haystackByPath.set(
      file.path,
      normalizeForEvidence(
        file.hunks.flatMap((h) => h.lines).map((l) => l.content).join('\n'),
      ),
    );
  }

  const kept: ParsedReviewComment[] = [];
  const dropped: ParsedReviewComment[] = [];
  const entries: EvidenceDropEntry[] = [];

  for (const comment of comments) {
    // Skip exempt categories — they always post regardless of evidence quality.
    if (exemptCategories.includes(comment.category)) {
      kept.push(comment);
      continue;
    }

    const haystack = haystackByPath.get(comment.path);
    const evidence = comment.existingCode;

    if (haystack === undefined || evidence == null || evidence.trim() === '') {
      // File not in diff or evidence absent -> drop
      dropped.push(comment);
      entries.push({
        path: comment.path,
        line: comment.line ?? null,
        title: comment.title,
        reason: 'absent',
      });
      continue;
    }

    const needle = normalizeForEvidence(stripLeadingDiffMarkers(evidence));
    if (needle.length === 0 || !haystack.includes(needle)) {
      dropped.push(comment);
      entries.push({
        path: comment.path,
        line: comment.line ?? null,
        title: comment.title,
        reason: 'not_in_hunk',
      });
      continue;
    }

    kept.push(comment);
  }

  return { kept, dropped, entries };
}
```

### Audit Event Builder (core/audit.ts addition)

```typescript
// Source: Derived from buildEvidenceMissingSummary (audit.ts:605-636)

const EVIDENCE_HARD_DROP_SAMPLE_CAP = 20;

export function buildEvidenceHardDroppedEvent(
  file: string,
  pass: FileReviewPass,
  entries: EvidenceDropEntry[],
): JobAuditEvent | null {
  if (entries.length === 0) return null;

  const sample = entries.slice(0, EVIDENCE_HARD_DROP_SAMPLE_CAP).map((e) => ({
    path: e.path,
    line: e.line,
    title: redactFindingTitle(e.title),
    reason: e.reason,
  }));

  const event = {
    stage: 'evidence_hard_dropped' as const,
    file,
    pass,
    droppedCount: entries.length,
    sample,
    timestamp: new Date().toISOString(),
  };

  return event satisfies JobAuditEvent;
}
```

### Finalize Phase Insertion Point (review.ts)

```typescript
// After line ~2183: reviewedComments is resolved from critic/security/main sources
// Before line ~2288: applyNoiseFilter is called

// --- EVID-02: hard-drop evidence gate (insert here) ---
if (config.review.evidence?.hard_drop ?? false) {
  const exemptCategories = config.review.evidence?.hard_drop_exempt_categories ?? ['security'];
  const evidenceResult = checkEvidence(files, reviewedComments, exemptCategories);
  reviewedComments = evidenceResult.kept;

  // Emit evidence_hard_dropped audit events per (file, pass)
  if (!finalizeRetriedPastPost && evidenceResult.entries.length > 0) {
    const entriesByFileAndPass = new Map<string, EvidenceDropEntry[]>();
    // Entries need file+pass grouping; group from the original reviews mapping
    for (const review of reviews) {
      const reviewEntries = evidenceResult.entries.filter(
        (e) => e.path === review.file_path,
      );
      if (reviewEntries.length === 0) continue;
      const key = `${review.file_path}:${review.pass}`;
      const existing = entriesByFileAndPass.get(key) ?? [];
      entriesByFileAndPass.set(key, [...existing, ...reviewEntries]);
    }
    for (const [key, fileEntries] of entriesByFileAndPass) {
      const [filePath, pass] = key.split(':') as [string, FileReviewPass];
      const event = buildEvidenceHardDroppedEvent(filePath, pass, fileEntries);
      if (event) {
        await appendJobAuditEvents(env, job.id, [event]);
      }
    }
  }
}
// --- end EVID-02 ---
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| EVID-01: soft/audit-only evidence check at parse time | EVID-01 unchanged at parse time; EVID-02 adds **hard-drop re-check at finalize time** | This phase | Evidence-invalid findings are removed from the candidate set before posting |
| Per-finding `evidence_missing` events (legacy) | `evidence_missing_summary` aggregate (Phase 21) + `evidence_hard_dropped` aggregate (this phase) | Phase 21 + this phase | Ring-buffer flood prevented by bounded aggregates; drop decisions explainable via audit |
| No evidence config toggle | `evidence.hard_drop` with per-category opt-out | This phase | Config-gated per NREG-01; escaped via `hard_drop: false` (default) |

**Deprecated/outdated:**
- The per-finding `evidence_missing` event (schema.ts:907-920) is preserved forever for backward compatibility but no longer produced by new code. The `evidence_missing_summary` (Phase 21) and `evidence_hard_dropped` (this phase) replace it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `files` variable in finalize (line 2082) contains the same parsed diff data that the parse-time EVID-01 check uses | Architecture Patterns | If the file list in finalize differs (e.g., `getJobDiffFiles` returns filtered results), the haystack would be incomplete and findings for filtered-out files would always be dropped as `not_in_hunk`. Low risk — finalize loads files via the same `getJobDiffFiles` call. |
| A2 | `ParsedReviewComment.category` is always one of the `reviewCategories` enum values | Pattern 2 | Category comparison for exempt-list matching defaults to `'correctness'` per schema (fallback if provider omitted it). A finding with a non-standard category would never match the exempt list. Low risk — the default `['security']` exemption only targets findings the model explicitly categorized as `security`. |
| A3 | The audit-trail viewer's `default: return null` in `DecisionEvent` won't cause a rendering error for unknown stages | Code Examples | Verified: the default case in audit-trail-viewer.tsx:347 returns null. Unknown stages are silently skipped. Adding `evidence_hard_dropped` to STAGE_ORDER without a renderer case would produce an empty group. Adding both STAGE_ORDER entry + basic renderer case eliminates risk. |

**If this table is empty:** not applicable — see entries above.

## Open Questions

1. **Should `evidence_hard_dropped` have dashboard rendering in this phase?**
   - What we know: The CONTEXT.md D-05 says the event "makes every drop decision explainable in the dashboard audit viewer." The out-of-scope section says "dashboard audit-trail rendering for the new event (follow-up Phase)." The CONTEXT.md explicitly leaves this as Claude's discretion.
   - What's unclear: Whether "explainable" means the event must be VISIBLE in the viewer (requiring a STAGE_ORDER entry + renderer case) or merely RECORDED (viewable via raw audit data access).
   - **Recommendation:** Add a minimal renderer case in this phase. The effort is ~15 lines (copying the `evidence_missing_summary` renderer pattern with `droppedCount` instead of two count fields). Without it, events exist but operators can't see them in the dashboard. This is a low-cost quality-of-life inclusion.

2. **Extract evidence check or duplicate logic?**
   - What we know: The evidence check logic is ~50 lines (model-output.ts:435-550). Reusing it requires extracting to `core/evidence.ts`. The alternative is inline duplication.
   - What's unclear: Whether the extraction introduces import-cycle issues (model-output.ts currently imports from `./audit`; the extracted module would import from `@shared/schema` and `./audit-redact` — no cycle risk).
   - **Recommendation:** Extract. The logic has accumulated WR-02 diff-marker stripping and normalizeForEvidence edge cases that must be identical between the two call sites. A single `checkEvidence()` function with deterministic input-output is easier to test and maintain.

## Environment Availability

> **Skip condition met:** This phase is a code/config-only change. The evidence re-check is an in-memory pure function operating on already-loaded data (FileDiff[], ParsedReviewComment[]). No new external tools, services, runtimes, databases, or CLIs are required. The existing development environment (Node.js v24.18.0, npm 11.16.0, Postgres for tests) covers all requirements.

Step 2.6: SKIPPED (no external dependencies identified)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.9 |
| Config file | vitest.config.mts (two projects: `node` and `browser`) |
| Quick run command | `npx vitest run test/evidence.spec.ts` (after extraction) |
| Full suite command | `npm test` (applies migrations, runs all node tests) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EVID-02 | Evidence re-check function correctly classifies absent/not_in_hunk/present findings | unit | `npx vitest run test/evidence.spec.ts -t "checkEvidence"` | ❌ Wave 0 |
| EVID-02 | Exempt categories bypass the drop | unit | `npx vitest run test/evidence.spec.ts -t "exempt categories"` | ❌ Wave 0 |
| EVID-02 | `evidence_hard_dropped` audit event builder produces correct shape | unit | `npx vitest run test/evidence.spec.ts -t "buildEvidenceHardDroppedEvent"` | ❌ Wave 0 |
| EVID-02 | Null/empty entries produce null event (no zero-count event) | unit | `npx vitest run test/evidence.spec.ts -t "empty entries"` | ❌ Wave 0 |
| EVID-02 | End-to-end: hard-drop gate in finalize drops findings with bad evidence | integration | `npx vitest run test/review-flow.spec.ts -t "evidence hard drop"` | ❌ Wave 0 |
| EVID-02 | Config-gated: disabled toggle produces byte-identical results (NREG-01) | integration | `npx vitest run test/review-flow.spec.ts -t "evidence disabled"` | ❌ Wave 0 |
| EVID-02 | Sample is bounded to 20 entries | unit | `npx vitest run test/evidence.spec.ts -t "sample cap"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run test/evidence.spec.ts -t "checkEvidence" -x`
- **Per wave merge:** `npx vitest run test/evidence.spec.ts -x`
- **Phase gate:** Full `npm test` suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `test/evidence.spec.ts` — covers checkEvidence, buildEvidenceHardDroppedEvent, sample cap, exempt categories, empty entries
- [ ] Integration test in `test/review-flow.spec.ts` — end-to-end hard-drop with mocked hallucinated evidence
- [ ] NREG-01 contract test verifying `defaultRepoConfig.evidence.hard_drop === false`
- [ ] `test/review-flow.spec.ts` NREG-01 test verifying byte-identical output when toggle is off

## Security Domain

> **Not applicable** — `security_enforcement` is not explicitly disabled, but this phase introduces no new authentication, session management, access control, or cryptography. The evidence check is a pure-text matching function operating on already-parsed model output. Privacy redaction of audit event titles is handled by the existing `redactFindingTitle` (Phase 20.1). No user-configurable input reaches the evidence check logic that isn't already validated by Zod schemas in `repoConfigSchema`.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | Partial | The `hard_drop_exempt_categories` array is parsed by Zod (z.array(z.string())) at config-write time. The comparison function does a category-string match against the existing `reviewCategories` const enum. |
| V9 (AUD-01) | Yes | All audit event sample entries use `redactFindingTitle` for title redaction (100-char cap, fixed-shape marker). Never carries body/diff/existingCode/codeSuggestion. |

## Sources

### Primary (HIGH confidence)
- `src/server/core/model-output.ts:280-310` — `normalizeForEvidence` / `stripLeadingDiffMarkers` normalization functions
- `src/server/core/model-output.ts:435-550` — EVID-01 evidence check (haystack construction, needle matching, audit event accumulation)
- `src/server/core/review.ts:2058-2300` — `runFinalizePhase` with `reviewedComments` resolution and `applyNoiseFilter` call
- `src/shared/schema.ts:110-253` — `reviewConfigSchema` with all existing toggle-block patterns
- `src/shared/schema.ts:805-1169` — `jobAuditEventSchema` discriminated union with `evidence_missing_summary` pattern
- `src/server/core/audit.ts:605-636` — `buildEvidenceMissingSummary` builder (pattern to follow)
- `src/server/core/diff.ts:1-30` — `FileDiff` / `DiffHunk` / `DiffLine` types
- `src/client/lib/audit-grouping.ts` — `STAGE_ORDER` and `normalizeAuditDisplayStage` patterns
- `src/client/components/features/job-detail/audit-trail-viewer.tsx:150-193` — evidence_missing rendering cases

### Secondary (MEDIUM confidence)
- [CITED: CONTEXT.md] — All D-01 through D-08 locked decisions verified against source code patterns
- [CITED: Phase 21 context] — `evidence_missing_summary` event shape and builder pattern

### Tertiary (LOW confidence)
- None — all findings verified against source code or locked decisions.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new packages; all patterns verified in source
- Architecture: HIGH — extraction pattern, insertion point, and audit event shape all verified against existing code
- Pitfalls: HIGH — all derived from D-01 (before-dedup), code review patterns, and existing finalize retry logic

**Research date:** 2026-07-26
**Valid until:** 2026-08-25 (stable patterns — no fast-moving dependencies in this phase)
