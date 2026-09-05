/**
 * Request validation for the query log — PRD §9.2, §9.5, §10.2.
 *
 * Zod runs before any service sees a value, and `strict` object parsing means
 * an unrecognised key is stripped rather than carried into a Mongo filter
 * (§8.3). Every id is checked for ObjectId SHAPE here; whether the caller may
 * reach the resource behind it is a separate, scoped query in the service.
 */
import { z } from 'zod';
import { safeText } from '../../utils/safeText.js';
import { QUERY_STATUSES, QUERY_REVIEW_STATUSES } from './query.model.js';

/** Same literal as document.schema.ts / report.schema.ts. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

/**
 * 2000 characters keeps a maximal body well inside app.ts's global 10kb JSON
 * limit (§9.2), which is enforced by the body parser BEFORE validation runs.
 *
 * There is no `style` field: style is derived from `isParliamentary` in the
 * worker, so the two cannot disagree about what was asked for.
 */
export const createQuerySchema = z.object({
  questionText: safeText({ min: 10, max: 2000, label: 'question' }),
  isParliamentary: z.boolean().default(false),
  /** Optional. Omitted = every subsidiary the caller holds (all, for an admin). */
  subsidiaryId: objectId.optional(),
  /** Narrow retrieval to named, in-scope, VALIDATED documents. */
  documentIds: z.array(objectId).max(25).default([]),
});

export const listQueriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Cursor, not page — the query log is append-heavy (§9.8). */
  cursor: objectId.optional(),
  subsidiaryId: objectId.optional(),
  status: z.enum(QUERY_STATUSES).optional(),
  reviewStatus: z.enum(QUERY_REVIEW_STATUSES).optional(),
  isParliamentary: z.enum(['true', 'false']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  askedBy: objectId.optional(),
  /** Text search over questionText + responseText, inside the scoped query (§8.2). */
  q: z.string().trim().min(2).max(120).optional(),
});

/**
 * `citations` is ABSENT from this schema by construction.
 *
 * A human may write the official response, but may never hand-author a
 * citation — that would defeat §9.5's rule that citations are only ever
 * derived from the chunks actually retrieved. With `strict: true` on the
 * schema, an attempt to send one is stripped by Zod before it reaches a
 * service.
 *
 * officialResponseText is capped at 2000 and reviewNote at 500 so a maximal
 * body fits the global 10kb JSON limit (§9.2). A longer official response
 * belongs in a Report, which carries version history and a publish gate.
 */
export const reviewQuerySchema = z
  .object({
    officialResponseText: safeText({ max: 2000, label: 'official response' }).optional(),
    reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
    reviewNote: safeText({ min: 0, max: 500, label: 'review note' }).optional(),
    linkedReportId: objectId.nullable().optional(),
    isParliamentary: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field must be supplied' });

export const queryIdParamSchema = z.object({ id: objectId });

export type CreateQueryInput = z.infer<typeof createQuerySchema>;
export type ListQueriesQuery = z.infer<typeof listQueriesQuerySchema>;
export type ReviewQueryInput = z.infer<typeof reviewQuerySchema>;
