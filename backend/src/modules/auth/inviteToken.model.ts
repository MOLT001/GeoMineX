import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Admin-issued account invitations — PRD §9.3.
 *
 * Cryptographically random and non-sequential, bounded lifetime, single use.
 * Invalid, expired and already-consumed tokens all return the same generic
 * error, which is what prevents enumeration on the accept flow.
 */
export interface InviteTokenAttrs {
  userId: Types.ObjectId;
  tokenHash: string;
  invitedBy: Types.ObjectId;
  consumedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
}

export type InviteTokenDoc = HydratedDocument<InviteTokenAttrs>;

const inviteTokenSchema = new Schema<InviteTokenAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    consumedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true, strictQuery: true },
);

inviteTokenSchema.index({ tokenHash: 1 }, { unique: true });
inviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const InviteToken: Model<InviteTokenAttrs> = mongoose.model<InviteTokenAttrs>(
  'InviteToken',
  inviteTokenSchema,
);
