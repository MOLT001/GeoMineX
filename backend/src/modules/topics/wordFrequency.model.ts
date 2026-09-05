import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * Materialised keyword frequencies — PRD §4.3, §8, §8.2.
 *
 * Collection name is set EXPLICITLY to `wordFrequencies` so the deployed name
 * matches §8's table verbatim rather than relying on Mongoose pluralisation.
 *
 * Rows are stored at PER-SOURCE granularity, not pre-summed per subsidiary.
 * That is what makes reprocessing idempotent — delete-then-insert by
 * (sourceType, sourceId), exactly as document.worker.ts already does for
 * chunks and fields — and it lets ONE row set serve the word cloud, the
 * clusters and the quarter-over-quarter trend without a rebuild.
 *
 * `periodMonth` and `periodQuarter` are computed ONCE at index time from the
 * SOURCE's UTC createdAt, by the same istPeriod.ts functions the analytics
 * pipeline expression mirrors (§4.6). Bucketing on the SOURCE's date — not the
 * row's — is deliberate: chunks are re-derived on every retry, so keying on
 * write time would move a 2024 document into the current fiscal quarter the
 * moment someone pressed Retry.
 *
 * §4.3 groups "documents/queries", so `sourceType` covers both.
 */
export const TERM_SOURCE_TYPES = ['document', 'query'] as const;
export type TermSourceType = (typeof TERM_SOURCE_TYPES)[number];

export interface WordFrequencyAttrs {
  term: string;
  count: number;
  sourceType: TermSourceType;
  sourceId: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  /** '2026-04' — IST month key. */
  periodMonth: string;
  /** 'FY2026-Q1' — Indian fiscal quarter key. */
  periodQuarter: string;
  /** The SOURCE's createdAt, so an arbitrary IST range needs no join. */
  sourceCreatedAt: Date;
  isDeleted: boolean;
  createdAt: Date;
}

export type WordFrequencyDoc = HydratedDocument<WordFrequencyAttrs>;

const wordFrequencySchema = new Schema<WordFrequencyAttrs>(
  {
    term: { type: String, required: true },
    count: { type: Number, required: true },
    sourceType: { type: String, required: true, enum: TERM_SOURCE_TYPES },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
    periodMonth: { type: String, required: true },
    periodQuarter: { type: String, required: true },
    sourceCreatedAt: { type: Date, required: true },
    isDeleted: { type: Boolean, required: true, default: false },
  },
  {
    collection: 'wordFrequencies',
    timestamps: { createdAt: true, updatedAt: false },
    strict: true,
    strictQuery: true,
  },
);

/**
 * §8.2 names `topics/wordFrequencies.subsidiaryId + periodBucket` as a required
 * index. Both bucket grains get one, because §4.3's trend comparison is by
 * quarter while §5.6's date-range filter is by month.
 */
wordFrequencySchema.index({ subsidiaryId: 1, periodMonth: 1, term: 1 });
wordFrequencySchema.index({ subsidiaryId: 1, periodQuarter: 1, term: 1 });
/** §8.2 — arbitrary IST date ranges that do not align to a whole bucket. */
wordFrequencySchema.index({ subsidiaryId: 1, sourceCreatedAt: -1 });
/** The idempotent delete-then-insert on reprocessing (§9.4). */
wordFrequencySchema.index({ sourceType: 1, sourceId: 1 });

// NOTE: no text index here. These rows already hold tokens; a text index over
// a token column would be pure cost.

export const WordFrequency: Model<WordFrequencyAttrs> = mongoose.model<WordFrequencyAttrs>(
  'WordFrequency',
  wordFrequencySchema,
);
