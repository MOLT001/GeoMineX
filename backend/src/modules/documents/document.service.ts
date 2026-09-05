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
import { getStorage, buildStorageKey } from '../../services/storage/index.js';
import { recordAudit } from '../audit/audit.service.js';
import { Subsidiary } from '../subsidiaries/subsidiary.model.js';
import { TopicCache } from '../topics/topicCache.model.js';
import { AnalyticsCache } from '../analytics/analyticsCache.model.js';
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
  if (query.q) filter.$text = { $search: query.q };
  if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

  const rows = await DocumentModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    data: page.map(present),
    pagination: {
      nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1]!._id) : null,
      limit: query.limit,
    },
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
  const fields = await ExtractedField.find({ documentId: doc._id, isDeleted: false })
    .sort({ fieldName: 1 })
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
  void invalidateForSubsidiary([TopicCache, AnalyticsCache], field.subsidiaryId);

  return {
    id: String(field._id),
    fieldName: field.fieldName,
    value: field.value,
    originalValue: field.originalValue,
    overrideReason: field.overrideReason,
    overriddenAt: field.overriddenAt,
  };
}
