import { z } from 'zod';
import { topicListSchema } from '../topics/topics.schema.js';
import { safeText } from '../../utils/safeText.js';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from './document.model.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

export const uploadBodySchema = z.object({
  subsidiaryId: objectId,
  // Optional operator-supplied tags, on top of the automatic ones (§4.1).
  // Multipart sends everything as strings, so a comma-separated list is
  // accepted alongside a repeated field.
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (typeof v === 'string' ? v.split(',') : (v ?? [])))
    .pipe(z.array(z.string().trim().min(1).max(40)).max(10)),
});

export const listDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Cursor pagination — documents are append-heavy (§9.8). */
  cursor: objectId.optional(),
  subsidiaryId: objectId.optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  type: z.enum(DOCUMENT_TYPES).optional(),
  requiresReview: z.enum(['true', 'false']).optional(),
  /**
   * Text search. Matches filename and tags through the document text index, and
   * — since Topic Intelligence — also documents whose extracted TOPICS or
   * KEYWORDS match, which is how a search for `drilling` reaches a report whose
   * filename never says it (§9). Extracted VALUES are still never searched (§8.2).
   */
  q: z.string().trim().min(1).max(120).optional(),
  /** §8 — repeatable: `?topic=drilling&topic=coal-reserves`. */
  topic: topicListSchema.optional(),
  /**
   * How to combine several topics. `all` is the intersection §8 asks for when a
   * user stacks filters; `any` is the union, and is the default because it is
   * the one that cannot surprise someone by returning nothing.
   */
  topicMatch: z.enum(['any', 'all']).default('any'),
});

export const documentIdParamSchema = z.object({ id: objectId });

/** §4.5 — the conflict review queue. */
export const conflictsQuerySchema = z.object({
  subsidiaryId: objectId.optional(),
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** §17 — how many related documents to return. */
export const relatedDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const overrideFieldSchema = z.object({
  value: safeText({ max: 2000, label: 'value' }),
  /** §4.5 — an override is only auditable if the reason is recorded. */
  reason: safeText({ min: 3, max: 500, label: 'reason' }),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type OverrideFieldInput = z.infer<typeof overrideFieldSchema>;
