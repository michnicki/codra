import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@server/core/diff';
import { selectDiffForRound, type SelectDiffForRoundInputs } from '@server/core/rounds';

// Phase 18 Plan 02 / Task 1 (RND-02 / D-04..D-07): the pure `selectDiffForRound` helper. The
// decision tree is locked in Plan 02 — a successful empty compare is a LEGITIMATE no_changes
// answer (Phase 17 D-09 contract; Antigravity/Codex HIGH consensus), so an empty compare must
// NEVER fall back to the full diff. Only a thrown compare (modelled as an empty compare parsed
// with no files AND caller decides) triggers the full-diff fallback. The full-diff finally
// resolves: empty -> no_changes, non-empty -> fallback.
//
// All tests are pure (no I/O, no VCS, no DB) — the helper's job is to classify the strings the
// caller has already fetched. The companion `test/rounds-review-flow.spec.ts` (Task 2/3) covers
// the wiring through the review pipeline against the test DB.

function file(path: string): FileDiff {
  return {
    path,
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 1,
    hunks: [
      {
        header: '@@ -1 +1 @@',
        lines: [{ kind: 'add', content: 'x', newLineNumber: 1, position: 1 }],
      },
    ],
  };
}

const toSha = 'b'.repeat(40);
const anchorSha = 'a'.repeat(40);

function select(
  overrides: Partial<SelectDiffForRoundInputs> & Pick<SelectDiffForRoundInputs, 'roundContext'>,
): SelectDiffForRoundInputs {
  return {
    compareDiff: '',
    compareFiles: [],
    fullDiff: '',
    fullFiles: [],
    toSha,
    ...overrides,
  };
}

describe('selectDiffForRound — pre-Phase-18 paths (NREG-01)', () => {
  it('mode full returns { mode: "full" } unchanged', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'full', anchorSha: null, round: 1 },
        }),
      ),
    ).toEqual({ mode: 'full' });
  });

  it('mode rest returns { mode: "rest" } unchanged (review-rest, never participates in round selection)', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'rest', anchorSha: null, round: 1 },
        }),
      ),
    ).toEqual({ mode: 'rest' });
  });
});

describe('selectDiffForRound — mode fallback (no anchor, RND-02 fallback branch)', () => {
  it('non-empty full diff + zero compare files (compare threw) -> fallback', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'fallback', anchorSha: null, round: 2 },
          fullDiff: 'diff --git a/x b/x\n+x',
          fullFiles: [file('x')],
        }),
      ),
    ).toEqual({ mode: 'fallback', fromSha: '', toSha });
  });

  it('empty full diff + zero compare -> no_changes (empty full diff is also a legitimate no_changes)', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'fallback', anchorSha: null, round: 2 },
        }),
      ),
    ).toEqual({ mode: 'no_changes', fromSha: '', toSha });
  });

  it('non-empty full diff wins over a non-empty compare (fallback mode means compare is ignored)', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'fallback', anchorSha: null, round: 2 },
          compareDiff: 'diff --git a/x b/x\n+x',
          compareFiles: [file('x')],
          fullDiff: 'diff --git a/y b/y\n+y',
          fullFiles: [file('y')],
        }),
      ),
    ).toEqual({ mode: 'fallback', fromSha: '', toSha });
  });
});

