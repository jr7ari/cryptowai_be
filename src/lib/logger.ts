import pino from 'pino';

/**
 * Structured JSON logger. Secrets are redacted by path AND by a value scrubber,
 * so even an accidental `log.info({ headers })` never leaks an API key/signature.
 */
const REDACT_PATHS = [
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  '*.password',
  '*.token',
  '*.operatorToken',
  'headers["x-auth-apikey"]',
  'headers["x-auth-signature"]',
  'headers["X-AUTH-APIKEY"]',
  'headers["X-AUTH-SIGNATURE"]',
  'headers.authorization',
  'req.headers.authorization',
  'req.headers["x-operator-token"]',
];

const secretValues = new Set<string>();

/** Register a runtime secret so any log line containing it is scrubbed. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secretValues.add(value);
}

function scrub(obj: unknown, depth = 0): unknown {
  if (depth > 6 || secretValues.size === 0) return obj;
  if (typeof obj === 'string') {
    let out = obj;
    for (const s of secretValues) if (out.includes(s)) out = out.split(s).join('[REDACTED]');
    return out;
  }
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) res[k] = scrub(v, depth + 1);
    return res;
  }
  return obj;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'crypto-hacks-engine' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  formatters: {
    level: (label) => ({ level: label }),
    log: (o) => scrub(o) as Record<string, unknown>,
  },
});

export type Logger = typeof logger;
export const childLogger = (module: string) => logger.child({ module });
