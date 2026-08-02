// PRD-06 (FR-131/FR-132): the bounded agentic-context executor and the six hard limits it enforces.
//
// This module is PURE. It touches no `env`, no `fetch`, no `logger`, no DB and no Cloudflare binding;
// every export is deterministic, and all I/O arrives as injected callbacks (`AgenticLoopDeps`). That
// purity is the whole point: it is what lets all six FR-132 bounds — including the two that are only
// observable at their exact boundary — be pinned in milliseconds by `test/agentic-tools.spec.ts` with
// no bindings, no database and no fetch mock. The same discipline `core/phase-routing.ts:1-4` and
// `core/code-index.ts:3` state for themselves.
//
// The ONE runtime dependency worth naming is `@server/prompts/agentic-context`, which owns the D-08
// fencing. `core/model-output`'s `parseAgenticToolCall` is reached through a LAZY import inside the
// loop instead of a static one, because `model-output` imports `agenticActionSchema` from this file:
// the lazy import keeps the module graph acyclic (same lazy-import precedent as `review.ts:3618`) and
// keeps this module's static graph free of the logger/DB/severity graph `model-output` pulls in.

import { z } from 'zod';
import picomatch from 'picomatch';
import {
  renderAgenticToolResult,
  renderGrepResult,
  renderReadFileResult,
} from '@server/prompts/agentic-context';
import type { VcsCodeSearchHit } from '@server/vcs/types';

