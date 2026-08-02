---
phase: 33-quality-fixes
plan: 02
subsystem: core
tags: [mermaid, walkthrough, sanitizer, model-output]

requires:
  - phase: 03
    provides: parseWalkthroughDiagram best-effort diagram contract (return null -> omit)
provides:
  - sanitizeMermaidLabels module-private string repair wired into parseWalkthroughDiagram
affects: [33-04 (same-file Wave-3 edits in a different region)]

tech-stack:
  added: []
  patterns:
    - "Single-pass linear scan (never regex-backtracking) that always advances the index"

key-files:
  created: []
  modified:
    - src/server/core/model-output.ts
    - test/model-output.spec.ts

key-decisions:
  - "D-12: interior double quotes inside [\"...\"] label tokens are REMOVED (canonical PRD rewrite)"
  - "D-13: scope is label tokens only — message/note text is never touched"
  - "D-14: sanitizer runs after fence-unwrap, before first-token validation and the length cap"
  - "OD-4: scan-based helper over a backtracking regex; no-close tokens copied verbatim, index always advances (R7)"

patterns-established:
  - "Token close = \" immediately followed by ] — a ] inside label text does not close the token"

requirements-completed: [PRD-03]

coverage:
  - id: D1
    description: "parseWalkthroughDiagram repairs nested double quotes inside Mermaid label tokens (canonical engine[\"core/\"engine.py\"\"] -> engine[\"core/engine.py\"]) in both bare and fenced payloads, before validation/cap"
    requirement: PRD-03
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts#repairs the canonical nested-quote label in a bare payload (FR-155, D-12)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#repairs the canonical nested-quote label inside a ```mermaid fence (fence unwrap runs first)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#returns a repaired broken-label-only diagram instead of omitting it (D-14)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Clean diagrams round-trip byte-identically — message quotes, clean multi-label lines, and already-clean labels untouched (NREG-01); unterminated tokens copy verbatim without hanging (R7)"
    requirement: PRD-03
    verification:
      - kind: unit
        ref: "test/model-output.spec.ts#leaves message-quote text untouched (NREG-01, D-13)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#round-trips a clean multi-label line byte-identically (NREG-01, REVIEWS R7)"
        status: pass
      - kind: unit
        ref: "test/model-output.spec.ts#copies an unterminated label token verbatim without hanging or crashing (REVIEWS R7)"
        status: pass
    human_judgment: false

duration: ~10min
completed: 2026-07-31
status: complete
---

# Phase 33 Plan 2: Mermaid label sanitizer Summary

**`parseWalkthroughDiagram` now repairs nested double quotes inside `["…"]` Mermaid label tokens (`engine["core/"engine.py""]` → `engine["core/engine.py"]`) via a module-private single-pass scan, wired between fence-unwrap and first-token validation — clean diagrams pass through byte-identical**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-31T14:04:00Z
- **Completed:** 2026-07-31T14:06:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `sanitizeMermaidLabels` (module-private, not exported): single-pass scan, label tokens open at `["` and close at the first `"` immediately followed by `]`; interior quotes removed via `.replace(/"/g, '')` on the span
- No-close tokens copied verbatim with the index always advancing — unterminated labels can never infinite-loop (REVIEWS R7)
- Wired at the D-14 position: after the fence-unwrap block, before `const source = text.trim()`, first-token validation, and the `DIAGRAM_SOURCE_MAX` cap — a broken-label-only diagram now survives instead of being omitted
- 9 new WT-04 test cases pinning the canonical bare/fenced repair, broken-label-only survival, message-quote/multi-label/clean-label NREG-01 round-trips, unterminated-token safety, and the interior-`]` boundary (consensus fold-in (b))

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sanitizeMermaidLabels and wire it into parseWalkthroughDiagram's step order** - `80df667` (feat)
2. **Task 2: parseWalkthroughDiagram sanitizer tests** - `63ae733` (test)

## Files Created/Modified
- `src/server/core/model-output.ts` - `sanitizeMermaidLabels` + `parseWalkthroughDiagram` call at the D-14 position
- `test/model-output.spec.ts` - 9 new WT-04 sanitizer cases

## Decisions Made
- OD-4 (planner resolution): scan-based helper rather than a backtracking regex — linear, no catastrophic backtracking, handles multiple labels per line naturally
- Consensus fold-in (b): token close is `"` immediately followed by `]`; a `]` inside label text does not close the token
- The diagram enters the system only through `parseWalkthroughDiagram` (verified in 33-RESEARCH §4.1), so parse-time sanitization covers the whole surface; `formatter.ts:523` untouched

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Ready for Plan 33-04 (Wave 3) — edits the same two files but in a different region (`parseFileReviewResponse` :400-558 + constant block ~:563), and the sequential wave ordering removes adjacency risk
- Wave 1 complete: Plans 33-01 and 33-02 both delivered; post-wave full-suite gate run

---
*Phase: 33-quality-fixes*
*Completed: 2026-07-31*
