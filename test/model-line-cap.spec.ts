import { vi, expect, describe, it } from 'vitest';
import { ModelService, COMPACT_REVIEW_PROMPT_LINE_CAP } from '@server/services/model';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';
import { runWithDb } from '@server/db/client';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('submitReviewBatch modelLineCap derivation', () => {
  const env = createTestEnv();

  it('returns modelLineCap === max_diff_lines_per_file when compactPrompt is false', async () => {
    await runWithDb(env, async () => {
      const model = new ModelService(env, undefined, undefined);
      // Spy on selectModel to return a known Cloudflare model (so resolveModel is reached)
      const selectSpy = vi.spyOn(model as any, 'selectModel').mockReturnValue({
        primary: 'gemini-2.5-pro',
        fallbacks: [],
      });
      // Spy on resolveModel to return a mock result that passes the apiFormat check
      vi.spyOn(model as any, 'resolveModel').mockResolvedValue({
        apiFormat: 'cloudflare-workers-ai',
        modelName: 'test-model',
      } as any);
      // Spy on callGate to avoid actual Cloudflare API call
      vi.spyOn(model as any, 'callGate', 'get').mockReturnValue({
        run: vi.fn().mockResolvedValue('req-1'),
      });

      const result = await model.submitReviewBatch({
        file: { content: 'test', lineCount: 100 },
        prTitle: null,
        prDescription: null,
        config: { review: { max_diff_lines_per_file: 800 } } as any,
        totalLineCount: 100,
        compactPrompt: false,
      });
      expect(result).not.toBeNull();
      expect(result!.modelLineCap).toBe(800);

      selectSpy.mockRestore();
    });
  });

  it('returns modelLineCap === COMPACT_REVIEW_PROMPT_LINE_CAP when compactPrompt is true', async () => {
    await runWithDb(env, async () => {
      const model = new ModelService(env, undefined, undefined);
      const selSpy = vi.spyOn(model as any, 'selectModel').mockReturnValue({
        primary: 'gemini-2.5-pro',
        fallbacks: [],
      });
      vi.spyOn(model as any, 'resolveModel').mockResolvedValue({
        apiFormat: 'cloudflare-workers-ai',
        modelName: 'test-model',
      } as any);
      vi.spyOn(model as any, 'callGate', 'get').mockReturnValue({
        run: vi.fn().mockResolvedValue('req-2'),
      });

      const result = await model.submitReviewBatch({
        file: { content: 'test', lineCount: 100 },
        prTitle: null,
        prDescription: null,
        config: { review: { max_diff_lines_per_file: 800 } } as any,
        totalLineCount: 100,
        compactPrompt: true,
      });
      expect(result).not.toBeNull();
      expect(result!.modelLineCap).toBe(COMPACT_REVIEW_PROMPT_LINE_CAP);

      selSpy.mockRestore();
    });
  });
});
