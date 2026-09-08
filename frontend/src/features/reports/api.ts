import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { useOffsetList } from '@/lib/lists';
import type { ReportStatus } from '@/components/ui/StatusBadge';

/**
 * Reports and report templates — PRD §5.6, §5.7.
 *
 * Server-state hooks live in the feature module; components never call the
 * client directly (§10.5).
 *
 * Two routers, one module: `/reports` (7 routes) and `/report-templates`
 * (2 routes). Nothing else in the backend mounts under either prefix, so this
 * file is the whole surface — there is no GET /report-templates/:id, no
 * template PATCH or DELETE, and no report DELETE, unarchive or unpublish.
 */

export type { ReportStatus };

// ─── Form constraints ────────────────────────────────────────────────────────

/**
 * `sectionSchema` (report.schema.ts:7-10) is shared verbatim by report
 * sections, version sections and template sections, so one set of numbers
 * covers every section editor in the app.
 *
 * heading and body are validated ASYMMETRICALLY and it matters for the form:
 *
 *   heading  safeText({ max: 200 }) — NFKC-normalised, invisible characters
 *            stripped, trimmed, THEN measured. A whitespace-only heading is
 *            rejected ('heading must be at least 1 character after removing
 *            invisible characters', safeText.ts:49), so a raw `.length` check
 *            in the browser can pass where the server fails. Note the strip
 *            KEEPS \t \n \r (unicodeNormalize.ts:20) — a multi-line heading is
 *            accepted by the API, so clamp it here if it would break layout.
 *
 *   body     z.string().max(50_000) — no minimum, no normalisation, no trim.
 *            The empty string is valid and is stored verbatim.
 */
export const SECTION_LIMITS = {
  minCount: 1,
  maxCount: 50,
  headingMin: 1,
  headingMax: 200,
  bodyMin: 0,
  bodyMax: 50_000,
} as const;

export const REPORT_LIMITS = {
  titleMax: 250,
  changeSummaryMax: 500,
  /** POST /reports — at least one, at most 25 source documents. */
  sourceDocumentsMin: 1,
  sourceDocumentsMax: 25,
  archiveConfirmMax: 250,
  /** GET /reports rejects limit > 100 with a 400. */
  listLimitMax: 100,
} as const;

export const TEMPLATE_LIMITS = {
  nameMax: 150,
  descriptionMax: 500,
  subsidiaryScopeMax: 50,
} as const;

/**
 * THE LIMIT THAT ACTUALLY BINDS, and it is not `SECTION_LIMITS.bodyMax`.
 *
 * `express.json({ limit: '10kb' })` is mounted app-wide (app.ts:97) with no
 * per-route override for reports, so a section body approaching the schema's
 * 50,000 characters can never reach the server. A PATCH /reports/:id or
 * POST /report-templates whose SERIALISED BODY crosses 10 KB fails with HTTP
 * 413 `PAYLOAD_TOO_LARGE` 'Request body is too large' (errorHandler.ts:62-69) —
 * a plain JSON error with NO `fields`, so it will not light up any one input.
 *
 * The editor must budget the whole request, all sections together, against
 * this number, or long-form editing breaks silently on save.
 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024;

/** Byte length of the JSON this body will actually serialise to. */
export function requestBodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body ?? {})).length;
}

/**
 * Two more ways a well-formed save is rejected, or accepted and then ignored.
 *
 * DOTTED TOP-LEVEL KEYS ARE REJECTED BEFORE VALIDATION. `rejectOperatorInjection`
 * walks body, query and params and 400s on any key containing '.' or starting
 * with '$' (utils/sanitize.ts:31-38, mounted app.ts:102). The message is
 * 'Request contains disallowed characters in a field name' and it carries NO
 * `fields` object, so it highlights no input. A section editor that flattens its
 * form state into `{ 'sections.0.body': … }` before saving trips exactly this —
 * send the nested arrays these interfaces declare.
 *
 * EXTRA KEYS ARE SILENTLY DISCARDED. No schema in report.schema.ts is
 * `.strict()`, and validate() replaces the request with the stripped result
 * (validate.ts:26, :38). Posting `status: 'published'` alongside a new report
 * returns 201 with the field simply never applied. A 2xx is not confirmation
 * that everything you sent was honoured — read the response back.
 */

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * Sections carry no `_id` — every section subschema is declared `{ _id: false }`
 * (report.model.ts:70-73, :88; reportTemplate.model.ts:36). Key them by index.
 */
