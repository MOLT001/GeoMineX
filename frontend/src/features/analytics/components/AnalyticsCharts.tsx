'use client';

import { useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
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
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Field, Select } from '@/components/ui/Field';
import { TBody, TD, TH, THead, TR, TableFrame } from '@/components/ui/Table';
import {
  hasSection,
  includesSection,
  type AnalyticsInclude,
  type AnalyticsResult,
  type AnalyticsSectionKey,
  type AnalyticsSlice,
  type DocumentType,
  type DocumentsBlock,
  type QueriesBlock,
  type SubsidiaryBreakdownRow,
} from '@/features/analytics/api';
import {
  CHART_INK,
  MAX_SERIES,
  STATUS_COLORS,
  sequentialStep,
  seriesColor,
  seriesDash,
  seriesShape,
} from '@/components/charts/palette';

/**
 * The analytics charts — PRD §5.3.
 *
 * ─── WHAT EVERY CHART IN HERE CARRIES, AND WHY ──────────────────────────────
 * Colour never identifies a series on its own (see `charts/palette.ts`: past
 * two hues no categorical palette survives protan/deutan simulation). So each
 * line also carries a marker SHAPE and a DASH pattern from the same fixed
 * index, a legend is always present, and with four or fewer series the lines
 * are direct-labelled at their right end.
 *
 * Every chart also ships a hover tooltip and a `<TableFrame>` of the same
 * figures behind a real `<button>` — a chart with no table view is unreadable
 * to a screen-reader user, so that is the floor rather than a nicety. The
 * container is a `role="img"` with a summarising label, since the SVG's
 * internals are noise once the table exists.
 *
 * Two shapes deliberately avoided: a dual axis (two measures at different
 * scales become two charts — counts and percentages never share one frame),
 * and a categorical palette for the eight CIL subsidiaries, which are above
 * MAX_SERIES and get sorted single-hue bars instead.
 *
 * ─── AND WHAT THE FIGURES THEMSELVES REQUIRE ────────────────────────────────
 * Zero-fill is asymmetric: an empty bucket is `0` for every COUNT and `null`
 * for every RATIO or AVERAGE (`analytics.service.ts:268-331`). `value ?? 0`
 * would re-create exactly the figure the backend refuses to emit, so nulls
 * stay null — a gap in a line, a dash in a table.
 */

// ─── Figure formatting ───────────────────────────────────────────────────────

/** There is no figure for this cell. Not the same statement as zero. */
export const NO_FIGURE = '—';

export function formatCount(value: number): string {
  return value.toLocaleString('en-IN');
}

/** 1dp percentages (`metricFormulas.ts:31`). `null` is a dash, never a 0. */
export function formatPercent(value: number | null): string {
  if (value === null) return NO_FIGURE;
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
}

/**
 * `avgOcrConfidence` and `avgConfidence` are on a 0..1 scale at 2dp
 * (`analytics.service.ts:255`) — NOT percentages. Rendering either with a `%`
 * would understate it by two orders of magnitude.
 */
export function formatRatio(value: number | null): string {
  if (value === null) return NO_FIGURE;
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `avgGenerationMs` is whole milliseconds; seconds read better past a second. */
export function formatMs(value: number | null): string {
  if (value === null) return NO_FIGURE;
  if (value >= 1000) return `${(value / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })} s`;
  return `${formatCount(value)} ms`;
}

/** `pipeline.oldestQueuedAgeSeconds` — null when nothing is queued in either queue. */
export function formatSeconds(value: number | null): string {
  if (value === null) return NO_FIGURE;
  if (value < 90) return `${formatCount(Math.round(value))} s`;
  if (value < 5400) return `${Math.round(value / 60).toLocaleString('en-IN')} min`;
  return `${(value / 3600).toLocaleString('en-IN', { maximumFractionDigits: 1 })} hr`;
}

/**
 * One cell of the subsidiary breakdown. Accuracy is the only nullable column
 * there, and its null is a dash; a count column carries a real number, so it is
 * never coerced into one.
 */
function formatMetric(value: number | null, percent: boolean): string {
  if (percent) return formatPercent(value);
  return value === null ? NO_FIGURE : formatCount(value);
}

/**
 * `DocumentTypeCount.type` is typed as the model's four-value union, but the
 * service declares the field a bare `string`, so nothing on the wire enforces
 * membership. Look the label up with a fallback rather than assuming
 * exhaustiveness at runtime — the `Record` still forces a new enum member to be
 * handled here at compile time.
 *
 * Short labels on purpose: these are axis ticks. The document filter's labels
 * name file extensions, which is the right thing there and too long here.
 */
const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  pdf: 'PDF',
  scan: 'Scan',
  spreadsheet: 'Spreadsheet',
  image: 'Image',
};

