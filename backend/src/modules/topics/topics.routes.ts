import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { analyticsLimiter } from '../../middleware/rateLimiters.js';
import { sendData } from '../../utils/envelope.js';
import * as service from './topics.service.js';
import { getTopicsQuerySchema, type GetTopicsQuery } from './topics.schema.js';

/**
 * PRD §4.3, §5.6, §10.2. All three roles — §2 gives MoC officials analytics —
 * and the term rows are subsidiary-filtered inside every pipeline.
 *
 * Inline handler, matching dashboard.routes.ts and report.routes.ts for small
 * families; a controller file would be ceremony for one route.
 *
 * analyticsLimiter, not the global limit: a cold-cache request is the heaviest
 * read in the system, and a cheap authenticated request must not be able to
 * schedule unbounded aggregation work (§9.2).
 */
export const topicRouter = Router();

topicRouter.use(requireAuth);

topicRouter.get('/', analyticsLimiter, validate({ query: getTopicsQuerySchema }), async (req, res, next) => {
  try {
    // Express 5 makes req.query a getter, so the validated values come from
    // res.locals via validatedQuery — reading req.query here would bypass
    // coercion and the defaults.
    sendData(res, await service.getTopics(validatedQuery<GetTopicsQuery>(res), req.user!));
  } catch (err) {
    next(err);
  }
});
