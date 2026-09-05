import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { sendData } from '../../utils/envelope.js';
import * as service from './dashboard.service.js';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

/**
 * Dashboard summary — PRD §5.3.
 *
 * Everything here is subsidiary-scoped to the caller, including the cached
 * metrics: the cache key is derived from the caller's grants, so a user can
 * never read an aggregate computed over subsidiaries they cannot access.
 */
dashboardRouter.get('/', async (req, res, next) => {
  try {
    const user = req.user!;
    const [metrics, recentReports, pendingWork] = await Promise.all([
      service.getMetrics(user),
      service.getRecentReports(user),
      service.getPendingWork(user),
    ]);

    sendData(res, {
      quickStats: {
        extractionAccuracyPercent: metrics.extractionAccuracyPercent,
        timeSavedPercent: metrics.timeSavedPercent,
        automationCoveragePercent: metrics.automationCoveragePercent,
        // §4.6 - a stale figure presented as live is a traceability defect,
        // so freshness travels with the numbers.
        computedAt: metrics.computedAt,
        cached: metrics.cached,
      },
      documents: {
        total: metrics.documentsTotal,
        validated: metrics.documentsValidated,
        failed: metrics.documentsFailed,
        awaitingReview: metrics.documentsAwaitingReview,
      },
      recentReports,
      pendingWork,
    });
  } catch (err) {
    next(err);
  }
});

/** Metrics on their own, for polling without the rest of the payload. */
dashboardRouter.get('/metrics', async (req, res, next) => {
  try {
    sendData(res, await service.getMetrics(req.user!));
  } catch (err) {
    next(err);
  }
});
