import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { toIstCalendarDate } from '@/lib/datetime';

/**
 * Analytics — `GET /analytics`, the only route on the module
 * (`analytics.routes.ts` registers path `/` and nothing else).
 *
 * Server-state hooks live in the feature module; components never call the
 * client directly (§10.5).
 *
 * Four properties of this endpoint govern everything below:
 *
 *   1. ZERO-FILL IS ASYMMETRIC. An empty bucket returns `0` for every COUNT and
 *      `null` for every RATIO or AVERAGE — `analytics.service.ts:268-331`,
 *      `metricFormulas.ts:41-96`. Rendering `value ?? 0` re-introduces exactly
 *      the fabricated figure the backend refuses to emit. Every `| null` here
 *      is load-bearing, and none of them means "zero".
 *
 *   2. A `null` SECTION means "you did not ask for it", which is a different
 *      statement from a section full of zeroes. `include` and
 *      `includeBySubsidiary` decide it. Use `hasSection` and `includesSection`
 *      rather than truthiness.
 *
 *   3. The figures are SERVER-CACHED (TTL `ANALYTICS_CACHE_TTL_SECONDS`,
 *      default 900s). `computedAt` and `cached` must be read together and shown
 *      — §13 treats a stale number presented as live as a traceability defect.
 *
 *   4. HISTORY IS NOT FROZEN. Every figure pipeline also matches
 *      `isDeleted: false` — `scopeKey.ts:53-60` (`scopeMatch`, for documents,
 *      extraction and reports) and `analytics.pipelines.ts:500` (queries) — so
 *      soft-deleting a document or a query retroactively lowers a PAST bucket's
 *      counts. Two exports of the same historical quarter can legitimately
 *      disagree; a back-period that moved is not a bug, and a figure copied out
 *      of here is a snapshot, not a permanent record.
 */

// ─── Literal unions ──────────────────────────────────────────────────────────

/** `utils/istPeriod.ts:21` GRANULARITIES. Two values only — there is no day or year. */
export type Granularity = 'month' | 'quarter';

/**
 * A SINGLE enum, not a comma-separated list. `analytics.schema.ts:31-41` records
 * that a csv transform was considered and rejected, so `include=documents,reports`
 * is a 400 rather than a two-section request. Ask for one section, or for `all`.
 */
export type AnalyticsInclude = 'documents' | 'extraction' | 'reports' | 'queries' | 'all';

/**
 * A STRING enum, not `z.coerce.boolean()` — `analytics.schema.ts:42-47`, and the
 * service compares `=== 'true'` at `analytics.service.ts:578`. So `'false'`
 * genuinely turns the breakdown off, and a real boolean must not be sent.
 */
export type IncludeBySubsidiary = 'true' | 'false';

/** `documents/document.model.ts:4` — the model enum behind `DocumentTypeCount.type`. */
export type DocumentType = 'pdf' | 'scan' | 'spreadsheet' | 'image';

/** The four `include`-gated sections of a slice. `'all'` is not one of them. */
export type AnalyticsSectionKey = 'documents' | 'extraction' | 'reports' | 'queries';

// ─── Request ─────────────────────────────────────────────────────────────────

/**
 * Every param is optional and every default is the server's, not ours: sending
 * nothing returns the current Indian fiscal year to date, by quarter, with all
 * four sections and the subsidiary breakdown.
 */
export interface GetAnalyticsQuery {
  /** Default `'quarter'`. */
  granularity?: Granularity;
  /** IST CALENDAR date, `YYYY-MM-DD`. Default: 1 April IST of the current fiscal year. */
  from?: string;
  /** IST CALENDAR date, `YYYY-MM-DD`, INCLUSIVE of the whole day. Default: now. */
  to?: string;
  /**
   * 24-hex ObjectId. For a non-admin this must be a subsidiary they hold or the
   * route answers 404 NOT_FOUND (`utils/authorization.ts:46-54`) — never 403.
   * An admin holds everything, so an admin never sees that 404: a well-formed
   * but nonexistent id comes back as a fully zero-filled 200 instead.
   *
   * It does NOT narrow every block the same way — see {@link QueriesBlock}.
   */
  subsidiaryId?: string;
  /** Default `'all'`. */
  include?: AnalyticsInclude;
  /** Default `'true'`. */
  includeBySubsidiary?: IncludeBySubsidiary;
}

