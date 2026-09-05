/**
 * NoSQL operator-injection defence — PRD §9.2.
 *
 * NOTE ON THE MISSING DEPENDENCY: the blueprint names `express-mongo-sanitize`.
 * That package is unmaintained and broken on Express 5, which made `req.query`
 * a getter the middleware can no longer mutate. Rather than adopt a thinly
 * maintained fork, defence here is layered:
 *
 *   1. Mongoose `strictQuery` + `sanitizeFilter` (src/config/db.ts) — casting
 *      rejects `{ $ne: null }` against a String field before it reaches Mongo.
 *   2. Zod validation on every body/query/param (src/middleware/validate.ts) —
 *      handlers receive parsed, typed values, never raw client objects.
 *   3. This scanner, which rejects operator-shaped input outright so a probe
 *      is a 400 rather than a silently-cast no-op.
 *
 * It never mutates `req.query`; it inspects and rejects.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError, ErrorCode } from './apiError.js';

const MAX_DEPTH = 8;

function hasOperatorKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) return value.some((v) => hasOperatorKey(v, depth + 1));

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    // `$` starts a Mongo operator; `.` traverses into a nested path. Neither
    // belongs in a client-supplied key.
    if (key.startsWith('$') || key.includes('.')) return true;

    // Express 5's default query parser is `simple`, which does NOT expand
    // bracket notation into nested objects — `?action[$ne]=null` arrives as
    // the single literal key "action[$ne]". Zod would strip it harmlessly,
    // but catching it here turns a silent strip into an explicit rejection,
    // which is both clearer and a usable monitoring signal.
    if (key.includes('[$')) return true;

    if (hasOperatorKey(val, depth + 1)) return true;
  }
  return false;
}

export function rejectOperatorInjection(req: Request, _res: Response, next: NextFunction): void {
  // Must run AFTER body parsing — before it, req.body does not exist and this
  // check would silently pass everything (PRD §9.2.1).
  for (const source of [req.body, req.query, req.params]) {
    if (hasOperatorKey(source)) {
      next(
        new ApiError(ErrorCode.VALIDATION_ERROR, 'Request contains disallowed characters in a field name', {
          logContext: { reason: 'operator-injection-attempt', path: req.path },
        }),
      );
      return;
    }
  }
  next();
}
