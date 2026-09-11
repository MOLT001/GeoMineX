/**
 * Read paths over stored topics — the half that makes extraction worth doing.
 *
 * Everything here reads `documentTopics` and `documentIntelligence`, both
 * written once at ingestion. Nothing re-analyses a document, and no request
 * path ever touches chunk text — §21's list of prohibitions, held by
 * construction rather than by discipline.
 *
 * ─── SCOPE IS RESOLVED BEFORE ANY FILTER IS BUILT ───────────────────────────
 * `resolveScope` runs first in every exported function, so a client-supplied
 * `subsidiaryId` is checked against the caller's grants — 404, never 403 —
 * before it can reach a `$match`. `documentTopics` carries a denormalised
 * `subsidiaryId` for exactly this reason: the scope clause and the topic clause
 * are one query, with no path that filters afterwards.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import type { AuthContext } from '../../utils/authorization.js';
import { getCached, setCached } from '../../utils/aggregateCache.js';
import { PAYLOAD_VERSION, cacheKeyOf, resolveScope, scopeMatch, type ResolvedScope } from '../../utils/scopeKey.js';
import { DocumentModel } from '../documents/document.model.js';
import { DocumentIntelligence } from './documentIntelligence.model.js';
import { DocumentTopic } from './documentTopic.model.js';
import { TopicCache } from './topicCache.model.js';
import { allTopics, labelForTopicId, topicById } from './taxonomy.js';

/**
 * How many topic rows the catalogue aggregation will read.
 *
 * A ceiling rather than a full scan, because this is an authenticated read that
 * must not be able to schedule unbounded work (§9.2). Rows are taken
 * newest-first, so the truncated tail is the oldest material — the end whose
 * absence a "what are we filing about" view can survive.
 */
const MAX_CATALOG_ROWS = 20_000;

/** Documents sampled when measuring which topics travel together (§16). */
const MAX_COOCCURRENCE_DOCS = 5_000;

/** Recent documents shown under each topic in the explorer (§13). */
const RECENT_PER_TOPIC = 3;

/** Related topics reported per topic. */
const RELATED_PER_TOPIC = 4;

/**
 * Documents a topic filter will resolve to.
 *
 * Beyond this the OLDEST are dropped, which matches the list's own
 * newest-first order — a user paging a topic filter reaches the cap long after
 * they have stopped looking. The number is reported back so the caller can say
 * so rather than silently showing a truncated set.
 */
const MAX_TOPIC_FILTER_DOCUMENTS = 5_000;

/** §14's "recently emerging" window, and the window it is compared against. */
const EMERGING_WINDOW_DAYS = 90;

// ── Shapes ─────────────────────────────────────────────────────────────────

export interface PresentedTopic {
  topicId: string;
  label: string;
  category: string;
  relevance: number;
  termCount: number;
  matchedTerms: string[];
  discovered: boolean;
  firstPage: number | null;
  evidence: { chunkIndex: number; pageNumber: number | null; quote: string }[];
}

export interface DocumentIntelligencePayload {
  documentId: string;
  status: string;
  confidence: number;
  extractionVersion: string;
  extractedAt: string | null;
  primaryTopic: PresentedTopic | null;
  secondaryTopics: PresentedTopic[];
  keywords: { term: string; count: number; domain: boolean }[];
  technicalTerms: { term: string; count: number; domain: boolean }[];
  summary: string;
  error: string | null;
}

export interface CatalogTopic {
  topicId: string;
  label: string;
  category: string;
  discovered: boolean;
  documentCount: number;
  /** How often this topic is a document's PRIMARY subject, not just present. */
  primaryCount: number;
  averageRelevance: number;
  lastSeenAt: string | null;
  relatedTopics: { topicId: string; label: string; sharedDocuments: number }[];
  recentDocuments: { id: string; originalFilename: string; createdAt: string; relevance: number }[];
}

