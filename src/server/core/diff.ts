import picomatch from 'picomatch';
import type { RepoConfig } from '@shared/schema';
import { scoreFile } from './priority';

export type DiffLineKind = 'context' | 'add' | 'del';

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  position: number;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type FileDiff = {
  path: string;
  previousPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  lineCount: number;
  hunks: DiffHunk[];
  isTruncated?: boolean;
  originalLineCount?: number;
};

const defaultSkipMatchers = ['**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.min.js'].map((pattern) =>
  picomatch(pattern, { dot: true }),
);

export function isReviewableFile(path: string, customMatchers: ReturnType<typeof picomatch>[]) {
  if (defaultSkipMatchers.some((matcher) => matcher(path))) return false;
  if (customMatchers.some((matcher) => matcher(path))) return false;
  return true;
}

export function parseUnifiedDiff(rawDiff: string, reviewConfig?: RepoConfig['review']): FileDiff[] {
  const files: FileDiff[] = [];
  const customMatchers = reviewConfig?.skip_files?.map((pattern) => picomatch(pattern, { dot: true })) ?? [];

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let isIgnored = false;

  const pushCurrentFile = () => {
    if (currentFile) {
      files.push(currentFile);
    }
    currentFile = null;
    currentHunk = null;
    oldLine = 0;
    newLine = 0;
    position = 0;
    isIgnored = false;
  };

  let startIndex = 0;
  const length = rawDiff.length;

  while (startIndex < length) {
    let endIndex = rawDiff.indexOf('\n', startIndex);
    if (endIndex === -1) {
      endIndex = length;
    }

    let line = rawDiff.substring(startIndex, endIndex);
    if (line.charCodeAt(line.length - 1) === 13) {
      line = line.slice(0, -1);
    }

    startIndex = endIndex + 1;

    if (line.startsWith('diff --git ')) {
      pushCurrentFile();
      const lastSpace = line.lastIndexOf(' ');
      const bPath = line.substring(lastSpace + 1);
      const path = bPath.startsWith('b/') ? bPath.slice(2) : bPath;

      currentFile = {
        path,
        previousPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        lineCount: 0,
        hunks: [],
      };

      if (reviewConfig) {
        isIgnored = !isReviewableFile(path, customMatchers);
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('rename from ')) {
      currentFile.previousPath = line.slice(12);
      continue;
    }

    if (line.startsWith('rename to ')) {
      const nextPath = line.slice(10);
      currentFile.path = nextPath.startsWith('b/') ? nextPath.slice(2) : nextPath;
      if (reviewConfig) {
        isIgnored = !isReviewableFile(currentFile.path, customMatchers);
      }
      continue;
    }

    if (line.startsWith('new file mode ')) {
      currentFile.isNew = true;
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      currentFile.isDeleted = true;
      isIgnored = true;
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      currentFile.isBinary = true;
      isIgnored = true;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const nextPath = line.slice(4);
      currentFile.path = nextPath.startsWith('b/') ? nextPath.slice(2) : nextPath;
      if (reviewConfig) {
        isIgnored = !isReviewableFile(currentFile.path, customMatchers);
      }
      continue;
    }

    if (isIgnored) {
      continue;
    }

    if (line.startsWith('--- ')) {
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) {
        continue;
      }

      oldLine = Number.parseInt(match[1], 10);
      newLine = Number.parseInt(match[2], 10);
      currentHunk = {
        header: line,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    const prefix = line[0];
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      continue;
    }

    position += 1;

    if (prefix === ' ') {
      currentHunk.lines.push({
        kind: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        position,
      });
      oldLine += 1;
      newLine += 1;
      currentFile.lineCount += 1;
      continue;
    }

    if (prefix === '+') {
      currentHunk.lines.push({
        kind: 'add',
        content: line.slice(1),
        newLineNumber: newLine,
        position,
      });
      newLine += 1;
      currentFile.lineCount += 1;
      continue;
    }

    currentHunk.lines.push({
      kind: 'del',
      content: line.slice(1),
      oldLineNumber: oldLine,
      position,
    });
    oldLine += 1;
    currentFile.lineCount += 1;
  }

  pushCurrentFile();

  return files.filter((file) => file.path);
}

export function getValidNewLines(file: FileDiff) {
  return new Set(
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== 'del' && line.newLineNumber !== undefined)
        .map((line) => line.newLineNumber as number),
    ),
  );
}

export function getValidPositions(file: FileDiff) {
  return new Set(
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== 'del')
        .map((line) => line.position),
    ),
  );
}

export function findPositionForLine(file: FileDiff, lineNumber: number) {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber && line.kind !== 'del') {
        return line.position;
      }
    }
  }

  return undefined;
}