/**
 * `from`/`to` are IST calendar dates, NOT instants: the schema regex is
 * `/^\d{4}-\d{2}-\d{2}$/`, so a `Date.toISOString()` fails validation outright.
 * Convert through here — §4.6 requires IST for bucketing anyway, and the
 * viewer's local zone would put a figure in a different fiscal quarter than the
 * one the server aggregated it into.
 */
export function toIstRangeParams(from: Date, to: Date): { from: string; to: string } {
  return { from: toIstCalendarDate(from), to: toIstCalendarDate(to) };
}

// ─── Response: leaf blocks ───────────────────────────────────────────────────

export interface DocumentTypeCount {
  /**
   * In practice one of the four model values, but the service declares the
   * field as a bare `string`, so nothing on the wire enforces the union. Look a
   * label up with a fallback rather than assuming exhaustiveness at runtime.
   */
  type: DocumentType;
  count: number;
}

export interface DocumentsBlock {
  total: number;
  validated: number;
  failed: number;
  /** status `queued` or `processing`. */
  inProgress: number;
  /** the `requiresReview` flag at ANY status. */
  requiresReview: number;
  /**
   * status `validated` AND `requiresReview` — `analytics.pipelines.ts:168-170`.
   * NOT the same number as `requiresReview`, and it is this one, never that one,
   * that Automation Coverage is built from.
   */
  awaitingReview: number;
  injectionFlagged: number;
  /**
   * 0..1 scale, 2 decimal places — NOT a percentage (`analytics.service.ts:255`).
   * `ocrConfidence` is optional on the model (`document.model.ts:24,67`), so a
   * bucket full of documents can still return null here.
   */
  avgOcrConfidence: number | null;
  /**
   * No zero-fill: a type absent from the bucket simply does not appear, so a
   * PDF-only bucket returns a one-element array. Already sorted by `type`
   * ascending — per bucket by the pipeline (`analytics.pipelines.ts:191`), and on
   * `totals` in TypeScript (`analytics.service.ts:708-711`).
   */
  byType: DocumentTypeCount[];
}

/**
 * Extraction figures bucket on the FIELD's own `createdAt`
 * (`analytics.pipelines.ts:262-283`), not on the document's — so a backfill run
 * puts decade-old scans in today's accuracy bucket. Documents bucket on the
 * document's `createdAt` instead, which is the reason the two cross-section
 * metrics on {@link AnalyticsSlice} exist only over the whole window.
 */
export interface ExtractionBlock {
  totalFields: number;
  /** fields whose `overriddenBy` is set — that is what "overridden" means (`analytics.pipelines.ts:328`). */
  overriddenFields: number;
  /** distinct documentIds with at least one overridden field. */
  correctedDocuments: number;
  /**
   * 0..1 scale, 2dp. `confidenceScore` is `required: true` on the model
   * (`extractedField.model.ts:35`), so this is null ONLY when the bucket matched
   * no field rows at all — never because rows "carried no score".
   */
  avgConfidence: number | null;
  /** fields with `confidenceScore <= assumptions.ocrReviewThreshold` (`$lte`, `analytics.pipelines.ts:258`). */
  lowConfidence: number;
  /** 1dp percent. null when `totalFields === 0` — never 0. */
  accuracyPercent: number | null;
}

export interface ReportsBlock {
  /**
   * Reports whose status is `published` OR `archived`, bucketed on `publishedAt`
   * rather than `createdAt` (`analytics.pipelines.ts:385-391`). Drafts never
   * appear, and an archived report stays counted in the quarter it was published.
   */
  published: number;
  withUnreviewedFigures: number;
}

/**
 * Queries are scoped by CONTAINMENT, not intersection — alone among the four
 * blocks. A query counts only when its whole `contextScope.subsidiaryIds` array
 * sits INSIDE the caller's grants (`analytics.pipelines.ts:86-108`, delegating
 * to `query.service.ts:59-68`).
 *
 * What that does to a screen: `?subsidiaryId=A` narrows this block to queries
 * asked about A ALONE — one asked over {A, B} vanishes from every field here,
 * while A's documents, extraction and reports are all still counted. So the
 * queries block shrinks faster than the rest when a subsidiary filter goes on,
 * and that is the backend working as designed, not a dropped row. Do not label
 * these counts "queries about this subsidiary".
 */
