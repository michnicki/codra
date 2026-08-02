// Phase 20.1 BLOCKER 1 (D-05 / D-06 / D-07): pure unit tests for the audit-redact redaction
// helpers. These helpers are the producer-side enforcement that makes the Phase 13 AUD-01
// privacy prohibition text ("recordUnitAudit never stores raw finding body / title / diff /
// code snippets / secret values") factually satisfiable. The helpers are pure, no I/O, so the
// tests run in the node project without a database.
//
// The test catalog below mirrors the must_haves in 20.1-01-PLAN.md and the contract in
// 20.1-CONTEXT.md (D-06 / D-07). Each test is short, asserts ONE invariant, and pins a
// specific edge of the contract so a regression that reverts the redactor OR relaxes the
// schema cap is caught here, not in production.

import { describe, expect, it } from 'vitest';
import {
  redactFindingTitle,
  redactErrorMessage,
  MACHINE_ERROR_REASONS,
} from '@server/core/audit-redact';
import { buildAgenticContextAuditEvent } from '@server/core/audit';
import { machineErrorReasonSchema } from '@shared/transient-errors';

// ---------------------------------------------------------------------------
// redactFindingTitle (D-06: fixed structural marker).
// ---------------------------------------------------------------------------

describe('redactFindingTitle (D-06 fixed structural marker)', () => {
  it('redacts a short secret-bearing title without retaining source content', () => {
    const title = 'Leaked token sk_live_secret_123';
    const out = redactFindingTitle(title);

    expect(out).toBe('[title-redacted]');
    expect(out).not.toBe(title);
    expect(out).not.toContain(title);
  });

  it('redacts the exact 100-character boundary', () => {
    expect(redactFindingTitle('x'.repeat(100))).toBe('[title-redacted]');
  });

  it.each(['x'.repeat(101), 'long-sensitive-prefix-' + 'y'.repeat(1000)])(
    'redacts long titles without retaining their raw head',
    (title) => {
      const out = redactFindingTitle(title);

      expect(out).toBe('[title-redacted]');
      expect(out).not.toContain(title.slice(0, 10));
    },
  );

  it('returns the same marker for different non-empty titles', () => {
    expect(redactFindingTitle('first private title')).toBe(
      redactFindingTitle('second unrelated title'),
    );
  });

  it.each(['unicode 🎉 title', 'control\0character', '�unpaired surrogate'])(
    'never throws or varies the marker for hostile string input',
    (title) => {
      expect(() => redactFindingTitle(title)).not.toThrow();
      expect(redactFindingTitle(title)).toBe('[title-redacted]');
    },
  );

  it.each([null, undefined, ''])(
    'returns the non-empty defensive marker for nullish or empty input',
    (title) => {
      const out = redactFindingTitle(title);

      expect(out).toBe('[clamped:empty]');
      expect(out.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// redactErrorMessage (D-07: machine-enum mapping).
// ---------------------------------------------------------------------------

describe('redactErrorMessage (D-07 machine-enum mapping)', () => {
  it('returns "unknown" for null input', () => {
    expect(redactErrorMessage(null)).toBe('unknown');
  });

  it('returns "unknown" for undefined input', () => {
    expect(redactErrorMessage(undefined)).toBe('unknown');
  });

  it('returns "unknown" for empty string input', () => {
    expect(redactErrorMessage('')).toBe('unknown');
  });

  it('returns "model_timeout" for messages matching isTimeoutMessage substrings', () => {
    expect(redactErrorMessage('Request timed out after 30s')).toBe('model_timeout');
    expect(redactErrorMessage('upstream timeout while awaiting response')).toBe('model_timeout');
    expect(redactErrorMessage('TIMED OUT (provider connection)')).toBe('model_timeout');
  });

  it('returns "model_transient" for messages matching SHARED_TRANSIENT_ERROR_SUBSTRINGS', () => {
    expect(redactErrorMessage('Model is unavailable')).toBe('model_transient');
    expect(redactErrorMessage('Experiencing high demand; retry later')).toBe('model_transient');
    expect(redactErrorMessage('Provider returned no review content')).toBe('model_transient');
    expect(redactErrorMessage('Got empty response from upstream')).toBe('model_transient');
    expect(redactErrorMessage('Secret value is [redacted] in payload')).toBe('model_transient');
  });

  it('returns "provider_5xx" for messages containing 5xx / 500 / 502 / 503 substrings', () => {
    expect(redactErrorMessage('Upstream 5xx surge')).toBe('provider_5xx');
    expect(redactErrorMessage('Got HTTP 500 Internal Server Error')).toBe('provider_5xx');
    expect(redactErrorMessage('Bad Gateway (502) from upstream')).toBe('provider_5xx');
    expect(redactErrorMessage('Service Unavailable (503)')).toBe('provider_5xx');
  });

  it('returns "network_reset" for messages containing fetch / network / econnreset', () => {
    expect(redactErrorMessage('fetch failed at socket layer')).toBe('network_reset');
    expect(redactErrorMessage('Network connection lost')).toBe('network_reset');
    expect(redactErrorMessage('ECONNRESET while reading response')).toBe('network_reset');
  });

  it('returns "unknown" for arbitrary Error.message text that fits no category', () => {
    expect(redactErrorMessage('schema validation failed at field "title"')).toBe('unknown');
    expect(redactErrorMessage('caller forgot to pass a required argument')).toBe('unknown');
    expect(redactErrorMessage('database connection refused by pg client')).toBe('unknown');
  });

  it('reads `.message` from an Error instance and classifies it', () => {
    const err = new Error('Request timed out');
    expect(redactErrorMessage(err)).toBe('model_timeout');
  });

  it('returns "unknown" for an Error instance whose `.message` is empty', () => {
    const err = new Error('');
    expect(redactErrorMessage(err)).toBe('unknown');
  });

  it('always returns a value that validates against the MACHINE_ERROR_REASONS enum', () => {
    const samples = [
      null,
      undefined,
      '',
      'timeout',
      'unavailable',
      '500',
      'fetch failed',
      'totally unclassified arbitrary message',
      new Error('timeout'),
      new Error(''),
    ];
    for (const sample of samples) {
      const out = redactErrorMessage(sample as any);
      expect(MACHINE_ERROR_REASONS).toContain(out);
      expect(machineErrorReasonSchema.safeParse(out).success).toBe(true);
    }
  });

  it('never throws on any input shape (null, undefined, number, object, Error)', () => {
    // The redactor is the audit boundary — a throw would fail open and leak the raw value.
    const adversarial = [
      null,
      undefined,
      '',
      'timeout',
      new Error('boom'),
      Object.create(null), // object with no .message
      42,
      true,
      Symbol('weird'),
    ];
    for (const input of adversarial) {
      expect(() => redactErrorMessage(input as any)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 35 (PRD-06 / T-35-21): the agentic_context event is the producer-side half of the
// counts-not-content privacy boundary.
//
// What makes this arm different from every sibling is WHAT it stands next to: the content the
// agentic loop gathers is untrusted, attacker-controlled repository source, and the audit trail is
// operator-facing and durable. A path, a grep query, a match fragment or a file body reaching the
// trail is a disclosure, not an inconvenience — so the assertion below is on the SERIALIZED string,
// which is what actually lands in the jobs.audit JSONB column.
// ---------------------------------------------------------------------------

describe('agentic_context audit serialization carries no content (T-35-21)', () => {
  // The shape a completed run has in hand at the audit write. Every string here is content the
  // builder must never copy: two of them are repository paths the loop read, one is the model's own
  // grep query, one is a matched line, one is a whole file body.
  const RUN = {
    filePaths: ['src/server/core/secret-handler.ts', 'infra/deploy/production.tfvars'],
    grepQuery: 'authenticateUser repo:acme/private-monolith',
    matchFragment: 'const API_KEY = process.env.CODRA_PRODUCTION_KEY;',
    fileBody: 'export function chargeCard(token: string) { return stripe.charge(token); }',
  };
  const FORBIDDEN = [
    ...RUN.filePaths,
    RUN.grepQuery,
    RUN.matchFragment,
    RUN.fileBody,
    // Fragments too: a "helpful" truncation to a prefix would still be a disclosure.
    'secret-handler',
    'production.tfvars',
    'authenticateUser',
    'CODRA_PRODUCTION_KEY',
    'chargeCard',
  ];

  it('serializes a completed run to counts and machine tokens only', () => {
    const event = buildAgenticContextAuditEvent('completed', {
      reason: 'done',
      hopsUsed: 4,
      filesRead: RUN.filePaths.length,
      grepsRun: 1,
      bytesGathered: RUN.fileBody.length + RUN.matchFragment.length,
      truncated: false,
      grepSupported: true,
      budgetHeadroom: 5,
    });

    const serialized = JSON.stringify(event);
    for (const forbidden of FORBIDDEN) {
      expect(serialized).not.toContain(forbidden);
    }
    // Positive control: the event is not vacuously clean because it is empty — the counts DERIVED
    // from that content are exactly what it should carry.
    expect(serialized).toContain('"files_read":2');
    expect(serialized).toContain('"greps_run":1');
  });

  it('serializes a fail-open run whose reason came from a provider error to a redacted token', () => {
    // The realistic leak path: `error.message` interpolated straight into `reason`. Routing it
    // through redactErrorMessage first is what makes that impossible.
    const providerError = new Error(
      `502 Bad Gateway while reading ${RUN.filePaths[0]} — upstream pool for acme/private-monolith exhausted`,
    );
    const event = buildAgenticContextAuditEvent('partial', {
      reason: redactErrorMessage(providerError),
      hopsUsed: 2,
      filesRead: 1,
      grepsRun: 0,
      bytesGathered: 812,
      truncated: false,
      grepSupported: true,
      budgetHeadroom: 6,
    });

    expect(event.reason).toBe('provider_5xx');
    expect(MACHINE_ERROR_REASONS).toContain(event.reason);

    const serialized = JSON.stringify(event);
    for (const forbidden of [...FORBIDDEN, 'Bad Gateway', 'acme/private-monolith', 'upstream pool']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('carries no content even when every optional field is omitted', () => {
    const event = buildAgenticContextAuditEvent('failed', { reason: 'budget_exhausted' });
    const serialized = JSON.stringify(event);
    for (const forbidden of FORBIDDEN) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(event).sort()).toEqual(['reason', 'stage', 'status', 'timestamp']);
  });
});