function documentTypeLabel(type: string): string {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so an off-enum
  // `'toString'` on the wire would pass the guard and hand back a FUNCTION typed
  // as a string — which React then refuses to render as a child. The fallback
  // has to be the string itself for every value that is not a key we wrote.
  return Object.hasOwn(DOCUMENT_TYPE_LABELS, type)
    ? DOCUMENT_TYPE_LABELS[type as DocumentType]
    : type;
}

// ─── Chart primitives ────────────────────────────────────────────────────────

const AXIS_TICK = { fill: CHART_INK.axis, fontSize: 11 } as const;
const AXIS_LINE = { stroke: CHART_INK.grid } as const;

/**
 * `seriesShape` returns recharts' own symbol vocabulary by design, but the
 * palette module must not import recharts — it is the one file every chart
 * depends on, and it stays library-agnostic. The narrowing happens here.
 */
function markerShape(index: number): SymbolType {
  return seriesShape(index) as SymbolType;
}

/**
 * The marker for one series, as recharts' `dot` render prop.
 *
 * This is the non-colour encoding: a reader who cannot separate series 2 from
 * series 3 by hue separates them by shape. Size 64 is an AREA (d3's convention)
 * — about 9px across, above the 8px floor.
 */
function seriesMarker(index: number) {
  const fill = seriesColor(index);
  const type = markerShape(index);

  return function SeriesMarker({ cx, cy, index: pointIndex }: DotItemDotProps): ReactNode {
    // A bucket with a null ratio has no coordinate. It must stay a visible gap
    // rather than being drawn at the origin.
    if (typeof cx !== 'number' || typeof cy !== 'number') return null;
    return <Symbols key={pointIndex} type={type} cx={cx} cy={cy} size={64} fill={fill} />;
  };
}

function tooltipValue(value: TooltipContentProps['payload'][number]['value']): string {
  if (value === undefined || value === null) return NO_FIGURE;
  if (typeof value === 'number') return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (typeof value === 'string') return value;
  return value.join(' – ');
}

/**
 * The shared tooltip.
 *
 * Rendered from the payload's typed fields only (`name`, `value`, `unit`,
 * `color`) — never from `entry.payload`, which recharts types as `any`. The
 * swatch is decorative: the series name beside it is what identifies the row.
 */
