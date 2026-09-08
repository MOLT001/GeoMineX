/**
 * The API's error contract, mirrored from `backend/src/utils/apiError.ts`.
 *
 * Kept as a hand-written mirror rather than a shared package because the two
 * halves deploy independently; if the backend adds a code, `ApiError.code`
 * still carries it through as a string and only the exhaustive `switch` in the
 * client needs revisiting.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'FORBIDDEN',
  'CANNOT_SELF_DEMOTE',
  'NOT_FOUND',
  'CONFLICT',
  'CONFIRM_TEXT_MISMATCH',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Zod-style field errors, keyed by dotted path (`body.email`). */
export type FieldErrors = Record<string, string[]>;

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: FieldErrors;
}

/** `{ success: false, error: {...} }` — the only error shape the API emits. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: FieldErrors | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.status = status;
    this.fields = body.fields;
  }

  is(code: ErrorCode): boolean {
    return this.code === code;
  }
}

/**
 * Raised when the network itself fails, or the response is not the envelope —
 * distinct from ApiError, which means the API answered and said no.
 *
 * `upstreamDown` separates two failures that look identical to the browser but
 * mean different things to the person reading the message:
 *
 *   false — the request never left, or the connection dropped. Genuinely a
 *           "check your connection" situation.
 *   true  — the Next rewrite answered, but could not reach the Express API and
 *           returned its own non-envelope 5xx. The user's connection is fine;
 *           the API is down or still booting.
 *
 * The distinction earns its keep in development, where `npm run dev` starts both
 * services at once: Next serves in about two seconds while the API spends
 * roughly twenty connecting to Atlas. For that whole window the login page is
 * fully usable and every request fails, and "check your connection" sends
 * someone hunting a network problem that does not exist.
 */
export class NetworkError extends Error {
  readonly upstreamDown: boolean;

  constructor(message: string, options?: { cause?: unknown; upstreamDown?: boolean }) {
    super(message, options);
    this.name = 'NetworkError';
    this.upstreamDown = options?.upstreamDown ?? false;
  }
}

/**
 * The four 401s, and why they are not interchangeable.
 *
 * Getting this wrong is the difference between an app that works and one that
 * signs people out constantly, so each is spelled out:
 *
 *   UNAUTHORIZED           No Authorization header reached the server. In
 *                          practice: a request that raced ahead of the
 *                          bootstrap refresh on a cold load. Wait for
 *                          bootstrap, retry once. NEVER a logout.
 *
 *   TOKEN_EXPIRED          The 15-minute access token aged out. Refresh once,
 *                          retry once. Routine.
 *
 *   TOKEN_INVALID          Emitted for three different situations: a bad
 *                          signature, a deactivated user, and a REVOKED
 *                          SESSION. The third is common and usually benign —
 *                          refresh rotation revokes the previous session
 *                          document, so a sibling tab's perfectly legitimate
 *                          refresh invalidates this tab's token. Treating it as
 *                          terminal makes the app single-tab-only. Attempt one
 *                          recovery refresh; log out only if that also fails.
 *
 *   REFRESH_TOKEN_INVALID  The refresh credential itself is gone, rotated, or
 *                          the family was revoked by reuse detection. Genuinely
 *                          terminal — re-authenticate.
 */
export type AuthFailureKind = 'not-ready' | 'refresh' | 'recover' | 'terminal';

export function classifyAuthFailure(code: string): AuthFailureKind | null {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'not-ready';
    case 'TOKEN_EXPIRED':
      return 'refresh';
    case 'TOKEN_INVALID':
      return 'recover';
    case 'REFRESH_TOKEN_INVALID':
      return 'terminal';
    default:
      return null;
  }
}

/**
 * Message shown for a 404.
 *
 * The API returns 404 both for "does not exist" and for "exists, but in a
 * subsidiary you do not hold" — deliberately indistinguishable
 * (`backend/src/utils/authorization.ts`). The UI must not undo that: a message
 * like "you don't have access to BCCL" reconstructs precisely the
 * resource-existence oracle the 404 convention exists to hide.
 *
 * 403 is different and may be explicit — it means the resource IS visible to
 * you but the action is not permitted.
 */
export const NOT_FOUND_MESSAGE = 'Not found.';

export function userMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NOT_FOUND') return NOT_FOUND_MESSAGE;
    if (error.code === 'INTERNAL_ERROR') return 'Something went wrong. Please try again.';
    return error.message;
  }
  if (error instanceof NetworkError) {
    return error.upstreamDown
      ? 'The server is not responding yet. If the app was just started, give it a few seconds and try again.'
      : 'Could not reach the server. Check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}
