/**
 * Word cloud, clusters and trend — PRD §4.3, §5.6, §4.6.
 *
 * Reads PRE-AGGREGATED rows only. No chunk text is touched at request time:
 * every term was tokenised and bucketed once, at write time, by
 * termIndexer.ts, so §4.6's "computed by aggregation, not by loading documents
 * into application memory" holds for the whole endpoint.
 *
 * Three things are load-bearing and easy to lose in a refactor:
 *
 *  1. `resolveScope` runs FIRST, so a client-supplied `subsidiaryId` is checked
 *     against the caller's grants (404, never 403) before it reaches a filter.
 *  2. The cache key carries the RESOLVED scope, so an aggregate computed over
 *     subsidiaries the caller cannot access is not addressable by them.
 *  3. Counts zero-fill, ratios stay null (D13). A plotted 0% for a period with
 *     no evidence is a fabricated figure, which is the traceability defect
 *     §4.6 exists to prevent.
 */
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import type { AuthContext } from '../../utils/authorization.js';
import { getCached, setCached } from '../../utils/aggregateCache.js';
import {
  PAYLOAD_VERSION,
  cacheKeyOf,
  metricAssumptionsFingerprint,
  resolveScope,
  type ResolvedScope,
} from '../../utils/scopeKey.js';
import {
  FISCAL_YEAR_START_MONTH,
  IST_LABEL,
  bucketLabel,
  currentFiscalYearRangeUtc,
  enumerateBuckets,
  istDateBoundaryToUtc,
  istParts,
  previousBucketKey,
  type Granularity,
} from '../../utils/istPeriod.js';
import { round1 } from '../analytics/metricFormulas.js';
import { clusterTerms, type TermCluster, type TermRow } from './clustering.js';
import { TopicCache } from './topicCache.model.js';
import { TERM_SOURCE_TYPES, WordFrequency } from './wordFrequency.model.js';
import {
  buildTrendPipeline,
  buildWordCloudPipeline,
  type BucketField,
  type TopicPipelineArgs,
} from './topics.pipelines.js';
import type { GetTopicsQuery } from './topics.schema.js';

// ── API shapes ─────────────────────────────────────────────────────────────

export interface TopicsScope {
  subsidiaryIds: string[];
  /** True for an admin reading across every subsidiary. */
  unscoped: boolean;
}

export interface TopicsRange {
  /** IST calendar dates, inclusive of `to` — the same form the client sent. */
  from: string;
  to: string;
  /** The half-open UTC window those calendar dates actually became. */
  fromUtc: string;
  toUtc: string;
  granularity: Granularity;
  buckets: string[];
  timezone: string;
  fiscalYearStartMonth: number;
}

export interface WordCloudEntry {
  term: string;
  frequency: number;
  sourceCount: number;
  /** Frequency normalised 0..1 against the top term, so the client sizes the cloud directly. */
  weight: number;
}

export interface TrendPoint {
  bucket: string;
  label: string;
  frequency: number;
  sourceCount: number;
}

export interface TrendEntry {
  term: string;
  total: number;
  series: TrendPoint[];
}

export interface ComparisonTerm {
  term: string;
  current: number;
  previous: number;
  change: number;
  /** null — never Infinity, never 100 — when the previous bucket was zero. */
  changePercent: number | null;
  direction: 'up' | 'down' | 'flat';
}

export interface TopicsComparison {
  currentPeriod: string;
  previousPeriod: string;
  terms: ComparisonTerm[];
  emerging: string[];
  fading: string[];
}

/** Everything that is cached. `computedAt`/`cached` are added per response. */
export interface TopicsPayload {
  scope: TopicsScope;
  range: TopicsRange;
  wordCloud: WordCloudEntry[];
  clusters: TermCluster[];
  trend: TrendEntry[];
  comparison: TopicsComparison | null;
}

export interface TopicsResponse extends TopicsPayload {
  computedAt: Date;
  /** True when served from cache rather than recomputed on this request (§4.6). */
  cached: boolean;
}

// ── Aggregation row shapes ─────────────────────────────────────────────────

interface WordCloudRow {
  term: string;
  frequency: number;
  sourceCount: number;
  sources: Types.ObjectId[];
}

interface TrendRow {
  term: string;
  total: number;
  series: { bucket: string; frequency: number; sourceCount: number }[];
}

const MILLIS_PER_DAY = 86_400_000;

