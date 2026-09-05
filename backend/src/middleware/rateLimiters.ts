/**
 * Rate limiting — PRD §9.2.
 *
 * Three tiers: a global limit on the API, a strict limit on authentication,
 * and a dedicated limit for public unauthenticated routes such as invite
 * accept, which cannot be limited per user. `/health` and `/ready` are mounted
 * outside all of these (PRD §9.2.1, §9.7) so platform health-polling cannot
 * trip the limiter and make the service look down.
 *
 * Phase 2 adds two further tiers for the AI and analytics routes. Those differ
 * in kind, not just in number: they are keyed on the authenticated USER rather
 * than on the IP, because they are the only routes that always sit behind
 * `requireAuth` and the only ones whose per-request cost is unbounded.
 */
import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import { ErrorCode } from '../utils/apiError.js';
import { env } from '../config/env.js';

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Disabled under test so suites are not throttled by their own fixtures.
  skip: () => env.isTest,
  message: {
    success: false,
    error: { code: ErrorCode.RATE_LIMIT_EXCEEDED, message: 'Too many requests, please try again later' },
  },
};

export const globalLimiter = rateLimit({ ...shared, windowMs: 60_000, max: 100 });

/** Strict: OTP issuance and verification are the brute-force surface. */
export const authLimiter = rateLimit({ ...shared, windowMs: 60_000, max: 10 });

/** Public, unauthenticated routes — invite accept. */
export const publicLimiter = rateLimit({ ...shared, windowMs: 60_000, max: 20 });

/**
 * Keyed on the USER, not the IP.
 *
 * These routes ALWAYS sit behind requireAuth in their own router, so a user key
 * is strictly better: behind a shared government NAT a per-IP limit would let
 * one caller exhaust a whole office's quota, and abuse would not be
 * attributable to an account.
 *
 * `ipKeyGenerator(req.ip ?? '')` rather than raw `req.ip` for the
 * unauthenticated fallback: express-rate-limit v8 REJECTS a custom keyGenerator
 * that returns an unnormalised IPv6 address (ERR_ERL_KEY_GEN_IPV6).
 */
const byUser = (req: { user?: { id: string }; ip?: string }) =>
  req.user?.id ?? ipKeyGenerator(req.ip ?? '');

/**
 * §9.2 requires stricter limits for AI endpoints. Answer generation is the most
 * expensive authenticated operation in the system and — once a hosted provider
 * is wired — the only one that costs money per call.
 */
export const aiLimiter = rateLimit({ ...shared, windowMs: 60_000, max: 12, keyGenerator: byUser });

/**
 * A cold-cache /topics or /analytics request is the heaviest READ in the
 * system. A cheap authenticated request must not be able to schedule unbounded
 * aggregation work.
 */
export const analyticsLimiter = rateLimit({ ...shared, windowMs: 60_000, max: 30, keyGenerator: byUser });
