import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fetchDocumentBlob } from '@/lib/api/client';
import { ApiError, NetworkError, classifyAuthFailure, type ApiErrorBody } from '@/lib/api/errors';
import { ensureFresh, refresh, SessionExpiredError } from '@/auth/refreshManager';
import { tokenStore } from '@/auth/tokenStore';
import { API_PREFIX } from '@/lib/env';
import { pollWhile, useCursorList } from '@/lib/lists';
import { isDocumentPending, type DocumentStatus } from '@/components/ui/StatusBadge';

/**
 * Documents — PRD §5.4, §5.5, §8.2.
 *
 * Server state for the ingestion pipeline: upload, the cursor-paginated list,
 * the detail row the UI polls while the worker runs, the chunk and
 * extracted-field reads, retry, and the human override of a single field.
 *
 * Components consume the hooks below and never call `api` themselves (§10.5).
 *
 * The two facts that shape the whole module:
 *
 *   1. Processing is ASYNCHRONOUS and there is no webhook, no SSE and no
 *      dedicated status endpoint. `GET /documents/:id` is the only way to learn
 *      that a document finished, so `useDocument` polls (document.worker.ts).
 *   2. `/documents` is CURSOR-paginated, so there is no total and no page
 *      count — only `hasNextPage` (backend/src/utils/envelope.ts:29-37).
 */

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Re-exported rather than redeclared: the enum, its badge, `isDocumentPending`
 * and `canRetryDocument` all live in `components/ui/StatusBadge`, and a second
 * copy of the value list here is how the two drift apart.
 */
export type { DocumentStatus };

/**
 * `document.model.ts:4` — the complete set, derived from the FILE EXTENSION
 * rather than from the contents. Only `.tif`/`.tiff` map to 'scan'; a scanned,
 * image-only PDF is still type 'pdf' and is recognised by `ocrConfidence` 0 with
 * zero extracted fields, not by this field. `.csv` and `.txt` both map to
 * 'spreadsheet'.
 */
export type DocumentType = 'pdf' | 'scan' | 'spreadsheet' | 'image';

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * The only document shape the API ever returns — `present()` in
 * document.service.ts:52-76. List rows, `GET /:id`, the 201 from upload and the
 * 200 from retry are all identical.
 *
 * Deliberately absent, and not worth waiting for: `storageKey`, `checksum`,
 * `injectionRuleIds` (publishing which patterns fired tells an author which to
 * avoid), `isDeleted`, `deletedAt` and `updatedAt`. There is no `updatedAt` on
 * a document — do not build a "last modified" column.
 */
export interface Document {
  id: string;
  subsidiaryId: string;
  /** User id. The API does not expand it; resolve the name from the users module. */
  uploadedBy: string;
  originalFilename: string;
  /**
   * The RESOLVED mime, not the one the browser declared (fileValidation.ts:114,
   * :132). For binary formats it is the magic-byte sniff, which for an `.xlsx`
   * is legitimately 'application/zip' because the format is a zip container.
   * Switch UI on `type`, never on this.
   */
  mimeType: string;
  sizeBytes: number;
  type: DocumentType;
  status: DocumentStatus;
  /** 0..1, null until the worker finishes. The key is always present. */
  ocrConfidence: number | null;
  /**
   * Stored, and computed by the worker as
   * `(ocrConfidence <= OCR_REVIEW_THRESHOLD || fields.length === 0) || injectionSuspected`
   * (document.worker.ts:139-140, :164). So a document with zero extracted fields
   * is always flagged, and `injectionSuspected` forces it true even when OCR was
   * confident. NOT the same value as `ExtractedField.requiresReview`, which is
   * derived per field at read time.
   */
  requiresReview: boolean;
  /** §9.5 ingestion-time prompt-injection flag. Implies `requiresReview`, never the reverse. */
  injectionSuspected: boolean;
  /** Auto tags (subsidiary CODE, 'YYYY-MM', the resolved type) merged with operator tags. Never null. */
  tags: string[];
  /**
   * Null unless `status === 'failed'` — with one exception: the body returned by
   * `POST /:id/retry` still carries the previous failure string. See
   * `useRetryDocument`.
   */
  processingError: string | null;
  /**
   * Incremented by the worker when it CLAIMS the job, not at enqueue
   * (document.worker.ts:86-90), so a freshly failed document reads 1, not 0.
   * `canRetryDocument` in StatusBadge is the guard that reads it.
   */
  processingAttempts: number;
  processedAt: string | null;
  createdAt: string;
}

