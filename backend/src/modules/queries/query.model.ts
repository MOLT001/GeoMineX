import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';

/**
 * The persistent, searchable, auditable parliamentary query log —
 * PRD §4.4, §5.7, §8, §8.1, §8.2.
 *
 * Two orthogonal states are kept deliberately separate:
 *   `status`       — the instructions §4a GENERATION state machine.
 *   `reviewStatus` — the human workflow §5.7 and §5.3 mean by "status".
 * Collapsing them would make "the model has not answered yet" indistinguishable
 * from "a human has not approved the answer yet", which are different problems
 * with different owners.
 *
 * Exported as `QueryModel`, not `Query`, for the same reason document.model.ts
 * exports `DocumentModel`: Mongoose exports its own `Query` type and any file
 * importing both would collide.
 */

/** §4a: includes the terminal `dead_lettered` state the Phase 1 document worker omits. */
export const QUERY_STATUSES = [
  'queued',
  'retrieving',
  'answering',
  'answered',
  'unsupported',
  'failed',
  'dead_lettered',
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export const QUERY_REVIEW_STATUSES = ['not_required', 'pending', 'approved', 'rejected'] as const;
export type QueryReviewStatus = (typeof QUERY_REVIEW_STATUSES)[number];

/**
 * §9.5 "distinguish sourced facts from unsupported content", as three states
 * rather than a boolean:
 *   sourced            — every claimed ref survived validation
 *   partially_sourced  — at least one survived, at least one was discarded
 *   unsupported        — none survived, or nothing cleared the relevance floor
 * The extractive local adapter is `sourced` by construction;
 * `partially_sourced` exists for the generative provider §11.7 may authorise.
 */
export const ANSWER_STATUSES = ['sourced', 'partially_sourced', 'unsupported'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/**
 * A citation — PRD §8.1.
 *
 * Structured metadata, separate from the prose, so the frontend renders
 * traceability links without parsing generated text (§5.8). EVERY field here,
 * INCLUDING `quote`, is built from the SERVER-HELD chunk record. No citation
 * field ever originates in model output — that is the §9.5 rule, and the
 * reason §8.1 requires the separation in the first place.
 *
 * Field names mirror ReportCitation so the frontend's traceability view is one
 * component.
 */
export interface QueryCitation {
  ordinal: number;
  documentId: Types.ObjectId;
  /** Safe to denormalise: originals are immutable after ingestion (§9.4). */
  documentFilename: string;
  chunkId: Types.ObjectId;
  chunkIndex: number;
  pageNumber?: number;
  section?: string;
  /** Sliced SERVER-SIDE from chunk.text at env.AI_CITATION_QUOTE_CHARS. */
  quote: string;
  /** Retrieval score. NOT a truth score — do not present it as confidence. */
  relevance: number;
  subsidiaryId: Types.ObjectId;
}

export interface QueryInjectionFlag {
  documentId: Types.ObjectId;
  chunkId: Types.ObjectId;
  ruleId: string;
  severity: 'low' | 'high';
}

export interface QueryAttrs {
  askedBy: Types.ObjectId;
  /**
   * The AUTHORIZATION field. Always non-empty. Reads use containment over this
   * array and nothing else — see query.service.ts#scopeContainmentClause.
   */
  contextScope: { subsidiaryIds: Types.ObjectId[]; documentIds: Types.ObjectId[] };
  /**
   * Denormalised: set only when contextScope.subsidiaryIds has exactly one
   * entry. Present for §8's indicative shape, for audit records, and for the
   * §5.7 log table. NEVER used for authorization — contextScope is.
   */
  subsidiaryId?: Types.ObjectId;
  questionText: string;
  isParliamentary: boolean;

  /** The MODEL's answer. Immutable once generation reaches a terminal state. */
  responseText?: string;
  /** The HUMAN's official response (PATCH). Never produced by a model. */
  officialResponseText?: string;
  answerStatus?: AnswerStatus;
  citations: QueryCitation[];
  /** What was actually retrieved — the basis §9.5 requires citations validated against. */
  retrievedChunkIds: Types.ObjectId[];
  candidatesConsidered: number;
  passagesUsed: number;
  passagesWithheld: number;
  /**
   * §4.5 — metrics on which the CITED documents disagree with each other.
   *
   * Recorded on the query, not derived at read time, because it is a fact about
   * the corpus AS IT WAS when the answer was produced. A conflict resolved
   * afterwards must not silently erase the warning that was shown to whoever
   * read this answer.
   */
  conflictingMetrics: Array<{
    metricLabel: string;
    readings: Array<{ originalFilename: string; value: string }>;
    /** Why it was attached: the question named the metric, or the answer quotes a disputed figure. */
    reason?: 'asked' | 'quoted';
    /** The figure the answer states, when `reason` is `quoted`. */
    quoted?: string;
  }>;
  discardedCitationCount: number;
  injectionFlags: QueryInjectionFlag[];
  injectionSuspected: boolean;

  status: QueryStatus;
  reviewStatus: QueryReviewStatus;
  attempts: number;
  maxAttempts: number;
  processingStartedAt?: Date;
  lastAttemptAt?: Date;
  /** NON-SENSITIVE reason only (§9.4). The raw error goes to the log. */
  failureReason?: string;

  providerName?: string;
  promptVersion?: string;
  model?: string;
  generationMs?: number;
  answeredAt?: Date;

  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  reviewNote?: string;
  linkedReportId?: Types.ObjectId;

  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type QueryDoc = HydratedDocument<QueryAttrs>;

const citationSchema = new Schema<QueryCitation>(
  {
    ordinal: { type: Number, required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    documentFilename: { type: String, required: true },
    chunkId: { type: Schema.Types.ObjectId, ref: 'DocumentChunk', required: true },
    chunkIndex: { type: Number, required: true },
    pageNumber: { type: Number },
    section: { type: String },
    quote: { type: String, required: true },
    relevance: { type: Number, required: true },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary', required: true },
  },
  { _id: false },
);

const querySchema = new Schema<QueryAttrs>(
  {
    askedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    contextScope: {
      subsidiaryIds: [{ type: Schema.Types.ObjectId, ref: 'Subsidiary' }],
      documentIds: [{ type: Schema.Types.ObjectId, ref: 'Document' }],
    },
    subsidiaryId: { type: Schema.Types.ObjectId, ref: 'Subsidiary' },
    questionText: { type: String, required: true, trim: true },
    isParliamentary: { type: Boolean, required: true, default: false },

    responseText: { type: String },
    officialResponseText: { type: String },
    answerStatus: { type: String, enum: ANSWER_STATUSES },
    citations: { type: [citationSchema], default: [] },
    retrievedChunkIds: [{ type: Schema.Types.ObjectId, ref: 'DocumentChunk' }],
    candidatesConsidered: { type: Number, required: true, default: 0 },
    passagesUsed: { type: Number, required: true, default: 0 },
    passagesWithheld: { type: Number, required: true, default: 0 },
    conflictingMetrics: {
      type: [
        new Schema(
          {
            metricLabel: { type: String, required: true },
            reason: { type: String, enum: ['asked', 'quoted'], default: 'asked' },
            quoted: { type: String },
            readings: {
              type: [
                new Schema(
                  { originalFilename: { type: String, required: true }, value: { type: String, required: true } },
                  { _id: false },
                ),
              ],
              required: true,
            },
          },
          { _id: false },
        ),
      ],
      required: true,
      default: [],
    },
    discardedCitationCount: { type: Number, required: true, default: 0 },
    injectionFlags: [
      {
        _id: false,
        documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
        chunkId: { type: Schema.Types.ObjectId, ref: 'DocumentChunk', required: true },
        ruleId: { type: String, required: true },
        severity: { type: String, required: true, enum: ['low', 'high'] },
      },
    ],
    injectionSuspected: { type: Boolean, required: true, default: false },

    status: { type: String, required: true, enum: QUERY_STATUSES, default: 'queued' },
    reviewStatus: { type: String, required: true, enum: QUERY_REVIEW_STATUSES, default: 'not_required' },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 3 },
    processingStartedAt: { type: Date },
    lastAttemptAt: { type: Date },
    failureReason: { type: String },

    providerName: { type: String },
    promptVersion: { type: String },
    model: { type: String },
    generationMs: { type: Number },
    answeredAt: { type: Date },

    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
    linkedReportId: { type: Schema.Types.ObjectId, ref: 'Report' },

    isDeleted: { type: Boolean, required: true, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

// ── PRD §8.2 indexes ────────────────────────────────────────────────────────
/** §8.2 names `queries.askedBy + createdAt` explicitly. */
querySchema.index({ askedBy: 1, createdAt: -1 });
/** §8.2 — the authorization and list read path: containment is evaluated on this array. */
querySchema.index({ 'contextScope.subsidiaryIds': 1, createdAt: -1 });
/** §8.2 — the §5.7 parliamentary log table and the §5.3 pending-work panel. */
querySchema.index({ 'contextScope.subsidiaryIds': 1, isParliamentary: 1, reviewStatus: 1, createdAt: -1 });
/** §8.2 — the §4a stuck-job sweep (recoverStuckQueries). */
querySchema.index({ status: 1, processingStartedAt: 1 });
/** §8.2 — the §5.7 back-link from a query to the report that carries its answer. */
querySchema.index({ linkedReportId: 1 }, { sparse: true });

/**
 * §8.2 text index.
 *
 * §8.2 names `queries.questionText` and permits `responseText` "where response
 * search is required"; §5.7 requires a searchable table of past queries, and a
 * log you can only search by question is half a log. Weighted so a question
 * match outranks an answer match.
 *
 * DELIBERATELY EXCLUDED: `citations.quote` and `officialResponseText`. The
 * quote is document-derived and already searchable through documentChunks;
 * the official response is human-authored and may restate a sensitive
 * operational figure, which is the same reason §8.2 excludes
 * `extractedFields.value`.
 *
 * §8.2's closing rule binds forever: every text-index-backed search must carry
 * the caller's subsidiary scope IN THE SAME QUERY. listQueries does; anything
 * added later must too. tests/queries.test.ts pins it.
 */
querySchema.index(
  { questionText: 'text', responseText: 'text' },
  { name: 'query_text', weights: { questionText: 10, responseText: 3 } },
);

// No _id index is declared for cursor pagination (§9.8): MongoDB always
// maintains it, rejects a custom one, and it serves both sort directions —
// the same note document.model.ts carries.

export const QueryModel: Model<QueryAttrs> = mongoose.model<QueryAttrs>('Query', querySchema);
