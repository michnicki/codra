// Phase 34 (PRD-05, §15): minimal line-oriented recursive-descent YAML parser for the RepoConfig
// subset, standing in for an npm YAML library (zero new dependencies — RESEARCH §3 Option C).
// Pure string manipulation: no imports, no file system access, Cloudflare Workers-compatible.
//
// SUPPORTED: comment lines, empty lines, nested objects (indentation), integer/float/boolean/string
// scalars, quoted strings, block-style string arrays (`- item`) at EITHER a deeper indent than
// their key or the SAME indent as their key (WR-03/WR-06 — the same-indent form is what most YAML
// documentation shows, and rejecting it discarded an otherwise-valid config file), FLOW-style
// arrays (`key: [a, b]` — review MEDIUM-5: repoConfigSchema has legitimate flow-array shapes like
// skip_files), and arrays-of-objects (`- key: value` with deeper `key: value` continuation lines).
// A leading UTF-8 BOM is tolerated (WR-06).
//
// NOT SUPPORTED (must throw): multi-line block scalars (`|`, `>`), flow-style maps (`{}`),
// anchors/aliases (`&`, `*`), tags (`!!`), complex keys (quoted keys with spaces).
//
// FAIL-SAFE CONTRACT: any unsupported or unparseable construct throws an Error whose message starts
// with "YAML parse error:" — the caller (D-12) always catches, falls back to the DB config, and
// emits a yaml_config_parse_failed audit event. Never silent misbehavior: a mis-parse would
// otherwise silently alter review behavior via config. Users who rely on unsupported constructs get
// the DB config + an audit event, never a wrong config.
//
// ERROR-MESSAGE CONTRACT (WR-02, 34-REVIEW): a message MUST report the POSITION (1-based source
// line) and the offending CONSTRUCT — it must NEVER echo the source text. The message travels
// verbatim into `jobs.audit` (yaml_config_parse_failed.reason), the dashboard audit-trail viewer,
// and the logs, and `.review.yaml` is UNTRUSTED PR-head content: echoing the failing line leaked
// whatever a contributor put next to their syntax error (a stray `api_token: …` line, for
// instance) into a durable, operator-visible store. AUD-01 keeps that content class out of
// `jobs.audit`, and the phase's own PATTERNS note says "Do NOT log raw YAML (untrusted)".

type Context =
  | { kind: 'object'; indent: number; obj: Record<string, unknown> }
  | { kind: 'array'; indent: number; arr: unknown[] };

// Returns the index of the first `:` that terminates a key (followed by whitespace or EOL),
// respecting quoted sections; -1 when the line has no key-value split.
function findKeyValueColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const nextCh = text[i + 1];
      if (nextCh === undefined || nextCh === ' ' || nextCh === '\t') return i;
    }
  }
  return -1;
}

// Strips a trailing ` # comment` that sits outside quoted sections (YAML: `#` starts a comment
// only when preceded by whitespace or at the start of a token).
function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\t')) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function coerceScalar(raw: string): string | number | boolean {
  const value = raw.trim();
  if (value.length === 0) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

// Anchors/aliases/tags are recognized only on unquoted values; a quoted string may legitimately
// contain `&`/`*`/`!!` (e.g. `"a & b"`).
function assertNoUnsupportedScalar(value: string): void {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('"') || trimmed.startsWith("'")) return;
  if (trimmed.startsWith('&') || trimmed.startsWith('*') || trimmed.includes('!!')) {
    // WR-02: name the CONSTRUCT, never echo the scalar. See the header note on error messages.
    throw new Error('YAML parse error: unsupported anchor/alias/tag construct in a scalar value');
  }
}

