'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { purgeQueryCache } from '@/lib/queryClient';
import { tokenStore } from './tokenStore';
import { bootstrapPromise } from './bootstrap';
import { ensureFresh, killSession, reviveSession } from './refreshManager';
import { listen, publishLogout } from './authChannel';
import type { AuthResult, AuthUser } from './types';

type Status = 'bootstrapping' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: AuthUser | null;
  /** Adopt the session returned by verify-code or invite-accept. */
  signIn: (result: AuthResult) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Proactive refresh at ~80% of the 15-minute access-token lifetime. */
const REFRESH_MARGIN_MS = 3 * 60 * 1000;
const REFRESH_TICK_MS = 60 * 1000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);

  /**
   * The token lives in a module singleton, not React state, so this subscribes
   * to it. `useSyncExternalStore` is the correct primitive — it keeps React's
   * rendering consistent with an external mutable source and avoids the tearing
   * a `useState` mirror would introduce when a sibling tab adopts a session.
   */
  const user = useSyncExternalStore(
    tokenStore.subscribe,
    () => tokenStore.getUser(),
    () => null, // server snapshot: nothing is authenticated during SSR
  );

  // Resolve the module-scope bootstrap. Because the promise is created once at
  // module load, StrictMode's double-invoked effect awaits the SAME promise
  // rather than starting a second refresh — which would race the first inside
  // the backend and revoke the session family.
  useEffect(() => {
    let cancelled = false;
    void bootstrapPromise.finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRemoteLogout = useCallback(() => {
    void purgeQueryCache(queryClient).finally(() => {
      window.location.replace('/login');
    });
  }, [queryClient]);

  // A sibling tab either rotated the session (adopt it) or signed out (follow).
  useEffect(() => listen(handleRemoteLogout), [handleRemoteLogout]);

  /**
   * Keep the token ahead of expiry while the tab is visible.
   *
   * Gated on visibility so background tabs do not each burn `authLimiter`
   * quota (10/min), and skipped entirely when hidden — a hidden tab has no
   * requests to protect.
   */
  useEffect(() => {
    if (!user) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void ensureFresh(REFRESH_MARGIN_MS);
    };
    const timer = window.setInterval(tick, REFRESH_TICK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [user]);

  const signIn = useCallback((result: AuthResult) => {
    reviveSession();
    tokenStore.set(result.accessToken, result.user);
  }, []);

  /**
   * Sign out with a HARD navigation, not `router.replace`.
   *
   * Clearing the query cache is necessary but not sufficient: it does not touch
   * component-local state (a half-typed report draft), does not defeat bfcache
   * — pressing Back can restore the previous page's DOM with the old user's
   * data on screen — and does not revoke blob URLs from document previews. A
   * full document teardown removes all four at once, and costs one page load on
   * the one action where a page load is expected.
   */
  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout', undefined, { credentials: 'include' });
    } catch {
      // Logout is best-effort: the server returns 200 even with no cookie, and
      // a network failure must not strand the user in a signed-in-looking UI.
    }
    killSession();
    publishLogout();
    await purgeQueryCache(queryClient);
    window.location.replace('/login');
  }, [queryClient]);

  const status: Status = !ready ? 'bootstrapping' : user ? 'authenticated' : 'anonymous';

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
