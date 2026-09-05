import mongoose, { Schema, type Model } from 'mongoose';
import type { CacheRowAttrs } from '../../utils/aggregateCache.js';

/**
 * Cached analytics payload — PRD §4.6, §8.
 *
 * Holds the DERIVED artefact for one fully-specified request — the series, the
 * totals, the per-subsidiary breakdown and the pipeline-health block — rather
 * than any raw row. Nothing here is document text, an extracted value or a
 * question; every field is a count, an average or a percentage.
 *
 * WHY THE KEY MUST CONTAIN BOTH THE SCOPE AND EVERY QUERY PARAMETER:
 *
 *   - Scope, because an aggregate computed over subsidiaries a user cannot
 *     access must never be readable by that user. That is a SECURITY property,
 *     not an optimisation — the same one metricsCache.model.ts states.
 *   - Every parameter, because keyed on scope alone one user's Q1 request would
 *     be served another user's Q3 figures. That is a correctness defect wearing
 *     a cache's clothing: the response would carry the right `computedAt`, the
 *     right `assumptions` block and entirely the wrong quarter, and nothing in
 *     the payload would contradict it.
 *
 * Both halves are enforced by `cacheKeyOf(...)` at the call site in
 * analytics.service.ts, which also folds in `PAYLOAD_VERSION` and
 * `metricAssumptionsFingerprint()` so a shape change or a retuned assumption
 * cannot serve a stale figure under new rules (D12).
 *
 * Shape is deliberately identical to topicCache.model.ts so both collections
 * can share utils/aggregateCache.ts and its targeted invalidation.
 */
const analyticsCacheSchema = new Schema<CacheRowAttrs>(
  {
    cacheKey: { type: String, required: true },
    /** RESOLVED scope, for targeted invalidation. [] = the unscoped admin view. */
    subsidiaryIds: [{ type: Schema.Types.ObjectId, ref: 'Subsidiary' }],
    /** Derived aggregate figures only — no document text, no field values, no questions. */
    payload: { type: Schema.Types.Mixed, required: true },
    computedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'analyticsCaches', strict: true, strictQuery: true, versionKey: false },
);

/** §8.2 — the read path is a point lookup on the hashed key, and it must be unique. */
analyticsCacheSchema.index({ cacheKey: 1 }, { unique: true });
/** §8.2 TTL rule — stale entries self-expire rather than accumulating. */
analyticsCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
/** §8.2 — targeted invalidation on a corpus change, without parsing key strings. */
analyticsCacheSchema.index({ subsidiaryIds: 1 });

export const AnalyticsCache: Model<CacheRowAttrs> = mongoose.model<CacheRowAttrs>(
  'AnalyticsCache',
  analyticsCacheSchema,
);
