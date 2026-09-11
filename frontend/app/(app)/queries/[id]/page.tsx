'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Card, DescriptionList, PageHeader, ProseText, Section } from '@/components/ui/Layout';
import { InjectionFlag, QueryStatusBadge, ReviewStatusBadge } from '@/components/ui/StatusBadge';
import { AnswerView } from '@/features/queries/components/AnswerView';
import { CitationList } from '@/features/queries/components/CitationList';
import { FollowUpChat } from '@/features/queries/components/FollowUpChat';
import { ReviewPanel } from '@/features/queries/components/ReviewPanel';
import { useQueryDetail, type QueryDetail } from '@/features/queries/api';
// The same bare-id attribution the report screen renders, exported for exactly
// this reuse — see its docblock for why no name is looked up.
import { UserRef } from '@/features/reports/components/VersionHistory';
import { ApiError, NOT_FOUND_MESSAGE, userMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/datetime';

/**
 * One query — question, answer, sources, review. PRD §5.7, §8.1, §13.
 *
 * The screen is a poller by construction: asking is asynchronous, so most
 * visits arrive on a row that has no answer yet and `useQueryDetail` refetches
 * until the worker finishes. It stops on all four resting statuses, `failed`
 * included — a client waiting for `answered` would poll a stationary row for
 * ever — and it tolerates the status moving BACKWARDS, which happens with no
 * user action when `recoverStuckQueries()` runs on boot.
 */

/** `:id` must be 24-hex or the API answers 400 VALIDATION_ERROR rather than
 *  404 (query.schema.ts:69), which would surface as "something went wrong" for
 *  what is really a bad link. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * A malformed id is the same outcome as an unknown one, and gets the same copy.
 *
 * Built as a real `ApiError` so `ErrorState` produces the canonical "Not found."
 * — the 404 wording is deliberately identical for "no such row" and "a row in a
 * subsidiary you do not hold", and writing bespoke copy here is how that
 * distinction leaks back out (§9, `utils/authorization.ts`).
 */
const MALFORMED_ID_ERROR = new ApiError(404, {
  code: 'NOT_FOUND',
  message: NOT_FOUND_MESSAGE,
});

export default function QueryDetailPage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();

  const routeId = typeof params.id === 'string' ? params.id : undefined;
  const id = routeId && OBJECT_ID.test(routeId) ? routeId : undefined;

  // `useQueryDetail` is disabled while `id` is undefined, so the hook order is
  // stable across the invalid-id branch below.
  const { data, isPending, error, refetch } = useQueryDetail(id);

  /**
   * A 404 arriving on a POLL means the row went away under an open page — soft
   * deleted, or a subsidiary grant revoked. This screen polls hard, so it is
   * the one most likely to be holding a cached copy of something the reader may
   * no longer see; that copy is dropped rather than left on screen beside a
   * "not found" line. Every OTHER refresh failure keeps the content and says so
   * below — a transient blip must not blank a readable answer.
   */
  const notFound = error instanceof ApiError && error.code === 'NOT_FOUND';
  const query = notFound ? undefined : data;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        /*
          UX4G's breadcrumb pattern, in place of the single back-link that stood
          here. Their rules are all structural: the trail sits at the TOP of the
          page, EVERY crumb is clickable except the one you are on, and the
          separator is clear. The `<nav>`/`<ol>` pair is what makes it a list of
          steps to a screen reader rather than a loose link, `aria-current`
          marks where the trail ends, and the separator is `aria-hidden` so it is
          never announced as a word between two names. The back-pointing chevron
          went with it: a `‹` and a `›` in one row leave no way to tell which
          glyph is the separator.

          The link is `min-h-11` — 44px, WCAG 2.5.5 — which a text-sized crumb
          misses at its natural 24px line box. Its label is already wider than
          44px, so height was the only dimension short of the rule, and there is
          no horizontal padding because it would push the crumb out of optical
          alignment with the `<h1>` beneath it. 16px rather than 14px because
          UX4G sizes a navigation item at Label/XL.
        */
        breadcrumb={
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
              <li>
                <Link
                  href="/queries"
                  className="inline-flex min-h-11 items-center text-sih-blue underline underline-offset-2 transition-colors duration-150 hover:text-sih-blue-dark motion-reduce:transition-none"
                >
                  All queries
                </Link>
              </li>
              <li className="flex min-w-0 items-center gap-x-2">
                <span aria-hidden="true" className="text-text-muted">
                  &rsaquo;
                </span>
                {/*
                  The question, clipped to one line the way the list screen
                  clamps it to two — it runs to 2000 characters, and a crumb that
                  wraps down the page has stopped being a trail. The `<h1>` below
                  is where it is read in full.

                  'Query' while it loads: a stable fallback, so the trail does
                  not appear a beat after the heading it sits above.
                */}
                <span
                  aria-current="page"
                  className="max-w-[40ch] truncate font-medium text-text-default"
                >
                  {query ? query.questionText : 'Query'}
                </span>
              </li>
            </ol>
          </nav>
        }
        // The question IS the page's identity, so it is the `<h1>` rather than
        // a generic "Query" — a screen reader's heading jump then lands on the
        // thing the reader came for. It can run to 2000 characters, hence
        // `break-words` and `whitespace-pre-wrap` on a heading that would
        // otherwise push the page sideways.
        title={
          query ? (
            <span className="break-words whitespace-pre-wrap">{query.questionText}</span>
          ) : (
            'Query'
          )
        }
        description={
          query
            ? `Asked ${formatDateTime(query.createdAt)}${
                user && query.askedBy === user.id ? ' by you' : ''
              }`
            : undefined
        }
      />

      {!id ? <ErrorState error={MALFORMED_ID_ERROR} /> : null}

      {id && isPending ? <LoadingBlock label="Loading query" rows={4} /> : null}

      {/*
        A failure with nothing to show replaces the page; a failure while a row
        is already on screen does not. This view polls, so a single failed tick
        must not throw away an answer the reader is part way through — it says
        the updates stopped and leaves the content alone.
      */}
      {error && !query ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {query ? (
        <>
          {/*
            Stated, not alarmed: a poll failing is nothing the reader did, and
            `InlineError` is reserved for a failure their own action caused.
            The same wording as documents/[id] and reports/[id], so a refresh
            that stops means one thing across the app.
          */}
          {error ? (
            <p role="status" className="text-sm text-text-muted">
              Last refresh failed: {userMessage(error)} What you see here may be out of date.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <QueryStatusBadge status={query.status} />
            <ReviewStatusBadge status={query.reviewStatus} />
            {query.isParliamentary ? (
              <Badge tone="info" srPrefix="Question style">
                Parliamentary
              </Badge>
            ) : null}
            {/* A property of the SOURCE material, not of the answer — §9.5. */}
            {query.injectionSuspected ? <InjectionFlag /> : null}
          </div>

          {/*
            The two stateful panels are keyed on the query id, the same way the
            report screen keys `SectionEditor`.

            Next reuses this page component across `[id]` changes, so anything
            below it that seeds `useState` from the row — `ReviewPanel`'s three
            fields — or that holds mutation state — `AnswerView`'s retry error —
            survives the navigation. It only LOOKS safe because `data` usually
            goes undefined for a render while the next row loads, which unmounts
            the whole branch; the moment the next row is already in cache that
            gap disappears and the previous query's draft is diffed against, and
            then PATCHed onto, a different query. The key makes the reset
            unconditional instead of dependent on a cache miss.
          */}
          <Section id="answer" title="Answer">
            <AnswerView key={query.id} query={query} />
            {/*
              Inside the SAME section, deliberately: the follow-up conversation
              is about this answer and belongs with it, not on a screen of its
              own. It renders nothing until there is an answer to discuss, and
              nothing at all when no assistant key is configured.

              Keyed on the query id for the same reason `AnswerView` is — moving
              between two queries must start a new conversation rather than
              carry one query's exchange onto another's answer.
            */}
            <FollowUpChat key={`chat-${query.id}`} query={query} />
          </Section>

          {/*
            Citations exist only where an answer does. `failed` and
            `dead_lettered` carry an empty array for the same reason they carry
            no text, and rendering "No sources cited" over a failure would
            describe the corpus when the problem was the worker.
          */}
          {query.status === 'answered' || query.status === 'unsupported' ? (
            <Section
              id="citations"
              title="Citations"
              description="Every passage this answer was allowed to draw on, filtered to the documents you can access."
            >
              <CitationList citations={query.citations} retrieval={query.retrieval} />
            </Section>
          ) : null}

          <Section id="review" title="Review">
            {/* UX only (§9.1). The endpoint refuses an `moc_official` outright
                and `ReviewPanel` still handles a 403 from every save. */}
            {can(user, 'query:review') ? (
              <ReviewPanel key={query.id} query={query} />
            ) : (
              <ReviewSummary query={query} />
            )}
          </Section>

          <Section id="details" title="Details">
            <Card muted>
              <DescriptionList
                columns={2}
                items={[
                  { label: 'Asked', value: formatDateTime(query.createdAt) },
                  {
                    label: 'Answered',
                    // Null on BOTH failure paths as well as while in flight —
                    // stamped only by the worker's `finish()`.
                    value: query.answeredAt ? formatDateTime(query.answeredAt) : 'Not answered',
                  },
                  { label: 'Last updated', value: formatDateTime(query.updatedAt) },
                  {
                    label: 'Asked by',
                    /*
                      `askedBy` is a bare 24-hex id — nothing in this module
                      expands it, and `GET /users/:id` is admin-only, so a name
                      here would 403 for the people most likely to be reading.
                      `UserRef` already encodes that: you, or the raw id. It is
                      NOT collapsed to "Another user" — an id someone can quote
                      into a support request is the honest answer, and it is
                      what the other two detail screens show.
                    */
                    value: <UserRef id={query.askedBy} />,
                  },
                  {
                    label: 'Subsidiaries in scope',
                    /*
                      `contextScope.subsidiaryIds` is the authorization scope the
                      answer was resolved against. The flat `subsidiaryId` is a
                      denormalised convenience that is null for every
                      multi-subsidiary ask, so it is not what gets rendered.
                    */
                    value: (
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {query.contextScope.subsidiaryIds.map((subsidiaryId) => (
                          <SubsidiaryLabel key={subsidiaryId} id={subsidiaryId} />
                        ))}
                      </span>
                    ),
                  },
                  {
                    label: 'Pinned documents',
                    value:
                      query.contextScope.documentIds.length === 0
                        ? 'None — every document in scope was searched'
                        : `${query.contextScope.documentIds.length} chosen when the question was asked`,
                  },
                  {
                    label: 'Worker attempts',
                    // Incremented when the worker CLAIMS the job, so a freshly
                    // queued query legitimately reads 0.
                    value: query.attempts,
                  },
                  {
                    label: 'Linked report',
                    value:
                      query.linkedReportId && OBJECT_ID.test(query.linkedReportId) ? (
                        <Link
                          href={`/reports/${query.linkedReportId}`}
                          className="text-sih-blue hover:underline"
                        >
                          Open report
                        </Link>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
            </Card>
          </Section>
        </>
      ) : null}
    </div>
  );
}

/**
 * The review, for a reader who cannot edit it — an MoC Official, who is refused
 * `PATCH /queries/:id` at the route.
 *
 * The official response is the part they came for: it is the answer the
 * department stands behind, and it is a different field from the model's
 * `responseText` rendered above.
 */
function ReviewSummary({ query }: { query: QueryDetail }) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ReviewStatusBadge status={query.reviewStatus} />
        {query.reviewedAt ? (
          <span className="text-sm text-text-muted">
            Reviewed {formatDateTime(query.reviewedAt)}
          </span>
        ) : null}
      </div>

      {query.officialResponseText ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
            Official response
          </p>
          <ProseText>{query.officialResponseText}</ProseText>
        </div>
      ) : (
        <p className="text-sm text-text-muted">No official response has been written yet.</p>
      )}

      {query.reviewNote ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Review note</p>
          <ProseText>{query.reviewNote}</ProseText>
        </div>
      ) : null}
    </Card>
  );
}
