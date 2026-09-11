/**
 * Backfill and re-version topic extraction — PRD §4.3; specification §21.
 *
 *   npm run backfill:topics          # only documents that have never been analysed
 *   npm run backfill:topics -- --all # every validated document, whatever its version
 *
 * §21 names four reasons to reprocess a document. Three are automatic — a fresh
 * ingestion, a retry, and an explicit request through
 * `POST /documents/:id/reprocess-topics`. The fourth, "the extraction version
 * changes", has no natural trigger: bumping `EXTRACTION_VERSION` changes what
 * the scorer would say about every document already stored, and nothing
 * re-reads them. This is that trigger.
 *
 * ─── WHAT THE DEFAULT MODE DOES, AND WHY IT IS THE DEFAULT ──────────────────
 * By default it processes only documents whose stored version is missing or
 * stale. That makes the common case — deploying this feature onto an existing
 * corpus — cheap, resumable, and safe to run repeatedly: a second run finds
 * nothing to do. `--all` is for the case where the scorer changed without the
 * version constant changing, which should not happen but is worth being able
 * to recover from without editing the database.
 *
 * ─── THE BASELINE MOVES WHILE THIS RUNS ─────────────────────────────────────
 * Distinctiveness is measured against the subsidiary's corpus, and this run
 * does not change that corpus — `wordFrequencies` is written by the term
 * indexer, not by this script — so the baseline is stable throughout. The
 * per-subsidiary cache is cleared once at the start so a long-lived process
 * does not score against a snapshot taken before `backfill:terms` last ran.
 *
 * Idempotent by the same delete-then-insert contract the worker uses, and
 * batched on ascending `_id` so an interrupted run resumes by re-reading a
 * little rather than skipping documents that shifted position.
 */
import type { QueryFilter, Types } from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { DocumentModel, type DocumentAttrs } from '../modules/documents/document.model.js';
import { DocumentIntelligence } from '../modules/topics/documentIntelligence.model.js';
import { clearCorpusBaselineCache } from '../modules/topics/corpusBaseline.js';
import { EXTRACTION_VERSION } from '../modules/topics/topicExtraction.js';
import { reprocessDocumentTopics } from '../modules/topics/topicIndexer.js';

const BATCH_SIZE = 100;

export interface TopicBackfillResult {
  documentsScanned: number;
  /** Documents that came back with a primary topic. */
  documentsWithTopics: number;
  /** Documents read successfully but too thin or too poor to have a subject. */
  documentsWithoutSubject: number;
  documentsFailed: number;
  skipped: number;
}

export interface TopicBackfillOptions {
  /** Re-extract every validated document, not only the stale ones. */
  all?: boolean;
  batchSize?: number;
}

/**
 * The backfill itself, separated from the CLI wrapper so it can be exercised
 * against a real database — the same split `seed.ts` and the term backfill use.
 *
 * Only `validated`, non-deleted documents are analysed: a queued or failed
 * document has no trustworthy text, and a soft-deleted one must not gain topics
 * that would make it discoverable through a filter.
 */
export async function runTopicBackfill(options: TopicBackfillOptions = {}): Promise<TopicBackfillResult> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  clearCorpusBaselineCache();

  let lastId: Types.ObjectId | null = null;
  const result: TopicBackfillResult = {
    documentsScanned: 0,
    documentsWithTopics: 0,
    documentsWithoutSubject: 0,
    documentsFailed: 0,
    skipped: 0,
  };

  // Read once, up front: the set of already-current documents cannot grow
  // while this runs, because the only writer of a current version is this
  // process. Holding ids is bounded by the corpus and far cheaper than a
  // per-document lookup inside the loop.
  const current = options.all
    ? new Set<string>()
    : new Set(
        (
          await DocumentIntelligence.find({ extractionVersion: EXTRACTION_VERSION, status: { $ne: 'failed' } })
            .select({ documentId: 1 })
            .lean()
        ).map((row) => String(row.documentId)),
      );

  for (;;) {
    const filter: Record<string, unknown> = { status: 'validated', isDeleted: false };
    if (lastId) filter._id = { $gt: lastId };

    const batch = await DocumentModel.find(filter as QueryFilter<DocumentAttrs>)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('_id')
      .lean();

    if (batch.length === 0) break;

    for (const doc of batch) {
      if (current.has(String(doc._id))) {
        result.skipped += 1;
        continue;
      }

      result.documentsScanned += 1;
      try {
        const outcome = await reprocessDocumentTopics(doc._id);
        if (outcome.primaryTopic) result.documentsWithTopics += 1;
        else result.documentsWithoutSubject += 1;
      } catch (err) {
        // One unreadable document must not end the run. It is counted and
        // named, so an operator can look at it rather than discover later that
        // the corpus is silently incomplete.
        result.documentsFailed += 1;
        logger.warn('Topic backfill skipped a document', {
          documentId: String(doc._id),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    lastId = batch[batch.length - 1]!._id;
    logger.info('Topic backfill progress', result);
  }

  return result;
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  await connectDatabase();

  logger.info(`Topic backfill starting (version ${EXTRACTION_VERSION}, mode ${all ? 'all' : 'stale-only'})`);
  const result = await runTopicBackfill({ all });

  logger.info(
    `Topic backfill complete: ${result.documentsWithTopics} document(s) received topics, ` +
      `${result.documentsWithoutSubject} had too little text to have a subject, ` +
      `${result.documentsFailed} failed, ${result.skipped} were already current.`,
  );

  await disconnectDatabase();
}

// Only run the CLI when executed directly, so importing this module in a test
// does not connect to a database or exit the process.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')) {
  main().catch((err: unknown) => {
    logger.error('Topic backfill failed', { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
