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

// Defensive marker for null / undefined / empty input. A non-empty placeholder keeps the
// downstream schema's `min(1)` truth value so the audit viewer does not need to special-case
// a totally empty title.
const EMPTY_TITLE_MARKER = '[clamped:empty]';

// Every non-empty title maps to one input-independent value. This intentionally sacrifices
// title-level debugging so jobs.audit can never retain model-supplied title content.
const REDACTED_FINDING_TITLE_MARKER = '[title-redacted]';

// Provider 5xx substrings (D-07 bucket). Substring match on lowercased message — a hostile
// provider payload is classified by the presence of any of these tokens, never by parsing the
// full HTTP status out of the message body.
const PROVIDER_5XX_SUBSTRINGS = ['5xx', '500', '502', '503'] as const;

// Network reset / transport substrings (D-07 bucket). Matches `fetch`, `network`, and the
// Node-style `econnreset` family. The error.message is lowercased before the check.
const NETWORK_RESET_SUBSTRINGS = ['fetch', 'network', 'econnreset'] as const;

/**
 * Maps every non-empty finding title to a fixed structural marker before audit persistence.
 * No source-derived prefix, digest, length, or other title content is retained. Nullish and empty
 * defensive inputs use a separate non-empty marker. Both outputs satisfy the audit title schema.
 */
export function redactFindingTitle(title: string | null | undefined): string {
  if (title == null || title === '') return EMPTY_TITLE_MARKER;
  return REDACTED_FINDING_TITLE_MARKER;
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