export interface QueriesBlock {
  total: number;
  answered: number;
  unsupported: number;
  failed: number;
  deadLettered: number;
  parliamentary: number;
  /** `reviewStatus === 'pending'`. */
  pendingReview: number;
  /** A COUNT OF QUERIES: answered, with at least one citation (`analytics.pipelines.ts:451-455`). */
  withCitations: number;
  /**
   * A COUNT OF CITATIONS, summed over every matched query whatever its status
   * (`analytics.pipelines.ts:456-459`) — so it can and does exceed `total`.
   */
  citationsAccepted: number;
  /** Likewise a count of CITATIONS, not queries. */
  citationsDiscarded: number;
  /** 1dp. `withCitations / answered`. null when `answered === 0`. */
  citationCoveragePercent: number | null;
  /**
   * 1dp. `citationsAccepted / (citationsAccepted + citationsDiscarded)`.
   * A completely different ratio from coverage, built from the two sums; null
   * when both are 0. Labelling either as the other misstates the figure.
   */
  citationIntegrityPercent: number | null;
  injectionSuspected: number;
  /** SUM of `passagesWithheld` across queries — passages, not queries. */
  passagesWithheld: number;
  /** Whole milliseconds (`round0`). null when no query in the bucket recorded one. */
  avgGenerationMs: number | null;
}

// ─── Response: slices ────────────────────────────────────────────────────────

/**
 * The four sections plus the two cross-section metrics.
 *
 * A `null` block means the caller's `include` excluded it. `hasSection` narrows.
 */
export interface AnalyticsSlice {
  documents: DocumentsBlock | null;
  extraction: ExtractionBlock | null;
  reports: ReportsBlock | null;
  queries: QueriesBlock | null;
  /**
   * `(documents.validated − extraction.correctedDocuments − documents.awaitingReview)
   * / documents.validated × 100`, rounded to 1dp and THEN clamped at >= 0
   * (`metricFormulas.ts:55-62`). The denominator is `documents.validated` alone;
   * `awaitingReview` is a numerator subtrahend, and `correctedDocuments` comes
   * from the EXTRACTION block. A screen recomputing this must use that exact
   * form or it will disagree with the server. Because of the clamp, `0` can mean
   * "negative, clamped".
   *
   * null when ANY of:
   *   - this is a `series` entry — ALWAYS null there, see {@link AnalyticsBucket};
   *   - `include` excluded documents or extraction (`analytics.service.ts:377`
   *     needs BOTH, so `include=documents` nulls it despite full document data);
   *   - `documents.validated === 0` (`metricFormulas.ts:60`) — an empty window
   *     returns null, not 0.
   */
  automationCoveragePercent: number | null;
  /**
   * `(documents.total × baselineManualMinutesPerDoc
   * − extraction.overriddenFields × minutesPerManualOverride)
   * / (documents.total × baselineManualMinutesPerDoc) × 100`, clamped at >= 0
   * and THEN rounded to 1dp (`metricFormulas.ts:75-80`) — note the opposite
   * clamp/round order from Automation Coverage. Both constants come from
   * {@link AnalyticsAssumptions}; never hard-code them.
   *
   * Same three null rules as above, except the third is `documents.total === 0`.
   */
  timeSavedPercent: number | null;
}

/**
 * One period.
 *
 * `automationCoveragePercent` and `timeSavedPercent` are ALWAYS null on a series
 * entry — for every bucket, always, even on a fully populated period. The series
 * is built with `{ crossSection: false }` (`analytics.service.ts:698`) and only
 * `totals` with `{ crossSection: true }` (`:717`), because documents bucket on
 * upload date while extraction buckets on extraction date, so the per-period
 * ratio is not meaningful (`analytics.service.ts:340-365`). Charting either of
 * them per period draws an empty line; plot them from `totals` only.
 */
