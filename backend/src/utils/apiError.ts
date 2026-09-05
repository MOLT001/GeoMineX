/**
 * Standard error codes — PRD §9.8.
 *
 * `NOT_FOUND` doubles as the response for an authorized-but-out-of-scope
 * resource: PRD §9.1 requires 404 rather than 403 so an unauthorized caller
 * is never told that a resource exists in another subsidiary. `FORBIDDEN` is
 * reserved for a resource the caller may legitimately see, where the *action*
 * is not permitted.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  CANNOT_SELF_DEMOTE: 'CANNOT_SELF_DEMOTE',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  CONFIRM_TEXT_MISMATCH: 'CONFIRM_TEXT_MISMATCH',
  /** Beyond the PRD §9.8 minimum set: the body-size limit in §9.2 needs a code. */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCodeValue, number> = {
  VALIDATION_ERROR: 400,
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  REFRESH_TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  CANNOT_SELF_DEMOTE: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFIRM_TEXT_MISMATCH: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeValue;
  public readonly fields?: Record<string, string[]>;
  /** Detail for the server log only — never serialized to the client. */
  public readonly logContext?: Record<string, unknown>;

  constructor(
    code: ErrorCodeValue,
    message: string,
    options?: { fields?: Record<string, string[]>; logContext?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    if (options?.fields) this.fields = options.fields;
    if (options?.logContext) this.logContext = options.logContext;
    Error.captureStackTrace?.(this, ApiError);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(ErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(message = 'Insufficient permissions'): ApiError {
    return new ApiError(ErrorCode.FORBIDDEN, message);
  }

  /**
   * The generic not-found used for both "no such resource" and "outside your
   * subsidiary/role scope" (PRD §9.1). Pass `logContext` to record what
   * actually happened without leaking it to the caller.
   */
  static notFound(message = 'Resource not found', logContext?: Record<string, unknown>): ApiError {
    return new ApiError(ErrorCode.NOT_FOUND, message, logContext ? { logContext } : undefined);
  }

  static conflict(message: string): ApiError {
    return new ApiError(ErrorCode.CONFLICT, message);
  }

  static invalidRequest(message: string): ApiError {
    return new ApiError(ErrorCode.INVALID_REQUEST, message);
  }
}
