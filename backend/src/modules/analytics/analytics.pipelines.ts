/**
 * Analytics aggregations — PRD §4.6, §1.5, §8.2.
 *
 * Every figure §4.6 asks for is computed by an aggregation pipeline. Nothing
 * here loads a document, a field value or a question into application memory:
 * what comes back is counts, sums and averages keyed by an IST bucket string.
 *
 * FOUR PROPERTIES THAT ARE LOAD-BEARING, NOT STYLE:
 *
 *   1. MongoDB feature floor 4.0 (D14). `$dateToString` with a fixed
 *      `timezone: '+05:30'` (3.6), `$toInt`/`$toString` (4.0), `$addToSet` with
 *      `$$REMOVE` (3.6). No `$dateTrunc` (5.0), no `$regexFindAll` (4.2), no
 *      `$sortArray` (5.2), no `$lookup` with `localField` + `pipeline` (5.0).
 *      server.ts warns at boot if the deployed server is older, so a too-old
 *      mongod is visible then rather than at query time.
 *
 *   2. Every pipeline is BOUNDED by a half-open date range the service has
 *      already capped at `ANALYTICS_MAX_BUCKETS`. An unbounded `$group` over
 *      the whole corpus inside an HTTP request is a denial-of-service, not a
 *      slow query.
 *
 *   3. The scope clause lives INSIDE the first `$match` of every pipeline, so
 *      an out-of-scope row is never read, let alone summed (§9.1). A caller
 *      with no grants produces `{ $in: [] }`, which matches nothing — never an
 *      unfiltered aggregation.
 *
 *   4. Bucket keys ('2026-04', 'FY2026-Q1') are lexicographically
 *      chronological by construction, so `$sort: { _id: 1 }` IS a time sort and
 *      needs no mapping table.
 *
 * The metric ARITHMETIC is not here and must not be added here: percentages are
 * derived in TypeScript after folding, from `./metricFormulas.js` (D11). This
 * file only produces the counters those formulas consume.
 */
import type { PipelineStage, Types } from 'mongoose';
import { istBucketExpr, type Granularity } from '../../utils/istPeriod.js';
import { scopeMatch, type ResolvedScope } from '../../utils/scopeKey.js';
import type { AuthContext } from '../../utils/authorization.js';
import { scopeContainmentClause } from '../queries/query.service.js';

/** Half-open UTC window. `lt` is exclusive, so no instant is counted twice. */
export interface UtcRange {
  gte: Date;
  lt: Date;
}

