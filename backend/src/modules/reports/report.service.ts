/**
 * Report drafting and lifecycle — PRD §4.2, §5.5.
 *
 * Lifecycle: draft -> published -> archived (§11.5 decision: single-step,
 * Admin-only publish).
 *
 * Two rules from §4.2 are enforced here rather than left to the UI:
 *   - Nothing publishes automatically. A draft is created from a template and
 *     extracted data, and a human must act to publish it.
 *   - Every edit produces an attributable, timestamped version.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError, ErrorCode } from '../../utils/apiError.js';
import { assertSubsidiaryAccess, isUnscoped, type AuthContext } from '../../utils/authorization.js';
import { invalidateForSubsidiary } from '../../utils/aggregateCache.js';
import { recordAudit } from '../audit/audit.service.js';
import { AnalyticsCache } from '../analytics/analyticsCache.model.js';
import { DocumentModel } from '../documents/document.model.js';
import { ExtractedField } from '../documents/extractedField.model.js';
import { Report, type ReportCitation, type ReportSection } from './report.model.js';
import { ReportTemplate } from './reportTemplate.model.js';
import type {
  CreateReportInput,
  CreateTemplateInput,
  ListReportsQuery,
  UpdateReportInput,
} from './report.schema.js';

export interface ActorMeta {
  ipAddress?: string;
}

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
// Templates
// ─────────────────────────────────────────────────────────────────────────────

export async function listTemplates(user: AuthContext) {
  const filter: Record<string, unknown> = { isDeleted: false };

  // A template scoped to specific subsidiaries is only offered to users who
  // hold one of them; unscoped templates are available to everyone.
  if (!isUnscoped(user.role)) {
    filter.$or = [
      { subsidiaryScope: { $size: 0 } },
      { subsidiaryScope: { $in: user.subsidiaryAccess.map((id) => new Types.ObjectId(id)) } },
    ];
  }

  const rows = await ReportTemplate.find(filter).sort({ name: 1 }).lean();
  return rows.map((t) => ({
    id: String(t._id),
    name: t.name,
    description: t.description ?? null,
    sections: t.sections,
    subsidiaryScope: (t.subsidiaryScope ?? []).map(String),
    version: t.version,
  }));
}

export async function createTemplate(input: CreateTemplateInput, user: AuthContext, meta: ActorMeta) {
  const existing = await ReportTemplate.findOne({ name: input.name, isDeleted: false });
  if (existing) throw ApiError.conflict('A template with that name already exists');

  const template = await ReportTemplate.create({
    name: input.name,
    description: input.description,
    sections: input.sections,
    subsidiaryScope: input.subsidiaryScope.map((id) => new Types.ObjectId(id)),
    version: 1,
  });

  await recordAudit({
    action: 'report_template.created',
    userId: user.id,
    targetType: 'ReportTemplate',
    targetId: String(template._id),
    ipAddress: meta.ipAddress,
  });

  return {
    id: String(template._id),
    name: template.name,
    description: template.description ?? null,
    sections: template.sections,
    subsidiaryScope: template.subsidiaryScope.map(String),
    version: template.version,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafting
// ─────────────────────────────────────────────────────────────────────────────

interface PresentableReport {
  _id: Types.ObjectId;
  title: string;
  templateId: Types.ObjectId;
  subsidiaryId: Types.ObjectId;
  createdBy: Types.ObjectId;
  status: string;
  sections: ReportSection[];
  currentVersion: number;
  sourceDocumentLinks?: Types.ObjectId[];
  citations?: ReportCitation[];
  hasUnreviewedFigures: boolean;
  publishedBy?: Types.ObjectId;
  publishedAt?: Date;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

function presentReport(r: PresentableReport) {
  return {
    id: String(r._id),
    title: r.title,
    templateId: String(r.templateId),
    subsidiaryId: String(r.subsidiaryId),
    createdBy: String(r.createdBy),
    status: r.status,
    sections: r.sections,
    currentVersion: r.currentVersion,
    sourceDocumentLinks: (r.sourceDocumentLinks ?? []).map(String),
    // §8.1 — citations travel as structured metadata, separate from the prose.
    citations: (r.citations ?? []).map((c) => ({
      documentId: String(c.documentId),
      extractedFieldId: c.extractedFieldId ? String(c.extractedFieldId) : null,
      fieldName: c.fieldName ?? null,
      chunkIndex: c.chunkIndex ?? null,
      pageNumber: c.pageNumber ?? null,
      section: c.section ?? null,
      confidenceScore: c.confidenceScore ?? null,
    })),
    hasUnreviewedFigures: r.hasUnreviewedFigures,
    publishedBy: r.publishedBy ? String(r.publishedBy) : null,
    publishedAt: r.publishedAt ?? null,
    archivedAt: r.archivedAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9 _/()-]{1,60}?)\s*\}\}/g;

/**
 * Fill a template section from extracted fields.
 *
 * Every substitution produces a citation pointing at the field it came from,
 * so a figure in a published report is always traceable back to a source
 * document (§8.1). An unmatched placeholder is left visibly unresolved rather
 * than silently blanked — a missing figure must be obvious to the human
 * editor, not invisible.
 */