export function findClosestValidLine(file: FileDiff, targetLine: number): number | undefined {
  const validLines = Array.from(getValidNewLines(file)).sort((a, b) => a - b);
  if (validLines.length === 0) return undefined;

  // Find the closest line in the diff
  let closest = validLines[0];
  let minDiff = Math.abs(targetLine - closest);

  for (const line of validLines) {
    const diff = Math.abs(targetLine - line);
    if (diff < minDiff) {
      minDiff = diff;
      closest = line;
    }
  }

  // If the closest line is too far away (e.g. > 10 lines), maybe don't use it?
  // But for now, returning the closest is better than nothing if the model was close.
  // Actually, let's limit it to a reasonable range to avoid confusing placement.
  if (minDiff > 20) return undefined;

  return closest;
}

// PRIO-02 / D-09: content-based generated-file markers, locked verbatim by PRIO-02/SC2. Stored
// upper-cased so the scan uppercases only the candidate text once (not the marker list). These are
// matched as plain code-unit substrings via String.includes over a bounded window — linear,
// non-backtracking, no regex (threat T-15-03-01).
export const GENERATION_MARKERS = [
  'DO NOT EDIT',
  'AUTO-GENERATED',
  'GENERATED BY',
  'AUTOMATICALLY GENERATED',
  'THIS FILE IS GENERATED',
  '@GENERATED',
] as const;

/**
 * True iff a GENERATION_MARKER appears in the upper-cased first 500 chars of the joined content of
 * the file's first TWO hunks (D-09; window locked by PRIO-02/SC2). Reads `l.content` directly — the
 * diff +/-/space prefix is already stripped at parse (parseUnifiedDiff, line.slice(1); RESEARCH
 * Pitfall 3) so do NOT re-strip. Pure and total: a zero-hunk / empty-content file yields '' and
 * returns false, never throws. Case-insensitive via locale-independent toUpperCase; no Unicode
 * normalization is applied — markers match as UTF-16 code-unit substrings.
 */
export function isGeneratedFile(file: FileDiff): boolean {
  const text = file.hunks
    .slice(0, 2)
    .flatMap((hunk) => hunk.lines)
    .map((line) => line.content)
    .join('\n')
    .slice(0, 500)
    .toUpperCase();
  return GENERATION_MARKERS.some((marker) => text.includes(marker));
}

/** The result of the single shared selection routine (D-04). `dropped` is consumed by the Plan 15-05
 * prepare-phase recorder; the pure module RETURNS it rather than emitting audit events. */
export type FileSelectionResult = {
  kept: FileDiff[];
  dropped: {
    // Content-detected generated files (enabled branch only). Excluded from BOTH kept and overCap
    // so they never enter the review-rest skipped_files queue (they'd be wrongly re-reviewed).
    generated: FileDiff[];
    // The remainder past max_files. In BOTH branches this is `sorted.slice(max_files)` — the legacy
    // remainder — so partitionReviewableFiles().omitted (= overCap) and the review-rest
    // reconstruction (`[...kept, ...omitted]`, review.ts:2301) stay byte-identical (Codex 15-03 HIGH).
    overCap: FileDiff[];
  };
};

/**
 * The ONE selection routine both public selectors (filterReviewableFiles / partitionReviewableFiles)
 * delegate to (D-04 two-path consistency). Both branches first apply the identical glob filter
 * (drop deleted/binary, default skip matchers, custom skip_files). Then:
 *
 *  - `file_selection.enabled` (D-02): partition out isGeneratedFile matches into dropped.generated,
 *    sort the remainder by scoreFile DESCENDING (path.localeCompare tiebreak), keep the top max_files.
 *  - disabled (D-03): a FROZEN, byte-identical copy of the legacy sort — the generated detector is
 *    NOT run and overCap PRESERVES the legacy remainder so review-rest reconstruction is unbroken.
 *    The "zero file_skipped events when disabled" guarantee is enforced downstream (15-05) by gating
 *    emission on file_selection.enabled, NEVER by erasing overCap here.
 *
 * Pure / I/O-free: it RETURNS drop metadata; it does NOT import db/env/logger or emit audit events.
 */
