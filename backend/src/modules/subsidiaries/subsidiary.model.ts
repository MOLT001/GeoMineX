import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export interface SubsidiaryAttrs {
  name: string;
  /** Short code, e.g. "BCCL", "WCL". */
  code: string;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type SubsidiaryDoc = HydratedDocument<SubsidiaryAttrs>;

const subsidiarySchema = new Schema<SubsidiaryAttrs>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    isDeleted: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

subsidiarySchema.index({ code: 1 }, { unique: true });

export const Subsidiary: Model<SubsidiaryAttrs> = mongoose.model<SubsidiaryAttrs>('Subsidiary', subsidiarySchema);
