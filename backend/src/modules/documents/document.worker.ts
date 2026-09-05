/**
 * Document processing pipeline — PRD §4.1, §9.4.
 *
 * queued -> processing -> validated | failed
 *
 * DEPLOYMENT LIMITATION, stated plainly: this is an in-process worker. Jobs
 * live in the Node process, so a restart mid-job leaves a document stuck in
 * `processing`. `recoverStuckDocuments()` below resets those on boot, which is
 * adequate for a single instance but is NOT a substitute for a durable queue.
 * A multi-instance production deployment needs a real queue (BullMQ/Redis or
 * SQS); the seam for that is `enqueueDocument`, which is the only entry point.
 *
 * The processing step itself is idempotent (§9.4): it re-derives chunks and
 * fields from the immutable original, deleting any previous derivations first,
 * so a retry cannot double-insert.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getStorage } from '../../services/storage/index.js';
import { getOcrProvider } from '../../services/ocr/index.js';
import { detectInjection, isSuspected } from '../../services/ai/injection.js';
import { invalidateForSubsidiary } from '../../utils/aggregateCache.js';
import { recordAudit } from '../audit/audit.service.js';
import { indexDocumentTerms } from '../topics/termIndexer.js';
import { TopicCache } from '../topics/topicCache.model.js';
import { AnalyticsCache } from '../analytics/analyticsCache.model.js';
import { DocumentModel } from './document.model.js';
import { DocumentChunk } from './documentChunk.model.js';
import { ExtractedField } from './extractedField.model.js';

const MAX_ATTEMPTS = 3;

/** Tracks in-flight work so tests (and shutdown) can await quiescence. */
const inFlight = new Set<Promise<void>>();