function ChartTooltip({ active, label, payload }: TooltipContentProps): ReactNode {
  // `payload` is typed non-optional but arrives undefined on an inactive
  // tooltip, so the runtime check is not the redundancy it looks like.
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm">
      <p className="font-medium text-text-default">{label}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {payload.map((entry, index) => (
          // Keyed by position: the payload is rebuilt per hover in a fixed
          // order, and two series can legitimately share a name.
          <li key={index} className="flex items-center gap-3">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color ?? entry.fill ?? CHART_INK.axis }}
            />
            <span className="text-text-muted">{entry.name}</span>
            <span className="ml-auto font-medium text-text-default tabular-nums">
              {tooltipValue(entry.value)}
              {entry.unit}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DataTableRow {
  key: string;
  cells: ReactNode[];
}

/**
 * A chart, its accessible summary, and its table alternative.
 *
 * The disclosure is a real `<button>` with `aria-expanded`, and the table is
 * mounted only while open — an always-rendered table hidden with CSS is the
 * version that gets read out twice.
 */
function ChartBlock({
  title,
  description,
  ariaLabel,
  caption,
  headers,
  rows,
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** What the chart shows, for a reader who gets the image and nothing else. */
  ariaLabel: string;
  caption: string;
  /** First header names the row-label column; the rest are numeric. */
  headers: string[];
  rows: DataTableRow[];
  /**
   * Legends and footnotes go here, never in `children`: `role="img"` replaces
   * everything inside it with `ariaLabel`, so text placed in the chart's own
   * container is text a screen reader never reaches.
   */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [tableOpen, setTableOpen] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-text-default">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setTableOpen((open) => !open)}
          aria-expanded={tableOpen}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-sih-blue transition-colors hover:bg-surface-muted"
        >
          {tableOpen ? 'Hide data table' : 'Show data table'}
        </button>
      </div>

      <div role="img" aria-label={ariaLabel}>
        {children}
      </div>

      {footer}

      {tableOpen ? (
        <TableFrame caption={caption}>
          <THead>
            {/* A plain <tr>: `TR` paints `bg-surface` over the muted header ground. */}
            <tr>
              {headers.map((header, index) => (
                <TH key={header} numeric={index > 0}>
                  {header}
                </TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.key}>
                {row.cells.map((cell, index) => (
                  <TD key={headers[index] ?? index} numeric={index > 0}>
                    {cell}
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </TableFrame>
      ) : null}
    </div>
  );
}

interface TrendSeries {
  key: string;
  name: string;
  /**
   * Fixed per METRIC, never per position. Colour follows the entity: dropping a
   * series from a chart must not repaint the ones that remain.
   */
  index: number;
  unit?: string;
}

/**
 * A time-series line chart.
 *
 * `connectNulls={false}` is load-bearing: a null ratio bucket is "no figure",
 * and bridging it would draw a measurement that was never taken.
 */
function TrendLineChart({
  rows,
  series,
  height = 240,
}: {
  rows: Array<Record<string, string | number | null>>;
  series: readonly TrendSeries[];
  height?: number;
}) {
  const lastIndex = rows.length - 1;
  // Four or fewer lines get an end label as well as the legend. Beyond that the
  // labels collide with each other and stop being readable.
  const directLabel = series.length <= 4;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart
        data={rows}
        /*
         * `accessibilityLayer` defaults to TRUE, and it puts `tabIndex={0}` and
         * `role="application"` on the chart's own `<svg>`
         * (`recharts/es6/container/RootSurface.js`). Inside `ChartBlock`'s
         * `role="img"` that is the worst of both: the subtree is presentational,
         * so the keyboard-navigable widget it builds has no accessible name and
         * nothing to announce — a tab stop that reads as nothing. The table view
         * is the keyboard and screen-reader path here, as in `TopicTrendChart`.
         */
        accessibilityLayer={false}
        margin={{ top: 8, right: directLabel ? 96 : 12, bottom: 0, left: 0 }}
      >
        <CartesianGrid stroke={CHART_INK.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={AXIS_LINE}
          minTickGap={12}
        />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={ChartTooltip} />
        <Legend
          iconSize={10}
          wrapperStyle={{ fontSize: 12, color: CHART_INK.axis, paddingTop: 4 }}
        />
        {series.slice(0, MAX_SERIES).map((entry) => (
          <Line
            key={entry.key}
            type="linear"
            dataKey={entry.key}
            name={entry.name}
            unit={entry.unit}
            stroke={seriesColor(entry.index)}
            strokeWidth={2}
            strokeDasharray={seriesDash(entry.index)}
            legendType={markerShape(entry.index)}
            dot={seriesMarker(entry.index)}
            connectNulls={false}
            isAnimationActive={false}
          >
            {directLabel ? (
              <LabelList
                position="right"
                offset={8}
                fill={seriesColor(entry.index)}
                fontSize={11}
                // `valueAccessor` is ignored when `dataKey` is set, so the label
                // text is produced here: the series name on the last point, and
                // nothing anywhere else. A last point with no figure gets no
                // label — it has no position to sit at.
                valueAccessor={(point, index) =>
                  index === lastIndex && point.value !== null ? entry.name : null
                }
              />
            ) : null}
          </Line>
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

interface BarRow {
  key: string;
  label: string;
  value: number | null;
  /** Pre-formatted, because it is both the direct label and the table cell. */
  display: string;
  fill: string;
}

/**
 * Sorted horizontal bars — the shape for a single measure across categories.
 *
 * Horizontal because the categories are words (subsidiary codes, status names)
 * and a vertical bar chart would rotate them; sorted because rank is the
 * question being asked; directly labelled because reading a value off an axis
 * is work the chart can do for the reader.
 */
function HorizontalBars({
  rows,
  measure,
  unit,
  categoryWidth = 132,
}: {
  rows: BarRow[];
  /** Names the measure in the tooltip — the axis already names the category. */
  measure: string;
  unit?: string;
  categoryWidth?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, rows.length * 34 + 32)}>
      <BarChart
        data={rows}
        layout="vertical"
        // Same reason as `TrendLineChart`: a focusable `role="application"` svg
        // inside a `role="img"` container is a tab stop with nothing to announce.
        accessibilityLayer={false}
        margin={{ top: 4, right: 72, bottom: 4, left: 0 }}
      >
        <CartesianGrid stroke={CHART_INK.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={AXIS_LINE} />
        <YAxis
          type="category"
          dataKey="label"
          width={categoryWidth}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={ChartTooltip} />
        <Bar dataKey="value" name={measure} unit={unit} barSize={16} isAnimationActive={false}>
          {rows.map((row) => (
            <Cell key={row.key} fill={row.fill} />
          ))}
          <LabelList
            dataKey="display"
            position="right"
            offset={8}
            fill={CHART_INK.label}
            fontSize={11}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** "Code 12, Code 8, …" — the bar chart's numbers, in the accessible name. */
function barsAriaLabel(title: string, rows: BarRow[]): string {
  return `${title}. Horizontal bar chart. ${rows
    .map((row) => `${row.label}: ${row.display}`)
    .join('. ')}.`;
}

function trendAriaLabel(title: string, series: readonly TrendSeries[], periods: string[]): string {
  const first = periods[0];
  const last = periods[periods.length - 1];
  const span =
    first === undefined || last === undefined
      ? 'no periods'
      : `${periods.length} periods, ${first} to ${last}`;
  return `${title}. Line chart of ${series
    .map((entry) => entry.name)
    .join(', ')} over ${span}. The same figures are in the data table below.`;
}

// ─── Trends over time ────────────────────────────────────────────────────────

const DOCUMENT_TREND: readonly TrendSeries[] = [
  { key: 'total', name: 'Uploaded', index: 0 },
  { key: 'validated', name: 'Validated', index: 1 },
  { key: 'awaitingReview', name: 'Awaiting review', index: 2 },
  { key: 'failed', name: 'Failed', index: 3 },
];

const QUERY_TREND: readonly TrendSeries[] = [
  { key: 'total', name: 'Asked', index: 0 },
  { key: 'answered', name: 'Answered', index: 1 },
  { key: 'unsupported', name: 'Unsupported', index: 2 },
  { key: 'failed', name: 'Failed', index: 3 },
];

/**
 * Series names stay short because they are drawn twice: once in the legend and
 * once as the end label on the line itself, where a long one runs off the plot.
 * The precise definition lives in each chart's description instead.
 */
const REPORT_TREND: readonly TrendSeries[] = [
  { key: 'published', name: 'Published', index: 0 },
  { key: 'unreviewed', name: 'Unreviewed', index: 1 },
];

const ACCURACY_TREND: readonly TrendSeries[] = [
  { key: 'accuracy', name: 'Accuracy', index: 0, unit: '%' },
];

const CITATION_TREND: readonly TrendSeries[] = [
  { key: 'coverage', name: 'Coverage', index: 0, unit: '%' },
  { key: 'integrity', name: 'Integrity', index: 1, unit: '%' },
];

/**
 * The per-period charts.
 *
 * Every chart here is gated on the section actually being present — a `null`
 * section means "not requested", and an empty frame for it would read as "none
 * happened". `series` is exactly parallel to `range.buckets`, gap-free and in
 * order, and `bucket.label` is the server's own IST label: the fiscal quarter
 * form is `FY2026-27 Q1`, which the local `fiscalQuarterLabel` writes the other
 * way round, so nothing is derived here.
 *
 * The two cross-section metrics are deliberately absent: `series[].
 * automationCoveragePercent` and `timeSavedPercent` are ALWAYS null on a bucket
 * (`analytics.service.ts:698` builds the series with `{crossSection: false}`),
 * so charting them per period draws an empty line. They are headline figures,
 * from `totals`, and nowhere else.
 */
export function TrendCharts({ result }: { result: AnalyticsResult }) {
  const periods = result.series.map((bucket) => bucket.label);
  const granularityNoun = result.range.granularity === 'month' ? 'month' : 'fiscal quarter';

  const documents = hasSection(result.totals, 'documents')
    ? result.series.map((bucket) => {
        const block = hasSection(bucket, 'documents') ? bucket.documents : null;
        return {
          label: bucket.label,
          total: block?.total ?? null,
          validated: block?.validated ?? null,
          awaitingReview: block?.awaitingReview ?? null,
          failed: block?.failed ?? null,
          inProgress: block?.inProgress ?? null,
          avgOcrConfidence: block?.avgOcrConfidence ?? null,
        };
      })
    : null;

  const extraction = hasSection(result.totals, 'extraction')
    ? result.series.map((bucket) => {
        const block = hasSection(bucket, 'extraction') ? bucket.extraction : null;
        return {
          label: bucket.label,
          accuracy: block?.accuracyPercent ?? null,
          totalFields: block?.totalFields ?? null,
          overriddenFields: block?.overriddenFields ?? null,
          lowConfidence: block?.lowConfidence ?? null,
          avgConfidence: block?.avgConfidence ?? null,
        };
      })
    : null;

  const reports = hasSection(result.totals, 'reports')
    ? result.series.map((bucket) => {
        const block = hasSection(bucket, 'reports') ? bucket.reports : null;
        return {
          label: bucket.label,
          published: block?.published ?? null,
          unreviewed: block?.withUnreviewedFigures ?? null,
        };
      })
    : null;

  const queries = hasSection(result.totals, 'queries')
    ? result.series.map((bucket) => {
        const block = hasSection(bucket, 'queries') ? bucket.queries : null;
        return {
          label: bucket.label,
          total: block?.total ?? null,
          answered: block?.answered ?? null,
          unsupported: block?.unsupported ?? null,
          failed: block?.failed ?? null,
          deadLettered: block?.deadLettered ?? null,
          avgGenerationMs: block?.avgGenerationMs ?? null,
          coverage: block?.citationCoveragePercent ?? null,
          integrity: block?.citationIntegrityPercent ?? null,
        };
      })
    : null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {documents ? (
        <ChartBlock
          title="Documents"
          description={`Bucketed on upload date, by ${granularityNoun}. "Awaiting review" is validated AND flagged for review — a subset of validated, not of the review flag at large.`}
          ariaLabel={trendAriaLabel('Documents', DOCUMENT_TREND, periods)}
          caption="Documents per period"
          headers={[
            'Period',
            'Uploaded',
            'Validated',
            'Awaiting review',
            'Failed',
            'In progress',
            'Avg OCR confidence',
          ]}
          rows={documents.map((row) => ({
            key: row.label,
            cells: [
              row.label,
              row.total === null ? NO_FIGURE : formatCount(row.total),
              row.validated === null ? NO_FIGURE : formatCount(row.validated),
              row.awaitingReview === null ? NO_FIGURE : formatCount(row.awaitingReview),
              row.failed === null ? NO_FIGURE : formatCount(row.failed),
              row.inProgress === null ? NO_FIGURE : formatCount(row.inProgress),
              formatRatio(row.avgOcrConfidence),
            ],
          }))}
        >
          <TrendLineChart rows={documents} series={DOCUMENT_TREND} />
        </ChartBlock>
      ) : null}

      {extraction ? (
        <ChartBlock
          title="Extraction accuracy"
          description="Fields never manually overridden, as a share of all fields. Bucketed on the FIELD's own creation date, not the document's, so a backfill lands in today's bucket. Field counts are in the table — a count and a percentage never share an axis."
          ariaLabel={trendAriaLabel('Extraction accuracy', ACCURACY_TREND, periods)}
          caption="Extraction accuracy per period"
          headers={[
            'Period',
            'Accuracy',
            'Fields',
            'Overridden',
            'Low confidence',
            'Avg confidence (0–1)',
          ]}
          rows={extraction.map((row) => ({
            key: row.label,
            cells: [
              row.label,
              formatPercent(row.accuracy),
              row.totalFields === null ? NO_FIGURE : formatCount(row.totalFields),
              row.overriddenFields === null ? NO_FIGURE : formatCount(row.overriddenFields),
              row.lowConfidence === null ? NO_FIGURE : formatCount(row.lowConfidence),
              formatRatio(row.avgConfidence),
            ],
          }))}
        >
          <TrendLineChart rows={extraction} series={ACCURACY_TREND} />
        </ChartBlock>
      ) : null}

      {reports ? (
        <ChartBlock
          title="Reports published"
          description="Counted in the period they were PUBLISHED in, not created; archived reports stay counted where they were published, and drafts never appear. Unreviewed = published with figures nobody has checked."
          ariaLabel={trendAriaLabel('Reports published', REPORT_TREND, periods)}
          caption="Reports published per period"
          headers={['Period', 'Published', 'With unreviewed figures']}
          rows={reports.map((row) => ({
            key: row.label,
            cells: [
              row.label,
              row.published === null ? NO_FIGURE : formatCount(row.published),
              row.unreviewed === null ? NO_FIGURE : formatCount(row.unreviewed),
            ],
          }))}
        >
          <TrendLineChart rows={reports} series={REPORT_TREND} />
        </ChartBlock>
      ) : null}

      {queries ? (
        <ChartBlock
          title="Queries"
          description="Scoped by containment: a query asked across several subsidiaries counts only when every one of them is inside the current scope, so this block narrows faster than the others under a subsidiary filter. Asked is larger than the outcomes while queries are still running."
          ariaLabel={trendAriaLabel('Queries', QUERY_TREND, periods)}
          caption="Queries per period"
          headers={[
            'Period',
            'Asked',
            'Answered',
            'Unsupported',
            'Failed',
            'Dead-lettered',
            'Avg generation',
          ]}
          rows={queries.map((row) => ({
            key: row.label,
            cells: [
              row.label,
              row.total === null ? NO_FIGURE : formatCount(row.total),
              row.answered === null ? NO_FIGURE : formatCount(row.answered),
              row.unsupported === null ? NO_FIGURE : formatCount(row.unsupported),
              row.failed === null ? NO_FIGURE : formatCount(row.failed),
              row.deadLettered === null ? NO_FIGURE : formatCount(row.deadLettered),
              formatMs(row.avgGenerationMs),
            ],
          }))}
        >
          <TrendLineChart rows={queries} series={QUERY_TREND} />
        </ChartBlock>
      ) : null}

      {queries ? (
        <ChartBlock
          title="Citation coverage and integrity"
          description="Two different ratios, not two views of one. Coverage is answered queries carrying at least one citation ÷ answered queries. Integrity is accepted citations ÷ (accepted + discarded) citations. Either labelled as the other misstates the figure."
          ariaLabel={trendAriaLabel('Citation coverage and integrity', CITATION_TREND, periods)}
          caption="Citation coverage and integrity per period"
          headers={['Period', 'Coverage', 'Integrity']}
          rows={queries.map((row) => ({
            key: row.label,
            cells: [row.label, formatPercent(row.coverage), formatPercent(row.integrity)],
          }))}
        >
          <TrendLineChart rows={queries} series={CITATION_TREND} />
        </ChartBlock>
      ) : null}
    </div>
  );
}

// ─── Status and type breakdowns ──────────────────────────────────────────────

interface StatusSlice {
  key: string;
  label: string;
  value: number;
  tone: Tone;
  fill: string;
}

/**
 * Document lifecycle, over the whole window.
 *
 * The three states partition `total` (queued and processing are folded into "in
 * progress"), which is why `awaitingReview`, `requiresReview` and
 * `injectionFlagged` are NOT bars here: they are flags that cut across the
 * statuses, and a bar beside the others would imply a fourth slice of the same
 * pie. They are listed underneath instead.
 */
function documentStatusSlices(documents: DocumentsBlock): StatusSlice[] {
  return [
    {
      key: 'validated',
      label: 'Validated',
      value: documents.validated,
      tone: 'success',
      fill: STATUS_COLORS.success,
    },
    {
      key: 'inProgress',
      label: 'In progress',
      value: documents.inProgress,
      tone: 'progress',
      fill: STATUS_COLORS.progress,
    },
    {
      key: 'failed',
      label: 'Failed',
      value: documents.failed,
      tone: 'danger',
      fill: STATUS_COLORS.danger,
    },
  ];
}

/**
 * Query outcomes.
 *
 * Failed and dead-lettered share the danger colour deliberately: both are
 * terminal failures, and here as everywhere the axis label is what identifies
 * the bar. STATUS_COLORS are reserved for exactly this and never reused as a
 * series colour.
 */
function queryOutcomeSlices(queries: QueriesBlock): StatusSlice[] {
  return [
    {
      key: 'answered',
      label: 'Answered',
      value: queries.answered,
      tone: 'success',
      fill: STATUS_COLORS.success,
    },
    {
      key: 'unsupported',
      label: 'Unsupported',
      value: queries.unsupported,
      tone: 'warning',
      fill: STATUS_COLORS.warning,
    },
    {
      key: 'failed',
      label: 'Failed',
      value: queries.failed,
      tone: 'danger',
      fill: STATUS_COLORS.danger,
    },
    {
      key: 'deadLettered',
      label: 'Dead-lettered',
      value: queries.deadLettered,
      tone: 'danger',
      fill: STATUS_COLORS.danger,
    },
  ];
}

/** Colour, icon and word together — none of the three carries the state alone. */
function StatusLegend({ slices }: { slices: StatusSlice[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {slices.map((slice) => (
        <li key={slice.key}>
          <Badge tone={slice.tone} srPrefix="Status">
            {slice.label} {formatCount(slice.value)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function StatusBarChart({
  title,
  description,
  caption,
  measure,
  noun,
  slices,
  footnote,
}: {
  title: string;
  description: ReactNode;
  caption: string;
  /** The category column: "Status", "Outcome". */
  measure: string;
  /** What is being counted: "Documents", "Queries". */
  noun: string;
  slices: StatusSlice[];
  footnote?: ReactNode;
}) {
  const rows: BarRow[] = slices.map((slice) => ({
    key: slice.key,
    label: slice.label,
    value: slice.value,
    display: formatCount(slice.value),
    fill: slice.fill,
  }));

  return (
    <ChartBlock
      title={title}
      description={description}
      ariaLabel={barsAriaLabel(title, rows)}
      caption={caption}
      headers={[measure, noun]}
      rows={rows.map((row) => ({ key: row.key, cells: [row.label, row.display] }))}
      footer={
        <div className="flex flex-col gap-2">
          <StatusLegend slices={slices} />
          {footnote ? <p className="text-xs text-text-muted">{footnote}</p> : null}
        </div>
      }
    >
      <HorizontalBars rows={rows} measure={noun} categoryWidth={110} />
    </ChartBlock>
  );
}

/**
 * The whole-window status breakdowns.
 *
 * Each is gated on its section being present rather than on the counts being
 * non-zero: zero validated documents is a fact worth showing, whereas a missing
 * section is a question that was never asked.
 */
export function StatusBreakdowns({ totals }: { totals: AnalyticsSlice }) {
  const documents = hasSection(totals, 'documents') ? totals.documents : null;
  const queries = hasSection(totals, 'queries') ? totals.queries : null;

  const typeMax = documents
    ? documents.byType.reduce((highest, entry) => Math.max(highest, entry.count), 0)
    : 0;

  const typeRows: BarRow[] = documents
    ? [...documents.byType]
        .sort((a, b) => b.count - a.count)
        .map((entry) => ({
          key: entry.type,
          label: documentTypeLabel(entry.type),
          value: entry.count,
          display: formatCount(entry.count),
          // One measure, one hue, light to dark — magnitude, not identity.
          fill: sequentialStep(entry.count, 0, typeMax),
        }))
    : [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {documents ? (
        <StatusBarChart
          title="Documents by status"
          description="The whole window. Queued and processing are folded together as in progress."
          caption="Documents by status"
          measure="Status"
          noun="Documents"
          slices={documentStatusSlices(documents)}
          footnote={
            <>
              Cutting across those states: {formatCount(documents.awaitingReview)} validated and
              awaiting review, {formatCount(documents.requiresReview)} flagged for review at any
              status, and {formatCount(documents.injectionFlagged)} flagged for suspicious content.
              Only the first of those feeds automation coverage.
            </>
          }
        />
      ) : null}

      {documents && typeRows.length > 0 ? (
        <ChartBlock
          title="Documents by file type"
          description="A type with no documents in the window is absent rather than zero — the breakdown carries no zero-fill."
          ariaLabel={barsAriaLabel('Documents by file type', typeRows)}
          caption="Documents by file type"
          headers={['File type', 'Documents']}
          rows={typeRows.map((row) => ({ key: row.key, cells: [row.label, row.display] }))}
        >
          <HorizontalBars rows={typeRows} measure="Documents" categoryWidth={110} />
        </ChartBlock>
      ) : null}

      {queries ? (
        <StatusBarChart
          title="Queries by outcome"
          description="The whole window. Queries still queued or running have no outcome yet and appear only in the total."
          caption="Queries by outcome"
          measure="Outcome"
          noun="Queries"
          slices={queryOutcomeSlices(queries)}
          footnote={
            <>
              {formatCount(queries.total)} asked in total, {formatCount(queries.parliamentary)}{' '}
              parliamentary, {formatCount(queries.pendingReview)} pending review, and{' '}
              {formatCount(queries.injectionSuspected)} with suspected injection.{' '}
              {formatCount(queries.passagesWithheld)} passages were withheld — passages, not
              queries.
            </>
          }
        />
      ) : null}
    </div>
  );
}

// ─── By subsidiary ───────────────────────────────────────────────────────────

interface SubsidiaryMetric {
  key:
    | 'documentsTotal'
    | 'documentsValidated'
    | 'extractionAccuracyPercent'
    | 'reportsPublished'
    | 'queriesAsked';
  label: string;
  /** The section that has to be included for this column to mean anything. */
  section: AnalyticsSectionKey;
  percent: boolean;
}

const SUBSIDIARY_METRICS: readonly SubsidiaryMetric[] = [
  { key: 'documentsTotal', label: 'Documents ingested', section: 'documents', percent: false },
  { key: 'documentsValidated', label: 'Documents validated', section: 'documents', percent: false },
  {
    key: 'extractionAccuracyPercent',
    label: 'Extraction accuracy',
    section: 'extraction',
    percent: true,
  },
  { key: 'reportsPublished', label: 'Reports published', section: 'reports', percent: false },
  { key: 'queriesAsked', label: 'Queries asked', section: 'queries', percent: false },
];

/**
 * The per-subsidiary breakdown.
 *
 * ─── WHY THIS IS NOT A MULTI-SERIES CHART ───────────────────────────────────
 * There are eight CIL subsidiaries and MAX_SERIES is six, so a categorical
 * palette cannot even seat them — and a seventh hue is not something to invent.
 * One measure at a time, as sorted single-hue bars with the value written on
 * each, answers the actual question ("who is ahead?") and stays readable to a
 * colour-blind reader, because rank is carried by position and the number is
 * carried by text.
 *
 * ─── AND WHY EACH COLUMN IS GATED ───────────────────────────────────────────
 * A section the caller did not `include` still produces rows: with
 * `include=documents` every row carries `reportsPublished: 0` and
 * `queriesAsked: 0` (`analytics.service.ts:720-725`), which are indistinguish-
 * able from a real zero. `includesSection` is the only thing that separates
 * "none" from "never computed", so a column the request did not ask for is not
 * offered at all.
 */
export function SubsidiaryBreakdown({
  rows,
  include,
}: {
  rows: SubsidiaryBreakdownRow[];
  include: AnalyticsInclude;
}) {
  const available = SUBSIDIARY_METRICS.filter((metric) => includesSection(include, metric.section));
  const [selectedKey, setSelectedKey] = useState<SubsidiaryMetric['key']>('documentsTotal');

  // Derived rather than synced: when `include` narrows, the chosen measure can
  // stop being available, and an effect that corrected it after the fact would
  // render one frame of the wrong column first.
  const metric = available.find((entry) => entry.key === selectedKey) ?? available[0];
  if (!metric) return null;

  const sorted = [...rows]
    // Nulls sort last: a null accuracy is "no fields in the window", which is
    // not a low score.
    .sort((a, b) => (b[metric.key] ?? -1) - (a[metric.key] ?? -1));

  const max = sorted.reduce((highest, row) => Math.max(highest, row[metric.key] ?? 0), 0);

  // Each caveat belongs to a column, so it appears only when that column does.
  const caveats: string[] = [
    includesSection(include, 'queries')
      ? 'Queries asked counts a query once against every subsidiary it was scoped to, so that column deliberately does not add up to the query total.'
      : '',
    includesSection(include, 'extraction')
      ? 'Extraction accuracy is blank when a subsidiary produced no fields in the window.'
      : '',
  ].filter((caveat) => caveat !== '');

  const barRows: BarRow[] = sorted.map((row) => {
    const value = row[metric.key];
    return {
      key: row.subsidiaryId,
      /*
       * The row's OWN `code`, not `SubsidiaryLabel` — an axis tick is a plain
       * string, and analytics deliberately resolves the code without an
       * `isDeleted` filter (`analytics.service.ts:415-420`), so a soft-deleted
       * subsidiary still has a name here after it has left the picker's list.
       * The table below pairs the id with the shared label component instead.
       */
      label: row.code ?? NO_FIGURE,
      value,
      display: formatMetric(value, metric.percent),
      // One measure, one hue, light to dark. A null has no magnitude and takes
      // the lightest step; the bar it would fill is absent anyway.
      fill: sequentialStep(value ?? 0, 0, max),
    };
  });

  return (
    <div className="flex flex-col gap-3">
      {available.length > 1 ? (
        <div className="max-w-72">
          <Field label="Measure">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={metric.key}
                onChange={(next) => setSelectedKey(next as SubsidiaryMetric['key'])}
              >
                {available.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : null}

      <ChartBlock
        title={metric.label}
        description="Sorted, one measure at a time and in a single hue: eight subsidiaries are more than a colour-blind-safe palette can hold, so rank is carried by position and the value is written on the bar."
        ariaLabel={barsAriaLabel(metric.label, barRows)}
        caption={`${metric.label} by subsidiary`}
        // `available` is both the measure list and the column list: a column is
        // offered exactly when its section was computed.
        headers={['Subsidiary', ...available.map((column) => column.label)]}
        rows={sorted.map((row) => ({
          key: row.subsidiaryId,
          cells: [
            <SubsidiaryLabel key="subsidiary" id={row.subsidiaryId} showName />,
            ...available.map((column) => formatMetric(row[column.key], column.percent)),
          ],
        }))}
        footer={
          caveats.length > 0 ? (
            <p className="text-xs text-text-muted">{caveats.join(' ')}</p>
          ) : null
        }
      >
        <HorizontalBars
          rows={barRows}
          measure={metric.label}
          unit={metric.percent ? '%' : undefined}
        />
      </ChartBlock>
    </div>
  );
}
