'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/ui/Feedback';
import { FileTextIcon, SourceLinkIcon } from '@/components/ui/Icon';
import { Card, DescriptionList, ProseText } from '@/components/ui/Layout';
import type { QueryCitation, QueryRetrievalStats } from '@/features/queries/api';

/**
 * The passages an answer was allowed to draw on — PRD §13.
 *
 * This list is the product's central claim: every figure traces back to a page
 * of a real document. So each entry shows the source verbatim — filename, page,
 * section, the server-sliced quote — and links to the document itself.
 *
 * Two things this component deliberately does NOT do:
 *
 *   1. It never renders `relevance` as a confidence meter. It is a MongoDB
 *      `$text` score, and it is legitimately 0 for every citation when the
 *      answer came off the pinned-document fallback path
 *      (retrieval.service.ts:171). A bar or a percentage would read as "how
 *      sure the model is", which is a claim nobody made.
 *   2. It never re-parses the answer prose. Numbers come out of the text via
 *      `parseAnswerSegments`; everything else comes off the citation objects.
 *
 * The array is hard-capped at 20 entries server-side (`MAX_CITATIONS`,
 * citation.ts:38), so this is sized for at most 20 rows and needs no paging.
 */

/** Ids from the API are 24-hex. One that is not gets a 400 from the API rather
 *  than a 404, so a malformed id is never put into a route. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * The route a citation points at, or null when it cannot safely be linked.
 *
 * Exported because the `[n]` markers inside the answer prose must resolve to
 * exactly the same target as the entry in this list; two call sites building
 * the href separately is how the two drift apart.
 *
 * `?page=` is a hint for the document viewer. The page number is also printed
 * in the link's accessible name and in the entry below, so nothing is lost if
 * the viewer ignores the parameter.
 */
export function citationHref(citation: QueryCitation): string | null {
  if (!OBJECT_ID.test(citation.documentId)) return null;
  const page = citation.pageNumber;
  return page !== null && Number.isInteger(page)
    ? `/documents/${citation.documentId}?page=${page}`
    : `/documents/${citation.documentId}`;
}

/** "annual-report.pdf, page 14" — the human name of a source, for link labels. */
export function citationSourceLabel(citation: QueryCitation): string {
  return citation.pageNumber === null
    ? citation.documentFilename
    : `${citation.documentFilename}, page ${citation.pageNumber}`;
}

export function CitationList({
  citations,
  retrieval,
}: {
  citations: QueryCitation[];
  /**
   * Detail-shape stats. Note the field name: the list shape calls the same
   * number `discardedCitationCount`, so a component fed a summary row silently
   * reads `undefined` here (query.service.ts:200 vs :235).
   */
  retrieval: QueryRetrievalStats;
}) {
  return (
    <div className="flex flex-col gap-4">
      {citations.length === 0 ? (
        <EmptyState
          title="No sources cited"
          description="No passage in the documents you can access was used to support this answer."
        />
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Each passage is quoted as it appears in the source document. The match score is a
            text-search score from retrieval — not a confidence rating — and is 0 when the passage
            came from a document pinned to the question.
          </p>
          <ol className="flex flex-col gap-3">
            {citations.map((citation) => (
              <li key={citation.ordinal}>
                <CitationCard citation={citation} />
              </li>
            ))}
          </ol>
        </>
      )}

      <RetrievalStats retrieval={retrieval} />
    </div>
  );
}

function CitationCard({ citation }: { citation: QueryCitation }) {
  const href = citationHref(citation);

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 rounded-sm bg-sih-blue/10 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-sih-blue">
            <span className="sr-only">Source </span>[{citation.ordinal}]
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 font-medium break-words text-text-default">
            <FileTextIcon size={14} className="shrink-0 translate-y-0.5 text-text-muted" />
            {citation.documentFilename}
          </span>
        </p>

        {/* A documentId that is not a usable id renders as no link at all
            rather than a dead one — an href that looks clickable and then 400s
            teaches people to stop clicking the citations. */}
        {href ? (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm text-sih-blue hover:underline"
          >
            <SourceLinkIcon size={14} />
            Open source
            <span className="sr-only"> — {citationSourceLabel(citation)}</span>
          </Link>
        ) : null}
      </div>

      {/*
        Page and section are null whenever the source chunk carried neither.
        The absence is stated rather than hidden: on a screen whose whole point
        is traceability, a silently missing page reads as a page we chose not to
        show. `chunkIndex` is the only locator left in that case, and it is
        0-based on the wire.
      */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span>
          {citation.pageNumber === null ? 'Page not recorded' : `Page ${citation.pageNumber}`}
        </span>
        {citation.section ? <span className="break-words">Section: {citation.section}</span> : null}
        <span>Passage {citation.chunkIndex + 1}</span>
        <span className="tabular-nums">Match score {citation.relevance.toFixed(2)}</span>
      </p>

      {/* Verbatim document text. `ProseText` renders it as a text node with
          `whitespace-pre-wrap`; there is no markup in it to preserve, and a
          renderer here would manufacture the XSS surface §9.13 forbids. */}
      <blockquote className="border-l-2 border-border pl-3">
        <ProseText className="text-text-muted">{citation.quote}</ProseText>
      </blockquote>
    </Card>
  );
}

/**
 * What retrieval did, in numbers.
 *
 * Shown even when there are no citations, because that is exactly when it
 * explains itself: `candidatesConsidered` can be greater than zero while
 * `passagesUsed` is zero, which is the difference between "nothing was found"
 * and "things were found and none of them survived validation".
 */
function RetrievalStats({ retrieval }: { retrieval: QueryRetrievalStats }) {
  return (
    <Card muted className="flex flex-col gap-3">
      <DescriptionList
        columns={2}
        items={[
          {
            label: 'Candidates considered',
            value: retrieval.candidatesConsidered.toLocaleString('en-IN'),
          },
          { label: 'Passages used', value: retrieval.passagesUsed.toLocaleString('en-IN') },
          { label: 'Passages withheld', value: retrieval.passagesWithheld.toLocaleString('en-IN') },
          {
            label: 'Citations discarded',
            value: retrieval.discardedCitations.toLocaleString('en-IN'),
          },
        ]}
      />
      {/* Stated in the reader's terms. A PRD section number is meaningless to a
          user and reads as a defect leaking through; the citation belongs here,
          in the comment. Withholding is the §9.5 ingestion-time content scan. */}
      <p className="text-xs text-text-muted">
        Withheld passages were removed by the content scanner before the model saw them. Discarded
        citations were dropped while the answer was checked against its sources.
      </p>
    </Card>
  );
}
