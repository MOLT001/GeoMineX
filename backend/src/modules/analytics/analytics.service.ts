/**
 * Analytics — PRD §4.6, §1.5, §5.3, §8.2, instructions §4a.
 *
 * The counterpart to `/dashboard`, not a duplicate of it: the dashboard is the
 * CURRENT SNAPSHOT, this is the SERIES AND BREAKDOWN behind it. Both derive
 * every percentage from `./metricFormulas.js`, which is why they cannot report
 * different accuracy for the same period (D11). No metric definition is
 * restated in this file — a definition stated twice is exactly how the §5.3
 * card and the §4.6 chart come to disagree.
 *
 * TWO RULES THAT PRODUCE THE NUMBERS, AND WOULD PRODUCE PLAUSIBLE WRONG ONES
 * IF REVERSED:
 *
 *   1. RAW COUNTERS ARE SUMMED FIRST, PERCENTAGES DERIVED SECOND. A quarter's
 *      accuracy is `total correct / total fields` FOR THE QUARTER — never the
 *      mean of three monthly percentages, which would weight a quiet March
 *      equally with a busy May. The `totals` block is likewise computed by its
 *      own `_id: null` group in the same pass, not by folding the series.
 *
 *   2. ZERO-FILL IS ASYMMETRIC (D13). A bucket with no rows gets `0` for every
 *      COUNT and `null` for every RATIO. Zero documents in a month is a true
 *      statement. A plotted 0% accuracy for a period with no extractions is a
 *      fabricated figure — the same class of defect §4.6 names when it calls a
 *      stale figure presented as live a traceability failure. `metricFormulas`
 *      returns `null` for the no-evidence case and this path passes it through;
 *      only the dashboard's snapshot coerces `?? 0`, where visible counts
 *      alongside make a 0 unambiguous.
 *
 * Everything is computed by aggregation pipeline, cached under a key that
 * carries both the caller's scope and every request parameter, and returned
 * with `computedAt`, `cached` and an `assumptions` block — because a derived
 * percentage whose assumptions are invisible is not a traceable figure.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { logger } from '../../utils/logger.js';
import type { AuthContext } from '../../utils/authorization.js';
import {
  FISCAL_YEAR_START_MONTH,
  IST_LABEL,
  bucketLabel,
  bucketRangeUtc,
  currentFiscalYearRangeUtc,
  enumerateBuckets,
  istDateBoundaryToUtc,
  istParts,
  type Granularity,
} from '../../utils/istPeriod.js';
import {
  PAYLOAD_VERSION,
  cacheKeyOf,
  metricAssumptionsFingerprint,
  resolveScope,
  type ResolvedScope,
} from '../../utils/scopeKey.js';
import { getCached, setCached } from '../../utils/aggregateCache.js';
import { DocumentModel } from '../documents/document.model.js';
import { ExtractedField } from '../documents/extractedField.model.js';
import { Report } from '../reports/report.model.js';
import { Subsidiary } from '../subsidiaries/subsidiary.model.js';
import { QueryModel } from '../queries/query.model.js';
import { AnalyticsCache } from './analyticsCache.model.js';
import {
  automationCoveragePercent,
  citationCoveragePercent,
  citationIntegrityPercent,
  extractionAccuracyPercent,
  timeSavedPercent,
} from './metricFormulas.js';
import {
  buildDocumentHealthPipeline,
  buildDocumentsPipeline,
  buildExtractionPipeline,
  buildQueriesPipeline,
  buildQueryHealthPipeline,
  buildQueryScopeClause,
  buildReportsPipeline,
  type AnalyticsPipelineArgs,
  type DocumentBucketRow,
  type DocumentHealthRow,
  type DocumentSubsidiaryRow,
  type DocumentTotalsRow,
  type DocumentsFacet,
  type ExtractionBucketRow,
  type ExtractionFacet,
  type ExtractionSubsidiaryRow,
  type ExtractionTotalsRow,
  type QueriesFacet,
  type QueryBucketRow,
  type QueryHealthRow,
  type QuerySubsidiaryRow,
  type QueryTotalsRow,
  type ReportBucketRow,
  type ReportSubsidiaryRow,
  type ReportTotalsRow,
  type ReportsFacet,
} from './analytics.pipelines.js';
import type { AnalyticsInclude, GetAnalyticsQuery } from './analytics.schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Response shape (§6.6)
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentTypeCount {
  type: string;
  count: number;
}

export interface DocumentsBlock {
  total: number;
  validated: number;
  failed: number;
  inProgress: number;
  requiresReview: number;
  /** Validated AND flagged — the Automation Coverage denominator's other half. */
  awaitingReview: number;
  injectionFlagged: number;
  avgOcrConfidence: number | null;
  byType: DocumentTypeCount[];
}

