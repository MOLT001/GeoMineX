'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { SubsidiaryLabel, SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Badge, CountChip } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Field, Select, TextInput } from '@/components/ui/Field';
import { RefreshIcon } from '@/components/ui/Icon';
import { PageHeader, ProseText, Section, Toolbar } from '@/components/ui/Layout';
import {
  AnswerStatusBadge,
  InjectionFlag,
  QueryStatusBadge,
  ReviewStatusBadge,
  isQueryPending,
  type QueryReviewStatus,
  type QueryStatus,
} from '@/components/ui/StatusBadge';
import { LoadMore, TBody, TD, TH, THead, TR, TableFrame } from '@/components/ui/Table';
import { AskPanel } from '@/features/queries/components/AskPanel';
import { type ListQueriesParams, type QuerySummary, useQueriesList } from '@/features/queries/api';
import { formatDateTime, formatRelative } from '@/lib/datetime';

/**
 * Queries — PRD §5.7: ask a question, and the log of what has been asked.
 *
 * The log is cursor-paginated, so there is no total, no page count and no
 * jump-to-page — `LoadMore` and "N loaded" are the whole vocabulary available
 * (see the note in components/ui/Table).
 *
 * It also does NOT poll. `useQueriesList` accepts a `refetchInterval`, but it
 * refetches EVERY page loaded so far against a moving cursor chain, which is
 * cheap at one page and wasteful at ten. The row a user actually cares about is
 * the one they opened, and the detail screen polls that one row. Here, a
 * Refresh control does the job honestly.
 */

/**
 * Mirrors `listKey` in the feature module, which keeps it private.
 *
 * Matched as a PREFIX, so resetting it drops the cursor chain of every filter
 * combination in the cache, not only the one on screen.
 */
const QUERIES_LIST_KEY = ['queries', 'list'] as const;

/**
 * Labels for the two filter dropdowns.
 *
 * `QueryStatusBadge` and `ReviewStatusBadge` own how a status LOOKS, but a
 * dropdown option cannot host a badge, so the plain-text labels live here.
 * (The listbox reads its options' children as TEXT — see textOf in ui/Select.tsx —
 * so this is still true now that the control is no longer a native <select>.)
 * Typed as exhaustive `Record`s on purpose: a status added to either enum
 * fails to compile here rather than silently becoming unfilterable.
 */
const STATUS_LABELS: Record<QueryStatus, string> = {
  queued: 'Queued',
  retrieving: 'Retrieving sources',
  answering: 'Composing answer',
  answered: 'Answered',
  unsupported: 'Not supported by sources',
  failed: 'Failed',
  dead_lettered: 'Needs manual review',
};

/**
 * All four are filterable, `not_required` included — even though the PATCH body
 * cannot set it (query.schema.ts:38 vs :62). There is no route back to it, so a
 * query that leaves it never returns.
 */
