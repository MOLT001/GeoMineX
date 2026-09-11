/**
 * Write-time topic materialisation — the step §7 puts between chunking and
 * "document available for search".
 *
 * Called from `document.worker.ts` immediately after `indexDocumentTerms`, so
 * topics are computed ONCE per document, in the background job that already
 * owns the document's text. §21's whole list of prohibitions — no AI on page
 * load, no regeneration on view, no whole-document work at request time —
 * follows from doing it here and nowhere else.
 *
 * ─── THE SAME FAILURE CONTRACT AS THE TERM INDEXER ──────────────────────────
 * Nothing in this file may fail an ingestion. A document whose topics could not
 * be computed is still a document that was read, stored and made searchable;
 * losing its chips is a degraded feature, not a lost filing. Every path
 * therefore records a status and returns, and the only thing a caller learns
 * from a failure is which status was written.
 *
 * ─── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Delete every row for the document, then insert. A retry REPLACES rather than
 * accumulates, exactly as chunks, extracted fields and term rows already do.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DocumentChunk } from '../documents/documentChunk.model.js';
import { DocumentModel, type DocumentType } from '../documents/document.model.js';
import { getCorpusBaseline } from './corpusBaseline.js';
import { DocumentIntelligence, type IntelligenceStatus } from './documentIntelligence.model.js';
import { DocumentTopic } from './documentTopic.model.js';
import { EXTRACTION_VERSION, extractTopics, type ExtractionResult } from './topicExtraction.js';

export interface TopicIndexTarget {
  _id: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  originalFilename: string;
  type: DocumentType;
  createdAt: Date;
}

export interface TopicIndexOutcome {
  status: IntelligenceStatus;
  primaryTopic?: string;
  topicCount: number;
  keywordCount: number;
  confidence: number;
}

const FAILED: TopicIndexOutcome = { status: 'failed', topicCount: 0, keywordCount: 0, confidence: 0 };

/**
 * Whether to run the OCR-confusion fold (§22).
 *
 * Type is the primary signal, but a PDF can be a scan wearing a text layer's
 * clothes — a photocopy someone ran through a converter — and the confidence
 * the OCR provider reported is what gives that away. Either is enough.
 */
function shouldTolerateOcrErrors(type: DocumentType, ocrConfidence: number): boolean {
  return type === 'scan' || type === 'image' || (ocrConfidence > 0 && ocrConfidence <= env.OCR_REVIEW_THRESHOLD);
}

/**
 * Extract, then store, one document's topics.
 *
 * `chunks` are passed in rather than re-read: the worker has just written them
 * and a re-read would race its own insert. `reprocessDocumentTopics` below is
 * the path for a document whose chunks are already durable.
 */
