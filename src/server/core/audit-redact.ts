// Phase 20.1 BLOCKER 1 (D-05 / D-06 / D-07): pure, never-throw, non-IO helpers that strip raw
// finding titles and arbitrary Error.message text from any audit-event payload BEFORE it reaches
// the jobs.audit ring buffer. The HUMAN audit-trail sign-off (Phase 13 UAT addendum D-07) commits
// to "recordUnitAudit never stores raw finding body / title / diff / code snippets / secret values"
// — these two helpers are the producer-side enforcement that makes that commitment factually
// satisfiable. They are intentionally SMALL (one pass, no allocations beyond the returned string)
// because every audit event runs them on the review hot path.
//
// Design constraints (per CONTEXT.md D-05 / D-06 / D-07):
//   - Pure: no I/O, no Date.now(), no module-level state. Testable in isolation. Safe to call
//     from any phase producer.
//   - Never-throw: ALL inputs are defensively typed (string | null | undefined | Error). The
//     helpers are the audit boundary — a throwing redactor would FAIL OPEN and leak the raw
//     value, which is the exact regression BLOCKER 1 is closing. They always return a string.
//   - Schema-bounded: the returned strings are guaranteed to satisfy the audit-event `title`
//     `.max(100)` (redacted title) and the MACHINE_ERROR_REASONS enum (error reason). The
//     redactor is the LAST producer step before the schema writes — the schema is the second
//     line of defense, not the first.
//   - Provider-neutral: the helpers are pure string-in / string-out, with no reference to
//     GitHub/Bitbucket. NREG-02 parity holds by construction (NREG-02 test invokes the helpers
//     with the same inputs and asserts identical outputs).

import {
  isTimeoutMessage,
  matchesAnyTransientSubstring,
  MACHINE_ERROR_REASONS,
  type MachineErrorReason,
} from '@shared/transient-errors';

// D-06: the length cap for a raw title that the redactor treats as "unchanged". A title at or
// below this length passes through verbatim — a long title is preserved for operator debug, not
// dropped, so the audit trail still names the finding. The 100-char ceiling matches the existing
// clampAuditTitle semantics so the audit-event schema can move `.max(200)` -> `.max(100)` without
// breaking any other producer.
const FINDING_TITLE_MAX_LENGTH = 100;

// Worst-case length of the redacted marker for a title at FINDING_TITLE_MAX_LENGTH:
//   "[clamped:head 100 chars " + 100 chars + "...]" = 22 + 100 + 4 = 126 chars.
// Plus the trim() / whitespace collapse introduced in the D-06 substring step (worst case: the
// head is all whitespace and collapses to "" so the marker is shorter than 100). The schema cap
// of 100 is therefore strict — the redactor must truncate BEFORE the marker wrapping. The
// explicit clamp on the head slice keeps the conditional "<= 110" in the spec literal-shaped.
const REDACTED_TITLE_HEAD_LENGTH = 100;
const REDACTED_MARKER_HEAD_BUDGET = 72;

// Defensive marker for null / undefined / empty input. A non-empty placeholder keeps the
// downstream schema's `min(1)` truth value (the relaxed proposal still wants a non-empty cell
// so the audit viewer does not have to special-case a totally empty title).
const EMPTY_TITLE_MARKER = '[clamped:empty]';

// Provider 5xx substrings (D-07 bucket). Substring match on lowercased message — a hostile
// provider payload is classified by the presence of any of these tokens, never by parsing the
// full HTTP status out of the message body.
const PROVIDER_5XX_SUBSTRINGS = ['5xx', '500', '502', '503'] as const;

// Network reset / transport substrings (D-07 bucket). Matches `fetch`, `network`, and the
// Node-style `econnreset` family. The error.message is lowercased before the check.
const NETWORK_RESET_SUBSTRINGS = ['fetch', 'network', 'econnreset'] as const;

