import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Chunked document text — PRD §8.1, §8.2.
 *
 * Carries `subsidiaryId` denormalised from its parent document so retrieval
 * can be authorization-filtered in the same query (§9.5) rather than by
 * joining back to `documents` and hoping the caller remembered to check.
 */
export interface DocumentChunkAttrs {
  documentId: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  chunkIndex: number;
  text: string;
  pageNumber?: number;
  section?: string;
  isDeleted: boolean;
  createdAt: Date;
}

export type DocumentChunkDoc = HydratedDocument<DocumentChunkAttrs>;

const chunkSchema = new Schema<DocumentChunkAttrs>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    pageNumber: { type: Number },
    section: { type: String },
    isDeleted: { type: Boolean, required: true, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true, strictQuery: true },
);

chunkSchema.index({ documentId: 1, chunkIndex: 1 });
chunkSchema.index({ subsidiaryId: 1 });
// §8.2 — supports keyword search and §4.3 topic term extraction.
chunkSchema.index({ text: 'text' }, { name: 'chunk_text' });

export const DocumentChunk: Model<DocumentChunkAttrs> = mongoose.model<DocumentChunkAttrs>(
  'DocumentChunk',
  chunkSchema,
);
