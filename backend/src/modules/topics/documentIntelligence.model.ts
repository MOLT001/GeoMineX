import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * One row per document: everything §6 asks a document to be able to store that
 * is not a per-topic fact.
 *
 * ─── WHY IT IS NOT FIELDS ON `documents` ────────────────────────────────────
 * The documents collection is on the authorization path — every list, every
 * detail read, every retrieval re-verification loads it. Keywords, technical
 * terms and a summary would add unbounded arrays and a paragraph of text to a
 * document that is fetched constantly and needs none of it. Keeping derived
 * intelligence beside the document rather than inside it also means a change to
 * the extractor never touches the collection that decides who can see what.
 *
 * ─── EXTRACTION STATUS LIVES HERE, NOT ON THE DOCUMENT ──────────────────────
 * §25 wants Processing / Completed / Failed / Retrying to be distinguishable.
 * `documents.status` already answers "was the FILE read", and overloading it
 * with "was it UNDERSTOOD" would make a perfectly ingested document look
 * failed because its text was too thin to have a subject. They are separate
 * questions with separate answers, so they get separate fields: a document can
 * be `validated` and its intelligence `insufficient_text` at the same time, and
 * both statements are true.
 */

export const INTELLIGENCE_STATUSES = [
  'pending',
  'processing',
  'extracted',
  /** Read fine, but there was not enough text to say what it is about. */
  'insufficient_text',
  /** A subject was found, but OCR quality means it should not be trusted unseen. */
  'low_quality',
  'failed',
] as const;
export type IntelligenceStatus = (typeof INTELLIGENCE_STATUSES)[number];

export interface ScoredTermAttrs {
  term: string;
  count: number;
  score: number;
  domain: boolean;
}

export interface DocumentIntelligenceAttrs {
  documentId: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  status: IntelligenceStatus;
  primaryTopicId?: string;
  primaryTopicLabel?: string;
  secondaryTopicIds: string[];
  keywords: ScoredTermAttrs[];
  technicalTerms: ScoredTermAttrs[];
  /** Sentences SELECTED verbatim from the document — never generated prose. */
  summary: string;
  /** 0..1, capped by OCR quality (§22). */
  confidence: number;
  /** The scorer that produced this. Reprocess when it moves (§21). */
  extractionVersion: string;
  extractedAt?: Date;
  /** Non-sensitive reason only, mirroring `documents.processingError` (§9.4). */
  error?: string;
  /** Counts only — never content. Feeds the audit record and the retry decision. */
  stats?: { tokens: number; distinctTerms: number; aliasHits: number; noiseDropped: number };
  documentCreatedAt: Date;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type DocumentIntelligenceDoc = HydratedDocument<DocumentIntelligenceAttrs>;

const scoredTermSchema = new Schema<ScoredTermAttrs>(
  {
    term: { type: String, required: true },
    count: { type: Number, required: true },
    score: { type: Number, required: true },
    domain: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const documentIntelligenceSchema = new Schema<DocumentIntelligenceAttrs>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true, unique: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    status: { type: String, required: true, enum: INTELLIGENCE_STATUSES, default: 'pending' },
    primaryTopicId: { type: String },
    primaryTopicLabel: { type: String },
    secondaryTopicIds: [{ type: String }],
    keywords: { type: [scoredTermSchema], default: [] },
    technicalTerms: { type: [scoredTermSchema], default: [] },
    summary: { type: String, required: true, default: '' },
    confidence: { type: Number, required: true, default: 0, min: 0, max: 1 },
    extractionVersion: { type: String, required: true },
    extractedAt: { type: Date },
    error: { type: String },
    stats: {
      type: new Schema(
        {
          tokens: { type: Number, required: true },
          distinctTerms: { type: Number, required: true },
          aliasHits: { type: Number, required: true },
          noiseDropped: { type: Number, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
    documentCreatedAt: { type: Date, required: true },
    isDeleted: { type: Boolean, required: true, default: false },
  },
  {
    collection: 'documentIntelligence',
    timestamps: true,
    strict: true,
    strictQuery: true,
  },
);

/**
 * §21 — "only reprocess when the extraction version changes". This index is
 * what makes finding those documents a range read rather than a collection
 * scan, so a version bump is a maintenance job and not an outage.
 */
documentIntelligenceSchema.index({ subsidiaryId: 1, extractionVersion: 1 });
/** The "which documents still need analysing / retrying" queue (§25). */
documentIntelligenceSchema.index({ status: 1, documentCreatedAt: -1 });
// documentId is already unique via the field-level `unique: true` above.

export const DocumentIntelligence: Model<DocumentIntelligenceAttrs> =
  mongoose.model<DocumentIntelligenceAttrs>('DocumentIntelligence', documentIntelligenceSchema);
