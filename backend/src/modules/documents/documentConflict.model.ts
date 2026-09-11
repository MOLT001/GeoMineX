import mongoose, { Schema, Types, type HydratedDocument, type Model } from 'mongoose';

/**
 * A CANDIDATE conflict: two documents in one subsidiary reporting different
 * values for the same metric — PRD §4.5.
 *
 * ─── WHY THIS IS "CANDIDATE" AND NOT "ERROR" ────────────────────────────────
 * The system cannot know which figure is right, and must not pretend to. A
 * revised return legitimately supersedes an earlier one; a corrigendum
 * legitimately contradicts the original; and two reports covering different
 * periods legitimately differ while sharing a row label. All three look
 * identical to a comparison of values.
 *
 * So a conflict is RAISED, never resolved: it records both readings with their
 * documents and dates and asks a human which is authoritative. That is the
 * §4.5 traceability position — the system's job is to make a discrepancy
 * impossible to miss, not to adjudicate it.
 *
 * ─── WHAT COUNTS AS THE SAME METRIC ─────────────────────────────────────────
 * The normalised field name, which is what the extractor read off the row
 * label. `Coal Production` and `Coal Production (till date)` are deliberately
 * DIFFERENT metrics: one is a monthly figure and the other cumulative, and
 * folding them together would raise a conflict between two correct numbers.
 */
export const CONFLICT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export interface ConflictReading {
  documentId: Types.ObjectId;
  /** Denormalised so the review list needs no join to be readable. */
  originalFilename: string;
  extractedFieldId: Types.ObjectId;
  /** Exactly as extracted, including separators — the citable form. */
  value: string;
  /** The parsed figure the comparison was made on. */
  numericValue: number;
  /** The report's own provenance, where the extractor established one. */
  section?: string;
  documentCreatedAt: Date;
}

export interface DocumentConflictAttrs {
  subsidiaryId: Types.ObjectId;
  /** Lowercased, punctuation-folded field name. The identity of the metric. */
  metricKey: string;
  /** The label as a document actually printed it, for display. */
  metricLabel: string;
  readings: ConflictReading[];
  /** Largest absolute gap between any two readings — orders the review queue. */
  spread: number;
  status: ConflictStatus;
  detectedAt: Date;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  /** Which reading a human declared authoritative, when they have. */
  resolvedDocumentId?: Types.ObjectId;
  resolutionNote?: string;
  isDeleted: boolean;
}

export type DocumentConflictDoc = HydratedDocument<DocumentConflictAttrs>;

const readingSchema = new Schema<ConflictReading>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    originalFilename: { type: String, required: true },
    extractedFieldId: { type: Schema.Types.ObjectId, ref: 'ExtractedField', required: true },
    value: { type: String, required: true },
    numericValue: { type: Number, required: true },
    section: { type: String },
    documentCreatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const conflictSchema = new Schema<DocumentConflictAttrs>(
  {
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    metricKey: { type: String, required: true },
    metricLabel: { type: String, required: true },
    readings: { type: [readingSchema], required: true },
    spread: { type: Number, required: true, default: 0 },
    status: { type: String, required: true, enum: CONFLICT_STATUSES, default: 'open' },
    detectedAt: { type: Date, required: true, default: () => new Date() },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    resolvedDocumentId: { type: Schema.Types.ObjectId, ref: 'Document' },
    resolutionNote: { type: String },
    isDeleted: { type: Boolean, required: true, default: false },
  },
  { timestamps: true, strict: true, strictQuery: true, versionKey: false },
);

/**
 * One row per (subsidiary, metric). Re-detection UPDATES it rather than
 * appending a second row, so a document processed twice does not double the
 * review queue — the same delete-then-write discipline the rest of the
 * ingestion path uses, expressed as an upsert.
 */
conflictSchema.index({ subsidiaryId: 1, metricKey: 1 }, { unique: true });
/** The review queue: open conflicts, widest gap first. */
conflictSchema.index({ subsidiaryId: 1, status: 1, spread: -1 });
/** "Is this document implicated in anything?" — the document detail page. */
conflictSchema.index({ 'readings.documentId': 1, status: 1 });

export const DocumentConflict: Model<DocumentConflictAttrs> =
  mongoose.model<DocumentConflictAttrs>('DocumentConflict', conflictSchema);
