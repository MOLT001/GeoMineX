/**
 * Dashboard — PRD §5.3, §4.6.
 *
 * The three §4.6 metric definitions are NOT restated here. They live once, as
 * pure functions, in `../analytics/metricFormulas.js`, and this file imports
 * them (D11). Restating them in a header comment is exactly how the §5.3
 * landing card and the §4.6 analytics chart come to report different accuracy
 * for the same period.
 *
 * The one thing this surface decides for itself is what to do with no
 * evidence. Every formula returns `null` for the empty case; a SNAPSHOT sits
 * beside visible counts that make a 0 unambiguous, so it coerces `?? 0` at its
 * own call site, while the §4.6 SERIES passes the null through (D13).
 *
 * Every figure is computed with an aggregation pipeline, cached with a TTL,
 * scoped to the caller's subsidiaries, and returned with `computedAt` so the
 * client can show how fresh it is (§4.6).
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import type { AuthContext } from '../../utils/authorization.js';
import { logger } from '../../utils/logger.js';
import {
  cacheKeyOf,
  metricAssumptionsFingerprint,
  resolveScope,
  PAYLOAD_VERSION,
} from '../../utils/scopeKey.js';
import {
  automationCoveragePercent,
  extractionAccuracyPercent,
  timeSavedPercent,
} from '../analytics/metricFormulas.js';
import { DocumentModel } from '../documents/document.model.js';
import { ExtractedField } from '../documents/extractedField.model.js';
import { QueryModel } from '../queries/query.model.js';
import { scopeContainmentClause } from '../queries/query.service.js';
import { Report } from '../reports/report.model.js';
import { MetricsCache } from './metricsCache.model.js';

export interface DashboardMetrics {
  extractionAccuracyPercent: number;
  automationCoveragePercent: number;
  timeSavedPercent: number;
  documentsTotal: number;
  documentsValidated: number;
  documentsFailed: number;
  documentsAwaitingReview: number;
  /** §5.3 — "Pending Queries needing response/review", as a count. */
  queriesPendingReview: number;
  computedAt: Date;
  /** True when served from cache rather than recomputed on this request. */
  cached: boolean;
}

function matchStage(subsidiaryIds: Types.ObjectId[] | null): Record<string, unknown> {
  const base: Record<string, unknown> = { isDeleted: false };
  if (subsidiaryIds) base.subsidiaryId = { $in: subsidiaryIds };
  return base;
}

/**
 * `user` is taken alongside the resolved ids because the two collections are
 * authorized differently and neither clause can stand in for the other:
 * documents and fields carry a top-level `subsidiaryId`, while a query is
 * authorized by CONTAINMENT over `contextScope.subsidiaryIds` (D3) — a query
 * answered over {A,B} must not be counted for a user granted only A, since its
 * prose may carry B's figures.
 */
