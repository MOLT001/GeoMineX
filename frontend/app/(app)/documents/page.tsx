'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import {
  FileTextIcon,
  ImageIcon,
  RefreshIcon,
  ScanIcon,
  TableIcon,
} from '@/components/ui/Icon';
import { PageHeader, Section } from '@/components/ui/Layout';
import {
  canRetryDocument,
  DocumentStatusBadge,
  InjectionFlag,
  ReviewRequiredFlag,
} from '@/components/ui/StatusBadge';
import { LoadMore, TableFrame, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import { useDocuments, useRetryDocument, type Document, type DocumentType } from '@/features/documents/api';
import {
  DOCUMENT_TYPE_LABELS,
  DocumentFilterBar,
  EMPTY_DOCUMENT_FILTERS,
  hasActiveFilters,
  toDocumentFilters,
  type DocumentListFilters,
} from '@/features/documents/components/DocumentFilterBar';
import { DocumentStats } from '@/features/documents/components/DocumentStats';
import { UploadPanel } from '@/features/documents/components/UploadPanel';
import { formatDateTime } from '@/lib/datetime';
import { formatBytes } from '@/lib/format';
import { userMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';

/**
 * Documents — PRD §5.4.
 *
 * The list is CURSOR-paginated, which is the fact that shapes the screen: the
 * envelope carries no `total` and no page count, so there is no "N results",
 * no page strip and no jump. `LoadMore` reports "N loaded", and
 * `nextCursor === null` is the only end-of-list signal — a short page is not
 * one, because scope filtering is applied after the fetch.
 *
 * ─── WHAT THE REFERENCE LAYOUT ASKED FOR AND WHAT THE API CAN HONOUR ────────
 * This screen is modelled on a document-library design, and three of its
 * controls could not be built without lying about the data behind them. They
 * are recorded here rather than silently dropped, so nobody re-adds one:
 *
 *   "Showing 1–6 of 1,248" AND A NUMBERED PAGER. Both need a total. Cursor
 *   pagination has none by design (§9.8: a count is not meaningful for a set
 *   being written to concurrently), so the count stays "N loaded" and paging
 *   stays one-way.
 *
 *   A "Newest first" SORT DROPDOWN. `listDocumentsQuerySchema` accepts no sort
 *   parameter; the order is fixed `_id` descending. A dropdown with one option
 *   is a control that does nothing, so the order is stated as a LABEL instead —
 *   which tells the reader the same fact without implying they can change it.
 *
 *   BULK-SELECT CHECKBOXES. There is no bulk endpoint on the API. A column of
 *   checkboxes wired to nothing is the worst kind of affordance.
 *
 * The storage-quota tile and the trend delta are refused for the same reason,
 * one level down, in components/DocumentStats.tsx.
 */

/**
 * A glyph per document type, so a long list is scannable by shape.
 *
 * Never the only carrier of the type: the written label sits beside it in the
 * table and under it in the grid. `DOCUMENT_TYPE_LABELS` is the exhaustive
 * `Record` this mirrors, so a new type added to the backend enum fails to
 * compile here rather than quietly rendering nothing.
 */
const TYPE_ICONS: Record<DocumentType, ReactNode> = {
  pdf: <FileTextIcon size={18} strokeWidth={2.4} />,
  scan: <ScanIcon size={18} strokeWidth={2.4} />,
  spreadsheet: <TableIcon size={18} strokeWidth={2.4} />,
  image: <ImageIcon size={18} strokeWidth={2.4} />,
};

type ViewMode = 'list' | 'grid';

export default function DocumentsPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<DocumentListFilters>(EMPTY_DOCUMENT_FILTERS);
  const [view, setView] = useState<ViewMode>('list');
  /** Bumped whenever the filter set is replaced wholesale — see applyFilter. */
  const [filterReset, setFilterReset] = useState(0);

  const {
    items,
    isPending,
    error,
    // Safe to call only where nothing has loaded yet — with zero pages in the
    // cache there are no stale cursors to re-request. The Refresh control in the
    // header resets instead, for exactly that reason.
    refetch,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    fetchNextPage,
  } = useDocuments(toDocumentFilters(filters));
  const queryClient = useQueryClient();

  const filtered = hasActiveFilters(filters);
  const canUpload = can(user, 'document:upload');

  /**
   * A count tile REPLACES the filter set rather than adding to it.
   *
   * Merging would mean pressing "Failed" while a subsidiary filter is active
   * shows a subset of the number on the tile, which makes the tile wrong the
   * moment it is used. Starting from empty makes what you see match what you
   * pressed.
   */
  const applyFilter = (next: Partial<DocumentListFilters>) => {
    setFilters({ ...EMPTY_DOCUMENT_FILTERS, ...next });
    // Also clears an unsubmitted search draft, which the filter object cannot
    // express: `q` is already '' here, so the bar has nothing to react to.
    setFilterReset((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        icon={<FileTextIcon size={24} strokeWidth={2} />}
        title="Documents"
        description="Everything ingested for the subsidiaries you can access, newest first. Processing runs in the background — open a document to watch it finish."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshIcon size={16} />}
            /*
              Reset, not refetch — the same reasoning as the queries log.
              `refetch()` re-requests every loaded page while REUSING the
              cursors it captured, and those cursors have moved: a new upload
              lands at the head, so a refreshed first page ends short of the
              boundary page two still asks for and the rows in between vanish
              from the merged list. Resetting drops back to one first page.

              This exists because the list does not poll: a row sitting on
              `queued` or `processing` would otherwise never advance here. The
              detail screen polls the one row that matters; this is the honest
              browse-surface equivalent.
            */
            busy={isFetching && !isFetchingNextPage}
            busyLabel="Refreshing…"
            onClick={() => void queryClient.resetQueries({ queryKey: ['documents', 'list'] })}
          >
            Refresh
          </Button>
        }
      />

      {/*
        Above the filter bar, deliberately. These counts are scope-wide and take
        no notice of the filters; putting them between the filters and the
        results would read as a summary of the filtered set. See the component.
      */}
      <DocumentStats onApplyFilter={applyFilter} />

      {/*
        §9.1: hiding the panel is a courtesy, not a control. `POST /documents`
        is roleGuard('admin','cil_user') and answers an MoC Official with a 403
        before multer reads a byte, which the panel handles regardless.
      */}
      {canUpload ? (
        <Section
          id="upload"
          title="Upload a document"
          description="Accepted immediately and read in the background. You will be taken to the document as soon as it is queued."
        >
          <UploadPanel />
        </Section>
      ) : null}

      <Section id="document-list" title="All documents">
        <DocumentFilterBar value={filters} onChange={setFilters} resetSignal={filterReset} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          {/*
            A LABEL, not a sort control. The API takes no sort parameter and the
            order is fixed `_id` descending, so this states the order rather than
            offering to change it.
          */}
          <p className="text-sm text-text-muted">Newest first</p>
          <ViewToggle value={view} onChange={setView} />
        </div>

        {isPending ? <LoadingBlock label="Loading documents" rows={5} /> : null}

        {/*
          Gated on an EMPTY list, because `error` is also what a failed SECOND
          page reports. The pages already loaded are still good, and replacing
          the table with an error would discard everything the user has paged
          through because one request failed. `refetch()` is the right remedy
          only here: on an infinite query it re-requests every page loaded so
          far, which against a 100/60s IP-keyed limiter is the wrong answer to a
          single failed page (the recovery for that sits under the table).
        */}
        {error && items.length === 0 ? (
          <div className="flex flex-col gap-3">
            <ErrorState error={error} onRetry={() => void refetch()} />
            {/*
              A subsidiaryId the caller does not hold 404s the WHOLE request
              instead of narrowing it to empty (assertSubsidiaryAccess throws
              before the query runs), so a filter left over from a revoked grant
              is one real cause of the error above. Offer the remedy without
              inventing 404 copy — the message stays the flat "Not found."
            */}
            {filtered ? (
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => setFilters(EMPTY_DOCUMENT_FILTERS)}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}

        {!isPending && !error && items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No documents match these filters' : 'No documents yet'}
            description={
              filtered
                ? 'Nothing matches this combination. Widen or clear the filters to see more.'
                : canUpload
                  ? 'Upload a PDF, scan, spreadsheet or image above to start the pipeline.'
                  : 'Documents appear here once they have been uploaded for a subsidiary you can access.'
            }
            action={
              /*
               * An empty page does NOT mean the end of the list. `nextCursor`
               * is the only end-of-list signal the API gives, and a page can
               * legitimately come back with no rows and a cursor still set. The
               * table is hidden at zero rows, so `LoadMore` below is hidden
               * too — without this control the user is stranded on an empty
               * screen with more results sitting one request away.
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
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setFilters(EMPTY_DOCUMENT_FILTERS)}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {items.length > 0 ? (
          <>
            {view === 'list' ? (
              <TableFrame caption="Documents, newest first">
                <THead>
                  {/*
                    A plain <tr>: `TR` paints `bg-surface`, which would cover the
                    muted header ground `THead` sets.
                  */}
                  <tr>
                    <TH>Document</TH>
                    <TH>Subsidiary</TH>
                    <TH>Status</TH>
                    <TH>Flags</TH>
                    <TH>Uploaded</TH>
                    <TH>Actions</TH>
                  </tr>
                </THead>
                <TBody>
                  {items.map((doc) => (
                    <DocumentRow key={doc.id} doc={doc} />
                  ))}
                </TBody>
              </TableFrame>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((doc) => (
                  <li key={doc.id}>
                    <DocumentCard doc={doc} />
                  </li>
                ))}
              </ul>
            )}

            {/* A failed next page keeps the pages already on screen. */}
            {error ? <ErrorState error={error} onRetry={() => void fetchNextPage()} /> : null}

            <LoadMore
              loaded={items.length}
              // `nextCursor` going null is the ONLY end-of-list signal; a short
              // page is not one, so the count is "N loaded" and never a total.
              hasMore={hasNextPage}
              isLoading={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
              noun="documents"
            />
          </>
        ) : null}
      </Section>
    </div>
  );
}

