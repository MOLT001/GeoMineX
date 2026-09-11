import { useInfiniteQuery, useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isCursorPagination, type OffsetPagination } from '@/lib/api/rawFetch';

/**
 * The two list-fetching shapes, matching the API's two pagination styles.
 *
 * Written once here because getting either wrong is subtle: a cursor list that
 * re-requests page one on every filter change looks fine and quietly re-reads
 * the whole collection; an offset list without `placeholderData` flashes empty
 * between pages, which reads as a failed request.
 */

/** Mirrors `RequestOptions['query']`: an array becomes a repeated parameter. */
export type QueryParams = Record<string, string | number | boolean | undefined | null | string[]>;

/**
 * A cursor-paginated list — documents, queries, audit logs.
 *
 * Cursor collections are append-heavy and unbounded, which is why the backend
 * omits `total` from their envelope. Consequences the caller inherits:
 *
 *   - There is no page count and no "N results". Report `items.length` as
 *     "N loaded" and nothing more (`LoadMore` in components/ui/Table).
 *   - Paging is forward-only. There is no way to jump to a page.
 *   - `nextCursor === null` is the ONLY end-of-list signal. A short final page
 *     is not one: the server may return fewer than `limit` rows and still have
 *     more, because scope filtering is applied after the fetch.
 */
export function useCursorList<T>({
  key,
  path,
  params,
  limit = 25,
  enabled = true,
  refetchInterval,
}: {
  /** Stable prefix for the query key; `params` is appended automatically. */
  key: readonly unknown[];
  path: string;
  params?: QueryParams;
  limit?: number;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const query = useInfiniteQuery({
    // `params` is part of the key, so changing a filter starts a fresh cursor
    // chain rather than appending filtered rows onto unfiltered ones.
    queryKey: [...key, params ?? {}, limit],
    queryFn: async ({ pageParam, signal }) => {
      const envelope = await api.get<T[]>(path, {
        query: { ...params, limit, cursor: pageParam },
        signal,
      });
      return envelope;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      isCursorPagination(lastPage.pagination)
        ? // `?? undefined` matters: TanStack treats `null` as "no more pages"
          // but also as a valid pageParam, and returning it produces a request
          // with `cursor=null` in the query string.
          (lastPage.pagination.nextCursor ?? undefined)
        : undefined,
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    enabled,
  });

  const items = query.data?.pages.flatMap((page) => page.data) ?? [];

  return { ...query, items };
}

/**
 * An offset-paginated list — users, reports.
 *
 * `keepPreviousData` holds the previous page on screen while the next one
 * loads. Without it the table unmounts, the page height collapses, the scroll
 * position jumps, and the whole thing reads as an error rather than a page
 * turn. `isPlaceholderData` is what a caller should use to dim the table and
 * disable the pagination controls during the transition.
 */
export function useOffsetList<T>({
  key,
  path,
  params,
  page,
  limit = 20,
  enabled = true,
}: {
  key: readonly unknown[];
  path: string;
  params?: QueryParams;
  page: number;
  limit?: number;
  enabled?: boolean;
}) {
  const query = useQuery({
    queryKey: [...key, params ?? {}, page, limit],
    queryFn: async ({ signal }) => {
      const envelope = await api.get<T[]>(path, {
        query: { ...params, page, limit },
        signal,
      });
      return {
        items: envelope.data,
        pagination: envelope.pagination as OffsetPagination | undefined,
      };
    },
    placeholderData: keepPreviousData,
    enabled,
  });

  return {
    ...query,
    items: query.data?.items ?? [],
    pagination: query.data?.pagination,
  };
}

/**
 * Poll interval for a record that is still being worked on.
 *
 * Returns `false` — TanStack's "stop polling" value — once the record reaches a
 * terminal state, so a finished document or answered query costs nothing.
 *
 * The `document.visibilityState` check is not an optimisation. Bootstrap spends
 * `authLimiter` budget (10/min) on every page load, and a background tab
 * polling every 1.5s alongside two foreground tabs is how a user hits 429 on a
 * screen they are not even looking at.
 */
export function pollWhile(isPending: boolean, intervalMs: number): number | false {
  if (!isPending) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  return intervalMs;
}