export function selectReviewableFiles(files: FileDiff[], config: RepoConfig['review']): FileSelectionResult {
  const customMatchers = config.skip_files.map((pattern) => picomatch(pattern, { dot: true }));

  const filtered = files
    .filter((file) => !file.isDeleted && !file.isBinary)
    .filter((file) => !defaultSkipMatchers.some((matcher) => matcher(file.path)))
    .filter((file) => !customMatchers.some((matcher) => matcher(file.path)));

  if (config.file_selection.enabled) {
    const generated: FileDiff[] = [];
    const candidates: FileDiff[] = [];
    for (const file of filtered) {
      if (isGeneratedFile(file)) generated.push(file);
      else candidates.push(file);
    }
    // Descending scoreFile; `left.path.localeCompare(right.path)` is the deterministic tiebreak,
    // mirroring the legacy sort's secondary key so equal-score ordering stays stable.
    const sorted = candidates.sort(
      (left, right) => scoreFile(right) - scoreFile(left) || left.path.localeCompare(right.path),
    );
    return {
      kept: sorted.slice(0, config.max_files),
      dropped: { generated, overCap: sorted.slice(config.max_files) },
    };
  }

  // FROZEN legacy branch (D-03): character-for-character the pre-phase sort — a provable byte-identical
  // revert. Do NOT run the generated detector here.
  const sorted = filtered.sort(
    (left, right) => Number(left.isNew) - Number(right.isNew) || left.path.localeCompare(right.path),
  );
  return {
    kept: sorted.slice(0, config.max_files),
    // overCap PRESERVES the legacy remainder (NOT []) — see FileSelectionResult.overCap (Codex 15-03 HIGH).
    dropped: { generated: [], overCap: sorted.slice(config.max_files) },
  };
}

export function filterReviewableFiles(files: FileDiff[], config: RepoConfig['review']) {
  return selectReviewableFiles(files, config).kept;
}

/**
 * CMD-02 / D-10 (Phase 11): partition the reviewable file set at the `max_files` boundary so the
 * skipped-for-size bookkeeping (skipped_files table) can record exactly the files a full review
 * DROPPED, and a later `review-rest` run can re-review them.
 *
 * Now delegates to the single shared selectReviewableFiles routine (D-04): `kept` is
 * `selectReviewableFiles(...).kept` and `omitted` is `dropped.overCap`. Generated files (enabled
 * branch) are in dropped.generated and appear in NEITHER kept NOR omitted — they must never enter the
 * review-rest skipped_files queue (T-15-03-03). When file_selection is disabled the routine's frozen
 * legacy branch keeps this byte-identical to the pre-phase behavior, so `[...kept, ...omitted]` still
 * reconstructs the full legacy remainder (review.ts:2301, Codex 15-03 HIGH).
 */
export function partitionReviewableFiles(
  files: FileDiff[],
  config: RepoConfig['review'],
): { kept: FileDiff[]; omitted: FileDiff[] } {
  const { kept, dropped } = selectReviewableFiles(files, config);
  return { kept, omitted: dropped.overCap };
}

export function truncateFileDiff(file: FileDiff, maxLines: number): FileDiff {
  if (file.lineCount <= maxLines) {
    return file;
  }

  let currentLines = 0;
  const keptHunks: DiffHunk[] = [];

  for (const hunk of file.hunks) {
    const remainingLines = maxLines - currentLines;
    if (remainingLines <= 0) {
      break;
    }

    if (hunk.lines.length <= remainingLines) {
      keptHunks.push(hunk);
      currentLines += hunk.lines.length;
      continue;
    }

    keptHunks.push({
      ...hunk,
      lines: hunk.lines.slice(0, remainingLines),
    });
    currentLines += remainingLines;
    break;
  }

  return {
    ...file,
    hunks: keptHunks,
    lineCount: currentLines,
    isTruncated: true,
    originalLineCount: file.lineCount,
  };
}

export function chunkFileDiff(file: FileDiff, maxLinesPerChunk: number): FileDiff[] {
  if (file.lineCount <= maxLinesPerChunk) {
    return [file];
  }

  const chunks: FileDiff[] = [];
  let currentHunks: DiffHunk[] = [];
  let currentLines = 0;

  for (const hunk of file.hunks) {
    let linesRemainingInHunk = hunk.lines;

    while (linesRemainingInHunk.length > 0) {
      const roomInChunk = maxLinesPerChunk - currentLines;

      if (roomInChunk <= 0) {
        chunks.push({
          ...file,
          hunks: currentHunks,
          lineCount: currentLines,
          isTruncated: true,
          originalLineCount: file.lineCount,
        });
        currentHunks = [];
        currentLines = 0;
        continue;
      }

      if (linesRemainingInHunk.length <= roomInChunk) {
        currentHunks.push({
          ...hunk,
          lines: linesRemainingInHunk,
        });
        currentLines += linesRemainingInHunk.length;
        linesRemainingInHunk = [];
      } else {
        currentHunks.push({
          ...hunk,
          lines: linesRemainingInHunk.slice(0, roomInChunk),
        });
        currentLines += roomInChunk;
        linesRemainingInHunk = linesRemainingInHunk.slice(roomInChunk);
      }
    }
  }

  if (currentHunks.length > 0) {
    chunks.push({
      ...file,
      hunks: currentHunks,
      lineCount: currentLines,
      isTruncated: true,
      originalLineCount: file.lineCount,
    });
  }

  return chunks;
}
