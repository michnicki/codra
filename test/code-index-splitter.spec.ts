// Phase 29 / QA-IDX-01, Plan 29-01 Task 2 — the identifier splitter and the write/query symmetry.
//
// Why this spec exists: to_tsvector('english', 'src/server/core/code-index.ts') was MEASURED on
// PostgreSQL 17.10 to produce exactly ONE lexeme -- the whole path -- so a question about "code index"
// never matches a chunk indexed from the raw path. Postgres's path tokenization is also
// unpredictable: 'a_b/c-d/e.f.g.ts' silently DROPS the leading 'a_'. That is why splitting happens in
// JS here, and why the pre-split words are appended alongside the raw path. The resulting retrieval
// miss would be INVISIBLE: Q&A fails open to diff-only (D-15), so a broken splitter looks exactly
// like a question whose answer is not in the index.
//
// The last case in this file is the write/query symmetry invariant. It is the reason this module
// exists as ONE shared splitter (Pitfall 8): a divergence between the two directions cannot be caught
// by testing either direction alone -- each side would pass its own spec while no term ever met a
// stored lexeme.
//
// Pure module: no database, so this file runs standalone.

import { describe, expect, it } from 'vitest';
import { buildIndexTokens, buildQueryTerms } from '@server/core/code-index';

/** The tokens buildIndexTokens contributes for some content, as a flat whitespace-split list. */
function contentTokenList(content: string): string[] {
  return buildIndexTokens('src/x.ts', content).contentTokens.split(/\s+/);
}

/**
 * The lexeme set a Postgres tokenization of buildIndexTokens' output would plausibly contain:
 * lowercased and broken on every non-alphanumeric run. Deliberately a SUPERSET model of Postgres's
 * own parser -- the real DB-level truth (that a stored vector actually matches a real tsquery) is
 * pinned by the live retrieval cases in test/code-index-tracer.spec.ts. What this model is exact
 * about is the thing the symmetry invariant needs: whether a term is REACHABLE at all.
 */
function indexLexemeSet(path: string, content: string): Set<string> {
  const { pathTokens, contentTokens } = buildIndexTokens(path, content);
  return new Set(
    `${pathTokens} ${contentTokens}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0),
  );
}

describe('buildIndexTokens path tokenization (Pitfall-1 regression guard)', () => {
  it('emits the RAW path plus each split component word', () => {
    const { pathTokens } = buildIndexTokens('src/server/core/code-index.ts', '');
    const tokens = pathTokens.split(/\s+/);

    // The raw path is retained so exact-path queries still work.
    expect(tokens[0]).toBe('src/server/core/code-index.ts');
    // ...and the component words are what a word-level query can actually reach.
    expect(tokens).toEqual(
      expect.arrayContaining(['src', 'server', 'core', 'code', 'index', 'ts']),
    );
  });

  it('splits the path shapes Postgres tokenizes wrongly or drops entirely', () => {
    // Measured: to_tsvector drops the leading `a_` of this path completely.
    const tokens = buildIndexTokens('a_b/c-d/e.f.g.ts', '').pathTokens.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'ts']));

    // Measured: `packages/@scope/pkg/src/index.ts` tokenizes to 'packag' + one compound lexeme.
    const scoped = buildIndexTokens('packages/@scope/pkg/src/index.ts', '').pathTokens.split(/\s+/);
    expect(scoped).toEqual(
      expect.arrayContaining(['packages', 'scope', 'pkg', 'src', 'index', 'ts']),
    );
  });

  it('never drops the raw path even when it has no split-able boundary', () => {
    expect(buildIndexTokens('README', '').pathTokens).toContain('README');
  });
});

describe('identifier splitting (D-02)', () => {
  it('splits camelCase while retaining the original token in the indexed text', () => {
    const tokens = contentTokenList('export function getUserById(id) {}');

    // The original token is still present verbatim (it is part of `content`).
    expect(tokens).toContain('getUserById(id)');
    // ...and the component words are appended.
    expect(tokens).toEqual(expect.arrayContaining(['get', 'user', 'by', 'id']));
  });

  it('splits snake_case, kebab-case and SCREAMING_SNAKE', () => {
    expect(contentTokenList('snake_case_name')).toEqual(
      expect.arrayContaining(['snake', 'case', 'name']),
    );
    expect(contentTokenList('kebab-case-name')).toEqual(
      expect.arrayContaining(['kebab', 'case', 'name']),
    );
    expect(contentTokenList('SCREAMING_SNAKE')).toEqual(
      expect.arrayContaining(['screaming', 'snake']),
    );
  });

  it('breaks an uppercase acronym run before the word that follows it', () => {
    expect(contentTokenList('class HTTPServerAdapter {}')).toEqual(
      expect.arrayContaining(['http', 'server', 'adapter']),
    );
  });

  it('preserves digits as their own terms in both directions', () => {
    expect(contentTokenList('const sha256Hash = 1;')).toEqual(
      expect.arrayContaining(['sha', '256', 'hash']),
    );
    expect(buildIndexTokens('db/migrations/018_code_index.sql', '').pathTokens.split(/\s+/)).toEqual(
      expect.arrayContaining(['db', 'migrations', '018', 'code', 'index', 'sql']),
    );
  });

  it('does not throw on non-ASCII input and contributes no bogus terms', () => {
    expect(() => buildIndexTokens('src/café/日本語.ts', 'const café = "日本語";')).not.toThrow();
    const tokens = buildIndexTokens('src/café/日本語.ts', 'const café = "日本語";').pathTokens.split(/\s+/);
    for (const token of tokens.slice(1)) {
      expect(token).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('is idempotent over its own output (re-normalizing changes nothing)', () => {
    const question = 'find getUserById in userService';
    const once = buildQueryTerms(question);
    const twice = buildQueryTerms(once.join(' '));

    expect(once.length).toBeGreaterThan(0);
    expect(twice).toEqual(once);
  });
});

describe('write/query symmetry invariant (Pitfall 8 — the failure this module exists to prevent)', () => {
  it.each([
    ['getUserById', 'src/server/db/users.ts', 'export function getUserById(id: string) {}'],
    ['user_session_token', 'src/server/core/session.ts', 'const user_session_token = read();'],
    ['HTTPServerAdapter', 'src/server/net/http.ts', 'class HTTPServerAdapter implements Adapter {}'],
  ])('every term a question about %s yields is reachable in the index tokens', (identifier, path, content) => {
    const terms = buildQueryTerms(`what does ${identifier} do`);
    const lexemes = indexLexemeSet(path, content);

    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(lexemes.has(term)).toBe(true);
    }
  });
});