export interface ReportSection {
  heading: string;
  body: string;
}

/**
 * Every nullable field is emitted as an explicit `null`, never omitted
 * (report.service.ts:137-145) — test with `=== null`, not `in` or `undefined`.
 */
export interface ReportCitation {
  documentId: string;
  extractedFieldId: string | null;
  fieldName: string | null;
  /**
   * These three are ALWAYS null in practice. `draftSection` only ever pushes
   * documentId, extractedFieldId, fieldName and confidenceScore
   * (report.service.ts:176-181); the model carries the rest but nothing writes
   * them. Never key a "jump to page" affordance on `pageNumber`, and note that
   * because `section` is never populated there is no way to tell which section
   * a citation came from.
   */
  chunkIndex: number | null;
  pageNumber: number | null;
  section: string | null;
  /** 0..1. */
  confidenceScore: number | null;
}

/**
 * The ONLY report shape the API returns. List rows, detail, create, update,
 * publish and archive all go through `presentReport` (report.service.ts:125-153),
 * so there is no richer detail payload to fetch.
 *
 * Deliberately absent from every response: `versionHistory` (only via
 * GET /reports/:id/versions), `archivedBy`, `isDeleted`, `deletedAt`. There is
 * therefore NO way to show who archived a report — that attribution lives only
 * in the audit log.
 *
 * Every id is a bare 24-hex string; nothing is ever populated with a name, so
 * user, subsidiary, template and document labels all need separate lookups.
 */
