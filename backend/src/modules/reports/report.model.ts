import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Reports — PRD §4.2, §5.5.
 *
 * Lifecycle: draft -> published -> archived. Per the §11.5 decision, publish
 * is single-step and Admin-only; there is no approval state. Adding one later
 * means inserting a status, not migrating the shape of this document.
 */
export const REPORT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportSection {
  heading: string;
  body: string;
}

/**
 * A citation — PRD §8.1.
 *
 * Kept as structured metadata, separate from the prose, so the frontend can
 * render traceability links without parsing generated text. It is also the
 * security reason for the separation (§9.5): a citation is validated against
 * the chunks actually retrieved, never accepted from model output.
 */
export interface ReportCitation {
  documentId: Types.ObjectId;
  extractedFieldId?: Types.ObjectId;
  fieldName?: string;
  chunkIndex?: number;
  pageNumber?: number;
  section?: string;
  confidenceScore?: number;
}

/** One immutable point-in-time snapshot of the report's content (§4.2). */
export interface ReportVersion {
  version: number;
  sections: ReportSection[];
  editedBy: Types.ObjectId;
  editedAt: Date;
  changeSummary?: string;
}

export interface ReportAttrs {
  title: string;
  templateId: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  createdBy: Types.ObjectId;
  status: ReportStatus;
  sections: ReportSection[];
  currentVersion: number;
  versionHistory: ReportVersion[];
  sourceDocumentLinks: Types.ObjectId[];
  citations: ReportCitation[];
  /** True when any cited figure was below the review threshold (§4.1). */
  hasUnreviewedFigures: boolean;
  publishedBy?: Types.ObjectId;
  publishedAt?: Date;
  archivedBy?: Types.ObjectId;
  archivedAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ReportDoc = HydratedDocument<ReportAttrs>;

const sectionSchema = new Schema<ReportSection>(
  { heading: { type: String, required: true }, body: { type: String, required: true } },
  { _id: false },
);

const reportSchema = new Schema<ReportAttrs>(
  {
    title: { type: String, required: true, trim: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'ReportTemplate', required: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, required: true, enum: REPORT_STATUSES, default: 'draft' },
    sections: { type: [sectionSchema], default: [] },
    currentVersion: { type: Number, required: true, default: 1 },
    versionHistory: [
      {
        _id: false,
        version: { type: Number, required: true },
        sections: { type: [sectionSchema], default: [] },
        editedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        editedAt: { type: Date, required: true },
        changeSummary: { type: String },
      },
    ],
    sourceDocumentLinks: [{ type: Schema.Types.ObjectId, ref: 'Document' }],
    citations: [
      {
        _id: false,
        documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
        extractedFieldId: { type: Schema.Types.ObjectId, ref: 'ExtractedField' },
        fieldName: { type: String },
        chunkIndex: { type: Number },
        pageNumber: { type: Number },
        section: { type: String },
        confidenceScore: { type: Number },
      },
    ],
    hasUnreviewedFigures: { type: Boolean, required: true, default: false },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },
    isDeleted: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

// PRD §8.2.
reportSchema.index({ subsidiaryId: 1, status: 1, createdAt: -1 });
reportSchema.index({ createdBy: 1, createdAt: -1 });
reportSchema.index({ templateId: 1 });

export const Report: Model<ReportAttrs> = mongoose.model<ReportAttrs>('Report', reportSchema);