export interface ExtractionBlock {
  totalFields: number;
  overriddenFields: number;
  correctedDocuments: number;
  avgConfidence: number | null;
  lowConfidence: number;
  accuracyPercent: number | null;
}

export interface ReportsBlock {
  published: number;
  withUnreviewedFigures: number;
}

export interface QueriesBlock {
  total: number;
  answered: number;
  unsupported: number;
  failed: number;
  deadLettered: number;
  parliamentary: number;
  pendingReview: number;
  /** The §1.5 numerator, exposed so the coverage percentage is checkable by hand. */
  withCitations: number;
  citationsAccepted: number;
  citationsDiscarded: number;
  citationCoveragePercent: number | null;
  citationIntegrityPercent: number | null;
  injectionSuspected: number;
  passagesWithheld: number;
  avgGenerationMs: number | null;
}

/**
 * One period's figures. `null` for a whole block means the caller did not ask
 * for it via `include`, which is a different statement from a block of zeroes.
 */
export interface AnalyticsSlice {
  documents: DocumentsBlock | null;
  extraction: ExtractionBlock | null;
  reports: ReportsBlock | null;
  queries: QueriesBlock | null;
  /** Both cross-section figures need documents AND extraction to be meaningful. */
  automationCoveragePercent: number | null;
  timeSavedPercent: number | null;
}

export interface AnalyticsBucket extends AnalyticsSlice {
  bucket: string;
  label: string;
  /** The half-open UTC window this bucket covers, so a chart axis needs no re-derivation. */
  bucketStart: string;
  bucketEnd: string;
}

export interface SubsidiaryBreakdownRow {
  subsidiaryId: string;
  /** `null` when the subsidiary row itself has since been removed. */
  code: string | null;
  documentsTotal: number;
  documentsValidated: number;
  extractionAccuracyPercent: number | null;
  reportsPublished: number;
  /**
   * A query asked over several subsidiaries counts once against each, so this
   * column does not sum to `totals.queries.total`. See the pipeline's note.
   */
  queriesAsked: number;
}

export interface PipelineHealth {
  documentsQueued: number;
  documentsProcessing: number;
  documentsFailed: number;
  queriesQueued: number;
  queriesInFlight: number;
  queriesFailed: number;
  queriesDeadLettered: number;
  /** `null` when nothing is queued at all — an empty queue has no age. */
  oldestQueuedAgeSeconds: number | null;
  inFlightPastTimeout: number;
}

export interface AnalyticsAssumptions {
  baselineManualMinutesPerDoc: number;
  minutesPerManualOverride: number;
  ocrReviewThreshold: number;
  extractionAccuracyDefinition: string;
}

export interface AnalyticsRange {
  /** IST calendar dates, inclusive of `to` as a whole day. */
  from: string;
  to: string;
  /** The half-open UTC window actually matched on, so the figures are reproducible. */
  fromUtc: string;
  toUtc: string;
  granularity: Granularity;
  buckets: string[];
  timezone: string;
  fiscalYearStartMonth: number;
}

export interface AnalyticsPayload {
  scope: { subsidiaryIds: string[]; unscoped: boolean };
  range: AnalyticsRange;
  series: AnalyticsBucket[];
  totals: AnalyticsSlice;
  /** `null` when `includeBySubsidiary=false`. */
  bySubsidiary: SubsidiaryBreakdownRow[] | null;
  pipeline: PipelineHealth;
  assumptions: AnalyticsAssumptions;
}