// `renderToolCatalog` is a RENDERING concern, so it lives in the prompt module beside the fencing —
// but it is re-exported here so the executor's public surface (definitions + their renderer) is one
// import for callers and tests. A re-export adds no new module edge: this file already imports that
// module at runtime, and that module imports nothing from this one except erased `import type`s.
export { renderToolCatalog } from '@server/prompts/agentic-context';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// UTF-8 byte accounting
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// FR-132 specifies BYTES. JavaScript's `String.length` is UTF-16 code units, which coincides with
// bytes only for ASCII — so on a CJK or emoji source file a code-unit cap silently lets through up to
// 4x the requirement. This is a DELIBERATE deviation from the Phase 34 analog `buildFileHistoryBlock`
// (prompts/file-review.ts:247), which counts code units: that approximation is invisible on ASCII
// commit subjects and must not be inherited by a cap that governs whole source files.
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function utf8ByteLength(text: string): number {
  return TEXT_ENCODER.encode(text).length;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a code point.
 *
 * A naive byte slice at the cap can land in the middle of a multi-byte sequence, and decoding that
 * yields U+FFFD (the replacement character) — a corrupted last character the model then reasons
 * about. The backtrack below walks off any UTF-8 continuation byte (`0b10xxxxxx`) so the cut always
 * falls on a sequence boundary. Surrogate pairs are handled for free: they are one code point and
 * therefore one UTF-8 sequence.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  const bytes = TEXT_ENCODER.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: TEXT_DECODER.decode(bytes.subarray(0, end)), truncated: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The six FR-132 limits, plus the two guards that keep them affordable
//
// All six are DECIMAL values taken from FR-132 itself, not 12 * 1024 / 50 * 1024 — the ROADMAP's
// "12KB / 50KB" shorthand is looser than the requirement.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// FR-132: hard cap on how many model calls one agentic-context pass may make.
//
// 6 is the requirement's figure and it is the bound that holds even when per-hop subrequest cost is
// mis-estimated — the independent second bound alongside AGENTIC_BUDGET_RESERVE (the WR-04
// two-independent-bounds reasoning at review.ts:230-239). A corrective message for an unparseable
// turn CONSUMES a hop (D-03) and a repeat-file no-op CONSUMES a hop, so 6 is a cap on model calls,
// not on useful reads.
//
// Not larger: each hop is one model call plus up to one provider fetch against a 25-subrequest
// fresh-invocation safe budget (token-tracker.ts), and the phase is ADVISORY — it must never risk the
// review that does the actual work. Not smaller: below ~4 the model cannot follow a reference chain
// (read a file, find its import, read that), which is the entire point of FR-131.
export const AGENTIC_MAX_HOPS = 6;

// FR-132: hard cap on the bytes ONE read_file returns.
//
// Sized so a single large file cannot consume a quarter of the 50,000-byte total accumulator on hop 1
// and starve every later hop. Truncation is SIGNALLED, never silent (see renderReadFileResult): a
// silently truncated read makes the model re-issue the identical read_file and burn the remaining
// hops on a file it already has — the observed degradation this constant plus its note prevent.
//
// Not larger: 12,000 bytes is already ~300 lines of typical source, more than enough to judge a
// module's shape, and four such reads plus fencing overhead is the whole context budget.
export const AGENTIC_READ_FILE_MAX_BYTES = 12_000;

// FR-132: hard cap on how many grep_repo matches reach the prompt.
//
// The clamp is applied in the executor even though the adapter is also asked for at most this many:
// a provider that ignores its `per_page` / `pagelen` argument would otherwise put an unbounded hit
// list into the prompt. Two enforcement points, one owner for the bound.
//
// Not larger: 30 literal-keyword matches is already past the point where the list is signal — beyond
// it the honest answer is "narrow the query", which is exactly the note the renderer emits.
export const AGENTIC_MAX_GREP_HITS = 30;

// FR-132: hard cap on the bytes of ONE grep hit's fragment.
//
// Applied in the executor, never in the adapter — `VcsCodeSearchHit.fragment` is documented as
// untruncated precisely so this bound lives in one testable place. Applied BEFORE the 50,000-byte
// total (per-item cap then total cap, matching prompts/file-review.ts:160-173) so one abusive
// minified line cannot own the whole context budget while the aggregate is still under it.
//
// Not larger: 240 bytes is ~2-3 source lines, enough to see whether a match is relevant; the model
// reads the file at head when it needs more.
export const AGENTIC_GREP_HIT_MAX_BYTES = 240;

// FR-132: hard cap on the TOTAL gathered context, and per D-04 the SOLE context bound — there is no
// eviction, no summarization and no compaction. When the cap is hit the fitting prefix is appended,
// the transcript is marked truncated, and the LOOP ENDS.
//
// Counted over the RENDERED block (fence + framing + note + body), not the body alone: the rendered
// transcript is what approaches the model's context window, and counting bodies only understates the
// real prompt by the fencing overhead times the hop count.
//
// Not larger: 50,000 bytes of gathered context sits on top of a full per-file review prompt on every
// file of the pull request, and the smallest configurable models this must work on have ~8k-token
// windows. Not smaller: below ~30,000 two 12,000-byte reads plus a grep no longer fit.
export const AGENTIC_TOTAL_OUTPUT_BYTES = 50_000;

// FR-132: hard cap on how many DISTINCT files one pass may read.
//
// Tracked as a Set of normalized paths, so a repeat read of an already-read path is a no-op that
// still consumes a hop and neither re-fetches nor re-charges the cap. Under a 6-hop bound this cap
// cannot bind today; it exists because the hop cap is the thing most likely to be raised later, and a
// raised hop cap without this bound is an unbounded repository crawl into a third-party LLM prompt.
//
// Not larger: 15 files is already 2.5x the hop cap. Not smaller: it must never bind before the hop
// cap does, or the two bounds become one.
export const AGENTIC_MAX_FILES = 15;

// D-11 / WR-04: how much safe subrequest budget must remain for the loop to attempt another hop.
//
// Derivation, written out rather than asserted:
//   worst-case ONE hop = 4 subrequests — a callVerifierRaw fallback chain of up to 3 provider
//   attempts, plus 1 VCS fetch (the provider clients self-increment the tracker; the loop never calls
//   incrementSubrequests itself).
//   phase tail = 3 subrequests — the KV put, the audit append, and the queue send.
//   4 + 3 = 7, rounded UP to 8 so this matches the sibling FILE_HISTORY_BUDGET_RESERVE at
//   review.ts:240 rather than introducing a second, differently-derived number.
//
// Raised from 4 to 8 at replan (35-REVIEWS.md, OpenCode Concern #4: 4 was "may be under-sized" on a
// loop more expensive than the one the sibling constant guards). The raise is FREE in the healthy
// case: the check runs BEFORE each hop against remainingSafeBudget(), which starts at 25 on the fresh
// instance this phase always gets (D-09), less a ~4-subrequest preamble (getPullRequest +
// getJobDiffFiles); at the normal 2-per-hop cost the check before hop 6 sees 21 - 10 = 11 >= 8 and
// all six hops still run. It binds — stopping the loop around hop 4 — only when every hop really does
// cost the worst-case 4, which is exactly when the phase tail needs protecting.
export const AGENTIC_BUDGET_RESERVE = 8;

// FR-131 / T-35-07: hard cap on the characters of a model-supplied grep_repo query.
//
// Arithmetic, not an assertion: GitHub rejects a `q` longer than 256 characters with 422. The adapter
// appends ` repo:{owner}/{repo}`, which costs 6 characters (space + "repo:" + "/") plus the owner plus
// the repository name. 256 - 120 - 6 = 130 characters of combined owner+repo headroom, which covers
// every realistic repository. The pathological case — GitHub's own maxima, a 39-character owner with a
// 100-character repo name — is absorbed by the adapter's 422 branch, which returns `[]` with a note
// rather than killing grep_repo for the rest of the run, so an over-long qualifier degrades one query
// instead of the capability.
//
// Do NOT "just raise it a bit" without redoing that subtraction: the failure it produces is a 422 on
// every search for repositories with long names, which looks like a broken capability.
export const AGENTIC_MAX_QUERY_CHARS = 120;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tool definitions (D-02)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One OpenAI-compatible function definition. Authored as an OBJECT, never as prose, so the same
 * constant is a drop-in `tools` array the day a native function-calling path lands — the text
 * protocol (D-01) renders it into the system prompt in the meantime.
 */
export type AgenticToolDefinition = {
  readonly type: 'function';
  readonly function: {
    readonly name: 'read_file' | 'grep_repo';
    readonly description: string;
    readonly parameters: {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
    };
  };
};

export const AGENTIC_TOOL_DEFINITIONS: readonly AgenticToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        `Read one file at the pull request head commit. Returns at most ${AGENTIC_READ_FILE_MAX_BYTES} bytes; ` +
        'a longer file is truncated and marked as truncated. Files the repository excludes from review ' +
        '(lockfiles, build output, generated files) are refused.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Repository-root-relative path, e.g. "src/server/core/review.ts". No leading slash, no ".." segments.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_repo',
      description:
        'Search the repository for LITERAL keywords (not a regular expression). Results come from the ' +
        'repository DEFAULT BRANCH and may differ from the pull request head. Returns at most ' +
        `${AGENTIC_MAX_GREP_HITS} matches, each fragment truncated to ${AGENTIC_GREP_HIT_MAX_BYTES} bytes.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: `Literal keywords to search for, at most ${AGENTIC_MAX_QUERY_CHARS} characters.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The action protocol (D-01 / T-35-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Strip a leading `./` (repeatedly) and surrounding whitespace so one canonical, repo-root-relative
 * form reaches BOTH the `skip_files` glob test and the provider fetch.
 *
 * THIS IS A SECURITY MITIGATION, NOT TIDY-UP (T-35-03). `picomatch` matches `dist/app.js` against
 * `dist/**` and `a.lock` against `**\/*.lock`, but it matches NEITHER `./dist/app.js` NOR `./a.lock`
 * (reproduced in 35-REVIEWS.md). Without this normalization a `./`-prefixed path slips straight past
 * `isSkippedByRepoRules` and spends a real subrequest reading a lockfile or build output the
 * repository excluded from review — exactly what PRD-06's privacy prohibition forbids.
 *
 * There is exactly ONE normalization site — here, inside the schema's transform — so the value that
 * is glob-tested and the value that is fetched can never disagree.
 */
export function normalizeToolPath(raw: string): string {
  let path = raw.trim();
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

// Path validation runs BEFORE any subrequest is spent, because the adapter already pins owner/repo,
// so the real cost of a hostile path is a wasted hop rather than cross-repository access.
const agenticToolPathSchema = z
  .string()
  .min(1)
  .max(400)
  .transform(normalizeToolPath)
  .refine((path) => path.length > 0, { message: 'empty path' })
  // CR-01 (35-REVIEW.md), belt and braces to the renderer's own `sanitizeUntrusted(note)`. A path is
  // interpolated verbatim into three executor-authored `note:` lines, and a newline in it forges a
  // line boundary inside the fence header — the lead-in to the sentinel forgery the renderer now
  // blocks. REJECTED rather than folded, unlike the sibling `query` field two blocks down: a query is
  // free text where folding a control run to a space still leaves a usable search, whereas a path
  // with a control character in it is never a real path. Rejecting also keeps this identical to every
  // other invalid-path outcome here (leading `/`, `..`, backslash, URL scheme) — `schema_rejected`
  // from `parseAgenticToolCall`, which costs the model D-03's one corrective hop instead of silently
  // rewriting what it asked for.
  .refine((path) => !/[\u0000-\u001f\u007f]/.test(path), { message: 'control characters are not allowed' })
  .refine((path) => !path.startsWith('/'), { message: 'absolute paths are not allowed' })
  .refine((path) => !path.split('/').includes('..'), { message: 'parent-directory segments are not allowed' })
  .refine((path) => !path.includes('\\'), { message: 'backslashes are not allowed' })
  .refine((path) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(path), { message: 'URLs are not allowed' });

export const agenticActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read_file'),
    path: agenticToolPathSchema,
  }),
  z.object({
    action: z.literal('grep_repo'),
    // Capped before the provider sees it (see AGENTIC_MAX_QUERY_CHARS for the arithmetic). Newlines
    // and control characters are folded to spaces here rather than in the caller so there is one
    // owner for the wire shape.
    query: z
      .string()
      .min(1)
      .max(AGENTIC_MAX_QUERY_CHARS)
      .transform((raw) => raw.replace(/[\s\u0000-\u001f]+/g, ' ').trim())
      .refine((query) => query.length > 0, { message: 'empty query' }),
  }),
  z.object({
    action: z.literal('done'),
    reason: z.string().max(200).optional(),
  }),
]);

