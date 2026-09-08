'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, InlineError, LoadingBlock } from '@/components/ui/Feedback';
import { AlertTriangleIcon, DownloadIcon } from '@/components/ui/Icon';
import { Card, ProseText, Section } from '@/components/ui/Layout';
import { isDocumentPending } from '@/components/ui/StatusBadge';
import { useDocumentBlob, useDocumentChunks, type Document } from '@/features/documents/api';
import { userMessage } from '@/lib/api/errors';

/** How many passages to put in the DOM at once. */
const PAGE_SIZE = 25;

/**
 * The original file, and the text the extractor read out of it — PRD §5.4.
 *
 * ─── WHY THERE IS NO EMBEDDED VIEWER ────────────────────────────────────────
 * `GET /documents/:id/file` cannot be an `<iframe src>` or an `<embed>`: the
 * browser will not attach the bearer token to a subresource load, and the route
 * answers `Content-Disposition: attachment` regardless. A viewer would need the
 * bytes fetched by script and handed to a bundled PDF renderer — a large
 * dependency that still could not open a `.tif`, an `.xlsx` or an encrypted
 * PDF, which are three of the four types this app accepts. So v1 offers the
 * download and the extracted text, and says so, rather than shipping a preview
 * pane that is blank for most documents.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function DocumentTextPanel({ doc }: { doc: Document }) {
  /**
   * The worker finishing does not invalidate this key — only a retry does — and
   * an empty array fetched while the document was queued stays fresh for five
   * minutes. Gate the read on the document being at rest.
   */
  const stillProcessing = isDocumentPending(doc.status);
  const { data, isPending, error, refetch } = useDocumentChunks(doc.id, {
    enabled: !stillProcessing,
  });

  const chunks = data ?? [];
  const [visible, setVisible] = useState(PAGE_SIZE);
  const shown = chunks.slice(0, visible);

  let body: ReactNode;
  if (stillProcessing) {
    body = (
      <EmptyState
        title="Extraction is still running"
        description="The text appears here once the extractor finishes with this document."
      />
    );
  } else if (error) {
    body = <ErrorState error={error} onRetry={() => void refetch()} />;
  } else if (isPending) {
    // Only reachable while the query is enabled: a disabled query stays
    // `isPending` forever, so the gate above has to be tested first.
    body = <LoadingBlock label="Loading document text" rows={3} />;
  } else if (chunks.length === 0) {
    body = <EmptyState title="No text was extracted" description={emptyExplanation(doc)} />;
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <ol className="flex flex-col gap-3">
          {shown.map((chunk) => (
            /*
              Chunk ids are not stable across a reprocess — a retry deletes and
              re-inserts every one — so this key is good for a render pass and
              for nothing that outlives it.
            */
            <li key={chunk.id} className="rounded-lg border border-border bg-surface p-4">
              <p className="text-xs tracking-wide text-text-muted uppercase">
                {/* `chunkIndex` is 0-based on the wire; readers count from one. */}
                Passage {chunk.chunkIndex + 1}
                {chunk.pageNumber === null ? '' : ` · page ${chunk.pageNumber}`}
              </p>
              <ProseText className="mt-1">{chunk.text}</ProseText>
            </li>
          ))}
        </ol>

        {/*
          Not `LoadMore` — that control belongs to cursor lists, and it would
          claim there is another request to make when the whole array is already
          in memory. This just puts fewer nodes in the DOM: the chunk endpoint
          is unpaginated and uncapped, so a long PDF arrives as thousands of
          passages at once, and rendering them all costs a visible freeze. A
          virtualiser would be the alternative, and it is a dependency this
          screen does not otherwise need.
        */}
        <div className="flex flex-col items-center gap-2 pt-1">
          <p aria-live="polite" className="text-sm text-text-muted">
            Showing {shown.length.toLocaleString('en-IN')} of{' '}
            {chunks.length.toLocaleString('en-IN')} passages
          </p>
          {visible < chunks.length ? (
            <Button variant="secondary" size="sm" onClick={() => setVisible((n) => n + PAGE_SIZE)}>
              Show more text
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <Section
      id="document-text"
      title="Original and extracted text"
      description="The plain text the extractor read, in the order it read it. Every figure above was pulled out of these passages."
    >
      <OriginalFile doc={doc} />

      {doc.injectionSuspected ? (
        <Card muted>
          <div className="flex items-start gap-2">
            <AlertTriangleIcon size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-text-default">This document contains suspicious text</p>
              {/*
                §9.5. The rules that fired are deliberately not exposed by the
                API — publishing them tells an author which patterns to avoid —
                so the flag itself is the whole of what can be said.
              */}
              <p className="mt-1 text-sm text-text-muted">
                Something in it reads like an instruction aimed at the AI rather than like content.
                Treat any figure taken from this document as unverified until a person has checked
                the passage it came from.
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {body}
    </Section>
  );
}

/** Mirrors `Button`'s `secondary`/`sm` styling — see the note in `OriginalFile`. */
const DOWNLOAD_LINK_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-surface ' +
  'px-2.5 py-1.5 text-sm font-semibold text-text-default transition-colors hover:bg-surface-muted';

/**
 * Fetch the original bytes, then offer them as a real link.
 *
 * Two steps, deliberately. The endpoint needs an `Authorization` header, so the
 * bytes have to be fetched by script before there is anything to link to; the
 * alternative — synthesising an anchor and clicking it from an effect once the
 * blob lands — is a download the user did not visibly initiate, and when a
 * browser blocks it there is nothing left on screen to click. A visible link
 * also restores right-click "Save link as" and shows the file name.
 */
function OriginalFile({ doc }: { doc: Document }) {
  const [requested, setRequested] = useState(false);
  const file = useDocumentBlob(doc.id, { enabled: requested });

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-words text-text-default">{doc.originalFilename}</p>
          <p className="mt-0.5 text-sm text-text-muted">
            The original is a download, not a preview — it cannot be opened inside this page.
          </p>
        </div>

        {file.url ? (
          /*
            A plain `<a>`, not `ButtonLink`: that component wraps `next/link`,
            which intercepts the click for a client-side navigation, and a
            `blob:` URL is not a route. `safeUrl()` is not applied either — it
            guards URLs that arrived in document or model text, and `blob:` is
            correctly absent from its allowlist, so running this one through it
            would return null and disable the download. This URL is minted by
            `URL.createObjectURL` from bytes we fetched ourselves, and the hook
            revokes it when this component unmounts.
          */
          <a href={file.url} download={doc.originalFilename} className={DOWNLOAD_LINK_CLASS}>
            <DownloadIcon size={14} />
            Save file
          </a>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<DownloadIcon size={14} />}
            busy={file.isPending}
            busyLabel="Fetching…"
            onClick={() => {
              setRequested(true);
              /*
                A second press after a failure has to ask again explicitly: the
                query sets `retry: false`, because the global policy's two
                retries would mean downloading the file up to three times.
                Note the spinner does not return on that second press —
                `isPending` maps to `isLoading`, which is false once a query has
                errored — so the error line below stays put until the new
                attempt resolves. A local busy flag would show a spinner that
                the query could not switch off.
              */
              if (file.isError) file.refetch();
            }}
          >
            {file.isError ? 'Try again' : 'Download original'}
          </Button>
        )}
      </div>

      {/*
        The blob route answers with bytes on success and JSON on failure, and
        `fetchDocumentBlob` has already turned the second into an ApiError — so
        the ordinary message mapping applies, including the flat "Not found."
        that a 404 must render as here exactly as it does anywhere else.
      */}
      {file.isError ? (
        <div className="mt-3">
          <InlineError>{userMessage(file.error)}</InlineError>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Why a settled document can hold no text.
 *
 * For a VALIDATED document this is the EXPECTED outcome for every image, `.tif`
 * scan and `.xlsx`, and for any scanned or encrypted PDF: the extractor writes
 * no chunks, the document still reaches 'validated', and it is flagged for
 * review. Never an error state.
 */
function emptyExplanation(doc: Document): string {
  /*
    A failed document is empty because the extractor stopped, not because the
    file had nothing in it. It has to be answered before the cases below, all
    of which describe a run that completed.
  */
  if (doc.status === 'failed') {
    return 'Extraction did not finish for this document, so no text was written down. The status above says what happened; the original can still be downloaded.';
  }
  if (doc.type === 'image' || doc.type === 'scan') {
    return 'Images and .tif scans hold no machine-readable text, so there is nothing for the extractor to write down. Download the original above to read it.';
  }
  if (doc.ocrConfidence === 0) {
    return 'Nothing readable was found in this file — a scanned or encrypted PDF looks like this. Download the original above to read it.';
  }
  return 'The extractor wrote no text for this file. Spreadsheet workbooks are the common case: the original downloads fine, but its cells never become passages.';
}