/**
 * D-06 length-bounded head clamp. Returns the title unchanged when its length is <= 100 chars.
 * Returns a fixed-shape marker `<prefix> <head>...` for longer input where:
 *   - prefix       = "[clamped:head 100 chars "  (always literal, never varies)
 *   - head         = the first 100 chars of the title with whitespace collapsed + trimmed
 *   - suffix       = "..."                       (always literal)
 * Returns the EMPTY_TITLE_MARKER for null / undefined / empty input so downstream code never
 * sees a slip-through empty string. The marker is always non-empty and <= 110 chars.
 *
 * Never throws on unicode / control chars / surrogate pairs — the head is sliced at a char
 * boundary (JavaScript string `.slice` is character-index based, which is safe for the
 * scalar values in a finding title; no UTF-16 surrogate splitting is possible here because
 * `length` returns code-unit count, so a slice at `length` is a code-unit slice — acceptable
 * for the audit boundary where the head is a human-debug elision, not a parser input).
 */
export function redactFindingTitle(title: string | null | undefined): string {
  if (title == null || title === '') return EMPTY_TITLE_MARKER;
  if (title.length <= FINDING_TITLE_MAX_LENGTH) return title;
  const head = title
    .slice(0, REDACTED_TITLE_HEAD_LENGTH)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REDACTED_MARKER_HEAD_BUDGET);
  return `[clamped:head 100 chars ${head}...]`;
}

/**
 * D-07 machine-enum mapping. Returns one of the 5 MACHINE_ERROR_REASONS codes — never the raw
 * `Error.message` — so the audit trail never carries provider response bodies, stack frames, or
 * host context. The classification order is intentional:
 *
 *   1. null / undefined / empty  -> 'unknown' (fail-open default; never re-throw)
 *   2. timeout substring         -> 'model_timeout' (matches the existing isTimeoutMessage)
 *   3. transient substring       -> 'model_transient' (matches SHARED_TRANSIENT_ERROR_SUBSTRINGS)
 *   4. 5xx substring             -> 'provider_5xx' (HTTP 5xx categories)
 *   5. network substring         -> 'network_reset' (transport-layer / DNS / etc.)
 *   6. catch-all                 -> 'unknown'
 *
 * The function accepts `string | null | undefined` and `Error` (the message is read from
 * `error.message` defensively; an Error without a `.message` field falls through to
 * 'unknown'). This single signature replaces the prior `result.reason instanceof Error ? .message :
 * String(...)` chain in ensemble failure logging (model.ts:524-534).
 */
export function redactErrorMessage(
  message: string | Error | null | undefined,
): MachineErrorReason {
  let lower: string;
  if (message == null) return 'unknown';
  if (message instanceof Error) {
    lower = (message.message ?? '').toLowerCase();
  } else if (typeof message === 'string') {
    lower = message.toLowerCase();
  } else {
    // Adversarial non-string input (number, boolean, object, Symbol): coerce via String().
    // String(Symbol('x')) throws; wrap in try/catch and fall through to 'unknown'. The redactor
    // is the audit boundary — a throw here would fail open and leak the raw value.
    try {
      lower = String(message).toLowerCase();
    } catch {
      return 'unknown';
    }
  }
  if (lower.length === 0) return 'unknown';
  if (isTimeoutMessage(lower)) return 'model_timeout';
  // Provider 5xx is checked BEFORE the generic transient substring list because the SHARED_TRANSIENT
  // list includes 'unavailable' which would otherwise swallow 'Service Unavailable (503)' into
  // 'model_transient'. The 5xx bucket is a more specific classification — it's the source of the
  // transient — so it wins.
  if (PROVIDER_5XX_SUBSTRINGS.some((substring) => lower.includes(substring))) {
    return 'provider_5xx';
  }
  if (matchesAnyTransientSubstring(lower)) return 'model_transient';
  if (NETWORK_RESET_SUBSTRINGS.some((substring) => lower.includes(substring))) {
    return 'network_reset';
  }
  return 'unknown';
}

// Re-export the tuple so callers can validate a redacted reason against the enum without
// importing @shared/transient-errors directly. The tuple is the same const reference; this is
// a convenience re-export, not a copy.
export { MACHINE_ERROR_REASONS };
