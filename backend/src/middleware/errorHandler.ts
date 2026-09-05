import type { Request, Response, NextFunction } from 'express';
import { ApiError, ErrorCode } from '../utils/apiError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/** 404 for unmatched routes, in the standard envelope. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: ErrorCode.NOT_FOUND, message: `Route not found: ${req.method} ${req.path}` },
  });
}

/**
 * Central error handler — PRD §9.2. Always registered last; registered before
 * the routes it would never fire.
 *
 * Production responses carry no stack trace or internal detail. An ApiError's
 * `logContext` is written to the log and never to the response, which is what
 * lets a cross-subsidiary denial be recorded accurately while the caller only
 * ever sees a flat 404.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      logger.error('Request failed', { code: err.code, message: err.message, path: req.path, ...err.logContext });
    } else {
      logger.warn('Request rejected', {
        code: err.code,
        path: req.path,
        method: req.method,
        userId: req.user?.id,
        ...err.logContext,
      });
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
      },
    });
    return;
  }

  // Duplicate key on a unique index — surfaces as a conflict, not a 500.
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    logger.warn('Duplicate key', { path: req.path });
    res.status(409).json({
      success: false,
      error: { code: ErrorCode.CONFLICT, message: 'Resource already exists' },
    });
    return;
  }

  // body-parser rejections carry their own `type` and status. Without this
  // they fall through to a 500, and the §9.2 body-size limit reports itself
  // as a server fault rather than a rejected request.
  const bodyParserType = (err as { type?: string }).type;
  if (bodyParserType === 'entity.too.large') {
    logger.warn('Request body exceeded the size limit', { path: req.path });
    res.status(413).json({
      success: false,
      error: { code: ErrorCode.PAYLOAD_TOO_LARGE, message: 'Request body is too large' },
    });
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      success: false,
      error: { code: ErrorCode.VALIDATION_ERROR, message: 'Malformed JSON body' },
    });
    return;
  }

  logger.error('Unhandled error', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error && !env.isProduction ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' },
  });
}
