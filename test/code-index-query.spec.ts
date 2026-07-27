// Phase 29 / QA-IDX-01, Plan 29-01 Task 2 — query-term normalization and expression construction.
//
// Why this spec exists: the reviewer's question is attacker-controlled free text, and every measured
// failure mode here is SILENT rather than loud.
//
// to_tsquery RAISES on operator characters -- `foo & (`, `foo!!bad` and `');drop table x;--` all error
// -- which is why this codebase uses websearch_to_tsquery instead. But websearch_to_tsquery has its
// own mini-syntax, and each of its four hazards CHANGES THE MEANING of the query without erroring
// (all measured on PostgreSQL 17.10):
//
//   `user OR "quoted phrase" OR x`  ->  'user' | 'quot' <-> 'phrase' | 'x'   (a PHRASE search)
//   `user OR -negated OR y`         ->  'user' | !'negat' | 'y'              (a NEGATION)
//   `a OR b OR`                     ->  'b'                                  (the LEFT operand is dropped)
//   a literal term `or`             ->  consumed as the operator, never searched for
//
// Restricting every term to /^[a-z0-9]+$/ after normalization defeats all four at once. This spec
// pins that restriction, plus the emptiness contract: an all-stopword question must yield NO
// expression, so the caller skips the statement rather than issuing a query whose tsquery reduces to
// the empty expression (measured: `the OR of OR and` -> '' with numnode 0).
//
// Pure module: no database, so this file runs standalone.

import { describe, expect, it } from 'vitest';
import {
  CODE_INDEX_MAX_QUERY_TERMS,
  buildQueryExpression,
  buildQueryTerms,
} from '@server/core/code-index';

describe('buildQueryTerms normalization', () => {
  it('yields lowercase alphanumeric terms for a plain question', () => {
    const terms = buildQueryTerms('Where is the retry budget computed?');

    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(term).toMatch(/^[a-z0-9]+$/);
    }
    expect(terms).toEqual(expect.arrayContaining(['retry', 'budget', 'computed']));
  });

  it('drops stopwords', () => {
    const terms = buildQueryTerms('where is the lease renewed and by what');

    for (const stopword of ['where', 'is', 'the', 'and', 'by', 'what']) {
      expect(terms).not.toContain(stopword);
    }
    expect(terms).toEqual(expect.arrayContaining(['lease', 'renewed']));
  });

  it('deduplicates while preserving first-seen order', () => {
    const terms = buildQueryTerms('lease lease renewal lease renewal');

    expect(terms).toEqual([...new Set(terms)]);
    expect(terms.indexOf('lease')).toBeLessThan(terms.indexOf('renewal'));
  });

  it.each([
    ['a double quote (phrase-search hazard)', 'user OR "quoted phrase" OR x'],
    ['a leading hyphen (negation hazard)', 'user -negated y'],
    ['tsquery operator characters', "');drop table x;-- foo & ( bar!!baz"],
    ['punctuation-only tokens', 'lease !!! ((( --- ??? renewal'],
  ])('neutralizes %s', (_label, question) => {
    const terms = buildQueryTerms(question);

    for (const term of terms) {
      expect(term).toMatch(/^[a-z0-9]+$/);
      // The reserved operator word is never emitted as a term.
      expect(term).not.toBe('or');
    }
    // No term retains a quote, a leading hyphen, or any operator character.
    expect(terms.join(' ')).not.toMatch(/["\-&|!():*]/);
  });

  it('drops a literal `or` so it cannot be consumed as the joiner', () => {
    expect(buildQueryTerms('cache or lease')).not.toContain('or');
  });

  it('splits an identifier pasted into the question, keeping the whole token too', () => {
    const terms = buildQueryTerms('what does getUserById return');

    expect(terms).toContain('getuserbyid');
    expect(terms).toEqual(expect.arrayContaining(['get', 'user', 'id']));
  });

  it('truncates to CODE_INDEX_MAX_QUERY_TERMS distinct terms', () => {
    const question = Array.from({ length: 80 }, (_, i) => `alpha${i}bravo`).join(' ');

    const terms = buildQueryTerms(question);

    expect(CODE_INDEX_MAX_QUERY_TERMS).toBe(32);
    expect(terms).toHaveLength(CODE_INDEX_MAX_QUERY_TERMS);
  });

  it.each([
    ['only stopwords', 'the of and is a to'],
    ['only punctuation', '!!! ((( --- ??? ***'],
    ['an empty question', ''],
    ['whitespace only', '   \n\t  '],
  ])('yields an empty array for %s, and buildQueryExpression returns null', (_label, question) => {
    const terms = buildQueryTerms(question);

    expect(terms).toEqual([]);
    expect(buildQueryExpression(terms)).toBeNull();
  });
});

describe('buildQueryExpression', () => {
  it("joins terms with ' OR ' and never emits a dangling joiner", () => {
    const terms = buildQueryTerms('where does retrieval scope by repository');
    const expression = buildQueryExpression(terms);

    expect(expression).toBe(terms.join(' OR '));
    expect(expression).not.toMatch(/(^\s*OR\b|\bOR\s*$)/);
    // Every operand between joiners is a real, non-empty term -- a dangling joiner would silently
    // drop its LEFT operand.
    for (const operand of expression!.split(' OR ')) {
      expect(operand).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('returns null for an empty term list rather than an expression that matches nothing', () => {
    expect(buildQueryExpression([])).toBeNull();
  });

  it('handles a single term without introducing a joiner', () => {
    expect(buildQueryExpression(['lease'])).toBe('lease');
  });
});
