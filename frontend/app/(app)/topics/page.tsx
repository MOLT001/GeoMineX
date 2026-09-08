'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { MAX_SERIES } from '@/components/charts/palette';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { CheckCircleIcon, PlusIcon } from '@/components/ui/Icon';
import { Card, DescriptionList, PageHeader, Section } from '@/components/ui/Layout';
import { TableFrame, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import {
  useTopics,
  type TermCluster,
  type TopicsComparison,
  type TopicsResponse,
  type TopicsScope,
  type TrendDirection,
} from '@/features/topics/api';
import {
  DEFAULT_TOPIC_FILTERS,
  isFilterError,
  TopicFilterBar,
  type TopicFilters,
} from '@/features/topics/components/TopicFilterBar';
import { partialBucketKeys, TopicTrendChart } from '@/features/topics/components/TopicTrendChart';
import { TopicWordCloud } from '@/features/topics/components/TopicWordCloud';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, formatRelative } from '@/lib/datetime';

/**
 * Topic analysis — PRD §5.6.
 *
 * One endpoint answers this whole screen. `GET /topics` is not paginated, has
 * no mutations, and carries no role guard — every authenticated role may read
 * it and the data is narrowed by subsidiary scope instead, which is why nothing
 * here is gated with `can()` and there is no 403 path to handle.
 *
 * The screen's real job is honesty about three things the payload makes easy to
 * misread, each handled below where it arises:
 *
 *   1. these are CACHED aggregations (`computedAt` + `cached`, §13);
 *   2. the first and last buckets can be PARTIAL periods, which is what makes
 *      the default range report a spurious "down" for nearly every term;
 *   3. an empty result is a legitimate answer — for a subsidiary with no
 *      corpus, for a well-formed id naming nothing, and for a user holding no
 *      grants at all — and must never be rendered as "no such subsidiary".
 */

/** Plotted before the reader picks anything. Four keeps the end-labels legible. */
const DEFAULT_PLOTTED = 4;

