import { z } from 'zod';
import { REPORT_STATUSES } from './report.model.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  body: z.string().max(50_000),
});

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).optional(),
  sections: z.array(sectionSchema).min(1).max(50),
  subsidiaryScope: z.array(objectId).max(50).default([]),
});

export const createReportSchema = z.object({
  title: z.string().trim().min(1).max(250),
  templateId: objectId,
  subsidiaryId: objectId,
  /**
   * Documents to draft from. Only `validated` documents are accepted — a
   * report must not cite a file that failed processing (§4.2).
   */
  sourceDocumentIds: z.array(objectId).min(1).max(25),
});

export const updateReportSchema = z.object({
  title: z.string().trim().min(1).max(250).optional(),
  sections: z.array(sectionSchema).min(1).max(50).optional(),
  changeSummary: z.string().trim().max(500).optional(),
});

/** Archiving is irreversible in effect, so it takes typed confirmation (§8.3). */
export const archiveReportSchema = z.object({
  confirm: z.string().trim().min(1),
});

export const listReportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(REPORT_STATUSES).optional(),
  subsidiaryId: objectId.optional(),
  templateId: objectId.optional(),
});

export const reportIdParamSchema = z.object({ id: objectId });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type CreateReportInput = z.infer<typeof createReportSchema>;
export type UpdateReportInput = z.infer<typeof updateReportSchema>;
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;
