/**
 * One-off backfill of `wordFrequencies` for the Phase 1 corpus — PRD §4.3.
 *
 * RUN THIS ONCE AFTER DEPLOY:
 *
 *   npx tsx src/scripts/backfillTermFrequencies.ts
 *
 * Term rows are materialised at write time (see termIndexer.ts), so documents
 * ingested before Phase 2 have none. Until this has run, GET /topics reports an
 * honestly EMPTY cloud for the historic corpus rather than a wrong one: no
 * existing collection gained a required field, so there is no partially
 * migrated state that produces quietly incorrect numbers — only a smaller
 * corpus that grows as the backfill progresses.
 *
 * Idempotent by the same delete-then-insert contract document.worker.ts uses,
 * so re-running it is safe and never double-counts. Batches are keyed on
 * ascending `_id` rather than an offset, so an interrupted run resumes by
 * re-reading a little rather than skipping documents that shifted position.
 */
import type { QueryFilter, Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { DocumentModel, type DocumentAttrs } from '../modules/documents/document.model.js';
import { DocumentChunk } from '../modules/documents/documentChunk.model.js';
import { indexDocumentTerms } from '../modules/topics/termIndexer.js';

/** Small enough that one batch's chunks never dominate memory, large enough to be one trip. */
const BATCH_SIZE = 100;

export interface BackfillResult {
  documentsScanned: number;
  /** Documents that produced at least one term row. */
  documentsIndexed: number;
  termsWritten: number;
}

/**
 * The backfill itself, separated from the CLI wrapper so it can be tested
 * against a real database rather than only exercised by hand — the same split
 * seed.ts uses.
 *
 * Assumes an open connection. Only `validated`, non-deleted documents are
 * indexed: a queued or failed document has no trustworthy text, and a
 * soft-deleted one must not contribute to §4.3 at all.
 */
export async function runTermBackfill(batchSize = BATCH_SIZE): Promise<BackfillResult> {
  let lastId: Types.ObjectId | null = null;
  let documentsScanned = 0;
  let documentsIndexed = 0;
  let termsWritten = 0;

  for (;;) {
    const filter: Record<string, unknown> = { status: 'validated', isDeleted: false };
    if (lastId) filter._id = { $gt: lastId };

    const batch = await DocumentModel.find(filter as QueryFilter<DocumentAttrs>)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('_id subsidiaryId createdAt')
      .lean();

    if (batch.length === 0) break;

    for (const doc of batch) {
      // Chunk order matters: termIndexer joins them, and a stable order keeps a
      // re-run byte-identical to the first one.
      const chunks = await DocumentChunk.find({ documentId: doc._id, isDeleted: false })
        .sort({ chunkIndex: 1 })
        .select('text')
        .lean();

      const written = await indexDocumentTerms(
        { _id: doc._id, subsidiaryId: doc.subsidiaryId, createdAt: doc.createdAt },
        chunks,
      );

      documentsScanned += 1;
      if (written > 0) documentsIndexed += 1;
      termsWritten += written;
    }

    lastId = batch[batch.length - 1]!._id;

    // A running count, so an operator watching a long backfill can see it move
    // rather than guess whether it has stalled.
    logger.info('Term backfill progress', { documentsScanned, documentsIndexed, termsWritten });
  }

  return { documentsScanned, documentsIndexed, termsWritten };
}

async function main(): Promise<void> {
  await connectDatabase();
  const result = await runTermBackfill();

  logger.info(
    `Term backfill complete: indexed ${result.documentsIndexed} of ${result.documentsScanned} validated document(s), ${result.termsWritten} term row(s) written. GET /api/v1/topics now covers the historic corpus.`,
  );

  await disconnectDatabase();
}

// Only run the CLI when executed directly, so importing this module in a test
// does not connect to a database or exit the process.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')) {
  main().catch((err: unknown) => {
    logger.error('Term backfill failed', { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
