import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/errors';
import { SessionExpiredError } from '@/auth/refreshManager';

/**
 * Server-state cache — PRD §10.5.
 *
 * Never add `persistQueryClient`. Persisting the cache writes authenticated
 * server state to browser storage, which §9.13 forbids outright; the ESLint
 * config bans the import so it cannot arrive quietly as a perceived
 * performance win.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * Never retry a 4xx.
         *
         * The default `retry: 3` is actively harmful here: against a 401 it
         * triples one stale-token event into three refresh attempts, and
         * `authLimiter` allows 10/min — so a couple of tabs reloading turns a
         * routine expiry into a 429 storm. Retrying a 403, 404 or 422 is
         * pointless in any case, since the answer will not change.
         */
        retry: (failureCount, error) => {
          if (error instanceof SessionExpiredError) return false;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Tear down every trace of the outgoing user's data.
 *
 * `clear()` alone is not enough, and the order matters:
 *
 *   1. Cancel in-flight queries FIRST. A request issued with the previous
 *      user's token can otherwise resolve after the next sign-in and write
 *      that data into the fresh cache.
 *   2. Then clear, so nothing cached survives.
 *
 * Even this is insufficient on its own, which is why sign-out is a hard
 * navigation: `clear()` does not touch component-local state (a half-typed
 * report draft), does not defeat bfcache, and does not revoke blob URLs from
 * document previews. A full document teardown is the only thing that removes
 * all four, and it costs one page load on the single action where a page load
 * is expected.
 */
export async function purgeQueryCache(client: QueryClient): Promise<void> {
  await client.cancelQueries();
  client.clear();
}