// ── Presentation ───────────────────────────────────────────────────────────

interface TopicRowLike {
  topicId: string;
  label: string;
  category: string;
  relevance: number;
  termCount: number;
  matchedTerms?: string[];
  discovered: boolean;
  firstPage?: number;
  evidence?: { chunkIndex: number; pageNumber?: number; quote: string }[];
}

function presentTopic(row: TopicRowLike): PresentedTopic {
  return {
    topicId: row.topicId,
    label: row.label,
    category: row.category,
    relevance: row.relevance,
    termCount: row.termCount,
    matchedTerms: row.matchedTerms ?? [],
    discovered: row.discovered,
    firstPage: row.firstPage ?? null,
    evidence: (row.evidence ?? []).map((e) => ({
      chunkIndex: e.chunkIndex,
      pageNumber: e.pageNumber ?? null,
      quote: e.quote,
    })),
  };
}

// ── Per-document intelligence (§12, §19) ───────────────────────────────────

/**
 * One document's analysis.
 *
 * The caller has ALREADY proved access to the document — `document.service`
 * resolves it through `findScoped` and passes the id in — so this does not
 * re-run the scope check. Everything read here is keyed on that id.
 */
export async function getDocumentIntelligence(
  documentId: Types.ObjectId,
): Promise<DocumentIntelligencePayload> {
  const [record, topics] = await Promise.all([
    DocumentIntelligence.findOne({ documentId }).lean(),
    DocumentTopic.find({ documentId, isDeleted: false }).sort({ score: -1 }).lean(),
  ]);

  // A document uploaded before this feature existed, or one still in the queue,
  // is `pending` rather than an error: nothing has failed, it has not run.
  if (!record) {
    return {
      documentId: String(documentId),
      status: 'pending',
      confidence: 0,
      extractionVersion: '',
      extractedAt: null,
      primaryTopic: null,
      secondaryTopics: [],
      keywords: [],
      technicalTerms: [],
      summary: '',
      error: null,
    };
  }

  const presented = topics.map(presentTopic);

  return {
    documentId: String(documentId),
    status: record.status,
    confidence: record.confidence,
    extractionVersion: record.extractionVersion,
    extractedAt: record.extractedAt?.toISOString() ?? null,
    // The rows are the authority on ordering; `primaryTopicId` on the record is
    // a convenience copy, and reading the FIRST ROW instead means the two can
    // never disagree about which topic leads.
    primaryTopic: presented[0] ?? null,
    secondaryTopics: presented.slice(1),
    keywords: record.keywords.map((k) => ({ term: k.term, count: k.count, domain: k.domain })),
    technicalTerms: record.technicalTerms.map((k) => ({ term: k.term, count: k.count, domain: k.domain })),
    summary: record.summary,
    error: record.error ?? null,
  };
}

// ── Topic filtering, for the documents list (§8) ───────────────────────────

export interface TopicFilterResult {
  documentIds: Types.ObjectId[];
  /** True when the cap was hit and the oldest matches were dropped. */
  truncated: boolean;
}

/**
 * Which documents carry these topics.
 *
 * `matchAll` is the difference between "Geological Exploration OR Drilling" and
 * the intersection §8 asks for when a user stacks two filters. The intersection
 * is computed in the database with a group-and-count rather than by loading two
 * id sets and intersecting them in Node, so the work stays proportional to the
 * matching rows and not to the corpus.
 */
