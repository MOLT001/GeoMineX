import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { sendCursorPaginated } from '../../utils/envelope.js';
import { ApiError } from '../../utils/apiError.js';
import { assertSubsidiaryAccess, isUnscoped } from '../../utils/authorization.js';
import { AuditLog, AUDIT_ACTIONS } from './auditLog.model.js';

export const auditRouter = Router();

auditRouter.use(requireAuth);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque cursor: the `_id` of the last row from the previous page. */
  cursor: objectId.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  subsidiaryId: objectId.optional(),
  userId: objectId.optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * Audit trail — PRD §4.5, §9.6.
 *
 * Cursor-paginated rather than offset-paginated (PRD §9.8): this collection
 * receives continuous inserts, and offset paging would silently skip and
 * duplicate rows as a reviewer pages through it. For a compliance audit trail
 * that is a defect, not a UX annoyance.
 */
auditRouter.get('/', validate({ query: listQuerySchema }), async (req, res, next) => {
  try {
    const user = req.user!;
    const query = validatedQuery<ListQuery>(res);

    const filter: Record<string, unknown> = {};

    // Subsidiary scoping. A non-admin sees only records for subsidiaries they
    // hold, plus their own activity — never another subsidiary's trail.
    if (isUnscoped(user.role)) {
      if (query.subsidiaryId) filter.subsidiaryId = new Types.ObjectId(query.subsidiaryId);
      if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    } else {
      if (query.subsidiaryId) assertSubsidiaryAccess(user, query.subsidiaryId);
      if (query.userId && query.userId !== user.id) {
        throw ApiError.notFound('Resource not found', {
          reason: 'audit-cross-user-denied',
          userId: user.id,
        });
      }

      const scopeIds = user.subsidiaryAccess.map((id) => new Types.ObjectId(id));
      filter.$or = [
        { subsidiaryId: query.subsidiaryId ? new Types.ObjectId(query.subsidiaryId) : { $in: scopeIds } },
        { userId: new Types.ObjectId(user.id) },
      ];
    }

    if (query.action) filter.action = query.action;
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    // Fetch one extra row to determine whether a further page exists.
    const rows = await AuditLog.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .lean();

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    sendCursorPaginated(
      res,
      page.map((r) => ({
        id: String(r._id),
        action: r.action,
        userId: r.userId ? String(r.userId) : null,
        targetType: r.targetType ?? null,
        targetId: r.targetId ? String(r.targetId) : null,
        subsidiaryId: r.subsidiaryId ? String(r.subsidiaryId) : null,
        metadata: r.metadata ?? null,
        timestamp: r.timestamp,
      })),
      {
        nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1]!._id) : null,
        limit: query.limit,
      },
    );
  } catch (err) {
    next(err);
  }
});
