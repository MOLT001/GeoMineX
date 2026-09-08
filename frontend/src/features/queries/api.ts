import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { pollWhile, useCursorList, type QueryParams } from '@/lib/lists';
import {
  isQueryPending,
  type AnswerStatus,
  type QueryReviewStatus,
  type QueryStatus,
} from '@/components/ui/StatusBadge';

/**
 * Queries — ask, poll, cite, review, retry. PRD §5.4, §5.6, §13.
 *
 * Asking is asynchronous: `POST /queries` returns 201 immediately with an empty
 * `queued` row and the worker fills it in later, so every screen that asks a
 * question is really a poller. `useQueryDetail` is that poller, and the only
 * hook here that refetches on a timer.
 *
 * Server-state hooks live in the feature module; components never call the
 * client directly (§10.5).
 */

/** The three status enums are owned by StatusBadge, which also holds the
 *  predicates that depend on them. Re-exported so a screen needs one import. */
export type { AnswerStatus, QueryReviewStatus, QueryStatus };

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * One cited passage — `query.service.ts:139-154` (`visibleCitations`).
 *
 * The stored `subsidiaryId` is stripped from the response (it is the read-time
 * filter key, not something to render), and the array is hard-capped at 20
 * entries (`MAX_CITATIONS`, citation.ts:38). Size the citation list for 20 rows.
 */
export interface QueryCitation {
  /**
   * The number inside the `[n]` marker in `responseText`, assigned at write
   * time as `citations.length + 1` (citation.ts:105).
   *
   * NOT an array index, and not guaranteed contiguous in a response: the array
   * is re-filtered against the CALLER's CURRENT grants on every read, so a
   * grant revoked after the answer was written removes the entry and leaves the
   * marker behind. Resolve markers with `parseAnswerSegments`, never by
   * position.
   */
  ordinal: number;
  documentId: string;
  /** The parent document's `originalFilename`, denormalised at retrieval time. */
  documentFilename: string;
  chunkId: string;
  /** 0-based position of the chunk within its document. */
  chunkIndex: number;
  pageNumber: number | null;
  section: string | null;
  /** Server-sliced from the stored chunk (default 300 chars). Never model
   *  output — this is the verbatim source text §13 requires us to show. */
  quote: string;
  /**
   * MongoDB `$text` score, and 0 on the pinned-document fallback path
   * (retrieval.service.ts:171). Explicitly NOT a confidence score
   * (query.model.ts:69) — rendering it as one misrepresents it, and a perfectly
   * good answer can carry 0 on every citation.
   */
  relevance: number;
}

/** `query.service.ts:200`. Note the field name — see `QuerySummary`. */
export interface QueryRetrievalStats {
  /** The candidate pool after the scoped search, before the per-document cap.
   *  Can be greater than 0 while `passagesUsed` is 0. */
  candidatesConsidered: number;
  passagesUsed: number;
  /** Dropped by the prompt-injection scanner before the model saw them. */
  passagesWithheld: number;
  /** The SAME number the summary shape calls `discardedCitationCount`. */
  discardedCitations: number;
}

/**
 * The full row — `POST /queries`, `GET /queries/:id`, `PATCH /queries/:id` and
 * `POST /queries/:id/retry` all return this shape (query.service.ts:176-220).
 *
 * Every nullable key is ALWAYS PRESENT with an explicit null (the presenter
 * runs `?? null` over each one), so `'field' in query` tells you nothing — test
 * the value.
 */