/**
 * List or grid, and nothing else.
 *
 * ─── WHY THESE ARE TOGGLE BUTTONS AND NOT A RADIOGROUP ──────────────────────
 * This was `role="radiogroup"` with two `role="radio"` children, which reads
 * better in the abstract and was wrong in practice: that contract obliges the
 * group to move selection with the ARROW KEYS and to expose a single tab stop
 * (roving `tabindex`). It had neither, so a screen-reader user was told they
 * were in a radio group, pressed an arrow, and nothing moved.
 *
 * `aria-pressed` promises only what is implemented — each button is its own tab
 * stop and Space or Enter activates it, which is exactly what these do. A
 * contract that is kept beats a richer one that is not.
 *
 * The choice is per-session and deliberately not persisted: it is a way of
 * looking at the page you are on, not a setting.
 */
function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const options: Array<{ id: ViewMode; label: string }> = [
    { id: 'list', label: 'List' },
    { id: 'grid', label: 'Grid' },
  ];

  return (
    <div
      // A plain group, named so the two buttons are announced as a pair.
      role="group"
      aria-label="Document layout"
      className="inline-flex rounded-md border border-border-strong bg-surface p-0.5"
    >
      {options.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={cn(
              'inline-flex min-h-9 items-center rounded-sm px-3.5 text-sm transition-colors duration-150',
              'motion-reduce:transition-none',
              active
                ? 'bg-sih-blue font-semibold text-white'
                : 'text-text-muted hover:text-primary-dark',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The filename cell, shared by both layouts. */
function DocumentIdentity({ doc, className }: { doc: Document; className?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-muted text-text-muted"
      >
        {TYPE_ICONS[doc.type]}
      </span>
      <div className="min-w-0">
        {/*
          Truncated with the full name on hover: `originalFilename` is stored up
          to 255 characters, and an unbroken one would push the table wider than
          the frame it scrolls inside.
        */}
        <Link
          href={`/documents/${doc.id}`}
          title={doc.originalFilename}
          className={cn('block truncate font-medium text-sih-blue underline-offset-2 hover:underline', className)}
        >
          {doc.originalFilename}
        </Link>
        <span className="mt-0.5 block text-xs text-text-muted">
          {DOCUMENT_TYPE_LABELS[doc.type]} · {formatBytes(doc.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

/** Both flags, in the same order as the detail screen. */
function DocumentFlags({ doc }: { doc: Document }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {/*
        The worker computes `requiresReview` as
        `(lowConfidence || noFields) || injectionSuspected`, so a suspicious
        document is always flagged for review too — but the two are still
        separate facts, and `requiresReview` is the one the Review filter above
        matches on. Hiding its badge on a suspicious row leaves a result of that
        filter with nothing on it that says why it matched.
      */}
      {doc.requiresReview ? <ReviewRequiredFlag /> : null}
      {doc.injectionSuspected ? <InjectionFlag /> : null}
      {!doc.requiresReview && !doc.injectionSuspected ? (
        <span className="text-text-muted">
          <span aria-hidden>—</span>
          <span className="sr-only">No flags</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * Row actions.
 *
 * Retry and nothing else, because retry is the only thing the API offers on a
 * list row.
 *
 * ─── TWO GUARDS, AND BOTH ARE REQUIRED ──────────────────────────────────────
 * `canRetryDocument(doc)` answers "is this document retryable" — `failed` AND
 * `processingAttempts < 3`, since a fourth attempt is refused by the server.
 *
 * `can(user, 'document:retry')` answers "may THIS PERSON retry", and it is a
 * separate question the document cannot answer. `POST /documents/:id/retry`
 * carries `roleGuard('admin','cil_user')`, so an `moc_official` takes a 403
 * whatever the row says — and because that role CAN read the list, it would
 * otherwise be shown a live button on every failed row that could never work.
 * The api.ts contract states this requirement in as many words, and the detail
 * screen already honours it.
 *
 * There is deliberately no download here. `GET /documents/:id/file` needs a
 * bearer header and answers `Content-Disposition: attachment`, so it cannot be
 * an `<a href>`; it has to be fetched as a blob and handed an object URL that
 * something then has to revoke. That lifecycle belongs on the detail screen
 * that already owns it, not duplicated across every row of an infinite list.
 */
function DocumentActions({ doc }: { doc: Document }) {
  const { user } = useAuth();
  const retry = useRetryDocument();
  const mayRetry = can(user, 'document:retry');

  if (!canRetryDocument(doc) || !mayRetry) {
    return (
      <span className="text-text-muted">
        <span aria-hidden>—</span>
        <span className="sr-only">
          {mayRetry ? 'No actions available' : 'Retrying is available to CIL users and administrators'}
        </span>
      </span>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        variant="secondary"
        size="sm"
        busy={retry.isPending}
        busyLabel="Retrying…"
        onClick={() => retry.mutate(doc.id)}
        // Names the file, because on a list of twenty rows "Retry" alone does
        // not say which one a screen reader is about to act on.
        aria-label={`Retry processing ${doc.originalFilename}`}
      >
        Retry
      </Button>

      {/*
        A failed retry has to SAY so. `mutate` swallows the rejection into
        mutation state, `useRetryDocument` has no `onError`, and the query
        client sets no global mutation handler — so without this the button
        spins, stops, the row still reads Failed, and a 403 or a 429 is
        indistinguishable from a success that did nothing.
      */}
      {retry.isError ? (
        <p role="alert" className="max-w-56 text-xs font-medium text-danger">
          {userMessage(retry.error)}
        </p>
      ) : null}
    </div>
  );
}

function DocumentRow({ doc }: { doc: Document }) {
  return (
    <TR>
      <TD>
        <DocumentIdentity doc={doc} className="max-w-[22rem]" />
      </TD>

      <TD>
        <SubsidiaryLabel id={doc.subsidiaryId} />
      </TD>

      <TD>
        <DocumentStatusBadge status={doc.status} />
      </TD>

      <TD>
        <DocumentFlags doc={doc} />
      </TD>

      {/*
        `createdAt` and nothing else: a Document carries no `updatedAt`, so
        there is no "last modified" to show however much a table invites one.
      */}
      <TD className="whitespace-nowrap text-text-muted">{formatDateTime(doc.createdAt)}</TD>

      <TD>
        <DocumentActions doc={doc} />
      </TD>
    </TR>
  );
}

/**
 * The grid arm of the view toggle.
 *
 * Carries exactly the same facts as the row — the toggle changes the shape of
 * the page, never what it tells you. A card that dropped the flags would make
 * "Needs review" invisible to anyone who happened to be in grid view.
 */
function DocumentCard({ doc }: { doc: Document }) {
  return (
    <article className="flex h-full flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <DocumentIdentity doc={doc} />

      <div className="flex flex-wrap items-center gap-2">
        <DocumentStatusBadge status={doc.status} />
        <DocumentFlags doc={doc} />
      </div>

      <dl className="mt-auto flex flex-col gap-1 text-xs">
        <div className="flex gap-2">
          <dt className="text-text-muted">Subsidiary</dt>
          <dd className="min-w-0 truncate text-text-default">
            <SubsidiaryLabel id={doc.subsidiaryId} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-text-muted">Uploaded</dt>
          <dd className="text-text-default">{formatDateTime(doc.createdAt)}</dd>
        </div>
      </dl>

      {/*
        No second condition here. `DocumentActions` owns BOTH guards — the
        document's state and the caller's role — and duplicating half of that
        test is exactly how the two arms drifted apart in the first place.
      */}
      <DocumentActions doc={doc} />
    </article>
  );
}
