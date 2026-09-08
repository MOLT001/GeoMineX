import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { toIstCalendarDate } from '@/lib/datetime';

/**
 * Topic analysis — PRD §10.5, §4.6.
 *
 * The whole module is ONE endpoint, `GET /topics`, mounted at
 * `backend/src/routes/index.ts:57`. It is not paginated, carries no
 * `pagination` key, and has no mutations — so there is a single query hook here
 * and nothing of its own to invalidate.
 *
 * Payload size is bounded by `limit` rather than by paging, and the trend
 * section is roughly `limit x range.buckets.length` points (200 x ~36 at the
 * 1100-day range cap), which is a large single JSON body. Keep `limit` modest
 * when the trend chart is on screen.
 *
 * The backend keeps its OWN read-through cache of this payload and drops it for
 * a subsidiary whenever that subsidiary's corpus changes — a document reaching
 * `validated`, an extracted-field override, a report publish or archive, a
 * query worker hitting a terminal status (`backend/src/utils/aggregateCache.ts:74-90`).
 * That invalidation is server-side only; a feature module performing one of
 * those mutations should also invalidate the `['topics']` key prefix here if it
 * wants the chart to move without waiting out `staleTime`.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

/** `backend/src/utils/istPeriod.ts:21` — only these two. No 'day', 'week' or 'year'. */
export type Granularity = 'month' | 'quarter';

/**
 * `topics.schema.ts:23`. 'all' expands to `['document','query']` server-side.
 *
 * Worth pinning to one or the other: under 'all', `clusters[].sourceIds` mixes
 * document ids and query ids with NO discriminator anywhere in the response, so
 * a "jump to this source" affordance cannot know whether to route to
 * /documents/:id or /queries/:id.
 *
 * Note also that only a query's QUESTION text is indexed, never the generated
 * answer (`termIndexer.ts:88-96`), so `source='query'` is what people ASKED —
 * do not label that view as topics found in answers.
 */
export type TopicsSourceFilter = 'document' | 'query' | 'all';

/** `topics.schema.ts:26`. 'none' makes `comparison` null. */
export type TopicsCompareMode = 'previous' | 'none';

/**
 * `topics.schema.ts:27` — a STRING enum, not a boolean, tested with
 * `=== 'true'` at `topics.service.ts:391`. `?cluster=1`, `?cluster=TRUE` and an
 * empty `?cluster` are 400s, not falsy values.
 */
export type TopicsClusterFlag = 'true' | 'false';

export type TrendDirection = 'up' | 'down' | 'flat';

// ─── Request ─────────────────────────────────────────────────────────────────

/**
 * The wire query for `GET /topics`, verbatim.
 *
 * A `type` and not an `interface` because only a type alias picks up the
 * implicit index signature that `api.get`'s `query` bag requires.
 *
 * EVERY key is optional and NONE tolerates an empty value: Zod's `.default()`
 * fires on `undefined` only, so `?from=`, `?subsidiaryId=` and `?limit=` are
 * 400 VALIDATION_ERROR rather than a fallback to the default. That is the most
 * likely way a generated query string breaks this endpoint, which is why
 * `toTopicsQuery` below omits blank keys instead of forwarding them.
 */
export type GetTopicsQuery = {
  /** IST calendar date, `/^\d{4}-\d{2}-\d{2}$/`. Default: April 1 of the current Indian fiscal year. */
  from?: string;
  /** IST calendar date, same regex. INCLUSIVE of that whole IST day. Default: the request instant. */
  to?: string;
  /** Default 'quarter'. */
  granularity?: Granularity;
  /**
   * 24-hex ObjectId. Out of scope => 404 NOT_FOUND, never 403.
   *
   * There is NO existence check behind that, though: a well-formed id that
   * names nothing — or that an admin holds by virtue of holding everything —
   * returns 200 with an empty `wordCloud`/`trend`, which is indistinguishable
   * from a real subsidiary with no corpus. Do not render the empty state as
   * "no such subsidiary".
   */
  subsidiaryId?: string;
  /** Default 'all'. */
  source?: TopicsSourceFilter;
  /** Integer 5..200, default 50. Applies to `wordCloud` AND `trend`; `5.5` is a 400. */
  limit?: number;
  /** Integer 1..50, default 2. A term in fewer distinct sources is dropped from every section. */
  minSources?: number;
  /** Default 'previous'. */
  compare?: TopicsCompareMode;
  /** Default 'true'. */
  cluster?: TopicsClusterFlag;
};

