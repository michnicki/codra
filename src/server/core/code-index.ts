// Phase 29 / QA-IDX-01: the pure tokenization + windowing core of the codebase index.
//
// PURE MODULE: no I/O, no DB, no logging, no environment reads. Every export is deterministic, so the
// test layer pins it without Cloudflare bindings -- test/code-index-splitter.spec.ts,
// test/code-index-chunker.spec.ts and test/code-index-query.spec.ts.
//
// Its inputs are ATTACKER-INFLUENCED: repository file content (anyone who can land a commit) and the
// reviewer's free-form question (anyone who can comment on a PR). All matching below is therefore
// non-backtracking -- single-pass character scanning and literal character classes only, never a
// nested-quantifier pattern an input could make quadratic.
//
// This module MUST remain the SINGLE splitter shared by the index-write path
// (src/server/db/code-index.ts) and the query path (the Q&A retrieval caller). Two implementations
// would normalize differently, so query terms and stored lexemes would never meet -- and because
// retrieval fails open to diff-only Q&A (D-15) the resulting total retrieval miss would be COMPLETELY
// SILENT. Anyone adding a second normalizer is reintroducing that failure.

import { WINDOW_LINE_COUNT } from './verify-fixes';

// ---------------------------------------------------------------------------------------------
// Tuned constants
// ---------------------------------------------------------------------------------------------

// D-04 weight labels for the two halves of the stored vector. MEASURED FACTS behind these values, on
// PostgreSQL 17.10: ts_rank_cd's weight array is ordered {D, C, B, A} -- index 0 is D, index 3 is A --
// so the defaults {0.1, 0.2, 0.4, 1.0} mean D = 0.1, C = 0.2, B = 0.4, A = 1.0. Labeling path-derived
// tokens 'A' and content 'D' was measured to make a path-token hit outrank a body-only hit by 10x for
// the same query (2.0 vs 0.2) with NO post-processing at all.
//
// These labels are baked into every stored vector. Changing which half gets which label invalidates
// every row for every repository and requires a full re-index -- not a schema migration, a rebuild.
export const CODE_INDEX_PATH_WEIGHT = 'A' as const;
export const CODE_INDEX_CONTENT_WEIGHT = 'D' as const;

// Per-chunk UTF-8 byte cap enforced in JS BEFORE the insert.
//
// Why a cap exists at all: to_tsvector RAISES above roughly 1 MB of RESULTING vector, and the vector
// is LARGER than its input -- a 1 088 889-byte input produced a 1 477 980-byte vector against the
// 1 048 575-byte ceiling. Without this cap, one window of a generated or minified file hard-fails the
// whole index build step, and the Workflow then burns its entire retry budget re-throwing the same
// deterministic error. A real 50-line window of this repository's own source measured 2 854 bytes, so
// 32 KB is roughly 11x a normal window.
//
// Why the value is 32_768 and MUST NOT be lowered: cross-AI review proposed 16 KB and/or a
// pg_column_size guard (29-REVIEWS.md: OpenCode 29-01 HIGH, Antigravity C-01/S-01). Both were
// REJECTED on measurement. On the live PG 17.10 test database, a 32 KB chunk of maximally dense
// UNIQUE camelCase identifiers -- plus the pre-split tokens buildIndexTokens appends, for 71.8 KB of
// combined input -- produced a 134 KB tsvector: 12.8% of the 1 048 575-byte ceiling, i.e. roughly 8x
// headroom. At double this cap the vector still reached only 25.3%. Real minified JavaScript has
// LONGER tokens and therefore FEWER lexemes than that synthetic worst case, so this is close to an
// upper bound on vector size per byte of input. Do not "harden" away 8x of measured headroom, and do
// not add a pg_column_size guard for a ceiling that cannot be reached.
export const CODE_INDEX_MAX_CHUNK_BYTES = 32_768;

// Per-file UTF-8 byte cap. A file above this size is RECORDED AS SKIPPED (code_index_files.skip_reason
// = 'oversized') rather than chunked: past a megabyte the file is a bundle, a lockfile or a data
// fixture, and indexing it costs storage and GIN maintenance for lexemes no reviewer will ever ask
// about. Note the D-09 consequence -- generated detection is content-based, so the file has already
// been fetched by the time this cap applies; the cap bounds STORAGE, not subrequests.
export const CODE_INDEX_MAX_FILE_BYTES = 1_000_000;