export interface QueryDetail {
  id: string;
  /** A bare 24-hex user id. Nothing in this module expands it, so an
   *  "Asked by <name>" line needs a separate lookup against the users module.
   *  Same for `reviewedBy`, `linkedReportId` and `citations[].documentId`. */
  askedBy: string;
  questionText: string;
  isParliamentary: boolean;
  /** The authorization scope resolved at ask time; `subsidiaryIds` is never
   *  empty. This — not `subsidiaryId` — is the real scope of the answer. */
  contextScope: {
    subsidiaryIds: string[];
    documentIds: string[];
  };
  /** Denormalised convenience only, and null whenever the scope covers more
   *  than one subsidiary (query.service.ts:341) — which is every group-wide
   *  admin ask. A table column bound to it is blank for those rows. */
  subsidiaryId: string | null;
  status: QueryStatus;
  reviewStatus: QueryReviewStatus;
  /**
   * Null for `queued` | `retrieving` | `answering` AND for `failed` |
   * `dead_lettered`: only `finish()` writes it, and the failure paths never
   * reach it (query.worker.ts:404-446). So a query that has stopped moving can
   * still have no text — "not moving" does not mean "has an answer".
   *
   * On the zero-retrieval `unsupported` path it is a fixed server-authored
   * sentence the provider never saw (query.worker.ts:217-218), not model
   * output. It carries raw `[n]` markers; render it through
   * `parseAnswerSegments`.
   */
  responseText: string | null;
  /** The human's answer, set only via PATCH. Never model-produced. */
  officialResponseText: string | null;
  /** Non-null only alongside `answered` (`sourced` | `partially_sourced`) and
   *  `unsupported` (`unsupported`). The pairs never cross. */
  answerStatus: AnswerStatus | null;
  /** `[]` until an answer is written, re-filtered per caller on every read, and
   *  at most 20 entries. */
  citations: QueryCitation[];
  retrieval: QueryRetrievalStats;
  /**
   * Pre-rendered English sentences (query.service.ts:157-173), not codes, and
   * `[]` when nothing was lost. There is nothing machine-readable to parse — to
   * branch, use `retrieval.passagesWithheld`, `retrieval.discardedCitations`
   * and `answerStatus`. Detail-only; the summary has no equivalent.
   */
  warnings: string[];
  injectionSuspected: boolean;
  /** The shipped local extractive adapter reports literally `'local'`. Written
   *  for both `answered` and `unsupported`, null on every other status. */
  provider: string | null;
  /** e.g. `'geominex-p2-extractive-v1'`. Same nullability as `provider`. */
  promptVersion: string | null;
  /** Milliseconds, and legitimately 0 on the zero-retrieval `unsupported`
   *  path. Same nullability as `provider`. */
  generationMs: number | null;
  /** Incremented when the worker CLAIMS the job, not at enqueue — so a freshly
   *  queued row reads 0 and a once-failed row reads 1. */
  attempts: number;
  /** One of four fixed sentences — see `QUERY_FAILURE_REASONS`. `$unset` on a
   *  successful re-claim, so an answered row never carries a stale reason. */
  failureReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  linkedReportId: string | null;
  /** Stamped by `finish()`, so non-null for `unsupported` as well as
   *  `answered`, and null for both failure states. */
  answeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The list row — the ONLY shape `GET /queries` returns
 * (query.service.ts:223-243).
 *
 * It is not a trimmed `QueryDetail` you can widen locally: there is no
 * `responseText`, no `citations`, no `retrieval`, no `contextScope` and no
 * `warnings`, so a row cannot be expanded in place without fetching the detail.
 */
export interface QuerySummary {
  id: string;
  askedBy: string;
  questionText: string;
  isParliamentary: boolean;
  status: QueryStatus;
  reviewStatus: QueryReviewStatus;
  answerStatus: AnswerStatus | null;
  /**
   * A raw `responseText.slice(0, 200)` — no ellipsis, no marker stripping. It
   * can end mid-word, and it can contain a `[3]` marker that this shape has no
   * citations array to resolve. Strip markers before showing it.
   */
  answerPreview: string | null;
  /** Counted AFTER read-time grant filtering, so it can be lower than the
   *  number of markers in the answer. */
  citationCount: number;
  /** The summary's name for `QueryRetrievalStats.discardedCitations`. A shared
   *  component that reads one shape's name off the other silently gets
   *  `undefined` (query.service.ts:200 vs :235). */
  discardedCitationCount: number;
  injectionSuspected: boolean;
  reviewedBy: string | null;
  linkedReportId: string | null;
  subsidiaryId: string | null;
  createdAt: string;
  answeredAt: string | null;
}

// ─── Requests ────────────────────────────────────────────────────────────────

/** `POST /queries` — query.schema.ts:23-30. */
export interface CreateQueryBody {
  /**
   * 10-2000 characters, inclusive at both ends, measured AFTER NFKC
   * normalisation and invisible-character stripping (utils/safeText.ts:41-52) —
   * so a counter bound to `value.length` can read 10 while the server sees 0.
   */
  questionText: string;
  /** A real JSON boolean here, unlike the list filter. `true` creates the row
   *  with `reviewStatus: 'pending'` and selects the parliamentary answer style;
   *  there is no separate `style` field. */
  isParliamentary?: boolean;
  /** Omit for "every subsidiary the caller holds". */
  subsidiaryId?: string;
  /**
   * Max 25, and ALL-OR-NOTHING: one id that is missing, out of scope, or whose
   * document status is not `validated` rejects the whole request without saying
   * which (query.service.ts:111-120). Restrict the picker to validated
   * documents.
   */
  documentIds?: string[];
}

/** `GET /queries` — query.schema.ts:32-44. Every key is optional. */
export interface ListQueriesParams {
  /** 1-100, default 25. */
  limit?: number;
  /** An array-CONTAINS ("touches") filter, not scope-equality
   *  (query.service.ts:294): a query scoped to {A, B} still appears when
   *  filtering on A, carrying `subsidiaryId: null`. There is no filter for
   *  "scoped to A only". An id the caller does not hold is a 404, never a 403. */
  subsidiaryId?: string;
  status?: QueryStatus;
  /** All four values filter here, including `not_required` — even though the
   *  PATCH body cannot set that one. */
  reviewStatus?: QueryReviewStatus;
  /** A STRING enum on the wire, not a boolean (query.schema.ts:39-40).
   *  `?isParliamentary=1` is a 400. */
  isParliamentary?: 'true' | 'false';
  /** Also a string enum, and it SILENTLY OVERRIDES `askedBy`
   *  (query.service.ts:299-300) — sending both yields the caller's own rows,
   *  not an intersection and not an error. */
  mine?: 'true' | 'false';
  askedBy?: string;
  /**
   * Full-text search over `questionText` and `responseText` only, 2-120 chars.
   * `officialResponseText` and citation quotes are deliberately outside the
   * index, so a human-written official response is unsearchable. Results stay
   * sorted newest-first — relevance ordering is discarded for cursor
   * stability — so never label these "best match".
   */
  q?: string;
}

/** `PATCH /queries/:id` — query.schema.ts:59-67. At least one key is required;
 *  an empty body is a 400 carrying `fields.body`. */
export interface ReviewQueryBody {
  /** 1-2000 chars after normalisation. `''` is rejected. */
  officialResponseText?: string;
  /** `not_required` is not settable — there is no route back to it. */
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  /** 0-500 chars; `''` is accepted and clears the note. */
  reviewNote?: string;
  /** A 24-hex id links, an explicit `null` unlinks, absent leaves it alone. An
   *  id outside the query's own scope is a 404 "Report not found". */
  linkedReportId?: string | null;
  /** A real JSON boolean. It does NOT recompute `reviewStatus`
   *  (query.service.ts:419) — a query flipped to parliamentary after the fact
   *  stays `not_required` unless `reviewStatus` moves in the same PATCH. */
  isParliamentary?: boolean;
}

export interface ReviewQueryVariables extends ReviewQueryBody {
  id: string;
}

/**
 * What `POST /queries/:id/retry` can actually be trusted to say.
 *
 * The endpoint returns a whole `QueryDetail`, but it is the PRE-retry document
 * with only `status` spread-overwritten (query.service.ts:476-477), so
 * `failureReason`, `attempts`, `responseText` and `answerStatus` are all the
 * failed run's values. `useRetryQuery` throws the rest away rather than let a
 * component render a resurrected failure message under a "Queued" badge.
 */
export interface RetryQueryResult {
  id: string;
  status: 'queued';
}

// ─── Failure reasons ─────────────────────────────────────────────────────────

/** The four fixed strings `failureReason` can hold (query.worker.ts:165, :348,
 *  :349, :494). The string is the only signal separating these cases. */
export const QUERY_FAILURE_REASONS = [
  'Access to the queried subsidiaries is no longer available',
  'Answer generation failed; retry available',
  'Answer generation failed repeatedly; manual review required',
  'Answer generation was interrupted repeatedly; manual review required',
] as const;

/**
 * The asker lost access to the queried subsidiaries between asking and
 * answering (query.worker.ts:159-168).
 *
 * Worth its own branch: the status is `failed`, so the generic Retry
 * affordance lights up, but a retry re-runs the same authorization check and
 * fails identically. This is also the only path that can leave a `failed` row
 * with its attempts already spent, which answers 400 "Retry limit reached" —
 * the ordinary generation failure dead-letters instead.
 */
export function isScopeRevokedFailure(failureReason: string | null): boolean {
  return failureReason === QUERY_FAILURE_REASONS[0];
}

// ─── Review gating ───────────────────────────────────────────────────────────

/**
 * Whether `reviewStatus` may be changed AT ALL right now (query.service.ts:395).
 *
 * Only `answered` and `unsupported`; anything else is 400 INVALID_REQUEST
 * 'A query cannot be reviewed while its status is "<status>"'. Deliberately NOT
 * `isQueryTerminal` from StatusBadge, which also admits `dead_lettered` — a
 * review form gated on that offers Approve/Reject on a row the server refuses.
 *
 * This gates the `reviewStatus` FIELD, not the endpoint: `officialResponseText`,
 * `reviewNote`, `linkedReportId` and `isParliamentary` have no status gate and
 * may be PATCHed at any status, including `queued`. Approve additionally needs
 * `role === 'admin'` — see `useReviewQuery`.
 */
export function canSetReviewStatus(status: QueryStatus): boolean {
  return status === 'answered' || status === 'unsupported';
}

// ─── Answer + citation rendering ─────────────────────────────────────────────

/** One piece of an answer: prose, or a resolved marker. */
export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; ordinal: number; citation: QueryCitation };