/**
 * What `useTopics` accepts.
 *
 * Identical to the wire query except that `from`/`to` also take a `Date`, which
 * is converted with `toIstCalendarDate`. That exists so no caller ever reaches
 * for `toISOString().slice(0, 10)`: for any instant after 18:30 UTC that string
 * names the PREVIOUS IST calendar day, and these params are read as IST
 * calendar dates, not as instants.
 *
 * Defaults are applied PER EDGE, not per pair (`topics.service.ts:308-310`):
 * sending only `from` means "from then until now"; sending only `to` means
 * "from April 1 of the current fiscal year until then". So a future `from` with
 * no `to` is a 400 INVALID_REQUEST ('Range ends before it starts'), not an
 * empty result.
 */
export interface TopicsParams {
  from?: string | Date;
  to?: string | Date;
  granularity?: Granularity;
  subsidiaryId?: string;
  source?: TopicsSourceFilter;
  limit?: number;
  minSources?: number;
  compare?: TopicsCompareMode;
  cluster?: TopicsClusterFlag;
}

// ─── Response ────────────────────────────────────────────────────────────────

export interface TopicsScope {
  /**
   * The RESOLVED scope, not the caller's grant list: a non-admin holding three
   * grants who sends `subsidiaryId=X` gets back `['X']` (`scopeKey.ts:39-42`).
   *
   * `[]` is ambiguous on its own — it means both "unscoped admin" and
   * "non-admin holding zero grants" (`topics.service.ts:223` maps a null scope
   * to `[]`). Read `unscoped` to tell them apart. A non-admin with zero grants
   * gets 200 and an empty payload, not an error.
   */
  subsidiaryIds: string[];
  /** True only for an admin who sent no `subsidiaryId` (`topics.service.ts:224`). */
  unscoped: boolean;
}

export interface TopicsRange {
  /**
   * Echoes the client's `from` VERBATIM (`topics.service.ts:322`), or the
   * derived default. The schema regex checks SHAPE ONLY, so `2026-02-30` and
   * `2026-13-01` pass validation and then roll over silently through `Date.UTC`
   * (`istPeriod.ts:78-79`), leaving this field contradicting `fromUtc` with no
   * error raised. Render `fromUtc`/`toUtc`/`buckets`, not `from`/`to`.
   */
  from: string;
  /** Echoes the client's `to`, or the IST date of the request instant. INCLUSIVE. */
  to: string;
  /** ISO-8601 UTC instant, INCLUSIVE lower bound — this one is the derived value. */
  fromUtc: string;
  /** ISO-8601 UTC instant, EXCLUSIVE upper bound. */
  toUtc: string;
  granularity: Granularity;
  /**
   * Contiguous, ascending, gap-free bucket keys covering `[fromUtc, toUtc)`;
   * always at least one. 'month' gives `'2026-04'`, 'quarter' gives
   * `'FY2026-Q1'` (Indian FY, starting April). Neither form survives
   * `new Date()`, and both sort lexicographically = chronologically, so use
   * this array's order directly.
   *
   * These are WHOLE buckets even when the range starts or ends mid-bucket —
   * `from=2026-01-01&to=2026-06-30` returns `['FY2025-Q4','FY2026-Q1']` — so
   * the FIRST and LAST points of every series are PARTIAL periods. On the
   * default fiscal-year-to-date range that makes `comparison` weigh a partial
   * current quarter against a complete previous one and report a spurious
   * `down` for nearly every term. Either mark the last bucket as partial in the
   * UI, or pin `to` to the end of the last complete bucket.
   */
  buckets: string[];
  /**
   * Always the literal display string `'Asia/Kolkata (+05:30)'`
   * (`istPeriod.ts:18`) — NOT an IANA zone id. Passing it to
   * `Intl.DateTimeFormat({ timeZone })` throws a RangeError.
   */
  timezone: string;
  /** Always 4 (`istPeriod.ts:19`). */
  fiscalYearStartMonth: number;
}

export interface WordCloudEntry {
  /**
   * A single lowercase token matching `/[a-z][a-z0-9-]{2,23}/`
   * (`textTerms.ts:14`): 3..24 chars, first character a letter, digits and
   * hyphens allowed, NEVER a space. Stopword-filtered at write time, and there
   * is no bigram or phrase indexing — so a raw term is not a readable heading.
   */
  term: string;
  /** Sum of per-source occurrence counts across the range. Always >= 1. */
  frequency: number;
  /**
   * Distinct sources containing the term — the TRUE count. It is computed on
   * the pre-slice array, so unlike `TermCluster.sourceCount` it is NOT capped
   * at 25 (`topics.pipelines.ts:65` vs `:81`).
   */
  sourceCount: number;
  /**
   * `frequency / wordCloud[0].frequency`, rounded to 3 dp
   * (`topics.service.ts:182`), so the first entry is always exactly 1. Scale
   * font size against this; do not recompute it from `frequency`.
   */
  weight: number;
}