export interface Report {
  id: string;
  title: string;
  templateId: string;
  subsidiaryId: string;
  createdBy: string;
  status: ReportStatus;
  sections: ReportSection[];
  /** Starts at 1. Only a section edit advances it — see `useUpdateReport`. */
  currentVersion: number;
  sourceDocumentLinks: string[];
  /**
   * Frozen at creation and NEVER regenerated: `updateReport` does not touch
   * citations (report.service.ts:348-390). After a human edits the prose these
   * still describe the original generated draft, so do not present them as
   * "verified for the current text".
   *
   * Not deduplicated either — one entry per placeholder OCCURRENCE
   * (report.service.ts:171-183) — so the same field cited in three sections
   * yields three identical rows. Dedupe on `extractedFieldId` client-side.
   */
  citations: ReportCitation[];
  /**
   * True when any citation scored `<=` the OCR review threshold (0.75 by
   * default) — note `<=`, so exactly 0.75 counts as unreviewed
   * (report.service.ts:236-238). Computed once at CREATE and never recomputed,
   * including on publish. Zero citations gives false.
   */
  hasUnreviewedFigures: boolean;
  publishedBy: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /reports/:id/versions element (report.service.ts:331-342). */
export interface ReportVersionEntry {
  version: number;
  sections: ReportSection[];
  /** Raw user id, no name — resolve it against the users list yourself. */
  editedBy: string;
  editedAt: string;
  /**
   * Never absent, but `null` and `''` are BOTH possible "no summary" states:
   * the field is `safeText` with min 0, so a client can store an empty string.
   * Version 1 always exists and reads 'Initial draft generated from template'.
   */
  changeSummary: string | null;
}

/**
 * `listTemplates` and `createTemplate` return the SAME shape
 * (report.service.ts:62-69, :92-99). No createdAt/updatedAt.
 */
export interface ReportTemplate {
  id: string;
  name: string;
  /** null when unset; `''` when the client sent one (safeText min 0). */
  description: string | null;
  /** Section bodies here still contain the `{{placeholder}}` markers. */
  sections: ReportSection[];
  /** `[]` means available to EVERY subsidiary, not "available to none". */
  subsidiaryScope: string[];
  /** Always 1 — `createTemplate` hardcodes it and nothing updates a template. */
  version: number;
}

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * GET /reports (report.schema.ts:41-47). There is no `q`/search, no `sort`, no
 * `createdBy` filter and no date range; ordering is fixed at createdAt DESC
 * (report.service.ts:290). Unknown query keys are silently stripped.
 */
export interface ListReportsQuery {
  page?: number;
  limit?: number;
  status?: ReportStatus;
  subsidiaryId?: string;
  templateId?: string;
}

/** POST /reports (report.schema.ts:19-28). */
export interface CreateReportBody {
  title: string;
  templateId: string;
  subsidiaryId: string;
  /**
   * 1..25 document ids. All must be status `validated` AND in `subsidiaryId`,
   * or the request fails — see `useCreateReport` for the failure ordering.
   * Duplicates are tolerated (compared against a Set, report.service.ts:200).
   */
  sourceDocumentIds: string[];
}

/** PATCH /reports/:id (report.schema.ts:30-34). Every field optional. */
export interface UpdateReportBody {
  title?: string;
  sections?: ReportSection[];
  /** Persisted ONLY alongside `sections` — see `useUpdateReport`. */
  changeSummary?: string;
}

export interface UpdateReportVariables extends UpdateReportBody {
  id: string;
}

/** POST /reports/:id/archive (report.schema.ts:37-39). The body is REQUIRED. */
export interface ArchiveReportBody {
  /** Must equal the report's CURRENT title exactly. */
  confirm: string;
}

export interface ArchiveReportVariables extends ArchiveReportBody {
  id: string;
}

/** POST /report-templates (report.schema.ts:12-17). */
export interface CreateTemplateBody {
  name: string;
  description?: string;
  sections: ReportSection[];
  /** Omit (or send `[]`) to make the template visible to every subsidiary. */
  subsidiaryScope?: string[];
}

// ─── State rules ─────────────────────────────────────────────────────────────

/**
 * These three answer "does the ROW allow it". They say nothing about the
 * CALLER, and every one of these actions is role-guarded as well, so gate a
 * control on both. The capability table in `@/auth/permissions` is the mirror
 * of the backend's `roleGuard` calls:
 *
 *   edit / draft    can(user, 'report:draft')     admin, cil_user
 *   publish         can(user, 'report:publish')   admin ONLY
 *   archive         can(user, 'report:archive')   admin ONLY
 *   new template    can(user, 'template:create')  admin ONLY
 *
 * A Publish button gated on `canPublishReport(status)` alone is offered to
 * every CIL user and always returns 403 — and because roleGuard runs BEFORE
 * validate(), that 403 masks every other error the request would have raised.
 */

/**
 * Only a draft may be edited (report.service.ts:358-360) or published
 * (:396-398). Publish is NOT idempotent: publishing an already-published
 * report is a 400, not a no-op.
 */
export function canEditReport(status: ReportStatus): boolean {
  return status === 'draft';
}

export function canPublishReport(status: ReportStatus): boolean {
  return status === 'draft';
}

/**
 * Archive is reachable from BOTH 'draft' and 'published' — the guard only
 * blocks 'archived' (report.service.ts:432), so a never-published draft can be
 * archived directly. It is terminal: no unarchive endpoint exists anywhere.
 */
export function canArchiveReport(status: ReportStatus): boolean {
  return status !== 'archived';
}

/**
 * A template placeholder that matched no extracted field is rendered into the
 * prose as the literal text `[[unresolved: FieldName]]` (report.service.ts:174)
 * rather than blanked, and there is no separate flag listing which ones failed.
 *
 * Not the only failure rendering: the placeholder regex only accepts
 * `[A-Za-z0-9 _/()-]` (report.service.ts:155), so a placeholder containing a
 * dot, a colon or an accent is not recognised at all and survives as a literal
 * `{{...}}` instead. Highlighting one without the other misses half of them.
 */
export function hasUnresolvedPlaceholders(text: string): boolean {
  return text.includes('[[unresolved:') || text.includes('{{');
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * GET /reports — offset-paginated, readable by any authenticated role.
 *
 * Scoping is invisible: an admin is unscoped, a non-admin is filtered to their
 * `subsidiaryAccess`, and a non-admin who pins a `subsidiaryId` they do not
 * hold gets 404 NOT_FOUND rather than 403 (authorization.ts:46-54). A non-admin
 * with no grants at all gets an empty page, not an error.
 */
export function useReports({
  page = 1,
  limit = 20,
  status,
  subsidiaryId,
  templateId,
  enabled = true,
}: ListReportsQuery & { enabled?: boolean } = {}) {
  const list = useOffsetList<Report>({
    key: ['reports', 'list'],
    path: '/reports',
    params: { status, subsidiaryId, templateId },
    page,
    limit,
    enabled,
  });

  return {
    ...list,
    page,
    /**
     * Derived here rather than in the pager because of the empty-result edge:
     * `totalPages` is `Math.ceil(total / limit) || 0` (report.service.ts:303),
     * so it is 0 — not 1 — when there are no reports. Rendering
     * "page of totalPages" straight shows "1 of 0"; this expression at least
     * gets the Next control right.
     */
    hasNextPage: list.pagination ? page < list.pagination.totalPages : false,
  };
}

/**
 * GET /reports/:id.
 *
 * 404 covers missing, soft-deleted AND out-of-subsidiary-scope alike
 * (report.service.ts:317-323) — never 403 — so the UI cannot and must not try
 * to distinguish "does not exist" from "not yours" (see NOT_FOUND_MESSAGE).
 * A malformed id never reaches that: it is a 400 VALIDATION_ERROR with
 * `fields.id = ['must be a valid id']`, so one broken link produces two
 * different error shapes.
 */
export function useReport(id: string | undefined) {
  return useQuery({
    queryKey: ['reports', 'detail', id],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<Report>(`/reports/${id}`, { signal });
      return data;
    },
    enabled: Boolean(id),
  });
}

/**
 * GET /reports/:id/versions — the whole history, newest first.
 *
 * A bare array with no pagination at all (report.routes.ts:82-88), already
 * sorted version DESCENDING by the service (report.service.ts:341), so do not
 * re-sort unless you mean to invert it. Same 404 scoping rule as the detail
 * route.
 */
export function useReportVersions(id: string | undefined) {
  return useQuery({
    queryKey: ['reports', 'versions', id],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<ReportVersionEntry[]>(`/reports/${id}/versions`, { signal });
      return data;
    },
    enabled: Boolean(id),
  });
}