/** Deliberately not global. `split` ignores the flag anyway, and a shared `/g/`
 *  regex carries `lastIndex` between calls, which drops every other marker. */
const CITATION_MARKER = /\[(\d+)\]/;

/**
 * Split `responseText` into prose and citation markers — §13's whole point.
 *
 * Three things the naive version gets wrong:
 *
 *   1. A marker is matched to its citation by `ordinal`, NEVER by array
 *      position. Ordinals are assigned at write time and the array is
 *      re-filtered against the reader's current grants, so `citations[n - 1]`
 *      can name a completely different source than `[n]` does.
 *   2. An unresolvable marker comes back as INERT TEXT with its brackets
 *      intact. It is rare — over-limit and duplicate-chunk refs have their
 *      markers stripped server-side (citation.ts:150), leaving only the
 *      grant-revocation case — but a dead link into a source the reader is no
 *      longer allowed to open is exactly the traceability failure §13 forbids.
 *   3. `responseText` is null on both failure paths, which yields `[]`.
 *
 * Runs of prose come back merged, so an unmatched marker does not fragment a
 * paragraph into three separate text segments.
 */
export function parseAnswerSegments(
  responseText: string | null,
  citations: readonly QueryCitation[],
): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  if (!responseText) return segments;

  const pushText = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last && last.kind === 'text') last.text += text;
    else segments.push({ kind: 'text', text });
  };

  // `split` with a capturing group interleaves the captures with the prose:
  // 'a [1] b' -> ['a ', '1', ' b']. Even indices are prose, odd are the digits.
  responseText.split(CITATION_MARKER).forEach((part, index) => {
    if (index % 2 === 0) {
      pushText(part);
      return;
    }
    const ordinal = Number(part);
    const citation = citations.find((c) => c.ordinal === ordinal);
    if (citation) segments.push({ kind: 'citation', ordinal, citation });
    else pushText(`[${part}]`);
  });

  return segments;
}

