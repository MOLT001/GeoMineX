/**
 * Query business logic — PRD §4.4, §5.7, §9.5, §9.6.
 *
 * THIS MODULE WRITES ONLY TO `queries` AND THE AUDIT LOG.
 *
 * It imports no report, user, session, storage or extracted-field mutation.
 * That absence is the §9.5 control "model output must never trigger a
 * privileged action": it is not a check that could be forgotten, it is an
 * absence of machinery. eslint.config.js turns it into a BUILD FAILURE
 * (no-restricted-imports on src/modules/queries/**), and
 * tests/promptInjection.test.ts asserts it again from the source text.
 *
 * Every read folds the caller's scope into the query itself (§9.1); an
 * out-of-scope query is never loaded into memory, and a miss is 404 whether
 * the row does not exist or belongs to another subsidiary.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { logger } from '../../utils/logger.js';
import { assertSubsidiaryAccess, isUnscoped, type AuthContext } from '../../utils/authorization.js';
import { recordAudit } from '../audit/audit.service.js';
import { Subsidiary } from '../subsidiaries/subsidiary.model.js';
import { DocumentModel } from '../documents/document.model.js';
import { QueryModel, type QueryAttrs, type QueryDoc } from './query.model.js';
import { enqueueQuery, canRetryQuery } from './query.worker.js';
import type { CreateQueryInput, ListQueriesQuery, ReviewQueryInput } from './query.schema.js';

export interface ActorMeta {
  ipAddress?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CENTRAL AUTHORIZATION RULE OF THIS MODULE — containment, not intersection.
 *
 * A query answered over {A, B} may carry B's figures in its prose and its
 * citations. A user granted only A must therefore NOT read it, even though the
 * query "touches" a subsidiary they hold. Intersection ($in alone) would let
 * them; containment does not.
 *
 * WRITTEN AS `$and` DELIBERATELY. Both clauses key on the same path, and as a
 * single object literal the second would silently overwrite the first —
 * dropping either the index-usable narrowing or, worse, the containment
 * guarantee itself.
 *
 *   - `$in`   keeps the query index-usable on
 *             { 'contextScope.subsidiaryIds': 1, createdAt: -1 }, AND kills
 *             the empty-grants case ($in: [] matches nothing), which
 *             containment alone would treat as universally satisfiable.
 *   - `$not/$elemMatch/$nin` is the containment half: the array must contain
 *             NOTHING outside my grants.
 *
 * Callers must not introduce another top-level `$and` into the same filter.
 */
export function scopeContainmentClause(user: AuthContext): Record<string, unknown> {
  if (isUnscoped(user.role)) return {};
  const ids = user.subsidiaryAccess.map((id) => new Types.ObjectId(id));
  return {
    $and: [
      { 'contextScope.subsidiaryIds': { $in: ids } },
      { 'contextScope.subsidiaryIds': { $not: { $elemMatch: { $nin: ids } } } },
    ],
  };
}

/**
 * Resolve the context scope at ASK time.
 *
 * Always returns a non-empty, concrete id array — never null — so no
 * downstream filter can ever emit `{ $in: null }`, and so the containment rule
 * above always has something to evaluate.
 */
