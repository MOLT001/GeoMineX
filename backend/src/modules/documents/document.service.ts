/**
 * Document ingestion and retrieval — PRD §4.1, §4.5, §9.4.
 *
 * Every read path folds the caller's subsidiary scope into the query itself,
 * so an out-of-scope document is never loaded into memory (§9.1). Out-of-scope
 * reads return 404, never 403.
 */
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { logger } from '../../utils/logger.js';
import { assertSubsidiaryAccess, isUnscoped, type AuthContext } from '../../utils/authorization.js';
import { invalidateForSubsidiary } from '../../utils/aggregateCache.js';
import { MetricsCache } from '../dashboard/metricsCache.model.js';
import { getStorage, buildStorageKey } from '../../services/storage/index.js';
import { recordAudit } from '../audit/audit.service.js';
import { Subsidiary } from '../subsidiaries/subsidiary.model.js';
import { TopicCache } from '../topics/topicCache.model.js';
import { AnalyticsCache } from '../analytics/analyticsCache.model.js';
import { resolveScope, scopeMatch } from '../../utils/scopeKey.js';
import { DocumentConflict, type ConflictStatus } from './documentConflict.model.js';
import { DocumentIntelligence } from '../topics/documentIntelligence.model.js';
import {
  assertKnownTopicIds,
  getDocumentIntelligence,
  getRelatedDocuments,
  resolveSearchTopicDocuments,
  resolveTopicFilter,
} from '../topics/topicIntelligence.service.js';
import { reprocessDocumentTopics } from '../topics/topicIndexer.js';
import { DocumentModel } from './document.model.js';
import { DocumentChunk } from './documentChunk.model.js';
import { ExtractedField } from './extractedField.model.js';
import { validateUpload } from './fileValidation.js';
import { enqueueDocument, canRetry } from './document.worker.js';
import type { ListDocumentsQuery, OverrideFieldInput } from './document.schema.js';

export interface ActorMeta {
  ipAddress?: string;
}

interface PresentableDocument {
  _id: unknown;
  subsidiaryId: unknown;
  uploadedBy: unknown;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  type: string;
  status: string;
  ocrConfidence?: number;
  requiresReview: boolean;
  /** Optional because `lean()` returns it as `undefined` on pre-§9.5 rows. */
  injectionSuspected?: boolean;
  tags?: string[];
  processingError?: string;
  processingAttempts: number;
  processedAt?: Date;
  createdAt: Date;
}

function present(doc: PresentableDocument) {
  return {
    id: String(doc._id),
    subsidiaryId: String(doc.subsidiaryId),
    uploadedBy: String(doc.uploadedBy),
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    type: doc.type,
    status: doc.status,
    ocrConfidence: doc.ocrConfidence ?? null,
    requiresReview: doc.requiresReview,
    // §9.5 — the FLAG travels to the client so a reviewer knows why the
    // document is in the queue. `injectionRuleIds` deliberately does not:
    // publishing which patterns fired tells an author which ones to avoid.
    injectionSuspected: doc.injectionSuspected ?? false,
    tags: doc.tags ?? [],
    processingError: doc.processingError ?? null,
    processingAttempts: doc.processingAttempts,
    processedAt: doc.processedAt ?? null,
    createdAt: doc.createdAt,
    // storageKey is deliberately NOT exposed: a client must never be able to
    // construct or guess a storage path (§9.4).
  };
}

