import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/apiError.js';
import { assertSubsidiaryAccess } from '../utils/authorization.js';

/**
 * Guard a route whose subsidiary is named in the path or query — PRD §9.1.
 *
 * For resource-by-id routes prefer `findScopedOrFail`, which folds the scope
 * into the query itself rather than checking it separately.
 */
export function subsidiaryGuard(source: 'params' | 'query' = 'params', key = 'subsidiaryId') {
  return function guard(req: Request, _res: Response, next: NextFunction): void {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }

    const raw = source === 'params' ? req.params[key] : req.query[key];
    if (typeof raw !== 'string' || raw.length === 0) {
      next(ApiError.invalidRequest(`Missing ${key}`));
      return;
    }

    try {
      assertSubsidiaryAccess(req.user, raw);
      next();
    } catch (err) {
      next(err);
    }
  };
}
