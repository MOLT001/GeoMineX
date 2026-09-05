/**
 * Read-through cache helpers shared by topics and analytics — PRD §4.6.
 *
 * Both cache collections have the same shape (cacheKey, subsidiaryIds,
 * payload, computedAt, expiresAt), so read/write/invalidate lives once here
 * rather than twice in two near-identical services.
 */
import type { Model, Types } from 'mongoose';
import { logger } from './logger.js';

export interface CacheRowAttrs {
  cacheKey: string;
  /** RESOLVED scope the entry was computed over. [] = the unscoped admin view. */
  subsidiaryIds: Types.ObjectId[];
  payload: unknown;
  computedAt: Date;
  expiresAt: Date;
}

/**
 * `expiresAt > now` is filtered IN THE READ, not left to the TTL monitor: the
 * monitor runs roughly once a minute, so the read-side filter is what actually
 * bounds staleness.
 */
export async function getCached<T>(
  model: Model<CacheRowAttrs>,
  cacheKey: string,
): Promise<{ payload: T; computedAt: Date } | null> {
  const row = await model.findOne({ cacheKey, expiresAt: { $gt: new Date() } }).lean();
  return row ? { payload: row.payload as T, computedAt: row.computedAt } : null;
}

/** A cache write must never fail the request — the contract dashboard.service.ts already uses. */
export async function setCached(
  model: Model<CacheRowAttrs>,
  args: { cacheKey: string; subsidiaryIds: Types.ObjectId[]; payload: unknown; ttlSeconds: number },
): Promise<Date> {
  const computedAt = new Date();
  await model
    .updateOne(
      { cacheKey: args.cacheKey },
      {
        $set: {
          cacheKey: args.cacheKey,
          subsidiaryIds: args.subsidiaryIds,
          payload: args.payload,
          computedAt,
          expiresAt: new Date(computedAt.getTime() + args.ttlSeconds * 1000),
        },
      },
      { upsert: true },
    )
    .catch((err: unknown) => {
      logger.warn('Failed to write aggregate cache', {
        model: model.modelName,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  return computedAt;
}

/**
 * Targeted invalidation.
 *
 * Deletes every entry that touches this subsidiary AND the unscoped admin
 * entry (`subsidiaryIds: []`), which was computed over everything and is
 * therefore stale too. Fire-and-forget: a cache miss is cheap, a failed
 * request is not.
 *
 * Called from the four places where the corpus genuinely changes: the document
 * worker on `validated`, overrideExtractedField, publishReport/archiveReport,
 * and the query worker on a terminal status.
 */
export async function invalidateForSubsidiary(
  models: Model<CacheRowAttrs>[],
  subsidiaryId: Types.ObjectId,
): Promise<void> {
  await Promise.all(
    models.map((m) =>
      m
        .deleteMany({ $or: [{ subsidiaryIds: subsidiaryId }, { subsidiaryIds: { $size: 0 } }] })
        .catch((err: unknown) => {
          logger.warn('Cache invalidation failed', {
            model: m.modelName,
            message: err instanceof Error ? err.message : String(err),
          });
        }),
    ),
  );
}
