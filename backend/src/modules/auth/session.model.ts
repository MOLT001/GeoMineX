import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Refresh/session credentials — PRD §9.3.
 *
 * Stored as a keyed hash, never plaintext. Rotated on every use: each refresh
 * issues a new credential and marks the previous one `rotatedAt`. Presenting
 * an already-rotated credential is the primary signal of a stolen token and
 * revokes every session in the family.
 */
export interface SessionAttrs {
  userId: Types.ObjectId;
  tokenHash: string;
  /**
   * Rotation chain id. All descendants of one login share a family, so reuse
   * detection can revoke the whole chain rather than a single row.
   */
  familyId: string;
  /** Set when this credential has been exchanged for a successor. */
  rotatedAt?: Date;
  revokedAt?: Date;
  revokedReason?: 'logout' | 'reuse_detected' | 'admin_revoked' | 'user_revoked';
  // Non-sensitive metadata for the user-facing session list (PRD §9.3).
  ipAddress?: string;
  userAgent?: string;
  lastActiveAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionDoc = HydratedDocument<SessionAttrs>;

const sessionSchema = new Schema<SessionAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    familyId: { type: String, required: true, index: true },
    rotatedAt: { type: Date },
    revokedAt: { type: Date },
    revokedReason: { type: String, enum: ['logout', 'reuse_detected', 'admin_revoked', 'user_revoked'] },
    ipAddress: { type: String },
    userAgent: { type: String },
    lastActiveAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ tokenHash: 1 }, { unique: true });

/**
 * PRD §8.2 — TTL index. Expired sessions self-expire rather than accumulating
 * indefinitely, so a revoked or lapsed credential does not remain queryable
 * past its validity window.
 */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session: Model<SessionAttrs> = mongoose.model<SessionAttrs>('Session', sessionSchema);
