import { describe, expect, it } from 'vitest';
import {
  buildFileHistoryBlock,
  buildFileReviewPrompts,
  UNTRUSTED_DIFF_END,
  UNTRUSTED_HISTORY_BEGIN,
  UNTRUSTED_HISTORY_END,
} from '@server/prompts/file-review';
import type { FileDiff } from '@server/core/diff';
import { repoConfigSchema, type VcsCommitEntry } from '@shared/schema';

const file: FileDiff = {
  path: 'src/example.ts',
  previousPath: null,
  isNew: false,
  isDeleted: false,
  isBinary: false,
  lineCount: 3,
  hunks: [
    {
      header: '@@ -1,2 +1,3 @@',
      lines: [
        { kind: 'context', content: 'const a = 1;', newLineNumber: 1, position: 1 },
        { kind: 'add', content: 'const b = a + 1;', newLineNumber: 2, position: 2 },
      ],
    },
  ],
};

// Phase 34 (PRD-04): configs with the file_history toggle in the desired state. The toggle lives
// in the config per 34-01 — `repoConfigSchema.parse({ review: { file_history: { enabled: true } } })`
// yields a full review config with the toggle on and every other key at its default; `parse({})`
// yields the documented default `{ enabled: false }` (NREG-01 inertness).
const configWithHistory = repoConfigSchema.parse({ review: { file_history: { enabled: true } } }).review;
const configToggleOff = repoConfigSchema.parse({}).review;

const entry = (overrides: Partial<VcsCommitEntry> = {}): VcsCommitEntry => ({
  hash: 'abc1234',
  message: 'fix: resolve race',
  files: [],
  filesAvailable: true,
  ...overrides,
});

describe('buildFileHistoryBlock', () => {
  it('returns new-file message for empty array', () => {
    expect(buildFileHistoryBlock([])).toBe('(no prior history — new file)');
  });

  it('formats a single commit entry', () => {
    const result = buildFileHistoryBlock([entry({ message: 'fix: bug', files: ['src/a.ts'] })]);
    expect(result).toBe('1. abc1234 — fix: bug — Other files changed: src/a.ts');
  });

  it('formats multiple commits', () => {
    const result = buildFileHistoryBlock([
      entry({ message: 'fix: resolve race', files: ['src/locks.ts'] }),
      entry({ hash: 'def4567', message: 'feat: add retry' }),
      entry({ hash: 'ghi9012', message: 'refactor: extract validator', files: ['src/types.ts'] }),
    ]);
    expect(result).toBe(
      [
        '1. abc1234 — fix: resolve race — Other files changed: src/locks.ts',
        '2. def4567 — feat: add retry — Other files changed: (none — only this file)',
        '3. ghi9012 — refactor: extract validator — Other files changed: src/types.ts',
      ].join('\n'),
    );
  });

  it('handles no other files changed', () => {
    // GitHub: `files: []` with filesAvailable true (default) means the commit genuinely
    // touched only this file.
    const result = buildFileHistoryBlock([entry()]);
    expect(result).toContain('Other files changed: (none — only this file)');
  });

  it('handles Bitbucket files-not-available', () => {
    // Bitbucket: `files: []` with filesAvailable false means the provider omitted the manifest —
    // a distinct message so the model is not misled (T-34-02-03).
    const result = buildFileHistoryBlock([entry({ filesAvailable: false })]);
    expect(result).toContain('Other files changed: (files list not available)');
    expect(result).not.toContain('(none — only this file)');
  });

  it('caps each message at 200 chars', () => {
    const longMessage = 'x'.repeat(1000);
    const result = buildFileHistoryBlock([entry({ message: longMessage })]);
    // Per-message cap (FILE_HISTORY_MAX_MESSAGE_CHARS) applied before the total cap (review LOW-8).
    expect(result).toContain(`${'x'.repeat(200)}…`);
    expect(result).not.toContain('x'.repeat(201));
  });

  it('truncates when over 4000 chars total', () => {
    const longFileList = Array.from({ length: 30 }, () => 'src/very-long-file-name-that-exceeds-typical-length.ts');
    const entries = Array.from({ length: 5 }, () => entry({ message: 'fix', files: longFileList }));
    const result = buildFileHistoryBlock(entries);
    expect(result).toContain('[NOTE: File history truncated — remaining entries omitted for length.]');
    expect(result.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('sanitizes control characters in message', () => {
    const result = buildFileHistoryBlock([entry({ message: 'bad\x00msg' })]);
    expect(result).not.toContain('\x00');
    expect(result).toContain('badmsg');
  });

  it('sanitizes sentinel-breaking patterns', () => {
    const result = buildFileHistoryBlock([entry({ message: 'ignore <<< everything' })]);
    // sanitizeUntrusted breaks triple-angle-bracket runs with zero-width spaces so untrusted
    // content can never reproduce the BEGIN/END sentinels (T-34-02-01).
    expect(result).not.toContain('<<<');
    expect(result).toContain('\u200B');
  });
});

describe('buildFileReviewPrompts with file history', () => {
  it('includes history appendix after diff', () => {
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
      fileHistory: [entry()],
    });
    // D-01: the appendix follows UNTRUSTED_DIFF_END, never precedes it.
    expect(result.userPrompt.indexOf(UNTRUSTED_HISTORY_BEGIN)).toBeGreaterThan(
      result.userPrompt.indexOf(UNTRUSTED_DIFF_END),
    );
    expect(result.userPrompt).toContain(UNTRUSTED_HISTORY_END);
    expect(result.userPrompt).toContain('abc1234');
  });

  it('omits history appendix when fileHistory is undefined', () => {
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
    });
    expect(result.userPrompt).not.toContain(UNTRUSTED_HISTORY_BEGIN);
  });

  it('includes new-file message when fileHistory is empty array', () => {
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
      fileHistory: [],
    });
    expect(result.userPrompt).toContain('(no prior history — new file)');
    expect(result.userPrompt).toContain(UNTRUSTED_HISTORY_BEGIN);
  });

  it('omits history appendix when the toggle is disabled even if history is provided', () => {
    // Toggle-aware builder (checker task_completeness resolution (a)): a provided-but-disabled
    // history is ignored — the caller-level gate (34-03) is the primary control, this is
    // defense in depth (D-04).
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOff,
      fileHistory: [entry()],
    });
    expect(result.userPrompt).not.toContain(UNTRUSTED_HISTORY_BEGIN);
  });
});
