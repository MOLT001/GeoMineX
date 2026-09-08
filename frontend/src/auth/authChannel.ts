import { tokenStore, type Session } from './tokenStore';

/**
 * Cross-tab session sharing.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Verified in `backend/src/modules/auth/auth.service.ts`: a SUCCESSFUL refresh
 * marks the presented session `rotatedAt` AND `revokedAt`, then issues a brand
 * new session document with a new `_id`. Access tokens embed that id as `sid`,
 * and `requireAuth` rejects a revoked session with TOKEN_INVALID.
 *
 * So every successful refresh instantly invalidates every access token minted
 * earlier in that family. With one tab that is invisible — the refresh returns
 * the replacement. With three tabs, each holding its own module-level token,
 * tab B's routine 15-minute refresh silently kills tab A's token. Left
 * unhandled the app is single-tab-only, and nobody notices until real use,
 * because developers test one tab.
 *
 * The fix is for whichever tab refreshes to publish the new credential so its
 * siblings ADOPT it instead of each refreshing in turn (which would revoke each
 * other in a loop).
 *
 * The token stays in memory in each tab and is never persisted — BroadcastChannel
 * is same-origin, in-memory, and not written to disk, so §9.13 holds.
 * ────────────────────────────────────────────────────────────────────────────
 */

const CHANNEL = 'geominex:auth';

type Message =
  | { type: 'session'; session: Session }
  | { type: 'logged-out' };

let channel: BroadcastChannel | null = null;

function get(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

/** Tell sibling tabs about a freshly rotated session so they stop using the dead one. */
export function publishSession(session: Session): void {
  get()?.postMessage({ type: 'session', session } satisfies Message);
}

/**
 * Tell sibling tabs the session is over.
 *
 * Needed because `POST /auth/logout` revokes the session matching the cookie —
 * which, after any refresh, is the one every tab is now sharing. Without this
 * the other tabs keep a token that the next request will reject.
 */
export function publishLogout(): void {
  get()?.postMessage({ type: 'logged-out' } satisfies Message);
}

/**
 * Start listening. Returns an unsubscribe function.
 *
 * `onLogout` lets the provider react (clear caches, redirect) rather than
 * leaving other tabs sitting on a dead session until their next request.
 */
export function listen(onLogout: () => void): () => void {
  const ch = get();
  if (!ch) return () => undefined;

  const handler = (event: MessageEvent<Message>) => {
    const msg = event.data;
    if (msg.type === 'session') {
      tokenStore.adopt(msg.session);
    } else {
      tokenStore.clear();
      onLogout();
    }
  };

  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}
