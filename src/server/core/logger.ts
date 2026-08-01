import { AsyncLocalStorage } from 'node:async_hooks';

const SENSITIVE_KEYS = [
  'api_key',
  'api-key',
  'apikey',
  'secret',
  'password',
  'token',
  'private_key',
  'private-key',
  'database_url',
  'authorization',
  'session',
  'cookie',
];

const storage = new AsyncLocalStorage<Record<string, any>>();

// Patterns for secrets embedded *inside* an otherwise-ordinary string (e.g. an error message or
// stack that quotes an Authorization header, or a provider body echoing a key). Each only matches
// the credential token itself so surrounding log text is preserved. Kept deliberately conservative
// so normal messages are untouched.
//
// These are consumed ONLY through String.replace (see scrubEmbeddedSecrets). Every entry carries
// the /g flag, which means it also carries mutable `lastIndex` state — `.test()` on a /g regex
// advances lastIndex and so alternates true/false on identical input. `.replace` resets it. No
// caller may switch any of these to `.test`.
const EMBEDDED_SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <token>
  // Compact JWS/JWT. Segments 2 and 3 use `*`, not `+`, because unsigned `alg:none` tokens and
  // the detached-signature form serialise with an EMPTY trailing segment:
  //   eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.
  // That payload still carries subject and session claims, and once the whole-string dotted
  // heuristic was removed from redact() nothing else here would catch it — the generic triple
  // below needs >= 16 characters in every segment. The `eyJ` anchor is what keeps `*` safe;
  // without the anchor, `*` would match almost any dotted value.
  // Accepted residual: ANY `eyJ`-prefixed dotted value redacts, e.g. a hypothetical
  // `eyJson.config.ts`. The non-empty-segment half of that residual predates this change (the
  // previous `+` form already matched `eyJson.config.ts`); `*` widens it only to empty-segment
  // forms such as `eyJfoo.bar.`. Fail-safe direction, and no such value exists in this repo.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
  // Defense-in-depth arm for opaque credentials the `eyJ` anchor cannot see (signed cookies, some
  // session/API token formats): three base64url segments of at least 16 characters each.
  // Why 16: a real JWT header segment is ~20 characters and an HS256 signature is 43, while the
  // ordinary dotted values that show up in this repo's logs — spec/config filenames, semvers,
  // hostnames, package-qualified class names — always have at least one segment shorter than 16,
  // so the threshold separates the two classes cleanly. The negative lookbehind/lookahead exclude
  // [A-Za-z0-9_.-] so a 3-segment window inside a longer dotted chain is never partially matched.
  // Accepted residual: a contrived value whose three segments are ALL >= 16 base64url characters
  // still redacts. Unchanged from the previous behaviour, errs fail-safe, no instance in this repo.
  // Placement directly after the anchored `eyJ` entry is a most-specific-first READABILITY
  // convention, NOT a correctness requirement: scrubEmbeddedSecrets applies every pattern
  // unconditionally over the accumulated result, so swapping the two yields identical output.
  // The segment class is disjoint from the `.` separator, so there is no ambiguity and no nested
  // quantifier — matching is linear, not backtracking, which matters on the logging hot path.
  /(?<![A-Za-z0-9_.-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_.-])/g,
  /sk-[A-Za-z0-9._-]{8,}/g, // OpenAI-style secret keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[0-9A-Za-z_-]{20,}/g, // Google AI API keys
  /ATCTT[A-Za-z0-9_=-]{20,}/g, // Bitbucket app passwords / access tokens
];

// EXPORTED (WR-02, 34-REVIEW) so producers of persisted, operator-visible text that never routes
// through the logger — notably `jobs.audit` event reasons built from untrusted input — can apply
// the same credential scrubbing the log path gets. `redact()` itself stays private: it is
// object-shaped and key-aware, which is the wrong contract for a bare string.
export function scrubEmbeddedSecrets(value: string): string {
  let result = value;
  for (const pattern of EMBEDDED_SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function redact(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') {
    if (typeof obj === 'string') {
      // A value that begins `Bearer ` is redacted whole rather than delegated to the embedded
      // Bearer regex: that pattern's character class is [A-Za-z0-9._~+/=-], so a token containing
      // anything outside it (`%`, `:`) would match only partially and leak the remaining
      // fragment. The whole-string form is the fail-safe here and has no false-positive problem.
      //
      // The former companion disjunct — a test for a string containing exactly two dots — was
      // removed: it replaced ANY such value wholesale, destroying spec/config filenames, semvers
      // and hostnames (model-output.spec.ts, vite.config.ts, 1.2.3, app.codra.dev) while letting
      // 4-segment hostnames and IPv4 addresses through, so it was a bad discriminator in both
      // directions. Structural JWT / opaque-triple detection now lives in
      // EMBEDDED_SECRET_PATTERNS, which replaces only the matched token and keeps the
      // surrounding log text readable.
      if (obj.startsWith('Bearer ')) {
        return '[REDACTED]';
      }
      // Otherwise scrub any secret embedded within an ordinary string in-place.
      return scrubEmbeddedSecrets(obj);
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(redact);

  const redacted: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sk) => lowerKey.includes(sk))) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redact(value);
    }
  }
  return redacted;
}

export class Logger {
  constructor(private context: Record<string, any> = {}) {}

  withContext(newContext: Record<string, any>) {
    return new Logger({ ...this.context, ...newContext });
  }

  private log(level: string, message: string, data?: any) {
    const store = storage.getStore() || {};
    const output = {
      timestamp: new Date().toISOString(),
      level,
      message: scrubEmbeddedSecrets(message),
      // Ambient store and logger context are attacker-influenced (they carry request/job values
      // and withContext/runWithContext data), so they must pass through the same redaction as
      // `data` — otherwise a Bearer token or key threaded into context would be logged verbatim.
      ...redact(store),
      ...redact(this.context),
      ...(data ? { data: redact(data) } : {}),
    };

    if (level === 'error') {
      console.error(JSON.stringify(output));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(output));
    } else {
      console.log(JSON.stringify(output));
    }
  }

  runWithContext<T>(context: Record<string, any>, fn: () => T): T {
    return storage.run({ ...(storage.getStore() || {}), ...context }, fn);
  }

  info(message: string, data?: any) {
    this.log('info', message, data);
  }

  error(message: string, data?: any) {
    if (data instanceof Error) {
      this.log('error', message, {
        name: data.name,
        message: data.message,
        stack: data.stack,
      });
    } else {
      this.log('error', message, data);
    }
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data);
  }

  debug(message: string, data?: any) {
    this.log('debug', message, data);
  }
}

export const logger = new Logger();
