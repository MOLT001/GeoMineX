import type { Request, Response, NextFunction } from 'express';
import { z, type ZodType } from 'zod';
import { ApiError, ErrorCode } from '../utils/apiError.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Zod validation on body, query and params — PRD §9.2.
 *
 * Parsed output replaces `req.body`/`req.params` so handlers work with typed,
 * stripped values rather than raw client objects. Express 5 makes `req.query`
 * a getter, so validated query values are exposed on `res.locals.query`
 * instead of being written back.
 */
export function validate(schemas: ValidationSchemas) {
  return function validator(req: Request, res: Response, next: NextFunction): void {
    const fields: Record<string, string[]> = {};

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) collect(result.error, fields, 'params');
      else req.params = result.data as typeof req.params;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) collect(result.error, fields, 'query');
      else res.locals.query = result.data;
    }

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) collect(result.error, fields, 'body');
      else req.body = result.data;
    }

    if (Object.keys(fields).length > 0) {
      next(new ApiError(ErrorCode.VALIDATION_ERROR, 'Validation failed', { fields }));
      return;
    }
    next();
  };
}

function collect(error: z.ZodError, target: Record<string, string[]>, prefix: string): void {
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : prefix;
    (target[path] ??= []).push(issue.message);
  }
}

/** Typed accessor for query values parsed by `validate`. */
export function validatedQuery<T>(res: Response): T {
  return res.locals.query as T;
}
