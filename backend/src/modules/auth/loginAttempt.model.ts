import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Per-account lockout state — PRD §9.3.
 *
 * Distinct from the per-IP rate limiter: rate limiting is defeated by a
 * distributed attacker, whereas lockout is what actually protects a targeted
 * account. TTL-indexed so counters do not accumulate (PRD §8.2).
 */
export interface LoginAttemptAttrs {
  userId: Types.ObjectId;
  failedCount: number;
  lockedUntil?: Date;
  lastFailureAt: Date;
  /** Housekeeping horizon for the TTL index. */
  expiresAt: Date;
}

export type LoginAttemptDoc = HydratedDocument<LoginAttemptAttrs>;

const loginAttemptSchema = new Schema<LoginAttemptAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    failedCount: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date },
    lastFailureAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { strict: true, strictQuery: true },
);

loginAttemptSchema.index({ userId: 1 }, { unique: true });
loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginAttempt: Model<LoginAttemptAttrs> = mongoose.model<LoginAttemptAttrs>(
  'LoginAttempt',
  loginAttemptSchema,
);
