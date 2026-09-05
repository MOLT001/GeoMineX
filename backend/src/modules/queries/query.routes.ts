import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { roleGuard } from '../../middleware/roleGuard.js';
import { validate } from '../../middleware/validate.js';
import { aiLimiter } from '../../middleware/rateLimiters.js';
import * as controller from './query.controller.js';
import {
  createQuerySchema,
  listQueriesQuerySchema,
  queryIdParamSchema,
  reviewQuerySchema,
} from './query.schema.js';

/**
 * Query routes — PRD §4.4, §5.7, §9.2, §10.2.
 *
 * TODO(§9.2.1): §9.2.1 specifies requireAuth -> validate -> roleGuard, but
 * every Phase 1 router (document.routes.ts, report.routes.ts, user.routes.ts)
 * registers roleGuard BEFORE validate. This module matches the existing code so
 * the codebase stays internally consistent; the discrepancy needs a
 * PROJECT-WIDE reconciliation rather than one module diverging.
 */
export const queryRouter = Router();

queryRouter.use(requireAuth);

/**
 * Ask — §2 gives the MoC Official the query interface explicitly. Asking writes
 * only the caller's own question, never subsidiary data, so all three roles may.
 *
 * aiLimiter is stricter than the global limit (§9.2 requires stricter limits
 * for AI endpoints) and is keyed on the USER, because this route always sits
 * behind requireAuth.
 */
queryRouter.post(
  '/',
  roleGuard('admin', 'cil_user', 'moc_official'),
  aiLimiter,
  validate({ body: createQuerySchema }),
  controller.ask,
);

queryRouter.get('/', validate({ query: listQueriesQuerySchema }), controller.list);

queryRouter.get('/:id', validate({ params: queryIdParamSchema }), controller.getOne);

/**
 * Review — admin or CIL user may annotate; APPROVAL is admin-only and is
 * checked in the service because it depends on the body. Same separation of
 * duties as POST /reports/:id/publish (§11.5).
 */
queryRouter.patch(
  '/:id',
  roleGuard('admin', 'cil_user'),
  validate({ params: queryIdParamSchema, body: reviewQuerySchema }),
  controller.review,
);

/**
 * Retry — instructions §4a: an explicit, authorized, rate-limitable endpoint
 * rather than a hidden internal loop. The author-or-admin check is in the
 * service and returns 403 (the resource is legitimately visible; only the
 * action is denied — §9.1).
 */
queryRouter.post(
  '/:id/retry',
  roleGuard('admin', 'cil_user', 'moc_official'),
  aiLimiter,
  validate({ params: queryIdParamSchema }),
  controller.retry,
);
