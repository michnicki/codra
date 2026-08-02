// WR-01: targeted unit coverage for the qualifier-stripping transform on grep_repo queries.
//
// GitHub code search treats multiple repo: qualifiers as OR. A model-supplied
// query that smuggles "repo:attacker/evil" alongside the provider-appended
// "repo:owner/repo" would return results from both repositories — a
// cross-repository disclosure. The agenticActionSchema strips repo:, org:,
// and user: qualifiers from the model-supplied query before it reaches the
// provider adapter.

import { describe, it, expect } from 'vitest';
import { parseAgenticToolCall } from '../src/server/core/model-output';

function grepCall(query: string): string {
  return JSON.stringify({ action: 'grep_repo', query });
}

function expectQuery(raw: string, expected: string) {
  const result = parseAgenticToolCall(grepCall(raw));
  expect(result.kind).toBe('action');
  if (result.kind === 'action' && result.action.action === 'grep_repo') {
    expect(result.action.query).toBe(expected);
  }
}

function expectUnparseable(raw: string) {
  const result = parseAgenticToolCall(grepCall(raw));
  expect(result.kind).toBe('unparseable');
}

describe('WR-01 qualifier-stripping transform', () => {
  it('strips repo: qualifiers, preserving remaining keywords', () => {
    expectQuery('AWS_SECRET repo:acme/infra repo:attacker/evil', 'AWS_SECRET');
  });

  it('strips multiple qualifier types (org:, user:)', () => {
    expectQuery('memory leak org:evil-corp user:attacker', 'memory leak');
  });

  it('strips qualifier at end without trailing space', () => {
    expectQuery('TODO repo:github/gitignore', 'TODO');
  });

  it('strips qualifier with path-style value', () => {
    expectQuery('password repo:owner/repo-with/slashes', 'password');
  });

  it('strips case-insensitively', () => {
    expectQuery('secret Repo:foo/bar ORG:baz', 'secret');
  });

  it('preserves legitimate colon-containing terms', () => {
    expectQuery(
      'http://example.com status:active',
      'http://example.com status:active',
    );
  });

  it('returns unparseable when all content is a qualifier', () => {
    expectUnparseable('repo:only/qualifier');
  });

  it('leaves normal queries untouched', () => {
    expectQuery(
      'AWS_SECRET_KEY hardcoded credential',
      'AWS_SECRET_KEY hardcoded credential',
    );
  });
});
