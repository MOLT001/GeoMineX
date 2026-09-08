'use client';

import { use, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { ErrorState, InlineError, LoadingBlock } from '@/components/ui/Feedback';
import { RefreshIcon } from '@/components/ui/Icon';
import { Card, DescriptionList, PageHeader, ProseText, Section } from '@/components/ui/Layout';
import {
  DocumentStatusBadge,
  InjectionFlag,
  ReviewRequiredFlag,
  canRetryDocument,
} from '@/components/ui/StatusBadge';
import {
  useDocument,
  useRetryDocument,
  type Document,
  type DocumentType,
} from '@/features/documents/api';
import { DocumentTextPanel } from '@/features/documents/components/DocumentTextPanel';
import { ExtractedFieldTable } from '@/features/documents/components/ExtractedFieldTable';
import { ApiError, NOT_FOUND_MESSAGE, userMessage } from '@/lib/api/errors';
import { formatDateTime, formatRelative } from '@/lib/datetime';
import { formatBytes } from '@/lib/format';

/**
 * One document — PRD §5.4.
 *
 * The detail query polls itself while the worker still has the file, so this
 * page has no refresh control and no timer of its own: the status card is the
 * live thing, and everything else on the page follows from it. The chunk and
 * extracted-field panels are gated on the document being at rest, inside their
 * own components, because nothing invalidates those two keys when the worker
 * finishes — fetching them early caches an empty array for minutes.
 */

/** Every id in a route path must be a 24-hex ObjectId or the API answers 400, not 404. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * A URL that cannot address a document is rendered exactly like a document that
 * is not there — which is what it is. Sending the id anyway would spend a
 * request to be told `VALIDATION_ERROR`, and that message ("Invalid id") reads
 * as a fault in the app rather than as a bad link. `ErrorState` owns the 404
 * copy so it is not written twice.
 */
const MALFORMED_ID = new ApiError(404, { code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });

/**
 * `useRetryDocument` invalidates the detail row immediately, so the refetch it
 * triggers can sample the document BEFORE the worker claims the job — coming
 * back 'failed', which `isDocumentPending` reads as at rest, which stops the
 * poll. One nudge a beat later is what turns that rare case back into a live
 * page without waiting for a window focus.
 */
const RETRY_SETTLE_MS = 1500;

/** From the file EXTENSION, never the contents: a scanned PDF is still 'pdf'. */
const TYPE_LABELS: Record<DocumentType, string> = {
  pdf: 'PDF',
  scan: 'Scan (TIFF)',
  spreadsheet: 'Spreadsheet or text',
  image: 'Image',
};

export default function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();

  /**
   * Every hook runs on every render, malformed id or not: Next reuses this
   * component across param changes, so an early return above a hook would
   * reorder the hook list the moment someone navigates from a bad id to a good
   * one. The id is disqualified by disabling the query instead.
   */
  const isValidId = OBJECT_ID.test(id);
  const detail = useDocument(id, { enabled: isValidId });
  const retry = useRetryDocument();

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  /**
   * A 404 arriving on a POLL means the row went away under an open page — soft
   * deleted, or a grant revoked. The cached copy is then a record of something
   * the reader may no longer see, so it is dropped rather than left on screen
   * beside a "not found" line. Any other refresh failure keeps the content and
   * says so in the status card: a transient network blip should not blank a
   * page that is still perfectly readable.
   */
  const notFound = detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND';
  const doc = notFound ? undefined : detail.data;

  function handleRetry() {
    retry.mutate(id, {
      onSuccess: () => {
        // The 200 body is a pre-retry snapshot — `processingError`,
        // `processingAttempts`, `processedAt` and `ocrConfidence` are all the
        // OLD values — so nothing is read from it here. See RETRY_SETTLE_MS.
        settleTimer.current = setTimeout(() => void detail.refetch(), RETRY_SETTLE_MS);
      },
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        /*
          UX4G's breadcrumb pattern, in full rather than as the single back-link
          that stood here.

          Their three rules are all structural: the trail sits at the TOP of the
          page, EVERY crumb is clickable except the one you are on, and the
          separator is clear. The `<nav>`/`<ol>` pair is what makes it a list of
          steps to a screen reader instead of two loose links, `aria-current`
          marks where the trail ends, and the separator is `aria-hidden` so it
          is never announced as a word between two names.

          The link is `min-h-11` — 44px, WCAG 2.5.5, the rule a text-sized crumb
          quietly breaks at its natural 24px line box. Its label is already far
          wider than 44px, so height is the only dimension that needed fixing;
          horizontal padding is deliberately absent because it would push the
          crumb out of optical alignment with the `<h1>` beneath it.

          16px, not 14px: UX4G sizes a navigation item at Label/XL, and the
          floor for anything that is not helper text is Body/M.
        */
        breadcrumb={
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
              <li>
                <Link
                  href="/documents"
                  className="inline-flex min-h-11 items-center text-sih-blue underline underline-offset-2 transition-colors duration-150 hover:text-sih-blue-dark motion-reduce:transition-none"
                >
                  Documents
                </Link>
              </li>
              <li className="flex min-w-0 items-center gap-x-2">
                <span aria-hidden="true" className="text-text-muted">
                  &rsaquo;
                </span>
                {/*
                  The same filename the `<h1>` carries, but capped and clipped:
                  it can arrive as 255 unbroken characters, and a crumb that
                  wraps to four lines stops being a trail. The heading below is
                  where the whole string is read.

                  'Document' while it loads — a stable fallback, so the trail
                  does not appear a beat after the heading it sits above.
                */}
                <span
                  aria-current="page"
                  className="max-w-[40ch] truncate font-medium text-text-default"
                >
                  {doc ? doc.originalFilename : 'Document'}
                </span>
              </li>
            </ol>
          </nav>
        }
        // The filename is the page's identity, so it is the `<h1>`. It comes
        // from whoever uploaded the file and is truncated to 255 characters
        // rather than reshaped, so it can arrive as one unbroken token — and a
        // heading does not break mid-word on its own. Without `break-words` the
        // `<h1>` overflows and pushes the whole page sideways on a phone.
        title={doc ? <span className="break-words">{doc.originalFilename}</span> : 'Document'}
        description={
          doc
            ? `${TYPE_LABELS[doc.type]} · ${formatBytes(doc.sizeBytes)} · uploaded ${formatRelative(doc.createdAt)}`
            : undefined
        }
      />

      {!isValidId ? <ErrorState error={MALFORMED_ID} /> : null}

      {/*
        `detail.isPending` stays true forever while the query is disabled, so it
        is only consulted once the id is known to be usable.
      */}
      {isValidId && detail.isPending ? <LoadingBlock label="Loading document" rows={4} /> : null}

      {detail.error && !doc ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : null}

      {doc ? (
        <>
          <StatusCard
            doc={doc}
            mayRetry={can(user, 'document:retry')}
            retrying={retry.isPending}
            retryError={retry.error}
            refreshError={detail.error}
            onRetry={handleRetry}
          />

          <Section id="properties" title="Properties">
            <Card>
              <DescriptionList
                items={[
                  { label: 'Subsidiary', value: <SubsidiaryLabel id={doc.subsidiaryId} showName /> },
                  {
                    label: 'File type',
                    value: (
                      <>
                        {TYPE_LABELS[doc.type]}{' '}
                        {/*
                          The RESOLVED mime from a magic-byte sniff, not what the
                          browser declared — an ordinary .xlsx legitimately reads
                          as 'application/zip', which is why no UI decision on
                          this page is taken from it.
                        */}
                        <span className="text-text-muted">({doc.mimeType})</span>
                      </>
                    ),
                  },
                  { label: 'Size', value: formatBytes(doc.sizeBytes) },
                  { label: 'Uploaded', value: formatDateTime(doc.createdAt) },
                  {
                    label: 'Uploaded by',
                    /*
                      The API returns a user id and does not expand it, and
                      `GET /users/:id` is admin-only — resolving a name here
                      would 403 for most of the people who can read this page.
                    */
                    value:
                      doc.uploadedBy === user?.id ? (
                        'You'
                      ) : (
                        <span className="font-mono text-xs break-all">{doc.uploadedBy}</span>
                      ),
                  },
                  {
                    label: 'Processed',
                    value: doc.processedAt ? formatDateTime(doc.processedAt) : 'Not yet',
                  },
                  {
                    label: 'OCR confidence',
                    /*
                      `=== null`, not falsy: 0 is a real reading and the usual
                      one for a scanned or encrypted PDF, which is exactly the
                      case a reader most needs to see.
                    */
                    value:
                      doc.ocrConfidence === null
                        ? 'Not measured yet'
                        : `${Math.round(doc.ocrConfidence * 100)}%${
                            doc.ocrConfidence === 0 ? ' — nothing readable was found' : ''
                          }`,
                  },
                  {
                    label: 'Processing attempts',
                    // Incremented when the worker CLAIMS the job, not at
                    // enqueue, so a freshly failed document reads 1, not 0.
                    value: `${doc.processingAttempts} of 3`,
                  },
                  {
                    label: 'Tags',
                    value:
                      doc.tags.length === 0 ? (
                        '—'
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {doc.tags.map((tag, index) => (
                            <span
                              // Auto tags (subsidiary code, month, type) are
                              // merged with operator tags, so a duplicate is
                              // possible and the index keeps the key unique.
                              key={`${tag}-${index}`}
                              className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-text-muted"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      ),
                  },
                  {
                    label: 'Document id',
                    value: <span className="font-mono text-xs break-all">{doc.id}</span>,
                  },
                ]}
              />
            </Card>
          </Section>

          <ExtractedFieldTable doc={doc} />

          <DocumentTextPanel doc={doc} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The live half of the page.
 *
 * Wrapped in a polite live region because it changes without anyone touching
 * it: the detail query polls, and a sighted user watches 'Processing' become
 * 'Validated' while a screen-reader user is told nothing at all.
 */
function StatusCard({
  doc,
  mayRetry,
  retrying,
  retryError,
  refreshError,
  onRetry,
}: {
  doc: Document;
  mayRetry: boolean;
  retrying: boolean;
  retryError: unknown;
  /** A poll that failed while the document itself is still on screen. */
  refreshError: unknown;
  onRetry: () => void;
}) {
  return (
    <Card>
      <div role="status" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge status={doc.status} />
          {doc.requiresReview ? <ReviewRequiredFlag /> : null}
          {doc.injectionSuspected ? <InjectionFlag /> : null}
        </div>
        <p className="mt-2 text-sm text-text-muted">{statusExplanation(doc)}</p>
        {/*
          Inside the live region on purpose: a poll failing is a change to what
          this card is asserting, and a reader who cannot see the page would
          otherwise be told the status is current when it may not be.
        */}
        {refreshError ? (
          <p className="mt-2 text-sm text-text-muted">
            Last refresh failed: {userMessage(refreshError)} What you see here may be out of date.
          </p>
        ) : null}
      </div>

      {doc.status === 'failed' ? (
        <div className="mt-4 flex flex-col items-start gap-3">
          {/*
            Only read while the status is 'failed'. The body of a retry carries
            the PREVIOUS failure string, and although that body is never written
            to the cache, keeping this inside the failed branch means a stale
            message can never appear beside a queued document.
          */}
          {doc.processingError ? (
            <div className="w-full rounded-md bg-surface-muted p-3">
              <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
                Extractor error
              </p>
              <ProseText>{doc.processingError}</ProseText>
            </div>
          ) : null}

          {canRetryDocument(doc) ? (
            mayRetry ? (
              <Button
                variant="primary"
                size="sm"
                icon={<RefreshIcon size={14} />}
                busy={retrying}
                busyLabel="Queuing…"
                onClick={onRetry}
              >
                Retry processing
              </Button>
            ) : (
              <p className="text-sm text-text-muted">
                A CIL user or an administrator can send this document back through the extractor.
              </p>
            )
          ) : (
            /*
              Three attempts spent. This is terminal — no endpoint moves a
              document out of it — so there is no button here, disabled or
              otherwise: a greyed-out Retry implies a state that could become
              available, and this one never will.
            */
            <p className="text-sm text-text-muted">
              <span className="font-medium text-text-default">Needs manual review.</span> All three
              processing attempts have been used and there is no automatic path out of this state.
              The original file can still be downloaded below.
            </p>
          )}

          {retryError ? <InlineError>{retryMessage(retryError)}</InlineError> : null}
        </div>
      ) : null}
    </Card>
  );
}

function statusExplanation(doc: Document): string {
  switch (doc.status) {
    case 'queued':
      /*
        Not only the state after an upload: `recoverStuckDocuments()` puts a
        document stranded in 'processing' back to 'queued' on boot, so this can
        follow 'processing' rather than precede it.
      */
      return 'Waiting for the extractor to pick this file up. This page checks again every few seconds.';
    case 'processing':
      return 'The extractor is reading this file. This page checks again every few seconds.';
    case 'validated':
      return doc.processedAt
        ? `Processed ${formatDateTime(doc.processedAt)}.`
        : 'The extractor finished with this file.';
    case 'failed':
      return 'The extractor could not finish this file.';
  }
}

function retryMessage(error: unknown): string {
  if (error instanceof ApiError) {
    /*
      §9.1: hiding the control is UX, never authorisation. A 403 landing here
      means the capability table drifted from the server's `roleGuard`, or the
      role changed mid-session — either way, name the reason.
    */
    if (error.status === 403) {
      return 'Your role cannot retry processing. Ask a CIL user or an administrator.';
    }
    /*
      The server re-checks `failed && attempts < 3` at the moment of the call,
      and the poll can move this row under an open page.
    */
    if (error.code === 'INVALID_REQUEST' || error.code === 'CONFLICT') {
      return 'This document can no longer be retried. Reload the page to see its current state.';
    }
  }
  return userMessage(error);
}
