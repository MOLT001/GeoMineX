import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Field-level extraction results — PRD §4.2, §4.5, §8.1.
 *
 * NOTE (§8.2): `value` is deliberately NOT text-indexed. Extracted values may
 * hold sensitive operational figures, and the indexing rule limits text
 * indexes to non-sensitive fields.
 */
export interface ExtractedFieldAttrs {
  documentId: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  fieldName: string;
  value: string;
  confidenceScore: number;
  sourceLocation?: { pageNumber?: number; section?: string; chunkIndex?: number };
  /** Manual override provenance (§4.5) — who changed it, why, and when. */
  overriddenBy?: Types.ObjectId;
  overrideReason?: string;
  overriddenAt?: Date;
  originalValue?: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ExtractedFieldDoc = HydratedDocument<ExtractedFieldAttrs>;

const extractedFieldSchema = new Schema<ExtractedFieldAttrs>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    fieldName: { type: String, required: true, trim: true },
    value: { type: String, required: true },
    confidenceScore: { type: Number, required: true, min: 0, max: 1 },
    sourceLocation: {
      pageNumber: { type: Number },
      section: { type: String },
      chunkIndex: { type: Number },
    },
    overriddenBy: { type: Schema.Types.ObjectId, ref: 'User' },
    overrideReason: { type: String },
    overriddenAt: { type: Date },
    originalValue: { type: String },
    isDeleted: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

extractedFieldSchema.index({ documentId: 1, fieldName: 1 });
extractedFieldSchema.index({ subsidiaryId: 1, createdAt: -1 });

export const ExtractedField: Model<ExtractedFieldAttrs> = mongoose.model<ExtractedFieldAttrs>(
  'ExtractedField',
  extractedFieldSchema,
);
