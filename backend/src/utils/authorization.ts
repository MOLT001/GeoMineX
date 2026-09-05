/**
 * Subsidiary-scoped authorization — PRD §9.1.
 *
 * This replaces the blueprint's `assertOwnership` helper, which assumes
 * single-tenant per-user ownership. GeoMineX is multi-tenant per *subsidiary*
 * with cross-tenant reviewer roles, so per-user ownership would be both too
 * strict (it blocks MoC reviewers) and too loose (a CIL user could reach a
 * colleague's subsidiary data).
 *
 * Two rules hold throughout:
 *
 *   1. A client-supplied `subsidiaryId` is never trusted on its own. It is
 *      intersected with the caller's grants before it reaches a query.
 *   2. Out-of-scope reads return 404, never 403, so an unauthorized caller is
 *      never told a resource exists in another subsidiary. 403 is reserved for
 *      a resource the caller may legitimately see where the *action* is not
 *      permitted.
 */
// Mongoose 9 renamed FilterQuery to QueryFilter.
import type { HydratedDocument, Model, QueryFilter } from 'mongoose';
import { Types } from 'mongoose';
import { ApiError } from './apiError.js';
import type { Role } from '../modules/users/user.model.js';

export interface AuthContext {
  id: string;
  role: Role;
  sessionId: string;
  subsidiaryAccess: string[];
}

/** Admin is unscoped; every other role is confined to its explicit grants. */
export function isUnscoped(role: Role): boolean {
  return role === 'admin';
}

export function canAccessSubsidiary(user: AuthContext, subsidiaryId: string): boolean {
  if (isUnscoped(user.role)) return true;
  return user.subsidiaryAccess.includes(subsidiaryId);
}

/**
 * Assert access to a named subsidiary. Throws 404 rather than 403 — see the
 * file header.
 */
export function assertSubsidiaryAccess(user: AuthContext, subsidiaryId: string): void {
  if (!canAccessSubsidiary(user, subsidiaryId)) {
    throw ApiError.notFound('Resource not found', {
      reason: 'cross-subsidiary-denied',
      userId: user.id,
      requestedSubsidiaryId: subsidiaryId,
    });
  }
}

/**
 * Build the subsidiary clause to merge into a Mongo filter.
 *
 * Returns `{}` for Admin (unscoped), a pinned id when the caller asked for one
 * they hold, or an `$in` over all their grants. A non-admin with no grants
 * gets a filter that matches nothing — never an unfiltered query.
 */
export function subsidiaryScopeFilter(
  user: AuthContext,
  requestedSubsidiaryId?: string,
): Record<string, unknown> {
  if (isUnscoped(user.role)) {
    return requestedSubsidiaryId ? { subsidiaryId: new Types.ObjectId(requestedSubsidiaryId) } : {};
  }

  if (requestedSubsidiaryId) {
    // Validate the client's choice against the caller's grants before use.
    assertSubsidiaryAccess(user, requestedSubsidiaryId);
    return { subsidiaryId: new Types.ObjectId(requestedSubsidiaryId) };
  }

  return {
    subsidiaryId: { $in: user.subsidiaryAccess.map((id) => new Types.ObjectId(id)) },
  };
}

/**
 * Fetch a subsidiary-scoped resource by id, or throw 404.
 *
 * The scope is applied inside the query rather than checked after the fetch,
 * so an out-of-scope document is never loaded into memory in the first place.
 */
export async function findScopedOrFail<T>(
  model: Model<T>,
  resourceId: string,
  user: AuthContext,
  extraFilter: QueryFilter<T> = {},
): Promise<HydratedDocument<T>> {
  if (!Types.ObjectId.isValid(resourceId)) {
    // An unparseable id is indistinguishable from a missing one, as far as the
    // caller is concerned.
    throw ApiError.notFound();
  }

  const filter = {
    _id: new Types.ObjectId(resourceId),
    isDeleted: false, // Soft-deleted records are excluded from normal reads (PRD §8.3).
    ...subsidiaryScopeFilter(user),
    ...extraFilter,
  } as QueryFilter<T>;

  const doc = await model.findOne(filter);
  if (!doc) {
    throw ApiError.notFound('Resource not found', {
      reason: 'not-found-or-out-of-scope',
      userId: user.id,
      resourceId,
      model: model.modelName,
    });
  }
  return doc as HydratedDocument<T>;
}
