/**
 * Request validation for `GET /api/v1/analytics` — PRD §4.6, §9.2, §9.8.
 *
 * Zod's job here stops at SHAPE. Whether the requested window is coherent
 * (`to` before `from`) or affordable (more buckets than `ANALYTICS_MAX_BUCKETS`)
 * is decided in the service and raised as `INVALID_REQUEST`, because the bucket
 * ceiling depends on the granularity as well as the two dates — a pair Zod
 * would have to re-derive the fiscal calendar to judge. §9.8 names exactly this
 * split, with "a report date range ending before it starts" as its example.
 */
import { z } from 'zod';
import { GRANULARITIES } from '../../utils/istPeriod.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

/**
 * An IST CALENDAR date, not an instant.
 *
 * The client never sends a timestamp, so the client can never disagree with the
 * server about where an Indian fiscal quarter begins. `istDateBoundaryToUtc`
 * turns it into the half-open UTC window every pipeline actually matches on.
 */
const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an IST calendar date, YYYY-MM-DD');

export const getAnalyticsQuerySchema = z.object({
  /** §4.6's named use case is quarter over quarter, so `quarter` is the default. */
  granularity: z.enum(GRANULARITIES).default('quarter'),
  from: istDate.optional(),
  to: istDate.optional(),
  subsidiaryId: objectId.optional(),
  /**
   * A SINGLE ENUM, deliberately not a transformed comma list.
   *
   * `z.string().optional().transform(csv).pipe(z.array(...))` feeds
   * `string | undefined` into a non-optional array schema, and in Zod 4 the
   * pipe target validates BEFORE the outer `.default()` applies — so omitting
   * the parameter would fail validation instead of defaulting, which is the
   * opposite of what a default is for. If multi-select is ever required, reach
   * for `z.preprocess` on the raw value, never `.transform().pipe().default()`.
   */
  include: z.enum(['documents', 'extraction', 'reports', 'queries', 'all']).default('all'),
  /**
   * String enum rather than `z.coerce.boolean()`: coercion treats the literal
   * string 'false' as `true`, so `?includeBySubsidiary=false` would silently do
   * the opposite of what it says.
   */
  includeBySubsidiary: z.enum(['true', 'false']).default('true'),
});

export type GetAnalyticsQuery = z.infer<typeof getAnalyticsQuerySchema>;
export type AnalyticsInclude = GetAnalyticsQuery['include'];