/**
 * GET /report-templates — a bare array, sorted by name ASC, no pagination and
 * no filters. Readable by any authenticated role.
 *
 * `staleTime` is long because the set is effectively immutable: the router
 * exposes no PATCH and no DELETE (report.routes.ts:23-45), so the only thing
 * that can change this list is `useCreateReportTemplate`, which invalidates it.
 *
 * Scope caveat for callers resolving a report's `templateId` against this list:
 * drafting does NOT scope-check the template (report.service.ts:189) while this
 * listing does (:54-59), so a report can legitimately reference a template the
 * same user cannot see here — and there is no GET /report-templates/:id to fall
 * back on. Show the id rather than "unknown template".
 */
export function useReportTemplates() {
  return useQuery({
    queryKey: ['reports', 'templates'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<ReportTemplate[]>('/report-templates', { signal });
      return data;
    },
    staleTime: 300_000,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * POST /reports — server-side drafting from a template. Admin and CIL user
 * only (`can(user, 'report:draft')`); an MoC Official gets 403.
 *
 * The failure modes are ordered, and the first three are all 404s, so surface
 * `error.message` rather than a generic "not found":
 *   404 'Resource not found'  — non-admin caller lacks `subsidiaryId`
 *   404 'Template not found'
 *   404 'One or more source documents were not found in this subsidiary'
 *       — fires if any id is missing, soft-deleted, or in another subsidiary
 *   400 'All source documents must be validated before drafting (N are not)'
 *
 * The returned report is always status 'draft' at version 1, and its sections
 * are the template's sections with placeholders resolved — so
 * `sections.length === template.sections.length` and any unresolved placeholder
 * is already sitting in the prose (see `hasUnresolvedPlaceholders`).
 */
export function useCreateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateReportBody) => {
      const { data } = await api.post<Report>('/reports', body);
      return data;
    },
    // §10.5: invalidate on every mutation.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reports', 'list'] }),
        /**
         * The dashboard's `recentReports` row is title + status +
         * currentVersion + hasUnreviewedFigures + updatedAt, so a new draft
         * belongs in it immediately.
         *
         * Deliberately NOT `['analytics']`: create does not drop the server's
         * AnalyticsCache, so refetching would spend a request to re-read the
         * same cached figures.
         */
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  });
}