/** Three decimals is enough to size a word cloud and keeps the cached payload compact. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 'YYYY-MM-DD' for an instant, read in IST — the same calendar the client sent. */
function istDateString(utc: Date): string {
  const { year, month, day } = istParts(utc);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Presentation ───────────────────────────────────────────────────────────

/**
 * Assembles the API shape from the two aggregation results.
 *
 * ObjectIds become strings here and nowhere else, and every source sample is
 * sorted before it leaves: `$addToSet` gives no ordering guarantee, so an
 * unsorted sample would make the clusters — and therefore the cached payload —
 * differ between two runs over identical data.
 */
function presentTopics(input: {
  scope: ResolvedScope;
  range: TopicsRange;
  cloudRows: WordCloudRow[];
  trendRows: TrendRow[];
  granularity: Granularity;
  cluster: boolean;
  compare: boolean;
}): TopicsPayload {
  const { buckets } = input.range;

  const topFrequency = input.cloudRows[0]?.frequency ?? 0;
  const wordCloud: WordCloudEntry[] = input.cloudRows.map((r) => ({
    term: r.term,
    frequency: r.frequency,
    sourceCount: r.sourceCount,
    weight: topFrequency === 0 ? 0 : round3(r.frequency / topFrequency),
  }));

  const termRows: TermRow[] = input.cloudRows.map((r) => ({
    term: r.term,
    frequency: r.frequency,
    sources: r.sources.map((id) => String(id)).sort(),
  }));

  const clusters = input.cluster
    ? clusterTerms(
        termRows,
        env.TOPICS_CLUSTER_SIMILARITY,
        env.TOPICS_CLUSTER_MAX_TERMS,
        env.TOPICS_MAX_CLUSTERS,
      )
    : [];

  // Zero-fill against the enumerated buckets so a line chart has no invisible
  // gaps. `buckets` is already ascending, so the series is chronological by
  // construction — no sort, and therefore no ordering that could drift.
  const trend: TrendEntry[] = input.trendRows.map((r) => {
    const byBucket = new Map(r.series.map((p) => [p.bucket, p]));
    return {
      term: r.term,
      total: r.total,
      series: buckets.map((bucket) => {
        const point = byBucket.get(bucket);
        return {
          bucket,
          label: bucketLabel(bucket),
          // D13: counts fill with 0. "No documents this month" is a true statement.
          frequency: point?.frequency ?? 0,
          sourceCount: point?.sourceCount ?? 0,
        };
      }),
    };
  });

  return {
    scope: {
      subsidiaryIds: (input.scope.subsidiaryIds ?? []).map((id) => String(id)),
      unscoped: input.scope.subsidiaryIds === null,
    },
    range: input.range,
    wordCloud,
    clusters,
    trend,
    comparison: input.compare ? buildComparison(trend, buckets, input.granularity) : null,
  };
}

/**
 * §4.3's quarter-over-quarter comparison, derived from the already-zero-filled
 * series rather than from a second query.
 *
 * REFUSES TO COMPARE AGAINST A BUCKET IT DID NOT QUERY. With fewer than two
 * buckets in the requested range the previous period lies outside the
 * aggregation window, where a zero means "not fetched" rather than "not
 * present" — reporting that as a 100% drop would be exactly the fabricated
 * figure D13 forbids. `null` says "no comparison available" honestly.
 *
 * Term order mirrors `trend` (total desc, term asc), so a client can read the
 * two lists side by side without re-sorting either.
 */
function buildComparison(
  trend: TrendEntry[],
  buckets: string[],
  granularity: Granularity,
): TopicsComparison | null {
  if (buckets.length < 2) return null;

  const currentPeriod = buckets[buckets.length - 1]!;
  // Contiguous enumeration means this IS buckets[length - 2]; deriving it from
  // the calendar instead keeps the fiscal-year boundary logic in one place.
  const previousPeriod = previousBucketKey(currentPeriod, granularity);

  const terms: ComparisonTerm[] = [];
  const emerging: string[] = [];
  const fading: string[] = [];

  for (const entry of trend) {
    const byBucket = new Map(entry.series.map((p) => [p.bucket, p.frequency]));
    const current = byBucket.get(currentPeriod) ?? 0;
    const previous = byBucket.get(previousPeriod) ?? 0;
    const change = current - previous;

    terms.push({
      term: entry.term,
      current,
      previous,
      change,
      // A term appearing for the first time has no percentage change. Mirrors
      // dashboard.service.ts's refusal to report 100% accuracy from zero
      // extractions.
      changePercent: previous === 0 ? null : round1((change / previous) * 100),
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    });

    if (previous === 0 && current > 0) emerging.push(entry.term);
    if (previous > 0 && current === 0) fading.push(entry.term);
  }

  // Plain string ordering, not localeCompare: an ordering a test asserts must
  // not depend on the host's collation data.
  emerging.sort();
  fading.sort();

  return { currentPeriod, previousPeriod, terms, emerging, fading };
}

// ── Read path ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/topics — PRD §4.3, §5.6, §7.6.
 *
 * Not paginated: the result is bounded by `limit`, the cluster caps and the
 * enumerated bucket count, so a cursor would add ceremony to a fixed-size
 * object.
 */
export async function getTopics(query: GetTopicsQuery, user: AuthContext): Promise<TopicsResponse> {
  const scope = resolveScope(user, query.subsidiaryId);

  // Defaulting per edge rather than per pair: `?from=2026-04-01` alone means
  // "from then until the end of the default window", which is what a client
  // sending one bound actually asked for.
  const fallback = currentFiscalYearRangeUtc();
  const gte = query.from ? istDateBoundaryToUtc(query.from, 'start') : fallback.gte;
  const lt = query.to ? istDateBoundaryToUtc(query.to, 'endExclusive') : fallback.lt;

  // Schema-valid, logically invalid — §9.8's own worked example.
  if (gte >= lt) throw ApiError.invalidRequest('Range ends before it starts');

  const spanDays = (lt.getTime() - gte.getTime()) / MILLIS_PER_DAY;
  if (spanDays > env.TOPICS_MAX_RANGE_DAYS) {
    throw ApiError.invalidRequest(
      `Range exceeds the maximum of ${env.TOPICS_MAX_RANGE_DAYS} days`,
    );
  }

  const fromIso = query.from ?? istDateString(gte);
  // `lt` is exclusive, so the last INCLUDED IST day is one millisecond earlier.
  const toIso = query.to ?? istDateString(new Date(lt.getTime() - 1));

  // The cache key is built from these IST CALENDAR dates, not from `lt`. The
  // default window ends at "now", which moves every millisecond; keying on the
  // instant would make every request a miss and turn the heaviest read in the
  // system into an uncacheable one. Day granularity plus the TTL is what
  // actually bounds staleness, and `computedAt` travels with the answer so a
  // figure is never presented as fresher than it is (§4.6).

  const range: TopicsRange = {
    from: fromIso,
    to: toIso,
    fromUtc: gte.toISOString(),
    toUtc: lt.toISOString(),
    granularity: query.granularity,
    buckets: enumerateBuckets(query.granularity, gte, lt),
    timezone: IST_LABEL,
    fiscalYearStartMonth: FISCAL_YEAR_START_MONTH,
  };

  // Every input that can change a figure is in the key, including the metric
  // assumptions fingerprint (D12): a number computed under old assumptions must
  // never be served after an operator retunes them.
  const cacheKey = cacheKeyOf([
    'topics',
    PAYLOAD_VERSION,
    metricAssumptionsFingerprint(),
    scope.key,
    query.granularity,
    fromIso,
    toIso,
    query.source,
    query.limit,
    query.minSources,
    query.compare,
    query.cluster,
  ]);

  const hit = await getCached<TopicsPayload>(TopicCache, cacheKey);
  if (hit) return { ...hit.payload, computedAt: hit.computedAt, cached: true };

  const args: TopicPipelineArgs = {
    subsidiaryIds: scope.subsidiaryIds,
    sourceTypes: query.source === 'all' ? [...TERM_SOURCE_TYPES] : [query.source],
    range: { gte, lt },
    minSources: query.minSources,
    limit: query.limit,
  };
  const bucketField: BucketField = query.granularity === 'month' ? 'periodMonth' : 'periodQuarter';

  // Two passes over the same indexed rows, issued together: neither depends on
  // the other, and a cold-cache request is the heaviest read in the system.
  // allowDiskUse keeps a large corpus from failing on the 100MB group limit
  // rather than silently returning a truncated cloud.
  const [cloudRows, trendRows] = await Promise.all([
    WordFrequency.aggregate<WordCloudRow>(buildWordCloudPipeline(args), { allowDiskUse: true }),
    WordFrequency.aggregate<TrendRow>(buildTrendPipeline(args, bucketField), {
      allowDiskUse: true,
    }),
  ]);

  const payload = presentTopics({
    scope,
    range,
    cloudRows,
    trendRows,
    granularity: query.granularity,
    cluster: query.cluster === 'true',
    compare: query.compare === 'previous',
  });

  const computedAt = await setCached(TopicCache, {
    cacheKey,
    subsidiaryIds: scope.subsidiaryIds ?? [],
    payload,
    ttlSeconds: env.TOPICS_CACHE_TTL_SECONDS,
  });

  return { ...payload, computedAt, cached: false };
}