// ─── Query keys ──────────────────────────────────────────────────────────────

const listKey = ['queries', 'list'] as const;
const detailKey = (id: string) => ['queries', 'detail', id] as const;

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * The query list.
 *
 * Named `useQueriesList` rather than `useQueries` because TanStack exports a
 * hook by that name and a screen may well import both.
 *
 * Cursor-paginated, so there is no total and no page count: `nextCursor` going
 * null is the ONLY end-of-list signal, and a short page is not one.
 */
export function useQueriesList(
  { limit = 25, ...filters }: ListQueriesParams = {},
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  /**
   * The seven filters are listed out rather than spread from `filters`.
   *
   * `rejectOperatorInjection` (utils/sanitize.ts:31-38, mounted at app.ts:102)
   * rejects the WHOLE request with 400 VALIDATION_ERROR if any query KEY
   * contains `$`, `.` or `[$`, and it runs before route validation — Zod only
   * strips unknown keys, and only afterwards. Forwarding whatever else happens
   * to sit on a screen's filter-state object therefore turns a working list
   * into a hard failure rather than an ignored param.
   */
  const params: QueryParams = {
    subsidiaryId: filters.subsidiaryId,
    status: filters.status,
    reviewStatus: filters.reviewStatus,
    isParliamentary: filters.isParliamentary,
    mine: filters.mine,
    askedBy: filters.askedBy,
    q: filters.q,
  };

  return useCursorList<QuerySummary>({
    key: listKey,
    path: '/queries',
    params,
    limit,
    enabled: options.enabled ?? true,
    // Optional, and it refetches EVERY page loaded so far — cheap at one page,
    // not at ten. Prefer letting `useQueryDetail` poll the row the user is
    // actually watching; the mutations below invalidate this list anyway.
    refetchInterval: options.refetchInterval ?? false,
  });
}