// Upper bound on how many terms one question can contribute to the tsquery. A hostile or merely
// pasted-in question cannot make the query expression grow without limit; 32 distinct terms is far
// more than any real reviewer question produces after stopword removal and deduplication.
export const CODE_INDEX_MAX_QUERY_TERMS = 32;

// English stopwords dropped from QUERY terms only (never from the stored vector -- Postgres's own
// english dictionary already drops them there). D-03 calls for dropping stopwords; doing it in JS
// rather than leaning on Postgres is what lets buildQueryExpression return null for an all-stopword
// question, so the caller skips the statement entirely instead of issuing a query whose tsquery
// reduces to the empty expression (measured: `the OR of OR and` -> '' with numnode 0). Deliberately
// SHORT -- this is not a linguistics project, it is a list of words that carry no retrieval signal.
const QUERY_STOPWORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'but',
  'by', 'can', 'did', 'do', 'does', 'doing', 'done', 'for', 'from', 'had', 'has', 'have', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'out', 'over', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

// 29-09 UAT finding, code-vocabulary half of the same list: `buildQueryExpression` OR-joins every
// surviving term with EQUAL weight, and `ts_rank_cd` ranks purely on how a document's OWN lexemes
// match -- it has no notion of how common a lexeme is ACROSS the repository (no IDF-like signal). A
// reserved word like `function` or `return` appears in nearly every source-code chunk, so once it
// survives into the query it contributes a nonzero rank to nearly every row and can outrank the one
// chunk containing the question's actually-distinctive term. Confirmed live: three real Bitbucket
// Q&A questions about `formatters.ts` retrieved eight completely unrelated chunks, because "function"
// and "return" (both present in the question, neither filtered) dominated `ts_rank_cd` over the
// genuinely rare identifier (`truncate`). This list is deliberately confined to reserved words and
// literals -- `function`, `return`, `const`, etc. -- that are near-universal across common
// C-family/scripting languages and virtually never the term a reviewer is actually asking about;
// generic-but-plausibly-distinctive nouns like `get`/`id`/`name`/`data`/`type`/`value` are
// DELIBERATELY EXCLUDED (see the pinned `getUserById` split-identifier case in
// code-index-query.spec.ts, which asserts `get` and `id` survive as terms).
const CODE_VOCABULARY_STOPWORDS = new Set([
  'function', 'return', 'const', 'let', 'var', 'class', 'new', 'export', 'import', 'default',
  'async', 'await', 'static', 'public', 'private', 'protected', 'void', 'null', 'undefined',
  'true', 'false',
]);

// A window of a file: 1-based INCLUSIVE line bounds, mirroring the mergedStart / mergedEnd convention
// of core/verify-fixes.ts so the whole codebase speaks one line-range dialect.
export type CodeIndexWindow = {
  start: number;
  end: number;
  content: string;
};

// ---------------------------------------------------------------------------------------------
// Identifier splitting (D-02) -- module-private, ONE implementation
// ---------------------------------------------------------------------------------------------

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Split one token into its lowercase [a-z0-9]+ component words at camelCase, snake_case,
 * kebab-case, dot, slash and letter/digit boundaries. `getUserById` -> [get, user, by, id];
 * `snake_case_name` -> [snake, case, name]; `HTTPServer` -> [http, server]; `sha256` -> [sha, 256].
 *
 * Implemented as a SINGLE-PASS character scan rather than a regex on purpose: the acronym boundary
 * (`HTTPServer`) needs "uppercase run followed by uppercase + lowercase", and the natural regex for
 * that -- /([A-Z]+)([A-Z][a-z])/ -- backtracks quadratically over a long uppercase run, which is
 * exactly the shape a hostile committed file can supply. This loop is O(n) with no backtracking.
 *
 * Any character that is not ASCII alphanumeric (including every non-ASCII character) acts as a
 * separator, so non-ASCII input can never throw -- it simply contributes no terms.
 */