export async function resolveTopicFilter(
  topicIds: string[],
  matchAll: boolean,
  scope: ResolvedScope,
): Promise<TopicFilterResult> {
  if (topicIds.length === 0) return { documentIds: [], truncated: false };

  const match = scopeMatch(scope, { topicId: { $in: topicIds } });

  const rows = await DocumentTopic.aggregate<{ _id: Types.ObjectId }>([
    { $match: match },
    { $sort: { documentCreatedAt: -1, documentId: -1 } },
    { $group: { _id: '$documentId', topics: { $addToSet: '$topicId' }, newest: { $first: '$documentCreatedAt' } } },
    ...(matchAll ? [{ $match: { [`topics.${topicIds.length - 1}`]: { $exists: true } } }] : []),
    { $sort: { newest: -1, _id: -1 } },
    { $limit: MAX_TOPIC_FILTER_DOCUMENTS + 1 },
    { $project: { _id: 1 } },
  ]);

  const truncated = rows.length > MAX_TOPIC_FILTER_DOCUMENTS;
  return {
    documentIds: (truncated ? rows.slice(0, MAX_TOPIC_FILTER_DOCUMENTS) : rows).map((r) => r._id),
    truncated,
  };
}

/**
 * Which documents mention these free-text terms as topics or keywords — §9.
 *
 * This is what lets a search for `drilling` return "Annual Geological
 * Investigation Report", whose filename contains neither word. Topic labels and
 * aliases are matched in code against the taxonomy (a small, in-memory list),
 * and stored keywords are matched in the database.
 */
