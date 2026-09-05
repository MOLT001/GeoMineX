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
