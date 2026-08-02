# Phase 24: Dashboard surface for new audit events - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-25
**Phase:** 24-dashboard-surface-for-new-audit-events
**Areas discussed:** Display grouping, Rendering detail, modelLineCap surfacing

---

## Display grouping for evidence_missing_summary

| Option | Description | Selected |
|--------|-------------|----------|
| Same group as legacy evidence_missing | Map evidence_missing_summary → evidence_missing via normalizeAuditDisplayStage. Both variants under one "Evidence missing" header. Follows rounds.* / threads.* precedent. | ✓ |
| Separate "Evidence missing (summary)" group | Add evidence_missing_summary as its own STAGE_ORDER entry with its own header. | |

**User's choice:** Same group as legacy evidence_missing (Recommended)
**Notes:** Operator sees one coherent "Evidence missing" section regardless of which variant a job carries. Legacy per-finding events (pre-Phase-21 jobs) and new aggregate events (Phase-21+ jobs) typically won't coexist in the same job, but the normalize pattern handles coexistence cleanly if it ever occurs.

---

## Rendering detail level for the summary event

| Option | Description | Selected |
|--------|-------------|----------|
| Counts + collapsible sample | File:pass header, absentCount + notInHunkCount as metric lines, expandable sample list. Follows filtered/file_skipped precedent. | ✓ |
| Counts only, no sample | Just aggregate counts per (file, pass). Compact but loses per-finding drill-down. | |
| Full expanded sample always | Always show full sample without collapse. Verbose for the common case. | |

**User's choice:** Counts + collapsible sample (Recommended)
**Notes:** Operators see at-a-glance counts and can drill into specific findings. Sample entries carry path, line, title (privacy-redacted), and reason (absent/not_in_hunk) — same shape as existing filtered sample entries.

---

## modelLineCap surfacing in job detail

| Option | Description | Selected |
|--------|-------------|----------|
| Don't surface | model_line_cap is an internal correctness fix, not operator-facing telemetry. | ✓ |
| Surface in file review rows | Add to getJobDetail files_json subquery and show as badge/tooltip on file review rows. | |
| Surface alongside evidence_missing_summary | Include as context in the DecisionEvent renderer. Couples audit viewer to a non-audit DB column. | |

**User's choice:** Don't surface (Recommended)
**Notes:** Operators debug evidence issues through the audit trail, not raw DB columns. Adding it would require API schema + route + component changes for a column that's read-zero in practice. Can be added later if needed (additive change).

---

## Claude's Discretion

- Exact `DecisionEvent` case implementation (native `<details>` vs inline sample, matching `filtered`/`file_skipped` which show samples unconditionally within the already-expanded `DecisionGroup`)
- Whether to show a reason badge per sample entry (absent vs not_in_hunk)
- Exact label text, styling, and CSS classes
- Whether to show `pass` as a MetricLine or as part of the file identifier
- Test strategy and placement (browser spec + audit-grouping unit test)
- TypeScript type adjustments (`AuditDisplayStage` closed union)

## Deferred Ideas

None — discussion stayed within phase scope.
