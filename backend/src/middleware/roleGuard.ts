import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/apiError.js';
import type { Role } from '../modules/users/user.model.js';

/**
 * Role gate — PRD §9.1.
 *
 * Returns 403, not 404: reaching a role-gated endpoint means the caller may
 * legitimately know the route exists; only the *action* is denied. The 404
 * convention applies to cross-subsidiary resource access (see
 * utils/authorization.ts).
 */
export function roleGuard(...allowed: Role[]) {
  return function guard(req: Request, _res: Response, next: NextFunction): void {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }
    if (!allowed.includes(req.user.role)) {
      next(ApiError.forbidden('Insufficient permissions for this action'));
      return;
    }
    next();
  };
}