/**
 * document.service.ts:271-277, sorted by `chunkIndex` ascending.
 *
 * No `documentId` or `subsidiaryId` on the row — you already know the document.
 * Chunk ids are NOT stable: a retry deletes and re-inserts every chunk
 * (document.worker.ts:105), so nothing may persist one across a reprocess.
 */
export interface DocumentChunk {
  id: string;
  chunkIndex: number;
  /** Max ~1200 characters (local.adapter.ts:24). */
  text: string;
  /**
   * A number ONLY for digital PDFs (local.adapter.ts:130-135). Always null for
   * `.csv`/`.txt`, whose text path never attaches a page.
   */
  pageNumber: number | null;
  /** ALWAYS null today — the only extraction provider never writes a section. */
  section: string | null;
}

/**
 * Inner keys are individually ABSENT when unset, never null
 * (extractedField.model.ts:36-40) — hence `?` rather than `| null`.
 *
 * With the bundled local provider this is always `{ pageNumber?, chunkIndex: 0 }`:
 * `section` is never written, and `chunkIndex` is HARD-CODED to 0
 * (local.adapter.ts:87). It is not a pointer into the chunk array, so do not use
 * it to scroll a citation into view — it points at chunk 0 for every field.
 */
export interface ExtractedFieldSourceLocation {
  pageNumber?: number;
  section?: string;
  chunkIndex?: number;
}

/**
 * document.service.ts:286-299, sorted by `fieldName` ascending.
 *
 * `fieldName` is NOT unique in the array. On reprocess the worker deletes only
 * the fields nobody overrode (document.worker.ts:106) and re-inserts the full
 * fresh set, so a human-corrected field survives alongside a new machine row
 * with the same name. Key every list, map and React `key` on `id`.
 */
export interface ExtractedField {
  id: string;
  documentId: string;
  fieldName: string;
  /** The CURRENT value — after an override this is the human's value. */
  value: string;
  /**
   * 0..1. With the local provider it is exactly 0.82 (the value looked numeric)
   * or 0.6 (anything else) — local.adapter.ts:86. A review UI sees two buckets,
   * not a spread, so a confidence bar reads as broken; prefer the flag.
   */
  confidenceScore: number;
  /**
   * DERIVED on every read as `confidenceScore <= OCR_REVIEW_THRESHOLD`
   * (document.service.ts:293, default 0.75 — note `<=`, so exactly 0.75 needs
   * review). It is not stored, and it is NOT cleared by an override: a corrected
   * field keeps its original score and can still report true.
   */
  requiresReview: boolean;
  /** Non-null with the bundled provider; null only if a future provider omits it. */
  sourceLocation: ExtractedFieldSourceLocation | null;
  overriddenBy: string | null;
  overrideReason: string | null;
  overriddenAt: string | null;
  /** The FIRST machine value, preserved across repeat overrides (document.service.ts:360). */
  originalValue: string | null;
}

/**
 * The body of `PATCH /extracted-fields/:id` — document.service.ts:383-390.
 *
 * Deliberately NARROWER than `ExtractedField`: no `documentId`,
 * `confidenceScore`, `requiresReview`, `sourceLocation` and, notably, no
 * `overriddenBy`. Do not merge this into a cached row;
 * `useOverrideExtractedField` refetches the list instead.
 */
