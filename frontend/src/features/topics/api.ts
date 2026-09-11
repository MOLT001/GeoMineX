import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';

/**
 * Topic & Keyword Intelligence — server state.
 *
 * Everything here is DERIVED and already stored: the backend extracts a
 * document's topics once, in the ingestion worker, and these endpoints read
 * rows. No hook in this file causes analysis to happen, which is why they can
 * be cached for minutes and mounted on a dashboard without thought.
 *
 * The one exception is `useReprocessTopics`, which is a deliberate user action
 * and is the only mutation here.
 *
 * ─── WHAT THE BACKEND IS AND IS NOT ─────────────────────────────────────────
 * Topics are scored deterministically against a curated geological/mining
 * taxonomy plus inverse document frequency over the subsidiary's own corpus.
 * There is no model call and no embedding: `relevance` is a within-document
 * ranking, comparable between the topics of ONE document and meaningless
 * between two. Do not build a UI that compares one document's 0.82 against
 * another's.
 */

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * `documentTopic.model.ts`. `topicId` is a taxonomy slug, or `discovered:<phrase>`
 * for a phrase the extractor found that the taxonomy does not know — `discovered`
 * is the flag to switch presentation on, never a prefix check on the id.
 */
export interface DocumentTopic {
  topicId: string;
  label: string;
  category: string;
  /** 0..1 against THIS document's leading topic. Not comparable across documents. */
  relevance: number;
  /** How many times the topic's vocabulary appeared. */
  termCount: number;
  /** The wordings the document actually used — show these, not the label, as proof. */
  matchedTerms: string[];
  discovered: boolean;
  firstPage: number | null;
  /** Verbatim slices of the document. Render as text; never as HTML. */
  evidence: { chunkIndex: number; pageNumber: number | null; quote: string }[];
}

export interface ScoredTerm {
  term: string;
  count: number;
  /** True for curated mining vocabulary, false for a phrase found in the text. */
  domain: boolean;
}

/**
 * `documentIntelligence.model.ts`. SEPARATE from `document.status`, and the two
 * answer different questions: `document.status` is "was the file read",
 * this is "was it understood". A document can be `validated` and
 * `insufficient_text` at once, and both are true.
 */
export type IntelligenceStatus =
  | 'pending'
  | 'processing'
  | 'extracted'
  | 'insufficient_text'
  | 'low_quality'
  | 'failed';

export interface DocumentIntelligence {
  documentId: string;
  status: IntelligenceStatus;
  /** 0..1, capped by OCR quality. 0 whenever there is no primary topic. */
  confidence: number;
  extractionVersion: string;
  extractedAt: string | null;
  primaryTopic: DocumentTopic | null;
  secondaryTopics: DocumentTopic[];
  keywords: ScoredTerm[];
  technicalTerms: ScoredTerm[];
  /**
   * Sentences SELECTED verbatim from the document — never generated prose. It
   * can therefore be empty, and an empty summary is a fact about the document
   * rather than a failure.
   */
  summary: string;
  /** Non-sensitive reason, present only when `status === 'failed'`. */
  error: string | null;
}

export interface CatalogTopic {
  topicId: string;
  label: string;
  category: string;
  discovered: boolean;
  documentCount: number;
  /** How often this is a document's LEADING subject, not merely present. */
  primaryCount: number;
  averageRelevance: number;
  lastSeenAt: string | null;
  /**
   * Measured co-occurrence in this corpus, topped up from the taxonomy's
   * curated edges. `sharedDocuments: 0` means the edge is curated, not observed
   * — worth showing differently rather than as a count of nothing.
   */
  relatedTopics: { topicId: string; label: string; sharedDocuments: number }[];
  recentDocuments: { id: string; originalFilename: string; createdAt: string; relevance: number }[];
}

export interface TopicAnalytics {
  totalDocuments: number;
  /** Documents that have been through extraction. Never exceeds `totalDocuments`. */
  analysedDocuments: number;
  topTopics: { topicId: string; label: string; category: string; documentCount: number }[];
  byCategory: { category: string; documentCount: number }[];
  /**
   * More documents in the last 90 days than in the 90 before. `change` is a
   * COUNT difference, deliberately not a percentage: a percentage against a
   * previous zero is either infinite or invented, and a topic with no history
   * is the strongest case of emerging there is.
   */
  emergingTopics: { topicId: string; label: string; recent: number; previous: number; change: number }[];
  extractionHealth: { status: IntelligenceStatus; count: number }[];
}

export interface RelatedDocument {
  id: string;
  originalFilename: string;
  createdAt: string;
  status: string;
  sharedTopics: { topicId: string; label: string }[];
  /**
   * 0..1 — the share of the SOURCE document's topic weight the two have in
   * common. Topic overlap, not semantic similarity: there is no embedding model
   * behind it, so do not label it as one in the UI.
   */
  similarity: number;
}

export interface TopicScope {
  subsidiaryIds: string[];
  unscoped: boolean;
}

/**
 * Human labels for the taxonomy's categories.
 *
 * A `Record` rather than a lookup with a fallback, so a category added to the
 * backend fails to compile here instead of rendering as a bare slug. `discovered`
 * is a real category: it is what a topic found in the text belongs to.
 */
export const TOPIC_CATEGORY_LABELS: Record<string, string> = {
  exploration: 'Exploration',
  geology: 'Geology',
  planning: 'Planning',
  operations: 'Operations',
  production: 'Production',
  quality: 'Quality',
  environment: 'Environment',
  safety: 'Safety',
  commercial: 'Commercial',
  regulatory: 'Regulatory',
  discovered: 'Found in documents',
};

