import { refresh } from './refreshManager';
import type { Session } from './tokenStore';

/**
 * Restore the session on page load.
 *
 * A reload wipes the in-memory access token, but the HttpOnly refresh cookie
 * survives — so every cold start begins with one refresh to find out whether
 * anyone is signed in.
 *
 * ─── WHY THIS IS A MODULE-SCOPE PROMISE AND NOT A useEffect ─────────────────
 * React StrictMode double-invokes effects in development. A `useRef` guard
 * inside a provider is per-component-instance and does not stop the second
 * call, so both fire, and two concurrent refreshes with the same cookie race
 * inside the backend's `refreshSession` — the loser reads the already-rotated
 * token as theft and revokes the whole family. The symptom is "development
 * signs me out immediately, production is fine", which is a miserable thing to
 * debug.
 *
 * Evaluating the promise once at module load makes a second invocation
 * impossible rather than merely unlikely, and it starts the request during
 * hydration instead of after first paint.
 *
 * The rejection is swallowed to `null` because "no valid session" is the normal
 * unauthenticated case, not an error: a logged-out visitor opening the home
 * page must not see a console error, and nothing should redirect from here.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const bootstrapPromise: Promise<Session | null> =
  typeof window === 'undefined' ? Promise.resolve(null) : refresh().catch(() => null);
