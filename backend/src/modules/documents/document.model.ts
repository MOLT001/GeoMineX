import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/** PRD §4.1 — accepted source material. */
// `archive` is a zip of the others — PS 26023 names archives as an input, and
// its members are read into this one document rather than fanned out into many.
export const DOCUMENT_TYPES = ['pdf', 'scan', 'spreadsheet', 'image', 'archive'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** PRD §4.1 — queued -> processing -> validated / failed. */
export const DOCUMENT_STATUSES = ['queued', 'processing', 'validated', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface DocumentAttrs {
  subsidiaryId: Types.ObjectId;
  uploadedBy: Types.ObjectId;
  /** Retained for display and search only — never used to build a storage path (§9.4). */
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  type: DocumentType;
  status: DocumentStatus;
  /** Server-generated. Immutable once written (§9.4). */
  storageKey: string;
  /** SHA-256 of the original bytes — lets tampering be detected later. */
  checksum: string;
  ocrConfidence?: number;
  /** True when extraction confidence is at or below the review threshold (§4.1). */
  requiresReview: boolean;
  /**
   * PRD §9.5 — set at INGESTION when a chunk trips the injection scanner.
   *
   * Flagging happens where untrusted text first enters the system rather than
   * at retrieval time, so a hostile document that no query ever surfaces is
   * still visible to a human. A flagged document is always also
   * `requiresReview`, which is what puts it in the existing §5.3 review queue.
   */
  injectionSuspected: boolean;
  /**
   * Which rules fired. Detection internals: deliberately NOT exposed through
   * `present()` — publishing which patterns matched tells an author exactly
   * which ones to avoid next time.
   */
  injectionRuleIds: string[];
  /** Auto-tagged on upload by subsidiary, date and type (§4.1). */
  tags: string[];
  /** Non-sensitive failure reason only (§9.4). */
  processingError?: string;
  processingAttempts: number;
  processedAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentDoc = HydratedDocument<DocumentAttrs>;

const documentSchema = new Schema<DocumentAttrs>(
  {
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    originalFilename: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    type: { type: String, required: true, enum: DOCUMENT_TYPES },
    status: { type: String, required: true, enum: DOCUMENT_STATUSES, default: 'queued' },
    storageKey: { type: String, required: true },
    checksum: { type: String, required: true },
    ocrConfidence: { type: Number },
    requiresReview: { type: Boolean, required: true, default: false },
    // `default: false` (never `required` without one) is what lets a Phase 1
    // row that predates this field stay visible to a `$match` — an
    // un-backfilled document must not silently vanish from the review queue.
    injectionSuspected: { type: Boolean, required: true, default: false },
    injectionRuleIds: [{ type: String }],
    tags: [{ type: String }],
    processingError: { type: String },
    processingAttempts: { type: Number, required: true, default: 0 },
    processedAt: { type: Date },
    isDeleted: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

// PRD §8.2 — authorization and filtering paths.
documentSchema.index({ subsidiaryId: 1, status: 1, createdAt: -1 });
documentSchema.index({ uploadedBy: 1, createdAt: -1 });
documentSchema.index({ storageKey: 1 }, { unique: true });
// No index is added for `injectionSuspected` (§9.5): the existing
// { subsidiaryId, status, createdAt } index plus the `requiresReview` filter
// already serves the review queue, and a flagged document is always also
// `requiresReview`, so the flag only ever narrows a set that is already small.
// Cursor pagination for append-heavy listing (§9.8) sorts by _id descending.
// No index is declared for it: MongoDB always maintains the _id index and
// rejects any custom one, and that index serves both sort directions.

/**
 * PRD §8.2 text index — non-sensitive fields only. Filename and tags are
 * safe to index; extracted values are NOT (see extractedField.model.ts).
 */
documentSchema.index({ originalFilename: 'text', tags: 'text' }, { name: 'document_text' });

export const DocumentModel: Model<DocumentAttrs> = mongoose.model<DocumentAttrs>('Document', documentSchema);
