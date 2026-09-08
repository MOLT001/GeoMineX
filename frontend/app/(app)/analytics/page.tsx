'use client';

import { useState, type ReactNode } from 'react';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { FormError, fieldErrorsOf } from '@/components/ui/Field';
import { Card, DescriptionList, PageHeader, Section } from '@/components/ui/Layout';
import {
  hasSection,
  useAnalytics,
  type AnalyticsInclude,
  type AnalyticsResult,
  type AnalyticsSectionKey,
  type AnalyticsSlice,
} from '@/features/analytics/api';
import {
  AnalyticsFilterBar,
  DEFAULT_ANALYTICS_FILTERS,
  toAnalyticsParams,
  type AnalyticsFilters,
} from '@/features/analytics/components/AnalyticsFilterBar';
import {
  NO_FIGURE,
  StatusBreakdowns,
  SubsidiaryBreakdown,
  TrendCharts,
  formatCount,
  formatPercent,
  formatSeconds,
} from '@/features/analytics/components/AnalyticsCharts';
import { ApiError, userMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, formatRelative } from '@/lib/datetime';

/**
 * Analytics — PRD §5.3.
 *
 * One GET, six filters, and a response that is PARTIAL BY DESIGN: `include`
 * selects which of the four sections come back, and the ones it left out arrive
 * as `null`. A null section means "you did not ask for it", which is a
 * different statement from a section full of zeroes — so every block below is
 * gated on the section being present rather than rendered as an empty frame.
 *
 * Not admin-only. `analytics.routes.ts:26-28` deliberately carries no
 * `roleGuard` ("there is no role that may not read analytics"); scope does the
 * gating instead, and a non-admin holding no grants still gets a 200 with zero
 * counts, which the body calls out rather than presenting as measurement.
 */
export default function AnalyticsPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>(DEFAULT_ANALYTICS_FILTERS);
  const { data, isPending, isPlaceholderData, error, refetch } = useAnalytics(
    toAnalyticsParams(filters),
  );

  const apiError = error instanceof ApiError ? error : null;
  const rateLimited = apiError?.code === 'RATE_LIMIT_EXCEEDED';

  /*
   * Two 400s, with different bodies, and the split is the whole reason this is
   * not one branch (`analytics.schema.ts:1-10`). VALIDATION_ERROR carries
   * `error.fields`, which the filter bar has already attached to the offending
   * control. INVALID_REQUEST — "Range ends before it starts", "Range covers N
   * buckets; the maximum is M" — carries no fields at all, so a screen that
   * only rendered field errors would reject the request in silence.
   */
  const rangeRejected = apiError?.code === 'INVALID_REQUEST';
  const fieldsRejected = apiError?.code === 'VALIDATION_ERROR';
  const showErrorState = error !== null && !rangeRejected && !fieldsRejected;

  /*
   * Zod keys its messages by PARAM NAME, but a failure at the query object's own
   * level is keyed by the literal 'query' (`middleware/validate.ts:51`) — a
   * message that belongs to no control, so the filter bar's `fieldErrorsOf`
   * lookups never place it. Unread, it is thrown away and the reader is told to
   * check filters that are every one of them showing as fine.
   */
  const objectLevelRejection = fieldErrorsOf(error)('query');

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Analytics"
        description="Extraction accuracy, drafting time saved and automation coverage across the subsidiaries you can access. Every figure is bucketed in IST, on the Indian fiscal year."
      />

      <div className="flex flex-col gap-3">
        <AnalyticsFilterBar value={filters} onChange={setFilters} error={error} />

        {fieldsRejected ? (
          <FormError>
            {objectLevelRejection ?? `${userMessage(apiError)} — check the filters above.`}
          </FormError>
        ) : null}

        {rangeRejected ? (
          <FormError>
            {userMessage(apiError)} The limit counts every bucket the window touches, partial ones
            at each end included, so it depends on the granularity: shorten the range, or bucket by
            fiscal quarter instead of month.
          </FormError>
        ) : null}
      </div>

      {showErrorState ? (
        <div className="flex flex-col gap-3">
          {/*
            A 404 here does NOT mean "no analytics" — it means a non-admin asked
            for a subsidiary they do not hold (`utils/authorization.ts:46-54`).
            `ErrorState` renders the flat "Not found." for it, and the remedy
            below is offered without naming the subsidiary back at them, which
            would rebuild the existence oracle the 404-not-403 convention hides.
          */}
          <ErrorState error={error} onRetry={rateLimited ? undefined : () => void refetch()} />

          {rateLimited ? (
            <p className="text-sm text-text-muted">
              This screen shares a per-minute request budget with Topics, and a rejected request is
              never retried automatically. Wait a moment before asking again.
            </p>
          ) : null}

          {apiError?.code === 'NOT_FOUND' && filters.subsidiaryId !== '' ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => setFilters({ ...filters, subsidiaryId: '' })}
            >
              Clear the subsidiary filter
            </Button>
          ) : null}
        </div>
      ) : null}

      {isPending ? <LoadingBlock label="Loading analytics" rows={4} /> : null}

      {/*
        `keepPreviousData` holds the previous window's figures on screen while
        the next set loads, which is what stops the page collapsing to nothing on
        every filter change — dimmed, because they are not yet the answer to the
        filters now shown. When the next request FAILS they are hidden outright:
        the placeholder survives an error, and figures from one window sitting
        under a filter bar describing another is the misreading §13 exists to
        prevent.
      */}
      {data && error === null ? (
        <div
          className={cn('flex flex-col gap-8', isPlaceholderData && 'opacity-60')}
          aria-busy={isPlaceholderData || undefined}
        >
          <AnalyticsBody result={data} />
        </div>
      ) : null}
    </div>
  );
}

