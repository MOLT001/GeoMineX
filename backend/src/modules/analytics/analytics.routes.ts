import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { analyticsLimiter } from '../../middleware/rateLimiters.js';
import { sendData } from '../../utils/envelope.js';
import * as service from './analytics.service.js';
import { getAnalyticsQuerySchema, type GetAnalyticsQuery } from './analytics.schema.js';

/**
 * PRD §4.6, §7.7, §10.2 — the series and breakdown behind the §5.3 dashboard.
 *
 * ALL THREE ROLES. §2 grants MoC officials analytics explicitly, and a CIL user
 * sees only their own subsidiaries because the scope clause sits inside every
 * pipeline AND inside the cache key — so neither the computation nor the cached
 * result can cross a grant boundary.
 *
 * Inline handler, matching dashboard.routes.ts and topics.routes.ts: a
 * controller file would be ceremony for one route.
 *
 * `analyticsLimiter` rather than the global limit: a cold-cache request is
 * among the heaviest reads in the system, and a cheap authenticated request
 * must not be able to schedule unbounded aggregation work (§9.2). Note that the
 * limiter inherits `skip: () => env.isTest`, so the 429 path is asserted by a
 * config unit test rather than by an integration test.
 *
 * Middleware order is `requireAuth` -> limiter -> `validate`, matching Phase 1
 * (D10). No `roleGuard`: there is no role that may not read analytics, and a
 * guard listing every role is a guard that only ever goes stale.
 */
export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

analyticsRouter.get(
  '/',
  analyticsLimiter,
  validate({ query: getAnalyticsQuerySchema }),
  async (req, res, next) => {
    try {
      // Express 5 makes `req.query` a getter, so validated values are read from
      // res.locals via validatedQuery — never from req.query after validation.
      sendData(res, await service.getAnalytics(validatedQuery<GetAnalyticsQuery>(res), req.user!));
    } catch (err) {
      next(err);
    }
  },
);