export type AgenticAction = z.infer<typeof agenticActionSchema>;

/**
 * The two actions that actually CALL a tool. `done` is not one of them: the parser maps a terminating
 * action to its own `{ kind: 'done' }` result, so the tool-dispatch branch of the loop can never see
 * it. Narrowing it away here is what lets that branch read `action.query` without a cast.
 */
export type AgenticToolAction = Exclude<AgenticAction, { action: 'done' }>;

/**
 * G-11 (ADOPTED at plan time): refuse to read a path the repository's own `review.skip_files` globs
 * exclude. Costs nothing at runtime, saves a subrequest, and closes the one plausible path by which
 * this loop reads a committed secret, a lockfile or build output into a third-party model prompt.
 *
 * Pure `picomatch` over the config the review pipeline already uses (`{ dot: true }`, matching
 * `core/diff.ts:33`). An invalid glob is skipped rather than thrown, following the C8 discipline in
 * `core/learned-rules.ts:138-144`: one bad pattern in a repository's config must not break the pass.
 */
export function isSkippedByRepoRules(path: string, skipFiles: readonly string[]): boolean {
  for (const pattern of skipFiles) {
    try {
      if (picomatch(pattern, { dot: true })(path)) return true;
    } catch {
      // An unparseable user-supplied glob is ignored, not fatal.
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The accumulator (D-04)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type AgenticAccumulator = {
  blocks: string[];
  totalBytes: number;
  filesRead: Set<string>;
  hopsUsed: number;
  grepsRun: number;
  truncated: boolean;
};

export function createAgenticAccumulator(): AgenticAccumulator {
  return { blocks: [], totalBytes: 0, filesRead: new Set<string>(), hopsUsed: 0, grepsRun: 0, truncated: false };
}

// The separator `blocks.join(...)` will insert between blocks, counted in the byte budget for the
// same reason WR-08 counts the join newline in buildFileHistoryBlock: an uncounted separator lets the
// rendered transcript drift over the cap by (blocks - 1) x separator length.
const AGENTIC_BLOCK_SEPARATOR = '\n\n';
const AGENTIC_BLOCK_SEPARATOR_BYTES = utf8ByteLength(AGENTIC_BLOCK_SEPARATOR);

/**
 * Append one RENDERED block to the accumulator under the 50,000-byte total bound.
 *
 * On overflow: append only the prefix that fits (code-point safe), set `truncated`, and return
 * `stop: true` so the caller ENDS THE LOOP. No eviction and no summarization — D-04 makes the total
 * byte cap the sole context bound, so an earlier block is never dropped to make room for a later one.
 */
export function appendBlock(acc: AgenticAccumulator, block: string): { acc: AgenticAccumulator; stop: boolean } {
  const separatorCost = acc.blocks.length === 0 ? 0 : AGENTIC_BLOCK_SEPARATOR_BYTES;
  const blockBytes = utf8ByteLength(block);

  if (acc.totalBytes + separatorCost + blockBytes <= AGENTIC_TOTAL_OUTPUT_BYTES) {
    acc.blocks.push(block);
    acc.totalBytes += separatorCost + blockBytes;
    return { acc, stop: false };
  }

  const remaining = AGENTIC_TOTAL_OUTPUT_BYTES - acc.totalBytes - separatorCost;
  if (remaining > 0) {
    const fitting = truncateToUtf8Bytes(block, remaining);
    if (fitting.text.length > 0) {
      acc.blocks.push(fitting.text);
      acc.totalBytes += separatorCost + utf8ByteLength(fitting.text);
    }
  }
  acc.truncated = true;
  return { acc, stop: true };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// read_file decision (one owner for the three refusal reasons)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ReadFileDecision = {
  /**
   * `skipped_by_repo_rules` — the repository's skip_files exclude it (privacy prohibition).
   * `already_read`          — a repeat read: a no-op that still consumes a hop, never re-fetched.
   * `file_cap`              — a NEW path past AGENTIC_MAX_FILES.
   * `fetch`                 — spend a subrequest.
   */
  decision: 'skipped_by_repo_rules' | 'already_read' | 'file_cap' | 'fetch';
  path: string;
};

/**
 * Decide what a `read_file` action costs, before any I/O. Extracted from the loop so the 15-vs-16
 * distinct-file boundary is pinnable directly: AGENTIC_MAX_HOPS (6) makes that boundary unreachable
 * through `executeAgenticLoop` itself.
 *
 * Order matters. The skip_files refusal is FIRST so an excluded path is refused whether or not the
 * file cap has room; `already_read` precedes `file_cap` so a model at the cap can still be reminded
 * it has a file rather than being told the cap was hit for a file it already has.
 */
export function resolveReadFileDecision(
  acc: AgenticAccumulator,
  path: string,
  skipFiles: readonly string[],
): ReadFileDecision {
  if (isSkippedByRepoRules(path, skipFiles)) return { decision: 'skipped_by_repo_rules', path };
  if (acc.filesRead.has(path)) return { decision: 'already_read', path };
  if (acc.filesRead.size >= AGENTIC_MAX_FILES) return { decision: 'file_cap', path };
  return { decision: 'fetch', path };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The shape `prompts/agentic-context.ts` renders. Internal contract, deliberately a plain type. */
export type AgenticToolResult = {
  tool: 'read_file' | 'grep_repo';
  ref: string;
  note?: string;
  body: string;
};

export type AgenticLoopDeps = {
  /** One hop's model turn. Wired to ModelService.callVerifierRaw by the phase driver. */
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** read_file at the PR HEAD SHA (D-06). Resolves to null ONLY on 404 (vcs/types.ts:219-226). */
  readFile: (path: string) => Promise<string | null>;
  /** grep_repo. THREE-VALUED (D-05): null = capability unavailable, [] = ran with zero matches. */
  searchCode: (query: string) => Promise<VcsCodeSearchHit[] | null>;
  /** Subrequest guard. Wired to tracker.hasRemainingSafeBudget (the review.ts:1436 idiom). */
  hasBudget: (reserve: number) => boolean;
};

export type AgenticLoopInput = {
  prTitle: string | null;
  touchedPaths: string[];
  headSha: string;
  /** The repository's own `review.skip_files` globs — the privacy refusal list (G-11). */
  skipFiles: readonly string[];
  /** D-07 disclosure label for grep hits. Never the head SHA. */
  defaultBranchLabel?: string;
};

// Machine tokens only — this union is persisted to KV and (from 35-06) to the audit trail, where the
// counts-not-content rule forbids provider text and file content.
export const agenticStopReasons = [
  'done',
  'hop_cap_reached',
  'byte_cap_reached',
  'file_cap_reached',
  'budget_exhausted',
  'unparseable_action',
  'model_call_failed',
] as const;

/**
 * The persisted `agentic-context:<jobId>` KV blob (D-12). Declared as a Zod schema so the consumer
 * side can `safeParse` a blob written by an earlier deploy instead of casting it — the WR-09 lesson:
 * a cast KV round-trip surfaced as a TypeError inside a prompt builder, a validated one is dropped
 * fail-open.
 */
export const agenticContextBlobSchema = z.object({
  context: z.string(),
  hopsUsed: z.number().int().nonnegative(),
  filesRead: z.number().int().nonnegative(),
  grepsRun: z.number().int().nonnegative(),
  bytesGathered: z.number().int().nonnegative(),
  truncated: z.boolean(),
  grepSupported: z.boolean(),
  stopReason: z.enum(agenticStopReasons),
});

export type AgenticContextBlob = z.infer<typeof agenticContextBlobSchema>;
/** The loop's return value IS the persisted blob — one shape, one schema (C-6). */
export type AgenticLoopOutcome = AgenticContextBlob;

// D-03: the ONE corrective message, authored by Codra and fed exactly once. The leading phrase is
// asserted by the spec, so keep it stable.
export const AGENTIC_CORRECTION_MESSAGE =
  'Your last reply was not a single valid JSON action object. Reply with exactly one raw JSON ' +
  'object and nothing else: {"action":"read_file","path":"..."} or {"action":"grep_repo","query":"..."} ' +
  'or {"action":"done","reason":"..."}. No markdown code fence, no prose before or after it.';

const DEFAULT_BRANCH_LABEL = 'repository default branch';

/**
 * FR-131: drive the bounded tool loop.
 *
 * Every bound is enforced here or in `appendBlock`/`resolveReadFileDecision`, and every truncation
 * and refusal is reported back to the model INSIDE the fenced block with Codra-authored framing, so
 * the model never has to guess whether it got a whole file.
 */
export async function executeAgenticLoop(
  deps: AgenticLoopDeps,
  input: AgenticLoopInput,
): Promise<AgenticLoopOutcome> {
  // Lazy, once: breaks the model-output <-> agentic-tools module cycle (see the file header).
  const { parseAgenticToolCall } = await import('./model-output');
  const { buildAgenticHopUserPrompt, buildAgenticSystemPrompt } = await import('@server/prompts/agentic-context');

  const acc = createAgenticAccumulator();
  const defaultBranchLabel = input.defaultBranchLabel ?? DEFAULT_BRANCH_LABEL;
  let grepSupported = true;
  let correctionsUsed = 0; // D-03: exactly one corrective message, ever.
  let pendingCorrection: string | null = null;
  let stopReason: AgenticLoopOutcome['stopReason'] = 'hop_cap_reached';

  // Built ONCE and held byte-identical across hops: callVerifierRaw is stateless, so a constant
  // system prompt is the only prompt-cache-friendly property this seam has.
  const systemPrompt = buildAgenticSystemPrompt({ tools: AGENTIC_TOOL_DEFINITIONS, grepSupported });

  for (let hop = 0; hop < AGENTIC_MAX_HOPS; hop++) {
    // Reserve check FIRST each hop: a model call plus its tool fetch plus the phase tail must all
    // still fit, or stop cleanly rather than pushing the invocation past Cloudflare's 50-subrequest
    // cap. The provider clients self-increment the tracker, so this is the correct AND only guard —
    // never call tracker.incrementSubrequests() from here.
    if (!deps.hasBudget(AGENTIC_BUDGET_RESERVE)) {
      stopReason = 'budget_exhausted';
      break;
    }

    const userPrompt = buildAgenticHopUserPrompt({
      prTitle: input.prTitle,
      touchedPaths: input.touchedPaths,
      headSha: input.headSha,
      transcript: acc.blocks, // the serialized transcript — there is NO conversation array
      hop: hop + 1,
      maxHops: AGENTIC_MAX_HOPS,
      correction: pendingCorrection,
      grepSupported,
    });

    let raw: string;
    try {
      raw = await deps.callModel(systemPrompt, userPrompt);
    } catch {
      // D-11 fail open, and NEVER retry: a provider context-length error is not classified transient
      // by isTransientModelFailure, so it arrives here as a hard error. Ending the loop with what was
      // gathered is correct; retrying would re-send the same oversized transcript.
      stopReason = 'model_call_failed';
      break;
    }
    acc.hopsUsed = hop + 1;
    pendingCorrection = null;

    // T-35-02: the parser is invoked EXACTLY ONCE per hop, on the model turn's raw text and nothing
    // else. No tool-result block, no accumulator content and no rendered fence is ever fed back
    // through it, which is what makes an action block embedded in repository content inert DATA
    // rather than a command.
    const call = parseAgenticToolCall(raw);

    if (call.kind === 'unparseable') {
      if (correctionsUsed >= 1) {
        stopReason = 'unparseable_action';
        break;
      }
      correctionsUsed += 1;
      pendingCorrection = AGENTIC_CORRECTION_MESSAGE;
      continue; // the corrective message CONSUMES this hop (D-03)
    }

    if (call.kind === 'done') {
      stopReason = 'done';
      break;
    }

    const action = call.action;
    let block: string;

    if (action.action === 'read_file') {
      const { decision, path } = resolveReadFileDecision(acc, action.path, input.skipFiles);
      const headRef = `pull request head ${input.headSha}`;
      if (decision === 'skipped_by_repo_rules') {
        block = renderAgenticToolResult({
          tool: 'read_file',
          ref: headRef,
          note: `refused: "${path}" is excluded from review by this repository's configuration — do not request it again`,
          body: 'this path is excluded from review (lockfile, build output, or generated file)',
        });
      } else if (decision === 'already_read') {
        block = renderAgenticToolResult({
          tool: 'read_file',
          ref: headRef,
          note: `already read "${path}" earlier in this session — its content is above; do not request it again`,
          body: 'already read this file earlier in this session',
        });
      } else if (decision === 'file_cap') {
        block = renderAgenticToolResult({
          tool: 'read_file',
          ref: headRef,
          note: `file scan limit (${AGENTIC_MAX_FILES}) reached — grep_repo and previously-read files remain available`,
          body: 'file scan limit reached; no further new files can be read in this session',
        });
      } else {
        const content = await deps.readFile(path);
        acc.filesRead.add(path);
        if (content === null) {
          block = renderAgenticToolResult({
            tool: 'read_file',
            ref: headRef,
            note: `"${path}" was not found at the pull request head — do not request it again`,
            body: 'file not found at this ref (it may have been deleted or never existed)',
          });
        } else {
          const totalBytes = utf8ByteLength(content);
          const capped = truncateToUtf8Bytes(content, AGENTIC_READ_FILE_MAX_BYTES);
          let body = capped.text;
          if (capped.truncated) {
            // Cut back to the last complete line so the model never reasons about half a statement.
            const lastNewline = body.lastIndexOf('\n');
            if (lastNewline > 0) body = body.slice(0, lastNewline);
          }
          block = renderReadFileResult({
            path,
            headSha: input.headSha,
            body,
            truncated: capped.truncated,
            shownBytes: utf8ByteLength(body),
            totalBytes,
          });
        }
      }
    } else {
      if (!grepSupported) {
        // Already downgraded earlier this invocation: short-circuit without spending a subrequest.
        block = renderAgenticToolResult({
          tool: 'grep_repo',
          ref: 'n/a',
          body: 'grep_repo is unavailable for this repository; use read_file instead.',
        });
      } else {
        const hits = await deps.searchCode(action.query);
        acc.grepsRun += 1;
        if (hits === null) {
          // D-05: a null return is a capability downgrade, permanent for the rest of the invocation.
          // Stated to the model rather than degraded silently (PRD-06 transparency prohibition).
          grepSupported = false;
          block = renderAgenticToolResult({
            tool: 'grep_repo',
            ref: 'n/a',
            body: 'grep_repo is unavailable for this repository; use read_file instead.',
          });
        } else {
          // Per-item cap AFTER the hit clamp and BEFORE the total cap — the ordering
          // prompts/file-review.ts:160-173 uses, so one abusive fragment cannot own the budget.
          const clamped = hits.slice(0, AGENTIC_MAX_GREP_HITS);
          const bounded = clamped.map((hit) => {
            const fragment = truncateToUtf8Bytes(hit.fragment, AGENTIC_GREP_HIT_MAX_BYTES);
            return {
              path: hit.path,
              line: hit.line,
              fragment: fragment.truncated ? `${fragment.text}…` : fragment.text,
            };
          });
          const providerRef = clamped[0]?.ref;
          block = renderGrepResult({
            hits: bounded,
            ref: providerRef ? `${defaultBranchLabel} (${providerRef})` : defaultBranchLabel,
            totalMatches: hits.length,
          });
        }
      }
    }

    const { stop } = appendBlock(acc, block);
    if (stop) {
      stopReason = 'byte_cap_reached';
      break;
    }
  }

  return {
    context: acc.blocks.join(AGENTIC_BLOCK_SEPARATOR),
    hopsUsed: acc.hopsUsed,
    filesRead: acc.filesRead.size,
    grepsRun: acc.grepsRun,
    bytesGathered: acc.totalBytes,
    truncated: acc.truncated,
    grepSupported,
    stopReason,
  };
}
