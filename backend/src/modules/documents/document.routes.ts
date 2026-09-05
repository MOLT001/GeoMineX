import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { roleGuard } from '../../middleware/roleGuard.js';
import { validate } from '../../middleware/validate.js';
import { uploadSingleDocument } from '../../middleware/upload.js';
import * as controller from './document.controller.js';
import {
  documentIdParamSchema,
  listDocumentsQuerySchema,
  overrideFieldSchema,
  uploadBodySchema,
} from './document.schema.js';

export const documentRouter = Router();

documentRouter.use(requireAuth);

/**
 * Upload — PRD §4.1, §9.4.
 *
 * MoC officials are read-only across subsidiaries (§2), so uploading is
 * limited to Admin and CIL User. `uploadSingleDocument` runs before `validate`
 * because multipart fields do not exist on req.body until multer has parsed
 * the request.
 */
documentRouter.post(
  '/',
  roleGuard('admin', 'cil_user'),
  uploadSingleDocument,
  validate({ body: uploadBodySchema }),
  controller.upload,
);

documentRouter.get('/', validate({ query: listDocumentsQuerySchema }), controller.list);

documentRouter.get('/:id', validate({ params: documentIdParamSchema }), controller.getOne);

/** The most security-sensitive route in the system — see the service. */
documentRouter.get('/:id/file', validate({ params: documentIdParamSchema }), controller.download);

documentRouter.get('/:id/chunks', validate({ params: documentIdParamSchema }), controller.chunks);

documentRouter.get(
  '/:id/extracted-fields',
  validate({ params: documentIdParamSchema }),
  controller.extractedFields,
);

documentRouter.post(
  '/:id/retry',
  roleGuard('admin', 'cil_user'),
  validate({ params: documentIdParamSchema }),
  controller.retry,
);

/**
 * Manual field override — PRD §4.5, §10.2.
 *
 * Mounted separately at /extracted-fields/:id, matching the endpoint family
 * the PRD specifies. Read-only MoC officials cannot override figures.
 */
export const extractedFieldRouter = Router();

extractedFieldRouter.use(requireAuth);

extractedFieldRouter.patch(
  '/:id',
  roleGuard('admin', 'cil_user'),
  validate({ params: documentIdParamSchema, body: overrideFieldSchema }),
  controller.overrideField,
);
