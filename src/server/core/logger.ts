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
const EMBEDDED_SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <token>
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT (three base64url segments)
  /sk-[A-Za-z0-9._-]{8,}/g, // OpenAI-style secret keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[0-9A-Za-z_-]{20,}/g, // Google AI API keys
  /ATCTT[A-Za-z0-9_=-]{20,}/g, // Bitbucket app passwords / access tokens
];

function scrubEmbeddedSecrets(value: string): string {
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
      // Redact strings that look like Bearer tokens or JWTs
      if (obj.startsWith('Bearer ') || obj.split('.').length === 3) {
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
