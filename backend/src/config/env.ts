/**
 * Environment contract — PRD §7.1.
 *
 * Single source of truth for configuration. No other module may read
 * `process.env`. Invalid configuration crashes the process at startup rather
 * than starting a server in an undefined state.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Load `.env` for local development, using Node's built-in loader — no
 * dependency required.
 *
 * Values already present in the real environment win, so a platform-injected
 * variable is never overwritten by a stray local file. In production,
 * configuration normally comes from the platform and no `.env` exists; that is
 * fine, the file is optional and the schema below is the actual gate.
 */
if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // A malformed .env is not fatal here — the schema below reports precisely
    // which variables are missing or invalid, which is the more useful error.
  }
}

const hex = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`), `must be exactly ${bytes * 2} hex characters (${bytes} bytes)`);

const envSchema = z
  .object({
    // ── Server ───────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),

    /**
     * Number of reverse-proxy hops in front of this process, for Express's
     * `trust proxy`. It must equal the real chain length, and the chain grew
     * when §11.9 resolved to a same-site topology: the Next.js rewrite is now
     * itself a hop, so a load-balanced deployment is browser → LB → Next →
     * Express, or 2 — while local development is browser → Next → Express, or 1.
     *
     * Getting this wrong is silent and expensive in both directions. Too low and
     * `req.ip` resolves to the nearest proxy instead of the client: every rate
     * limiter becomes a single global budget shared by the whole user base, and
     * every audit row records the proxy's address, quietly emptying the §9.6
     * compliance trail of the one field that identifies who acted. Too high and
     * a client can spoof `X-Forwarded-For` to evade rate limiting entirely.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

    // ── Database ─────────────────────────────────────────────────────────
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    // ── JWT / sessions ───────────────────────────────────────────────────
    JWT_ACCESS_SECRET: z.string().min(64, 'must be at least 64 characters'),
    JWT_REFRESH_SECRET: z.string().min(64, 'must be at least 64 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    // ── Token hashing (PRD §9.3) ─────────────────────────────────────────
    TOKEN_HASH_SECRET: z.string().min(32, 'must be at least 32 characters'),

    // ── Application-level encryption (PRD §9.11) ─────────────────────────
    ENCRYPTION_KEY: hex(32),

    // ── Web ──────────────────────────────────────────────────────────────
    CLIENT_URL: z.url('must be a valid URL'),
    CORS_ORIGINS: z.string().min(1),
    DEPLOY_TOPOLOGY: z.enum(['same-site', 'cross-site']).default('same-site'),

    // ── Auth policy ──────────────────────────────────────────────────────
    OTP_LENGTH: z.coerce.number().int().min(6).max(10).default(6),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    ACCOUNT_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
    INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),

    // ── Email ────────────────────────────────────────────────────────────
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    EMAIL_FROM: z.email('must be a valid email address').optional(),

    // ── File storage & uploads (PRD §9.4, §11.6) ─────────────────────────
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./var/uploads'),
    // Cap for the multipart upload route ONLY. The 10kb JSON limit in §9.2
    // stays untouched; raising that would strip protection from every JSON route.
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400), // 25 MiB

    // ── Rate limits (PRD §9.2) ────────────────────────────────────────────
    /*
     * Rate limits, per 60-second window (PRD §9.2).
     *
     * Tunable because the right number is environment-specific: a shared
     * government NAT needs more headroom than a single developer, and an
     * end-to-end suite that exercises the auth flow repeatedly would otherwise
     * throttle itself. The DEFAULTS are the production values — an environment
     * has to opt into anything looser, so forgetting to set them is safe.
     */
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_PUBLIC_MAX: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_AI_MAX: z.coerce.number().int().positive().default(12),
    RATE_LIMIT_ANALYTICS_MAX: z.coerce.number().int().positive().default(30),

    // ── Extraction / OCR (PRD §11.2, §11.7) ──────────────────────────────
    OCR_PROVIDER: z.enum(['local']).default('local'),
    // Extractions at or below this confidence are flagged for manual review (§4.1).
    OCR_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),

    // ── AI query & retrieval (PRD §4.4, §9.5, §11.2, §11.7) ──────────────
    /**
     * §11.7 ("may external providers process government documents?") is a
     * BLOCKING production decision, so `local` is the only value. It answers
     * OFFLINE from passages this server already authorised; nothing leaves the
     * machine.
     *
     * When this enum is widened, add a `.refine` making `AI_PROVIDER_API_KEY`
     * required for any non-`local` value. Such a refine is unreachable dead
     * code against a single-member enum, so it is deliberately omitted rather
     * than written as decoration that no test could ever exercise.
     */
    AI_PROVIDER: z.enum(['local']).default('local'),
    AI_PROVIDER_API_KEY: z.string().optional(),
    AI_PROVIDER_ENDPOINT: z.url('must be a valid URL').optional(),
    AI_RETRIEVAL_CANDIDATES: z.coerce.number().int().min(1).max(200).default(40),
    AI_RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(8),
    // Relevance diversity and injection blast radius, one knob: one file must
    // not fill the context window.
    AI_RETRIEVAL_MAX_CHUNKS_PER_DOCUMENT: z.coerce.number().int().min(1).max(10).default(2),
    AI_ANSWER_MAX_PASSAGES: z.coerce.number().int().min(1).max(20).default(5),
    // Matches the OCR adapter's MAX_CHUNK_CHARS, so truncation is normally a no-op.
    AI_MAX_CONTEXT_CHARS_PER_CHUNK: z.coerce.number().int().positive().default(1200),
    AI_MAX_ANSWER_CHARS: z.coerce.number().int().min(200).max(20_000).default(4000),
    AI_CITATION_QUOTE_CHARS: z.coerce.number().int().positive().default(300),
    AI_LOCAL_MAX_SENTENCES: z.coerce.number().int().min(1).max(10).default(3),
    AI_ANSWER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * `exclude` drops a chunk that trips the injection scanner. This is the
     * correct default and should not be changed casually: the local provider is
     * EXTRACTIVE, so a flagged-but-retained chunk would have its injected
     * sentence quoted verbatim into a parliamentary draft — a failure that
     * happens whether or not any model ever "followed" the instruction.
     *
     * `flag` exists only for an operator investigating a false positive, and
     * the affected passage count is reported on every response either way.
     */
    AI_INJECTION_POLICY: z.enum(['exclude', 'flag']).default('exclude'),
    // Query pipeline (instructions §4a). Answering is asynchronous, so a worker
    // that dies mid-answer must be recoverable without an operator: attempts
    // are bounded, and a row stuck in `answering` past the timeout is reclaimed.
    QUERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    QUERY_STUCK_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10),

    // ── Word cloud & topics (PRD §4.3, §5.6) ─────────────────────────────
    TOPICS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    // The single biggest lever on `wordFrequencies` growth: every indexed
    // source writes at most this many rows.
    TOPICS_MAX_TERMS_PER_SOURCE: z.coerce.number().int().min(10).max(2000).default(300),
    TOPICS_CLUSTER_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
    TOPICS_CLUSTER_MAX_TERMS: z.coerce.number().int().min(10).max(200).default(60),
    TOPICS_MAX_CLUSTERS: z.coerce.number().int().min(1).max(50).default(25),
    // ~3 Indian fiscal years. Bounds the most expensive request a client can
    // make — topics must not be the one read path with no range cap.
    TOPICS_MAX_RANGE_DAYS: z.coerce.number().int().positive().default(1100),

    // ── Analytics (PRD §4.6) ─────────────────────────────────────────────
    ANALYTICS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    ANALYTICS_MAX_BUCKETS: z.coerce.number().int().min(1).max(120).default(24),
    // Deliberately no ANALYTICS_* twin of the metric assumptions. Analytics
    // reuses BASELINE_MANUAL_MINUTES_PER_DOC, MINUTES_PER_MANUAL_OVERRIDE and
    // OCR_REVIEW_THRESHOLD, so /dashboard and /analytics cannot report
    // different numbers for the same period — and those three are exactly what
    // metricAssumptionsFingerprint() hashes into every cache key.

    // ── Dashboard metrics (PRD §4.6) ─────────────────────────────────────
    METRICS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // Documented estimation assumptions behind "Time Saved %". These are
    // estimates, not measurements — change them here, not in the query.
    BASELINE_MANUAL_MINUTES_PER_DOC: z.coerce.number().positive().default(45),
    MINUTES_PER_MANUAL_OVERRIDE: z.coerce.number().positive().default(3),

    // ── Observability ────────────────────────────────────────────────────
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  })
  /**
   * The two secrets must differ. Reusing one for both would let an access
   * token be replayed as a refresh token (PRD §7.1).
   */
  .refine((cfg) => cfg.JWT_ACCESS_SECRET !== cfg.JWT_REFRESH_SECRET, {
    message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values',
    path: ['JWT_REFRESH_SECRET'],
  })
  /**
   * Production must be able to actually deliver OTP codes and invitations —
   * an auth system that cannot send mail is a locked door with no key.
   */
  .refine((cfg) => cfg.NODE_ENV !== 'production' || Boolean(cfg.SMTP_HOST && cfg.EMAIL_FROM), {
    message: 'SMTP_HOST and EMAIL_FROM are required when NODE_ENV=production',
    path: ['SMTP_HOST'],
  })
  /**
   * Retrieval fetches `AI_RETRIEVAL_CANDIDATES` chunks; the answer may quote at
   * most `AI_ANSWER_MAX_PASSAGES` of them. Inverted, the answer is silently
   * capped below what was actually retrieved and the symptom is an answer that
   * misses an obviously relevant passage — read by everyone as a relevance bug
   * rather than as the configuration error it is. That is precisely the class
   * of silent failure §7.1's fail-fast rule exists to prevent.
   *
   * This refine is REACHABLE, which is why it is written and the
   * `AI_PROVIDER_API_KEY` one is not (see the AI_PROVIDER comment above).
   */
  /**
   * PRD §13: "`SameSite=None` is never set without a paired CSRF token."
   *
   * `cross-site` switches the refresh cookie to `SameSite=None`, which forfeits
   * the ONLY CSRF control this API currently has. The paired double-submit
   * token layer §9.14 describes is not built, because §11.9 (the deployment
   * topology) is still an open decision and building the wrong half of it first
   * is how a control ends up present-but-wrong.
   *
   * So the value stays selectable — the topology is a real choice, and the
   * cookie logic below already honours it — but selecting it FAILS THE BOOT
   * rather than silently shipping an API whose refresh endpoint authenticates
   * from a cookie any origin can cause the browser to send. A one-line
   * environment change must not be able to remove a security control quietly;
   * that is exactly the silent-failure class §7.1's fail-fast rule exists for.
   *
   * Delete this refine in the same change that lands the CSRF token layer.
   */
  .refine((cfg) => cfg.DEPLOY_TOPOLOGY !== 'cross-site', {
    message:
      'DEPLOY_TOPOLOGY=cross-site requires the §9.14 CSRF token layer, which is not implemented yet (§11.9 is an open decision). Use same-site, or implement the paired control first.',
    path: ['DEPLOY_TOPOLOGY'],
  })
  .refine((cfg) => cfg.AI_ANSWER_MAX_PASSAGES <= cfg.AI_RETRIEVAL_CANDIDATES, {
    message: 'AI_ANSWER_MAX_PASSAGES cannot exceed AI_RETRIEVAL_CANDIDATES',
    path: ['AI_ANSWER_MAX_PASSAGES'],
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console -- the logger depends on env; this runs before it exists.
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const data = parsed.data;

export const env = {
  ...data,
  corsOrigins: data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  isProduction: data.NODE_ENV === 'production',
  isTest: data.NODE_ENV === 'test',
  /**
   * PRD §9.14: same-site deployment keeps SameSite=Strict and needs no CSRF
   * token layer. `cross-site` requires SameSite=None, which forfeits SameSite
   * protection — do not enable it without the paired CSRF token control.
   */
  refreshCookie: {
    name: 'geominex_session',
    sameSite: data.DEPLOY_TOPOLOGY === 'same-site' ? ('strict' as const) : ('none' as const),
    secure: data.NODE_ENV === 'production',
    maxAgeMs: data.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth',
  },
} as const;

export type Env = typeof env;