export default function TopicsPage() {
  const [filters, setFilters] = useState<TopicFilters>(DEFAULT_TOPIC_FILTERS);

  /**
   * Which term occupies which colour.
   *
   * A fixed `MAX_SERIES`-long array rather than a list, because the palette's
   * rule is that colour follows the ENTITY and not its rank: removing the first
   * term must not repaint the second. The slot index IS the colour index, and a
   * removal leaves a hole rather than shuffling everything down.
   *
   * `null` means "untouched", so the default pick keeps tracking the data until
   * the reader takes over — no effect writing state from props.
   */
  const [slots, setSlots] = useState<ReadonlyArray<string | null> | null>(null);

  const { data, isPending, error, refetch, isFetching, isPlaceholderData } = useTopics(filters);

  // Pulled out so the dependency arrays below name a plain variable rather than
  // an optional-chained expression.
  const trend = data?.trend;
  const range = data?.range;

  /** Terms this payload can actually plot. `trend` mirrors `wordCloud` exactly. */
  const plottable = useMemo(() => new Set((trend ?? []).map((entry) => entry.term)), [trend]);

  const defaultSlots = useMemo<ReadonlyArray<string | null>>(() => {
    const top = (trend ?? []).slice(0, DEFAULT_PLOTTED).map((entry) => entry.term);
    return Array.from({ length: MAX_SERIES }, (_, index) => top[index] ?? null);
  }, [trend]);

  const effectiveSlots = slots ?? defaultSlots;

  /**
   * Where the next term goes.
   *
   * An empty slot first, then a slot still holding a term this range has no
   * data for. That second case is what stops a stale pick — chosen before the
   * reader narrowed the range — from holding a colour hostage and capping the
   * chart below `MAX_SERIES` for no benefit. The stale term keeps its slot
   * until something else needs it, so widening the range brings it back in its
   * original colour.
   */
  const emptySlot = effectiveSlots.findIndex((term) => term === null);
  const staleSlot = effectiveSlots.findIndex((term) => term !== null && !plottable.has(term));
  const nextSlot = emptySlot !== -1 ? emptySlot : staleSlot;
  const canSelectMore = nextSlot !== -1;

  const selectedTerms = useMemo(
    () => effectiveSlots.filter((term): term is string => term !== null && plottable.has(term)),
    [effectiveSlots, plottable],
  );

  const toggleTerm = (term: string) => {
    const next = [...effectiveSlots];
    const held = next.indexOf(term);
    if (held !== -1) {
      next[held] = null;
    } else {
      if (nextSlot === -1) return;
      next[nextSlot] = term;
    }
    setSlots(next);
  };

  /**
   * A bucket key rendered for a human.
   *
   * `range.buckets` holds keys (`'2026-04'`, `'FY2026-Q1'`) and neither survives
   * `new Date()`. `TrendPoint.label` is the server's rendered form for the same
   * index, so the lookup goes through the trend rather than parsing anything.
   */
  const bucketLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const first = trend?.[0];
    range?.buckets.forEach((bucket, index) => {
      labels.set(bucket, first?.series[index]?.label ?? bucket);
    });
    return labels;
  }, [trend, range]);

  /** Buckets the range does not fully cover — see `TopicTrendChart`. */
  const partialBuckets = useMemo(() => (range ? partialBucketKeys(range) : null), [range]);

  const periodNoun =
    (range?.granularity ?? filters.granularity) === 'quarter' ? 'fiscal quarter' : 'month';

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Topic analysis"
        description="What the documents and questions you can access are about, and how that has shifted. The range defaults to the Indian fiscal year to date — 1 April up to today in IST — bucketed by fiscal quarter."
      />

      <TopicFilterBar
        value={filters}
        onChange={setFilters}
        onReset={() => {
          setFilters(DEFAULT_TOPIC_FILTERS);
          setSlots(null);
        }}
        error={error}
        busy={isFetching}
      />

      {isPending ? <LoadingBlock label="Loading topic analysis" rows={4} /> : null}

      {/*
        A bad date, an impossible range or an operator-shaped key is the reader's
        to fix and the bar names it against the control that caused it. Anything
        else — a 404 for a subsidiary out of scope, a 429 from the shared
        analytics limiter, a 500 — belongs here. `ErrorState` renders a 404 as
        the flat "Not found." with no retry, which is the point: the API returns
        404 for "no such record" and "not yours" alike, and naming a subsidiary
        here would rebuild the existence oracle that convention hides.
      */}
      {error && !isFilterError(error) ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : null}

      {data ? (
        <div
          /*
            `useTopics` holds the previous payload on screen while the next one
            loads, so a filter change dims the view instead of collapsing the
            page to nothing and reading as a failure.
          */
          aria-busy={isPlaceholderData || undefined}
          className={cn('flex flex-col gap-8', isPlaceholderData && 'opacity-60')}
        >
          <PayloadSummary data={data} periodNoun={periodNoun} />

          <Section
            id="word-cloud"
            title="Most frequent terms"
            description="Size and shade both track how often a term appears. Terms are single lowercase words — the index stores no phrases — so read them as tags rather than headings."
          >
            <TopicWordCloud
              entries={data.wordCloud}
              selected={selectedTerms}
              canSelectMore={canSelectMore}
              onToggleTerm={toggleTerm}
            />
          </Section>

          <Section
            id="trend"
            title="Trend over time"
            description={`Occurrences per ${periodNoun}, up to ${MAX_SERIES} terms at once. Pick a word above to add one.`}
          >
            <TopicTrendChart
              range={data.range}
              trend={data.trend}
              slots={effectiveSlots}
              onRemoveTerm={toggleTerm}
              onPlotDefault={() => setSlots(null)}
            />
          </Section>

          {/*
            `clusters` is `[]` — never null — both when grouping is switched off
            and when the cloud is empty, so the section simply does not exist
            rather than rendering an empty frame.
          */}
          {data.clusters.length > 0 ? (
            <Section
              id="clusters"
              title="Related terms"
              description="Terms sharing a stem, gathered under their most frequent member. Only the most frequent terms are considered and a group holds at most twelve, so a word in the cloud above may belong to no group here."
            >
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.clusters.map((cluster) => (
                  <li key={cluster.label}>
                    <ClusterCard
                      cluster={cluster}
                      selected={selectedTerms}
                      plottable={plottable}
                      canSelectMore={canSelectMore}
                      onToggleTerm={toggleTerm}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section
            id="comparison"
            title="Change since the previous period"
            description="The last two periods in the range, term by term."
          >
            {data.comparison ? (
              <ComparisonPanel
                comparison={data.comparison}
                labelFor={(bucket) => bucketLabels.get(bucket) ?? bucket}
                currentIsPartial={partialBuckets?.has(data.comparison.currentPeriod) ?? false}
              />
            ) : (
              /*
                `comparison` is null for TWO different reasons and they need
                different copy — rendering either as "no change" would be a
                fabricated figure. `compare='none'` is the reader's own choice;
                otherwise the range enumerated fewer than two buckets, which the
                server refuses to compare because the earlier bucket lies outside
                the aggregation window and would report a false 100% drop.
              */
              <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-sm text-text-muted">
                {filters.compare === 'none'
                  ? 'Comparison is switched off. Choose “Against previous period” in the filters to turn it back on.'
                  : `This range covers ${
                      data.range.buckets.length === 1
                        ? `a single ${periodNoun}`
                        : `${data.range.buckets.length} ${periodNoun}s`
                    }, and a period-on-period comparison needs two. Widen the range, or switch the granularity to months.`}
              </p>
            )}
          </Section>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the figures below actually cover, and how old they are.
 *
 * §13: the computed-at timestamp must be VISIBLE on a cached aggregation.
 * Presenting a stale figure as live is a traceability defect in a product whose
 * entire claim is traceable figures.
 */
function PayloadSummary({ data, periodNoun }: { data: TopicsResponse; periodNoun: string }) {
  const { range } = data;

  /*
    `toUtc` is the EXCLUSIVE upper bound, so the last day genuinely included is
    one millisecond earlier. And these are the DERIVED instants, deliberately:
    `range.from` / `range.to` echo the caller's strings verbatim, and the
    server's regex checks shape only — `2026-02-30` passes validation, rolls
    over to 2 March, and comes back still reading "2026-02-30".
  */
  const lastInstant = new Date(Date.parse(range.toUtc) - 1);

  return (
    <Card muted>
      <DescriptionList
        columns={3}
        items={[
          {
            label: 'Range',
            value: (
              <>
                {formatDate(range.fromUtc)} – {formatDate(lastInstant)}
                {/*
                  `range.timezone` is the literal display string
                  'Asia/Kolkata (+05:30)', not an IANA zone id — printed here,
                  never handed to Intl, which would throw on it.
                */}
                <span className="mt-0.5 block text-xs text-text-muted">{range.timezone}</span>
              </>
            ),
          },
          {
            label: 'Periods',
            value: `${range.buckets.length} ${periodNoun}${range.buckets.length === 1 ? '' : 's'}`,
          },
          { label: 'Scope', value: <ScopeValue scope={data.scope} /> },
          {
            label: 'Computed',
            value: (
              <>
                {formatRelative(data.computedAt)}
                {/*
                  Freshness comes from `computedAt` + `cached` and never from
                  `range.toUtc`: on a cache hit the ENTIRE payload, `range`
                  included, comes from the earlier run, so a default request can
                  report a range up to the cache TTL old.
                */}
                <span className="mt-0.5 block text-xs text-text-muted">
                  {data.cached ? 'Served from the cache' : 'Freshly aggregated'}
                </span>
                <span className="sr-only"> ({formatDateTime(data.computedAt)})</span>
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}

/**
 * The RESOLVED scope, which is not the caller's grant list.
 *
 * `subsidiaryIds: []` means BOTH "unscoped admin" and "non-admin holding zero
 * grants", and only `unscoped` separates them. The second gets 200 and an empty
 * payload rather than an error, so it is stated plainly instead of being left to
 * look like a fault.
 */
function ScopeValue({ scope }: { scope: TopicsScope }): ReactNode {
  if (scope.unscoped) return <>All subsidiaries</>;
  if (scope.subsidiaryIds.length === 0) return <>No subsidiary access granted</>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {scope.subsidiaryIds.map((id) => (
        <SubsidiaryLabel key={id} id={id} />
      ))}
    </span>
  );
}

function ClusterCard({
  cluster,
  selected,
  plottable,
  canSelectMore,
  onToggleTerm,
}: {
  cluster: TermCluster;
  selected: readonly string[];
  plottable: ReadonlySet<string>;
  canSelectMore: boolean;
  onToggleTerm: (term: string) => void;
}) {
  return (
    <Card className="h-full">
      {/* `label` is the seed term with only its first character upper-cased —
          always one word, because terms are single tokens. */}
      <h3 className="font-serif text-base font-semibold text-primary-dark">{cluster.label}</h3>

      <p className="mt-1 text-xs text-text-muted">
        {cluster.frequency.toLocaleString('en-IN')} occurrences ·{' '}
        {/*
          "at least", because this count is the union of per-term source samples
          that are themselves capped at 25 — it UNDER-reports and will not match
          the word cloud's `sourceCount`, which is the true, uncapped one.
        */}
        at least {cluster.sourceCount.toLocaleString('en-IN')} sources
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {cluster.terms.map((term) => {
          const isPlotted = selected.includes(term);
          return (
            <Button
              key={term}
              variant="ghost"
              size="sm"
              className="rounded-full border border-border"
              // A real toggle, so the state is announced rather than implied by
              // the icon. The icon is a shape, not a colour — see Badge.tsx.
              aria-pressed={isPlotted}
              disabled={!plottable.has(term) || (!isPlotted && !canSelectMore)}
              onClick={() => onToggleTerm(term)}
              icon={isPlotted ? <CheckCircleIcon size={12} /> : <PlusIcon size={12} />}
            >
              {term}
              <span className="sr-only">
                {isPlotted ? ' — remove from the trend chart' : ' — plot on the trend chart'}
              </span>
            </Button>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Direction as a word and a shape, never as a colour.
 *
 * Green-up / red-down would assert a judgement the data does not carry: a term
 * appearing more often is neither good nor bad, and the §6 success/danger
 * colours mean "validated" and "failed" everywhere else in this app.
 */
const DIRECTION_LABEL: Record<TrendDirection, string> = {
  up: 'Rising',
  down: 'Falling',
  flat: 'Level',
};

const DIRECTION_MARK: Record<TrendDirection, string> = { up: '▲', down: '▼', flat: '–' };

function ComparisonPanel({
  comparison,
  labelFor,
  currentIsPartial,
}: {
  comparison: TopicsComparison;
  labelFor: (bucket: string) => string;
  currentIsPartial: boolean;
}) {
  const previousLabel = labelFor(comparison.previousPeriod);
  const currentLabel = labelFor(comparison.currentPeriod);

  return (
    <div className="flex flex-col gap-4">
      {currentIsPartial ? (
        // The single most misleading thing on this screen if left unsaid: the
        // default range ends mid-period, so a part-period is weighed against a
        // whole one and nearly every term reads as falling.
        <p className="rounded-md border border-accent-yellow/50 bg-accent-yellow/10 px-3 py-2 text-sm text-text-default">
          <span className="font-medium">{currentLabel} is not over yet.</span> Its figures cover only
          the days so far, against a complete {previousLabel}, so most terms will look as though they
          are falling. Set an end date on the last complete period to compare like with like.
        </p>
      ) : null}

      {comparison.terms.length === 0 ? (
        <p className="text-sm text-text-muted">No terms qualified in either period.</p>
      ) : (
        <TableFrame caption={`Term frequency, ${previousLabel} compared with ${currentLabel}`}>
          <THead>
            {/* A plain <tr>: `TR` paints `bg-surface` over the muted header ground. */}
            <tr>
              <TH>Term</TH>
              <TH numeric>{previousLabel}</TH>
              <TH numeric>{currentLabel}</TH>
              <TH numeric>Change</TH>
              <TH numeric>Change %</TH>
              <TH>Direction</TH>
            </tr>
          </THead>
          <TBody>
            {comparison.terms.map((term) => (
              <TR key={term.term}>
                <TD>{term.term}</TD>
                <TD numeric>{term.previous.toLocaleString('en-IN')}</TD>
                <TD numeric>{term.current.toLocaleString('en-IN')}</TD>
                <TD numeric>
                  {term.change > 0 ? '+' : ''}
                  {term.change.toLocaleString('en-IN')}
                </TD>
                <TD numeric>
                  {/*
                    `changePercent` is null — never Infinity, never 100 —
                    whenever `previous` is 0. That is "new" only when the term
                    actually appeared this period; absent from both is neither
                    new nor a percentage.
                  */}
                  {term.changePercent === null ? (
                    <span className="text-text-muted">
                      {term.current > 0 ? (
                        'new'
                      ) : (
                        <>
                          <span aria-hidden>—</span>
                          <span className="sr-only">not applicable</span>
                        </>
                      )}
                    </span>
                  ) : (
                    `${term.changePercent > 0 ? '+' : ''}${term.changePercent.toFixed(1)}%`
                  )}
                </TD>
                <TD className="whitespace-nowrap">
                  <span aria-hidden className="mr-1.5 text-text-muted">
                    {DIRECTION_MARK[term.direction]}
                  </span>
                  {DIRECTION_LABEL[term.direction]}
                </TD>
              </TR>
            ))}
          </TBody>
        </TableFrame>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TermList
          heading={`First seen in ${currentLabel}`}
          description="Absent from the previous period entirely."
          terms={comparison.emerging}
        />
        <TermList
          heading={`Absent from ${currentLabel}`}
          description="Present in the previous period, gone from this one."
          terms={comparison.fading}
        />
      </div>
    </div>
  );
}

function TermList({
  heading,
  description,
  terms,
}: {
  heading: string;
  description: string;
  terms: string[];
}) {
  return (
    <div>
      <h3 className="font-serif text-base font-semibold text-primary-dark">{heading}</h3>
      <p className="mt-0.5 text-xs text-text-muted">{description}</p>
      {terms.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">None.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {terms.map((term) => (
            <li key={term}>
              <span className="inline-flex rounded-full border border-border px-2.5 py-0.5 text-sm text-text-default">
                {term}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