export function enqueueDocument(documentId: string): void {
  const job = processDocument(documentId).catch((err: unknown) => {
    logger.error('Document processing crashed', {
      documentId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
}

/** Await all queued processing — used by tests and graceful shutdown. */
/**
 * Track a deferred follow-up so `drainProcessing()` reaches real quiescence.
 * See the equivalent helper in query.worker.ts for the reasoning.
 */
function trackDeferred(work: Promise<unknown>): void {
  const job = work.then(
    () => undefined,
    (err: unknown) => {
      logger.error('Deferred document follow-up failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    },
  );
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
}

export async function drainProcessing(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}

async function streamToBuffer(documentId: string, storageKey: string): Promise<Buffer> {
  const stream = await getStorage().getStream(storageKey);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part as Buffer));
  logger.debug('Read document from storage', { documentId });
  return Buffer.concat(parts);
}

export async function processDocument(documentId: string): Promise<void> {
  const id = new Types.ObjectId(documentId);

  // Claim the job atomically. If another worker (or a duplicate enqueue) has
  // already moved it out of `queued`, this matches nothing and we stop —
  // which is what makes double-enqueue harmless.
  const claimed = await DocumentModel.findOneAndUpdate(
    { _id: id, status: { $in: ['queued', 'failed'] }, isDeleted: false },
    { $set: { status: 'processing', processingError: undefined }, $inc: { processingAttempts: 1 } },
    { returnDocument: 'after' },
  );

  if (!claimed) return;

  try {
    const buffer = await streamToBuffer(documentId, claimed.storageKey);
    const result = await getOcrProvider().extract({
      buffer,
      mimeType: claimed.mimeType,
      originalFilename: claimed.originalFilename,
    });

    // Idempotency: clear previous derivations before writing new ones, so a
    // retry replaces rather than accumulates. The original file is untouched.
    await Promise.all([
      DocumentChunk.deleteMany({ documentId: id }),
      ExtractedField.deleteMany({ documentId: id, overriddenBy: { $exists: false } }),
    ]);

    if (result.chunks.length > 0) {
      await DocumentChunk.insertMany(
        result.chunks.map((c) => ({
          documentId: id,
          subsidiaryId: claimed.subsidiaryId,
          chunkIndex: c.chunkIndex,
          text: c.text,
          pageNumber: c.pageNumber,
          section: c.section,
          isDeleted: false,
        })),
      );
    }

    if (result.fields.length > 0) {
      await ExtractedField.insertMany(
        result.fields.map((f) => ({
          documentId: id,
          subsidiaryId: claimed.subsidiaryId,
          fieldName: f.fieldName,
          value: f.value,
          confidenceScore: f.confidenceScore,
          sourceLocation: f.sourceLocation,
          isDeleted: false,
        })),
      );
    }

    // §4.1 — flag low-confidence extraction for manual review rather than
    // presenting it as a verified figure.
    const requiresReview =
      result.ocrConfidence <= env.OCR_REVIEW_THRESHOLD || result.fields.length === 0;

    // §9.5 — the earliest point untrusted document text is inside the system, and
    // the point §9.5 means by "silently processed". A hostile document that is
    // never retrieved by any query is still flagged here, and still reaches a human
    // through the EXISTING review queue rather than a parallel workflow.
    //
    // The refs are per-document ordinals (`chunk-0`, `chunk-1`, …) rather than
    // chunk ids: nothing here is handed to a model, and a positional ref keeps
    // the audit metadata free of anything that could identify stored content.
    const injectionFlags = result.chunks.flatMap((c, i) => detectInjection(c.text, `chunk-${i}`));
    const injectionSuspected = isSuspected(injectionFlags);
    const injectionRuleIds = [...new Set(injectionFlags.map((f) => f.ruleId))];

    await DocumentModel.updateOne(
      { _id: id },
      {
        $set: {
          status: 'validated',
          ocrConfidence: result.ocrConfidence,
          // A flagged document is FORCED into the review queue even when the
          // extraction itself was confident. §9.5 asks for flagging, not for
          // refusing to ingest the government's own source material, so the
          // document still validates — it just cannot pass unseen.
          requiresReview: requiresReview || injectionSuspected,
          injectionSuspected,
          injectionRuleIds,
          processedAt: new Date(),
          processingError: undefined,
        },
      },
    );

    // §4.3 — feed the topic corpus. Keyed on the DOCUMENT's createdAt, not the
    // chunk's, so a retry that crosses a month boundary still lands the material in
    // the period it actually belongs to. Idempotent: delete-then-insert by sourceId,
    // exactly as chunks and fields above.
    //
    // Indexed BEFORE the audit purely so the row count can travel in the
    // audit metadata; the call cannot throw (it swallows and returns 0), so
    // it can never turn a successful ingestion into a failure.
    const termsIndexed = await indexDocumentTerms(
      { _id: id, subsidiaryId: claimed.subsidiaryId, createdAt: claimed.createdAt },
      result.chunks,
    );
    // Tracked, not a bare `void`: `drainProcessing()` must not resolve while
    // the cache rows this document invalidates are still being dropped, or a
    // caller that awaited quiescence reads figures that predate the document.
    trackDeferred(invalidateForSubsidiary([TopicCache, AnalyticsCache], claimed.subsidiaryId));

    await recordAudit({
      action: 'document.processed',
      targetType: 'Document',
      targetId: documentId,
      subsidiaryId: String(claimed.subsidiaryId),
      metadata: {
        chunks: result.chunks.length,
        fields: result.fields.length,
        // The value that was actually stored, so the record and the queue
        // cannot disagree about why this document needs a human.
        requiresReview: requiresReview || injectionSuspected,
        injectionSuspected,
        // Rule ids and counts ONLY — never an excerpt of the injected text.
        // An audit log a reviewer reads must not itself carry the payload.
        ruleIds: injectionRuleIds,
        termsIndexed,
        provider: getOcrProvider().name,
      },
    });

    if (injectionSuspected) {
      await recordAudit({
        action: 'document.injection_suspected',
        targetType: 'Document',
        targetId: documentId,
        subsidiaryId: String(claimed.subsidiaryId),
        metadata: { ruleIds: injectionRuleIds, flaggedChunks: injectionFlags.length },
      });
    }
  } catch (err) {
    // §9.4 — a defined failure state and a NON-SENSITIVE reason. The raw error
    // goes to the log; the stored reason is a short, safe summary.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('Document processing failed', { documentId, message: detail });

    const attempts = claimed.processingAttempts;
    await DocumentModel.updateOne(
      { _id: id },
      {
        $set: {
          status: 'failed',
          processingError:
            attempts >= MAX_ATTEMPTS
              ? 'Processing failed repeatedly; manual review required'
              : 'Processing failed; retry available',
          processedAt: new Date(),
        },
      },
    );

    await recordAudit({
      action: 'document.processing_failed',
      targetType: 'Document',
      targetId: documentId,
      subsidiaryId: String(claimed.subsidiaryId),
      metadata: { attempts },
    });
  }
}

export function canRetry(attempts: number): boolean {
  return attempts < MAX_ATTEMPTS;
}

export { MAX_ATTEMPTS };

/**
 * Reset documents stranded in `processing` by a crash or restart. Called on
 * boot — see the durability caveat in the file header.
 */
export async function recoverStuckDocuments(): Promise<number> {
  // Collected BEFORE the update, because after it the rows no longer match the
  // filter and there is nothing left to identify them by.
  const stranded = await DocumentModel.find({ status: 'processing' }).select({ _id: 1 }).lean();

  const res = await DocumentModel.updateMany(
    { status: 'processing' },
    // $unset, not `$set: { processingError: undefined }` — Mongoose strips
    // undefined values out of an update object, so the stale error from the
    // interrupted run would survive a successful reprocess and be served
    // alongside a `validated` document.
    { $set: { status: 'queued' }, $unset: { processingError: '' } },
  );

  // RE-ENQUEUE, or the reset is worse than doing nothing: `enqueueDocument` is
  // called only on upload and on retry, and retry refuses anything that is not
  // `failed`, so a document reset to `queued` and left there could never be
  // processed and could never be retried by its owner.
  for (const row of stranded) enqueueDocument(String(row._id));

  if (res.modifiedCount > 0) {
    logger.warn('Requeued documents left in processing by a previous run', { count: res.modifiedCount });
  }
  return res.modifiedCount;
}