/**
 * PATCH /reports/:id — admin and CIL user (`can(user, 'report:draft')`, there
 * is no separate edit capability), drafts only (400 INVALID_REQUEST
 * 'Only drafts can be edited (current status: published)' otherwise).
 *
 * The version timeline advances ONLY when `sections` is sent
 * (report.service.ts:364-375). A title-only PATCH leaves `currentVersion`
 * unchanged and writes no version row — and `changeSummary` is read inside that
 * same branch, so sending a summary without sections validates, returns 200 and
 * silently records nothing.
 *
 * An empty body `{}` is valid and returns the report unchanged.
 */
export function useUpdateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: UpdateReportVariables) => {
      const { data } = await api.patch<Report>(`/reports/${id}`, body);
      return data;
    },
    onSuccess: (_report, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['reports', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'detail', variables.id] });
      // The same `recentReports` row as on create: a save moves title,
      // currentVersion and updatedAt. Still not `['analytics']` — an edit does
      // not touch the server's AnalyticsCache either.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      // Only a section edit pushes a version, so a title-only save leaves the
      // versions list already correct.
      if (variables.sections) {
        void queryClient.invalidateQueries({ queryKey: ['reports', 'versions', variables.id] });
      }
    },
  });
}

/**
 * POST /reports/:id/publish — ADMIN ONLY (`can(user, 'report:publish')`),
 * deliberately, so the drafter is not the publisher (report.routes.ts:103-112).
 * A CIL user gets 403 even on a malformed id, because roleGuard runs before
 * validate().
 *
 * No request body: the route binds a params schema only, and anything sent is
 * ignored. Not idempotent — publishing a published report is 400
 * 'Only drafts can be published (current status: published)'.
 */
export function usePublishReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.post<Report>(`/reports/${id}/publish`);
      return data;
    },
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ['reports', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'detail', report.id] });
      // Publishing drops the subsidiary's AnalyticsCache server-side
      // (report.service.ts:418), so the cached figures on screen are now stale.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

/**
 * POST /reports/:id/archive — ADMIN ONLY (`can(user, 'report:archive')`), and
 * the body is REQUIRED:
 * `confirm` must equal the report's CURRENT title exactly (a rename changes the
 * required string). Both sides are safeText-normalised, so a title pasted with
 * invisible characters still matches.
 *
 * Two different failures, and the order is the trap:
 *   400 INVALID_REQUEST       'Report is already archived'  — checked FIRST
 *   400 CONFIRM_TEXT_MISMATCH "To archive this report, provide its exact title
 *                              in the 'confirm' field"
 * So a double-submit reports "already archived" whatever `confirm` held — do
 * not render that one against the confirm input. CONFIRM_TEXT_MISMATCH is HTTP
 * 400 (apiError.ts:41), not 409, and IS the confirm-field error.
 *
 * A bodyless POST fails at the object level and lands under the synthetic key
 * `fields.body`, not `fields.confirm` (validate.ts:51).
 *
 * Terminal: nothing un-archives a report.
 */
export function useArchiveReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, confirm }: ArchiveReportVariables) => {
      const { data } = await api.post<Report>(`/reports/${id}/archive`, { confirm });
      return data;
    },
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ['reports', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'detail', report.id] });
      // Archive invalidates the subsidiary's AnalyticsCache too
      // (report.service.ts:457).
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

/**
 * POST /report-templates — admin only (`can(user, 'template:create')`).
 *
 * Name collisions arrive as 409 CONFLICT under TWO different messages, and both
 * are ordinary: 'A template with that name already exists' from the pre-check,
 * which filters `isDeleted: false` (report.service.ts:73-74), and 'Resource
 * already exists' from the Mongo duplicate-key handler when a SOFT-DELETED
 * template still holds the name — the unique index is not partial
 * (reportTemplate.model.ts:49). Key the form error on the CODE, not the message.
 */
export function useCreateReportTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateTemplateBody) => {
      const { data } = await api.post<ReportTemplate>('/report-templates', body);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports', 'templates'] }),
  });
}