export interface ExtractedFieldOverrideResult {
  id: string;
  fieldName: string;
  value: string;
  originalValue: string;
  overrideReason: string;
  overriddenAt: string;
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * `GET /documents` filters — document.schema.ts:19-29, minus `limit` and
 * `cursor`, which `useCursorList` owns.
 *
 * `injectionSuspected` is NOT here and must not be added. The service reads it
 * (document.service.ts:172-187) but the Zod schema does not declare the key, and
 * Zod strips unknown keys, so `?injectionSuspected=true` is silently DISCARDED
 * and the list comes back unfiltered — wrong results with no error. To surface
 * flagged documents today, filter `requiresReview: 'true'` here and narrow on
 * the `injectionSuspected` field of the rows you loaded, remembering a cursor
 * list only ever knows about the pages it has fetched.
 */
export interface DocumentFilters {
  /**
   * A subsidiary a non-admin does not hold does NOT narrow the result to empty:
   * `assertSubsidiaryAccess` throws and the WHOLE request is 404 NOT_FOUND
   * (document.service.ts:83-85 → authorization.ts:46-54). Render the error; an
   * empty table would be a lie. A non-admin with no grants at all gets a genuine
   * empty list.
   */
  subsidiaryId?: string;
  status?: DocumentStatus;
  type?: DocumentType;
  /**
   * A STRING enum, not a boolean — `z.coerce.boolean()` would read the literal
   * 'false' as true and invert the filter, so the schema takes the literals
   * instead. '1', 'yes' and an empty value are all 400s. Omit the key to not
   * filter.
   */
  requiresReview?: 'true' | 'false';
  /**
   * Mongo `$text` over the `{ originalFilename, tags }` index ONLY
   * (document.model.ts:100) — never over extracted values (§8.2). 1..120 chars.
   * Relevance does not affect ordering; the sort stays `_id` descending.
   */
  q?: string;
}

/**
 * The document list, newest first.
 *
 * Cursor-paginated, so `hasNextPage`/`fetchNextPage` are the only navigation:
 * there is no total, no page count and no way to jump. Report `items.length` as
 * "N loaded" and nothing more.
 *
 * `refetchInterval` is a caller opt-in rather than a default because refetching
 * an infinite query re-requests EVERY loaded page — on a list scrolled to page
 * six that is six requests against a 100/60s limiter. Poll the detail row
 * instead where you can, and pass `pollWhile(...)` here only for a short-lived
 * "waiting for my upload" view.
 */
export function useDocuments(
  filters: DocumentFilters = {},
  options: { limit?: number; enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useCursorList<Document>({
    key: ['documents', 'list'],
    path: '/documents',
    // Listed key by key rather than spread, so nothing a caller happens to be
    // carrying on its filter object can reach the wire — notably
    // `injectionSuspected`, which the schema strips in silence.
    params: {
      subsidiaryId: filters.subsidiaryId,
      status: filters.status,
      type: filters.type,
      requiresReview: filters.requiresReview,
      q: filters.q,
    },
    limit: options.limit ?? 25,
    enabled: options.enabled ?? true,
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
  });
}

// ─── Detail ──────────────────────────────────────────────────────────────────

/** How often to ask whether the worker has finished. */
const DOCUMENT_POLL_MS = 3000;

/**
 * One document, polling itself while the worker still has it.
 *
 * `queued` counts as in-flight in both directions: `recoverStuckDocuments()`
 * resets anything stranded in `processing` back to `queued` on boot
 * (document.worker.ts:260-284), so a document can travel BACKWARDS without any
 * client action, and a poller that reads that as terminal stops watching a
 * document about to start again. `isDocumentPending` already encodes this.
 *
 * `refetchOnWindowFocus` is switched back on for this query alone, and it needs
 * `staleTime: 0` beside it to do anything — see the note on the options.
 *
 * A 404 here is indistinguishable between "no such id", "soft-deleted" and
 * "belongs to a subsidiary you do not hold" (authorization.ts:1-18). Do not try
 * to tell the user which; that is the point of the convention.
 */
export function useDocument(documentId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['documents', 'detail', documentId],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<Document>(`/documents/${documentId}`, { signal });
      return data;
    },
    enabled: (options.enabled ?? true) && documentId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return pollWhile(status !== undefined && isDocumentPending(status), DOCUMENT_POLL_MS);
    },
    /**
     * These two are what RESUMES polling, and neither works alone.
     *
     * `pollWhile` returns false in a hidden tab — deliberately, so a background
     * tab does not spend the 100/60s budget — and the moment a fetch settles
     * while hidden, TanStack recomputes the interval, gets `false`, and CLEARS
     * the timer. Only a refetch re-evaluates `refetchInterval` after that. But
     * `refetchOnWindowFocus` fires a refetch only when the row is STALE, and the
     * app-wide default is `staleTime: 30_000` (lib/queryClient.ts) — a row polled
     * three seconds ago is fresh, the focus refetch is skipped, and the document
     * sits on 'processing' with the timer off until something else pokes the
     * cache. `staleTime: 0` is the half that makes the focus refetch actually
     * fire; the cost is bounded, since this route carries no limiter but the
     * global one.
     */
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Every chunk of a document, in one unpaginated array.
 *
 * There is no `limit` parameter and no server-side cap, so a large PDF's chunks
 * can be a multi-megabyte response — virtualise the list and expect a slow first
 * load. Nested under the detail key so a retry invalidation reaches it.
 *
 * `[]` is a 200 and a NORMAL outcome, not an error state: while the document is
 * queued or processing, and permanently for every image, `.tif` scan and
 * `.xlsx`, plus any scanned or encrypted PDF (local.adapter.ts:117, :152-161).
 * Those documents still reach 'validated'.
 *
 * GATE THIS on the document being settled —
 * `enabled: doc !== undefined && !isDocumentPending(doc.status)`. Nothing
 * invalidates this key when the worker finishes; only a retry does. Fetch it
 * while the document is still queued and the empty array is cached fresh for the
 * five minutes below, so the chunk list stays empty long after the text arrived.
 */
export function useDocumentChunks(documentId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['documents', 'detail', documentId, 'chunks'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<DocumentChunk[]>(`/documents/${documentId}/chunks`, { signal });
      return data;
    },
    enabled: (options.enabled ?? true) && documentId.length > 0,
    // Chunks change only when the worker reprocesses, and a retry invalidates
    // this key explicitly — so a long stale window costs nothing and saves
    // re-downloading megabytes on every tab switch.
    staleTime: 5 * 60_000,
  });
}

