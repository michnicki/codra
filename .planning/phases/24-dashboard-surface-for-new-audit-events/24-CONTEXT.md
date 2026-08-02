# Phase 24: Dashboard surface for new audit events - Context

**Gathered:** 2026-07-25
**Status:** Ready for planning

## Phase Boundary

Surface the new v1.3 audit events in the dashboard's job-detail audit trail viewer. The server (`getJobDetail`) already returns `evidence_missing_summary` events — the `jobAuditEventSchema` discriminated union includes them via `.passthrough()`. This phase is purely a dashboard rendering catch-up: add the `DecisionEvent` renderer, wire it into `STAGE_ORDER`/`normalizeAuditDisplayStage`/`STAGE_LABELS`, and verify with a browser spec.

**In scope:** `evidence_missing_summary` rendering in `audit-trail-viewer.tsx` (new `DecisionEvent` case), `normalizeAuditDisplayStage` mapping, `STAGE_LABELS` entry if needed, browser test for the new renderer, audit-grouping unit test update.

**Out of scope:** Server-side changes (the events already flow through `getJobDetail`), `model_line_cap` dashboard surfacing (internal correctness fix, not operator-facing), any new audit event types, changes to the legacy `evidence_missing` per-finding renderer (kept as-is for old persisted events), any other dashboard pages (stats, repo config, etc.).

## Implementation Decisions

### Display Grouping
- **D-01:** `evidence_missing_summary` maps to the existing `evidence_missing` display group via `normalizeAuditDisplayStage`. A new line `if (stage === 'evidence_missing_summary') return 'evidence_missing';` joins the existing synthetic-stage mappings. Follows the Phase 18/19/20 precedent (`rounds.*` → `rounds`, `threads.*` → `threads`, `critic.decisions` → `critic`, `ensemble.voted` → `ensemble`, `walkthrough.enrichment` → `walkthrough`). Both the legacy per-finding `evidence_missing` variant and the new aggregate `evidence_missing_summary` render under one "Evidence missing" header, distinguished by the `DecisionEvent` switch on `event.stage`. — **Reversibility:** reversible — adding/removing a normalize mapping is a one-line change.

### Rendering Detail
- **D-02:** Counts + collapsible sample rendering for `evidence_missing_summary`. Show `file` + `pass` as identifier, `absentCount` + `notInHunkCount` as metric lines, and an expandable sample list (≤20 entries) with `path:line`, `title` (already privacy-redacted), and `reason` (absent / not_in_hunk). Follows the `filtered` and `file_skipped` precedent exactly — aggregate counts at the top, bounded sample below. The legacy `evidence_missing` single-item renderer stays as-is (one row per legacy event). — **Reversibility:** reversible — changing the renderer is a local component change.

### modelLineCap Surfacing
- **D-03:** Do NOT surface `model_line_cap` in the dashboard. It's an internal correctness fix (Phase 23) ensuring poll uses the same line cap the model saw at submit — not operator-facing telemetry. Operators debug evidence issues through the audit trail (`evidence_missing_summary` events), not raw DB columns. Adding it to the API + dashboard would require a `getJobDetail` subquery change + `jobDetailSchema` update + component work for a column that is read-zero in practice. — **Reversibility:** reversible — adding it later is additive (new JSON_BUILD_OBJECT key + optional schema field + component).

### Claude's Discretion
- Exact `DecisionEvent` case implementation: whether to use a native `<details>` for the sample collapse or render the sample inline (matching `filtered`/`file_skipped` which show the sample unconditionally within the expanded `DecisionGroup` — the group is already inside a collapsed `<details>` section)
- Whether to show a reason badge per sample entry (`absent` vs `not_in_hunk`) as a colored chip or plain text
- Exact label text, styling, and CSS classes (match surrounding `MetricLine`/`SampleIdentifier` conventions)
- Whether to show the `pass` field as a MetricLine or as part of the file identifier (e.g., `file · pass`)
- Test strategy: browser spec in `test/browser/` for the new renderer (following the existing audit-trail viewer browser test pattern), unit test in `test/audit-grouping.spec.ts` for the new `normalizeAuditDisplayStage` mapping
- Whether to add the `evidence_missing_summary` literal to `AuditDisplayStage` (the closed union) — it's not strictly needed if the normalizer collapses it before `STAGE_ORDER` filtering, but TypeScript may require it depending on how `normalizeAuditDisplayStage` is typed

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Dashboard Audit Trail
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` — The full audit trail viewer: `DecisionEvent` switch (lines 79-329), `DecisionGroup` (lines 358-372), `DraftedGroup` (lines 334-354), `STAGE_LABELS` (lines 15-27), `SampleIdentifier` (lines 40-58), `MetricLine` (lines 62-68). New `evidence_missing_summary` case goes in the `DecisionEvent` switch.
- `src/client/lib/audit-grouping.ts` — `STAGE_ORDER` (lines 14-26), `normalizeAuditDisplayStage` (lines 61-68), `AuditDisplayStage` type (line 38), `groupAuditByStage` (lines 82-96). Add `evidence_missing_summary` → `evidence_missing` mapping in the normalizer.

### Schema (Read for event shape)
- `src/shared/schema.ts` §936-953 — `evidence_missing_summary` event shape: `stage`, `file`, `pass`, `absentCount`, `notInHunkCount`, `sample` (≤20 entries of `{path, line, title, reason}`), `timestamp`
- `src/shared/schema.ts` §907-920 — Legacy `evidence_missing` per-finding variant (kept forever, already rendered)

### Precedent Renderers (Follow these patterns)
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` §89-116 — `filtered` DecisionEvent: counts + bounded sample with path/line/title + severity/category/confidence metadata row. Closest analog.
- `src/client/components/features/job-detail/audit-trail-viewer.tsx` §147-163 — `file_skipped` DecisionEvent: reason + count + sample with path/line/title. Simpler analog.