export interface TermCluster {
  /**
   * The seed (highest-frequency) member with only its FIRST character
   * upper-cased (`textTerms.ts:107-108`). Because terms are single tokens this
   * is always ONE word — `'colliery'` becomes `'Colliery'`. It is not
   * multi-word title case.
   */
  label: string;
  /** 1..12 members, seed first (`clustering.ts:89` caps growth at 12). */
  terms: string[];
  /** Sum of the member terms' frequencies. */
  frequency: number;
  /**
   * Size of the union of the members' ALREADY-SAMPLED source sets, so it
   * UNDER-reports and will NOT match `WordCloudEntry.sourceCount` for a term
   * appearing in more than 25 sources (`clustering.ts:102`,
   * `topics.pipelines.ts:81`). The word cloud's count is the true one; this one
   * is not.
   */
  sourceCount: number;
  /**
   * A bounded sample: sorted, then sliced to AT MOST 25 ids
   * (`clustering.ts:103`) — the 25 lexicographically smallest — drawn from
   * per-term samples that are themselves capped at 25. `sourceIds.length` is
   * `<= sourceCount`, often far less.
   *
   * These are the ONLY ids in the entire response. Under `source='all'` they
   * mix document ids and query ids with no type discriminator, so pin
   * `source` before linking out of them.
   */
  sourceIds: string[];
}

export interface TrendPoint {
  /** One of `range.buckets`, same format and same index position. */
  bucket: string;
  /** The rendered form: `'2026-04'` -> `'April 2026'`, `'FY2025-Q1'` -> `'FY2025-26 Q1'`. */
  label: string;
  /** Zero-filled: an absent bucket is 0, never omitted and never null. */
  frequency: number;
  /** Distinct sources for this term IN THIS BUCKET. Zero-filled. */
  sourceCount: number;
}

export interface TrendEntry {
  term: string;
  /** Sum of `series[].frequency` across the whole range. */
  total: number;
  /**
   * ALWAYS exactly `range.buckets.length` long, in that same ascending order,
   * zero-filled (`topics.service.ts:208-217`) — no missing points and no nulls,
   * including for a zero bucket in the MIDDLE of the series. A chart may index
   * this against `range.buckets` positionally.
   */
  series: TrendPoint[];
}

export interface ComparisonTerm {
  term: string;
  /** Frequency in `comparison.currentPeriod`. */
  current: number;
  /** Frequency in `comparison.previousPeriod`. */
  previous: number;
  /** `current - previous`; may be negative. */
  change: number;
  /**
   * null — never Infinity, never 100 — whenever `previous` is 0
   * (`topics.service.ts:277`). The key is always PRESENT with the value null,
   * so render "new" rather than a percentage. Rounded to 1 dp otherwise.
   */
  changePercent: number | null;
  direction: TrendDirection;
}

export interface TopicsComparison {
  /** The LAST bucket of `range.buckets` — on the default range, a PARTIAL period. */
  currentPeriod: string;
  /** The bucket before it (`istPeriod.ts:118-121`); equals `range.buckets[length - 2]`. */
  previousPeriod: string;
  /** Same term order and same length as `trend` (total desc, then term asc). */
  terms: ComparisonTerm[];
  /** Terms with `previous === 0 && current > 0`, sorted ascending as plain strings. */
  emerging: string[];
  /** Terms with `previous > 0 && current === 0`, sorted ascending as plain strings. */
  fading: string[];
}

/** The `data` of `GET /topics`. */
export interface TopicsResponse {
  scope: TopicsScope;
  range: TopicsRange;
  /** Frequency desc, then term asc. Length `<= limit`. `[]` when nothing matches. */
  wordCloud: WordCloudEntry[];
  /**
   * `[]` — never null, never absent — when `cluster='false'`, and `[]` when the
   * cloud is empty.
   *
   * Clusters do NOT cover the word cloud. Only the top 60 terms are ever
   * considered (`clustering.ts:72-74`), and once 25 clusters exist a term that
   * matches nothing — or that matches a cluster already holding its 12 members
   * — is SILENTLY DROPPED: `clustering.ts:89-95` has no else branch. Never
   * derive the term list from here; use `wordCloud`.
   */
  clusters: TermCluster[];
  /**
   * The same term set in the same order as `wordCloud` — same rows, same
   * distinct-source floor, same sort, same limit — and `comparison.terms`
   * mirrors this order in turn. Safe to zip the three by index, though joining
   * on `term` is the safer habit.
   */
  trend: TrendEntry[];
  /**
   * null for TWO different reasons: the caller sent `compare='none'`, or the
   * range enumerated fewer than 2 buckets (`topics.service.ts:230` and `:252`).
   * The second is deliberate — comparing against a bucket outside the
   * aggregation window would report a fabricated 100% drop — and is common at
   * the default `granularity='quarter'`. Do not render null as "no change".
   */
  comparison: TopicsComparison | null;
  /** ISO-8601 UTC instant the payload was computed. Unchanged across cache hits. */
  computedAt: string;
  /**
   * True => served from the server's cache, in which case `computedAt` AND
   * `range` both come from that earlier run: on a default (no `to`) request
   * `range.toUtc` can be up to the cache TTL old. Render freshness from
   * `computedAt` + `cached`, never from `range.toUtc`.
   */
  cached: boolean;
}