/**
 * Every extracted field, unpaginated, sorted by `fieldName`.
 *
 * Capped at 100 fields per document by the provider (local.adapter.ts:90). Empty
 * until the document reaches 'validated', and permanently empty for the file
 * types the local provider cannot read. Remember `fieldName` is not unique after
 * a retry — key on `id`.
 *
 * Gate it the same way as the chunks above: the worker finishing does not
 * invalidate this key, so an empty array fetched while the document was queued
 * survives until it goes stale on its own.
 */
export function useExtractedFields(documentId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['documents', 'detail', documentId, 'extracted-fields'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<ExtractedField[]>(
        `/documents/${documentId}/extracted-fields`,
        { signal },
      );
      return data;
    },
    enabled: (options.enabled ?? true) && documentId.length > 0,
  });
}

// ─── Preview ─────────────────────────────────────────────────────────────────

export interface DocumentBlobResult {
  /** Object URL for the fetched bytes, revoked automatically. Null until loaded. */
  url: string | null;
  blob: Blob | null;
  /** True only while bytes are actually in flight — a disabled hook reports false. */
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * The original uploaded bytes, as an object URL suitable for a preview.
 *
 * `GET /documents/:id/file` cannot be an `<iframe src>`: it needs a bearer
 * header the browser will not attach to a subresource load, and it answers with
 * `Content-Disposition: attachment`. `fetchDocumentBlob` handles the
 * success-is-bytes / failure-is-JSON split that the route's dual content type
 * forces on every client.
 *
 * The object URL is created in an effect and revoked in its cleanup, so it dies
 * with the component; React's double-invoked effects in development revoke the
 * first URL and hand back a live second one, which is correct.
 *
 * Do NOT parse `Content-Disposition` for a name — the header carries only the
 * RFC 5987 `filename*` form with no legacy fallback. Read `originalFilename` off
 * `useDocument`, and choose the viewer from `type` rather than `mimeType`, which
 * is 'application/zip' for a perfectly ordinary spreadsheet.
 */
export function useDocumentBlob(
  documentId: string,
  options: { enabled?: boolean } = {},
): DocumentBlobResult {
  const query = useQuery({
    // Deliberately NOT under ['documents','detail',id]: the stored bytes are
    // immutable, so a status poll or a retry invalidation must never trigger a
    // re-download of up to 25 MiB.
    queryKey: ['documents', 'file', documentId],
    queryFn: ({ signal }) => fetchDocumentBlob(documentId, signal),
    enabled: (options.enabled ?? true) && documentId.length > 0,
    staleTime: Infinity,
    // The cache entry IS the file. The 5-minute default would hold every
    // previewed document in memory at full size; a minute still makes
    // close-and-reopen free.
    gcTime: 60_000,
    // The global policy retries twice on a 5xx, which here means downloading the
    // file up to three times. Surface the failure and let the user ask again.
    retry: false,
  });

  const blob = query.data ?? null;

  /**
   * The URL is stored WITH the blob it was minted from, and read back only when
   * the two still agree. That keeps the effect to a single job — create, and
   * revoke on cleanup — with no state write for the empty case and no window in
   * which a URL belonging to a previous document is handed to a caller.
   */
  const [minted, setMinted] = useState<{ blob: Blob; url: string } | null>(null);

  useEffect(() => {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    /**
     * eslint-disable-next-line react-hooks/set-state-in-effect --
     * The rule targets state DERIVED from props or other state, which belongs
     * in render. This is neither: an object URL is an external resource with an
     * allocate/release lifecycle, and an effect with a cleanup is the only
     * primitive that models it. The two alternatives both regress —
     * `useMemo` allocates during render, and React's double-invoked render in
     * development then leaks the first URL because only the committed one is
     * ever revoked (a 25 MiB retention per preview); creating the URL inside
     * `queryFn` outlives the component, so a remount would read a URL this
     * effect had already revoked while the entry was still cached.
     * Double-invoked EFFECTS, by contrast, are handled correctly here: the
     * first pass is revoked by its own cleanup before the second allocates.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMinted({ blob, url: objectUrl });
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  const url = minted && minted.blob === blob ? minted.url : null;

  return {
    url,
    blob,
    // `isLoading`, not `isPending`: a preview panel that has not been opened yet
    // passes `enabled: false`, and a disabled query stays `pending` forever —
    // a spinner that never resolves on a panel nobody asked to fill.
    isPending: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/** `env.MAX_UPLOAD_BYTES` default — multer's `fileSize` limit (upload.ts:25). */
export const MAX_UPLOAD_BYTES = 26_214_400;

/**
 * fileValidation.ts:27-53. Usable directly as the `accept` attribute
 * (`ACCEPTED_UPLOAD_EXTENSIONS.join(',')`). The extension decides the stored
 * `type`: `.pdf`→'pdf', `.png`/`.jpg`/`.jpeg`→'image', `.tif`/`.tiff`→'scan',
 * `.xlsx`/`.csv`/`.txt`→'spreadsheet'.
 */
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.xlsx',
  '.csv',
  '.txt',
] as const;

/** Zod caps the split tag array at 10 entries of 1..40 characters (document.schema.ts:12-16). */
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 40;

export interface UploadProgress {
  loaded: number;
  /** Total bytes of the multipart body — slightly larger than the file. 0 while indeterminate. */
  total: number;
  /** 0..100, rounded. */
  percent: number;
}

export interface UploadDocumentInput {
  file: File;
  subsidiaryId: string;
  /** Sent as ONE comma-separated part however it is passed in — see `joinTags`. */
  tags?: string[] | string;
  /**
   * Bytes sent, not work done: 100% means the body left the browser, after which
   * the server still has to sniff the magic bytes and write to storage. Show
   * "Uploading" up to 100 and then "Checking file", not "Done".
   */
  onProgress?: (progress: UploadProgress) => void;
  /** Cancels the transfer; the promise rejects with an `AbortError` DOMException. */
  signal?: AbortSignal;
}

/**
 * Refresh margin for the upload.
 *
 * A 401 partway through a 25 MiB body costs the whole file again, so the token
 * is renewed up front whenever it is anywhere near expiry — five minutes on a
 * fifteen-minute token.
 */
const UPLOAD_TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * One comma-separated `tags` part, never repeated parts.
 *
 * multer's limits are tight — fields 10, parts 12, fieldArrayIndexLimit 10
 * (upload.ts:25-34) — so ten repeated tag parts alongside `subsidiaryId` and the
 * file trip LIMIT_FIELD_COUNT and surface as an opaque 'Upload rejected: …'
 * rather than a field error. Empty segments are dropped because 'a,,b' fails the
 * inner `min(1)` with the indexed key `tags.1`.
 */
function joinTags(tags: UploadDocumentInput['tags']): string | null {
  if (!tags) return null;
  const list = Array.isArray(tags) ? tags : tags.split(',');
  const cleaned = list.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return cleaned.length > 0 ? cleaned.join(',') : null;
}

/**
 * Read the envelope out of an XHR response.
 *
 * A small echo of `rawFetch`, and the only place in the app that duplicates it:
 * `fetch` has NO upload progress event, so an upload with a progress bar has to
 * be XHR, and XHR cannot borrow that parser. Everything else — the token, the
 * refresh, the error classes — is shared, so there is no second auth path.
 */
function readUploadEnvelope(xhr: XMLHttpRequest): Document {
  let payload: unknown;
  try {
    payload = JSON.parse(xhr.responseText);
  } catch {
    throw new NetworkError(`Unreadable response (HTTP ${xhr.status})`);
  }

  if (typeof payload !== 'object' || payload === null || !('success' in payload)) {
    throw new NetworkError(`Unexpected response shape (HTTP ${xhr.status})`);
  }

  const envelope = payload as { success: boolean; data?: unknown; error?: ApiErrorBody };
  if (envelope.success) return envelope.data as Document;
  if (envelope.error) throw new ApiError(xhr.status, envelope.error);
  throw new NetworkError(`Unexpected response shape (HTTP ${xhr.status})`);
}

function sendUpload(input: UploadDocumentInput, token: string | null): Promise<Document> {
  const { file, subsidiaryId, onProgress, signal } = input;

  return new Promise<Document>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }

    const form = new FormData();
    form.append('subsidiaryId', subsidiaryId);
    const tags = joinTags(input.tags);
    if (tags !== null) form.append('tags', tags);
    /**
     * The file part MUST be named exactly 'file'. multer is `single('file')`, so
     * any other name — or a second `file` part — is rejected by MULTER with
     * LIMIT_UNEXPECTED_FILE (400 'Upload rejected: LIMIT_UNEXPECTED_FILE')
     * before the controller ever runs. The controller's friendlier
     * 'send it as multipart field "file"' fires only when there is no file part
     * at all, so a typo here produces the unhelpful message, not the helpful one.
     */
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_PREFIX}/documents`);
    // No Content-Type header: only the browser can generate the multipart
    // boundary, and setting the header by hand omits it, which multer reads as a
    // malformed body.
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        const total = event.lengthComputable ? event.total : 0;
        onProgress({
          loaded: event.loaded,
          total,
          percent: total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0,
        });
      });
    }

    const abort = () => {
      xhr.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    xhr.addEventListener('loadend', () => {
      signal?.removeEventListener('abort', abort);
    });

    xhr.addEventListener('load', () => {
      try {
        resolve(readUploadEnvelope(xhr));
      } catch (error) {
        reject(error instanceof Error ? error : new NetworkError('Upload failed'));
      }
    });
    xhr.addEventListener('error', () => reject(new NetworkError('Upload failed')));
    xhr.addEventListener('timeout', () => reject(new NetworkError('Upload timed out')));
    xhr.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));

    xhr.send(form);
  });
}

/**
 * Upload a file, with the same token handling every other request gets.
 *
 * `ensureFresh` is the whole reason this is not just `sendUpload`: it renews a
 * near-expiry token BEFORE the body starts moving. The fallback below — refresh
 * and send again — is correct but expensive, because retrying an upload means
 * re-sending the entire file; the proactive refresh exists to keep that path
 * unreached. One recovery attempt only, matching `apiFetch`'s budget.
 */
export async function uploadDocument(input: UploadDocumentInput): Promise<Document> {
  await ensureFresh(UPLOAD_TOKEN_MARGIN_MS);

  try {
    return await sendUpload(input, tokenStore.get());
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    if (classifyAuthFailure(error.code) === 'terminal') throw new SessionExpiredError();
    await refresh();
    return await sendUpload(input, tokenStore.get());
  }
}

/**
 * `POST /documents` — 201 with `status: 'queued'`.
 *
 * The response is an acknowledgement, not a result: `ocrConfidence` and
 * `processedAt` are null, `processingAttempts` is 0, chunks and extracted fields
 * are empty, and they stay that way until the worker runs. Route to the detail
 * view and let `useDocument` poll.
 *
 * Requires 'document:upload' (`admin`, `cil_user`) — `roleGuard` rejects an
 * `moc_official` with 403 before multer reads a single byte, so gate the control
 * with `can(user, 'document:upload')` and still handle the 403.
 *
 * Two 404s here are worth telling apart, and only the MESSAGE distinguishes
 * them: a `subsidiaryId` outside the caller's grants answers 'Resource not
 * found' (authorization.ts:48, raised before anything is written to storage),
 * while a subsidiary that is missing or soft-deleted answers 'Subsidiary not
 * found' (document.service.ts:104-105). The first means "choose a different
 * subsidiary", the second means "that subsidiary is gone" — do not collapse
 * both into the generic not-found copy.
 */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadDocument,
    onSuccess: (doc) => {
      // Seed the detail cache so the poll starts from the queued row instead of
      // spending a request to re-learn what the 201 just said.
      queryClient.setQueryData(['documents', 'detail', doc.id], doc);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents', 'list'] }),
        // Document counts and the pending-work list both move on an upload.
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });
}

// ─── Retry ───────────────────────────────────────────────────────────────────

/**
 * `POST /documents/:id/retry` — an empty POST that answers 200 with a full
 * `Document` (not 202, and not an empty body).
 *
 * Only a document that is `failed` AND has `processingAttempts < 3` may be
 * retried (document.service.ts:309-314); anything else is a 400 INVALID_REQUEST,
 * and `failed` with three attempts is TERMINAL with no API path out of it. Offer
 * the control only where `canRetryDocument(doc)` from StatusBadge says so — it is
 * the same guard, kept in one place.
 *
 * The route ALSO carries a role guard: 'document:retry' is `admin` and
 * `cil_user` only (document.routes.ts:51), and an `moc_official` takes a 403
 * whatever the document's status. `canRetryDocument(doc)` does not know that, so
 * gate on `can(user, 'document:retry')` as well.
 *
 * The 200 body is NOT written into the cache, on purpose — and it is still
 * handed back as `mutation.data`, so read nothing from it but the `id`. It is
 * `{ ...present(preRetryDoc), status: 'queued' }` (document.service.ts:326) built
 * from the row as it was BEFORE the enqueue, so `processingError` still holds the
 * old failure text, `processingAttempts` is the pre-increment value, and
 * `processedAt`/`ocrConfidence` are stale. The stored row may still read 'failed'
 * at the moment the 200 lands, because the worker claims the job asynchronously.
 * Treat it as an ack and refetch.
 *
 * That last point has one residual consequence the invalidation below cannot
 * remove: the refetch it triggers samples the row at the earliest possible
 * moment, so it can legitimately come back 'failed' — and `isDocumentPending`
 * reads 'failed' as at rest, which stops `useDocument`'s poll. The in-process
 * worker claims within milliseconds so this is rare, and `staleTime: 0` there
 * means the next window focus recovers it; a screen that wants certainty can
 * call the detail query's own `refetch()` a beat later.
 */
export function useRetryDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (documentId: string) => {
      const { data } = await api.post<Document>(`/documents/${documentId}/retry`);
      return data;
    },
    onSuccess: (_result, documentId) =>
      Promise.all([
        // `exact`, so this reaches the detail ROW only. A prefix invalidation
        // also matches the nested `…/chunks` and `…/extracted-fields` keys, and
        // those would refetch straight away — against a row that still reads
        // 'failed' with the worker yet to re-run, so both come back empty and
        // the chunk list caches that empty array for its five-minute
        // `staleTime` long after the text actually arrives.
        queryClient.invalidateQueries({
          queryKey: ['documents', 'detail', documentId],
          exact: true,
        }),
        // The worker deletes and re-inserts both (document.worker.ts:105-106),
        // so the two nested keys ARE stale — but they are marked stale without
        // a refetch and re-read when next observed, by which time the panels'
        // own `isDocumentPending` gate has reopened on a settled document.
        queryClient.invalidateQueries({
          queryKey: ['documents', 'detail', documentId, 'chunks'],
          refetchType: 'none',
        }),
        queryClient.invalidateQueries({
          queryKey: ['documents', 'detail', documentId, 'extracted-fields'],
          refetchType: 'none',
        }),
        queryClient.invalidateQueries({ queryKey: ['documents', 'list'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  });
}

// ─── Field override ──────────────────────────────────────────────────────────

/** `PATCH /extracted-fields/:id` body (document.schema.ts:33-37). */
export interface OverrideFieldBody {
  /**
   * 1..2000 characters AFTER the server NFKC-normalises and strips invisible and
   * control characters (safeText.ts:41-52) — so a value made only of zero-width
   * characters collapses to empty and fails `min(1)`. Count after trimming if you
   * validate in the form.
   */
  value: string;
  /** REQUIRED, 3..500 characters after the same normalisation. An override with no reason is a 400. */
  reason: string;
}

export interface OverrideFieldInput extends OverrideFieldBody {
  /** The ExtractedField id — NOT the document id, despite the shared param schema. */
  fieldId: string;
  /**
   * Not sent. The endpoint hangs off its own top-level router and the response
   * omits `documentId`, so the caller supplies it here for the invalidation.
   */
  documentId: string;
}

/**
 * Correct one extracted figure.
 *
 * Mounted at `/extracted-fields/:id`, NOT under the document (routes/index.ts:52).
 * Requires 'field:override' (`admin`, `cil_user`); an `moc_official` is read-only
 * and gets a 403.
 *
 * The result is deliberately not merged into the cached row: it omits
 * `overriddenBy` entirely — the Postman collection asserts that key and would
 * fail against the running service — along with `confidenceScore`,
 * `requiresReview` and `sourceLocation`. Refetching the list is the only way to
 * get a complete row, and it is one small request.
 *
 * The document's own `requiresReview` is intentionally NOT invalidated: it is a
 * stored value the worker computed, and an override does not recompute it. The
 * field's `requiresReview` likewise stays true when the original confidence was
 * low, so "still needs review" after a human correction is expected, not a bug.
 */
export function useOverrideExtractedField() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ fieldId, value, reason }: OverrideFieldInput) => {
      const body: OverrideFieldBody = { value, reason };
      const { data } = await api.patch<ExtractedFieldOverrideResult>(
        `/extracted-fields/${fieldId}`,
        body,
      );
      return data;
    },
    onSuccess: (_result, variables) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['documents', 'detail', variables.documentId, 'extracted-fields'],
        }),
        // The service drops this subsidiary's TopicCache and AnalyticsCache rows
        // (document.service.ts:381), so every figure derived from them is now out
        // of date — an override that leaves the dashboard showing the old number
        // is exactly the traceability failure §13 exists to prevent.
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['analytics'] }),
        queryClient.invalidateQueries({ queryKey: ['topics'] }),
      ]),
  });
}