function draftSection(
  body: string,
  fields: Map<string, { id: string; documentId: string; value: string; confidenceScore: number }>,
  citations: ReportCitation[],
): string {
  return body.replace(PLACEHOLDER, (_match, rawName: string) => {
    const key = rawName.trim().toLowerCase();
    const field = fields.get(key);
    if (!field) return `[[unresolved: ${rawName.trim()}]]`;

    citations.push({
      documentId: new Types.ObjectId(field.documentId),
      extractedFieldId: new Types.ObjectId(field.id),
      fieldName: rawName.trim(),
      confidenceScore: field.confidenceScore,
    });
    return field.value;
  });
}

export async function createReport(input: CreateReportInput, user: AuthContext, meta: ActorMeta) {
  assertSubsidiaryAccess(user, input.subsidiaryId);

  const template = await ReportTemplate.findOne({ _id: input.templateId, isDeleted: false }).lean();
  if (!template) throw ApiError.notFound('Template not found');

  // Source documents must be in scope AND validated — a report cannot cite a
  // document that failed processing (§4.2).
  const docs = await DocumentModel.find({
    _id: { $in: input.sourceDocumentIds.map((id) => new Types.ObjectId(id)) },
    isDeleted: false,
    subsidiaryId: new Types.ObjectId(input.subsidiaryId),
  }).lean();

  if (docs.length !== new Set(input.sourceDocumentIds).size) {
    throw ApiError.notFound('One or more source documents were not found in this subsidiary');
  }

  const unvalidated = docs.filter((d) => d.status !== 'validated');
  if (unvalidated.length > 0) {
    throw ApiError.invalidRequest(
      `All source documents must be validated before drafting (${unvalidated.length} are not)`,
    );
  }

  const extracted = await ExtractedField.find({
    documentId: { $in: docs.map((d) => d._id) },
    isDeleted: false,
  }).lean();

  const fieldMap = new Map(
    extracted.map((f) => [
      f.fieldName.toLowerCase(),
      {
        id: String(f._id),
        documentId: String(f.documentId),
        value: f.value,
        confidenceScore: f.confidenceScore,
      },
    ]),
  );

  const citations: ReportCitation[] = [];
  const sections = template.sections.map((s) => ({
    heading: s.heading,
    body: draftSection(s.body, fieldMap, citations),
  }));

  // Surface low-confidence figures at the report level so a reviewer sees the
  // risk before publishing, not after (§4.1).
  const hasUnreviewedFigures = citations.some(
    (c) => (c.confidenceScore ?? 0) <= env.OCR_REVIEW_THRESHOLD,
  );

  const now = new Date();
  const report = await Report.create({
    title: input.title,
    templateId: template._id,
    subsidiaryId: new Types.ObjectId(input.subsidiaryId),
    createdBy: new Types.ObjectId(user.id),
    status: 'draft',
    sections,
    currentVersion: 1,
    versionHistory: [
      {
        version: 1,
        sections,
        editedBy: new Types.ObjectId(user.id),
        editedAt: now,
        changeSummary: 'Initial draft generated from template',
      },
    ],
    sourceDocumentLinks: docs.map((d) => d._id),
    citations,
    hasUnreviewedFigures,
  });

  await recordAudit({
    action: 'report.created',
    userId: user.id,
    targetType: 'Report',
    targetId: String(report._id),
    subsidiaryId: input.subsidiaryId,
    metadata: { templateId: String(template._id), sourceDocuments: docs.length, hasUnreviewedFigures },
    ipAddress: meta.ipAddress,
  });

  return presentReport(report);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export async function listReports(query: ListReportsQuery, user: AuthContext) {
  const filter: Record<string, unknown> = {
    isDeleted: false,
    ...scopeClause(user, query.subsidiaryId),
  };
  if (query.status) filter.status = query.status;
  if (query.templateId) filter.templateId = new Types.ObjectId(query.templateId);

  const [rows, total] = await Promise.all([
    Report.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Report.countDocuments(filter),
  ]);

  return {
    data: rows.map(presentReport),
    pagination: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    },
  };
}