describe('selectDiffForRound — mode incremental (RND-02 compare branch)', () => {
  it('non-empty parseable compare -> incremental, no full fetch', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'incremental', anchorSha, round: 2 },
          compareDiff: 'diff --git a/x b/x\n+x',
          compareFiles: [file('x')],
          fullDiff: '',
          fullFiles: [],
        }),
      ),
    ).toEqual({ mode: 'incremental', fromSha: anchorSha, toSha });
  });

  it('empty compare response = LEGITIMATE no_changes (Antigravity/Codex HIGH: do NOT fall back)', () => {
    // A successful empty compare (the Phase 17 D-09 contract: `''` is a valid no-changes answer)
    // is NOT a fallback signal. The full diff is consulted ONLY when the compare threw.
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'incremental', anchorSha, round: 2 },
          compareDiff: '',
          compareFiles: [],
          fullDiff: 'diff --git a/x b/x\n+x',
          fullFiles: [file('x')],
        }),
      ),
    ).toEqual({ mode: 'no_changes', fromSha: anchorSha, toSha });
  });

  it('whitespace-only compare response = LEGITIMATE no_changes (no full fetch)', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'incremental', anchorSha, round: 2 },
          compareDiff: '   \n\n  ',
          compareFiles: [],
          fullDiff: 'diff --git a/x b/x\n+x',
          fullFiles: [file('x')],
        }),
      ),
    ).toEqual({ mode: 'no_changes', fromSha: anchorSha, toSha });
  });

  it('zero-file parse output from a non-empty compare body = LEGITIMATE no_changes (junk tolerated by parseUnifiedDiff)', () => {
    // The contract: parseUnifiedDiff is tolerant (Codex MEDIUM). A 200 OK response with junk
    // text parses to zero files; that is the parser's "no diff structure found" answer, which
    // is functionally equivalent to a `''` response. Treat as no_changes; do NOT fetch full.
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'incremental', anchorSha, round: 2 },
          compareDiff: 'not a diff at all',
          compareFiles: [],
          fullDiff: 'diff --git a/x b/x\n+x',
          fullFiles: [file('x')],
        }),
      ),
    ).toEqual({ mode: 'no_changes', fromSha: anchorSha, toSha });
  });

  it('thrown compare (empty compare + empty full) -> no_changes', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'incremental', anchorSha, round: 2 },
          compareThrew: true,
        }),
      ),
    ).toEqual({ mode: 'no_changes', fromSha: anchorSha, toSha });
  });

  it('thrown compare (empty compare + non-empty full) -> fallback with the SAME (from, to) range', () => {
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'incremental', anchorSha, round: 2 },
          compareThrew: true,
          fullDiff: 'diff --git a/y b/y\n+y',
          fullFiles: [file('y')],
        }),
      ),
    ).toEqual({ mode: 'fallback', fromSha: anchorSha, toSha });
  });
});

describe('selectDiffForRound — anchor invariants (D-08)', () => {
  it('fromSha is the LOCKED prior anchor (never the freshly-fetched live head)', () => {
    // Two calls with the same anchor return the same fromSha; the toSha is the prepare-time
    // head captured before the review started. A finalize-phase fetch of a NEWER live head MUST
    // NOT propagate to fromSha on the persisted descriptor.
    const first = selectDiffForRound(
      select({
        roundContext: { mode: 'incremental', anchorSha, round: 2 },
        compareDiff: 'diff --git a/x b/x\n+x',
        compareFiles: [file('x')],
      }),
    );
    const second = selectDiffForRound(
      select({
        roundContext: { mode: 'incremental', anchorSha, round: 2 },
        compareDiff: 'diff --git a/x b/x\n+x',
        compareFiles: [file('x')],
      }),
    );
    expect(first).toEqual(second);
    if (first.mode === 'incremental') {
      expect(first.fromSha).toBe(anchorSha);
      expect(first.toSha).toBe(toSha);
    }
  });

  it('no_changes descriptor carries the EXACT (from, to) range the audit event requires (D-08)', () => {
    const out = selectDiffForRound(
      select({
        roundContext: { mode: 'incremental', anchorSha, round: 2 },
        compareDiff: '',
        compareFiles: [],
      }),
    );
    expect(out).toEqual({ mode: 'no_changes', fromSha: anchorSha, toSha });
  });
});

describe('selectDiffForRound — null anchor with unresolved threads (D-04)', () => {
  it('round 2 thread-only path uses full-diff fallback, NOT no_changes (D-04 explicit)', () => {
    // The D-04 resolver sets mode='fallback' when an anchor is null but unresolved threads exist,
    // so the round is recorded as 2+ (the OR composition trips) but the compare branch has no
    // anchor to diff against -> full diff. A non-empty full diff resolves to fallback, NOT
    // no_changes, because the round-2 escalation still runs (raised floors + open-thread
    // suppression) against the full diff. The plan's acceptance: "Null anchor with unresolved
    // threads uses full fallback, not no_changes."
    expect(
      selectDiffForRound(
        select({
          roundContext: { mode: 'fallback', anchorSha: null, round: 2 },
          fullDiff: 'diff --git a/x b/x\n+x',
          fullFiles: [file('x')],
        }),
      ),
    ).toEqual({ mode: 'fallback', fromSha: '', toSha });
  });
});
