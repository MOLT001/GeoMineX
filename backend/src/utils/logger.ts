/**
 * Structured logging — PRD §9.6, §9.7, §9.10.
 *
 * Never log passwords, access/refresh tokens, OTP codes, API keys, or raw
 * sensitive PII. The redaction pass below is a safety net, not a licence to
 * pass secrets in: keep them out of the call site in the first place.
 */
import winston from 'winston';
import { env } from '../config/env.js';

const REDACTED = '[REDACTED]';

/** Keys whose values are scrubbed anywhere they appear in log metadata. */
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'tokenHash',
  'code',
  'otp',
  'otpHash',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'inviteToken',
  'encryptionKey',
  // §9.5 — AI prompts, retrieved context, outputs and errors must not leak into
  // logs. The queries module deliberately logs counts and ids only; this is the
  // safety net that makes an accidental future
  // `logger.info('answered', { responseText })` inert rather than a disclosure.
  'prompt',
  'passages',
  'passage',
  'context',
  'questionText',
  'answerText',
  'responseText',
  'officialResponseText',
  'quote',
  'snippet',
  'excerpt',
  'chunkText',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

/**
 * Redacts the log payload IN PLACE.
 *
 * It must not rebuild the info object: Winston carries `level` and `message`
 * on Symbol keys that `Object.entries` does not see, and returning a fresh
 * plain object drops them — which makes every downstream format throw, and
 * turns an innocuous log line into a failed request.
 */
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    const val = (info as Record<string, unknown>)[key];
    (info as Record<string, unknown>)[key] = SENSITIVE_KEYS.has(key) ? REDACTED : redact(val);
  }
  return info;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  // Quiet under test so suite output stays readable; DEBUG_LOGS=1 re-enables
  // it when a test failure needs the server-side reason.
  silent: env.isTest && process.env.DEBUG_LOGS !== '1',
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: !env.isProduction }),
    env.isProduction ? winston.format.json() : winston.format.prettyPrint({ colorize: true }),
  ),
  defaultMeta: { service: 'geominex-api' },
  transports: [new winston.transports.Console()],
});