function parseFlowArray(rawValue: string): unknown[] {
  if (!rawValue.endsWith(']')) {
    throw new Error('YAML parse error: unbalanced flow-style array');
  }
  const inner = rawValue.slice(1, -1).trim();
  if (inner === '') return [];
  const items: string[] = [];
  let depth = 0;
  let current = '';
  // CR-03 (34-REVIEW): the splitter MUST track quote state, mirroring findKeyValueColon /
  // stripInlineComment. Without it, `["Prefer const, not let", "No any"]` split on the comma
  // INSIDE the quoted element and produced ['"Prefer const', 'not let"', 'No any'] — two garbage
  // custom_rules with dangling quotes, each a valid Zod string, so no throw and no audit event.
  // Brackets and commas are structural only outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;

    const quoted = inSingle || inDouble;
    if (!quoted) {
      if (ch === '[') depth += 1;
      else if (ch === ']') depth -= 1;
    }
    if (ch === ',' && depth === 0 && !quoted) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
    if (depth < 0) throw new Error('YAML parse error: unbalanced flow-style array');
  }
  if (depth !== 0) throw new Error('YAML parse error: unbalanced flow-style array');
  if (inSingle || inDouble) throw new Error('YAML parse error: unterminated quoted string in flow-style array');
  items.push(current);
  // Trailing comma leaves one empty element; drop it.
  if (items[items.length - 1].trim() === '') items.pop();
  return items.map((item) => {
    const trimmed = item.trim();
    if (trimmed.startsWith('{')) {
      throw new Error('YAML parse error: flow-style maps are not supported');
    }
    assertNoUnsupportedScalar(trimmed);
    return coerceScalar(trimmed);
  });
}

function assignScalarValue(obj: Record<string, unknown>, key: string, rawValue: string): void {
  if (rawValue.startsWith('{')) {
    throw new Error('YAML parse error: flow-style maps are not supported');
  }
  if (/^[|>][-+]?$/.test(rawValue)) {
    throw new Error('YAML parse error: multi-line block scalars are not supported');
  }
  if (rawValue.startsWith('[')) {
    obj[key] = parseFlowArray(rawValue);
    return;
  }
  assertNoUnsupportedScalar(rawValue);
  obj[key] = coerceScalar(rawValue);
}

function assertValidKey(key: string): void {
  if (key === '') {
    throw new Error('YAML parse error: empty key');
  }
  if (key.includes('"') || key.includes("'")) {
    throw new Error('YAML parse error: complex (quoted) keys are not supported');
  }
  if (key.includes(' ')) {
    throw new Error('YAML parse error: complex keys with spaces are not supported');
  }
}

