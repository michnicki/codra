import { describe, expect, it } from 'vitest';
import { buildFileReviewPrompts, UNTRUSTED_HISTORY_BEGIN } from '@server/prompts/file-review';
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

const configWithHistory = repoConfigSchema.parse({ review: { file_history: { enabled: true } } }).review;
const configToggleOff = repoConfigSchema.parse({}).review;

const mockHistory: VcsCommitEntry[] = [
  { hash: 'abc1234', message: 'fix: resolve race', files: ['src/locks.ts'], filesAvailable: true },
  { hash: 'def4567', message: 'feat: add retry', files: [], filesAvailable: true },
];

describe('NREG-01: file-history toggle-off byte-identical', () => {
  it('produces identical prompt when fileHistory is undefined', () => {
    const withoutKey = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
    });
    const withUndefined = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
      fileHistory: undefined,
    });
    expect(withUndefined.userPrompt).toBe(withoutKey.userPrompt);
  });

  it('ignores provided history when toggle is off', () => {
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configToggleOff,
      fileHistory: mockHistory,
    });
    // The toggle is the gate; a provided-but-disabled history is ignored (toggle-aware builder).
    expect(result.userPrompt).not.toContain(UNTRUSTED_HISTORY_BEGIN);
  });

  it('produces identical system prompt regardless of fileHistory', () => {
    const withHistory = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
      fileHistory: mockHistory,
    });
    const withoutHistory = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: configWithHistory,
    });
    expect(withHistory.systemPrompt).toBe(withoutHistory.systemPrompt);
  });
});
