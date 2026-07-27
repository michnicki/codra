// Phase 29 / QA-IDX-01, Plan 29-01 Task 2 — the fixed-window chunker and its byte cap.
//
// Why this spec exists, two measured reasons:
//
// 1. D-10 says the chunker reuses the verify-fixes windowing VOCABULARY. Reusing the verify-fixes
//    FUNCTION instead would be wrong: windowFileContent returns null for every file at or under
//    FULL_CONTENT_LINE_CAP (500 lines), which is exactly the population D-10 needs windowed. The
//    symptom of that mistake is an index where nearly every row has chunk_start = 1 and one chunk
//    spans a whole file -- plausible-looking and quietly useless. The 12-line and 501-line cases
//    below are the guard.
//
// 2. to_tsvector RAISES above roughly 1 MB of RESULTING vector, and the vector is bigger than its
//    input: a 1 088 889-byte input produced a 1 477 980-byte vector against the 1 048 575-byte
//    ceiling. One window of a minified or generated file would hard-fail the index build step, and the
//    Workflow would then burn its whole retry budget re-throwing the same deterministic error. The
//    byte cap is enforced in JS BEFORE the insert; the truncation cases below are the guard.
//
// Pure module: no database, so this file runs standalone.

import { describe, expect, it } from 'vitest';
import { CODE_INDEX_MAX_CHUNK_BYTES, chunkLines } from '@server/core/code-index';
import { FULL_CONTENT_LINE_CAP, WINDOW_LINE_COUNT } from '@server/core/verify-fixes';

function makeLines(count: number, text = (i: number) => `line ${i}`): string {
  return Array.from({ length: count }, (_, i) => text(i + 1)).join('\n');
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe('chunkLines (D-10 fixed 50-line windows, 1-based inclusive)', () => {
  it('windows a 120-line file into [1..50], [51..100], [101..120]', () => {
    const windows = chunkLines(makeLines(120));

    expect(windows.map((w) => [w.start, w.end])).toEqual([
      [1, 50],
      [51, 100],
      [101, 120],
    ]);
    // Bounds are inclusive on both ends and contain exactly (end - start + 1) lines.
    for (const window of windows) {
      expect(window.content.split('\n')).toHaveLength(window.end - window.start + 1);
    }
  });

  it('windows a 12-line file into a SINGLE window rather than declining to window it', () => {
    const windows = chunkLines(makeLines(12));

    expect(windows).toHaveLength(1);
    expect(windows[0]!.start).toBe(1);
    expect(windows[0]!.end).toBe(12);
    expect(windows[0]!.content).toBe(makeLines(12));
  });

  it('returns an empty array for empty content', () => {
    expect(chunkLines('')).toEqual([]);
  });

  it('still windows on 50 lines above FULL_CONTENT_LINE_CAP (not emitted whole)', () => {
    const windows = chunkLines(makeLines(FULL_CONTENT_LINE_CAP + 1));

    expect(WINDOW_LINE_COUNT).toBe(50);
    expect(FULL_CONTENT_LINE_CAP).toBe(500);
    expect(windows).toHaveLength(11);
    expect(windows.at(-1)).toMatchObject({ start: 501, end: 501 });
    // No window ever spans more than WINDOW_LINE_COUNT lines.
    for (const window of windows) {
      expect(window.end - window.start + 1).toBeLessThanOrEqual(WINDOW_LINE_COUNT);
    }
  });

  it('honors an explicit chunk line count', () => {
    expect(chunkLines(makeLines(25), 10).map((w) => [w.start, w.end])).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
  });
});

describe('chunkLines byte cap (Pitfall 6 — to_tsvector raises above ~1 MB of vector)', () => {
  it('truncates an oversized window to CODE_INDEX_MAX_CHUNK_BYTES while keeping the real line numbers', () => {
    // 50 lines of 1 000 characters each: ~50 KB, well over the 32 KB cap.
    const windows = chunkLines(makeLines(50, () => 'x'.repeat(1_000)));

    expect(windows).toHaveLength(1);
    const window = windows[0]!;
    expect(utf8Length(window.content)).toBeLessThanOrEqual(CODE_INDEX_MAX_CHUNK_BYTES);
    expect(utf8Length(window.content)).toBeGreaterThan(CODE_INDEX_MAX_CHUNK_BYTES - 8);
    // The line range is the REAL range in the file, not the truncated content's range -- a retrieved
    // hit must always cite lines that exist.
    expect(window.start).toBe(1);
    expect(window.end).toBe(50);
  });

  it('leaves a normal-sized window byte-for-byte untouched', () => {
    const content = makeLines(50);
    const windows = chunkLines(content);

    expect(windows).toHaveLength(1);
    expect(windows[0]!.content).toBe(content);
  });

  it('never splits a multi-byte character when truncating', () => {
    // Every character is 3 UTF-8 bytes, so the cap necessarily lands mid-sequence unless the cut is
    // backed off to a sequence boundary.
    const windows = chunkLines(makeLines(50, () => '日'.repeat(500)));

    const content = windows[0]!.content;
    expect(utf8Length(content)).toBeLessThanOrEqual(CODE_INDEX_MAX_CHUNK_BYTES);
    // A mid-sequence cut would decode to U+FFFD REPLACEMENT CHARACTER.
    expect(content).not.toContain('�');
    // Round-tripping is lossless, which is only true if the cut fell on a boundary.
    expect(new TextDecoder().decode(new TextEncoder().encode(content))).toBe(content);
  });
});
