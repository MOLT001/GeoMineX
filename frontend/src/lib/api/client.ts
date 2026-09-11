import { tokenStore } from '@/auth/tokenStore';
import { refresh, SessionExpiredError, isSessionDead } from '@/auth/refreshManager';
import { bootstrapPromise } from '@/auth/bootstrap';
import { ApiError, classifyAuthFailure } from './errors';
import { rawFetch, type Envelope } from './rawFetch';

/**
 * The authenticated transport — PRD §10.5's `client`, the one with the
 * interceptor behaviour.
 *
 * Built on `fetch` rather than Axios deliberately. TanStack Query already owns
 * caching, deduplication and retry, so Axios's remaining contribution here
 * would be the ~40 lines below; and an Axios response interceptor that retries
 * on 401 is a second, invisible retry layer underneath Query's own, which is
 * how one stale token turns into three refresh attempts and a revoked session
 * family.
 */

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /**
   * An array value becomes a REPEATED parameter (`?topic=a&topic=b`), which is
   * the form Express and Zod both read back as an array. Comma-joining would
   * arrive as one string containing a comma and fail validation.
   */
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  signal?: AbortSignal | undefined;
  /** Set for the auth routes, whose credential is the cookie. */
  credentials?: RequestCredentials;
}

function buildPath(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      // `append`, so every element gets its own occurrence of the key. An empty
      // array contributes nothing, which is the same as not filtering.
      for (const item of value) if (item !== '') params.append(key, item);
      continue;
    }
    // Boolean filters cross the wire as the STRINGS 'true'/'false' — the
    // backend schemas declare them as string enums, not booleans, so a real
    // boolean is coerced to a string that happens to match. Being explicit
    // keeps that from looking accidental.
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * One request, with at most one recovery attempt.
 *
 * The retry budget is exactly one, tracked per call rather than globally: a
 * second 401 after a successful refresh means something is genuinely wrong, and
 * refreshing again would just feed the rate limiter.
 *
 * `send` is invoked at most twice and must read the token itself on each call,
 * so the retry carries whatever the refresh just minted. Every authenticated
 * path in the app goes through here — the JSON transport below and the blob
 * download at the foot of this file — because a second, hand-rolled copy of
 * this ladder is exactly the thing that drifts and starts signing people out.
 */
async function withAuthRetry<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;

    const kind = classifyAuthFailure(error.code);

    switch (kind) {
      /**
       * No Authorization header reached the server — this request raced ahead
       * of the cold-start refresh. Wait for bootstrap and retry. Emphatically
       * not a logout: treating it as one signs people out on every cold load
       * where a query fires before the session lands.
       */
      case 'not-ready': {
        await bootstrapPromise;
        if (!tokenStore.get()) throw error;
        return await send();
      }

      /** Routine 15-minute expiry. */
      case 'refresh': {
        await refresh();
        return await send();
      }

      /**
       * TOKEN_INVALID. Usually NOT a security event: refresh rotation revokes
       * the previous session document, so a sibling tab's legitimate refresh
       * invalidates this tab's token and the server reports it here. One
       * recovery refresh distinguishes that from a genuinely dead session.
       */
      case 'recover': {
        if (isSessionDead()) throw error;
        try {
          await refresh();
        } catch {
          throw error;
        }
        return await send();
      }

      /** The refresh credential itself is gone. Re-authenticate. */
      case 'terminal':
        throw new SessionExpiredError();

      default:
        throw error;
    }
  }
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { method = 'GET', body, query, signal, credentials } = options;
  const url = buildPath(path, query);

  return await withAuthRetry(() => {
    const token = tokenStore.get();
    return rawFetch<T>(url, {
      method,
      body,
      signal,
      ...(credentials ? { credentials } : {}),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  });
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'PATCH', body }),

  /**
   * DELETE accepts a body, and one endpoint requires it:
   * `DELETE /users/:id/subsidiary-access/:subsidiaryId` expects
   * `{ confirm: <SUBSIDIARY CODE> }`. Unusual, but `fetch` handles it.
   */
  delete: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'DELETE', body }),
};

/**
 * Fetch a stored document as a Blob.
 *
 * `GET /documents/:id/file` cannot be rendered with `<iframe src>` or `<embed>`:
 * it requires a bearer header that the browser will not attach to a subresource
 * load, and it sets `Content-Disposition: attachment`. So previews go
 * fetch → Blob → object URL → canvas, which is what `img-src blob:` and
 * `worker-src blob:` in the CSP are for.
 *
 * Bare `fetch` rather than `rawFetch` because success here is BYTES, not the
 * JSON envelope — only the failure path is an envelope. The 401 handling is not
 * optional for that reason: without `withAuthRetry` a preview or download begun
 * with a token that has just aged out fails outright, while every other request
 * in the app recovers silently.
 *
 * Callers MUST revoke the returned object URL on unmount, or the blob is
 * retained for the life of the document.
 */
export async function fetchDocumentBlob(documentId: string, signal?: AbortSignal): Promise<Blob> {
  return await withAuthRetry(async () => {
    const token = tokenStore.get();
    const response = await fetch(`/api/v1/documents/${documentId}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError(response.status, {
          code: 'INTERNAL_ERROR',
          message: 'Could not download the document.',
        });
      }
      const err = body as { error?: { code: string; message: string } };
      throw new ApiError(
        response.status,
        err.error ?? { code: 'INTERNAL_ERROR', message: 'Could not download the document.' },
      );
    }

    return await response.blob();
  });
}
