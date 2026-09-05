import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/requireAuth.js';
import { roleGuard } from '../../middleware/roleGuard.js';
import { validate } from '../../middleware/validate.js';
import { sendCreated, sendData } from '../../utils/envelope.js';
import { ApiError } from '../../utils/apiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { isUnscoped } from '../../utils/authorization.js';
import { Subsidiary } from './subsidiary.model.js';

export const subsidiaryRouter = Router();

subsidiaryRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  code: z.string().min(2).max(16).trim().toUpperCase(),
});

/**
 * List subsidiaries.
 *
 * Scoped, not global: a CIL user sees only the subsidiaries they hold grants
 * for. Returning the full list would leak the organisational structure to
 * every authenticated user (PRD §9.1).
 */
subsidiaryRouter.get('/', async (req, res, next) => {
  try {
    const user = req.user!;
    const filter: Record<string, unknown> = { isDeleted: false };

    if (!isUnscoped(user.role)) {
      filter._id = { $in: user.subsidiaryAccess.map((id) => new Types.ObjectId(id)) };
    }

    const subsidiaries = await Subsidiary.find(filter).sort({ code: 1 }).lean();
    sendData(
      res,
      subsidiaries.map((s) => ({ id: String(s._id), name: s.name, code: s.code })),
    );
  } catch (err) {
    next(err);
  }
});

subsidiaryRouter.post('/', roleGuard('admin'), validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { name, code } = req.body as z.infer<typeof createSchema>;

    const existing = await Subsidiary.findOne({ code, isDeleted: false });
    if (existing) throw ApiError.conflict('A subsidiary with that code already exists');

    const subsidiary = await Subsidiary.create({ name, code });

    await recordAudit({
      action: 'subsidiary.created',
      userId: req.user!.id,
      targetType: 'Subsidiary',
      targetId: String(subsidiary._id),
      subsidiaryId: String(subsidiary._id),
      ipAddress: req.ip,
    });

    sendCreated(res, { id: String(subsidiary._id), name: subsidiary.name, code: subsidiary.code });
  } catch (err) {
    next(err);
  }
});
