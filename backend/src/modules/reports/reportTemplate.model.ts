import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Report templates — PRD §4.2, §5.5.
 *
 * A template is a list of sections. Each section's body may reference
 * extracted fields with `{{fieldName}}` placeholders, which drafting resolves
 * against the source documents' extracted values.
 */
export interface TemplateSection {
  heading: string;
  body: string;
}

export interface ReportTemplateAttrs {
  name: string;
  description?: string;
  sections: TemplateSection[];
  /** Empty = available to every subsidiary. */
  subsidiaryScope: Types.ObjectId[];
  version: number;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ReportTemplateDoc = HydratedDocument<ReportTemplateAttrs>;

const templateSchema = new Schema<ReportTemplateAttrs>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    sections: [
      {
        _id: false,
        heading: { type: String, required: true },
        body: { type: String, required: true },
      },
    ],
    subsidiaryScope: [{ type: Schema.Types.ObjectId, ref: 'Subsidiary' }],
    version: { type: Number, required: true, default: 1 },
    isDeleted: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

templateSchema.index({ name: 1 }, { unique: true });
templateSchema.index({ subsidiaryScope: 1 });

export const ReportTemplate: Model<ReportTemplateAttrs> = mongoose.model<ReportTemplateAttrs>(
  'ReportTemplate',
  templateSchema,
);
