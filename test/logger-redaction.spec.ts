import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@server/core/logger';

// DB-free unit test for the structured logger's redaction policy. The logger emits a single
// JSON string to console.log/warn/error; we spy on those, parse the emitted JSON, and assert
// on the redacted fields. These tests guard that:
//   - ambient store + logger context values are redacted (not just `data`)
//   - secrets embedded inside otherwise-ordinary strings (error messages/stacks) are scrubbed
//   - existing key-based and whole-string redaction is NOT weakened
//   - ordinary log text is left untouched
//   - ordinary dotted values (spec/config filenames, semvers, hostnames) SURVIVE logging

type Captured = Record<string, any>;

function captureConsole() {
  const outputs: Captured[] = [];
  const record = (args: any[]) => {
    const first = args[0];
    if (typeof first === 'string') {
      try {
        outputs.push(JSON.parse(first));
      } catch {
        // Not a JSON log line — ignore.
      }
    }
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => record(args)),
    vi.spyOn(console, 'warn').mockImplementation((...args: any[]) => record(args)),
    vi.spyOn(console, 'error').mockImplementation((...args: any[]) => record(args)),
  ];
  return {
    outputs,
    restore: () => spies.forEach((s) => s.mockRestore()),
    last: () => outputs[outputs.length - 1],
  };
}

// Ordinary two-dot values that the logger must NOT touch. Every one of these was replaced
// wholesale with [REDACTED] by the old `obj.split('.').length === 3` heuristic — i.e. exactly
// the values you need when reading a log to debug something.
const SURVIVING_VALUES = [
  'model-output.spec.ts',
  'audit-trail-viewer.spec.tsx',
  'vite.config.ts',
  'worker-env.d.ts',
  '1.2.3',
  'v0.9.4',
  'app.codra.dev',
  'api.openai.com',
  'com.example.MyVeryLongClassNameHere',
];

// A real signed compact JWS: `eyJ`-prefixed header, payload, HS256 signature.
const SIGNED_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

// An unsigned (`alg:none`) JWT. It serialises with an EMPTY third segment, which is why the
// anchored `eyJ` pattern in logger.ts must use `*` (not `+`) on segments 2 and 3: with `+` this
// value would fall through every pattern once the dotted-split clause is gone and be logged
// verbatim, leaking its subject/claims payload. This probe is the reason that relaxation exists.
const UNSIGNED_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.';

// One representative per EMBEDDED_SECRET_PATTERNS family (excluding Bearer and the JWT entries,
// which are pinned separately above). None contains a dot, so these cases exercise the embedded
// scrub path only and are unaffected by the whole-string clause in either direction.
const CREDENTIAL_FAMILIES: Array<{ label: string; secret: string }> = [
  { label: 'OpenAI sk-', secret: 'sk-ABCD1234EFGH5678IJKL' },
  { label: 'GitHub ghp_', secret: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { label: 'GitHub fine-grained PAT', secret: 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
  { label: 'Slack xox', secret: 'xoxb-1234567890-ABCDEFGHIJKLM' },
  { label: 'AWS AKIA', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { label: 'Google AIza', secret: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456' },
  { label: 'Bitbucket ATCTT', secret: 'ATCTT3xFfGN0abcdefghijklmnopqrstuvwxyz012345678=' },
];

describe('logger redaction', () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
  });

  it('redacts a Bearer token carried in logger context', () => {
    new Logger().withContext({ authorization: 'Bearer abc123def456ghi' }).info('request');
    expect(cap.last().authorization).toBe('[REDACTED]');
    expect(cap.last().message).toBe('request');
  });

  it('scrubs a secret embedded inside an error stack/message', () => {
    const err = new Error('upstream rejected key sk-ABCD1234EFGH5678IJKL for provider');
    new Logger().error('provider failed', err);
    const serialized = JSON.stringify(cap.last());
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('sk-ABCD1234EFGH5678IJKL');
  });

  it('scrubs a GitHub token embedded in an ambient store value via runWithContext', () => {
    new Logger().runWithContext(
      { detail: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected' },
      () => {
        new Logger().info('webhook');
      },
    );
    expect(cap.last().detail).toContain('[REDACTED]');
    expect(cap.last().detail).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    // Surrounding words are preserved — only the token is replaced.
    expect(cap.last().detail).toContain('token');
    expect(cap.last().detail).toContain('rejected');
  });

  it('still redacts values under sensitive keys (existing behavior preserved)', () => {
    new Logger().info('config', { api_key: 'super-secret-value', note: 'ok' });
    expect(cap.last().data.api_key).toBe('[REDACTED]');
    expect(cap.last().data.note).toBe('ok');
  });

  it('still redacts values under the token and authorization keys', () => {
    new Logger().info('config', {
      token: 'plain-looking-value',
      authorization: 'Basic dXNlcjpwYXNz',
      note: 'ok',
    });
    expect(cap.last().data.token).toBe('[REDACTED]');
    expect(cap.last().data.authorization).toBe('[REDACTED]');
    expect(cap.last().data.note).toBe('ok');
  });

  // Replaces the former probe `aaaa.bbbb.cccc`. That probe was four lowercase-alpha characters
  // per segment — a shape no real credential has — and it only redacted as a side effect of the
  // over-broad `split('.').length === 3` heuristic being removed here. The test's INTENT is real
  // and is kept: a JWT-shaped opaque credential that the anchored `eyJ` matcher cannot see (signed
  // cookies, some session/API token formats) must still redact. Only the probe changed, to a
  // realistic high-entropy base64url triple that the structural check actually discriminates on.
  it('still redacts a high-entropy dotted triple with no eyJ prefix (defense in depth)', () => {
    new Logger().info('auth', {
      probe: 'Kf3xQp7ZmR2vLtYw9NbA.Uq8ErTyIoPaSdFgHjKlZ.Xc4Vb6Nm1QwErTyUiOpAsDfGh',
    });
    expect(cap.last().data.probe).toBe('[REDACTED]');
  });

  it('leaves ordinary log messages and values untouched', () => {
    new Logger().withContext({ repo: 'acme/widgets' }).info('review started', { count: 3 });
    expect(cap.last().message).toBe('review started');
    expect(cap.last().repo).toBe('acme/widgets');
    expect(cap.last().data.count).toBe(3);
  });
});

describe('logger redaction — ordinary dotted values survive', () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
  });

  it.each(SURVIVING_VALUES)('keeps %s intact when logged in data', (value) => {
    new Logger().info('probe', { file: value });
    expect(cap.last().data.file).toBe(value);
  });

  it('keeps a dotted value intact when carried on the logger context', () => {
    new Logger().withContext({ file: 'vite.config.ts' }).info('probe');
    expect(cap.last().file).toBe('vite.config.ts');
  });

  it('keeps a dotted value intact when carried in the ambient store', () => {
    new Logger().runWithContext({ file: 'model-output.spec.ts' }, () => {
      new Logger().info('probe');
    });
    expect(cap.last().file).toBe('model-output.spec.ts');
  });

  // Coverage, NOT proof. `Logger.log()` routes `message` through `scrubEmbeddedSecrets` only
  // (logger.ts:83) and never through `redact()`, so the whole-string dotted clause never applied
  // to the message sink — this case passes identically before and after the narrowing. The sinks
  // that genuinely go red on the removed clause are the ambient `store`, `this.context`, and
  // `data`. Without this note a future reader would mistake this case for evidence about the
  // clause it cannot exercise.
  it('keeps a dotted value intact when it is the log message itself', () => {
    new Logger().info('failed while parsing vite.config.ts');
    expect(cap.last().message).toBe('failed while parsing vite.config.ts');
  });
});

