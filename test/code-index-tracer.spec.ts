// Phase 29 / QA-IDX-01, Plan 29-01 Task 1 — the TRACER spec.
//
// One file proves the whole idea end to end on the thinnest real path: real source file content ->
// 50-line windows -> stored rows carrying a weighted tsvector -> a real ranked Postgres retrieval ->
// that hunk fenced as untrusted data inside a real buildQaPrompt call. Every later plan in this
// phase (provider tree walk, durable build Workflow, push webhooks, dashboard panel) is an expansion
// of this path, so if the tokenization, the A/D weighting, the storage shape or the fence is wrong,
// all of them are wrong -- and because retrieval fails open (D-15) every one of those failures is
// SILENT. This spec is what makes the core observable.
//
// The DB-backed cases are gated on hasConfiguredTestDatabaseUrl() the way
// test/migration-016-idempotency.spec.ts is, and migration 018 is applied to TEST_DATABASE_URL by
// `npm test` (scripts/test.mjs sets DATABASE_URL = TEST_DATABASE_URL then runs scripts/migrate.mjs).
// A bare `npx vitest run` applies NO migration, so a "relation does not exist" failure here is an
// un-migrated database, not a code defect.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildIndexTokens,
  buildQueryExpression,
  buildQueryTerms,
  chunkLines,
} from '@server/core/code-index';
import {
  retrieveCodeIndexChunks,
  upsertCodeIndexChunks,
  type CodeIndexChunkHit,
} from '@server/db/code-index';
import { getOrCreateRepository } from '@server/db/repositories';
import { queryRows } from '@server/db/client';
import {
  buildQaPrompt,
  QA_MAX_INDEX_CHARS,
  QA_SYSTEM_PROMPT,
  QA_SYSTEM_PROMPT_WITH_INDEX,
  UNTRUSTED_INDEX_BEGIN,
  UNTRUSTED_INDEX_END,
} from '@server/prompts/qa';
import { UNTRUSTED_DIFF_END } from '@server/prompts/file-review';
import { WINDOW_LINE_COUNT } from '@server/core/verify-fixes';
import { defaultRepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The real source file whose real 50-line windows are stored and retrieved. Reading it from disk
// (rather than inlining a fixture) is the point: the tracer must exercise real code shapes.
const REAL_PATH = 'src/server/db/code-index.ts';

function makeFile(lines: string[]): FileDiff {
  return {
    path: 'src/app.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: lines.length,
    hunks: [
      {
        header: '@@ -1 +1 @@',
        lines: lines.map((content, index) => ({
          kind: 'add' as const,
          content,
          newLineNumber: index + 1,
          position: index + 1,
        })),
      },
    ],
  };
}

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

describe('QA-IDX-01 tracer (pure): content -> windows -> tokens', () => {
  it('chunkLines yields 1-based inclusive 50-line windows over a 120-line file', () => {
    const content = Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

    const windows = chunkLines(content);

    expect(windows.map((w) => [w.start, w.end])).toEqual([
      [1, 50],
      [51, 100],
      [101, 120],
    ]);
    expect(WINDOW_LINE_COUNT).toBe(50);
    // The window content is the real slice, first line inclusive.
    expect(windows[0]!.content.split('\n')[0]).toBe('const line1 = 1;');
    expect(windows[2]!.content.split('\n').at(-1)).toBe('const line120 = 120;');
  });

  it('chunkLines still windows a 12-line file (it does NOT return null like windowFileContent)', () => {
    const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

    const windows = chunkLines(content);

    expect(windows).toHaveLength(1);
    expect(windows[0]!.start).toBe(1);
    expect(windows[0]!.end).toBe(12);
  });

  it('buildIndexTokens emits the raw path AND its split component words (Pitfall-1 guard)', () => {
    const { pathTokens } = buildIndexTokens('src/server/core/code-index.ts', 'const x = 1;');

    expect(pathTokens).toContain('src/server/core/code-index.ts');
    for (const word of ['src', 'server', 'core', 'code', 'index', 'ts']) {
      expect(pathTokens.split(/\s+/)).toContain(word);
    }
  });

  it('buildQueryTerms + buildQueryExpression produce an OR-joined expression from a question', () => {
    const terms = buildQueryTerms('where is the code index retrieval query');

    expect(terms).toContain('code');
    expect(terms).toContain('index');
    expect(terms).toContain('retrieval');
    // Stopwords never survive normalization.
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('is');

    expect(buildQueryExpression(terms)).toBe(terms.join(' OR '));
  });
});

dbDescribe('QA-IDX-01 tracer (DB): stored windows -> ranked retrieval', () => {
  const env = createTestEnv();
  let repositoryId = 0;
  let storedWindows: Array<{ start: number; end: number }> = [];

  beforeAll(async () => {
    repositoryId = await getOrCreateRepository(env, {
      installationId: '99000029',
      owner: 'codra-tracer-owner',
      repo: 'codra-tracer-29-01',
      vcsProvider: 'github',
    });
    await queryRows(env, 'DELETE FROM code_index_chunks WHERE repository_id = $1', [repositoryId]);

    const content = readFileSync(path.join(repoRoot, REAL_PATH), 'utf8');
    const windows = chunkLines(content);
    const { pathTokens } = buildIndexTokens(REAL_PATH, content);

    await upsertCodeIndexChunks(env, {
      repositoryId,
      path: REAL_PATH,
      indexedSha: 'a'.repeat(40),
      pathTokens,
      chunks: windows.map((w) => ({
        chunkStart: w.start,
        chunkEnd: w.end,
        content: w.content,
        contentTokens: buildIndexTokens(REAL_PATH, w.content).contentTokens,
      })),
    });

    storedWindows = windows.map((w) => ({ start: w.start, end: w.end }));
  });

  afterAll(async () => {
    if (repositoryId) {
      await queryRows(env, 'DELETE FROM code_index_chunks WHERE repository_id = $1', [repositoryId]);
    }
  });

  it('stores every 50-line window of a real source file for one repository', async () => {
    const rows = await queryRows<{ chunk_start: number; chunk_end: number; path: string }>(
      env,
      'SELECT path, chunk_start, chunk_end FROM code_index_chunks WHERE repository_id = $1 ORDER BY chunk_start ASC',
      [repositoryId],
    );

    expect(rows.length).toBe(storedWindows.length);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.path === REAL_PATH)).toBe(true);
    expect(rows.map((r) => [Number(r.chunk_start), Number(r.chunk_end)])).toEqual(
      storedWindows.map((w) => [w.start, w.end]),
    );
  });

  it('retrieves a specific hunk with a real line range, ranked, for a real question', async () => {
    const terms = buildQueryTerms('where is the code index retrieval query');
    const hits = await retrieveCodeIndexChunks(env, {
      repositoryId,
      queryExpression: buildQueryExpression(terms),
      limit: 8,
    });

    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    expect(hit.path).toBe(REAL_PATH);
    expect(storedWindows).toEqual(
      expect.arrayContaining([{ start: hit.chunkStart, end: hit.chunkEnd }]),
    );
    expect(hit.content.length).toBeGreaterThan(0);
    // Ranked, descending.
    const ranks = hits.map((h) => h.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it('ranks a path-token match ABOVE a body-only match for the same query (D-04)', async () => {
    const pathHit = 'src/server/db/code-index-retrieval.ts';
    const bodyHit = 'src/client/widget-render.ts';

    for (const [chunkPath, body] of [
      [pathHit, 'unrelated body text here'],
      [bodyHit, 'incidental mention of code index retrieval in a comment'],
    ] as const) {
      const tokens = buildIndexTokens(chunkPath, body);
      await upsertCodeIndexChunks(env, {
        repositoryId,
        path: chunkPath,
        indexedSha: 'b'.repeat(40),
        pathTokens: tokens.pathTokens,
        chunks: [{ chunkStart: 1, chunkEnd: 1, content: body, contentTokens: tokens.contentTokens }],
      });
    }

    const hits = await retrieveCodeIndexChunks(env, {
      repositoryId,
      queryExpression: buildQueryExpression(buildQueryTerms('code index retrieval')),
      limit: 50,
    });

    const rankOf = (p: string) => hits.find((h: CodeIndexChunkHit) => h.path === p)?.rank ?? -1;
    expect(rankOf(pathHit)).toBeGreaterThan(0);
    expect(rankOf(bodyHit)).toBeGreaterThan(0);
    expect(rankOf(pathHit)).toBeGreaterThan(rankOf(bodyHit));
  });

  it('returns [] for a null query expression WITHOUT issuing a statement', async () => {
    // An unroutable connection string: if the accessor issued a statement it would reject with a
    // connection error instead of resolving. postgres() is lazy, so no statement means no connect.
    const deadEnv = createTestEnv({
      HYPERDRIVE: { connectionString: 'postgresql://postgres@127.0.0.1:1/definitely-not-a-database' },
    });

    await expect(
      retrieveCodeIndexChunks(deadEnv, { repositoryId, queryExpression: null, limit: 8 }),
    ).resolves.toEqual([]);
    await expect(
      retrieveCodeIndexChunks(deadEnv, { repositoryId, queryExpression: '', limit: 8 }),
    ).resolves.toEqual([]);
  });
});

describe('QA-IDX-01 tracer (prompt): a retrieved hunk arrives inside its OWN fence', () => {
  const baseInput = {
    question: 'Where does retrieval scope by repository?',
    prTitle: 'Add code index',
    prBody: 'Adds a Postgres FTS index',
    files: [makeFile(['const answer = 42;'])],
    config: defaultRepoConfig.review,
  };

  it('selects the variant system prompt and fences the chunk with path + line range', () => {
    const chunk = {
      path: 'src/server/db/code-index.ts',
      chunkStart: 51,
      chunkEnd: 100,
      content: 'WHERE repository_id = $1',
    };

    const { systemPrompt, userPrompt } = buildQaPrompt({
      ...baseInput,
      indexChunks: [chunk],
      indexedSha: 'c'.repeat(40),
    });

    expect(systemPrompt).toBe(QA_SYSTEM_PROMPT_WITH_INDEX);
    expect(systemPrompt).not.toBe(QA_SYSTEM_PROMPT);
    expect(userPrompt).toContain(UNTRUSTED_INDEX_BEGIN);
    expect(userPrompt).toContain(UNTRUSTED_INDEX_END);

    const begin = userPrompt.lastIndexOf(UNTRUSTED_INDEX_BEGIN);
    const end = userPrompt.lastIndexOf(UNTRUSTED_INDEX_END);
    expect(begin).toBeLessThan(end);
    const fenced = userPrompt.slice(begin, end);
    expect(fenced).toContain(chunk.path);
    expect(fenced).toContain('51-100');
    expect(fenced).toContain('WHERE repository_id = $1');

    // The retrieved-context fence is its OWN pair, placed after the diff fence -- a reviewer (and
    // the model) must be able to tell PR changes from ambient repository context (D-14).
    expect(userPrompt.lastIndexOf(UNTRUSTED_DIFF_END)).toBeLessThan(begin);
    expect(UNTRUSTED_INDEX_BEGIN).not.toBe(UNTRUSTED_DIFF_END);
  });

  it('caps the retrieved-context block at QA_MAX_INDEX_CHARS and never loses the closing sentinel', () => {
    const { userPrompt } = buildQaPrompt({
      ...baseInput,
      indexChunks: [
        {
          path: 'src/generated/huge.ts',
          chunkStart: 1,
          chunkEnd: 50,
          content: 'x'.repeat(QA_MAX_INDEX_CHARS * 2),
        },
      ],
    });

    const begin = userPrompt.lastIndexOf(UNTRUSTED_INDEX_BEGIN);
    const end = userPrompt.lastIndexOf(UNTRUSTED_INDEX_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(end - begin).toBeLessThanOrEqual(QA_MAX_INDEX_CHARS + UNTRUSTED_INDEX_BEGIN.length + 200);
  });

  it('is byte-identical to a call without the new field when no chunks are supplied (NREG-01)', () => {
    const withoutField = buildQaPrompt({ ...baseInput });
    const emptyArray = buildQaPrompt({ ...baseInput, indexChunks: [] });
    const undefinedField = buildQaPrompt({ ...baseInput, indexChunks: undefined, indexedSha: null });

    expect(emptyArray.systemPrompt).toBe(QA_SYSTEM_PROMPT);
    expect(emptyArray.userPrompt).toBe(withoutField.userPrompt);
    expect(undefinedField.userPrompt).toBe(withoutField.userPrompt);
    expect(withoutField.userPrompt).not.toContain(UNTRUSTED_INDEX_BEGIN);
  });
});