/**
 * One query, polled while the worker is still working on it.
 *
 * The interval is recomputed from the freshest status on every tick, which is
 * what makes a BACKWARD transition safe: `recoverStuckQueries()` resets rows
 * stranded in `retrieving`/`answering` back to `queued` on boot with no age
 * guard (query.worker.ts:482-537), so a status can regress with no user action
 * and polling must simply carry on. A progress indicator driven off status has
 * to tolerate the same thing.
 *
 * Polling stops on `answered` | `unsupported` | `failed` | `dead_lettered` —
 * `failed` included, because nothing moves a failed row without an explicit
 * retry, so a client waiting for `answered` would poll a stationary row
 * forever. `isQueryPending` encodes exactly that set.
 */
export function useQueryDetail(id: string | undefined, pollIntervalMs = 1500) {
  return useQuery({
    queryKey: detailKey(id ?? ''),
    queryFn: async ({ signal }) => {
      const { data } = await api.get<QueryDetail>(`/queries/${id}`, { signal });
      return data;
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Nothing fetched yet: leave the timer off. The in-flight initial fetch
      // re-evaluates this callback when it settles.
      if (!status) return false;
      // `pollWhile` also returns false in a hidden tab — a background tab
      // polling at 1.5s is how a user hits the 100/min global limit on a screen
      // they are not looking at.
      return pollWhile(isQueryPending(status), pollIntervalMs);
    },
    /**
     * These two are what RESUMES polling after a hidden tab paused it.
     *
     * `pollWhile` returning false clears the timer, and nothing re-evaluates it
     * until the query updates again. TanStack's focus manager fires on
     * `visibilitychange`, so re-showing the tab refetches — but only if the data
     * is stale, and the app-wide default is 30s. A row that changes every second
     * must not carry that default, or returning to the tab shows a frozen
     * "Retrieving sources" until something else happens to poke the cache.
     *
     * The cost is bounded: `GET /queries/:id` is not AI-limited, only globally.
     */
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Ask a question — `POST /queries`, 201 with an empty `queued` row.
 *
 * There is no answer in this response and there will not be one for seconds:
 * hand the returned id to `useQueryDetail` and let it poll. Errors worth
 * distinguishing: 400 `INVALID_REQUEST` "Only validated documents can be
 * queried", 404 for a document or subsidiary outside the caller's grants (never
 * 403), and 429 from `aiLimiter` — which is keyed on the USER id, shares its
 * 12/minute budget with retry, and, because it runs before validation, is
 * consumed even by requests that are then rejected as malformed.
 */
export function useAskQuery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateQueryBody) => {
      const { data } = await api.post<QueryDetail>('/queries', body);
      return data;
    },
    onSuccess: (created) => {
      // Genuinely fresh, unlike retry's response, so seeding the detail cache is
      // safe here and lets the answer screen paint the question immediately
      // instead of spinning through its first poll.
      queryClient.setQueryData(detailKey(created.id), created);
      // §10.5: invalidate on every mutation. The dashboard's `pendingWork` feed
      // carries queries, so it goes stale on all three of these.
      void queryClient.invalidateQueries({ queryKey: listKey });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/**
 * Review a query — `PATCH /queries/:id`.
 *
 * TWO permission gates, and only the first is a route guard. A `moc_official`
 * is refused the endpoint outright for ANY body, even a bare `reviewNote`. But
 * `reviewStatus: 'approved'` is admin-only and is checked in the SERVICE
 * (query.service.ts:391-394), so a `cil_user` sails through the route and then
 * takes a 403 — gate the Approve control on `role === 'admin'` in the UI, or
 * the user meets an avoidable error.
 *
 * `reviewStatus` also has a status gate: it may only change while the query is
 * `answered` or `unsupported`, otherwise 400. The other four fields have no
 * such gate and can be set at any status, including `queued`. The admin check
 * runs FIRST, so a `cil_user` approving a queued row sees the 403, not the 400.
 */
export function useReviewQuery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: ReviewQueryVariables) => {
      const { data } = await api.patch<QueryDetail>(`/queries/${id}`, body);
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(detailKey(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: listKey });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/**
 * Re-enqueue a failed query — `POST /queries/:id/retry`, 200 rather than 201
 * because it creates nothing.
 *
 * Offer this ONLY for `status === 'failed'` (`canRetryQuery` in StatusBadge).
 * `dead_lettered` is terminal and answers 400, and a non-author who is not an
 * admin gets 403 even though they can see the row.
 *
 * The response body is deliberately DISCARDED except for `status`: it is the
 * pre-retry snapshot with one field overwritten, so writing it whole into the
 * cache would resurrect the old `failureReason` and a stale `attempts` count
 * beside a "Queued" badge.
 *
 * That one trustworthy field IS written onto the cached row, and it has to be.
 * `useQueryDetail` stopped polling the moment the row read `failed`, so nothing
 * would ever restart it. Invalidating the detail key instead is worse than
 * doing nothing: the retry does not write `queued` to the database — the
 * worker's atomic claim accepts `status $in ['queued','failed']`
 * (query.worker.ts:125), which is exactly why it does not have to — so a
 * refetch that races the claim reads `failed` straight back, and the row sits
 * frozen under a "Failed" badge while the worker quietly answers it. Writing
 * `queued` locally re-arms the timer, and the poller's own next tick re-reads
 * the row once the claim has landed.
 */
export function useRetryQuery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<RetryQueryResult> => {
      await api.post<QueryDetail>(`/queries/${id}/retry`);
      return { id, status: 'queued' };
    },
    onSuccess: ({ id }) => {
      // No cached row (retried from the list, detail never opened) means there
      // is no poller to re-arm; the updater returning `previous` leaves the
      // cache untouched rather than seeding a one-field ghost row.
      queryClient.setQueryData<QueryDetail>(detailKey(id), (previous) =>
        previous ? { ...previous, status: 'queued' } : previous,
      );
      void queryClient.invalidateQueries({ queryKey: listKey });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
