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

// CR-02 (34-REVIEW): a trailing `# comment` on a block-sequence item used to become part of the
// value. Zod accepts the result as a string, so the corruption was SILENT — no throw, no DB
// fallback, no yaml_config_parse_failed event — and the mangled glob/rule went straight into
// picomatch / the review prompt. These pin the strip on every `-` path.
describe('parseYaml — CR-02: inline comments on block-sequence items', () => {
  it('strips an inline comment from a plain list item', () => {
    expect(parseYaml('review:\n  custom_rules:\n    - rule one # note')).toEqual({
      review: { custom_rules: ['rule one'] },
    });
  });

  it('strips an inline comment from a QUOTED list item and still unquotes it', () => {
    const raw = ['review:', '  skip_files:', '    - "vendor/**"   # third-party', '    - "*.snap"'].join('\n');
    expect(parseYaml(raw)).toEqual({ review: { skip_files: ['vendor/**', '*.snap'] } });
  });

  it('does NOT strip a `#` that sits inside a quoted list item', () => {
    expect(parseYaml('items:\n  - "a # b"')).toEqual({ items: ['a # b'] });
  });

  it('strips an inline comment from an array-of-objects item line', () => {
    const raw = ['model:', '  size_overrides:', '    - max_lines: 200 # small', '      model: "gpt-4o"'].join('\n');
    expect(parseYaml(raw)).toEqual({ model: { size_overrides: [{ max_lines: 200, model: 'gpt-4o' }] } });
  });
});

// CR-03 (34-REVIEW): the flow-array splitter tracked bracket depth but not quote state, so a
// comma inside a quoted element split that element into two garbage entries with dangling
// quotes. Same silent-corruption class as CR-02.
describe('parseYaml — CR-03: commas inside quoted flow-array elements', () => {
  it('keeps a comma inside a double-quoted element', () => {
    expect(parseYaml('review:\n  custom_rules: ["Prefer const, not let", "No any"]')).toEqual({
      review: { custom_rules: ['Prefer const, not let', 'No any'] },
    });
  });

  it('keeps a comma inside a single-quoted element', () => {
    expect(parseYaml("on: ['a,b', 'c']")).toEqual({ on: ['a,b', 'c'] });
  });

  it('keeps a comma inside a quoted glob', () => {
    expect(parseYaml('review:\n  skip_files: ["a,b/**"]')).toEqual({ review: { skip_files: ['a,b/**'] } });
  });

  it('still splits on structural commas outside quotes', () => {
    expect(parseYaml('skip_files: ["a", b, "c"]')).toEqual({ skip_files: ['a', 'b', 'c'] });
  });

  it('does not treat a bracket inside a quoted element as nesting', () => {
    expect(parseYaml('skip_files: ["a[1],b", "c"]')).toEqual({ skip_files: ['a[1],b', 'c'] });
  });

  it('rejects an unterminated quoted element rather than mangling it', () => {
    expect(() => parseYaml('skip_files: ["a, b]')).toThrow(/^YAML parse error:/);
  });
});

// WR-02 (34-REVIEW): `.review.yaml` is UNTRUSTED PR-head content and the thrown message travels
// verbatim into jobs.audit (yaml_config_parse_failed.reason), the dashboard audit-trail viewer,
// and the logs. Messages must name the POSITION and the CONSTRUCT, never echo the source text.
describe('parseYaml — WR-02: error messages never echo source content', () => {
  it('reports a 1-based source line number instead of the failing line text', () => {
    // Line 3 is the offender; lines 1-2 are a comment and a blank line, which are dropped from
    // the significant-line list but still counted for the source line number.
    const raw = ['# header', '', 'this line has no colon'].join('\n');
    expect(() => parseYaml(raw)).toThrow("YAML parse error: expected 'key: value' at line 3");
  });

  it('does not leak a secret-looking line that sits inside the failing document', () => {
    const raw = ['api_token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'a colonless line'].join('\n');
    let message = '';
    try {
      parseYaml(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^YAML parse error:/);
    expect(message).not.toContain('ghp_');
    expect(message).not.toContain('a colonless line');
  });

  it('names the construct for an unsupported scalar without echoing it', () => {
    let message = '';
    try {
      parseYaml('key: &secret-anchor-name value');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('YAML parse error: unsupported anchor/alias/tag construct in a scalar value');
    expect(message).not.toContain('secret-anchor-name');
  });

  it('reports the line number for inconsistent indentation without the line text', () => {
    // Line 4 dedents to an indent no open block owns (3 sits between the b-block's 4 and a's 2).
    const raw = ['a:', '  b:', '    c: 1', '   password: hunter2'].join('\n');
    let message = '';
    try {
      parseYaml(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('YAML parse error: inconsistent indentation at line 4');
    expect(message).not.toContain('hunter2');
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