export interface AnalyticsResult extends AnalyticsPayload {
  computedAt: string;
  /** True when served from cache. Read it together with `computedAt` (§4.6). */
  cached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Presentation rounding ONLY. These are not metric definitions and must not
 * grow into any: every percentage in this file comes from metricFormulas.ts.
 *
 * Averages keep more precision than percentages because a confidence score
 * lives in 0..1, where one decimal place would erase the difference between a
 * document that just cleared the review threshold and one that sailed past it.
 */
const round2 = (n: number | null | undefined): number | null =>
  typeof n === 'number' ? Math.round(n * 100) / 100 : null;

/** Generation latency is reported in whole milliseconds; sub-millisecond precision is noise. */
const round0 = (n: number | null | undefined): number | null =>
  typeof n === 'number' ? Math.round(n) : null;

/** 'YYYY-MM-DD' for an instant, read on the IST calendar. */
function istCalendarDate(utc: Date): string {
  const { year, month, day } = istParts(utc);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * D13 in one place: a missing row means the period had no rows, so every COUNT
 * is a truthful `0` and every RATIO stays `null`.
 */
function presentDocuments(
  row: DocumentTotalsRow | undefined,
  byType: DocumentTypeCount[],
): DocumentsBlock {
  return {
    total: row?.total ?? 0,
    validated: row?.validated ?? 0,
    failed: row?.failed ?? 0,
    inProgress: row?.inProgress ?? 0,
    requiresReview: row?.requiresReview ?? 0,
    awaitingReview: row?.awaitingReview ?? 0,
    injectionFlagged: row?.injectionFlagged ?? 0,
    avgOcrConfidence: round2(row?.avgOcrConfidence),
    byType,
  };
}

function presentExtraction(row: ExtractionTotalsRow | undefined): ExtractionBlock {
  const totalFields = row?.totalFields ?? 0;
  const overriddenFields = row?.overriddenFields ?? 0;
  return {
    totalFields,
    overriddenFields,
    correctedDocuments: row?.correctedDocuments ?? 0,
    avgConfidence: round2(row?.avgConfidence),
    lowConfidence: row?.lowConfidence ?? 0,
    accuracyPercent: extractionAccuracyPercent(totalFields, overriddenFields),
  };
}

function presentReports(row: ReportTotalsRow | undefined): ReportsBlock {
  return {
    published: row?.published ?? 0,
    withUnreviewedFigures: row?.withUnreviewedFigures ?? 0,
  };
}

function presentQueries(row: QueryTotalsRow | undefined): QueriesBlock {
  const answered = row?.answered ?? 0;
  const withCitations = row?.withCitations ?? 0;
  const citationsAccepted = row?.citationsAccepted ?? 0;
  const citationsDiscarded = row?.citationsDiscarded ?? 0;
  return {
    total: row?.total ?? 0,
    answered,
    unsupported: row?.unsupported ?? 0,
    failed: row?.failed ?? 0,
    deadLettered: row?.deadLettered ?? 0,
    parliamentary: row?.parliamentary ?? 0,
    pendingReview: row?.pendingReview ?? 0,
    withCitations,
    citationsAccepted,
    citationsDiscarded,
    citationCoveragePercent: citationCoveragePercent(answered, withCitations),
    citationIntegrityPercent: citationIntegrityPercent(citationsAccepted, citationsDiscarded),
    injectionSuspected: row?.injectionSuspected ?? 0,
    passagesWithheld: row?.passagesWithheld ?? 0,
    avgGenerationMs: round0(row?.avgGenerationMs),
  };
}

/**
 * Assemble one period from whichever blocks the caller asked for.
 *
 * Automation Coverage and Time Saved read counters from BOTH the documents and
 * the extraction pipeline, so a request that excluded either reports them as
 * `null` rather than computing them from a half-present denominator.
 *
 * THEY ARE ALSO `null` FOR EVERY INDIVIDUAL BUCKET, and that is deliberate.
 *
 * The two pipelines run on different clocks, and correctly so: a document is
 * counted in the period it arrived, and an extraction in the period it was
 * produced. Those coincide most of the time and diverge exactly when it
 * matters — a document uploaded in Q1 whose OCR is retried in Q2 puts its
 * document row in one bucket and all of its field rows in the next. Both
 * numbers are right on their own clock; the RATIO between them is not, because
 * its numerator and its subtrahend then live in different buckets and the
 * correction is subtracted in neither.
 *
 * `metricFormulas` clamps at zero, so the error cannot even average out: a
 * bucket that lost its corrections reports 100% while the bucket that received
 * them floors at 0, and the plotted line reads systematically better than
 * reality. A chart claiming 100% automation above a total of 0% is worse than
 * no chart, in a product whose purpose is figures you can trace.
 *
 * `totals` is computed over the whole window, where both pipelines cover the
 * same span, so both ratios are meaningful there and are reported there.
 * `extractionAccuracyPercent` stays per-bucket throughout: its numerator and
 * denominator both come from the extraction pipeline, on one clock.
 *
 * Fixing this properly means denormalising the parent document's date onto
 * every field row and backfilling it — a migration, not a patch. Until then the
 * honest answer per bucket is "not computable", which is the same rule the
 * empty-period case already follows.
 */
function buildSlice(
  parts: {
    documents: DocumentsBlock | null;
    extraction: ExtractionBlock | null;
    reports: ReportsBlock | null;
    queries: QueriesBlock | null;
  },
  opts: { crossSection: boolean },
): AnalyticsSlice {
  const { documents, extraction } = parts;
  const computable = opts.crossSection && documents !== null && extraction !== null;
  return {
    ...parts,
    automationCoveragePercent: computable
      ? automationCoveragePercent(
          documents.validated,
          extraction.correctedDocuments,
          documents.awaitingReview,
        )
      : null,
    timeSavedPercent: computable ? timeSavedPercent(documents.total, extraction.overriddenFields) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-subsidiary breakdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subsidiary codes are resolved with ONE `Subsidiary.find({ _id: { $in } })`,
 * never a `$lookup`: the 4.0 feature floor rules out the `$lookup` form that
 * would be readable here (D14), and the id set is already bounded by the number
 * of subsidiaries that appeared in the range.
 */
async function buildSubsidiaryBreakdown(rows: {
  documents: DocumentSubsidiaryRow[];
  extraction: ExtractionSubsidiaryRow[];
  reports: ReportSubsidiaryRow[];
  queries: QuerySubsidiaryRow[];
}): Promise<SubsidiaryBreakdownRow[]> {
  const ids = new Set<string>();
  for (const r of rows.documents) ids.add(String(r._id));
  for (const r of rows.extraction) ids.add(String(r._id));
  for (const r of rows.reports) ids.add(String(r._id));
  for (const r of rows.queries) ids.add(String(r._id));
  if (ids.size === 0) return [];

  const objectIds = [...ids].map((id) => new Types.ObjectId(id));
  // Soft-deleted subsidiaries are NOT filtered out: their documents still
  // exist and are still counted above, so hiding the code would leave a row
  // labelled with a bare id and no way to explain it.
  const subsidiaries = await Subsidiary.find({ _id: { $in: objectIds } })
    .select({ code: 1 })
    .lean();
  const codeById = new Map<string, string>(subsidiaries.map((s) => [String(s._id), s.code]));

  const documentsById = new Map<string, DocumentSubsidiaryRow>(
    rows.documents.map((r) => [String(r._id), r]),
  );
  const extractionById = new Map<string, ExtractionSubsidiaryRow>(
    rows.extraction.map((r) => [String(r._id), r]),
  );
  const reportsById = new Map<string, ReportSubsidiaryRow>(
    rows.reports.map((r) => [String(r._id), r]),
  );
  const queriesById = new Map<string, QuerySubsidiaryRow>(
    rows.queries.map((r) => [String(r._id), r]),
  );

  const out: SubsidiaryBreakdownRow[] = [...ids].map((id) => {
    const ex = extractionById.get(id);
    return {
      subsidiaryId: id,
      code: codeById.get(id) ?? null,
      documentsTotal: documentsById.get(id)?.total ?? 0,
      documentsValidated: documentsById.get(id)?.validated ?? 0,
      extractionAccuracyPercent: ex
        ? extractionAccuracyPercent(ex.totalFields, ex.overriddenFields)
        : null,
      reportsPublished: reportsById.get(id)?.published ?? 0,
      queriesAsked: queriesById.get(id)?.queriesAsked ?? 0,
    };
  });

  // Code order, with the id as the tie-break so the ordering is total and
  // reproducible. Plain comparison, not localeCompare: a collation that varies
  // with the host's ICU build is not something a cached payload may depend on.
  out.sort((a, b) => {
    const ca = a.code ?? '';
    const cb = b.code ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.subsidiaryId < b.subsidiaryId ? -1 : 1;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline health (§4a)
// ─────────────────────────────────────────────────────────────────────────────

function presentPipelineHealth(
  documentRows: DocumentHealthRow[],
  queryRows: QueryHealthRow[],
  now: Date,
): PipelineHealth {
  const docs = new Map<string, DocumentHealthRow>(documentRows.map((r) => [r._id, r]));
  const queries = new Map<string, QueryHealthRow>(queryRows.map((r) => [r._id, r]));

  const queriesInFlight =
    (queries.get('retrieving')?.count ?? 0) + (queries.get('answering')?.count ?? 0);

  // In-flight only: a `queued` row has no `processingStartedAt`, and a terminal
  // one is not in flight, so neither can be past a processing timeout.
  const inFlightPastTimeout =
    (queries.get('retrieving')?.pastTimeout ?? 0) + (queries.get('answering')?.pastTimeout ?? 0);

  /**
   * The age of the oldest thing WAITING, across both queues. Documents carry no
   * `processingStartedAt`, so a stuck document shows up here as a queue that
   * stops draining rather than as an `inFlightPastTimeout` count.
   */
  const queuedSince = [docs.get('queued')?.oldest, queries.get('queued')?.oldest].filter(
    (d): d is Date => d instanceof Date,
  );
  const oldest = queuedSince.length > 0 ? Math.min(...queuedSince.map((d) => d.getTime())) : null;

  return {
    documentsQueued: docs.get('queued')?.count ?? 0,
    documentsProcessing: docs.get('processing')?.count ?? 0,
    documentsFailed: docs.get('failed')?.count ?? 0,
    queriesQueued: queries.get('queued')?.count ?? 0,
    queriesInFlight,
    queriesFailed: queries.get('failed')?.count ?? 0,
    queriesDeadLettered: queries.get('dead_lettered')?.count ?? 0,
    // Clamped at 0: a clock adjustment must not report a negative age.
    oldestQueuedAgeSeconds:
      oldest === null ? null : Math.max(0, Math.round((now.getTime() - oldest) / 1000)),
    inFlightPastTimeout,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The read path
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_DOCUMENTS_FACET: DocumentsFacet = { series: [], byType: [], totals: [] };
const EMPTY_EXTRACTION_FACET: ExtractionFacet = { series: [], totals: [] };
const EMPTY_REPORTS_FACET: ReportsFacet = { series: [], totals: [] };
const EMPTY_QUERIES_FACET: QueriesFacet = { series: [], totals: [] };

/**
 * The `assumptions` block travels WITH the figures for the same reason
 * `computedAt` does: a derived percentage whose assumptions are invisible is
 * not a traceable figure, and §4.6 treats untraceable figures as a defect.
 *
 * The definition string is the API's own statement of what the number means,
 * for a reader who will never open this repository. The ARITHMETIC behind it
 * exists in exactly one place — metricFormulas.ts — and this string must be
 * changed only alongside it.
 */
function assumptions(): AnalyticsAssumptions {
  return {
    baselineManualMinutesPerDoc: env.BASELINE_MANUAL_MINUTES_PER_DOC,
    minutesPerManualOverride: env.MINUTES_PER_MANUAL_OVERRIDE,
    ocrReviewThreshold: env.OCR_REVIEW_THRESHOLD,
    extractionAccuracyDefinition: 'fields never manually overridden / total fields',
  };
}

/**
 * §4.6 / §7.7 — the series and breakdown behind the dashboard snapshot.
 *
 * @param query validated request parameters (`validatedQuery`, never `req.query`).
 * @param user  the caller; their grants are folded into every pipeline AND into
 *              the cache key, so a CIL user can neither compute nor read an
 *              aggregate covering a subsidiary they do not hold.
 */
export async function getAnalytics(
  query: GetAnalyticsQuery,
  user: AuthContext,
): Promise<AnalyticsResult> {
  // One clock for the whole response: the default range, the queue ages and
  // the stuck-job cutoff must all agree about "now".
  const now = new Date();

  // 1. Scope. A requested subsidiary the caller does not hold is 404, never 403.
  const scope: ResolvedScope = resolveScope(user, query.subsidiaryId);

  // 2. Range, from IST CALENDAR dates, defaulting to the fiscal year to date.
  const fallback = currentFiscalYearRangeUtc(now);
  const gte = query.from ? istDateBoundaryToUtc(query.from, 'start') : fallback.gte;
  const lt = query.to ? istDateBoundaryToUtc(query.to, 'endExclusive') : fallback.lt;
  if (gte >= lt) {
    throw ApiError.invalidRequest('Range ends before it starts');
  }

  const buckets = enumerateBuckets(query.granularity, gte, lt);
  if (buckets.length > env.ANALYTICS_MAX_BUCKETS) {
    // The ceiling is enforced here rather than in Zod because it depends on the
    // granularity as well as the two dates. Without it, `granularity=month`
    // over a century is a single cheap request that schedules a hundred group
    // stages per collection — a denial of service, not a slow query.
    throw ApiError.invalidRequest(
      `Range covers ${buckets.length} ${query.granularity} buckets; the maximum is ${env.ANALYTICS_MAX_BUCKETS}`,
    );
  }

  const fromIso = query.from ?? istCalendarDate(gte);
  // `to` is inclusive as a calendar day, so the last instant inside the
  // half-open window is the day the caller means.
  const toIso = query.to ?? istCalendarDate(new Date(lt.getTime() - 1));
  const includeBySubsidiary = query.includeBySubsidiary === 'true';

  // 3. Cache. The key carries the payload version and the assumptions
  //    fingerprint (D12) so a shape change or a retuned constant can never
  //    serve a figure computed under the old rules, and every request
  //    parameter, so one caller's Q1 is never another caller's Q3.
  const cacheKey = cacheKeyOf([
    'analytics',
    PAYLOAD_VERSION,
    metricAssumptionsFingerprint(),
    scope.key,
    query.granularity,
    fromIso,
    toIso,
    query.include,
    query.includeBySubsidiary,
  ]);

  const hit = await getCached<AnalyticsPayload>(AnalyticsCache, cacheKey);
  if (hit) {
    return { ...hit.payload, computedAt: hit.computedAt.toISOString(), cached: true };
  }

  // 4. Miss — compute.
  const args: AnalyticsPipelineArgs = {
    scope,
    range: { gte, lt },
    granularity: query.granularity,
    includeBySubsidiary,
  };
  const wants = (section: Exclude<AnalyticsInclude, 'all'>): boolean =>
    query.include === 'all' || query.include === section;

  const queryScope = buildQueryScopeClause(user, scope);
  const stuckBefore = new Date(now.getTime() - env.QUERY_STUCK_TIMEOUT_MINUTES * 60_000);

  logger.debug('Computing analytics (cache miss)', {
    granularity: query.granularity,
    buckets: buckets.length,
    include: query.include,
    unscoped: scope.subsidiaryIds === null,
  });

  const documentsPromise: Promise<DocumentsFacet[]> = wants('documents')
    ? DocumentModel.aggregate<DocumentsFacet>(buildDocumentsPipeline(args)).allowDiskUse(true).exec()
    : Promise.resolve([]);
  const extractionPromise: Promise<ExtractionFacet[]> = wants('extraction')
    ? ExtractedField.aggregate<ExtractionFacet>(
        buildExtractionPipeline(args, env.OCR_REVIEW_THRESHOLD),
      )
        .allowDiskUse(true)
        .exec()
    : Promise.resolve([]);
  const reportsPromise: Promise<ReportsFacet[]> = wants('reports')
    ? Report.aggregate<ReportsFacet>(buildReportsPipeline(args)).allowDiskUse(true).exec()
    : Promise.resolve([]);
  const queriesPromise: Promise<QueriesFacet[]> = wants('queries')
    ? QueryModel.aggregate<QueriesFacet>(buildQueriesPipeline(args, queryScope))
        .allowDiskUse(true)
        .exec()
    : Promise.resolve([]);

  const [documentsResult, extractionResult, reportsResult, queriesResult, docHealth, queryHealth] =
    await Promise.all([
      documentsPromise,
      extractionPromise,
      reportsPromise,
      queriesPromise,
      // §4a's queue-depth export is computed unconditionally: a wedged pipeline
      // must be visible whatever sections the caller happened to ask for.
      DocumentModel.aggregate<DocumentHealthRow>(buildDocumentHealthPipeline(scope)).exec(),
      QueryModel.aggregate<QueryHealthRow>(buildQueryHealthPipeline(queryScope, stuckBefore)).exec(),
    ]);

  // A $facet always returns exactly one document; a skipped pipeline returns none.
  const documentsFacet = documentsResult[0] ?? EMPTY_DOCUMENTS_FACET;
  const extractionFacet = extractionResult[0] ?? EMPTY_EXTRACTION_FACET;
  const reportsFacet = reportsResult[0] ?? EMPTY_REPORTS_FACET;
  const queriesFacet = queriesResult[0] ?? EMPTY_QUERIES_FACET;

  // 5. Fold. Bucket key -> row, so zero-fill is a lookup miss rather than a
  //    positional join against a series the database never promised to pad.
  const documentsByBucket = new Map<string, DocumentBucketRow>(
    documentsFacet.series.map((r) => [r._id, r]),
  );
  const extractionByBucket = new Map<string, ExtractionBucketRow>(
    extractionFacet.series.map((r) => [r._id, r]),
  );
  const reportsByBucket = new Map<string, ReportBucketRow>(
    reportsFacet.series.map((r) => [r._id, r]),
  );
  const queriesByBucket = new Map<string, QueryBucketRow>(
    queriesFacet.series.map((r) => [r._id, r]),
  );

  const typesByBucket = new Map<string, DocumentTypeCount[]>();
  const typeTotals = new Map<string, number>();
  for (const row of documentsFacet.byType) {
    const list = typesByBucket.get(row._id.bucket) ?? [];
    list.push({ type: row._id.type, count: row.count });
    typesByBucket.set(row._id.bucket, list);
    typeTotals.set(row._id.type, (typeTotals.get(row._id.type) ?? 0) + row.count);
  }

  const series: AnalyticsBucket[] = buckets.map((key) => {
    const range = bucketRangeUtc(key, query.granularity);
    return {
      bucket: key,
      label: bucketLabel(key),
      bucketStart: range.gte.toISOString(),
      bucketEnd: range.lt.toISOString(),
      ...buildSlice({
        documents: wants('documents')
          ? presentDocuments(documentsByBucket.get(key), typesByBucket.get(key) ?? [])
          : null,
        extraction: wants('extraction') ? presentExtraction(extractionByBucket.get(key)) : null,
        reports: wants('reports') ? presentReports(reportsByBucket.get(key)) : null,
        queries: wants('queries') ? presentQueries(queriesByBucket.get(key)) : null,
      },
      // Per bucket the two cross-clock ratios are not computable — see buildSlice.
      { crossSection: false }),
    };
  });

  // Totals come from each pipeline's own `_id: null` group, NOT from folding
  // the series: see rule 1 in the file header.
  const totals: AnalyticsSlice = buildSlice({
    documents: wants('documents')
      ? presentDocuments(
          documentsFacet.totals[0],
          [...typeTotals.entries()]
            .map(([type, count]) => ({ type, count }))
            // Deterministic order for a map that was built by iteration.
            .sort((a, b) => (a.type < b.type ? -1 : 1)),
        )
      : null,
    extraction: wants('extraction') ? presentExtraction(extractionFacet.totals[0]) : null,
    reports: wants('reports') ? presentReports(reportsFacet.totals[0]) : null,
    queries: wants('queries') ? presentQueries(queriesFacet.totals[0]) : null,
  }, { crossSection: true });

  const bySubsidiary = includeBySubsidiary
    ? await buildSubsidiaryBreakdown({
        documents: documentsFacet.bySubsidiary ?? [],
        extraction: extractionFacet.bySubsidiary ?? [],
        reports: reportsFacet.bySubsidiary ?? [],
        queries: queriesFacet.bySubsidiary ?? [],
      })
    : null;

  const payload: AnalyticsPayload = {
    scope: {
      subsidiaryIds: (scope.subsidiaryIds ?? []).map((id) => String(id)),
      unscoped: scope.subsidiaryIds === null,
    },
    range: {
      from: fromIso,
      to: toIso,
      fromUtc: gte.toISOString(),
      toUtc: lt.toISOString(),
      granularity: query.granularity,
      buckets,
      timezone: IST_LABEL,
      fiscalYearStartMonth: FISCAL_YEAR_START_MONTH,
    },
    series,
    totals,
    bySubsidiary,
    /**
     * Cached alongside the figures, so the queue depth is exactly as fresh as
     * `computedAt` says it is and no fresher. An operator watching for a wedge
     * reads the two together — which is the point of shipping `computedAt` at
     * all, and is bounded by ANALYTICS_CACHE_TTL_SECONDS.
     */
    pipeline: presentPipelineHealth(docHealth, queryHealth, now),
    assumptions: assumptions(),
  };

  const computedAt = await setCached(AnalyticsCache, {
    cacheKey,
    // [] is the unscoped admin view — the convention aggregateCache.ts uses for
    // targeted invalidation, which deletes it alongside any named subsidiary.
    subsidiaryIds: scope.subsidiaryIds ?? [],
    payload,
    ttlSeconds: env.ANALYTICS_CACHE_TTL_SECONDS,
  });

  return { ...payload, computedAt: computedAt.toISOString(), cached: false };
}
