// Phase 34 (PRD-05, §15): unit tests for the standalone inline YAML parser (core/yaml-parse.ts).
//
// The parser is a line-oriented recursive-descent implementation covering the RepoConfig subset:
// comments, empty lines, nested objects, integer/float/boolean/string scalars, quoted strings,
// block-style string arrays, FLOW-style arrays, and arrays-of-objects. Unsupported constructs
// (multi-line block scalars, flow-style maps, anchors/aliases, tags, complex keys) MUST throw an
// Error whose message starts with "YAML parse error:" so the caller (D-12) always falls back to
// the DB config + a yaml_config_parse_failed audit event — never silent misbehavior.
//
// Pure — no DB, no mocks.

import { describe, expect, it } from 'vitest';
import { parseYaml } from '@server/core/yaml-parse';

describe('parseYaml — basics', () => {
  it('parses empty input to an empty object', () => {
    expect(parseYaml('')).toEqual({});
  });

  it('parses a single key-value pair', () => {
    expect(parseYaml('key: value')).toEqual({ key: 'value' });
  });

  it('parses nested objects from indentation', () => {
    expect(parseYaml('parent:\n  child: 1\n  other: two')).toEqual({
      parent: { child: 1, other: 'two' },
    });
  });

  it('ignores comment-only lines', () => {
    expect(parseYaml('# this is a comment\nkey: value')).toEqual({ key: 'value' });
  });

  it('ignores empty lines and scattered comments between keys', () => {
    const raw = [
      '# header comment',
      '',
      'a: 1',
      '',
      '# comment before b',
      'b: two',
      '',
    ].join('\n');
    expect(parseYaml(raw)).toEqual({ a: 1, b: 'two' });
  });
});

describe('parseYaml — scalar coercion', () => {
  it('parses integers including zero and negatives', () => {
    expect(parseYaml('a: 0\nb: -42\nc: 100')).toEqual({ a: 0, b: -42, c: 100 });
  });

  it('parses floats including negatives', () => {
    expect(parseYaml('a: 3.14\nb: -0.5')).toEqual({ a: 3.14, b: -0.5 });
  });

  it('parses booleans', () => {
    expect(parseYaml('a: true\nb: false')).toEqual({ a: true, b: false });
  });

  it('parses quoted strings and strips the surrounding quotes', () => {
    expect(parseYaml('a: "hello"\nb: "world"')).toEqual({ a: 'hello', b: 'world' });
  });

  it('treats everything else as a plain string', () => {
    expect(parseYaml('name: hello world')).toEqual({ name: 'hello world' });
  });
});

describe('parseYaml — arrays', () => {
  it('parses block-style string arrays', () => {
    expect(parseYaml('items:\n  - "one"\n  - "two"')).toEqual({ items: ['one', 'two'] });
  });

  it('parses block-style arrays of numbers', () => {
    expect(parseYaml('ports:\n  - 8080\n  - 8443')).toEqual({ ports: [8080, 8443] });
  });

  it('parses flow-style arrays with plain elements', () => {
    expect(parseYaml('on: [opened, synchronize]')).toEqual({ on: ['opened', 'synchronize'] });
  });

  it('parses flow-style arrays with quoted elements', () => {
    expect(parseYaml('skip_files: ["*.lock", "dist/**"]')).toEqual({
      skip_files: ['*.lock', 'dist/**'],
    });
  });

  it('tolerates a trailing comma in flow-style arrays', () => {
    expect(parseYaml('on: [opened, synchronize,]')).toEqual({ on: ['opened', 'synchronize'] });
  });

  it('parses arrays-of-objects', () => {
    const raw = ['model:', '  size_overrides:', '    - max_lines: 200', '      model: "gpt-4o"'].join('\n');
    expect(parseYaml(raw)).toEqual({
      model: { size_overrides: [{ max_lines: 200, model: 'gpt-4o' }] },
    });
  });
});

describe('parseYaml — unsupported constructs throw "YAML parse error:"', () => {
  it('rejects multi-line block scalars (| and >)', () => {
    expect(() => parseYaml('key: |\n  multi\n  line')).toThrow(/^YAML parse error:/);
    expect(() => parseYaml('key: >\n  folded\n  text')).toThrow(/^YAML parse error:/);
  });

  it('rejects flow-style maps', () => {
    expect(() => parseYaml('obj: {a: 1}')).toThrow(/^YAML parse error:/);
  });

  it('rejects anchors and aliases', () => {
    expect(() => parseYaml('key: &anchor value')).toThrow(/^YAML parse error:/);
  });

  it('rejects YAML tags', () => {
    expect(() => parseYaml('key: !!str value')).toThrow(/^YAML parse error:/);
  });
});
