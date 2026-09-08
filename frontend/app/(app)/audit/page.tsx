'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { isUnscoped } from '@/auth/permissions';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { RefreshIcon } from '@/components/ui/Icon';
import { PageHeader, Section } from '@/components/ui/Layout';
import { LoadMore, TBody, TH, THead, TableFrame } from '@/components/ui/Table';
import {
  AUDIT_LIST_KEY,
  canFilterAuditByUser,
  isAuditScopeDenied,
  useAuditLogs,
} from '@/features/audit/api';
import { AUDIT_COLUMNS, AuditEntryRow } from '@/features/audit/components/AuditEntryRow';
import {
  AuditFilterBar,
  hasAuditFilters,
  NO_AUDIT_FILTERS,
  toAuditLogFilters,
  USER_DIRECTORY_PAGE,
  type AuditFilterState,
} from '@/features/audit/components/AuditFilterBar';
import { useUsers } from '@/features/users/api';

/**
 * Audit log — PRD §5.10, §9.6.
 *
 * Every authenticated role can read this; what differs by role is the Mongo
 * filter, not a 403 (audit.routes.ts:13 applies `requireAuth` and no
 * `roleGuard`). So this screen is not admin-only, and the rows a CIL user sees
 * are their own activity plus their granted subsidiaries'.
 */

/**
 * Within the server's 1–100 bound (audit.routes.ts:17-24), so it can never be
 * the thing that 400s. Denser than the default 25 because this is a scanning
 * surface: fewer round trips to reach a row from last week.
 */
const AUDIT_PAGE_SIZE = 50;

export default function AuditPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AuditFilterState>(NO_AUDIT_FILTERS);

  const {
    items,
    isPending,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
    refetch,
  } = useAuditLogs(toAuditLogFilters(filters), { limit: AUDIT_PAGE_SIZE });

  /*
    Actor names, for admins only. GET /users is roleGuard('admin') and no public
    user-lookup route exists, so for every other role an id that is not the
    viewer's own stays an id — see `ActorCell`.

    The arguments must stay identical to the filter bar's own `useUsers` call.
    `useOffsetList` folds params, page and limit into the query key, so the two
    hooks share one cache entry — and one request — only while they agree; hence
    the shared `USER_DIRECTORY_PAGE` rather than a literal on each side.
  */
  const directory = useUsers({
    limit: USER_DIRECTORY_PAGE,
    enabled: canFilterAuditByUser(user),
  });
  const actorNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const account of directory.items) names.set(account.id, account.name);
    return names;
  }, [directory.items]);

  const filtered = hasAuditFilters(filters);
  const denied = isAuditScopeDenied(error);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Audit log"
        description="Every recorded action, who performed it and what it touched. Times are IST."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshIcon size={14} />}
            busy={isFetching && !isFetchingNextPage}
            busyLabel="Refreshing…"
            /*
              Reset, not refetch. Refetching an infinite query re-requests EVERY
              page loaded so far — ten pages is ten sequential calls against this
              route's only limiter, the app-wide 100/min keyed on IP (app.ts:105).
              Resetting drops back to a single first page, which is also the
              honest answer: new rows land at the head, so the window each cursor
              covers has already moved.
            */
            onClick={() => void queryClient.resetQueries({ queryKey: AUDIT_LIST_KEY })}
          >
            Refresh
          </Button>
        }
      />

      <Section
        id="audit-entries"
        title="Activity"
        description="Newest first. Load more to reach older entries."
      >
        <AuditFilterBar value={filters} onChange={setFilters} />

        {/*
          The backend scopes a non-admin with `$or: [{ subsidiaryId }, { userId:
          you }]` (audit.routes.ts:58-61), so a subsidiary-filtered page is a
          union and still carries the viewer's own rows. Saying so once here is
          cheaper than leaving the reader to wonder why a row from elsewhere is
          on a filtered page.
        */}
        {filters.subsidiaryId && !isUnscoped(user) ? (
          <p className="text-sm text-text-muted">
            Your own activity is always included, even where it falls outside this subsidiary. Those
            rows are marked <span className="font-medium text-text-default">Your activity</span>.
          </p>
        ) : null}

        {isPending ? <LoadingBlock label="Loading audit entries" rows={6} /> : null}

        {/*
          A 404 here means DENIED, not empty (utils/authorization.ts:46-54) — the
          existence of the rows is itself the secret, which is why the backend
          answers 404 rather than 403. `ErrorState` renders it as "Not found."
          with no retry, since retrying cannot change the answer. Rendering an
          empty table instead would assert that the subsidiary has no activity,
          which is a different and false statement.
        */}
        {!isPending && error && items.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorState error={error} onRetry={() => void refetch()} className="w-full" />
            {denied && filtered ? (
              <Button variant="secondary" size="sm" onClick={() => setFilters(NO_AUDIT_FILTERS)}>
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}

        {!isPending && !error && items.length === 0 ? (
          <EmptyState
            title="No audit entries"
            description={
              filtered
                ? 'No recorded action matches these filters.'
                : 'Nothing has been recorded against your access yet.'
            }
            action={
              /*
               * An empty page is NOT the end of the list — `nextCursor` is the
               * only end-of-list signal, and a page can come back with no rows
               * and a cursor still set. The table is hidden at zero rows, so
               * `LoadMore` is hidden with it; without this the user is stranded
               * on an empty screen with entries one request away. Most likely
               * to bite here of the three cursor lists, because the audit log is
               * the one people filter hard.
               */
              hasNextPage ? (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={isFetchingNextPage}
                  busyLabel="Loading…"
                  onClick={() => void fetchNextPage()}
                >
                  Keep looking
                </Button>
              ) : filtered ? (
                <Button variant="secondary" size="sm" onClick={() => setFilters(NO_AUDIT_FILTERS)}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {items.length > 0 ? (
          <>
            <TableFrame caption="Audit log entries, newest first">
              <THead>
                <tr>
                  {AUDIT_COLUMNS.map((column) => (
                    <TH key={column}>{column}</TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {/*
                  Rendered in the order the server paged them, which is `_id`
                  descending (audit.routes.ts:69) — NOT timestamp order. The two
                  differ for writes in the same millisecond, and re-sorting on
                  the timestamp column would put rows in an order no cursor page
                  boundary matches.
                */}
                {items.map((entry) => (
                  <AuditEntryRow
                    key={entry.id}
                    entry={entry}
                    viewer={user}
                    actorName={entry.userId ? actorNames.get(entry.userId) : undefined}
                    filteredSubsidiaryId={filters.subsidiaryId || undefined}
                  />
                ))}
              </TBody>
            </TableFrame>

            {/* A failed page keeps the pages already on screen. */}
            {error ? <ErrorState error={error} onRetry={() => void fetchNextPage()} /> : null}

            {/*
              "N loaded", never "N results": the cursor envelope carries no
              `total` (utils/envelope.ts:29-36) and neither do we.
            */}
            <LoadMore
              loaded={items.length}
              hasMore={hasNextPage}
              isLoading={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
              noun="entries"
            />
          </>
        ) : null}
      </Section>
    </div>
  );
}