function splitIdentifier(token: string): string[] {
  const words: string[] = [];
  let current = '';
  let prev = '';

  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i]!;

    if (!isUpper(ch) && !isLower(ch) && !isDigit(ch)) {
      if (current.length > 0) {
        words.push(current.toLowerCase());
        current = '';
      }
      prev = '';
      continue;
    }

    if (current.length > 0) {
      const next = i + 1 < token.length ? token[i + 1]! : '';
      const boundary =
        // getUser / v2Beta: lowercase or digit followed by an uppercase letter.
        ((isLower(prev) || isDigit(prev)) && isUpper(ch)) ||
        // HTTPServer: inside an uppercase run, break before the Upper that starts a lowercase word.
        (isUpper(prev) && isUpper(ch) && isLower(next)) ||
        // sha256 / 018code: digits are their own terms in both directions.
        ((isLower(prev) || isUpper(prev)) && isDigit(ch)) ||
        (isDigit(prev) && (isLower(ch) || isUpper(ch)));

      if (boundary) {
        words.push(current.toLowerCase());
        current = '';
      }
    }

    current += ch;
    prev = ch;
  }

  if (current.length > 0) {
    words.push(current.toLowerCase());
  }

  return words;
}

/** Push every not-yet-seen word into `out`, preserving first-seen order. */
function pushUnique(out: string[], seen: Set<string>, words: string[]): void {
  for (const word of words) {
    if (word.length === 0 || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
}

// ---------------------------------------------------------------------------------------------
// Index-write direction (D-02 / D-04)
// ---------------------------------------------------------------------------------------------

/**
 * Build the two token strings the stored vector is composed from:
 *
 *  - `pathTokens` is the RAW path followed by its split component words. Both halves are needed:
 *    to_tsvector('english', 'src/server/core/code-index.ts') was MEASURED to produce exactly ONE
 *    unsearchable lexeme ('src/server/core/code-index.ts'), so a question about "code index" never
 *    matches it -- while the pre-split form yields the individual words. Keeping the raw path too
 *    preserves exact-path queries. (Postgres's path tokenization is also unpredictable: `a_b/c-d/e.f`
 *    silently DROPS the leading `a_`, so the split must happen here in JS, not in Postgres.)
 *    This string is labeled CODE_INDEX_PATH_WEIGHT ('A') by the writer.
 *
 *  - `contentTokens` is the content followed by the split component words of the identifiers found in
 *    it, so `getUserById` is reachable from a question about user lookup (D-02). Labeled
 *    CODE_INDEX_CONTENT_WEIGHT ('D').
 *
 * The appended words are DEDUPLICATED: a lexeme's presence is what `@@` tests, so repeating a word
 * once per occurrence would inflate the input (and the vector) for no retrieval gain.
 */
export function buildIndexTokens(
  path: string,
  content: string,
): { pathTokens: string; contentTokens: string } {
  const pathWords: string[] = [];
  pushUnique(pathWords, new Set<string>(), splitIdentifier(path));
  const pathTokens = pathWords.length > 0 ? `${path} ${pathWords.join(' ')}` : path;

  // Bounded literal character class, single pass: identifier-ish runs only.
  const rawTokens = content.match(/[A-Za-z0-9_$.-]+/g) ?? [];
  const contentWords: string[] = [];
  const seen = new Set<string>();
  for (const token of rawTokens) {
    const words = splitIdentifier(token);
    // A token that splits to exactly itself already appears verbatim in `content`; appending it
    // again would be pure duplication.
    if (words.length === 1 && words[0] === token.toLowerCase()) continue;
    pushUnique(contentWords, seen, words);
  }
  const contentTokens = contentWords.length > 0 ? `${content} ${contentWords.join(' ')}` : content;

  return { pathTokens, contentTokens };
}

// ---------------------------------------------------------------------------------------------
// Query direction (D-03)
// ---------------------------------------------------------------------------------------------

/**
 * Normalize a reviewer's free-form question into the query terms, using the SAME splitter the write
 * path uses (D-02/D-03, Pitfall 8). Deduplicated, order-preserving, truncated to
 * CODE_INDEX_MAX_QUERY_TERMS. Every surviving term matches /^[a-z0-9]+$/, is not the reserved word
 * `or`, and is not a stopword.
 *
 * That single restriction simultaneously neutralizes all four MEASURED websearch_to_tsquery
 * mini-syntax hazards, each of which silently changes the query's meaning rather than erroring:
 *   - a double quote turns the rest into a PHRASE search (`user OR "quoted phrase"` -> 'quot' <-> 'phrase')
 *   - a leading hyphen turns a term into a NEGATION (`user OR -negated` -> 'user' | !'negat')
 *   - an empty term leaves a dangling joiner that silently drops its LEFT operand (`a OR b OR` -> 'b')
 *   - a literal `or` is consumed as the operator rather than searched for
 *
 * Never throws: the only pattern used is a literal character-class test.
 */
export function buildQueryTerms(question: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const raw of question.split(/\s+/)) {
    if (raw.length === 0) continue;
    // The token itself (an identifier a reviewer pasted in, e.g. getUserById -> getuserbyid) plus its
    // component words. Anything that does not normalize to [a-z0-9]+ is dropped, not repaired.
    const candidates = [raw.toLowerCase(), ...splitIdentifier(raw)];
    for (const candidate of candidates) {
      if (terms.length >= CODE_INDEX_MAX_QUERY_TERMS) return terms;
      if (!/^[a-z0-9]+$/.test(candidate)) continue;
      if (candidate === 'or' || QUERY_STOPWORDS.has(candidate) || CODE_VOCABULARY_STOPWORDS.has(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      terms.push(candidate);
    }
  }

  return terms;
}

/**
 * Join normalized terms into the single expression bound as ONE parameter to websearch_to_tsquery.
 * Returns null when there are no usable terms.
 *
 * null means the caller MUST skip the query entirely rather than issue one that cannot match: an
 * empty tsquery is safe (`@@` returns false, so it matches nothing rather than everything) but
 * pointless, and skipping Postgres is cheaper. retrieveCodeIndexChunks enforces this itself too --
 * see the defense-in-depth note there.
 */
export function buildQueryExpression(terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  return terms.join(' OR ');
}

// ---------------------------------------------------------------------------------------------
// Windowing (D-10)
// ---------------------------------------------------------------------------------------------

/**
 * Truncate text to at most `maxBytes` UTF-8 bytes, never splitting a multi-byte sequence (the cut is
 * backed off over any trailing continuation bytes, so the result is always valid UTF-8 and always
 * within the bound).
 */
function capUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;

  let end = maxBytes;
  // UTF-8 continuation bytes are 0b10xxxxxx. If the byte at the cut is one, the sequence straddles
  // the boundary, so walk back until the cut falls on a lead/ASCII byte.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Split content into fixed `chunkLineCount`-line windows with 1-based INCLUSIVE bounds (D-10).
 * Empty content yields an empty array. Each window's content is capped to
 * CODE_INDEX_MAX_CHUNK_BYTES UTF-8 bytes while `start`/`end` stay the REAL line numbers, so a
 * retrieved hit always cites a line range that exists in the file.
 *
 * WINDOW_LINE_COUNT is imported from core/verify-fixes.ts so the 50-line vocabulary is single-sourced.
 * windowFileContent from that module is deliberately NOT called: it returns null for any file at or
 * under FULL_CONTENT_LINE_CAP (500 lines), which is exactly the population D-10 needs windowed --
 * reusing it would store one giant row per small file, the shape D-10 rejects. The loop body is six
 * lines and worth duplicating; the CONSTANTS are what must not be duplicated.
 */
export function chunkLines(content: string, chunkLineCount: number = WINDOW_LINE_COUNT): CodeIndexWindow[] {
  if (content.length === 0) return [];

  const lines = content.split('\n');
  const size = Math.max(1, Math.floor(chunkLineCount));
  const windows: CodeIndexWindow[] = [];

  for (let start = 0; start < lines.length; start += size) {
    const end = Math.min(start + size, lines.length);
    windows.push({
      start: start + 1,
      end,
      content: capUtf8Bytes(lines.slice(start, end).join('\n'), CODE_INDEX_MAX_CHUNK_BYTES),
    });
  }

  return windows;
}
