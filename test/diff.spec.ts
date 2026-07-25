import {
  findPositionForLine,
  filterReviewableFiles,
  getValidNewLines,
  isGeneratedFile,
  parseUnifiedDiff,
  partitionReviewableFiles,
  selectReviewableFiles,
  truncateFileDiff,
  type FileDiff,
} from '@server/core/diff';
import { buildWalkthroughData, type WalkthroughReviewRow } from '@server/core/walkthrough';
import { defaultRepoConfig } from '@shared/schema';

// A minimal FileDiff with an overridable path / changeType and no hunks (score = keyword tiers +
// changeType nudge; size bonus 0).
function makeFile(path: string, opts: Partial<FileDiff> = {}): FileDiff {
  return { path, previousPath: null, isNew: false, isDeleted: false, isBinary: false, lineCount: 0, hunks: [], ...opts };
}

// Build a FileDiff whose first two (or more) hunks carry the given per-hunk line contents.
// `content` is the ALREADY prefix-stripped line text (matching parseUnifiedDiff's line.slice(1)).
function fileWithHunkLines(...hunkContents: string[][]): FileDiff {
  return {
    path: 'x.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 0,
    hunks: hunkContents.map((lines) => ({
      header: '@@',
      lines: lines.map((content, i) => ({ kind: 'add' as const, content, newLineNumber: i + 1, position: i + 1 })),
    })),
  };
}

