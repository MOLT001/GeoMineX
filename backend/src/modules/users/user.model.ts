import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/** PRD §2 — roles. */
export const ROLES = ['admin', 'cil_user', 'moc_official'] as const;
export type Role = (typeof ROLES)[number];

export interface UserAttrs {
  email: string;
  name: string;
  role: Role;
  /**
   * Explicit per-subsidiary grants (PRD §2). Admin is unscoped and ignores
   * this list. MoC officials receive explicit grants rather than blanket
   * access, per the §11.4 recommendation.
   */
  subsidiaryAccess: Types.ObjectId[];
  isActive: boolean;
  /** Set false until an invitation is accepted (PRD §9.3). */
  isInvitePending: boolean;
  lastLoginAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = HydratedDocument<UserAttrs>;

const userSchema = new Schema<UserAttrs>(
  {
    // Uniqueness is declared once, on the explicit index below.
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, enum: ROLES },
    subsidiaryAccess: [{ type: Schema.Types.ObjectId, ref: 'Subsidiary' }],
    isActive: { type: Boolean, required: true, default: false },
    isInvitePending: { type: Boolean, required: true, default: true },
    lastLoginAt: { type: Date },
    isDeleted: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

// PRD §8.2 — users.email unique.
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1, isActive: 1 });

export const User: Model<UserAttrs> = mongoose.model<UserAttrs>('User', userSchema);