describe('logger redaction — credentials still scrub', () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
  });

  it('redacts a signed JWT logged as a whole value', () => {
    new Logger().info('auth', { probe: SIGNED_JWT });
    expect(cap.last().data.probe).toBe('[REDACTED]');
  });

  it('redacts a signed JWT embedded mid-sentence and keeps the sentence', () => {
    new Logger().info('auth', { detail: `upstream rejected ${SIGNED_JWT} for provider` });
    const detail: string = cap.last().data.detail;
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain(SIGNED_JWT);
    expect(detail).toContain('upstream');
    expect(detail).toContain('provider');
  });

  // The unsigned `alg:none` form. Its empty third segment is invisible to both the `+`-quantified
  // anchored pattern and the >=16-per-segment generic triple, so it survives ONLY because the
  // anchored `eyJ` entry was relaxed to `*` in the same commit that removed the dotted-split
  // clause. Landing that removal alone would leak this payload's subject/claims verbatim.
  it('redacts an unsigned alg:none JWT with an empty signature segment', () => {
    new Logger().info('auth', { probe: UNSIGNED_JWT });
    expect(cap.last().data.probe).toBe('[REDACTED]');
  });

  it('redacts an unsigned alg:none JWT embedded mid-sentence and keeps the sentence', () => {
    new Logger().info('auth', { detail: `upstream rejected ${UNSIGNED_JWT} for provider` });
    const detail: string = cap.last().data.detail;
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain('eyJzdWIiOiIxMjM0NTY3ODkwIn0');
    expect(detail).toContain('upstream');
    expect(detail).toContain('provider');
  });

  it('redacts a whole string beginning with Bearer', () => {
    new Logger().info('auth', { probe: 'Bearer abc123def456ghi' });
    expect(cap.last().data.probe).toBe('[REDACTED]');
  });

  it.each(CREDENTIAL_FAMILIES)('scrubs a $label credential in place', ({ secret }) => {
    new Logger().info('provider failed', { detail: `upstream rejected ${secret} for provider` });
    const serialized = JSON.stringify(cap.last());
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain(secret);
    const detail: string = cap.last().data.detail;
    expect(detail).toContain('upstream');
    expect(detail).toContain('provider');
  });
});

describe('logger redaction — hot path stays bounded', () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.restore();
  });

  // 1000 ms is deliberately loose. It is not a performance target — it is a catastrophic-
  // backtracking tripwire. Every scrub pattern uses a segment character class disjoint from its
  // `.` separator, so matching is linear; if someone later introduces an ambiguous or nested
  // quantifier, a ~200 KB dotted input blows past a full second by orders of magnitude. redact()
  // and scrubEmbeddedSecrets run on every log line, so a regression here stalls the Worker.
  it('scrubs a ~200 KB dotted low-entropy string in well under a second', () => {
    const payload = 'lorem.ipsum.dolor.'.repeat(12_000); // ~216 KB
    const started = performance.now();
    new Logger().info('bulk', { detail: payload });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });
});
