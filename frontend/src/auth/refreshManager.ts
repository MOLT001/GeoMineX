import { rawFetch } from '@/lib/api/rawFetch';
import { ApiError } from '@/lib/api/errors';
import { tokenStore, type Session } from './tokenStore';
import { publishSession } from './authChannel';
import type { AuthResult } from './types';

/**
 * Refresh, deduplicated three ways. Keep this module small and stable — Fast
 * Refresh resets module state when a file changes, and the module-level
 * singletons below are the entire mechanism.
 *
 * ─── WHY DEDUPLICATION IS A SECURITY CONTROL HERE, NOT AN OPTIMISATION ──────
 * `refreshSession` in the backend has no idempotency window and no transaction:
 *
 *     const session = await Session.findOne({ tokenHash: hashToken(presented) });
 *     if (session.rotatedAt || session.revokedAt) { ...revoke the whole family }
 *
 * Two concurrent refreshes with the same cookie race between that `findOne` and
 * the subsequent `save`. The loser sees `rotatedAt` already set, reads it as
 * token theft, and revokes every session in the family — signing the user out
 * of everything. So a duplicate refresh does not waste a request; it ends the
 * session.
 *
 * Three layers, because each catches a case the others cannot:
 *
 *   1. `inFlight`  — one promise per JS context. Catches N concurrent 401s and
 *                    React StrictMode's double-invoked effects.
 *   2. Web Locks   — one refresh per ORIGIN across tabs. Catches two tabs
 *                    bootstrapping at the same moment.
 *   3. Broadcast   — see authChannel.ts. Even serialised by the lock, a second
 *                    tab refreshing again would revoke the first tab's freshly
 *                    minted token, so siblings adopt rather than refresh.
 * ────────────────────────────────────────────────────────────────────────────
 */

const LOCK_NAME = 'geominex:refresh';

/** In-flight refresh for this tab. */
let inFlight: Promise<Session> | null = null;

/**
 * Terminal flag. Once the refresh credential is definitively gone, every later
 * call fails immediately with no network request.
 *
 * Without it, a dozen queued queries each fire their own refresh after the
 * first fails — against `authLimiter`, which is 10/min, producing a 429 storm
 * on top of an already-dead session.
 */
let sessionDead = false;

export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

async function callRefresh(): Promise<Session> {
  // `credentials: 'include'` is explicit rather than relying on the
  // same-origin default, so a future origin change fails loudly here instead
  // of silently dropping the cookie and looking like a backend bug.
  const { data } = await rawFetch<AuthResult>('/auth/refresh', {
    method: 'POST',
    credentials: 'include',
  });
  const session = tokenStore.set(data.accessToken, data.user);
  publishSession(session);
  return session;
}

/**
 * Obtain a fresh session, coalescing every concurrent caller onto one request.
 *
 * Throws `SessionExpiredError` when the credential is terminally invalid, so
 * callers can distinguish "re-authenticate" from a transient failure.
 */
export function refresh(): Promise<Session> {
  if (sessionDead) return Promise.reject(new SessionExpiredError());
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // Web Locks serialises across tabs. Where it is unavailable the
      // per-context guard and the broadcast still apply; the residual risk is
      // two tabs cold-starting in the same instant.
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request(LOCK_NAME, async () => {
          // Re-check inside the lock: a sibling may have refreshed and
          // broadcast a session while we waited, making our request redundant
          // — and a redundant refresh is what revokes the family.
          if (!tokenStore.expiresWithin(0)) {
            const current = tokenStore.getSession();
            if (current) return current;
          }
          return await callRefresh();
        });
      }
      return await callRefresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        sessionDead = true;
        tokenStore.clear();
        throw new SessionExpiredError();
      }
      throw error;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Called after a successful sign-in so refresh works again. */
export function reviveSession(): void {
  sessionDead = false;
}

/** Called on sign-out; blocks any further refresh attempts. */
export function killSession(): void {
  sessionDead = true;
  inFlight = null;
  tokenStore.clear();
}

export function isSessionDead(): boolean {
  return sessionDead;
}

/**
 * Refresh ahead of expiry when the token is close to aging out.
 *
 * Used before an upload — a 401 partway through a 25 MiB file would re-send the
 * whole thing — and by the idle timer. Cheap when the token is healthy.
 */
export async function ensureFresh(marginMs = 5 * 60 * 1000): Promise<void> {
  if (sessionDead) return;
  if (tokenStore.expiresWithin(marginMs)) {
    try {
      await refresh();
    } catch {
      // Leave it to the request itself to surface the failure.
    }
  }
}
