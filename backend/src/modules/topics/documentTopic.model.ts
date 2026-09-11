import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';
import { TOPIC_CATEGORIES } from './taxonomy.js';

/**
 * The document-to-topic join — what makes topics FUNCTIONAL rather than
 * decorative.
 *
 * ─── WHY A ROW PER PAIR, AND NOT AN ARRAY ON THE DOCUMENT ───────────────────
 * "Show me every document tagged Geological Exploration, newest first, within
 * my subsidiaries" is the query the Documents filter and the Topic Explorer
 * both run, and it has to be served by an index rather than by scanning
 * documents and unwinding arrays. One row per (document, topic) makes that a
 * single indexed range read. The reverse direction — a document's own topics —
 * is equally cheap on `{ documentId, score }`.
 *
 * ─── THE TAXONOMY IS CODE; THE ASSIGNMENTS ARE DATA ─────────────────────────
 * There is deliberately NO `topics` collection. Canonical topics live in
 * `taxonomy.ts` because they are a reviewed vocabulary, not user content, and a
 * second copy in the database would be one more thing that can drift. Label and
 * category are DENORMALISED onto each row anyway, so a topic list can be built
 * by aggregation without a lookup, and so a discovered topic — which by
 * definition has no taxonomy entry — is described by its own row.
 *
 * ─── IDEMPOTENT BY THE SAME CONTRACT AS EVERYTHING ELSE ─────────────────────
 * Reprocessing deletes every row for the document and inserts fresh ones,
 * exactly as `document.worker.ts` already does for chunks and extracted fields
 * and as `termIndexer.ts` does for term rows. The unique index on
 * (documentId, topicId) is the backstop that turns a bug in that sequence into
 * a write error rather than a silently doubled topic count.
 */

export const TOPIC_RANKS = ['primary', 'secondary'] as const;
export type TopicRank = (typeof TOPIC_RANKS)[number];

export interface TopicEvidenceAttrs {
  chunkIndex: number;
  pageNumber?: number;
  /** A verbatim slice of the source. Never model-written text. */
  quote: string;
}

export interface DocumentTopicAttrs {
  documentId: Types.ObjectId;
  /** Denormalised from the parent so every read is authorization-filtered in one query (§9.5). */
  subsidiaryId: Types.ObjectId;
  /** Taxonomy slug, or `discovered:<phrase>` for one found in the text. */
  topicId: string;
  label: string;
  category: string;
  rank: TopicRank;
  /** Raw score. Comparable WITHIN one document only — never across documents. */
  score: number;
  /** 0..1 against the document's leading topic. This is what ranks and sizes. */
  relevance: number;
  termCount: number;
  /** Surface forms actually found, so a chip can show what the document said. */
  matchedTerms: string[];
  discovered: boolean;
  firstPage?: number;
  evidence: TopicEvidenceAttrs[];
  extractionVersion: string;
  /**
   * The PARENT's createdAt, copied at write time.
   *
   * Trend and explorer queries sort and bucket by when the document arrived,
   * not by when this row was last rewritten — otherwise pressing Retry would
   * move a 2024 report into the current quarter, the same trap
   * `wordFrequency.sourceCreatedAt` exists to avoid.
   */
  documentCreatedAt: Date;
  isDeleted: boolean;
  createdAt: Date;
}

export type DocumentTopicDoc = HydratedDocument<DocumentTopicAttrs>;

const evidenceSchema = new Schema<TopicEvidenceAttrs>(
  {
    chunkIndex: { type: Number, required: true },
    pageNumber: { type: Number },
    quote: { type: String, required: true },
  },
  { _id: false },
);

const documentTopicSchema = new Schema<DocumentTopicAttrs>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    topicId: { type: String, required: true },
    label: { type: String, required: true },
    // Not an enum: a discovered topic's category is `discovered`, and pinning
    // the list here would make adding a taxonomy category a migration.
    category: { type: String, required: true, default: 'discovered' },
    rank: { type: String, required: true, enum: TOPIC_RANKS },
    score: { type: Number, required: true },
    relevance: { type: Number, required: true, min: 0, max: 1 },
    termCount: { type: Number, required: true, default: 0 },
    matchedTerms: [{ type: String }],
    discovered: { type: Boolean, required: true, default: false },
    firstPage: { type: Number },
    evidence: { type: [evidenceSchema], default: [] },
    extractionVersion: { type: String, required: true },
    documentCreatedAt: { type: Date, required: true },
    isDeleted: { type: Boolean, required: true, default: false },
  },
  {
    collection: 'documentTopics',
    timestamps: { createdAt: true, updatedAt: false },
    strict: true,
    strictQuery: true,
  },
);

/** The Documents topic filter and the Topic Explorer's document list. */
documentTopicSchema.index({ subsidiaryId: 1, topicId: 1, documentCreatedAt: -1 });
/** A document's own topics, strongest first — the detail page and related-docs seed. */
documentTopicSchema.index({ documentId: 1, score: -1 });
/** Topic co-occurrence (§16) and related documents (§17), scoped in the same query. */
documentTopicSchema.index({ topicId: 1, subsidiaryId: 1 });
/** Idempotency backstop: a doubled insert fails loudly instead of doubling a count. */
documentTopicSchema.index({ documentId: 1, topicId: 1 }, { unique: true });

// TOPIC_CATEGORIES is imported for the taxonomy's own use of this module's
// vocabulary; referencing it here keeps the two files' notion of a category
// visibly coupled without turning the stored field into an enum.
export const KNOWN_TOPIC_CATEGORIES: readonly string[] = TOPIC_CATEGORIES;

export const DocumentTopic: Model<DocumentTopicAttrs> = mongoose.model<DocumentTopicAttrs>(
  'DocumentTopic',
  documentTopicSchema,
);
