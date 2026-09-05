import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { userRouter } from '../modules/users/user.routes.js';
import { subsidiaryRouter } from '../modules/subsidiaries/subsidiary.routes.js';
import { auditRouter } from '../modules/audit/audit.routes.js';
import { documentRouter, extractedFieldRouter } from '../modules/documents/document.routes.js';
import { reportRouter, reportTemplateRouter } from '../modules/reports/report.routes.js';
import { dashboardRouter } from '../modules/dashboard/dashboard.routes.js';
import { queryRouter } from '../modules/queries/query.routes.js';
import { topicRouter } from '../modules/topics/topics.routes.js';
import { analyticsRouter } from '../modules/analytics/analytics.routes.js';

/** All application endpoints are versioned under /api/v1 — PRD §9.2, §10.2. */
export const apiRouter = Router();

/**
 * Index for the API base itself.
 *
 * `/api/v1` is only a mount prefix, so without this it falls through to the
 * 404 handler — confusing for anyone who trims the path or follows the link
 * from the startup banner. Lists the resource families only: no methods, no
 * role requirements, nothing that maps out the admin surface for an
 * unauthenticated caller.
 */
apiRouter.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      version: 'v1',
      resources: {
        auth: '/api/v1/auth',
        users: '/api/v1/users',
        subsidiaries: '/api/v1/subsidiaries',
        documents: '/api/v1/documents',
        extractedFields: '/api/v1/extracted-fields',
        reports: '/api/v1/reports',
        reportTemplates: '/api/v1/report-templates',
        dashboard: '/api/v1/dashboard',
        queries: '/api/v1/queries',
        topics: '/api/v1/topics',
        analytics: '/api/v1/analytics',
        auditLogs: '/api/v1/audit-logs',
      },
    },
  });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/subsidiaries', subsidiaryRouter);
apiRouter.use('/documents', documentRouter);
apiRouter.use('/extracted-fields', extractedFieldRouter);
apiRouter.use('/reports', reportRouter);
apiRouter.use('/report-templates', reportTemplateRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/queries', queryRouter);
apiRouter.use('/topics', topicRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/audit-logs', auditRouter);
