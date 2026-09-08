'use client';

import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Symbols,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
  type SymbolType,
  type TooltipContentProps,
} from 'recharts';
import { CHART_INK, seriesColor, seriesDash, seriesShape } from '@/components/charts/palette';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Feedback';
import { CloseIcon } from '@/components/ui/Icon';
import { TableFrame, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import { fiscalQuarterLabel } from '@/lib/datetime';
import type { Granularity, TopicsRange, TrendEntry } from '@/features/topics/api';

/**
 * Term frequency over the bucketed range — PRD §5.6.
 *
 * ─── WHY EVERY SERIES CARRIES THREE ENCODINGS ───────────────────────────────
 * `components/charts/palette.ts` spells out the constraint: checked across
 * every pair, no palette of more than two hues is colour-blind-safe — to a
 * protanope green IS orange, to a deuteranope blue IS purple. So a line here is
 * identified by its COLOUR, its MARKER SHAPE and its DASH PATTERN together, a
 * legend is always on screen, and at four series or fewer each line is also
 * labelled at its right-hand end so the eye never has to travel to the legend.
 *
 * The SLOT INDEX — not the term's rank — chooses all three. `slots` is a fixed
 * `MAX_SERIES`-long array owned by the page, so removing the first term does
 * not repaint the second: colour follows the entity, never its position.
 *
 * One measure, one axis. Frequency and source count are different scales and
 * would need a second chart, never a second y-axis.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Direct end-labels stay legible to four lines; beyond that they collide. */
const END_LABEL_LIMIT = 4;

/**
 * `d3-symbol` sizes by AREA, not diameter. 72px² is a ~9.6px circle, clearing
 * the palette's 8px marker floor while staying thin enough that the line reads
 * as the data and the marker as punctuation.
 */
const MARKER_AREA = 72;

/**
 * Every value in `SERIES_SHAPES` is a valid recharts `SymbolType`. This map is
 * where that claim is checked by the compiler rather than assumed.
 */
const MARKER_TYPES: Record<string, SymbolType> = {
  circle: 'circle',
  square: 'square',
  triangle: 'triangle',
  diamond: 'diamond',
  cross: 'cross',
  star: 'star',
};

function markerType(slot: number): SymbolType {
  return MARKER_TYPES[seriesShape(slot)] ?? 'circle';
}

/** The longest end-label the gutter can hold before it starts clipping. */
const END_LABEL_CHARS = 15;

function endLabelText(term: string): string {
  return term.length > END_LABEL_CHARS ? `${term.slice(0, END_LABEL_CHARS - 1)}…` : term;
}

/**
 * A term is a lowercase token matching `/[a-z][a-z0-9-]{2,23}/`, so `label`,
 * `bucket` and `partial` are all terms a corpus could genuinely produce. The
 * underscore prefix cannot be — a term always starts with a letter — which is
 * what stops a series column silently overwriting a row field.
 */
function seriesKey(term: string): string {
  return `_${term}`;
}

/** One bucket, plus one column per plotted term. */
interface TrendRow {
  bucket: string;
  /** `TrendPoint.label` — the server's rendered form. See `bucketLabels`. */
  label: string;
  partial: boolean;
  [seriesColumn: string]: string | number | boolean;
}

// ─── Partial buckets ─────────────────────────────────────────────────────────

/** IST is a fixed +05:30 with no daylight saving (`istPeriod.ts:18`). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC instant of IST midnight on the 1st of a month — mirrors `istPeriod.ts:78-79`. */
function istMonthStartUtc(year: number, monthIndex: number): number {
  return Date.UTC(year, monthIndex, 1) - IST_OFFSET_MS;
}

/** `[start, end)` in UTC ms for a bucket key, or null if it is not a key we know. */
function bucketBounds(key: string, granularity: Granularity): [number, number] | null {
  if (granularity === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    return [istMonthStartUtc(year, monthIndex), istMonthStartUtc(year, monthIndex + 1)];
  }

  const match = /^FY(\d{4})-Q([1-4])$/.exec(key);
  if (!match) return null;
  const fiscalYear = Number(match[1]);
  // FY2026-Q1 is April–June 2026 and Q4 is January–March 2027. Month indices
  // 12..14 are exactly what `Date.UTC` rolls into the following year, so the
  // April-based fiscal year needs no special case of its own.
  const firstMonth = 3 + (Number(match[2]) - 1) * 3;
  return [istMonthStartUtc(fiscalYear, firstMonth), istMonthStartUtc(fiscalYear, firstMonth + 3)];
}

/**
 * The buckets the range does not fully cover.
 *
 * `range.buckets` holds WHOLE bucket keys even for a partial range —
 * `from=2026-01-01&to=2026-06-30` returns `['FY2025-Q4','FY2026-Q1']`
 * (`tests/topics.test.ts:353-358`) — so the first and last points of every
 * series can be part-periods. On the default fiscal-year-to-date range the last
 * one always is, which is what makes `comparison` weigh a partial current
 * quarter against a complete previous one and report a spurious "down" for
 * nearly every term. Marking them is the alternative to pinning `to` to the end
 * of the last complete bucket.
 */
export function partialBucketKeys(range: TopicsRange): ReadonlySet<string> {
  const partial = new Set<string>();
  const from = Date.parse(range.fromUtc);
  const to = Date.parse(range.toUtc);
  if (Number.isNaN(from) || Number.isNaN(to)) return partial;

  for (const key of range.buckets) {
    const bounds = bucketBounds(key, range.granularity);
    // `fromUtc` is the INCLUSIVE lower bound and `toUtc` the EXCLUSIVE upper
    // one, so a bucket is whole only when it sits entirely inside them.
    if (bounds && (bounds[0] < from || bounds[1] > to)) partial.add(key);
  }
  return partial;
}

/**
 * The Indian fiscal quarter the range actually ends inside.
 *
 * `toUtc` is EXCLUSIVE, so on a quarter boundary it names the quarter AFTER the
 * one the data covers; the last instant genuinely in range is 1ms earlier. The
 * fiscal year starts in April, so a calendar-quarter label would be wrong for
 * nine months of every year — hence `fiscalQuarterLabel`, never a raw `Intl`
 * quarter.
 */
export function rangeEndQuarterLabel(range: TopicsRange): string {
  return fiscalQuarterLabel(new Date(Date.parse(range.toUtc) - 1));
}

// ─── The chart ───────────────────────────────────────────────────────────────

export function TopicTrendChart({
  range,
  trend,
  slots,
  onRemoveTerm,
  onPlotDefault,
}: {
  range: TopicsRange;
  trend: TrendEntry[];
  /** Slot index IS the colour index; a null slot is a free colour. */
  slots: ReadonlyArray<string | null>;
  onRemoveTerm: (term: string) => void;
  /** Restores the default pick — the way back from an emptied chart. */
  onPlotDefault: () => void;
}) {
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);

  const byTerm = useMemo(() => new Map(trend.map((entry) => [entry.term, entry])), [trend]);

  /**
   * The plotted series, in slot order.
   *
   * A slot may hold a term the CURRENT range has no data for — the reader
   * picked it, then narrowed the range. Such a slot plots nothing rather than
   * being pruned out of state, so widening the range again brings the term back
   * wearing its original colour.
   */
  const series = useMemo(
    () =>
      slots.flatMap((term, slot) => {
        if (term === null) return [];
        const entry = byTerm.get(term);
        if (!entry) return [];
        return [
          {
            entry,
            key: seriesKey(term),
            color: seriesColor(slot),
            dash: seriesDash(slot),
            shape: markerType(slot),
            renderDot: makeDotRenderer(slot),
          },
        ];
      }),
    [slots, byTerm],
  );

  const partial = useMemo(() => partialBucketKeys(range), [range]);

  /**
   * `TrendPoint.label` is the server's rendered bucket name — `'April 2026'`,
   * `'FY2025-26 Q1'` — and every entry's series is the same length and order as
   * `range.buckets`. Rebuilding it here would mean parsing a bucket key, and
   * neither `'2026-04'` nor `'FY2026-Q1'` survives `new Date()`.
   */
  const bucketLabels = useMemo(() => {
    const first = trend[0];
    return range.buckets.map((bucket, index) => first?.series[index]?.label ?? bucket);
  }, [range.buckets, trend]);

  const rows = useMemo<TrendRow[]>(
    () =>
      range.buckets.map((bucket, index) => {
        const row: TrendRow = {
          bucket,
          label: bucketLabels[index] ?? bucket,
          partial: partial.has(bucket),
        };
        // `series` is zero-filled to exactly `range.buckets.length` in the same
        // order (`topics.service.ts:208-217`), including a zero bucket in the
        // middle, so indexing positionally is safe here.
        for (const plotted of series) {
          row[plotted.key] = plotted.entry.series[index]?.frequency ?? 0;
        }
        return row;
      }),
    [range.buckets, bucketLabels, partial, series],
  );

  const periodNoun = range.granularity === 'quarter' ? 'fiscal quarter' : 'month';
  const partialLabels = rows.filter((row) => row.partial).map((row) => row.label);
  const endLabels = series.length > 0 && series.length <= END_LABEL_LIMIT;
  const lastIndex = rows.length - 1;

  /**
   * Room for the end-labels, sized to the longest one actually rendered.
   *
   * `endLabelText` is what bounds it: a term runs to 24 characters, and a
   * gutter wide enough for the worst case would eat a phone-width chart alive.
   * Past that length the label is elided — the legend and the tooltip both
   * carry the term in full, so the end-label only has to say WHICH line it is.
   */
  const longestLabel = series.reduce(
    (longest, plotted) => Math.max(longest, endLabelText(plotted.entry.term).length),
    0,
  );
  const labelGutter = endLabels ? 16 + longestLabel * 7 : 16;

  const busiest = series.reduce<TrendEntry | null>(
    (best, plotted) => (best === null || plotted.entry.total > best.total ? plotted.entry : best),
    null,
  );

  const summary =
    series.length === 0
      ? 'Trend chart with no terms selected.'
      : `Line chart of term frequency across ${rows.length} ${periodNoun}${rows.length === 1 ? '' : 's'}, ` +
        `${rows[0]?.label ?? ''} to ${rows[lastIndex]?.label ?? ''}. ` +
        `${series.length} term${series.length === 1 ? '' : 's'} plotted: ${series
          .map((plotted) => plotted.entry.term)
          .join(', ')}. ` +
        (busiest
          ? `Highest total over the range: ${busiest.term}, ${busiest.total.toLocaleString('en-IN')} occurrences. `
          : '') +
        'The table below carries every number.';

  /**
   * The tooltip reads its numbers out of `rows`, not out of the recharts
   * payload: payload entries type their row as `any`, and the row is already in
   * scope here — which keeps the whole readout type-checked and lets the
   * partial-period marker appear in the tooltip too.
   */
  const renderTooltip = ({ active, label }: TooltipContentProps): ReactNode => {
    if (!active) return null;
    const row = rows.find((candidate) => candidate.label === label);
    if (!row) return null;

    return (
      <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm">
        <p className="font-medium text-text-default">
          {row.label}
          {row.partial ? <span className="ml-1.5 text-text-muted">(partial)</span> : null}
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {series.map((plotted) => (
            <li key={plotted.entry.term} className="flex items-center gap-2">
              <SeriesSwatch color={plotted.color} dash={plotted.dash} shape={plotted.shape} />
              <span className="text-text-default">{plotted.entry.term}</span>
              <span className="ml-auto tabular-nums text-text-muted">
                {Number(row[plotted.key] ?? 0).toLocaleString('en-IN')}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  if (trend.length === 0) {
    return (
      <EmptyState
        title="Nothing to chart in this range"
        description="No term in the documents and questions you can see appears in enough distinct sources over this range."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        The legend, and the only control that removes a series — one chip, so a
        reader never has to work out which swatch belongs to which line. It is
        HTML rather than a recharts <Legend> because these are real buttons: a
        legend rendered inside the SVG is unreachable by keyboard.
      */}
      {series.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {series.map((plotted) => (
            <li key={plotted.entry.term}>
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface py-0.5 pr-0.5 pl-3 text-sm">
                <SeriesSwatch color={plotted.color} dash={plotted.dash} shape={plotted.shape} wide />
                <span className="font-medium text-text-default">{plotted.entry.term}</span>
                <span className="tabular-nums text-text-muted">
                  {plotted.entry.total.toLocaleString('en-IN')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full px-1.5"
                  onClick={() => onRemoveTerm(plotted.entry.term)}
                  icon={<CloseIcon size={12} />}
                >
                  <span className="sr-only">Remove {plotted.entry.term} from the chart</span>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {series.length === 0 ? (
        <EmptyState
          title="No terms selected"
          description="Pick a word from the cloud above, or start again from the most frequent terms."
          action={
            <Button variant="secondary" size="sm" onClick={onPlotDefault}>
              Plot the most frequent terms
            </Button>
          }
        />
      ) : (
        <div
          /*
            One node, one name. The individual paths carry no numbers, and the
            table below is the accessible equivalent, so `role="img"` describes
            the chart honestly rather than exposing an unlabelled scatter of
            SVG. recharts' own `accessibilityLayer` is off for the same reason:
            it builds a keyboard-navigable widget that nothing inside a
            `role="img"` subtree can reach.
          */
          role="img"
          aria-label={summary}
          className="rounded-lg border border-border bg-surface p-2"
        >
          <ResponsiveContainer width="100%" height={320}>
            <LineChart
              data={rows}
              accessibilityLayer={false}
              margin={{ top: 8, right: labelGutter, bottom: 0, left: 0 }}
            >
              {/* Recessive furniture — the data is the ink. */}
              <CartesianGrid stroke={CHART_INK.grid} vertical={false} />
              <XAxis
                dataKey="label"
                stroke={CHART_INK.axis}
                tick={{ fill: CHART_INK.axis, fontSize: 12 }}
                tickMargin={8}
                minTickGap={16}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                width={56}
                stroke={CHART_INK.axis}
                tick={{ fill: CHART_INK.axis, fontSize: 12 }}
              />
              <Tooltip
                content={renderTooltip}
                cursor={{ stroke: CHART_INK.grid, strokeWidth: 1 }}
                isAnimationActive={false}
              />
              {series.map((plotted) => (
                <Line
                  key={plotted.entry.term}
                  dataKey={plotted.key}
                  name={plotted.entry.term}
                  /*
                    Linear, never a smoothed curve: a monotone spline draws
                    values between two buckets that were never measured, and
                    these are counts for whole periods.
                  */
                  type="linear"
                  stroke={plotted.color}
                  strokeWidth={2}
                  strokeDasharray={plotted.dash}
                  dot={plotted.renderDot}
                  // `fill` spelled out rather than left to the default, which
                  // inherits the line's own `fill` — white — and would draw a
                  // white dot on a white surface.
                  activeDot={{ r: 5, fill: plotted.color, stroke: CHART_INK.surface, strokeWidth: 2 }}
                  /*
                    `false`, not the default `"auto"`, which still animates for
                    anyone who has expressed no motion preference. A line
                    redrawing itself on every filter change is noise.
                  */
                  isAnimationActive={false}
                >
                  {endLabels ? (
                    <LabelList
                      valueAccessor={(_entry, index) =>
                        index === lastIndex ? endLabelText(plotted.entry.term) : ''
                      }
                      position="right"
                      offset={10}
                      fill={plotted.color}
                      fontSize={12}
                      fontWeight={600}
                    />
                  ) : null}
                </Line>
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {partialLabels.length > 0
            ? `${partialLabels.join(' and ')} ${
                partialLabels.length === 1 ? 'is a partial period' : 'are partial periods'
              } — the range starts or ends inside ${
                partialLabels.length === 1 ? 'it' : 'them'
              }, so those counts cover only the days in range.` +
              (range.granularity === 'quarter'
                ? ` The range ends inside ${rangeEndQuarterLabel(range)}.`
                : '')
            : `Every ${periodNoun} shown is complete.`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowTable((current) => !current)}
          aria-expanded={showTable}
          aria-controls={tableId}
        >
          {showTable ? 'Hide the numbers' : 'Show the numbers'}
        </Button>
      </div>

      {/*
        Not an extra: the chart above is one opaque image to a screen reader, so
        the table is where those numbers are actually readable.
      */}
      <div id={tableId} hidden={!showTable}>
        {series.length === 0 ? (
          <p className="text-sm text-text-muted">Select a term to see its figures.</p>
        ) : (
          <TableFrame caption={`Occurrences per ${periodNoun} for the plotted terms`}>
            <THead>
              {/* A plain <tr>: `TR` paints `bg-surface` over the muted header ground. */}
              <tr>
                <TH>Period</TH>
                {series.map((plotted) => (
                  <TH key={plotted.entry.term} numeric>
                    {plotted.entry.term}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.bucket}>
                  <TD className="whitespace-nowrap">
                    {row.label}
                    {row.partial ? (
                      <span className="ml-2 text-xs text-text-muted">(partial)</span>
                    ) : null}
                  </TD>
                  {series.map((plotted) => (
                    <TD key={plotted.entry.term} numeric>
                      {Number(row[plotted.key] ?? 0).toLocaleString('en-IN')}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </TableFrame>
        )}
      </div>
    </div>
  );
}

/**
 * The line-plus-marker swatch, shared by the legend and the tooltip.
 *
 * It repeats all three encodings — hue, dash and shape — because that is the
 * whole point: a reader who cannot separate two hues separates the swatches by
 * their dash and their marker instead.
 */
function SeriesSwatch({
  color,
  dash,
  shape,
  wide = false,
}: {
  color: string;
  dash: string;
  shape: SymbolType;
  wide?: boolean;
}) {
  const width = wide ? 26 : 22;
  const mid = width / 2;
  // 14 rather than 12 high: a star of the same AREA as the circle has a wider
  // extent, and at 12 its points clip against the top of the box.
  return (
    <svg width={width} height={14} aria-hidden className="shrink-0">
      <line x1={0} y1={7} x2={width} y2={7} stroke={color} strokeWidth={2} strokeDasharray={dash} />
      <Symbols
        type={shape}
        cx={mid}
        cy={7}
        size={MARKER_AREA}
        fill={color}
        stroke={CHART_INK.surface}
        strokeWidth={1}
      />
    </svg>
  );
}

/**
 * The marker renderer for one slot.
 *
 * Built per slot so its identity is stable for as long as the series list is,
 * and deliberately NOT spreading the props recharts hands it: those carry the
 * line's own `strokeDasharray` (which would dash the marker into invisibility)
 * plus `points` and `payload`, which are not SVG attributes and would reach the
 * DOM as React warnings.
 */
function makeDotRenderer(slot: number) {
  const fill = seriesColor(slot);
  const type = markerType(slot);

  return function renderDot({ cx, cy }: DotItemDotProps): ReactNode {
    const x = Number(cx);
    const y = Number(cy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return (
      <Symbols
        type={type}
        cx={x}
        cy={y}
        size={MARKER_AREA}
        fill={fill}
        stroke={CHART_INK.surface}
        strokeWidth={1}
      />
    );
  };
}