/** Scope clause folded into every document query (§9.1). */
function scopeClause(user: AuthContext, requested?: string): Record<string, unknown> {
  if (isUnscoped(user.role)) {
    return requested ? { subsidiaryId: new Types.ObjectId(requested) } : {};
  }
  if (requested) {
    assertSubsidiaryAccess(user, requested);
    return { subsidiaryId: new Types.ObjectId(requested) };
  }
  return { subsidiaryId: { $in: user.subsidiaryAccess.map((id) => new Types.ObjectId(id)) } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadDocument(
  file: { buffer: Buffer; originalname: string; mimetype: string },
  input: { subsidiaryId: string; tags: string[] },
  user: AuthContext,
  meta: ActorMeta,
) {
  // Authorization first — never write to storage for a subsidiary the caller
  // has no grant for.
  assertSubsidiaryAccess(user, input.subsidiaryId);

  const subsidiary = await Subsidiary.findOne({ _id: input.subsidiaryId, isDeleted: false }).lean();
  if (!subsidiary) throw ApiError.notFound('Subsidiary not found');

  const validated = await validateUpload(file.buffer, file.originalname, file.mimetype);

  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storageKey = buildStorageKey(input.subsidiaryId, file.originalname);

  await getStorage().put(storageKey, file.buffer);

  // §4.1 auto-tagging: subsidiary, date and type, plus any operator tags.
  const now = new Date();
  const autoTags = [
    subsidiary.code,
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    validated.documentType,
  ];
  const tags = [...new Set([...autoTags, ...input.tags])];

  try {
    const doc = await DocumentModel.create({
      subsidiaryId: new Types.ObjectId(input.subsidiaryId),
      uploadedBy: new Types.ObjectId(user.id),
      originalFilename: file.originalname.slice(0, 255),
      mimeType: validated.resolvedMimeType,
      sizeBytes: file.buffer.byteLength,
      type: validated.documentType,
      status: 'queued',
      storageKey,
      checksum,
      tags,
      requiresReview: false,
      processingAttempts: 0,
    });

    await recordAudit({
      action: 'document.uploaded',
      userId: user.id,
      targetType: 'Document',
      targetId: String(doc._id),
      subsidiaryId: input.subsidiaryId,
      metadata: { type: validated.documentType, sizeBytes: file.buffer.byteLength },
      ipAddress: meta.ipAddress,
    });

    enqueueDocument(String(doc._id));
    logger.info('Document queued for processing', { documentId: String(doc._id) });

    /**
     * `documentsTotal` has already changed, so the landing figures are stale
     * the moment this row exists — before the worker has touched it. Only the
     * metrics cache: the topic and analytics views are computed from
     * `validated` documents and a queued one changes neither.
     */
    void invalidateForSubsidiary([MetricsCache], doc.subsidiaryId);

    return present(doc);
  } catch (err) {
    // Do not leave an orphaned object behind if the metadata write fails.
    await getStorage().delete(storageKey);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List documents — PRD §4.1, §4.5.
 *
 * The parameter widens the validated query type with `injectionSuspected`: the
 * §9.5 filter belongs here alongside every other document filter, and the
 * widening stays source-compatible with `listDocumentsQuerySchema`'s inferred
 * type, so the key can be admitted by the schema without a second edit here.
 */
export async function listDocuments(
  query: ListDocumentsQuery & { injectionSuspected?: 'true' | 'false' },
  user: AuthContext,
) {
  const filter: Record<string, unknown> = {
    isDeleted: false,
    ...scopeClause(user, query.subsidiaryId),
  };

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.requiresReview) filter.requiresReview = query.requiresReview === 'true';
  // §9.5 — "documents that tried to give the model instructions" is a
  // different queue from "documents the OCR was unsure about", and a reviewer
  // triaging the first should not have to wade through the second.
  if (query.injectionSuspected) filter.injectionSuspected = query.injectionSuspected === 'true';

  // Scope is resolved once and reused by both topic paths below. It re-runs the
  // same grant check `scopeClause` already made, which is deliberate: neither
  // helper may depend on the other having been called.
  const scope = resolveScope(user, query.subsidiaryId);
  let topicsTruncated = false;

  // ── §8: filter by topic ──────────────────────────────────────────────────
  if (query.topic && query.topic.length > 0) {
    assertKnownTopicIds(query.topic);
    const resolved = await resolveTopicFilter(query.topic, query.topicMatch === 'all', scope);
    topicsTruncated = resolved.truncated;
    // No matches means an empty page, not an unfiltered one. Leaving `$in: []`
    // to the database would work, but returning early makes it impossible for a
    // later edit to drop the clause and quietly serve the whole corpus.
    if (resolved.documentIds.length === 0) {
      return { data: [], pagination: { nextCursor: null, limit: query.limit }, topicsTruncated };
    }
    filter._id = { $in: resolved.documentIds };
  }

  // ── §9: search considers topics and keywords, not just the filename ──────
  let topicMatchIds = new Set<string>();
  let searchTerms: string[] = [];

  if (query.q) {
    searchTerms = query.q
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
      .slice(0, 6);

    const viaTopics = searchTerms.length ? await resolveSearchTopicDocuments(searchTerms, scope) : [];
    topicMatchIds = new Set(viaTopics.map(String));

    if (viaTopics.length > 0) {
      /**
       * `$text` inside `$or` is legal only when every other clause is indexed,
       * which `_id` always is. That constraint is why this widens through `_id`
       * rather than through a second text predicate.
       *
       * The ORDER of results is deliberately unchanged — still newest-first,
       * still cursor-paginated. Re-ranking by relevance would mean abandoning
       * the cursor contract this endpoint publishes (§9.8), and the win §9 is
       * really asking for is that the right documents are IN the set at all:
       * a report called "Annual Geological Investigation" now answers a search
       * for `drilling`. `matchedVia` tells the client why each row is here.
       */
      filter.$or = [{ $text: { $search: query.q } }, { _id: { $in: viaTopics } }];
    } else {
      filter.$text = { $search: query.q };
    }
  }

  if (query.cursor) {
    // Merged, not assigned: a topic filter may already have put an `$in` here,
    // and overwriting it would silently drop the filter on page two.
    filter._id = { ...(filter._id ?? {}), $lt: new Types.ObjectId(query.cursor) };
  }

  const rows = await DocumentModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  // One lookup for the whole page: the list shows each document's leading
  // topic, which is the difference between a filename list and a catalogue.
  const intelligence = page.length
    ? await DocumentIntelligence.find({ documentId: { $in: page.map((d) => d._id) } })
        .select({ documentId: 1, primaryTopicId: 1, primaryTopicLabel: 1, status: 1, confidence: 1 })
        .lean()
    : [];
  const intelligenceById = new Map(intelligence.map((i) => [String(i.documentId), i]));

  return {
    data: page.map((doc) => {
      const info = intelligenceById.get(String(doc._id));
      return {
        ...present(doc),
        primaryTopic: info?.primaryTopicId
          ? { topicId: info.primaryTopicId, label: info.primaryTopicLabel ?? info.primaryTopicId }
          : null,
        topicStatus: info?.status ?? 'pending',
        ...(query.q
          ? {
              matchedVia: [
                ...(searchTerms.some((t) => doc.originalFilename.toLowerCase().includes(t)) ? ['filename'] : []),
                ...(topicMatchIds.has(String(doc._id)) ? ['topic'] : []),
              ],
            }
          : {}),
      };
    }),
    pagination: {
      nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1]!._id) : null,
      limit: query.limit,
    },
    /** True when a topic filter matched more documents than it would resolve. */
    topicsTruncated,
  };
}

/** Fetch a document within scope, or 404. Shared by every by-id path. */
async function findScoped(documentId: string, user: AuthContext) {
  if (!Types.ObjectId.isValid(documentId)) throw ApiError.notFound('Document not found');

  const doc = await DocumentModel.findOne({
    _id: new Types.ObjectId(documentId),
    isDeleted: false,
    ...scopeClause(user),
  });

  if (!doc) {
    throw ApiError.notFound('Document not found', {
      reason: 'not-found-or-out-of-scope',
      userId: user.id,
      documentId,
    });
  }
  return doc;
}

export async function getDocument(documentId: string, user: AuthContext) {
  return present(await findScoped(documentId, user));
}

/**
 * Stream the original file — PRD §5.8, §9.4.
 *
 * The most security-sensitive route in the system: it returns the raw
 * government source document. Authorization is re-checked on every request,
 * the bytes are streamed through the API, and no durable or public storage URL
 * is ever issued.
 */
export async function streamDocumentFile(
  documentId: string,
  user: AuthContext,
  meta: ActorMeta,
): Promise<{ stream: Readable; filename: string; mimeType: string; sizeBytes: number }> {
  const doc = await findScoped(documentId, user);
  const stream = await getStorage().getStream(doc.storageKey);

  await recordAudit({
    action: 'document.downloaded',
    userId: user.id,
    targetType: 'Document',
    targetId: documentId,
    subsidiaryId: String(doc.subsidiaryId),
    ipAddress: meta.ipAddress,
  });

  return {
    stream,
    filename: doc.originalFilename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
  };
}

export async function getDocumentChunks(documentId: string, user: AuthContext) {
  const doc = await findScoped(documentId, user);
  const chunks = await DocumentChunk.find({ documentId: doc._id, isDeleted: false })
    .sort({ chunkIndex: 1 })
    .lean();

  return chunks.map((c) => ({
    id: String(c._id),
    chunkIndex: c.chunkIndex,
    text: c.text,
    pageNumber: c.pageNumber ?? null,
    section: c.section ?? null,
  }));
}

export async function getExtractedFields(documentId: string, user: AuthContext) {
  const doc = await findScoped(documentId, user);
  /**
   * DOCUMENT order, not alphabetical.
   *
   * `_id` is monotonic, so this is insertion order, which for the extractor is
   * reading order down the page. That matters for a table: a results statement
   * argues from revenue to total income to expenses to profit, and sorting by
   * name scatters that into an alphabetical list where `Changes in inventories`
   * leads and revenue sits under R between two unrelated rows. It also keeps the
   * four figures of one measure adjacent, which is what lets the document view
   * lay them back out as the columns the filing prints.
   */
  const fields = await ExtractedField.find({ documentId: doc._id, isDeleted: false })
    .sort({ _id: 1 })
    .lean();

  return fields.map((f) => ({
    id: String(f._id),
    documentId: String(f.documentId),
    fieldName: f.fieldName,
    value: f.value,
    confidenceScore: f.confidenceScore,
    // At or below the threshold this figure must not be treated as verified (§4.1).
    requiresReview: f.confidenceScore <= env.OCR_REVIEW_THRESHOLD,
    sourceLocation: f.sourceLocation ?? null,
    overriddenBy: f.overriddenBy ? String(f.overriddenBy) : null,
    overrideReason: f.overrideReason ?? null,
    overriddenAt: f.overriddenAt ?? null,
    originalValue: f.originalValue ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export async function retryDocument(documentId: string, user: AuthContext, meta: ActorMeta) {
  const doc = await findScoped(documentId, user);

  if (doc.status !== 'failed') {
    throw ApiError.invalidRequest(`Only failed documents can be retried (current status: ${doc.status})`);
  }
  if (!canRetry(doc.processingAttempts)) {
    throw ApiError.invalidRequest('Retry limit reached; this document needs manual review');
  }

  await recordAudit({
    action: 'document.retried',
    userId: user.id,
    targetType: 'Document',
    targetId: documentId,
    subsidiaryId: String(doc.subsidiaryId),
    ipAddress: meta.ipAddress,
  });

  enqueueDocument(documentId);
  return { ...present(doc), status: 'queued' };
}

/**
 * Manually override an extracted value — PRD §4.5.
 *
 * The original machine-produced value is preserved and a reason is mandatory,
 * so the change is attributable and reversible in the record. Overrides also
 * drive the extraction-accuracy metric (§4.6): an overridden field is one the
 * extraction got wrong.
 */
export async function overrideExtractedField(
  fieldId: string,
  input: OverrideFieldInput,
  user: AuthContext,
  meta: ActorMeta,
) {
  if (!Types.ObjectId.isValid(fieldId)) throw ApiError.notFound('Field not found');

  const field = await ExtractedField.findOne({
    _id: new Types.ObjectId(fieldId),
    isDeleted: false,
    ...scopeClause(user),
  });

  if (!field) {
    throw ApiError.notFound('Field not found', {
      reason: 'not-found-or-out-of-scope',
      userId: user.id,
      fieldId,
    });
  }

  // Keep the first machine-produced value, not the previous override.
  field.originalValue ??= field.value;
  field.value = input.value;
  field.overriddenBy = new Types.ObjectId(user.id);
  field.overrideReason = input.reason;
  field.overriddenAt = new Date();
  await field.save();

  await recordAudit({
    action: 'extracted_field.overridden',
    userId: user.id,
    targetType: 'ExtractedField',
    targetId: fieldId,
    subsidiaryId: String(field.subsidiaryId),
    // The reason is operational context. The value itself is NOT logged — it
    // may be a sensitive operational figure (§9.6).
    metadata: { fieldName: field.fieldName, reason: input.reason },
    ipAddress: meta.ipAddress,
  });

  // An override changes the extraction-accuracy figure, so a series computed
  // under the old value must go (§4.6).
  void invalidateForSubsidiary([TopicCache, AnalyticsCache, MetricsCache], field.subsidiaryId);

  return {
    id: String(field._id),
    fieldName: field.fieldName,
    value: field.value,
    originalValue: field.originalValue,
    overrideReason: field.overrideReason,
    overriddenAt: field.overriddenAt,
  };
}

// ── Topic Intelligence, per document ───────────────────────────────────────

/**
 * §12/§19 — one document's topics, keywords, technical terms and summary.
 *
 * Access is proved by `findScoped` before anything else is read, so the
 * intelligence collections are never queried on behalf of a caller who cannot
 * see the document they describe.
 */
export async function getDocumentTopics(documentId: string, user: AuthContext) {
  const doc = await findScoped(documentId, user);
  return getDocumentIntelligence(doc._id);
}

/**
 * §17 — historical documents that share this one's subjects.
 *
 * Scoped twice over: `findScoped` proves the caller may see the SOURCE
 * document, and the scope resolved from the caller's own grants filters the
 * candidates. The source document's subsidiary is deliberately not used to
 * widen that — a document a user can read must not become a lens onto a
 * subsidiary they cannot.
 */
export async function listRelatedDocuments(documentId: string, user: AuthContext, limit: number) {
  const doc = await findScoped(documentId, user);
  const related = await getRelatedDocuments(doc._id, resolveScope(user), limit);
  return { documentId: String(doc._id), related };
}

/**
 * §19/§21 — re-run topic extraction for one document, on request.
 *
 * The other three reasons to reprocess (§21) are automatic: a fresh ingestion,
 * a retry, and a version bump handled by the backfill script. This is the
 * manual one, for a document whose analysis a reviewer disagrees with — so it
 * is restricted to the roles that may already correct extracted figures, and it
 * is audited like any other correction.
 *
 * It does NOT re-read the file or re-run OCR. `POST /documents/:id/retry` is
 * the action for that, and conflating them would let a cheap request schedule
 * an expensive one.
 */
export async function reprocessTopics(documentId: string, user: AuthContext, meta: ActorMeta) {
  const doc = await findScoped(documentId, user);

  if (doc.status !== 'validated') {
    throw ApiError.invalidRequest('Topics can only be re-extracted from a document that has been processed');
  }

  const outcome = await reprocessDocumentTopics(doc._id);

  await recordAudit({
    action: 'document.topics_reprocessed',
    userId: user.id,
    targetType: 'Document',
    targetId: documentId,
    subsidiaryId: String(doc.subsidiaryId),
    // Counts and a label — the same discipline the ingestion audit follows.
    metadata: {
      status: outcome.status,
      topicsExtracted: outcome.topicCount,
      primaryTopic: outcome.primaryTopic,
    },
    ipAddress: meta.ipAddress,
  });

  // The catalogue, the analytics panel and the word cloud were all computed
  // over the topics this call just replaced.
  void invalidateForSubsidiary([TopicCache, AnalyticsCache], doc.subsidiaryId);

  return { ...outcome, ...(await getDocumentIntelligence(doc._id)) };
}

// ── Conflicting figures across documents (§4.5) ────────────────────────────

/**
 * The conflict review queue, widest disagreement first.
 *
 * Scoped like every other read: the caller sees only conflicts inside the
 * subsidiaries they hold, and a conflict is a property of one subsidiary by
 * construction — the detector never compares across them.
 */
export async function listConflicts(
  query: { subsidiaryId?: string; status?: ConflictStatus; limit: number },
  user: AuthContext,
) {
  const scope = resolveScope(user, query.subsidiaryId);

  const rows = await DocumentConflict.find(
    scopeMatch(scope, { status: query.status ?? 'open', isDeleted: false }),
  )
    .sort({ spread: -1, detectedAt: -1 })
    .limit(query.limit)
    .lean();

  return {
    conflicts: rows.map((c) => ({
      id: String(c._id),
      subsidiaryId: String(c.subsidiaryId),
      metric: c.metricLabel,
      status: c.status,
      // The absolute gap, so a reviewer can triage by how much is at stake.
      spread: c.spread,
      detectedAt: c.detectedAt.toISOString(),
      readings: c.readings.map((r) => ({
        documentId: String(r.documentId),
        originalFilename: r.originalFilename,
        value: r.value,
        section: r.section ?? null,
        documentDate: r.documentCreatedAt.toISOString(),
      })),
    })),
  };
}
