import mongoose, { Schema, type Model } from 'mongoose';
import type { CacheRowAttrs } from '../../utils/aggregateCache.js';

/**
 * Cached topics payload — PRD §4.6, §8.
 *
 * Collection name is set EXPLICITLY to `topics` so the deployed name matches
 * §8's table. It holds the DERIVED artefact — word cloud, clusters and trend
 * for one (scope, range, granularity) — rather than raw terms, which live in
 * `wordFrequencies`.
 *
 * The subsidiary-scoped cache key is a SECURITY property, not an optimisation,
 * for the same reason metricsCache.model.ts states: an aggregate computed over
 * subsidiaries a user cannot access must never be readable by that user.
 */
const topicCacheSchema = new Schema<CacheRowAttrs>(
  {
    cacheKey: { type: String, required: true },
    /** RESOLVED scope, for targeted invalidation. [] = the unscoped admin view. */
    subsidiaryIds: [{ type: Schema.Types.ObjectId, ref: 'Subsidiary' }],
    /** Derived aggregate counts and terms only — no document text, no field values. */
    payload: { type: Schema.Types.Mixed, required: true },
    computedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'topics', strict: true, strictQuery: true, versionKey: false },
);

topicCacheSchema.index({ cacheKey: 1 }, { unique: true });
/** §8.2 TTL rule — stale entries self-expire rather than accumulating. */
topicCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
/** Targeted invalidation without parsing key strings. */
topicCacheSchema.index({ subsidiaryIds: 1 });

export const TopicCache: Model<CacheRowAttrs> = mongoose.model<CacheRowAttrs>('TopicCache', topicCacheSchema);
