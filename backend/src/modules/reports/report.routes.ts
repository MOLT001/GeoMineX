import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { roleGuard } from '../../middleware/roleGuard.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { sendCreated, sendData, sendPaginated } from '../../utils/envelope.js';
import * as service from './report.service.js';
import {
  archiveReportSchema,
  createReportSchema,
  createTemplateSchema,
  listReportsQuerySchema,
  reportIdParamSchema,
  updateReportSchema,
  type CreateReportInput,
  type CreateTemplateInput,
  type ListReportsQuery,
  type UpdateReportInput,
} from './report.schema.js';

const actor = (req: { ip?: string }) => ({ ipAddress: req.ip });

// ── Templates ───────────────────────────────────────────────────────────────
export const reportTemplateRouter = Router();
reportTemplateRouter.use(requireAuth);

reportTemplateRouter.get('/', async (req, res, next) => {
  try {
    sendData(res, await service.listTemplates(req.user!));
  } catch (err) {
    next(err);
  }
});

reportTemplateRouter.post(
  '/',
  roleGuard('admin'),
  validate({ body: createTemplateSchema }),
  async (req, res, next) => {
    try {
      sendCreated(res, await service.createTemplate(req.body as CreateTemplateInput, req.user!, actor(req)));
    } catch (err) {
      next(err);
    }
  },
);

// ── Reports ─────────────────────────────────────────────────────────────────
export const reportRouter = Router();
reportRouter.use(requireAuth);

reportRouter.get('/', validate({ query: listReportsQuerySchema }), async (req, res, next) => {
  try {
    const result = await service.listReports(validatedQuery<ListReportsQuery>(res), req.user!);
    sendPaginated(res, result.data, result.pagination);
  } catch (err) {
    next(err);
  }
});

/** Drafting is a write, so MoC officials (read-only, §2) are excluded. */
reportRouter.post(
  '/',
  roleGuard('admin', 'cil_user'),
  validate({ body: createReportSchema }),
  async (req, res, next) => {
    try {
      sendCreated(res, await service.createReport(req.body as CreateReportInput, req.user!, actor(req)));
    } catch (err) {
      next(err);
    }
  },
);

reportRouter.get('/:id', validate({ params: reportIdParamSchema }), async (req, res, next) => {
  try {
    sendData(res, await service.getReport(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
});

reportRouter.get('/:id/versions', validate({ params: reportIdParamSchema }), async (req, res, next) => {
  try {
    sendData(res, await service.getVersions(req.params.id as string, req.user!));
  } catch (err) {
    next(err);
  }
});

reportRouter.patch(
  '/:id',
  roleGuard('admin', 'cil_user'),
  validate({ params: reportIdParamSchema, body: updateReportSchema }),
  async (req, res, next) => {
    try {
      sendData(res, await service.updateReport(req.params.id as string, req.body as UpdateReportInput, req.user!, actor(req)));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Publish — Admin only (§11.5 decision).
 *
 * Deliberately not open to CIL Users: it keeps the person drafting a figure
 * separate from the person putting it on record, in a system whose output
 * feeds parliamentary answers.
 */
reportRouter.post(
  '/:id/publish',
  roleGuard('admin'),
  validate({ params: reportIdParamSchema }),
  async (req, res, next) => {
    try {
      sendData(res, await service.publishReport(req.params.id as string, req.user!, actor(req)));
    } catch (err) {
      next(err);
    }
  },
);

reportRouter.post(
  '/:id/archive',
  roleGuard('admin'),
  validate({ params: reportIdParamSchema, body: archiveReportSchema }),
  async (req, res, next) => {
    try {
      const { confirm } = req.body as { confirm: string };
      sendData(res, await service.archiveReport(req.params.id as string, confirm, req.user!, actor(req)));
    } catch (err) {
      next(err);
    }
  },
);