export function parseYaml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Context[] = [{ kind: 'object', indent: -1, obj: root }];

  // Pre-scan into significant lines, stripping comment-only lines and trailing whitespace while
  // preserving leading indentation for depth tracking. `line` is the 1-based ORIGINAL source line
  // number (blank/comment lines are dropped from `lines` but still counted), so WR-02 error
  // messages can point the operator at their file without echoing its content.
  // WR-06 (34-REVIEW): strip a leading UTF-8 BOM. `String.prototype.trim` treats U+FEFF as
  // whitespace, so a BOM-saved file reported `indent === 1` on its first line and died with a
  // misleading "inconsistent indentation" — an editor default silently discarding the whole config.
  const sourceLines = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split(/\r?\n/);
  const lines: Array<{ indent: number; text: string; line: number }> = [];
  for (let sourceIndex = 0; sourceIndex < sourceLines.length; sourceIndex += 1) {
    const trimmedRight = sourceLines[sourceIndex].trimEnd();
    const trimmed = trimmedRight.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    lines.push({
      indent: trimmedRight.length - trimmedRight.trimStart().length,
      text: trimmed,
      line: sourceIndex + 1,
    });
  }

  const popTo = (indent: number): Context => {
    while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
    return stack[stack.length - 1];
  };

  // An array-of-objects entry continues on deeper lines; the context indent is the next line's
  // indent so a sibling `- ` item (which sits at the entry's own indent) pops it correctly.
  const pushEntryContext = (itemIndent: number, nextIndex: number, entry: Record<string, unknown>): void => {
    const next = lines[nextIndex];
    const entryIndent = next && next.indent > itemIndent ? next.indent : itemIndent + 2;
    stack.push({ kind: 'object', indent: entryIndent, obj: entry });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const { indent, text, line } = lines[i];
    const next = lines[i + 1];

    if (text.startsWith('-')) {
      const top = popTo(indent);
      if (top.kind !== 'array' || top.indent !== indent) {
        throw new Error(
          `YAML parse error: array item at indent ${indent} without a matching parent key at line ${line}`,
        );
      }
      // CR-02 (34-REVIEW): strip the inline comment ONCE, at the top of the `-` branch, so every
      // downstream path (empty item, array-of-objects, plain scalar) is covered consistently.
      // Previously only the `key: value` paths stripped comments, so `- "vendor/**"  # third-party`
      // became the literal glob `"vendor/**"   # third-party` — a valid Zod string, so no throw,
      // no DB fallback, no audit event: exactly the silent mis-parse the module contract forbids.
      const itemContent = stripInlineComment(text.slice(1).trim());
      if (itemContent === '') {
        const entry: Record<string, unknown> = {};
        top.arr.push(entry);
        if (next && next.indent > indent) pushEntryContext(indent, i + 1, entry);
        continue;
      }
      const colon = findKeyValueColon(itemContent);
      if (colon !== -1) {
        // First key-value pair on the item line starts an array-of-objects entry. The inline
        // comment was already stripped from `itemContent` above (CR-02).
        const key = itemContent.slice(0, colon).trim();
        const rawValue = itemContent.slice(colon + 1).trim();
        assertValidKey(key);
        const entry: Record<string, unknown> = {};
        assignScalarValue(entry, key, rawValue);
        top.arr.push(entry);
        if (next && next.indent > indent) pushEntryContext(indent, i + 1, entry);
        continue;
      }
      assertNoUnsupportedScalar(itemContent);
      top.arr.push(coerceScalar(itemContent));
      continue;
    }

    const colon = findKeyValueColon(text);
    if (colon === -1) {
      throw new Error(`YAML parse error: expected 'key: value' at line ${line}`);
    }
    const key = text.slice(0, colon).trim();
    assertValidKey(key);
    const rawValue = stripInlineComment(text.slice(colon + 1).trim());

    let top = popTo(indent);
    // WR-06: a SAME-INDENT block sequence keeps its array context AT the parent key's indent (see
    // the rawValue === '' branch below), and `popTo` only pops contexts that are strictly deeper.
    // A sibling key arriving at that same indent is what closes the sequence.
    if (top.kind === 'array' && top.indent === indent) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (top.kind !== 'object') {
      throw new Error('YAML parse error: key-value pair inside an array');
    }
    // The root context (stack[0], indent -1) legitimately receives keys at indent 0; any deeper
    // key landing on the root means the document dedented past its open blocks (inconsistent
    // indentation).
    if (top.indent < indent && !(stack.length === 1 && indent === 0)) {
      throw new Error(`YAML parse error: inconsistent indentation at line ${line}`);
    }

    if (rawValue === '') {
      // A key with no value starts a nested block iff the next line is more indented — OR, for a
      // block sequence only, sits at the SAME indent (WR-06):
      //
      //   review:
      //     skip_files:
      //     - "dist/**"        <- indent 2, same as its key; the style most YAML docs use
      //
      // The array context is opened AT the key's own indent so `- ` items at that indent match
      // `top.indent === indent` in the sequence branch above, and the sibling-key pop added there
      // is what closes it. Rejecting this form threw "array item at indent N without a matching
      // parent key" and discarded the operator's entire config file.
      const sameIndentSequence = Boolean(next && next.indent === indent && next.text.startsWith('-'));
      if (next && next.indent > indent) {
        if (next.text.startsWith('-')) {
          const arr: unknown[] = [];
          top.obj[key] = arr;
          stack.push({ kind: 'array', indent: next.indent, arr });
        } else {
          const child: Record<string, unknown> = {};
          top.obj[key] = child;
          stack.push({ kind: 'object', indent: next.indent, obj: child });
        }
      } else if (sameIndentSequence) {
        const arr: unknown[] = [];
        top.obj[key] = arr;
        stack.push({ kind: 'array', indent, arr });
      } else {
        top.obj[key] = '';
      }
      continue;
    }

    if (next && next.indent > indent) {
      throw new Error('YAML parse error: scalar value cannot start a nested block');
    }
    assignScalarValue(top.obj, key, rawValue);
  }

  return root;
}
