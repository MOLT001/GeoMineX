import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Email OTP codes — PRD §9.3, §11.1 (decision: OTP over magic link).
 *
 * The code is stored as a keyed hash and expires by TTL index, so a consumed
 * or lapsed code is never queryable afterwards (PRD §8.2).
 */
export interface OtpCodeAttrs {
  userId: Types.ObjectId;
  codeHash: string;
  attempts: number;
  consumedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
}

export type OtpCodeDoc = HydratedDocument<OtpCodeAttrs>;

const otpCodeSchema = new Schema<OtpCodeAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    consumedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true, strictQuery: true },
);

otpCodeSchema.index({ userId: 1, consumedAt: 1 });
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpCode: Model<OtpCodeAttrs> = mongoose.model<OtpCodeAttrs>('OtpCode', otpCodeSchema);
