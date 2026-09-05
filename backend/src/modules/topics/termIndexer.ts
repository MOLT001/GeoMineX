/**
 * Write-time term materialisation — PRD §4.3, §9.4.
 *
 * Called from document.worker.ts after a successful validation and from
 * query.worker.ts after an answer, so the §4.3 corpus stays current with no
 * separate scheduled job and no second in-process worker.
 *
 * IDEMPOTENT BY THE SAME CONTRACT THE DOCUMENT WORKER ALREADY USES: delete
 * every row for (sourceType, sourceId), then insert fresh ones. A retry
 * REPLACES rather than accumulates, so reprocessing a document does not double
 * its word cloud.
 *
 * Every write is wrapped so a failure logs and returns 0 rather than failing
 * the operation being indexed — the same contract recordAudit uses. Losing a
 * word-cloud row must never fail an ingestion.
 */
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { countTerms } from '../../utils/textTerms.js';
import { istMonthKey, istFiscalQuarterKey } from '../../utils/istPeriod.js';
import { WordFrequency, type TermSourceType } from './wordFrequency.model.js';

/**
 * The delete happens BEFORE the count is inspected, so a source whose text no
 * longer yields any term (a failed re-OCR, a redacted document) loses its old
 * rows instead of keeping a stale cloud that nothing will ever correct.
 */
async function writeTerms(
  sourceType: TermSourceType,
  sourceId: Types.ObjectId,
  subsidiaryId: Types.ObjectId,
  sourceCreatedAt: Date,
  text: string,
): Promise<number> {
  try {
    const counts = countTerms(text, env.TOPICS_MAX_TERMS_PER_SOURCE);
    await WordFrequency.deleteMany({ sourceType, sourceId });
    if (counts.size === 0) return 0;

    const periodMonth = istMonthKey(sourceCreatedAt);
    const periodQuarter = istFiscalQuarterKey(sourceCreatedAt);

    await WordFrequency.insertMany(
      [...counts.entries()].map(([term, count]) => ({
        term,
        count,
        sourceType,
        sourceId,
        subsidiaryId,
        periodMonth,
        periodQuarter,
        sourceCreatedAt,
        isDeleted: false,
      })),
    );
    return counts.size;
  } catch (err) {
    logger.error('Failed to index terms', {
      sourceType,
      sourceId: String(sourceId),
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Index one document's chunk text.
 *
 * Chunks are joined with a newline rather than concatenated, so a term ending
 * one chunk and a term starting the next cannot fuse into a token that appears
 * in neither.
 */
export function indexDocumentTerms(
  doc: { _id: Types.ObjectId; subsidiaryId: Types.ObjectId; createdAt: Date },
  chunks: { text: string }[],
): Promise<number> {
  return writeTerms('document', doc._id, doc.subsidiaryId, doc.createdAt, chunks.map((c) => c.text).join('\n'));
}

/**
 * Only the QUESTION text is indexed, never the response.
 *
 * The response is derived from documents already counted, so indexing it would
 * double-weight whatever the retriever happened to surface — a word cloud that
 * amplifies its own retrieval bias.
 */
export function indexQueryTerms(q: {
  _id: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  questionText: string;
  createdAt: Date;
}): Promise<number> {
  return writeTerms('query', q._id, q.subsidiaryId, q.createdAt, q.questionText);
}

/**
 * Drop a source's rows without reindexing — used when the source itself is
 * soft-deleted, so a deleted document stops contributing to §4.3 immediately
 * rather than at the next TTL expiry.
 */
export async function removeTermsForSource(sourceType: TermSourceType, sourceId: Types.ObjectId): Promise<void> {
  await WordFrequency.deleteMany({ sourceType, sourceId }).catch(() => undefined);
}