async function computeMetrics(
  subsidiaryIds: Types.ObjectId[] | null,
  user: AuthContext,
): Promise<Omit<DashboardMetrics, 'cached'>> {
  const match = matchStage(subsidiaryIds);

  // Document counts by status — one pass, in the database (§4.6).
  const [docAgg] = await DocumentModel.aggregate<{
    total: number;
    validated: number;
    failed: number;
    awaitingReview: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        validated: { $sum: { $cond: [{ $eq: ['$status', 'validated'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        awaitingReview: {
          $sum: { $cond: [{ $and: [{ $eq: ['$status', 'validated'] }, '$requiresReview'] }, 1, 0] },
        },
      },
    },
    { $project: { _id: 0, total: 1, validated: 1, failed: 1, awaitingReview: 1 } },
  ]);

  const docs = docAgg ?? { total: 0, validated: 0, failed: 0, awaitingReview: 0 };

  // Field-level accuracy, plus how many distinct documents needed correction.
  const [fieldAgg] = await ExtractedField.aggregate<{
    totalFields: number;
    overriddenFields: number;
    correctedDocuments: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        totalFields: { $sum: 1 },
        overriddenFields: { $sum: { $cond: [{ $ifNull: ['$overriddenBy', false] }, 1, 0] } },
        correctedDocs: {
          $addToSet: { $cond: [{ $ifNull: ['$overriddenBy', false] }, '$documentId', '$$REMOVE'] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        totalFields: 1,
        overriddenFields: 1,
        correctedDocuments: { $size: '$correctedDocs' },
      },
    },
  ]);

  const fields = fieldAgg ?? { totalFields: 0, overriddenFields: 0, correctedDocuments: 0 };

  /**
   * Only `reviewStatus: 'pending'` — the HUMAN backlog. A `failed` or
   * `dead_lettered` query is an operational fault, not a review, and it is
   * counted separately by `getPendingWork` below; folding the two into one
   * figure would make "six answers need approval" indistinguishable from "six
   * generations broke".
   */
  const pendingReviewFilter: Record<string, unknown> = {
    isDeleted: false,
    ...scopeContainmentClause(user),
    reviewStatus: 'pending',
  };
  const queriesPendingReview = await QueryModel.countDocuments(pendingReviewFilter);

  return {
    // With no extractions yet there is no evidence either way. Reporting 100%
    // would be a fabricated success, so report 0 and let the counts explain it.
    // The series path keeps the null (D13).
    extractionAccuracyPercent:
      extractionAccuracyPercent(fields.totalFields, fields.overriddenFields) ?? 0,
    automationCoveragePercent:
      automationCoveragePercent(docs.validated, fields.correctedDocuments, docs.awaitingReview) ?? 0,
    timeSavedPercent: timeSavedPercent(docs.total, fields.overriddenFields) ?? 0,
    documentsTotal: docs.total,
    documentsValidated: docs.validated,
    documentsFailed: docs.failed,
    documentsAwaitingReview: docs.awaitingReview,
    queriesPendingReview,
    computedAt: new Date(),
  };
}

export async function getMetrics(user: AuthContext): Promise<DashboardMetrics> {
  const scope = resolveScope(user);

  /**
   * The key folds in the payload version AND the assumption fingerprint, not
   * just the scope. Retuning `BASELINE_MANUAL_MINUTES_PER_DOC` previously
   * served figures computed under the old assumption for a full TTL; now it
   * changes the key. Hashing also bounds a `scopeKey` that was an unbounded
   * comma-joined grant list sitting on a unique index (§10.10, D12).
   */
  const key = cacheKeyOf(['dashboard', PAYLOAD_VERSION, metricAssumptionsFingerprint(), scope.key]);

  const cached = await MetricsCache.findOne({ scopeKey: key, expiresAt: { $gt: new Date() } }).lean();
  if (cached) {
    return {
      extractionAccuracyPercent: cached.extractionAccuracyPercent,
      automationCoveragePercent: cached.automationCoveragePercent,
      timeSavedPercent: cached.timeSavedPercent,
      documentsTotal: cached.documentsTotal,
      documentsValidated: cached.documentsValidated,
      documentsFailed: cached.documentsFailed,
      documentsAwaitingReview: cached.documentsAwaitingReview,
      // A row written by the previous deploy has no such field; it must read
      // back as 0, not as `undefined` rendered into a card.
      queriesPendingReview: cached.queriesPendingReview ?? 0,
      computedAt: cached.computedAt,
      cached: true,
    };
  }

  const fresh = await computeMetrics(scope.subsidiaryIds, user);

  await MetricsCache.updateOne(
    { scopeKey: key },
    {
      $set: {
        ...fresh,
        scopeKey: key,
        expiresAt: new Date(Date.now() + env.METRICS_CACHE_TTL_SECONDS * 1000),
      },
    },
    { upsert: true },
  ).catch((err: unknown) => {
    // A cache write failure must not fail the dashboard.
    logger.warn('Failed to write metrics cache', {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return { ...fresh, cached: false };
}

/** §5.3 — recent reports, scoped to the caller's access. */
export async function getRecentReports(user: AuthContext, limit = 5) {
  const { subsidiaryIds } = resolveScope(user);
  const filter: Record<string, unknown> = { isDeleted: false };
  if (subsidiaryIds) filter.subsidiaryId = { $in: subsidiaryIds };

  const rows = await Report.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();

  return rows.map((r) => ({
    id: String(r._id),
    title: r.title,
    status: r.status,
    subsidiaryId: String(r.subsidiaryId),
    currentVersion: r.currentVersion,
    hasUnreviewedFigures: r.hasUnreviewedFigures,
    updatedAt: r.updatedAt,
  }));
}

/**
 * §5.3's pending-work panel: documents awaiting manual review or a failed
 * ingestion, UNIONED with queries needing attention.
 *
 * The two halves are authorized by different rules and that is deliberate.
 * Documents use the caller's grant list on a top-level `subsidiaryId`; queries
 * use `scopeContainmentClause` IMPORTED from query.service.ts and never
 * re-derived here (D3) — a second copy of that clause is exactly how the
 * containment half comes to be dropped in one place and not the other.
 *
 * Each row carries a `kind` discriminator so the panel can route the click,
 * and both halves sort by `createdAt` descending before the limit is applied,
 * so a busy document queue cannot hide every pending query or vice versa.
 */
export async function getPendingWork(user: AuthContext, limit = 5) {
  const { subsidiaryIds } = resolveScope(user);

  const documentFilter: Record<string, unknown> = {
    isDeleted: false,
    $or: [{ requiresReview: true, status: 'validated' }, { status: 'failed' }],
  };
  if (subsidiaryIds) documentFilter.subsidiaryId = { $in: subsidiaryIds };

  const queryFilter: Record<string, unknown> = {
    isDeleted: false,
    ...scopeContainmentClause(user),
    $or: [{ reviewStatus: 'pending' }, { status: { $in: ['failed', 'dead_lettered'] } }],
  };

  // Each side is limited before the merge, so the union is bounded even when
  // one queue is enormous.
  const [documents, queries] = await Promise.all([
    DocumentModel.find(documentFilter).sort({ createdAt: -1 }).limit(limit).lean(),
    QueryModel.find(queryFilter).sort({ createdAt: -1 }).limit(limit).lean(),
  ]);

  const documentRows = documents.map((d) => ({
    kind: 'document' as const,
    id: String(d._id),
    originalFilename: d.originalFilename,
    status: d.status,
    reason: d.status === 'failed' ? 'Processing failed — retry available' : 'Low-confidence extraction',
    subsidiaryId: String(d.subsidiaryId),
    createdAt: d.createdAt,
  }));

  const queryRows = queries.map((q) => ({
    kind: 'query' as const,
    id: String(q._id),
    questionText: q.questionText,
    status: q.status,
    // A broken generation is checked first: it is the more urgent of the two
    // and a dead-lettered query can also still be sitting at `pending`.
    reason:
      q.status === 'dead_lettered'
        ? 'Generation failed repeatedly; manual review required'
        : q.status === 'failed'
          ? 'Generation failed — retry available'
          : 'Answer awaiting review',
    // `contextScope` is the authorization field; this denormalised id exists
    // only when the query was asked against exactly one subsidiary, so a
    // multi-subsidiary query reports null rather than an arbitrary member.
    subsidiaryId: q.subsidiaryId ? String(q.subsidiaryId) : null,
    createdAt: q.createdAt,
  }));

  // Newest first. Documents are concatenated ahead of queries so an exact
  // timestamp tie resolves the same way on every run — the sort is stable, so
  // no comparator tie-break is needed and none may be added.
  return [...documentRows, ...queryRows]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