### Prior Phase Context
- `.planning/phases/21-evidence-missing-aggregate-summary-event-schema-audit-writer/21-CONTEXT.md` — Phase 21 decisions: D-01 event shape design, D-05 no zero-count event, D-06 always-aggregate, D-07 sample preserves emission order
- `.planning/phases/23-in-01-modellinecap-persistence-at-submit-time/23-CONTEXT.md` — Phase 23 decisions: D-03 `model_line_cap` is internal DB state, not on the API surface

### Browser Test Patterns
- `test/browser/` — Existing browser specs for audit trail viewer (look for files testing job detail / audit rendering)
- `test/audit-grouping.spec.ts` or similar — Unit tests for `normalizeAuditDisplayStage` / `groupAuditByStage`

### Requirements
- `.planning/REQUIREMENTS.md` — v1.3 requirements: EVID-03 (Phase 21, already shipped), EVID-04 (Phase 22, already shipped), AUD-03 (Phase 23, already shipped). Phase 24 has no new requirement ID — it's the dashboard catch-up for the telemetry added in Phases 21-23.

## Existing Code Insights

### Reusable Assets
- **`normalizeAuditDisplayStage`** (`audit-grouping.ts:61-68`): Already maps 5 synthetic stages. Add one more line for `evidence_missing_summary` → `evidence_missing`. Zero new machinery needed.
- **`DecisionEvent` switch** (`audit-trail-viewer.tsx:79-329`): Add a new `case 'evidence_missing_summary':` block. All existing helper components (`MetricLine`, `SampleIdentifier`, `CountBadge`) are reusable.
- **`STAGE_LABELS`** (`audit-trail-viewer.tsx:15-27`): The `evidence_missing` label already exists. No new label needed since D-01 maps to the same group.
- **`groupAuditByStage`** (`audit-grouping.ts:82-96`): No changes needed — the normalizer handles the mapping before bucketing.
- **`getJobDetail`** (`db/jobs.ts:602-716`): No changes needed — `jobAuditEventSchema.safeParse` already accepts `evidence_missing_summary` via `.passthrough()`.

### Established Patterns
- **Synthetic stage normalization**: `normalizeAuditDisplayStage` collapses sub-variants to display groups. Adding `evidence_missing_summary` → `evidence_missing` is the 6th mapping, following the exact string-prefix / string-equality pattern.
- **Count + sample renderers**: `filtered` and `file_skipped` both show aggregate counts as `MetricLine` rows, then a conditional sample list with `SampleIdentifier` entries. The new renderer follows this pattern with two count lines (absentCount + notInHunkCount).
- **Privacy-bounded**: Sample titles already route through `redactFindingTitle` server-side. The client just renders whatever string arrives — no additional sanitization needed.
- **No new dependencies**: Dashboard-only change, zero npm packages, zero server changes.

### Integration Points
- **`audit-grouping.ts` line ~66**: Add `if (stage === 'evidence_missing_summary') return 'evidence_missing';` in `normalizeAuditDisplayStage`
- **`audit-trail-viewer.tsx` line ~170**: Add new `case 'evidence_missing_summary':` after the legacy `evidence_missing` case (line 165-171)
- **No other files change**: The server, schema, DB layer, and all other dashboard pages are unaffected

## Specific Ideas

No specific references — the rendering follows the established `filtered`/`file_skipped` pattern. The user confirmed the three key decisions (same-group mapping, counts + sample rendering, no modelLineCap surfacing).

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: 24-dashboard-surface-for-new-audit-events*
*Context gathered: 2026-07-25*