export interface AnalyticsBucket extends AnalyticsSlice {
  /**
   * `'2026-04'` for month, `'FY2026-Q1'` for quarter (fiscal, starting April).
   * Lexicographically chronological, so sorting the strings sorts the periods.
   */
  bucket: string;
  /**
   * `'April 2026'` / `'FY2026-27 Q1'` (`istPeriod.ts:64-75`). Already computed —
   * derive nothing of your own from `bucket`; the quarter label is FY, the start
   * year, a hyphen, then the TWO-DIGIT end year, and it is easy to get wrong.
   */
  label: string;
  /** ISO-8601 UTC, INCLUSIVE. */
  bucketStart: string;
  /** ISO-8601 UTC, EXCLUSIVE. */
  bucketEnd: string;
}

/**
 * One row per subsidiary in scope.
 *
 * Ordered by `code` ascending with `subsidiaryId` as tie-break, using plain `<`
 * rather than `localeCompare`, and a null `code` sorts first
 * (`analytics.service.ts:454-459`).
 *
 * A column is only meaningful when its section was `include`d: with
 * `include=documents` every row still carries `extractionAccuracyPercent: null`,
 * `reportsPublished: 0` and `queriesAsked: 0` (`analytics.service.ts:720-725`
 * passes `facet.bySubsidiary ?? []` per section), and those zeroes mean "not
 * computed", not "none". Gate each column on `includesSection`.
 */
export interface SubsidiaryBreakdownRow {
  subsidiaryId: string;
  /**
   * null ONLY when the Subsidiary row was hard-removed. Soft-deleted
   * subsidiaries are deliberately still listed, with their code
   * (`analytics.service.ts:415-420` — the lookup has no `isDeleted` filter).
   */
  code: string | null;
  documentsTotal: number;
  documentsValidated: number;
  /**
   * 1dp. null when this subsidiary produced no fields in the window — OR when
   * `include` left extraction out, which is the same null for a different
   * reason. Only `includesSection` separates them.
   */
  extractionAccuracyPercent: number | null;
  reportsPublished: number;
  /**
   * A query scoped over three subsidiaries is `$unwind`-ed and counted once
   * against EACH (`analytics.pipelines.ts:477-495`), so this column deliberately
   * does NOT sum to `totals.queries.total`. Never present the breakdown as a
   * decomposition of the query total.
   */
  queriesAsked: number;
}

/**
 * Queue health.
 *
 * Computed UNCONDITIONALLY whatever `include` says (`analytics.service.ts:646-649`)
 * and NOT date-ranged — a job stuck since last quarter deliberately still shows
 * (`analytics.pipelines.ts:540-543`). `documentsFailed`, `queriesFailed` and
 * `queriesDeadLettered` are therefore ALL-TIME counts within scope, not "failed
 * this window".
 *
 * It IS scope-filtered and a `subsidiaryId` narrows it, so this is "this scope's
 * queue", not the cluster's. And it is stored in the cache with the figures
 * (`analytics.service.ts:746-752`), so it is only as fresh as `computedAt` — do
 * not present it as live monitoring.
 */
export interface PipelineHealth {
  documentsQueued: number;
  documentsProcessing: number;
  documentsFailed: number;
  queriesQueued: number;
  /** status `retrieving` plus status `answering`. */
  queriesInFlight: number;
  queriesFailed: number;
  queriesDeadLettered: number;
  /** null when nothing is `queued` in EITHER queue. Clamped >= 0. */
  oldestQueuedAgeSeconds: number | null;
  /** in-flight queries older than QUERY_STUCK_TIMEOUT_MINUTES (default 10) by `processingStartedAt`. */
  inFlightPastTimeout: number;
}

/**
 * The constants the derived metrics were computed from. Show them beside the
 * metrics: §13's traceability rule covers a figure's inputs, and these are
 * environment-tunable, so a number computed last week is not necessarily
 * reproducible from today's settings.
 */
export interface AnalyticsAssumptions {
  /** env BASELINE_MANUAL_MINUTES_PER_DOC, default 45. */
  baselineManualMinutesPerDoc: number;
  /** env MINUTES_PER_MANUAL_OVERRIDE, default 3. */
  minutesPerManualOverride: number;
  /** env OCR_REVIEW_THRESHOLD on a 0..1 scale, default 0.75 — the cutoff behind `extraction.lowConfidence`. */
  ocrReviewThreshold: number;
  /**
   * Fixed literal string, `'fields never manually overridden / total fields'`
   * (`analytics.service.ts:532`). Display it; do not parse it.
   */
  extractionAccuracyDefinition: string;
}

