import { z } from 'zod';
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
  /** Text search over filename/tags only — never over extracted values (§8.2). */
  q: z.string().trim().min(1).max(120).optional(),
});

export const documentIdParamSchema = z.object({ id: objectId });

export const overrideFieldSchema = z.object({
  value: z.string().trim().min(1).max(2000),
  /** §4.5 — an override is only auditable if the reason is recorded. */
  reason: z.string().trim().min(3).max(500),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
export type OverrideFieldInput = z.infer<typeof overrideFieldSchema>;
