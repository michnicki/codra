import type { ReviewSeverity } from '@shared/schema';

// REV-M-4: Keep the subset of Bitbucket API values Codra emits in one module so the shared
// validators and adapter body builders cannot drift. Atlassian's current OpenAPI confirms BUG is
// accepted for Code Insights reports. Codra emits only terminal PASSED/FAILED report results; the
// upstream API's PENDING value is intentionally outside this phase's create/update contract.
export const REPORT_TYPE = 'BUG' as const;
export const REPORT_TYPE_VALUES = [REPORT_TYPE] as const;
export const REPORT_RESULT = ['PASSED', 'FAILED'] as const;

// LINE_TYPES describes Codra's internal anchor classification. The REST client translates it to
// Bitbucket's documented `inline.to` (added/context) or `inline.from` (removed) wire fields.
export const LINE_TYPES = ['context', 'added', 'removed'] as const;

// Codra emits the three states needed by its review lifecycle. Bitbucket also documents STOPPED,
// which is not produced by this workflow and is therefore intentionally excluded.
export const BUILD_STATUS_STATE = ['SUCCESSFUL', 'FAILED', 'INPROGRESS'] as const;

// Phase 30 (ANNO-01, D-01): the Code Insights report_id for Codra's per-file annotations report.
// Confirmed at the 30-01 Task 1 checkpoint. Deliberately a SEPARATE report_id from the existing
// summary report's `'codra-review'` literal (core/bitbucket.ts, vcs/bitbucket.ts) so Bitbucket
// renders annotations under their own PR report card rather than merging into the summary report.
// This id is a permanent PR-visible contract once shipped — Bitbucket has no rename-report-id
// operation, so changing it later orphans the old card instead of renaming it.
export const ANNOTATION_REPORT_ID = 'codra-annotations' as const;

// Phase 30 (ANNO-01, D-05): the annotation_type value posted on every annotation. Intentionally
// the SAME literal value as REPORT_TYPE but a distinctly-named constant (not a re-export), so
// annotation semantics can diverge from the summary report's report_type later without touching
// this constant.
export const ANNOTATION_TYPE = 'BUG' as const;

// Phase 30 (ANNO-01, D-04): the four literal `severity` enum values Bitbucket's live OpenAPI spec
// documents on `report_annotation` (verified 2026-07-30 against swagger.json, see 30-RESEARCH.md
// Pattern 3). Imported by reportAnnotationSchema below so the client and schema cannot drift.
export const ANNOTATION_SEVERITY_VALUES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

// Phase 30 (ANNO-01, D-04/D-06): maps Codra's internal review severities to Bitbucket's wire
// severity enum. D-04's own wording ("P0→top, P1→high, P2→mid, P3+nit merged→low") was informal
// shorthand; this is the pinned wire-accurate encoding of the identical intent. Per D-06, this
// mapping is a hardcoded constant and is NEVER config-overridable.
export const ANNOTATION_SEVERITY_MAP = {
  P0: 'CRITICAL',
  P1: 'HIGH',
  P2: 'MEDIUM',
  P3: 'LOW',
  nit: 'LOW',
} as const satisfies Record<ReviewSeverity, typeof ANNOTATION_SEVERITY_VALUES[number]>;

// Bitbucket's bulk annotation POST endpoint documents `maxItems: 100` per request (verified
// against the live swagger.json). Consumed by the chunking loop in postAnnotations (Plan 30-03)
// so a PR with more than 100 posted findings (below the existing 150 max_comments ceiling) still
// succeeds via multiple sequential POSTs.
export const ANNOTATION_BATCH_SIZE = 100 as const;