describe('Diff Engine Deep Dive', () => {
  const sampleDiff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,4 @@
 const answer = 41;
+const next = answer + 1;
 export function value() {
   return answer;
 }`;

  describe('parseUnifiedDiff', () => {
    it('tracks new lines and GitHub positions for standard diffs', () => {
      const [file] = parseUnifiedDiff(sampleDiff);
      expect(file.path).toBe('src/example.ts');
      expect(file.lineCount).toBe(5);
      expect(getValidNewLines(file)).toEqual(new Set([1, 2, 3, 4, 5]));
      expect(findPositionForLine(file, 2)).toBe(2);
    });

    it('correctly handles file renames', () => {
      const renameDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;
      const [file] = parseUnifiedDiff(renameDiff);
      expect(file.path).toBe('new-name.ts');
      expect(file.previousPath).toBe('old-name.ts');
    });

    it('identifies new file creations', () => {
      const newFileDiff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+console.log("hello");
`;
      const [file] = parseUnifiedDiff(newFileDiff);
      expect(file.isNew).toBe(true);
      expect(file.path).toBe('new.ts');
    });

    it('identifies deleted files', () => {
      const deleteDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-console.log("bye");
`;
      const [file] = parseUnifiedDiff(deleteDiff);
      expect(file.isDeleted).toBe(true);
    });

    it('gracefully skips binary files', () => {
      const binaryDiff = `diff --git a/image.png b/image.png
index 1234567..890abcd 100644
Binary files a/image.png and b/image.png differ
`;
      const [file] = parseUnifiedDiff(binaryDiff);
      expect(file.isBinary).toBe(true);
      expect(file.path).toBe('image.png');
    });

    it('handles malformed hunk headers without crashing', () => {
      const malformedDiff = `diff --git a/broken.ts b/broken.ts
--- a/broken.ts
+++ b/broken.ts
@@ invalid hunk header @@
+broken
`;
      const files = parseUnifiedDiff(malformedDiff);
      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(0);
    });
  });

  describe('truncateFileDiff', () => {
    it('truncates large files to the specified line limit', () => {
      const largeFile = {
        path: 'large.ts',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 100,
        hunks: [
          { header: '@@ -1,50 +1,50 @@', lines: Array(50).fill({ kind: 'add', content: 'line', position: 1 }) },
          { header: '@@ -51,100 +51,100 @@', lines: Array(50).fill({ kind: 'add', content: 'line', position: 51 }) },
        ],
      } as any;

      const truncated = truncateFileDiff(largeFile, 60);
      expect(truncated.isTruncated).toBe(true);
      expect(truncated.hunks).toHaveLength(2);
      expect(truncated.hunks[1].lines).toHaveLength(10);
      expect(truncated.lineCount).toBe(60);
    });

    it('slices a single oversized hunk to the line limit', () => {
      const largeFile = {
        path: 'large.ts',
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 500,
        hunks: [
          { header: '@@ -1,500 +1,500 @@', lines: Array(500).fill({ kind: 'add', content: 'line', position: 1 }) },
        ],
      } as any;

      const truncated = truncateFileDiff(largeFile, 300);
      expect(truncated.isTruncated).toBe(true);
      expect(truncated.hunks).toHaveLength(1);
      expect(truncated.hunks[0].lines).toHaveLength(300);
      expect(truncated.lineCount).toBe(300);
    });
  });

  describe('filterReviewableFiles', () => {
    it('applies complex exclusion patterns', () => {
      const files = [
        { path: 'src/main.ts', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
        { path: 'dist/bundle.js', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
        { path: 'src/test.spec.ts', isDeleted: false, isBinary: false, isNew: false, hunks: [] },
      ] as any;

      const config = {
        ...defaultRepoConfig.review,
        skip_files: ['dist/**', '**/*.spec.ts'],
      };

      const filtered = filterReviewableFiles(files, config);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].path).toBe('src/main.ts');
    });

    it('respects max_files limit', () => {
      const manyFiles = Array(20).fill(0).map((_, i) => ({
        path: `file${i}.ts`, isDeleted: false, isBinary: false, isNew: false, hunks: []
      })) as any;

      const filtered = filterReviewableFiles(manyFiles, { ...defaultRepoConfig.review, max_files: 5 });
      expect(filtered).toHaveLength(5);
    });
  });

  describe('isGeneratedFile', () => {
    it('detects a DO NOT EDIT banner in the first hunk (case-insensitive)', () => {
      expect(isGeneratedFile(fileWithHunkLines(['DO NOT EDIT this file']))).toBe(true);
      expect(isGeneratedFile(fileWithHunkLines(['do not edit this file']))).toBe(true);
    });

    it('detects a lower-case @generated banner (scan upper-cases both sides)', () => {
      expect(isGeneratedFile(fileWithHunkLines(['// @generated by tool']))).toBe(true);
    });

    it('detects each of the six markers within the window', () => {
      const markers = [
        'DO NOT EDIT',
        'AUTO-GENERATED',
        'GENERATED BY',
        'AUTOMATICALLY GENERATED',
        'THIS FILE IS GENERATED',
        '@GENERATED',
      ];
      for (const marker of markers) {
        expect(isGeneratedFile(fileWithHunkLines([`prefix ${marker.toLowerCase()} suffix`]))).toBe(true);
      }
    });

    it('detects a marker in the second hunk but NOT the third (window = first two hunks)', () => {
      expect(isGeneratedFile(fileWithHunkLines(['first hunk'], ['@generated in second']))).toBe(true);
      expect(isGeneratedFile(fileWithHunkLines(['first hunk'], ['second hunk'], ['@generated in third']))).toBe(false);
    });

    it('ignores a marker that appears only after char 600 (window = first 500 chars)', () => {
      expect(isGeneratedFile(fileWithHunkLines(['X'.repeat(600) + 'DO NOT EDIT']))).toBe(false);
    });

    it('resolves the 499/500 boundary precisely', () => {
      // '@GENERATED' is 10 chars. Pad so its LAST char lands exactly at index 499 -> whole marker
      // fits inside slice(0, 500) -> detected.
      const padded = 'X'.repeat(500 - '@GENERATED'.length) + '@GENERATED';
      expect(isGeneratedFile(fileWithHunkLines([padded]))).toBe(true);
      // Shift one char later -> marker's last char is at index 500, past the slice -> not detected.
      const shifted = 'X'.repeat(500 - '@GENERATED'.length + 1) + '@GENERATED';
      expect(isGeneratedFile(fileWithHunkLines([shifted]))).toBe(false);
    });

    it('returns false for a zero-hunk file and a normal source file (never throws)', () => {
      expect(isGeneratedFile(fileWithHunkLines())).toBe(false);
      expect(isGeneratedFile(fileWithHunkLines(['const x = 1;', 'export default x;']))).toBe(false);
    });
  });

  describe('selectReviewableFiles', () => {
    const enabled = (max_files: number) => ({ ...defaultRepoConfig.review, max_files });
    const disabled = (max_files: number) => ({
      ...defaultRepoConfig.review,
      max_files,
      file_selection: { enabled: false },
    });

    it('keeps the top max_files by descending score and over-caps the remainder (enabled)', () => {
      const high = makeFile('src/payment/charge.ts', { isNew: true }); // +5 +1 = 6
      const mid = makeFile('src/payment/refund.ts'); // +5 +0.5 = 5.5
      const low = makeFile('src/util.ts'); // 0.5
      const { kept, dropped } = selectReviewableFiles([low, high, mid], enabled(2));
      expect(kept.map((f) => f.path)).toEqual(['src/payment/charge.ts', 'src/payment/refund.ts']);
      expect(dropped.overCap.map((f) => f.path)).toEqual(['src/util.ts']);
      expect(dropped.generated).toEqual([]);
    });

    it('lets a sensitive file beat an alphabetically-earlier low-priority file for the last slot (SC1)', () => {
      const low = makeFile('aaa-test.ts'); // 'test' -5 +0.5 = -4.5
      const sensitive = makeFile('zzz-auth.ts'); // 'auth' +5 +0.5 = 5.5
      const { kept, dropped } = selectReviewableFiles([low, sensitive], enabled(1));
      expect(kept.map((f) => f.path)).toEqual(['zzz-auth.ts']);
      expect(dropped.overCap.map((f) => f.path)).toEqual(['aaa-test.ts']);
    });

    it('orders two equal-score files by path.localeCompare tiebreak (enabled)', () => {
      const a = makeFile('src/a.ts'); // 0.5
      const b = makeFile('src/b.ts'); // 0.5
      const { kept } = selectReviewableFiles([b, a], enabled(10));
      expect(kept.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('drops a generated file into dropped.generated — never kept nor partition().omitted (enabled)', () => {
      const normal = makeFile('src/main.ts');
      const generated = { ...fileWithHunkLines(['// @generated by tool']), path: 'src/api.gen.ts' };
      const { kept, dropped } = selectReviewableFiles([normal, generated], enabled(10));
      expect(kept.map((f) => f.path)).toEqual(['src/main.ts']);
      expect(dropped.generated.map((f) => f.path)).toEqual(['src/api.gen.ts']);
      const { omitted } = partitionReviewableFiles([normal, generated], enabled(10));
      expect(omitted.map((f) => f.path)).not.toContain('src/api.gen.ts');
    });

    // A diverse, deliberately shuffled input reused across the disabled-branch assertions. Includes a
    // file that WOULD be generated-detected ('c.ts') to prove the disabled branch never runs the detector.
    const shuffled: FileDiff[] = [
      makeFile('b.ts'),
      makeFile('a.ts'),
      { ...fileWithHunkLines(['// @generated']), path: 'c.ts' },
      makeFile('d.ts', { isNew: true }),
      makeFile('e.ts'),
    ];
    // The FROZEN legacy sort oracle: Number(isNew) asc, then path.localeCompare. New file 'd.ts' sorts last.
    const legacySorted = [...shuffled].sort(
      (left, right) => Number(left.isNew) - Number(right.isNew) || left.path.localeCompare(right.path),
    );

    it('disabled: selection is byte-identical to the frozen legacy sort and preserves the omitted remainder', () => {
      const { kept, dropped } = selectReviewableFiles(shuffled, disabled(2));
      expect(kept).toEqual(legacySorted.slice(0, 2));
      // overCap PRESERVES the legacy remainder (NOT []) — Codex 15-03 HIGH.
      expect(dropped.overCap).toEqual(legacySorted.slice(2));
      expect(dropped.generated).toEqual([]);
      // The detector is NOT invoked: the generated-looking 'c.ts' still appears in the selection.
      expect([...kept, ...dropped.overCap].map((f) => f.path)).toContain('c.ts');
    });

    it('disabled: review-rest reconstruction is unbroken — omitted keeps the full remainder', () => {
      const { kept, omitted } = partitionReviewableFiles(shuffled, disabled(2));
      expect(omitted).toHaveLength(3);
      expect([...kept, ...omitted]).toEqual(legacySorted);
    });

    it('two-path consistency: filter/partition both delegate to selectReviewableFiles', () => {
      const config = enabled(2);
      const select = selectReviewableFiles(shuffled, config);
      expect(filterReviewableFiles(shuffled, config)).toEqual(select.kept);
      const partition = partitionReviewableFiles(shuffled, config);
      expect(partition.kept).toEqual(select.kept);
      expect(partition.omitted).toEqual(select.dropped.overCap);
    });

    it('under-cap: buildWalkthroughData output is unchanged regardless of file order (walkthrough sorts independently)', () => {
      const rows: WalkthroughReviewRow[] = [
        { file_path: 'src/a.ts', file_summary: 'a', file_status: 'done', error_msg: null, verdict: 'comment', diff_line_count: 10, pass: 'main' },
        { file_path: 'src/b.ts', file_summary: 'b', file_status: 'done', error_msg: null, verdict: 'comment', diff_line_count: 20, pass: 'main' },
        { file_path: 'src/c.ts', file_summary: 'c', file_status: 'done', error_msg: null, verdict: 'comment', diff_line_count: 5, pass: 'main' },
      ];
      // Distinct severities per file so the walkthrough's severity-rank sort is a total order —
      // independent of the incoming review-row order (which the priority reorder may change).
      const finalComments = [
        { path: 'src/a.ts', severity: 'P0' },
        { path: 'src/b.ts', severity: 'P1' },
        { path: 'src/c.ts', severity: 'P2' },
      ] as unknown as Parameters<typeof buildWalkthroughData>[0]['finalComments'];
      const forward = buildWalkthroughData({ reviews: rows, finalComments });
      const reversed = buildWalkthroughData({ reviews: [...rows].reverse(), finalComments });
      expect(reversed).toEqual(forward);
      // Walkthrough orders by severity rank (P0 first), NOT by the review-row / kept-array order.
      expect(forward.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });
  });
});
