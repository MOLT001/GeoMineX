import type { AuthUser } from './types';

/**
 * The access token, held in a module-level variable and nowhere else.
 *
 * PRD §9.13 and §13: credentials are never written to `localStorage` or
 * `sessionStorage`. A module variable dies with the tab, which is the point —
 * an XSS payload can still read it while the page is running, but nothing
 * survives to be scraped later, and no other origin or later session can reach
 * it. The refresh credential lives only in the HttpOnly cookie, which
 * JavaScript cannot read at all.
 *
 * Module scope rather than React state is load-bearing, not stylistic: the
 * fetch wrapper and the refresh manager both need the token outside any
 * component tree, and React state would not survive a Fast Refresh or be
 * readable from a plain function.
 */

interface Session {
  accessToken: string;
  user: AuthUser;
  /** Epoch ms when the access token expires, decoded from the JWT. */
  expiresAt: number;
}

let session: Session | null = null;

/** Notified whenever the session changes, so React can re-render. */
type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Read `exp` out of the JWT payload without verifying it.
 *
 * This is a scheduling hint, not a security check — the server verifies the
 * signature on every request. It exists so we can refresh proactively at ~80%
 * of the lifetime rather than waiting for a 401, which matters most for the
 * 25 MiB upload: a token expiring mid-upload would otherwise re-send the file.
 *
 * Returns a conservative fallback if the token is not a readable JWT.
 */
function readExpiry(accessToken: string): number {
  const FALLBACK_MS = 10 * 60 * 1000;
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return Date.now() + FALLBACK_MS;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims: unknown = JSON.parse(json);
    if (typeof claims === 'object' && claims !== null && 'exp' in claims) {
      const { exp } = claims;
      if (typeof exp === 'number') return exp * 1000;
    }
  } catch {
    // Malformed token: fall through. The server remains the authority.
  }
  return Date.now() + FALLBACK_MS;
}

export const tokenStore = {
  get(): string | null {
    return session?.accessToken ?? null;
  },

  getUser(): AuthUser | null {
    return session?.user ?? null;
  },

  getSession(): Session | null {
    return session;
  },

  set(accessToken: string, user: AuthUser): Session {
    session = { accessToken, user, expiresAt: readExpiry(accessToken) };
    emit();
    return session;
  },

  /** Adopt a session broadcast by a sibling tab (already has its expiry). */
  adopt(next: Session): void {
    session = next;
    emit();
  },

  clear(): void {
    session = null;
    emit();
  },

  /** True when the token is gone or within `withinMs` of expiring. */
  expiresWithin(withinMs: number): boolean {
    if (!session) return true;
    return session.expiresAt - Date.now() <= withinMs;
  },

  /**
   * Arrow property, not a shorthand method: `useSyncExternalStore` receives
   * this detached from the object, so a method would lose its `this` binding
   * and needs a stable identity across renders to avoid resubscribing.
   */
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export type { Session };