const REVIEW_LABELS: Record<QueryReviewStatus, string> = {
  not_required: 'No review needed',
  pending: 'Awaiting review',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** `q` is trimmed 2-120 server-side; outside that range it is a 400, not an
 *  ignored param, so the filter is simply not sent until it is valid. */
const SEARCH_MIN = 2;
const SEARCH_MAX = 120;

interface Filters {
  status: QueryStatus | '';
  reviewStatus: QueryReviewStatus | '';
  subsidiaryId: string;
  mine: boolean;
  isParliamentary: boolean;
}

const NO_FILTERS: Filters = {
  status: '',
  reviewStatus: '',
  subsidiaryId: '',
  mine: false,
  isParliamentary: false,
};

export default function QueriesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canAsk = can(user, 'query:ask');

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  /**
   * Debounced rather than live: every keystroke would otherwise start a fresh
   * cursor chain, and the whole app shares one IP-keyed budget of 100 requests
   * a minute.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const trimmedSearch = debouncedSearch.trim();

  const params: ListQueriesParams = {
    ...(trimmedSearch.length >= SEARCH_MIN ? { q: trimmedSearch } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.reviewStatus ? { reviewStatus: filters.reviewStatus } : {}),
    ...(filters.subsidiaryId ? { subsidiaryId: filters.subsidiaryId } : {}),
    // String enums on the wire, not booleans — `?mine=1` is a 400. Only the
    // affirmative is ever sent: `mine=false` would mean "other people's
    // queries", which is not what an unticked chip asks for.
    ...(filters.mine ? { mine: 'true' as const } : {}),
    ...(filters.isParliamentary ? { isParliamentary: 'true' as const } : {}),
  };

  const list = useQueriesList(params);
  const isFiltered = Object.keys(params).length > 0;

  function clearFilters() {
    setSearch('');
    setDebouncedSearch('');
    setFilters(NO_FILTERS);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Queries"
        description="Ask a question and get an answer built only from documents you are allowed to read, with a citation behind every claim."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshIcon size={16} />}
            /*
              Reset, not refetch. `refetch()` re-requests every page already
              loaded while REUSING the cursors it captured, and those cursors
              have moved: new rows land at the head, so a refreshed first page
              now ends short of the `_id <` boundary page two still asks for,
              and the rows in between disappear from the merged list. Resetting
              drops back to a single first page — one request instead of one per
              page, and the only answer a cursor chain can give honestly.
            */
            busy={list.isFetching && !list.isFetchingNextPage}
            busyLabel="Refreshing…"
            onClick={() => void queryClient.resetQueries({ queryKey: QUERIES_LIST_KEY })}
          >
            Refresh
          </Button>
        }
      />

      {/*
        §9.1: hiding this hides a control the server would allow anyway — all
        three roles hold `query:ask`. It is a courtesy for a future role, and
        the panel still handles every refusal the API can return.
      */}
      {canAsk ? (
        <Section
          id="ask"
          title="Ask a question"
          description="Ask in plain language. The answer is written in the background, so you can leave this page and pick it up again in the log below."
        >
          <AskPanel />
        </Section>
      ) : null}

      <Section
        id="log"
        title="Query log"
        description="A snapshot, not a live view — statuses change in the background. Open a query to watch it answer, or refresh."
      >
        <Toolbar>
          <Field
            label="Search"
            className="min-w-56 flex-1"
            description={
              search.trim().length > 0 && search.trim().length < SEARCH_MIN
                ? `Type at least ${SEARCH_MIN} characters to search.`
                : 'Words in the question or the generated answer. Results stay newest-first, never ranked by relevance.'
            }
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                type="search"
                value={search}
                maxLength={SEARCH_MAX}
                placeholder="e.g. coking coal production"
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </Field>

          <Field label="Status" className="min-w-48">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={filters.status}
                onChange={(status) =>
                  setFilters((current) => ({
                    ...current,
                    // The option values are the keys of an exhaustive Record
                    // over QueryStatus, plus the empty "any" sentinel.
                    status: status as QueryStatus | '',
                  }))
                }
              >
                <option value="">Any status</option>
                {(Object.entries(STATUS_LABELS) as Array<[QueryStatus, string]>).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </Select>
            )}
          </Field>

          <Field label="Review" className="min-w-48">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={filters.reviewStatus}
                onChange={(reviewStatus) =>
                  setFilters((current) => ({
                    ...current,
                    reviewStatus: reviewStatus as QueryReviewStatus | '',
                  }))
                }
              >
                <option value="">Any review state</option>
                {(Object.entries(REVIEW_LABELS) as Array<[QueryReviewStatus, string]>).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </Select>
            )}
          </Field>

          <div className="min-w-56 flex-1">
            <SubsidiaryPicker
              value={filters.subsidiaryId}
              onChange={(subsidiaryId) => setFilters((current) => ({ ...current, subsidiaryId }))}
              allowAll
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 pb-1">
            {/*
              `mine=true` SILENTLY OVERRIDES `askedBy` (query.service.ts:299-300),
              so the two must never both be offered. There is no asked-by filter
              on this screen, which keeps that impossible.
            */}
            <CountChip
              label="Only mine"
              active={filters.mine}
              onClick={() => setFilters((current) => ({ ...current, mine: !current.mine }))}
            />
            <CountChip
              label="Parliamentary"
              active={filters.isParliamentary}
              onClick={() =>
                setFilters((current) => ({ ...current, isParliamentary: !current.isParliamentary }))
              }
            />
            {isFiltered ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </Toolbar>

        {/*
          `isPending`, not `isLoading` — v5 defines the latter as
          `isPending && isFetching`, so a query parked at fetchStatus 'paused'
          (the browser is offline) reports neither. This screen would then show
          no skeleton, no error, and fall through to the empty state below,
          asserting that nothing has ever been asked about a log it never read.
        */}
        {list.isPending ? <LoadingBlock label="Loading queries" rows={4} /> : null}

        {/*
          A 404 here means the `subsidiaryId` filter names a grant this user does
          not hold — the API answers 404, never 403, and ErrorState already
          renders that as a flat "Not found." with no retry.

          Gated on an EMPTY list, because `isError` is also what a failed second
          page reports. The pages already fetched are still good, and swapping
          the whole table for an error message would throw away everything the
          user has paged through because one request failed.
        */}
        {list.isError && list.items.length === 0 ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : null}

        {!list.isPending && !list.isError && list.items.length === 0 ? (
          <EmptyState
            title={
              isFiltered ? 'No queries match these filters' : 'No questions have been asked yet'
            }
            description={
              isFiltered
                ? 'Nothing in the log matches. Widening the status or review filter is usually what finds it.'
                : canAsk
                  ? 'Ask the first question above. It will appear here with its status, its sources and its review state.'
                  : 'Questions asked within the subsidiaries you can read will appear here.'
            }
            action={
              /*
               * An empty page is NOT the end of the list — `nextCursor` is the
               * only end-of-list signal, and a page can come back with no rows
               * and a cursor still set. The table is hidden at zero rows, so
               * `LoadMore` is hidden with it; without this control the user is
               * stranded on an empty screen with more results one request away.
               */
              list.hasNextPage ? (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={list.isFetchingNextPage}
                  busyLabel="Loading…"
                  onClick={() => void list.fetchNextPage()}
                >
                  Keep looking
                </Button>
              ) : isFiltered ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {list.items.length > 0 ? (
          <>
            <TableFrame caption="Query log">
              <THead>
                {/* A plain <tr>: `TR` carries the row-hover and click affordances
                    of a BODY row, and its surface tone would paint over the
                    header's muted ground. */}
                <tr>
                  <TH>Question</TH>
                  <TH>Status</TH>
                  <TH>Answer</TH>
                  <TH>Review</TH>
                  <TH>Subsidiary</TH>
                  <TH>Asked</TH>
                </tr>
              </THead>
              <TBody>
                {list.items.map((query) => (
                  <QueryRow
                    key={query.id}
                    query={query}
                    onOpen={() => router.push(`/queries/${query.id}`)}
                  />
                ))}
              </TBody>
            </TableFrame>

            {/*
              Why a column of dashes is correct rather than broken: the filter
              matches any query that TOUCHES the subsidiary
              (query.service.ts:294), and a query scoped to more than one
              carries `subsidiaryId: null` (:341). There is no "scoped to this
              one only" filter to offer instead.
            */}
            {filters.subsidiaryId ? (
              <p className="text-xs text-text-muted">
                This filter also matches queries that merely touch the subsidiary alongside others.
                Those are scoped to several, so they show no subsidiary of their own.
              </p>
            ) : null}

            {/* A failed page keeps the pages already on screen. */}
            {list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.fetchNextPage()} />
            ) : null}

            <LoadMore
              loaded={list.items.length}
              // `nextCursor` going null is the ONLY end-of-list signal; a
              // short page is not one, because scope filtering happens after
              // the fetch.
              hasMore={list.hasNextPage}
              isLoading={list.isFetchingNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              noun="queries"
            />
          </>
        ) : null}
      </Section>
    </div>
  );
}

function QueryRow({ query, onOpen }: { query: QuerySummary; onOpen: () => void }) {
  return (
    <TR onClick={onOpen}>
      <TD className="max-w-xs">
        <Link
          href={`/queries/${query.id}`}
          className="font-medium text-sih-blue underline-offset-2 hover:underline"
        >
          <span className="line-clamp-2">{query.questionText}</span>
        </Link>
        {query.isParliamentary || query.injectionSuspected ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {query.isParliamentary ? (
              <Badge tone="info" srPrefix="Question type">
                Parliamentary
              </Badge>
            ) : null}
            {/* §9.5 — a property of the SOURCE documents, worth showing beside
                the answer that was built from them. */}
            {query.injectionSuspected ? <InjectionFlag /> : null}
          </span>
        ) : null}
      </TD>

      <TD>
        <QueryStatusBadge status={query.status} />
      </TD>

      <TD className="max-w-sm">
        <AnswerCell query={query} />
      </TD>

      <TD>
        <ReviewStatusBadge status={query.reviewStatus} />
      </TD>

      <TD>
        <SubsidiaryLabel id={query.subsidiaryId} />
      </TD>

      <TD className="whitespace-nowrap text-text-muted">
        {formatRelative(query.createdAt)}
        <span className="sr-only"> ({formatDateTime(query.createdAt)})</span>
      </TD>
    </TR>
  );
}