export interface AnalyticsRange {
  /** IST calendar date. Echoes `from`, or the derived fiscal-year start. */
  from: string;
  /** IST calendar date, inclusive as a whole day. */
  to: string;
  /** ISO-8601 UTC, inclusive — the window actually matched on. */
  fromUtc: string;
  /**
   * ISO-8601 UTC, EXCLUSIVE. When `to` was omitted this is `now + 1ms`, not a
   * midnight boundary (`analytics.service.ts:556`), so the default view's window
   * end is a live timestamp. The cache key uses the CALENDAR dates instead, which
   * is why two calls a second apart still share a key and are served from cache.
   */
  toUtc: string;
  granularity: Granularity;
  /** Gap-free ascending bucket keys. `series` has exactly this length, in this order. */
  buckets: string[];
  /** Literal constant `'Asia/Kolkata (+05:30)'`. */
  timezone: string;
  /** Literal constant `4` — the Indian fiscal year starts in April. */
  fiscalYearStartMonth: number;
}

export interface AnalyticsScope {
  /**
   * `[]` in TWO different situations: an unscoped admin, and a non-admin holding
   * zero grants. `unscoped` is the only field that separates them — an empty
   * array alone means nothing. When `subsidiaryId` was sent this is `[thatId]`
   * with `unscoped: false`, even for an admin (`scopeKey.ts:37-43`).
   */
  subsidiaryIds: string[];
  unscoped: boolean;
}

// ─── Response: root ──────────────────────────────────────────────────────────

export interface AnalyticsResult {
  scope: AnalyticsScope;
  range: AnalyticsRange;
  /**
   * Exactly parallel to `range.buckets` — same length, same order, gap-free
   * (`analytics.service.ts:682-700`), including entries for periods with no data
   * at all. Join on index or on `bucket`.
   */
  series: AnalyticsBucket[];
  /**
   * The whole-window figures, computed by their own `_id: null` group — NOT by
   * folding `series`, so do not expect the two to reconcile by addition. The two
   * cross-section metrics exist only here.
   */
  totals: AnalyticsSlice;
  /**
   * `null` when `includeBySubsidiary=false` — "not requested". `[]` when it WAS
   * requested and nothing matched (`analytics.service.ts:719-726`). Two different
   * messages to a reader; do not collapse them with `?? []`.
   */
  bySubsidiary: SubsidiaryBreakdownRow[] | null;
  pipeline: PipelineHealth;
  assumptions: AnalyticsAssumptions;
  /**
   * ISO-8601 UTC. When `cached` is true this is the ORIGINAL compute time,
   * unchanged (`analytics.service.ts:598`) — the pair must be read together, and
   * §13 requires both to be visible.
   */
  computedAt: string;
  cached: boolean;
}

// ─── Section presence ────────────────────────────────────────────────────────

/**
 * Was this section computed?
 *
 * Narrows the block to non-null, so a chart can be written against
 * `slice.documents` without a second assertion:
 *
 *   if (hasSection(totals, 'documents')) totals.documents.validated // number
 *
 * `series` entries narrow too, keeping `bucket` and `label`.
 */
export function hasSection<S extends AnalyticsSlice, K extends AnalyticsSectionKey>(
  slice: S,
  section: K,
): slice is S & { [P in K]: NonNullable<S[P]> } {
  return slice[section] !== null;
}

/**
 * Will this `include` value produce that section? Answers the question BEFORE
 * the response arrives — for skeletons, for disabling a tab, and above all for
 * `bySubsidiary` columns, whose "not computed" state is an indistinguishable `0`
 * rather than a null.
 *
 * `undefined` means the param was omitted, which the server reads as `'all'`.
 */
