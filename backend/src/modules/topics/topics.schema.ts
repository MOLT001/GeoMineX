import { z } from 'zod';
import { GRANULARITIES } from '../../utils/istPeriod.js';

/**
 * Request validation for GET /api/v1/topics — PRD §5.6, §9.2.
 *
 * Every bound here is a COST bound as well as a correctness one: `limit` and
 * `minSources` decide how much of the term table the aggregation touches, and
 * an unbounded `limit` on the heaviest read in the system is a denial of
 * service with a valid token (§9.2).
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');
/** An IST CALENDAR date, not an instant. The service converts it. */
const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an IST calendar date, YYYY-MM-DD');

export const getTopicsQuerySchema = z.object({
  from: istDate.optional(),
  to: istDate.optional(),
  /** §4.3's named use case is quarter over quarter, so `quarter` is the default. */
  granularity: z.enum(GRANULARITIES).default('quarter'),
  subsidiaryId: objectId.optional(),
  source: z.enum(['document', 'query', 'all']).default('all'),
  limit: z.coerce.number().int().min(5).max(200).default(50),
  minSources: z.coerce.number().int().min(1).max(50).default(2),
  compare: z.enum(['previous', 'none']).default('previous'),
  cluster: z.enum(['true', 'false']).default('true'),
});

export type GetTopicsQuery = z.infer<typeof getTopicsQuerySchema>;

/**
 * Range COHERENCE (`from <= to`, span within TOPICS_MAX_RANGE_DAYS) is checked
 * in the service and raised as INVALID_REQUEST, not here.
 *
 * `from=2026-09-30&to=2026-04-01` is schema-VALID — two well-formed dates — and
 * logically invalid, which is precisely the distinction §9.8 draws when it
 * names "a report date range ending before it starts" as its own worked
 * example of INVALID_REQUEST rather than VALIDATION_ERROR.
 */

// ── Topic Intelligence ─────────────────────────────────────────────────────

/**
 * A topic id is either a taxonomy slug (`coal-reserves`) or a discovered one
 * (`discovered:stripping-ratio`). The colon is admitted deliberately — it is the
 * marker that separates curated vocabulary from a phrase the extractor found,
 * and dropping it would make discovered topics unaddressable.
 */
export const topicIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^(discovered:)?[a-z0-9-]+( [a-z0-9-]+)*$/, 'must be a topic id');

/**
 * `?topic=a&topic=b` arrives as a string when there is one and an array when
 * there are several. Normalising here means every consumer sees an array, and
 * the single-value case cannot quietly take a different code path.
 */
export const topicListSchema = z
  .union([topicIdSchema, z.array(topicIdSchema).max(8)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const topicCatalogQuerySchema = z.object({
  subsidiaryId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  /**
   * Discovered topics are included by default in the explorer and excluded from
   * the filter's option list: a filter offering `discovered:coal handling` beside
   * curated topics presents an unvetted phrase as vocabulary.
   */
  includeDiscovered: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const topicAnalyticsQuerySchema = z.object({
  subsidiaryId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});

export type TopicCatalogQuery = z.infer<typeof topicCatalogQuerySchema>;
export type TopicAnalyticsQuery = z.infer<typeof topicAnalyticsQuerySchema>;
