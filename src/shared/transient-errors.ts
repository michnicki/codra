// Substrings that both the server's "should this persisted failed file-review be retried?" check
// (isRetryableFileReviewErrorMessage, review.ts) and its "is this live model error transient?"
// check (isTransientModelFailure, model.ts) treat as transient. Keeping the common core in one
// place stops the two lists from silently drifting apart. Each classifier still appends its own
// layer-specific extras (e.g. 'all configured review models failed', 'fetch failed').
export const SHARED_TRANSIENT_ERROR_SUBSTRINGS = [
  'unavailable',
  'high demand',
  'returned no review content',
  'empty response',
  '[redacted]',
] as const;

/** Timeouts are deliberately NOT transient here -- both classifiers fail fast on them. */
export function isTimeoutMessage(lowerMessage: string): boolean {
  return lowerMessage.includes('timed out') || lowerMessage.includes('timeout');
}

export function matchesAnyTransientSubstring(
  lowerMessage: string,
  substrings: readonly string[] = SHARED_TRANSIENT_ERROR_SUBSTRINGS,
): boolean {
  return substrings.some((substring) => lowerMessage.includes(substring));
}

// Phase 20.1 BLOCKER 1 (D-07): fixed-shape machine error reasons persisted by audit producers
// (ensemble failedRunReasons, etc.). The redactor (core/audit-redact.ts) maps an arbitrary
// `Error.message` to exactly one of these five codes — never the raw message — so the persisted
// audit trail never leaks provider response bodies or stack/host context. The codes mirror the
// existing transient-classification taxonomy (timeout / transient / 5xx / network / unknown) so
// a value already classified by the existing helpers is a shape-preserving re-mapping.
import { z } from 'zod';

export const MACHINE_ERROR_REASONS = [
  'model_timeout',
  'model_transient',
  'provider_5xx',
  'network_reset',
  'unknown',
] as const;

export type MachineErrorReason = (typeof MACHINE_ERROR_REASONS)[number];

export const machineErrorReasonSchema = z.enum(MACHINE_ERROR_REASONS);

// Public alias for the audit-event envelope. Schema is intentionally identical to
// machineErrorReasonSchema — the alias documents AUDIT-01 enforcement at the call site and
// matches the redactedErrorReasonSchema reference in BLOCKER 1's contract.
export const redactedErrorReasonSchema = machineErrorReasonSchema;