export function includesSection(
  include: AnalyticsInclude | undefined,
  section: AnalyticsSectionKey,
): boolean {
  const requested = include ?? 'all';
  return requested === 'all' || requested === section;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseAnalyticsOptions extends GetAnalyticsQuery {
  /** Hold the request until the screen's filters are settled. */
  enabled?: boolean;
}

/** Params only, in wire form — `enabled` must never reach the query string. */
function analyticsQueryParams(params: GetAnalyticsQuery): Record<string, string | undefined> {
  return {
    granularity: params.granularity,
    from: params.from,
    to: params.to,
    subsidiaryId: params.subsidiaryId,
    include: params.include,
    includeBySubsidiary: params.includeBySubsidiary,
  };
}

/**
 * The analytics figures for one window.
 *
 * Anyone signed in may call it. There is NO `roleGuard` on this router
 * (`analytics.routes.ts:26-28,32` — the omission is deliberate: "there is no
 * role that may not read analytics"), so do not hide the screen behind an admin
 * check. Scope does the gating instead: an admin is unscoped, a `cil_user` or
 * `moc_official` is confined to their `subsidiaryAccess` grants, and a
 * non-admin holding none still gets a 200 — zero counts and
 * `scope.subsidiaryIds: []`. Read {@link AnalyticsScope} before writing "no
 * data": an empty array means two different things.
 *
 * Read-only: the module has no mutation, so nothing here invalidates. The other
 * direction is worth knowing — a mutation elsewhere (a document validating, a
 * report publishing) can invalidate the `['analytics']` prefix, but the refetch
 * can still return `cached: true` with the ORIGINAL `computedAt`, because the
 * server's own entry is keyed on scope + params and lives out
 * `ANALYTICS_CACHE_TTL_SECONDS` (default 900s). Render freshness from
 * `computedAt`, never from "we just refetched".
 *
 * Two 400s to handle separately, because they carry different bodies — the split
 * is documented at `analytics.schema.ts:1-10`:
 *
 *   VALIDATION_ERROR  message 'Validation failed', WITH `error.fields` keyed by
 *                     query param name (falling back to the literal 'query' on an
 *                     object-level failure, `validate.ts:51`). A malformed date or
 *                     id — attach it to the field.
 *   INVALID_REQUEST   NO `fields` at all: 'Range ends before it starts', or
 *                     'Range covers N <granularity> buckets; the maximum is M'
 *                     (`analytics.service.ts:559-572`; M is ANALYTICS_MAX_BUCKETS,
 *                     default 24). A form that only reads `error.fields` shows
 *                     nothing for these. The cap counts every bucket the window
 *                     TOUCHES, partial ones at each end included, and so depends
 *                     on granularity: 2021-04-01..2026-03-31 is 20 quarters (fine)
 *                     but 60 months (400).
 *
 * A 404 here does NOT mean "no analytics" — it means a non-admin asked for a
 * `subsidiaryId` they do not hold (`utils/authorization.ts:46-54`). `NOT_FOUND_MESSAGE`
 * still applies: do not name the subsidiary back at them.
 *
 * 429 RATE_LIMIT_EXCEEDED is a realistic outcome rather than a theoretical one,
 * because the 30/min budget is per USER and shared with `GET /topics`.
 * `createQueryClient` never retries a 4xx, so it surfaces at once and stays —
 * say "too many requests, try again shortly" instead of spinning.
 */
export function useAnalytics(options: UseAnalyticsOptions = {}) {
  const { enabled = true, ...params } = options;
  const query = analyticsQueryParams(params);

  return useQuery({
    queryKey: ['analytics', query],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<AnalyticsResult>('/analytics', { query, signal });
      return data;
    },
    /**
     * The server caches for 900s, and `analyticsLimiter` allows 30/min PER USER
     * shared with `GET /topics`, which is mounted on the same limiter instance
     * (`topics.routes.ts:24`) — a dashboard firing both on load spends one budget.
     * Refetching faster than the server TTL costs requests and returns the
     * identical payload, `cached: true` and all.
     */
    staleTime: 5 * 60_000,
    /**
     * Changing granularity or the range keeps the previous figures on screen
     * while the next set loads — the same reasoning as `useOffsetList` in
     * `@/lib/lists`: an unmounting chart collapses the page height and reads as a
     * failure rather than a filter change. Dim on `isPlaceholderData`.
     */
    placeholderData: keepPreviousData,
    enabled,
  });
}
