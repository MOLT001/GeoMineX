/**
 * Cache-scope identity — PRD §4.6.
 *
 * The scope segment of a cache key is a SECURITY property, not an
 * optimisation: an aggregate computed over subsidiaries a user cannot access
 * must never be readable by that user. Because the key is derived from the
 * caller's grant LIST and never from their user id, a user whose grants change
 * automatically gets a different key rather than a stale over-broad answer.
 *
 * Extracted from dashboard.service.ts#scopeFor so the dashboard, topics and
 * analytics caches cannot drift apart.
 */
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { isUnscoped, assertSubsidiaryAccess, type AuthContext } from './authorization.js';

/** Bump when a cached payload SHAPE changes, so a deploy cannot serve the old shape. */
export const PAYLOAD_VERSION = 1;

export interface ResolvedScope {
  /** 'all' for an unscoped admin, otherwise `sub:<sorted grant ids>`. */
  key: string;
  /** null = unscoped admin. Concrete ids otherwise. */
  subsidiaryIds: Types.ObjectId[] | null;
}

/**
 * Sorting is load-bearing: it keeps the key identical regardless of the order
 * grants happen to be stored in.
 *
 * A requested subsidiary is validated against the caller's grants FIRST
 * (assertSubsidiaryAccess -> 404, never 403), so a client-supplied id never
 * reaches a filter unchecked (§8.3).
 */
export function resolveScope(user: AuthContext, requestedSubsidiaryId?: string): ResolvedScope {
  if (requestedSubsidiaryId) {
    assertSubsidiaryAccess(user, requestedSubsidiaryId);
    return {
      key: `sub:${requestedSubsidiaryId}`,
      subsidiaryIds: [new Types.ObjectId(requestedSubsidiaryId)],
    };
  }
  if (isUnscoped(user.role)) return { key: 'all', subsidiaryIds: null };
  const sorted = [...user.subsidiaryAccess].sort();
  return {
    key: `sub:${sorted.join(',') || 'none'}`,
    subsidiaryIds: sorted.map((id) => new Types.ObjectId(id)),
  };
}

/** `{ isDeleted: false }` plus the subsidiary clause, for a $match stage. */
export function scopeMatch(
  scope: ResolvedScope,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = { isDeleted: false, ...extra };
  if (scope.subsidiaryIds) base.subsidiaryId = { $in: scope.subsidiaryIds };
  return base;
}

/**
 * sha256 over parts joined by U+0000.
 *
 * The NUL separator prevents ['sub:a,b','X'] colliding with ['sub:a','bX'].
 * Hashing bounds the key, which matters because a user holding many grants
 * otherwise produces an unbounded string sitting on a unique index.
 */
export function cacheKeyOf(parts: (string | number | boolean)[]): string {
  return crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');
}

/**
 * Fingerprint of the env constants that feed DERIVED figures.
 *
 * Change an assumption and every cache key changes, so a Time Saved % computed
 * under old assumptions is never served after an operator retunes the
 * constants. The Phase 1 metrics cache has this gap; adopting cacheKeyOf in
 * dashboard.service.ts closes it there too.
 */
export function metricAssumptionsFingerprint(): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        env.BASELINE_MANUAL_MINUTES_PER_DOC,
        env.MINUTES_PER_MANUAL_OVERRIDE,
        env.OCR_REVIEW_THRESHOLD,
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 12);
}