export async function indexDocumentTopics(
  doc: TopicIndexTarget,
  chunks: readonly { text: string; pageNumber?: number; section?: string }[],
  ocrConfidence: number,
): Promise<TopicIndexOutcome> {
  try {
    const baseline = await getCorpusBaseline(doc.subsidiaryId);

    const result = extractTopics({
      chunks,
      filename: doc.originalFilename,
      ocrTolerant: shouldTolerateOcrErrors(doc.type, ocrConfidence),
      ocrConfidence,
      baseline,
    });

    return await persist(doc, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Topic extraction failed', { documentId: String(doc._id), message });
    // §25 — a failure is RECORDED, never silent, so the UI can offer a retry
    // instead of showing a document with no topics and no explanation.
    await markFailed(doc, message);
    return FAILED;
  }
}

/**
 * Write the result.
 *
 * Delete-then-insert, and the intelligence row is upserted LAST: if the process
 * dies between the two, the document is left with no topic rows and a stale or
 * absent intelligence row, which reads as "not analysed" and is retried. The
 * opposite order would leave a document claiming an analysis whose rows are
 * gone.
 */
async function persist(doc: TopicIndexTarget, result: ExtractionResult): Promise<TopicIndexOutcome> {
  await DocumentTopic.deleteMany({ documentId: doc._id });

  if (result.topics.length > 0) {
    await DocumentTopic.insertMany(
      result.topics.map((t, index) => ({
        documentId: doc._id,
        subsidiaryId: doc.subsidiaryId,
        topicId: t.topicId,
        label: t.label,
        category: t.category,
        // Exactly one primary per document — the rank is positional, so it
        // cannot disagree with the score ordering it was derived from.
        rank: index === 0 ? ('primary' as const) : ('secondary' as const),
        score: t.score,
        relevance: t.relevance,
        termCount: t.termCount,
        matchedTerms: t.matchedTerms,
        discovered: t.discovered,
        firstPage: t.firstPage,
        evidence: t.evidence,
        extractionVersion: result.version,
        documentCreatedAt: doc.createdAt,
        isDeleted: false,
      })),
    );
  }

  const status: IntelligenceStatus = result.status;

  await DocumentIntelligence.updateOne(
    { documentId: doc._id },
    {
      $set: {
        documentId: doc._id,
        subsidiaryId: doc.subsidiaryId,
        status,
        primaryTopicId: result.primary?.topicId,
        primaryTopicLabel: result.primary?.label,
        secondaryTopicIds: result.secondary.map((t) => t.topicId),
        keywords: result.keywords,
        technicalTerms: result.technicalTerms,
        summary: result.summary,
        confidence: result.confidence,
        extractionVersion: result.version,
        extractedAt: new Date(),
        documentCreatedAt: doc.createdAt,
        isDeleted: false,
      },
      // Cleared explicitly: a successful rerun of a document that failed before
      // must not keep displaying the old failure alongside its new topics.
      $unset: { error: '' },
    },
    { upsert: true },
  );

  return {
    status,
    primaryTopic: result.primary?.label,
    topicCount: result.topics.length,
    keywordCount: result.keywords.length,
    confidence: result.confidence,
  };
}

async function markFailed(doc: TopicIndexTarget, message: string): Promise<void> {
  await DocumentIntelligence.updateOne(
    { documentId: doc._id },
    {
      $set: {
        documentId: doc._id,
        subsidiaryId: doc.subsidiaryId,
        status: 'failed',
        // Truncated and unadorned: this string reaches a user, and §9.4 keeps
        // internal detail out of anything a user reads.
        error: message.slice(0, 200),
        extractionVersion: EXTRACTION_VERSION,
        documentCreatedAt: doc.createdAt,
        isDeleted: false,
      },
    },
    { upsert: true },
  ).catch(() => undefined);
}

/**
 * Re-run extraction for a document whose chunks are already stored.
 *
 * This is the path behind the explicit reprocess action and the version-bump
 * backfill — the two of §21's four reasons that are not simply "it just
 * processed". It reads the chunks back rather than taking them as an argument,
 * because by definition nobody is holding them.
 *
 * Throws, unlike `indexDocumentTopics`: its caller is a request that should
 * report a failure to the person who asked for it, not a worker that must
 * survive one.
 */
export async function reprocessDocumentTopics(documentId: Types.ObjectId): Promise<TopicIndexOutcome> {
  const doc = await DocumentModel.findOne({ _id: documentId, isDeleted: false })
    .select({ _id: 1, subsidiaryId: 1, originalFilename: 1, type: 1, createdAt: 1, ocrConfidence: 1 })
    .lean();
  if (!doc) throw new Error('document not found');

  await DocumentIntelligence.updateOne(
    { documentId },
    {
      $set: {
        documentId,
        subsidiaryId: doc.subsidiaryId,
        status: 'processing',
        extractionVersion: EXTRACTION_VERSION,
        documentCreatedAt: doc.createdAt,
        isDeleted: false,
      },
    },
    { upsert: true },
  );

  const chunks = await DocumentChunk.find({ documentId, isDeleted: false })
    .sort({ chunkIndex: 1 })
    .select({ text: 1, pageNumber: 1, section: 1 })
    .lean();

  const baseline = await getCorpusBaseline(doc.subsidiaryId);
  const ocrConfidence = doc.ocrConfidence ?? 0;

  const result = extractTopics({
    chunks,
    filename: doc.originalFilename,
    ocrTolerant: shouldTolerateOcrErrors(doc.type, ocrConfidence),
    ocrConfidence,
    baseline,
  });

  return persist(
    {
      _id: doc._id,
      subsidiaryId: doc.subsidiaryId,
      originalFilename: doc.originalFilename,
      type: doc.type,
      createdAt: doc.createdAt,
    },
    result,
  );
}

/**
 * Drop a document's intelligence.
 *
 * NOT CALLED YET, and deliberately so: there is no document-delete endpoint in
 * the API today. It exists for the moment there is one, because a soft-deleted
 * document must stop appearing under a topic filter IMMEDIATELY — `documentTopics`
 * is queried directly and never joins back to `documents`, so nothing else would
 * notice the deletion. `termIndexer.removeTermsForSource` sits unused for exactly
 * the same reason and is the precedent for keeping it.
 */
export async function removeTopicsForDocument(documentId: Types.ObjectId): Promise<void> {
  await Promise.all([
    DocumentTopic.deleteMany({ documentId }).catch(() => undefined),
    DocumentIntelligence.deleteOne({ documentId }).catch(() => undefined),
  ]);
}
