import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { analyticsLimiter } from '../../middleware/rateLimiters.js';
import { sendData } from '../../utils/envelope.js';
import * as service from './topics.service.js';
import * as intelligence from './topicIntelligence.service.js';
import {
  getTopicsQuerySchema,
  topicAnalyticsQuerySchema,
  topicCatalogQuerySchema,
  type GetTopicsQuery,
  type TopicAnalyticsQuery,
  type TopicCatalogQuery,
} from './topics.schema.js';

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

/**
 * The taxonomy itself — the filter control's option list.
 *
 * No database read and no rate limiter: it returns a constant compiled into the
 * server, and a dropdown that waits on an aggregation feels broken. It is still
 * behind `requireAuth`, because the vocabulary describes what this system is
 * built to read and that is not public.
 */
topicRouter.get('/vocabulary', (_req, res) => {
  sendData(res, { topics: intelligence.getTopicVocabulary() });
});

/**
 * §13 Topic Explorer, and the counted version of the filter list: every topic
 * present in the caller's corpus with its document count, its most recent
 * documents and the topics it travels with.
 */
topicRouter.get(
  '/catalog',
  analyticsLimiter,
  validate({ query: topicCatalogQuerySchema }),
  async (req, res, next) => {
    try {
      sendData(res, await intelligence.getTopicCatalog(validatedQuery<TopicCatalogQuery>(res), req.user!));
    } catch (err) {
      next(err);
    }
  },
);

/** §14 — the dashboard's Document Intelligence panel. */
topicRouter.get(
  '/analytics',
  analyticsLimiter,
  validate({ query: topicAnalyticsQuerySchema }),
  async (req, res, next) => {
    try {
      sendData(res, await intelligence.getTopicAnalytics(validatedQuery<TopicAnalyticsQuery>(res), req.user!));
    } catch (err) {
      next(err);
    }
  },
);