export interface AnalyticsPipelineArgs {
  scope: ResolvedScope;
  range: UtcRange;
  granularity: Granularity;
  /**
   * The per-subsidiary facets are opt-in: they add a second `$group` pass to
   * every pipeline, and a caller charting one line does not need them.
   */
  includeBySubsidiary: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `queries` scope clause — containment, imported, never re-derived.
 *
 * `documents`, `extractedFields` and `reports` each carry a top-level
 * `subsidiaryId`, so `scopeMatch()` is the right filter for them. A query does
 * not: it is authorized on `contextScope.subsidiaryIds`, and a query answered
 * over {A, B} may carry B's figures in its prose, so a user granted only A must
 * not see it counted (D3). That rule has exactly one implementation —
 * `query.service.ts#scopeContainmentClause` — and this file calls it rather
 * than restating the `$and: [{$in}, {$not:{$elemMatch:{$nin}}}]` shape, because
 * a second copy is a second thing to get wrong.
 *
 * A requested `subsidiaryId` then NARROWS that floor with a containment clause
 * of its own. Without the narrowing, `?subsidiaryId=A` would return A-only
 * document counts beside query counts covering every subsidiary the caller
 * holds — a plausible wrong number, which is the failure §4.6 is most concerned
 * with. `resolveScope()` has already rejected an id the caller does not hold
 * (404, never 403), so the narrowing can only ever shrink the set.
 *
 * Written as ONE `$and` array, with the imported clause nested inside it as a
 * whole rather than unpacked. Two clauses on the same key in one object literal
 * silently drop the first, and the containment half is the half that protects;
 * nesting cannot drop anything.
 */
export function buildQueryScopeClause(
  user: AuthContext,
  scope: ResolvedScope,
): Record<string, unknown> {
  const authorization = scopeContainmentClause(user);

  // Unscoped admin who asked for no particular subsidiary: nothing to narrow,
  // and `authorization` is `{}` by design.
  if (!scope.subsidiaryIds) return authorization;

  const ids = scope.subsidiaryIds;
  const clauses: Record<string, unknown>[] = [];
  // `{}` for an admin. Omitted rather than pushed empty, because an empty
  // predicate inside `$and` is noise in an explain plan.
  if (Object.keys(authorization).length > 0) clauses.push(authorization);
  // Index-usable narrowing, and the clause that kills the empty-set case:
  // `$in: []` matches nothing, where containment alone is vacuously true.
  clauses.push({ 'contextScope.subsidiaryIds': { $in: ids } });
  // Containment: the query's scope must hold NOTHING outside this set.
  clauses.push({ 'contextScope.subsidiaryIds': { $not: { $elemMatch: { $nin: ids } } } });

  return { $and: clauses };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Documents — bucketed on the document's own createdAt
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentBucketRow {
  _id: string;
  total: number;
  validated: number;
  failed: number;
  inProgress: number;
  requiresReview: number;
  awaitingReview: number;
  injectionFlagged: number;
  avgOcrConfidence: number | null;
}

export type DocumentTotalsRow = Omit<DocumentBucketRow, '_id'>;

export interface DocumentTypeRow {
  _id: { bucket: string; type: string };
  count: number;
}

export interface DocumentSubsidiaryRow {
  _id: Types.ObjectId;
  total: number;
  validated: number;
}

export interface DocumentsFacet {
  series: DocumentBucketRow[];
  byType: DocumentTypeRow[];
  totals: DocumentTotalsRow[];
  bySubsidiary?: DocumentSubsidiaryRow[];
}

/**
 * One accumulator set, used by both the per-bucket `$group` and the totals
 * `$group`.
 *
 * Shared deliberately: a totals block computed from a slightly different
 * expression than the series it sits beside is the drift D11 exists to
 * prevent, and it stays invisible until someone adds the column up by hand.
 */
function documentAccumulators(): Record<string, unknown> {
  return {
    total: { $sum: 1 },
    validated: { $sum: { $cond: [{ $eq: ['$status', 'validated'] }, 1, 0] } },
    failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
    inProgress: { $sum: { $cond: [{ $in: ['$status', ['queued', 'processing']] }, 1, 0] } },
    requiresReview: { $sum: { $cond: ['$requiresReview', 1, 0] } },
    /**
     * The other half of the §4.6 Automation Coverage denominator, and NOT the
     * same number as `requiresReview`: dashboard.service.ts counts a document
     * as awaiting review only once it has actually been validated. Using the
     * identical `$and` idiom is what stops the §5.3 card and the §4.6 chart
     * reporting different coverage for the same period.
     */
    awaitingReview: {
      $sum: { $cond: [{ $and: [{ $eq: ['$status', 'validated'] }, '$requiresReview'] }, 1, 0] },
    },
    /**
     * `$eq: [..., true]` rather than a bare truthiness test: Phase 1 rows were
     * written before `injectionSuspected` existed and carry no value at all.
     * They must count as `false`, not throw.
     */
    injectionFlagged: { $sum: { $cond: [{ $eq: ['$injectionSuspected', true] }, 1, 0] } },
    /** `$avg` yields null over zero non-null values — passed through, never coerced to 0. */
    avgOcrConfidence: { $avg: '$ocrConfidence' },
  };
}

export function buildDocumentsPipeline(a: AnalyticsPipelineArgs): PipelineStage[] {
  const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {
    series: [
      { $group: { _id: '$bucket', ...documentAccumulators() } },
      // Bucket keys sort lexicographically into chronological order.
      { $sort: { _id: 1 } },
    ],
    byType: [
      { $group: { _id: { bucket: '$bucket', type: '$type' }, count: { $sum: 1 } } },
      { $sort: { '_id.bucket': 1, '_id.type': 1 } },
    ],
    totals: [{ $group: { _id: null, ...documentAccumulators() } }, { $project: { _id: 0 } }],
  };

  if (a.includeBySubsidiary) {
    facet.bySubsidiary = [
      {
        $group: {
          _id: '$subsidiaryId',
          total: { $sum: 1 },
          validated: { $sum: { $cond: [{ $eq: ['$status', 'validated'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ];
  }

  return [
    { $match: scopeMatch(a.scope, { createdAt: { $gte: a.range.gte, $lt: a.range.lt } }) },
    { $addFields: { bucket: istBucketExpr('$createdAt', a.granularity) } },
    { $facet: facet },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Extraction accuracy — bucketed on the FIELD'S OWN createdAt
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractionBucketRow {
  _id: string;
  totalFields: number;
  overriddenFields: number;
  correctedDocuments: number;
  avgConfidence: number | null;
  lowConfidence: number;
}

export type ExtractionTotalsRow = Omit<ExtractionBucketRow, '_id'>;

export interface ExtractionSubsidiaryRow {
  _id: Types.ObjectId;
  totalFields: number;
  overriddenFields: number;
}

export interface ExtractionFacet {
  series: ExtractionBucketRow[];
  totals: ExtractionTotalsRow[];
  bySubsidiary?: ExtractionSubsidiaryRow[];
}

/**
 * `correctedDocs` is an `$addToSet` of documentIds, sized in the `$project`.
 *
 * This is the EXACT idiom dashboard.service.ts already uses for "corrected
 * document", so the snapshot and the series cannot disagree about what the
 * phrase means. `$$REMOVE` keeps non-overridden rows out of the set entirely
 * rather than admitting a null member that `$size` would then count.
 */
function extractionAccumulators(reviewThreshold: number): Record<string, unknown> {
  return {
    totalFields: { $sum: 1 },
    overriddenFields: { $sum: { $cond: ['$wasOverridden', 1, 0] } },
    correctedDocs: { $addToSet: { $cond: ['$wasOverridden', '$documentId', '$$REMOVE'] } },
    avgConfidence: { $avg: '$confidenceScore' },
    /** §4.1's review threshold, so "how much needed a human" is answerable per period. */
    lowConfidence: { $sum: { $cond: [{ $lte: ['$confidenceScore', reviewThreshold] }, 1, 0] } },
  };
}

/**
 * WHY THIS BUCKETS DIFFERENTLY FROM THE TOPIC ROWS — stated here and in the
 * term indexer so nobody "fixes" one to match the other:
 *
 *   An extraction is bucketed by WHEN THE EXTRACTION HAPPENED (the field's own
 *   `createdAt`), because the accuracy metric is a statement about the system's
 *   performance during that period.
 *
 *   A topic row is bucketed by WHEN THE MATERIAL IS FROM (the source document's
 *   `createdAt`), because a word cloud is a statement about the corpus, not
 *   about ingestion scheduling.
 *
 * Both are right for their own question. Backfilling a decade of scanned
 * reports in one afternoon puts every one of those extractions in this
 * afternoon's accuracy bucket — which is correct, because that is when the
 * system did the work being measured.
 *
 * `extractedFields` gained no denormalised date for this (D17): a new
 * `required: true` field on a live collection makes every un-backfilled Phase 1
 * row invisible to a `$match`, which is a silently wrong number rather than a
 * visibly missing one.
 */
export function buildExtractionPipeline(
  a: AnalyticsPipelineArgs,
  reviewThreshold: number,
): PipelineStage[] {
  const projection: Record<string, unknown> = {
    totalFields: 1,
    overriddenFields: 1,
    avgConfidence: 1,
    lowConfidence: 1,
    correctedDocuments: { $size: '$correctedDocs' },
  };

  const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {
    series: [
      { $group: { _id: '$bucket', ...extractionAccumulators(reviewThreshold) } },
      { $project: { _id: 1, ...projection } },
      { $sort: { _id: 1 } },
    ],
    totals: [
      { $group: { _id: null, ...extractionAccumulators(reviewThreshold) } },
      { $project: { _id: 0, ...projection } },
    ],
  };

  if (a.includeBySubsidiary) {
    facet.bySubsidiary = [
      {
        $group: {
          _id: '$subsidiaryId',
          totalFields: { $sum: 1 },
          overriddenFields: { $sum: { $cond: ['$wasOverridden', 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ];
  }

  return [
    { $match: scopeMatch(a.scope, { createdAt: { $gte: a.range.gte, $lt: a.range.lt } }) },
    {
      $addFields: {
        bucket: istBucketExpr('$createdAt', a.granularity),
        // An override is the operator saying the extraction was wrong. Derived
        // once here so the three accumulators below cannot disagree about it.
        wasOverridden: { $cond: [{ $ifNull: ['$overriddenBy', false] }, true, false] },
      },
    },
    { $facet: facet },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Reports — bucketed on publishedAt
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportBucketRow {
  _id: string;
  published: number;
  withUnreviewedFigures: number;
}

export type ReportTotalsRow = Omit<ReportBucketRow, '_id'>;

export interface ReportSubsidiaryRow {
  _id: Types.ObjectId;
  published: number;
}

export interface ReportsFacet {
  series: ReportBucketRow[];
  totals: ReportTotalsRow[];
  bySubsidiary?: ReportSubsidiaryRow[];
}

function reportAccumulators(): Record<string, unknown> {
  return {
    published: { $sum: 1 },
    /** §4.5 — a published report still carrying figures nobody signed off on. */
    withUnreviewedFigures: { $sum: { $cond: ['$hasUnreviewedFigures', 1, 0] } },
  };
}

/**
 * Bucketed on `publishedAt`, NOT `createdAt`: a report drafted in Q1 and
 * published in Q2 is a Q2 event, because publication is the thing being
 * counted. `status: { $in: ['published','archived'] }` keeps an archived report
 * in its original quarter — archiving it later does not un-publish it.
 */
export function buildReportsPipeline(a: AnalyticsPipelineArgs): PipelineStage[] {
  const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {
    series: [{ $group: { _id: '$bucket', ...reportAccumulators() } }, { $sort: { _id: 1 } }],
    totals: [{ $group: { _id: null, ...reportAccumulators() } }, { $project: { _id: 0 } }],
  };

  if (a.includeBySubsidiary) {
    facet.bySubsidiary = [
      { $group: { _id: '$subsidiaryId', published: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ];
  }

  return [
    {
      $match: scopeMatch(a.scope, {
        status: { $in: ['published', 'archived'] },
        publishedAt: { $gte: a.range.gte, $lt: a.range.lt },
      }),
    },
    { $addFields: { bucket: istBucketExpr('$publishedAt', a.granularity) } },
    { $facet: facet },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Queries — bucketed on createdAt, scoped by CONTAINMENT
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryBucketRow {
  _id: string;
  total: number;
  answered: number;
  unsupported: number;
  failed: number;
  deadLettered: number;
  parliamentary: number;
  pendingReview: number;
  withCitations: number;
  citationsAccepted: number;
  citationsDiscarded: number;
  injectionSuspected: number;
  passagesWithheld: number;
  avgGenerationMs: number | null;
}

export type QueryTotalsRow = Omit<QueryBucketRow, '_id'>;

export interface QuerySubsidiaryRow {
  _id: Types.ObjectId;
  queriesAsked: number;
}

export interface QueriesFacet {
  series: QueryBucketRow[];
  totals: QueryTotalsRow[];
  bySubsidiary?: QuerySubsidiaryRow[];
}

/**
 * `citationsAccepted` and `citationsDiscarded` are the two halves of the §9.5
 * fabricated-citation alarm and are counted separately on purpose: a fall in
 * the ratio between them is the system telling an operator that a provider has
 * begun claiming sources it was never given.
 *
 * `withCitations` is a different number again — it is the numerator of §1.5's
 * "≥95% of query responses with correct source citation" target. Both are
 * wanted and neither substitutes for the other; the two percentages derived
 * from them live in `metricFormulas.ts`.
 */
function queryAccumulators(): Record<string, unknown> {
  return {
    total: { $sum: 1 },
    answered: { $sum: { $cond: [{ $eq: ['$status', 'answered'] }, 1, 0] } },
    unsupported: { $sum: { $cond: [{ $eq: ['$status', 'unsupported'] }, 1, 0] } },
    failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
    deadLettered: { $sum: { $cond: [{ $eq: ['$status', 'dead_lettered'] }, 1, 0] } },
    parliamentary: { $sum: { $cond: ['$isParliamentary', 1, 0] } },
    pendingReview: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'pending'] }, 1, 0] } },
    withCitations: {
      $sum: {
        $cond: [{ $and: [{ $eq: ['$status', 'answered'] }, { $gt: ['$citationCount', 0] }] }, 1, 0],
      },
    },
    citationsAccepted: { $sum: '$citationCount' },
    citationsDiscarded: { $sum: { $ifNull: ['$discardedCitationCount', 0] } },
    injectionSuspected: { $sum: { $cond: [{ $eq: ['$injectionSuspected', true] }, 1, 0] } },
    passagesWithheld: { $sum: { $ifNull: ['$passagesWithheld', 0] } },
    avgGenerationMs: { $avg: '$generationMs' },
  };
}

/**
 * @param queryScope the clause from `buildQueryScopeClause`. Passed in rather
 * than rebuilt here so the containment rule keeps exactly one implementation.
 */
export function buildQueriesPipeline(
  a: AnalyticsPipelineArgs,
  queryScope: Record<string, unknown>,
): PipelineStage[] {
  const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {
    series: [{ $group: { _id: '$bucket', ...queryAccumulators() } }, { $sort: { _id: 1 } }],
    totals: [{ $group: { _id: null, ...queryAccumulators() } }, { $project: { _id: 0 } }],
  };

  if (a.includeBySubsidiary) {
    /**
     * A query asked over three subsidiaries counts once against EACH of them,
     * so this column deliberately does not sum to `totals.queries.total`. It
     * answers "how much was this subsidiary asked about", which is the question
     * a per-subsidiary breakdown is for; attributing the query to the
     * denormalised `subsidiaryId` instead would silently drop every
     * multi-subsidiary question from the breakdown, because that field is only
     * set when the context scope holds exactly one entry.
     *
     * The unwind cannot surface an id the caller does not hold: containment has
     * already guaranteed every member of the array is inside their scope.
     */
    facet.bySubsidiary = [
      { $unwind: '$contextScope.subsidiaryIds' },
      { $group: { _id: '$contextScope.subsidiaryIds', queriesAsked: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ];
  }

  return [
    {
      $match: {
        isDeleted: false,
        ...queryScope,
        createdAt: { $gte: a.range.gte, $lt: a.range.lt },
      },
    },
    {
      $addFields: {
        bucket: istBucketExpr('$createdAt', a.granularity),
        // `$ifNull` because a row written before the array default landed has
        // no `citations` field at all, and `$size` of a missing path errors.
        citationCount: { $size: { $ifNull: ['$citations', []] } },
      },
    },
    { $facet: facet },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Pipeline health — instructions §4a's required queue-depth export
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentHealthRow {
  _id: string;
  count: number;
  oldest: Date;
}

export interface QueryHealthRow {
  _id: string;
  count: number;
  oldest: Date;
  pastTimeout: number;
}

/**
 * WITHOUT THESE NUMBERS A WEDGED PIPELINE LOOKS EXACTLY LIKE AN IDLE ONE
 * (§4a, §9.7). "Zero documents processed this month" draws the same chart
 * whether nobody uploaded anything or the worker died at 03:00 — the queue
 * depth and the age of the oldest waiting item are what tell those apart.
 *
 * Deliberately NOT date-ranged: a job stuck since last quarter is precisely the
 * one an operator needs to see, and it would fall outside the requested window.
 * The `status` filter is what bounds this instead — terminal rows are the
 * overwhelming majority of the collection and none of them are matched.
 */
export function buildDocumentHealthPipeline(scope: ResolvedScope): PipelineStage[] {
  return [
    { $match: scopeMatch(scope, { status: { $in: ['queued', 'processing', 'failed'] } }) },
    { $group: { _id: '$status', count: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
    // Deterministic row order; the service reads by status key regardless.
    { $sort: { _id: 1 } },
  ];
}

/**
 * @param stuckBefore rows whose `processingStartedAt` predates this instant are
 * past `QUERY_STUCK_TIMEOUT_MINUTES` and are what `recoverStuckQueries` will
 * reclaim. Computed by the caller so the whole response shares one clock.
 *
 * `$type` rather than a null comparison: a `queued` row has no start time at
 * all, and missing-versus-date BSON ordering is not something a figure a
 * ministry reads should depend on. Counting those rows as stuck would report a
 * permanent backlog no worker could ever clear.
 */
export function buildQueryHealthPipeline(
  queryScope: Record<string, unknown>,
  stuckBefore: Date,
): PipelineStage[] {
  return [
    {
      $match: {
        isDeleted: false,
        ...queryScope,
        status: { $in: ['queued', 'retrieving', 'answering', 'failed', 'dead_lettered'] },
      },
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        oldest: { $min: '$createdAt' },
        pastTimeout: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $type: '$processingStartedAt' }, 'date'] },
                  { $lt: ['$processingStartedAt', stuckBefore] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];
}