function AnswerCell({ query }: { query: QuerySummary }) {
  /**
   * `answerStatus` — and `answerPreview` with it — is null for `failed` and
   * `dead_lettered` as well as for the three moving statuses: only `finish()`
   * writes them, and the failure paths never reach it. A row that has stopped
   * moving has not necessarily produced anything, and the two cases read very
   * differently to whoever asked.
   */
  if (!query.answerStatus) {
    return (
      <span className="text-sm text-text-muted">
        {isQueryPending(query.status) ? 'Not answered yet' : 'No answer was produced'}
      </span>
    );
  }

  const preview = previewText(query.answerPreview);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <AnswerStatusBadge status={query.answerStatus} />
      {preview ? <ProseText className="line-clamp-2">{preview}</ProseText> : null}
      <p className="text-xs text-text-muted">
        {/*
          The SUMMARY shape spells this `discardedCitationCount`; the DETAIL
          shape calls the same number `retrieval.discardedCitations`. Reading
          the other name here would silently render undefined.
        */}
        {query.citationCount} {query.citationCount === 1 ? 'source' : 'sources'}
        {query.discardedCitationCount > 0 ? ` · ${query.discardedCitationCount} discarded` : ''}
      </p>
    </div>
  );
}

/** `query.service.ts:233` slices exactly this many characters. */
const PREVIEW_LENGTH = 200;

/**
 * `answerPreview` is a raw `responseText.slice(0, 200)`: no ellipsis, and it
 * still carries the `[3]` citation markers from the full answer.
 *
 * The markers are stripped rather than rendered, because the summary shape has
 * no citations array — a marker shown here is a reference to a source this row
 * cannot name, which is the traceability failure §13 exists to prevent. They
 * are shown, and resolved by ordinal, on the detail screen.
 */
function previewText(answerPreview: string | null): string | null {
  if (!answerPreview) return null;
  const stripped = answerPreview
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  // The slice can cut mid-word, so a full-length preview gets the ellipsis the
  // server does not add.
  return answerPreview.length >= PREVIEW_LENGTH ? `${stripped}…` : stripped;
}
