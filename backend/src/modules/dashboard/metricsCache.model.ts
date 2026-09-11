import mongoose, { Schema, Types, type HydratedDocument, type Model } from 'mongoose';

/**
 * Pre-computed dashboard metrics — PRD §4.6.
 *
 * §4.6 requires metrics to be cached rather than recomputed on every dashboard
 * load: "Time Saved %" compares against a historical baseline and sits on the
 * landing page for every role, so recomputing it per request is the query that
 * would take the dashboard down first.
 *
 * The cache key is subsidiary-scoped, which is a security property, not an
 * optimisation: an aggregate computed over subsidiaries a user cannot access
 * must never be readable by that user.
 *
 * A shape change to a cached collection needs no migration — the TTL index
 * expires every row within `METRICS_CACHE_TTL_SECONDS` — but a `findOne` may
 * still return a row written by the previous version, so the read path
 * defaults a newly added field to 0.
 */
export interface MetricsCacheAttrs {
  /**
   * Scope identity. The FIELD is unchanged in shape; its VALUE is now a
   * `cacheKeyOf(...)` digest that folds in `PAYLOAD_VERSION` and
   * `metricAssumptionsFingerprint()` (§10.10). That is transparent to the
   * schema and simply causes one recompute after deploy — which is the point:
   * a figure computed under retuned assumptions can no longer be served under
   * the new ones, and the key is bounded rather than an unbounded comma-joined
   * grant list sitting on a unique index.
   */
  scopeKey: string;
  /**
   * The RESOLVED scope this row was computed over; `[]` is the unscoped admin
   * view. Redundant against `scopeKey` for reading — the key is a digest — but
   * it is the only thing that makes the row INVALIDATABLE.
   *
   * Without it the dashboard could only ever go stale and wait: a document
   * finishing dropped the topic and analytics caches and left this one
   * untouched, so the landing page went on reporting zero documents for the
   * full `METRICS_CACHE_TTL_SECONDS` after an upload had already been
   * processed. A digest cannot be searched by subsidiary; this can.
   */
  subsidiaryIds: Types.ObjectId[];
  extractionAccuracyPercent: number;
  automationCoveragePercent: number;
  timeSavedPercent: number;
  documentsTotal: number;
  documentsValidated: number;
  documentsFailed: number;
  documentsAwaitingReview: number;
  /**
   * §5.3 "Pending Queries needing response/review", cached alongside the
   * document counts so the landing card is one read rather than two.
   */
  queriesPendingReview: number;
  /** §4.6 — surfaced to the client so a stale figure is never shown as live. */
  computedAt: Date;
  expiresAt: Date;
}

export type MetricsCacheDoc = HydratedDocument<MetricsCacheAttrs>;

const metricsCacheSchema = new Schema<MetricsCacheAttrs>(
  {
    scopeKey: { type: String, required: true },
    // Defaulted for the same reason `queriesPendingReview` is: a row written by
    // the previous deploy must stay readable rather than failing validation.
    subsidiaryIds: { type: [Schema.Types.ObjectId], required: true, default: [] },
    extractionAccuracyPercent: { type: Number, required: true },
    automationCoveragePercent: { type: Number, required: true },
    timeSavedPercent: { type: Number, required: true },
    documentsTotal: { type: Number, required: true },
    documentsValidated: { type: Number, required: true },
    documentsFailed: { type: Number, required: true },
    documentsAwaitingReview: { type: Number, required: true },
    // Defaulted, never bare-`required`: a row written by the previous version
    // must stay readable rather than failing validation or reading back
    // undefined into a rendered figure (D17).
    queriesPendingReview: { type: Number, required: true, default: 0 },
    computedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { strict: true, strictQuery: true, versionKey: false },
);

metricsCacheSchema.index({ scopeKey: 1 }, { unique: true });
// Invalidation looks rows up by the scope they cover, never by the digest.
metricsCacheSchema.index({ subsidiaryIds: 1 });
// Stale entries self-expire rather than accumulating (§8.2).
metricsCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MetricsCache: Model<MetricsCacheAttrs> = mongoose.model<MetricsCacheAttrs>(
  'MetricsCache',
  metricsCacheSchema,
);