async function resolveContextScope(
  input: CreateQueryInput,
  user: AuthContext,
): Promise<{ subsidiaryIds: Types.ObjectId[]; documentIds: Types.ObjectId[] }> {
  let subsidiaryIds: Types.ObjectId[];

  if (input.subsidiaryId) {
    assertSubsidiaryAccess(user, input.subsidiaryId); // 404, never 403
    subsidiaryIds = [new Types.ObjectId(input.subsidiaryId)];
  } else if (isUnscoped(user.role)) {
    const all = await Subsidiary.find({ isDeleted: false }).select({ _id: 1 }).lean();
    subsidiaryIds = all.map((s) => s._id);
  } else {
    subsidiaryIds = [...user.subsidiaryAccess].sort().map((id) => new Types.ObjectId(id));
  }

  if (subsidiaryIds.length === 0) {
    throw ApiError.invalidRequest('You have no subsidiary access; nothing can be queried');
  }

  // Client-supplied documentIds are resolved through a SCOPED query, so an
  // unchecked client id never reaches a filter (§8.3). Out of scope -> 404;
  // in scope but not validated -> INVALID_REQUEST, mirroring createReport.
  let documentIds: Types.ObjectId[] = [];
  if (input.documentIds.length > 0) {
    const wanted = input.documentIds.map((id) => new Types.ObjectId(id));
    const found = await DocumentModel.find({
      _id: { $in: wanted },
      isDeleted: false,
      subsidiaryId: { $in: subsidiaryIds },
    })
      .select({ _id: 1, status: 1 })
      .lean();

    if (found.length !== input.documentIds.length) {
      throw ApiError.notFound('Document not found', {
        reason: 'not-found-or-out-of-scope',
        userId: user.id,
      });
    }
    const unvalidated = found.filter((d) => d.status !== 'validated');
    if (unvalidated.length > 0) {
      throw ApiError.invalidRequest('Only validated documents can be queried');
    }
    documentIds = found.map((d) => d._id);
  }

  return { subsidiaryIds, documentIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presenters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Citations are re-filtered against the caller's grants AT READ TIME.
 *
 * Belt and braces: a historic query answered while the caller held a grant
 * that has since been revoked must not surface that subsidiary's citation.
 * §9.1 requires subsidiary access to be evaluated on every protected
 * operation, not only when the row was written.
 */
function visibleCitations(q: QueryAttrs, user: AuthContext) {
  const allowed = isUnscoped(user.role) ? null : new Set(user.subsidiaryAccess);
  return q.citations
    .filter((c) => allowed === null || allowed.has(String(c.subsidiaryId)))
    .map((c) => ({
      ordinal: c.ordinal,
      documentId: String(c.documentId),
      documentFilename: c.documentFilename,
      chunkId: String(c.chunkId),
      chunkIndex: c.chunkIndex,
      pageNumber: c.pageNumber ?? null,
      section: c.section ?? null,
      quote: c.quote,
      relevance: c.relevance,
    }));
}

/** Human-readable loss. A withheld passage must be VISIBLE loss, not silent loss. */
function buildWarnings(q: QueryAttrs): string[] {
  const out: string[] = [];
  if (q.passagesWithheld > 0) {
    out.push(
      `${q.passagesWithheld} source passage(s) were withheld from the answer because they contain suspected embedded instructions. The documents are flagged for review.`,
    );
  }
  if (q.discardedCitationCount > 0) {
    out.push(
      `${q.discardedCitationCount} proposed citation(s) did not match the sources actually retrieved and were discarded.`,
    );
  }
  if (q.answerStatus === 'unsupported') {
    out.push('No authorised source in scope supports an answer to this question.');
  }
  /**
   * §4.5 — the sources cited here contradict each other.
   *
   * Deliberately the LOUDEST warning on the list and deliberately not a
   * correction: the system cannot tell a revision from an error, so it names
   * both readings, names the documents they came from, and asks for a human.
   * An answer drawn from documents that disagree is not wrong, but it is not
   * safe to quote either.
   */
  for (const conflict of q.conflictingMetrics ?? []) {
    const readings = conflict.readings
      .map((r) => `${r.value} (${r.originalFilename})`)
      .join(' vs ');
    /**
     * Say WHICH trigger fired, or the second case reads as a bug.
     *
     * Asked about G9, a reader was shown a warning about Coal Production with
     * no way to see that it fired because the answer above literally states
     * 128,450 — a figure the corpus disputes. Naming that figure turns a
     * confusing caveat into an obviously correct one.
     */
    const because =
      conflict.reason === 'quoted' && conflict.quoted
        ? `This answer states ${conflict.quoted}, and sources disagree on ${conflict.metricLabel}`
        : `Sources disagree on ${conflict.metricLabel}`;
    out.push(
      `CONFLICTING DATA FOUND — HUMAN REVIEW NEEDED. ${because}: ${readings}. Do not quote either figure until a reviewer establishes which is authoritative.`,
    );
  }
  return out;
}

/** Full detail — the polling and traceability shape. */
export function presentQuery(q: QueryAttrs & { _id: unknown }, user: AuthContext) {
  return {
    id: String(q._id),
    askedBy: String(q.askedBy),
    questionText: q.questionText,
    isParliamentary: q.isParliamentary,
    contextScope: {
      subsidiaryIds: q.contextScope.subsidiaryIds.map(String),
      documentIds: q.contextScope.documentIds.map(String),
    },
    subsidiaryId: q.subsidiaryId ? String(q.subsidiaryId) : null,
    status: q.status,
    reviewStatus: q.reviewStatus,
    responseText: q.responseText ?? null,
    officialResponseText: q.officialResponseText ?? null,
    answerStatus: q.answerStatus ?? null,
    // §8.1 — structured metadata, separate from the prose. The client links
    // documentId (+pageNumber, +chunkIndex) into the §5.8 traceability routes
    // and NEVER parses responseText.
    citations: visibleCitations(q, user),
    retrieval: {
      candidatesConsidered: q.candidatesConsidered,
      passagesUsed: q.passagesUsed,
      passagesWithheld: q.passagesWithheld,
      discardedCitations: q.discardedCitationCount,
    },
    warnings: buildWarnings(q),
    injectionSuspected: q.injectionSuspected,
    provider: q.providerName ?? null,
    promptVersion: q.promptVersion ?? null,
    generationMs: q.generationMs ?? null,
    attempts: q.attempts,
    failureReason: q.failureReason ?? null,
    reviewedBy: q.reviewedBy ? String(q.reviewedBy) : null,
    reviewedAt: q.reviewedAt ?? null,
    reviewNote: q.reviewNote ?? null,
    linkedReportId: q.linkedReportId ? String(q.linkedReportId) : null,
    answeredAt: q.answeredAt ?? null,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    // retrievedChunkIds and injectionFlags are internal state. They are
    // surfaced only as COUNTS: publishing which rules fired tells an attacker
    // exactly which patterns to avoid.
  };
}

/** §5.7's log table needs a preview and a count, not the whole answer. */
export function presentQuerySummary(q: QueryAttrs & { _id: unknown }, user: AuthContext) {
  const full = presentQuery(q, user);
  return {
    id: full.id,
    askedBy: full.askedBy,
    questionText: full.questionText,
    isParliamentary: full.isParliamentary,
    status: full.status,
    reviewStatus: full.reviewStatus,
    answerStatus: full.answerStatus,
    answerPreview: q.responseText ? q.responseText.slice(0, 200) : null,
    citationCount: full.citations.length,
    discardedCitationCount: q.discardedCitationCount,
    injectionSuspected: q.injectionSuspected,
    reviewedBy: full.reviewedBy,
    linkedReportId: full.linkedReportId,
    subsidiaryId: full.subsidiaryId,
    createdAt: full.createdAt,
    answeredAt: full.answeredAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a query within scope, or 404.
 *
 * DELIBERATELY NOT utils/authorization.ts#findScopedOrFail: that helper merges
 * `subsidiaryScopeFilter`, which filters a TOP-LEVEL `subsidiaryId`. This
 * collection authorizes on `contextScope.subsidiaryIds`, so findScopedOrFail
 * would match nothing and 404 every non-admin read.
 */
async function findScoped(queryId: string, user: AuthContext): Promise<QueryDoc> {
  if (!Types.ObjectId.isValid(queryId)) throw ApiError.notFound('Query not found');

  const row = await QueryModel.findOne({
    _id: new Types.ObjectId(queryId),
    isDeleted: false,
    ...scopeContainmentClause(user),
  });

  if (!row) {
    throw ApiError.notFound('Query not found', {
      reason: 'not-found-or-out-of-scope',
      userId: user.id,
      queryId,
    });
  }
  return row;
}

export async function getQuery(queryId: string, user: AuthContext) {
  return presentQuery(await findScoped(queryId, user), user);
}

/**
 * The §5.7 log table.
 *
 * Cursor, not offset (§9.8): the log takes continuous inserts, so offset paging
 * would skip and duplicate rows under the reader. Results stay sorted by `_id`
 * descending even when `?q=` supplies a text search — score ordering and cursor
 * stability are incompatible, and for an auditable log a silently skipped row is
 * a defect while a suboptimal result order is a UX annoyance.
 */
export async function listQueries(query: ListQueriesQuery, user: AuthContext) {
  const filter: Record<string, unknown> = { isDeleted: false, ...scopeContainmentClause(user) };

  if (query.subsidiaryId) {
    assertSubsidiaryAccess(user, query.subsidiaryId); // 404 for a grant not held
    filter['contextScope.subsidiaryIds'] = new Types.ObjectId(query.subsidiaryId);
  }
  if (query.status) filter.status = query.status;
  if (query.reviewStatus) filter.reviewStatus = query.reviewStatus;
  if (query.isParliamentary) filter.isParliamentary = query.isParliamentary === 'true';
  if (query.askedBy) filter.askedBy = new Types.ObjectId(query.askedBy);
  if (query.mine === 'true') filter.askedBy = new Types.ObjectId(user.id);
  // §8.2: the text operator lives in the SAME query as the scope clause.
  if (query.q) filter.$text = { $search: query.q };
  if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

  const rows = await QueryModel.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    data: page.map((r) => presentQuerySummary(r as unknown as QueryAttrs & { _id: unknown }, user)),
    pagination: {
      nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1]!._id) : null,
      limit: query.limit,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask — instructions §4a, PRD §4.4, §10.3.
 *
 * The row is created in `queued` and returned immediately with **no answer**;
 * the worker answers it and the client polls `GET /queries/:id`. Answering
 * inside the request would tie a parliamentary question to one HTTP timeout
 * and leave no state to retry from.
 */
export async function askQuery(input: CreateQueryInput, user: AuthContext, meta: ActorMeta) {
  const scope = await resolveContextScope(input, user);

  const doc = await QueryModel.create({
    askedBy: new Types.ObjectId(user.id),
    contextScope: scope,
    // Denormalised for §8's shape, audit and the log table. NOT authorization.
    subsidiaryId: scope.subsidiaryIds.length === 1 ? scope.subsidiaryIds[0] : undefined,
    questionText: input.questionText,
    isParliamentary: input.isParliamentary,
    status: 'queued',
    reviewStatus: input.isParliamentary ? 'pending' : 'not_required',
    attempts: 0,
    maxAttempts: env.QUERY_MAX_ATTEMPTS,
  });

  // §9.6: counts and ids only. The QUESTION TEXT IS NEVER AUDITED — it can
  // restate an operational figure, which is the same reason
  // extractedFields.value is excluded from audit metadata.
  await recordAudit({
    action: 'query.asked',
    userId: user.id,
    targetType: 'Query',
    targetId: String(doc._id),
    subsidiaryId: doc.subsidiaryId ? String(doc.subsidiaryId) : undefined,
    metadata: {
      isParliamentary: input.isParliamentary,
      scopeSize: scope.subsidiaryIds.length,
      documentCount: scope.documentIds.length,
    },
    ipAddress: meta.ipAddress,
  });

  enqueueQuery(String(doc._id));
  logger.info('Query queued for answering', { queryId: String(doc._id) });

  return presentQuery(doc, user);
}

/**
 * Human review — PRD §5.7, §4.2's no-auto-publish rule restated as a §9.5
 * injection control.
 *
 * A model-drafted answer reaches an official response only through an
 * authenticated human. `reviewStatus: 'approved'` is ADMIN-ONLY, checked here
 * rather than in the router because it depends on the body — the same
 * separation of duties report.routes.ts applies to publish, for the same
 * reason: the person drafting a figure is not the person putting it on record.
 */
export async function reviewQuery(
  queryId: string,
  input: ReviewQueryInput,
  user: AuthContext,
  meta: ActorMeta,
) {
  const q = await findScoped(queryId, user);

  if (input.reviewStatus === 'approved' && !isUnscoped(user.role)) {
    // 403, not 404: the row is legitimately visible; only the ACTION is denied (§9.1).
    throw ApiError.forbidden('Only an administrator can approve a query response');
  }
  if (input.reviewStatus && !['answered', 'unsupported'].includes(q.status)) {
    throw ApiError.invalidRequest(`A query cannot be reviewed while its status is "${q.status}"`);
  }

  if (input.linkedReportId !== undefined) {
    if (input.linkedReportId === null) {
      q.linkedReportId = undefined;
    } else {
      // Resolved through a scoped read in the reports module's own terms.
      // Imported as a MODEL, never as a mutating service (§9.5 / eslint rule).
      const { Report } = await import('../reports/report.model.js');
      const report = await Report.findOne({
        _id: new Types.ObjectId(input.linkedReportId),
        isDeleted: false,
        subsidiaryId: { $in: q.contextScope.subsidiaryIds },
      })
        .select({ _id: 1 })
        .lean();
      if (!report) throw ApiError.notFound('Report not found');
      q.linkedReportId = report._id;
    }
  }

  if (input.officialResponseText !== undefined) q.officialResponseText = input.officialResponseText;
  if (input.isParliamentary !== undefined) q.isParliamentary = input.isParliamentary;
  if (input.reviewNote !== undefined) q.reviewNote = input.reviewNote;
  if (input.reviewStatus) {
    q.reviewStatus = input.reviewStatus;
    q.reviewedBy = new Types.ObjectId(user.id);
    q.reviewedAt = new Date();
  }
  await q.save();

  await recordAudit({
    action: input.reviewStatus ? 'query.reviewed' : 'query.updated',
    userId: user.id,
    targetType: 'Query',
    targetId: queryId,
    subsidiaryId: q.subsidiaryId ? String(q.subsidiaryId) : undefined,
    metadata: {
      reviewStatus: q.reviewStatus,
      hadInjectionFlags: q.injectionSuspected,
      citationCount: q.citations.length,
      officialResponseEdited: input.officialResponseText !== undefined,
    },
    ipAddress: meta.ipAddress,
  });

  return presentQuery(q, user);
}

/**
 * Retry — instructions §4a: "make retry an explicit endpoint, not a hidden
 * loop", so it is observable, authorized and rate-limitable.
 *
 * Author-or-admin. 403 (not 404) when the query is legitimately visible but
 * the caller is neither.
 */
export async function retryQuery(queryId: string, user: AuthContext, meta: ActorMeta) {
  const q = await findScoped(queryId, user);

  if (!isUnscoped(user.role) && String(q.askedBy) !== user.id) {
    throw ApiError.forbidden('Only the author or an administrator can retry this query');
  }
  if (q.status !== 'failed') {
    throw ApiError.invalidRequest(`Only failed queries can be retried (current status: ${q.status})`);
  }
  if (!canRetryQuery(q.attempts, q.maxAttempts)) {
    throw ApiError.invalidRequest('Retry limit reached; this query needs manual review');
  }

  await recordAudit({
    action: 'query.retried',
    userId: user.id,
    targetType: 'Query',
    targetId: queryId,
    subsidiaryId: q.subsidiaryId ? String(q.subsidiaryId) : undefined,
    metadata: { attempts: q.attempts },
    ipAddress: meta.ipAddress,
  });

  enqueueQuery(queryId);
  return { ...presentQuery(q, user), status: 'queued' as const };
}