const SECTIONS: AnalyticsSectionKey[] = ['documents', 'extraction', 'reports', 'queries'];

/**
 * Which sections this payload was actually built from.
 *
 * The response does not echo `include`, and during a filter change the figures
 * on screen belong to the PREVIOUS request. Reading the sections back off
 * `totals` keeps the by-subsidiary columns matched to the figures standing
 * beside them rather than to a request that has not landed — which matters
 * because an excluded section's breakdown columns come back as real-looking
 * `0`s (`analytics.service.ts:720-725`), not as nulls.
 */
function respondedInclude(totals: AnalyticsSlice): AnalyticsInclude {
  const present = SECTIONS.filter((section) => hasSection(totals, section));
  return present.length === 1 && present[0] ? present[0] : 'all';
}

function AnalyticsBody({ result }: { result: AnalyticsResult }) {
  const { assumptions, bySubsidiary, pipeline, range, scope, totals } = result;

  const documents = hasSection(totals, 'documents') ? totals.documents : null;
  const extraction = hasSection(totals, 'extraction') ? totals.extraction : null;
  const reports = hasSection(totals, 'reports') ? totals.reports : null;
  const queries = hasSection(totals, 'queries') ? totals.queries : null;

  const period = `${formatDate(range.from)} – ${formatDate(range.to)}`;
  const bucketNoun = range.granularity === 'month' ? 'monthly' : 'fiscal-quarter';
  // `[]` is ambiguous on its own: an unscoped admin and a user holding nothing
  // produce the same array. `unscoped` is the only field that separates them.
  const noGrants = !scope.unscoped && scope.subsidiaryIds.length === 0;

  return (
    <>
      <Card muted>
        <DescriptionList
          columns={2}
          items={[
            { label: 'Window', value: `${period} · ${range.timezone}` },
            {
              label: 'Buckets',
              value: `${formatCount(range.buckets.length)} ${bucketNoun}`,
            },
            {
              label: 'Scope',
              value: scope.unscoped ? (
                'All subsidiaries'
              ) : noGrants ? (
                'None granted'
              ) : (
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {scope.subsidiaryIds.map((id) => (
                    <SubsidiaryLabel key={id} id={id} />
                  ))}
                </span>
              ),
            },
            {
              label: 'Computed',
              /*
               * §13: a cached figure presented as a live one is a traceability
               * defect. `cached` and `computedAt` have to be read together —
               * when the payload came from the server's cache this timestamp is
               * the ORIGINAL computation time, unchanged, however recently the
               * request was made (`analytics.service.ts:598`).
               */
              value: (
                <>
                  {formatRelative(result.computedAt)}
                  {result.cached ? ' · served from cache' : ''}
                  <span className="sr-only"> ({formatDateTime(result.computedAt)})</span>
                </>
              ),
            },
          ]}
        />
      </Card>

      {noGrants ? (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="warning">No subsidiary access</Badge>
            <p className="text-sm text-text-muted">
              Every figure below is a zero produced by an empty scope, not a measurement. Ask an
              administrator to grant access to a subsidiary.
            </p>
          </div>
        </Card>
      ) : null}

      <Section
        id="headline"
        title="Headline figures"
        description="The whole window, aggregated in its own pass — these do not add up from the periods below."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/*
            Automation coverage and time saved need BOTH blocks
            (`analytics.service.ts:377`), so with anything but `include=all`
            they are null however complete the document figures look. A tile
            that could only ever read "—" is noise, so the pair is absent
            rather than empty.
          */}
          {documents && extraction ? (
            <>
              <StatTile
                label="Automation coverage"
                value={formatPercent(totals.automationCoveragePercent)}
                period={period}
                note={
                  documents.validated === 0
                    ? 'No validated documents in this window, so there is nothing to measure.'
                    : 'Validated documents that needed neither a field correction nor a review.'
                }
              />
              <StatTile
                label="Time saved"
                value={formatPercent(totals.timeSavedPercent)}
                period={period}
                note={
                  documents.total === 0
                    ? 'No documents in this window, so there is nothing to measure.'
                    : `Against a ${assumptions.baselineManualMinutesPerDoc}-minute manual baseline per document.`
                }
              />
            </>
          ) : null}

          {extraction ? (
            <StatTile
              label="Extraction accuracy"
              value={formatPercent(extraction.accuracyPercent)}
              period={period}
              note={assumptions.extractionAccuracyDefinition}
            />
          ) : null}

          {documents ? (
            <StatTile
              label="Documents ingested"
              value={formatCount(documents.total)}
              period={period}
              note={`${formatCount(documents.validated)} validated · ${formatCount(documents.failed)} failed`}
            />
          ) : null}

          {reports ? (
            <StatTile
              label="Reports published"
              value={formatCount(reports.published)}
              period={period}
              note={`${formatCount(reports.withUnreviewedFigures)} carry unreviewed figures. Counted in the period they were published in.`}
            />
          ) : null}

          {queries ? (
            <StatTile
              label="Queries asked"
              value={formatCount(queries.total)}
              period={period}
              note="Counted by containment: one asked across several subsidiaries counts only when every one of them is in scope."
            />
          ) : null}
        </div>

        {documents && extraction ? (
          <Card muted>
            <p className="mb-3 text-sm font-medium text-text-default">
              How the derived figures were calculated
            </p>
            <DescriptionList
              columns={2}
              items={[
                {
                  label: 'Manual baseline',
                  value: `${assumptions.baselineManualMinutesPerDoc} minutes per document`,
                },
                {
                  label: 'Manual override',
                  value: `${assumptions.minutesPerManualOverride} minutes per corrected field`,
                },
                {
                  label: 'Low-confidence cutoff',
                  value: `${assumptions.ocrReviewThreshold} on a 0–1 confidence scale`,
                },
                { label: 'Extraction accuracy', value: assumptions.extractionAccuracyDefinition },
              ]}
            />
            {/*
              §13 covers a figure's inputs, not just the figure. These constants
              are environment-tunable, so a number computed last week is not
              necessarily reproducible from today's settings — and neither is a
              past period, since every pipeline also matches `isDeleted: false`
              and a soft-delete lowers a bucket that has already been read.
            */}
            <p className="mt-4 text-xs text-text-muted">
              Both derived figures are clamped at zero, so a 0 can mean a negative result. The
              constants above are set per environment, and soft-deleting a document or query lowers
              the period it was counted in — two readings of the same past quarter can legitimately
              differ.
            </p>
          </Card>
        ) : null}
      </Section>

      <Section
        id="trends"
        title="Trends over time"
        description={`${formatCount(range.buckets.length)} ${bucketNoun} buckets, gap-free and labelled in IST.`}
      >
        <TrendCharts result={result} />
      </Section>

      {documents || queries ? (
        <Section id="breakdowns" title="Breakdowns" description={`The whole window: ${period}.`}>
          <StatusBreakdowns totals={totals} />
        </Section>
      ) : null}

      {/*
        `null` means the breakdown was not requested; `[]` means it was computed
        and matched nothing. Two different messages to a reader, so the section
        is absent in the first case rather than empty.
      */}
      {bySubsidiary !== null ? (
        <Section
          id="by-subsidiary"
          title="By subsidiary"
          description={`The whole window: ${period}. Ordered by the measure shown.`}
        >
          {bySubsidiary.length === 0 ? (
            <EmptyState
              title="Nothing to break down"
              description="The per-subsidiary pass ran and matched no rows for this scope and window."
            />
          ) : (
            <SubsidiaryBreakdown rows={bySubsidiary} include={respondedInclude(totals)} />
          )}
        </Section>
      ) : null}

      <Section
        id="pipeline"
        title="Processing queue"
        description={`This scope's queue as it stood when the figures were computed, ${formatRelative(result.computedAt)} — not live monitoring, and not filtered by the window above: failed and dead-lettered are all-time counts.`}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QueueTile label="Documents queued" value={pipeline.documentsQueued} tone="pending" />
          <QueueTile
            label="Documents processing"
            value={pipeline.documentsProcessing}
            tone="progress"
          />
          <QueueTile label="Documents failed" value={pipeline.documentsFailed} tone="danger" />
          <QueueTile label="Queries queued" value={pipeline.queriesQueued} tone="pending" />
          <QueueTile label="Queries in flight" value={pipeline.queriesInFlight} tone="progress" />
          <QueueTile label="Queries failed" value={pipeline.queriesFailed} tone="danger" />
          <QueueTile
            label="Queries dead-lettered"
            value={pipeline.queriesDeadLettered}
            tone="danger"
          />
          <QueueTile
            label="In flight past the timeout"
            value={pipeline.inFlightPastTimeout}
            tone="warning"
          />
        </div>
        <p className="text-xs text-text-muted">
          {pipeline.oldestQueuedAgeSeconds === null
            ? 'Nothing is queued in either queue.'
            : `Oldest queued item: ${formatSeconds(pipeline.oldestQueuedAgeSeconds)} old.`}
        </p>
      </Section>
    </>
  );
}

/**
 * One headline number.
 *
 * A single figure is a number, not a chart — a bar of one tells the reader
 * nothing the digits do not. The dash is deliberate and never a 0: every ratio
 * here comes back null rather than zero for an empty window, and printing a
 * measured-looking zero is precisely what the backend refuses to do.
 */
function StatTile({
  label,
  value,
  period,
  note,
}: {
  label: string;
  /** Already formatted; `NO_FIGURE` when the API returned null. */
  value: string;
  period: string;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface-muted p-4">
      <p className="text-sm text-text-muted">{label}</p>
      <p className="mt-1 font-serif text-3xl font-semibold text-primary-dark tabular-nums">
        {value}
        {value === NO_FIGURE ? <span className="sr-only">No figure for this window</span> : null}
      </p>
      <p className="mt-1 text-xs text-text-muted">{period}</p>
      {note ? <p className="mt-2 text-xs text-text-muted">{note}</p> : null}
    </div>
  );
}

/** A queue depth. The badge carries the colour, an icon and the words together. */
function QueueTile({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <Badge tone={tone}>{label}</Badge>
      <p className="mt-2 font-serif text-2xl font-semibold text-primary-dark tabular-nums">
        {formatCount(value)}
      </p>
    </div>
  );
}