export function categoryLabel(category: string): string {
  return TOPIC_CATEGORY_LABELS[category] ?? category;
}

/**
 * How to describe an extraction state to someone who is not going to read a
 * schema. Every one of these is a real state a document reaches, and none of
 * them means "broken" except `failed`.
 */
export const INTELLIGENCE_STATUS_LABELS: Record<IntelligenceStatus, string> = {
  pending: 'Not analysed yet',
  processing: 'Analysing',
  extracted: 'Analysed',
  insufficient_text: 'Too little text to analyse',
  low_quality: 'Analysed — scan quality is low',
  failed: 'Analysis failed',
};

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The taxonomy, for a filter's option list.
 *
 * Served from a constant compiled into the server, so it never changes between
 * deploys — cached for the session and never refetched on focus. This is the
 * complete vocabulary, INCLUDING topics no document has yet; the counted
 * version is `useTopicCatalog`.
 */
export function useTopicVocabulary() {
  return useQuery({
    queryKey: ['topics', 'vocabulary'],
    queryFn: ({ signal }) =>
      api
        .get<{ topics: { topicId: string; label: string; category: string }[] }>('/topics/vocabulary', {
          signal,
        })
        .then((envelope) => envelope.data.topics),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** The server caches this for `TOPICS_CACHE_TTL_SECONDS`; matching it here avoids a pointless round trip. */
const CATALOG_STALE_MS = 5 * 60_000;

/**
 * Every topic present in the caller's corpus, with counts, recent documents and
 * related topics — the Topic Explorer, and the counted filter list.
 */
export function useTopicCatalog(
  params: { subsidiaryId?: string; limit?: number; includeDiscovered?: boolean } = {},
) {
  return useQuery({
    queryKey: ['topics', 'catalog', params],
    queryFn: ({ signal }) =>
      api
        .get<{ scope: TopicScope; topics: CatalogTopic[]; computedAt: string; cached: boolean }>(
          '/topics/catalog',
          {
            query: {
              subsidiaryId: params.subsidiaryId,
              limit: params.limit,
              // The wire form is the STRING 'true'/'false', matching every other
              // boolean query parameter in this API.
              includeDiscovered:
                params.includeDiscovered === undefined ? undefined : String(params.includeDiscovered),
            },
            signal,
          },
        )
        .then((envelope) => envelope.data),
    staleTime: CATALOG_STALE_MS,
  });
}

/** §14 — the dashboard's Document Intelligence panel. */
export function useTopicAnalytics(params: { subsidiaryId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ['topics', 'analytics', params],
    queryFn: ({ signal }) =>
      api
        .get<{ scope: TopicScope; analytics: TopicAnalytics; computedAt: string; cached: boolean }>(
          '/topics/analytics',
          { query: { subsidiaryId: params.subsidiaryId, limit: params.limit }, signal },
        )
        .then((envelope) => envelope.data),
    staleTime: CATALOG_STALE_MS,
  });
}

/**
 * One document's analysis.
 *
 * `enabled` exists because the detail page mounts this beside a document that
 * may still be in the worker: extraction runs at the END of processing, so
 * asking before the document is at rest caches a `pending` record for minutes.
 * Gate it on the document being validated, exactly as the chunk and
 * extracted-field panels do.
 *
 * A 404 here is the document being absent or out of scope — never a missing
 * analysis. An unanalysed document returns 200 with `status: 'pending'`.
 */
export function useDocumentIntelligence(documentId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['documents', 'detail', documentId, 'topics'],
    queryFn: ({ signal }) =>
      api.get<DocumentIntelligence>(`/documents/${documentId}/topics`, { signal }).then((e) => e.data),
    enabled: (options.enabled ?? true) && documentId !== '',
  });
}

/** §17 — historical documents that share this one's subjects. */
export function useRelatedDocuments(
  documentId: string,
  options: { limit?: number; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ['documents', 'detail', documentId, 'related', options.limit ?? 5],
    queryFn: ({ signal }) =>
      api
        .get<{ documentId: string; related: RelatedDocument[] }>(`/documents/${documentId}/related`, {
          query: { limit: options.limit },
          signal,
        })
        .then((envelope) => envelope.data.related),
    enabled: (options.enabled ?? true) && documentId !== '',
  });
}

// ─── Mutation ────────────────────────────────────────────────────────────────

/**
 * Re-run the analysis for one document — admin and CIL User only.
 *
 * It does NOT re-read the file or re-run OCR; `useRetryDocument` is the action
 * for that. Conflating them in the UI would let a cheap button schedule an
 * expensive job.
 *
 * The corpus-wide views are invalidated as well as the document's own, because
 * re-extraction changes the counts behind the catalogue, the analytics panel
 * and the topic filter's results.
 */
export function useReprocessTopics() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (documentId: string) =>
      api.post<DocumentIntelligence>(`/documents/${documentId}/reprocess-topics`).then((e) => e.data),
    onSuccess: (data, documentId) => {
      // Written straight into the cache: the response IS the new analysis, so
      // refetching it would ask the server to repeat what it just said.
      queryClient.setQueryData(['documents', 'detail', documentId, 'topics'], data);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents', 'detail', documentId, 'related'] }),
        queryClient.invalidateQueries({ queryKey: ['topics', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: ['topics', 'analytics'] }),
        queryClient.invalidateQueries({ queryKey: ['documents', 'list'] }),
      ]);
    },
  });
}