export async function resolveSearchTopicDocuments(
  terms: string[],
  scope: ResolvedScope,
): Promise<Types.ObjectId[]> {
  if (terms.length === 0) return [];

  const needle = terms.map((t) => t.toLowerCase());

  // A taxonomy topic matches when any search term appears in its label or in
  // one of its aliases — `drilling` reaches `Drilling & Boreholes` through both.
  const topicIds = allTopics()
    .filter((topic) => {
      const haystack = [topic.label.toLowerCase(), ...topic.aliases.map((a) => a.toLowerCase())];
      return needle.some((term) => haystack.some((h) => h.includes(term)));
    })
    .map((t) => t.id);

  const [byTopic, byKeyword] = await Promise.all([
    topicIds.length
      ? DocumentTopic.find(scopeMatch(scope, { topicId: { $in: topicIds } }))
          .sort({ documentCreatedAt: -1 })
          .limit(MAX_TOPIC_FILTER_DOCUMENTS)
          .select({ documentId: 1 })
          .lean()
      : [],
    // Anchored on the term boundary rather than a bare substring, so `ash` does
    // not match `cash`. Escaped, because a search string is user input and an
    // unescaped `(` in a regex is a 500 at best.
    DocumentIntelligence.find(
      scopeMatch(scope, {
        'keywords.term': { $in: needle.map((t) => new RegExp(`\\b${escapeRegex(t)}`, 'i')) },
      }),
    )
      .sort({ documentCreatedAt: -1 })
      .limit(MAX_TOPIC_FILTER_DOCUMENTS)
      .select({ documentId: 1 })
      .lean(),
  ]);

  const ids = new Map<string, Types.ObjectId>();
  for (const row of byTopic) ids.set(String(row.documentId), row.documentId);
  for (const row of byKeyword) ids.set(String(row.documentId), row.documentId);
  return [...ids.values()];
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Topic catalogue and explorer (§13, and the filter's option list) ───────

export async function getTopicCatalog(
  query: { subsidiaryId?: string; limit: number; includeDiscovered: boolean },
  user: AuthContext,
): Promise<{ scope: { subsidiaryIds: string[]; unscoped: boolean }; topics: CatalogTopic[]; computedAt: string; cached: boolean }> {
  const scope = resolveScope(user, query.subsidiaryId);
  const cacheKey = cacheKeyOf([
    'topic-catalog',
    PAYLOAD_VERSION,
    scope.key,
    query.limit,
    query.includeDiscovered,
  ]);

  const hit = await getCached<{ topics: CatalogTopic[] }>(TopicCache, cacheKey);
  if (hit) {
    return {
      scope: presentScope(scope),
      topics: hit.payload.topics,
      computedAt: hit.computedAt.toISOString(),
      cached: true,
    };
  }

  const match = scopeMatch(scope, query.includeDiscovered ? {} : { discovered: false });

  const grouped = await DocumentTopic.aggregate<{
    _id: string;
    label: string;
    category: string;
    discovered: boolean;
    documentCount: number;
    primaryCount: number;
    averageRelevance: number;
    lastSeenAt: Date;
    recent: { documentId: Types.ObjectId; relevance: number; createdAt: Date }[];
  }>([
    { $match: match },
    // Sorted BEFORE the group, so `$push` accumulates newest-first and the
    // `$slice` below yields the most recent documents rather than arbitrary
    // ones. This is also what bounds the stage: only the newest rows are read.
    { $sort: { documentCreatedAt: -1, documentId: -1 } },
    { $limit: MAX_CATALOG_ROWS },
    {
      $group: {
        _id: '$topicId',
        label: { $first: '$label' },
        category: { $first: '$category' },
        discovered: { $first: '$discovered' },
        documentCount: { $sum: 1 },
        primaryCount: { $sum: { $cond: [{ $eq: ['$rank', 'primary'] }, 1, 0] } },
        averageRelevance: { $avg: '$relevance' },
        lastSeenAt: { $max: '$documentCreatedAt' },
        recent: { $push: { documentId: '$documentId', relevance: '$relevance', createdAt: '$documentCreatedAt' } },
      },
    },
    { $project: { label: 1, category: 1, discovered: 1, documentCount: 1, primaryCount: 1, averageRelevance: 1, lastSeenAt: 1, recent: { $slice: ['$recent', RECENT_PER_TOPIC] } } },
    // Ties break on the id so the catalogue does not reshuffle between reads.
    { $sort: { documentCount: -1, _id: 1 } },
    { $limit: query.limit },
  ]);

  // One hydration query for every recent document across every topic, rather
  // than one per topic. Re-scoped deliberately: a filename is content, and it
  // must not travel on the strength of a topic row's denormalised subsidiary.
  const recentIds = [...new Set(grouped.flatMap((g) => g.recent.map((r) => String(r.documentId))))];
  const docs = recentIds.length
    ? await DocumentModel.find({
        _id: { $in: recentIds.map((id) => new Types.ObjectId(id)) },
        isDeleted: false,
        ...(scope.subsidiaryIds ? { subsidiaryId: { $in: scope.subsidiaryIds } } : {}),
      })
        .select({ _id: 1, originalFilename: 1, createdAt: 1 })
        .lean()
    : [];
  const docById = new Map(docs.map((d) => [String(d._id), d]));

  const related = await computeRelatedTopics(
    grouped.map((g) => g._id),
    scope,
  );

  const topics: CatalogTopic[] = grouped.map((g) => ({
    topicId: g._id,
    label: g.label || labelForTopicId(g._id),
    category: g.category,
    discovered: g.discovered,
    documentCount: g.documentCount,
    primaryCount: g.primaryCount,
    averageRelevance: Math.round(g.averageRelevance * 1000) / 1000,
    lastSeenAt: g.lastSeenAt?.toISOString() ?? null,
    relatedTopics: related.get(g._id) ?? [],
    recentDocuments: g.recent
      .map((r) => {
        const doc = docById.get(String(r.documentId));
        return doc
          ? {
              id: String(doc._id),
              originalFilename: doc.originalFilename,
              createdAt: doc.createdAt.toISOString(),
              relevance: r.relevance,
            }
          : null;
      })
      .filter((d): d is NonNullable<typeof d> => d !== null),
  }));

  const computedAt = await setCached(TopicCache, {
    cacheKey,
    subsidiaryIds: scope.subsidiaryIds ?? [],
    payload: { topics },
    ttlSeconds: env.TOPICS_CACHE_TTL_SECONDS,
  });

  return { scope: presentScope(scope), topics, computedAt: computedAt.toISOString(), cached: false };
}

/**
 * Which topics travel together — §16, measured rather than asserted.
 *
 * Co-occurrence in the actual corpus is merged with the taxonomy's static
 * `related` list, and the corpus wins: an edge the documents contradict does
 * not survive, while a curated edge fills in for a topic the corpus has not yet
 * seen enough of. That ordering is the point — the taxonomy is a prior, not a
 * claim about this subsidiary's filings.
 */
async function computeRelatedTopics(
  topicIds: string[],
  scope: ResolvedScope,
): Promise<Map<string, { topicId: string; label: string; sharedDocuments: number }[]>> {
  const out = new Map<string, { topicId: string; label: string; sharedDocuments: number }[]>();
  if (topicIds.length === 0) return out;

  const perDocument = await DocumentTopic.aggregate<{ _id: Types.ObjectId; topics: string[] }>([
    { $match: scopeMatch(scope) },
    { $sort: { documentCreatedAt: -1 } },
    { $limit: MAX_CATALOG_ROWS },
    { $group: { _id: '$documentId', topics: { $addToSet: '$topicId' } } },
    { $limit: MAX_COOCCURRENCE_DOCS },
  ]);

  const wanted = new Set(topicIds);
  const pairs = new Map<string, Map<string, number>>();

  for (const doc of perDocument) {
    for (const a of doc.topics) {
      if (!wanted.has(a)) continue;
      let row = pairs.get(a);
      if (!row) {
        row = new Map();
        pairs.set(a, row);
      }
      for (const b of doc.topics) {
        if (a === b) continue;
        row.set(b, (row.get(b) ?? 0) + 1);
      }
    }
  }

  for (const id of topicIds) {
    const measured = [...(pairs.get(id) ?? new Map<string, number>()).entries()]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, RELATED_PER_TOPIC)
      .map(([topicId, sharedDocuments]) => ({ topicId, label: labelForTopicId(topicId), sharedDocuments }));

    const seen = new Set(measured.map((m) => m.topicId));
    // `sharedDocuments: 0` is honest: the edge is curated, not observed here.
    for (const fallback of topicById(id)?.related ?? []) {
      if (measured.length >= RELATED_PER_TOPIC) break;
      if (seen.has(fallback)) continue;
      measured.push({ topicId: fallback, label: labelForTopicId(fallback), sharedDocuments: 0 });
      seen.add(fallback);
    }
    out.set(id, measured);
  }

  return out;
}

// ── Related documents (§17) ────────────────────────────────────────────────

export interface RelatedDocument {
  id: string;
  originalFilename: string;
  createdAt: string;
  status: string;
  sharedTopics: { topicId: string; label: string }[];
  /** 0..1 — the share of this document's topic weight the two have in common. */
  similarity: number;
}

/**
 * Documents that share this one's subjects.
 *
 * Similarity is weighted by the SOURCE document's relevance scores, so a
 * document sharing its primary topic ranks above one sharing a marginal
 * secondary. There is no embedding model here, so this is honest overlap and is
 * described as such — it does not claim semantic similarity it cannot measure.
 */
export async function getRelatedDocuments(
  documentId: Types.ObjectId,
  scope: ResolvedScope,
  limit: number,
): Promise<RelatedDocument[]> {
  const mine = await DocumentTopic.find({ documentId, isDeleted: false })
    .sort({ score: -1 })
    .select({ topicId: 1, relevance: 1, label: 1 })
    .lean();
  if (mine.length === 0) return [];

  const weightByTopic = new Map(mine.map((t) => [t.topicId, t.relevance]));
  const totalWeight = mine.reduce((sum, t) => sum + t.relevance, 0) || 1;

  const others = await DocumentTopic.find(
    scopeMatch(scope, { topicId: { $in: mine.map((t) => t.topicId) }, documentId: { $ne: documentId } }),
  )
    .sort({ documentCreatedAt: -1 })
    .limit(MAX_TOPIC_FILTER_DOCUMENTS)
    .select({ documentId: 1, topicId: 1, label: 1 })
    .lean();

  const scored = new Map<string, { id: Types.ObjectId; weight: number; topics: { topicId: string; label: string }[] }>();
  for (const row of others) {
    const key = String(row.documentId);
    let entry = scored.get(key);
    if (!entry) {
      entry = { id: row.documentId, weight: 0, topics: [] };
      scored.set(key, entry);
    }
    entry.weight += weightByTopic.get(row.topicId) ?? 0;
    entry.topics.push({ topicId: row.topicId, label: row.label });
  }

  const ranked = [...scored.values()]
    .sort((a, b) => b.weight - a.weight || (String(a.id) < String(b.id) ? -1 : 1))
    .slice(0, limit);
  if (ranked.length === 0) return [];

  // Re-scoped hydration, for the same reason as the catalogue: the filename and
  // status are content, and they come from `documents` under its own filter.
  const docs = await DocumentModel.find({
    _id: { $in: ranked.map((r) => r.id) },
    isDeleted: false,
    ...(scope.subsidiaryIds ? { subsidiaryId: { $in: scope.subsidiaryIds } } : {}),
  })
    .select({ _id: 1, originalFilename: 1, createdAt: 1, status: 1 })
    .lean();
  const docById = new Map(docs.map((d) => [String(d._id), d]));

  const out: RelatedDocument[] = [];
  for (const r of ranked) {
    const doc = docById.get(String(r.id));
    // Dropped rather than shown: a topic row whose parent is gone from the
    // scoped query is drift, and the safe reading of drift is "not visible".
    if (!doc) continue;
    out.push({
      id: String(doc._id),
      originalFilename: doc.originalFilename,
      createdAt: doc.createdAt.toISOString(),
      status: doc.status,
      sharedTopics: r.topics,
      similarity: Math.round(Math.min(1, r.weight / totalWeight) * 1000) / 1000,
    });
  }
  return out;
}

// ── Dashboard analytics (§14) ──────────────────────────────────────────────

export interface TopicAnalytics {
  totalDocuments: number;
  analysedDocuments: number;
  topTopics: { topicId: string; label: string; category: string; documentCount: number }[];
  byCategory: { category: string; documentCount: number }[];
  emergingTopics: { topicId: string; label: string; recent: number; previous: number; change: number }[];
  extractionHealth: { status: string; count: number }[];
}

export async function getTopicAnalytics(
  query: { subsidiaryId?: string; limit: number },
  user: AuthContext,
): Promise<{ scope: { subsidiaryIds: string[]; unscoped: boolean }; analytics: TopicAnalytics; computedAt: string; cached: boolean }> {
  const scope = resolveScope(user, query.subsidiaryId);
  const cacheKey = cacheKeyOf(['topic-analytics', PAYLOAD_VERSION, scope.key, query.limit]);

  const hit = await getCached<{ analytics: TopicAnalytics }>(TopicCache, cacheKey);
  if (hit) {
    return {
      scope: presentScope(scope),
      analytics: hit.payload.analytics,
      computedAt: hit.computedAt.toISOString(),
      cached: true,
    };
  }

  const now = Date.now();
  const windowMs = EMERGING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentFrom = new Date(now - windowMs);
  const previousFrom = new Date(now - windowMs * 2);

  // One round trip. Five independent reads issued in series would pay five
  // Atlas latencies for aggregations that are individually trivial — the same
  // defect that made the dashboard's cold cache take fifteen seconds.
  const [topTopics, byCategory, windows, health, documentCounts] = await Promise.all([
    DocumentTopic.aggregate<{ _id: string; label: string; category: string; documentCount: number }>([
      { $match: scopeMatch(scope) },
      { $group: { _id: '$topicId', label: { $first: '$label' }, category: { $first: '$category' }, documentCount: { $sum: 1 } } },
      { $sort: { documentCount: -1, _id: 1 } },
      { $limit: query.limit },
    ]),
    DocumentTopic.aggregate<{ _id: string; documentCount: number }>([
      { $match: scopeMatch(scope, { rank: 'primary' }) },
      { $group: { _id: '$category', documentCount: { $sum: 1 } } },
      { $sort: { documentCount: -1, _id: 1 } },
    ]),
    DocumentTopic.aggregate<{ _id: string; label: string; recent: number; previous: number }>([
      { $match: scopeMatch(scope, { documentCreatedAt: { $gte: previousFrom } }) },
      {
        $group: {
          _id: '$topicId',
          label: { $first: '$label' },
          recent: { $sum: { $cond: [{ $gte: ['$documentCreatedAt', recentFrom] }, 1, 0] } },
          previous: { $sum: { $cond: [{ $lt: ['$documentCreatedAt', recentFrom] }, 1, 0] } },
        },
      },
    ]),
    DocumentIntelligence.aggregate<{ _id: string; count: number }>([
      { $match: scopeMatch(scope) },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    DocumentModel.countDocuments({
      isDeleted: false,
      ...(scope.subsidiaryIds ? { subsidiaryId: { $in: scope.subsidiaryIds } } : {}),
    }),
  ]);

  const analysedDocuments = health.reduce((sum, h) => sum + h.count, 0);

  const analytics: TopicAnalytics = {
    totalDocuments: documentCounts,
    analysedDocuments,
    topTopics: topTopics.map((t) => ({
      topicId: t._id,
      label: t.label || labelForTopicId(t._id),
      category: t.category,
      documentCount: t.documentCount,
    })),
    byCategory: byCategory.map((c) => ({ category: c._id, documentCount: c.documentCount })),
    /**
     * "Emerging" means MORE than before, and a topic with no history is the
     * strongest case of that — so `previous: 0` is kept rather than filtered as
     * a division-by-zero. `change` is a count difference, deliberately not a
     * percentage: a percentage against zero is either infinite or invented, and
     * §4.6 does not permit plotting an invented figure.
     */
    emergingTopics: windows
      .filter((w) => w.recent > w.previous)
      .sort((a, b) => b.recent - b.previous - (a.recent - a.previous) || (a._id < b._id ? -1 : 1))
      .slice(0, query.limit)
      .map((w) => ({
        topicId: w._id,
        label: w.label || labelForTopicId(w._id),
        recent: w.recent,
        previous: w.previous,
        change: w.recent - w.previous,
      })),
    extractionHealth: health.map((h) => ({ status: h._id, count: h.count })),
  };

  const computedAt = await setCached(TopicCache, {
    cacheKey,
    subsidiaryIds: scope.subsidiaryIds ?? [],
    payload: { analytics },
    ttlSeconds: env.TOPICS_CACHE_TTL_SECONDS,
  });

  return { scope: presentScope(scope), analytics, computedAt: computedAt.toISOString(), cached: false };
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function presentScope(scope: ResolvedScope): { subsidiaryIds: string[]; unscoped: boolean } {
  return {
    subsidiaryIds: (scope.subsidiaryIds ?? []).map(String),
    unscoped: scope.subsidiaryIds === null,
  };
}

/**
 * The taxonomy as an option list for the filter control.
 *
 * Served from code with no database read: the vocabulary is static, and a
 * filter dropdown that waits on an aggregation is a filter dropdown that feels
 * broken. Counts come from `getTopicCatalog`; this is the complete list, so a
 * topic no document has yet is still offerable.
 */
export function getTopicVocabulary(): { topicId: string; label: string; category: string }[] {
  return allTopics().map((t) => ({ topicId: t.id, label: t.label, category: t.category }));
}

export function assertKnownTopicIds(topicIds: string[]): void {
  for (const id of topicIds) {
    if (!topicById(id) && !id.startsWith('discovered:')) {
      throw ApiError.invalidRequest(`Unknown topic: ${id}`);
    }
  }
}
