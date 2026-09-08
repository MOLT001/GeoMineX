import { API_PREFIX } from '@/lib/env';
import { ApiError, NetworkError, type ApiErrorBody } from './errors';

/**
 * The unauthenticated transport. PRD §10.5 calls this `refreshClient` — the
 * instance with NO interceptors — and its whole job is to be the thing the
 * refresh call uses.
 *
 * Keeping it a separate exported function rather than a configured instance is
 * deliberate: with an instance, sharing an interceptor with the authenticated
 * client is one careless import away, and the resulting failure is an infinite
 * refresh loop that only shows up under load. A plain function has nothing to
 * share.
 *
 * Nothing here retries, refreshes, or reads the token store.
 */

interface RawOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Send cookies. Required for the auth routes; harmless elsewhere. */
  credentials?: RequestCredentials;
}

/** Success envelope: `{ success: true, data, pagination? }`. */
export interface Envelope<T> {
  data: T;
  pagination?: OffsetPagination | CursorPagination;
}

export interface OffsetPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Cursor envelope. Note the ABSENCE of `total` — the backend omits it on
 * purpose for append-heavy collections (`backend/src/utils/envelope.ts`), so
 * these lists load incrementally and can never render page numbers.
 */
export interface CursorPagination {
  nextCursor: string | null;
  limit: number;
}

export function isCursorPagination(
  p: OffsetPagination | CursorPagination | undefined,
): p is CursorPagination {
  return !!p && 'nextCursor' in p;
}

export async function rawFetch<T>(path: string, options: RawOptions = {}): Promise<Envelope<T>> {
  const { method = 'GET', body, headers = {}, signal, credentials = 'same-origin' } = options;

  const init: RequestInit = { method, credentials, headers: { ...headers } };
  if (signal) init.signal = signal;

  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    // A RELATIVE path, always. §11.9 is a same-site deployment: the browser
    // must reach the API through the Next rewrite on this origin, or the
    // SameSite=Strict refresh cookie is not attached and sign-in breaks.
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError('Request failed', { cause });
  }

  // The API never uses 204 — an empty success still returns the envelope
  // (§10.3) — so a body is always expected. A response that is NOT the envelope
  // did not come from the API at all: it came from the Next rewrite, which
  // answers with its own plain-text 5xx when it cannot reach Express. Flagging
  // that separately is what lets the UI say "the server is still starting"
  // instead of sending someone to check their wifi.
  const upstreamDown = response.status >= 500;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new NetworkError(`Unreadable response (HTTP ${response.status})`, { cause, upstreamDown });
  }

  if (!isEnvelope(payload)) {
    throw new NetworkError(`Unexpected response shape (HTTP ${response.status})`, { upstreamDown });
  }

  if (!payload.success) {
    throw new ApiError(response.status, payload.error);
  }

  const result: Envelope<T> = { data: payload.data as T };
  if (payload.pagination) result.pagination = payload.pagination;
  return result;
}

type RawEnvelope =
  | { success: true; data: unknown; pagination?: OffsetPagination | CursorPagination }
  | { success: false; error: ApiErrorBody };

function isEnvelope(value: unknown): value is RawEnvelope {
  if (typeof value !== 'object' || value === null || !('success' in value)) return false;
  const v = value as { success: unknown; error?: unknown };
  if (v.success === true) return true;
  return (
    v.success === false &&
    typeof v.error === 'object' &&
    v.error !== null &&
    'code' in v.error &&
    'message' in v.error
  );
}