async function findScoped(reportId: string, user: AuthContext) {
  if (!Types.ObjectId.isValid(reportId)) throw ApiError.notFound('Report not found');

  const report = await Report.findOne({
    _id: new Types.ObjectId(reportId),
    isDeleted: false,
    ...scopeClause(user),
  });

  if (!report) {
    throw ApiError.notFound('Report not found', {
      reason: 'not-found-or-out-of-scope',
      userId: user.id,
      reportId,
    });
  }
  return report;
}

export async function getReport(reportId: string, user: AuthContext) {
  return presentReport(await findScoped(reportId, user));
}

export async function getVersions(reportId: string, user: AuthContext) {
  const report = await findScoped(reportId, user);
  return report.versionHistory
    .map((v) => ({
      version: v.version,
      sections: v.sections,
      editedBy: String(v.editedBy),
      editedAt: v.editedAt,
      changeSummary: v.changeSummary ?? null,
    }))
    .sort((a, b) => b.version - a.version);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function updateReport(
  reportId: string,
  input: UpdateReportInput,
  user: AuthContext,
  meta: ActorMeta,
) {
  const report = await findScoped(reportId, user);

  // A published report is a matter of record. Editing it would change what was
  // published without any trace at the point of publication.
  if (report.status !== 'draft') {
    throw ApiError.invalidRequest(`Only drafts can be edited (current status: ${report.status})`);
  }

  if (input.title) report.title = input.title;

  if (input.sections) {
    report.sections = input.sections;
    report.currentVersion += 1;
    // §4.2 — every edit is attributable and timestamped.
    report.versionHistory.push({
      version: report.currentVersion,
      sections: input.sections,
      editedBy: new Types.ObjectId(user.id),
      editedAt: new Date(),
      changeSummary: input.changeSummary,
    });
  }

  await report.save();

  await recordAudit({
    action: 'report.updated',
    userId: user.id,
    targetType: 'Report',
    targetId: reportId,
    subsidiaryId: String(report.subsidiaryId),
    metadata: { version: report.currentVersion },
    ipAddress: meta.ipAddress,
  });

  return presentReport(report);
}

/** Publish — Admin only, per the §11.5 decision. */
export async function publishReport(reportId: string, user: AuthContext, meta: ActorMeta) {
  const report = await findScoped(reportId, user);

  if (report.status !== 'draft') {
    throw ApiError.invalidRequest(`Only drafts can be published (current status: ${report.status})`);
  }

  report.status = 'published';
  report.publishedBy = new Types.ObjectId(user.id);
  report.publishedAt = new Date();
  await report.save();

  await recordAudit({
    action: 'report.published',
    userId: user.id,
    targetType: 'Report',
    targetId: reportId,
    subsidiaryId: String(report.subsidiaryId),
    // Recorded because publishing a report containing low-confidence figures
    // is exactly the decision an auditor will want to see attributed.
    metadata: { version: report.currentVersion, hasUnreviewedFigures: report.hasUnreviewedFigures },
    ipAddress: meta.ipAddress,
  });

  // Publishing changes the report counts a cached analytics payload reports (§4.6).
  void invalidateForSubsidiary([AnalyticsCache], report.subsidiaryId);

  return presentReport(report);
}

/** Archive — irreversible in effect, so it takes typed confirmation (§8.3). */
export async function archiveReport(
  reportId: string,
  confirm: string,
  user: AuthContext,
  meta: ActorMeta,
) {
  const report = await findScoped(reportId, user);

  if (report.status === 'archived') {
    throw ApiError.invalidRequest('Report is already archived');
  }
  if (confirm !== report.title) {
    throw new ApiError(
      ErrorCode.CONFIRM_TEXT_MISMATCH,
      "To archive this report, provide its exact title in the 'confirm' field",
    );
  }

  report.status = 'archived';
  report.archivedBy = new Types.ObjectId(user.id);
  report.archivedAt = new Date();
  await report.save();

  await recordAudit({
    action: 'report.archived',
    userId: user.id,
    targetType: 'Report',
    targetId: reportId,
    subsidiaryId: String(report.subsidiaryId),
    ipAddress: meta.ipAddress,
  });

  // Archiving changes the report counts a cached analytics payload reports (§4.6).
  void invalidateForSubsidiary([AnalyticsCache], report.subsidiaryId);

  return presentReport(report);
}