// ─── Params to query string ──────────────────────────────────────────────────

/**
 * Guard for the shape the schema regex accepts but the calendar does not.
 *
 * `from=2026-02-30` and `from=2026-13-01` pass Zod (`topics.schema.ts:15`
 * checks shape only) and then roll over silently through `Date.UTC`, returning
 * 200 for a range nobody asked for while `range.from` echoes the bad string
 * back. Nothing server-side complains, so a date field that can emit a
 * free-typed value has to check here first.
 */
export function isRealIstCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function calendarDate(value: string | Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return toIstCalendarDate(value);
  // A blank is dropped rather than forwarded: see `GetTopicsQuery` — an empty
  // value is a 400, not a fallback to the server default.
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Build the wire query, omitting every key the caller did not set.
 *
 * Exported because this object is also the query key, so a screen that wants to
 * prefetch or invalidate one exact variant can build the identical one.
 */
export function toTopicsQuery(params: TopicsParams = {}): GetTopicsQuery {
  const query: GetTopicsQuery = {};

  const from = calendarDate(params.from);
  if (from !== undefined) query.from = from;
  const to = calendarDate(params.to);
  if (to !== undefined) query.to = to;

  if (params.granularity) query.granularity = params.granularity;
  if (params.subsidiaryId) query.subsidiaryId = params.subsidiaryId;
  if (params.source) query.source = params.source;
  if (typeof params.limit === 'number') query.limit = params.limit;
  if (typeof params.minSources === 'number') query.minSources = params.minSources;
  if (params.compare) query.compare = params.compare;
  if (params.cluster) query.cluster = params.cluster;

  return query;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * `GET /topics` — word cloud, clusters, trend series and period comparison in
 * one payload.
 *
 * Two 400s, and a date picker must handle them separately because only ONE of
 * them can be attached to a field:
 *
 *   VALIDATION_ERROR  message `Validation failed`, WITH `error.fields` keyed by
 *                     the failing query param name (`from`, `limit`, …, or the
 *                     literal `query` for an object-level issue,
 *                     `middleware/validate.ts:51`). A malformed date or id.
 *   INVALID_REQUEST   NO `fields` at all: `Range ends before it starts`
 *                     (`topics.service.ts:313`) or `Range exceeds the maximum of
 *                     1100 days` (env.TOPICS_MAX_RANGE_DAYS,
 *                     `topics.service.ts:315-320`). A form that only reads
 *                     `error.fields` renders nothing for either — surface these
 *                     on the range control itself, from `error.message`.
 *
 * Both still cost quota: the limiter runs BEFORE validation
 * (`topics.routes.ts:24`), so a malformed range spends budget, and answers 429
 * rather than 400 once the caller is over it.
 *
 * `staleTime` is deliberately long. The response is read-through cached
 * server-side for 900s, so a refetch inside that window returns the identical
 * payload with `cached: true` and an unchanged `computedAt`: it buys nothing
 * and spends `analyticsLimiter` budget, which is 30 requests/minute per USER id
 * — not per IP — shared across every analytics screen the user has open. Five
 * minutes rather than the full TTL because the server drops its entry early
 * whenever the subsidiary's corpus changes, and a chart should not lag that by
 * much.
 *
 * No `refetchInterval`: nothing here is a job that completes, so polling would
 * only burn the same budget.
 */
export function useTopics(params: TopicsParams = {}, options: { enabled?: boolean } = {}) {
  const query = toTopicsQuery(params);

  return useQuery({
    queryKey: ['topics', query],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<TopicsResponse>('/topics', { query, signal });
      return data;
    },
    staleTime: 5 * 60_000,
    /**
     * Changing the range, granularity or subsidiary holds the current cloud and
     * chart on screen while the next payload loads — the same reasoning as
     * `useAnalytics` and `useOffsetList`: a chart that unmounts collapses the
     * page height and reads as a failure rather than a filter change. Dim on
     * `isPlaceholderData`.
     */
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}
