import { useCursorList, type QueryParams } from '@/lib/lists';
import { ApiError } from '@/lib/api/errors';
import { can, isUnscoped } from '@/auth/permissions';
import type { AuthUser, Role } from '@/auth/types';

/**
 * Audit trail — PRD §5.10, §9.6.
 *
 * `GET /audit-logs` is the ONLY endpoint this module has. There is no detail
 * route, no POST, no PATCH and no DELETE: the trail is append-only by design
 * (`backend/src/modules/audit/auditLog.model.ts:3-8`), and `AuditLog` is
 * imported nowhere outside `modules/audit/`, so no other router exposes rows
 * either. Consequently there are no mutations here and nothing for this module
 * to invalidate.
 *
 * Rows are written server-side as a side effect of OTHER modules' mutations, so
 * `AUDIT_LIST_KEY` is exported: a feature that mutates and wants the trail to
 * reflect it invalidates that key from its own `onSuccess`.
 */

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * `AUDIT_ACTIONS` verbatim and in source order
 * (`backend/src/modules/audit/auditLog.model.ts:10-60`). Forty values.
 *
 * This one list is both the DB enum (`auditLog.model.ts:82`) and the `action`
 * query-param enum (`audit.routes.ts:21`), so a value absent here cannot be
 * filtered on and a value misspelled here is a 400, not an empty page.
 */
export const AUDIT_ACTIONS = [
  'auth.otp_requested',
  'auth.login_success',
  'auth.login_failed',
  'auth.account_locked',
  'auth.logout',
  'auth.token_refreshed',
  'auth.token_reuse_detected',
  'auth.session_revoked',
  'auth.sessions_revoked_all',
  'invite.issued',
  'invite.accepted',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.reactivated',
  'user.subsidiary_access_granted',
  'user.subsidiary_access_revoked',
  'subsidiary.created',
  'subsidiary.updated',
  'document.uploaded',
  'document.processed',
  'document.processing_failed',
  'document.retried',
  'document.downloaded',
  'extracted_field.overridden',
  'report_template.created',
  'report.created',
  'report.updated',
  'report.published',
  'report.archived',
  'query.asked',
  'query.answered',
  'query.generation_failed',
  'query.retried',
  'query.updated',
  'query.reviewed',
  'query.scope_revoked',
  'query.injection_suspected',
  'query.citation_discarded',
  'document.injection_suspected',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The three values no live request path can produce.
 *
 * `user.reactivated` and `subsidiary.updated` have zero call sites anywhere in
 * the backend, and `user.created` is written only by `scripts/seed.ts:100`.
 * Filtering on any of them returns an empty page every time, which reads as a
 * broken filter rather than an empty category.
 *
 * They stay in `AUDIT_ACTIONS` because rows carrying them exist in a seeded
 * database and must still render; they are only excluded from the picker.
 */
export const UNREACHABLE_AUDIT_ACTIONS = [
  'user.reactivated',
  'subsidiary.updated',
  'user.created',
] as const satisfies readonly AuditAction[];

/** The actions worth offering in a filter control. */
export const FILTERABLE_AUDIT_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.filter(
  (action) => !(UNREACHABLE_AUDIT_ACTIONS as readonly string[]).includes(action),
);

// ─── Targets ─────────────────────────────────────────────────────────────────

/**
 * Every `targetType` literal the backend actually writes, read off all 36
 * `recordAudit` call sites. Note the absence of an `Invite` — an issued invite
 * is recorded against the `User` it creates.
 */
export const AUDIT_TARGET_TYPES = [
  'Session',
  'User',
  'Document',
  'ExtractedField',
  'Query',
  'Report',
  'ReportTemplate',
  'Subsidiary',
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * What the field can actually hold.
 *
 * `targetType` is a free `String` column (`auditLog.model.ts:83`), NOT an enum,
 * so the eight literals above are observed values rather than a closed set. The
 * `string` arm keeps a row written by a future backend from failing to
 * typecheck here; the intersection preserves autocomplete on the known
 * literals.
 */
export type AuditTargetTypeValue = AuditTargetType | (string & Record<never, never>);

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * One row, exactly as serialised at `audit.routes.ts:78-87`.
 *
 * All eight keys are ALWAYS PRESENT. Every optional column is coalesced to
 * `null` on the way out (`r.userId ? String(r.userId) : null`,
 * `r.targetType ?? null`, `r.metadata ?? null`), so `'subsidiaryId' in row` is
 * never the right test — `row.subsidiaryId === null` is.
 *
 * `ipAddress` is deliberately absent. It IS stored (`auditLog.model.ts:87`,
 * written by `audit.service.ts:31`) but is not in the response projection, so a
 * "source IP" column would be permanently blank; it is not retrievable through
 * this endpoint at all.
 */
export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  /**
   * The actor — null more often than "worker rows have no actor" suggests, and
   * less often.
   *
   * Null on exactly four kinds of row: the three document-worker actions
   * (`document.worker.ts:190`, `:211`, `:240` — so `document.processed`,
   * `document.processing_failed` and `document.injection_suspected` always
   * serialise null) plus the seed script's `user.created`. The QUERY worker
   * DOES pass an actor on all five of its calls (`query.worker.ts:175, :196,
   * :264, :355, :450`), as do all 32 request-path calls.
   *
   * A null actor is therefore a normal state to render, not an error — but a UI
   * keyed on "written by a worker ⇒ null" blanks every `query.answered` row
   * incorrectly.
   */
  userId: string | null;
  targetType: AuditTargetTypeValue | null;
  /** The target's own id. NOT a ref to one fixed collection — read it with `targetType`. */
  targetId: string | null;
  subsidiaryId: string | null;
  /** `Schema.Types.Mixed`, shape varies by action. See `AuditMetadataByAction`. */
  metadata: Record<string, unknown> | null;
  /**
   * ISO-8601 UTC. Render through `formatDateTime` (IST, §4.6).
   *
   * Do not sort on it. The list is ordered by `_id` descending
   * (`audit.routes.ts:69`) while `timestamp` is stamped separately with
   * `new Date()` at write time (`audit.service.ts:32`), so concurrent writes in
   * the same millisecond can page in an order that does not match their
   * timestamps. Sort by `id` if you need the server's own order.
   */
  timestamp: string;
}

/**
 * The metadata key sets actually written, by action — OBSERVED, not guaranteed.
 *
 * `metadata` is `Schema.Types.Mixed` and passes through no schema, so this map
 * documents rather than validates: narrow with your own type guard, never with
 * a bare cast. The actions listed here are the only ones that write metadata at
 * all; the other fifteen always serialise `metadata: null`.
 *
 * By §9.6 policy metadata carries counts and ids ONLY — never question text,
 * field values or excerpts (explicit comments at `query.service.ts:350-352`,
 * `query.worker.ts:201`, `document.worker.ts:202-203`,
 * `document.service.ts:373-374`). It is safe to render verbatim, and it will
 * never contain the content a reviewer might be hoping to find.
 */
export interface AuditMetadataByAction {
  'auth.account_locked': { lockMinutes: number };
  'auth.sessions_revoked_all': { revokedCount: number };
  /** The INVITED role, not the inviter's — the closed `Role` union (`user.service.ts:80`). */
  'invite.issued': { role: Role };
  'user.created': { role: string; via: string };
  'user.updated': { changed: string[] };
  'user.deactivated': { changed: string[] };
  'document.uploaded': { type: string; sizeBytes: number };
  'document.processed': {
    chunks: number;
    fields: number;
    requiresReview: boolean;
    injectionSuspected: boolean;
    ruleIds: string[];
    termsIndexed: number;
    provider: string;
  };
  'document.processing_failed': { attempts: number };
  'document.injection_suspected': { ruleIds: string[]; flaggedChunks: number };
  'extracted_field.overridden': { fieldName: string; reason: string };
  'report.created': { templateId: string; sourceDocuments: number; hasUnreviewedFigures: boolean };
  'report.updated': { version: number };
  'report.published': { version: number; hasUnreviewedFigures: boolean };
  'query.asked': { isParliamentary: boolean; scopeSize: number; documentCount: number };
  'query.answered': {
    answerStatus: string;
    citations: number;
    discarded: number;
    passagesUsed: number;
    passagesWithheld: number;
    injectionSuspected: boolean;
    provider: string;
    generationMs: number;
  };
  'query.retried': { attempts: number };
  'query.generation_failed': { attempts: number; deadLettered: boolean };
  'query.updated': {
    reviewStatus: string;
    hadInjectionFlags: boolean;
    citationCount: number;
    officialResponseEdited: boolean;
  };
  'query.reviewed': {
    reviewStatus: string;
    hadInjectionFlags: boolean;
    citationCount: number;
    officialResponseEdited: boolean;
  };
  'query.scope_revoked': { scopeSize: number };
  /** Note `flagged`/`withheld` — NOT the `flaggedChunks` of the document variant. */
  'query.injection_suspected': { ruleIds: string[]; flagged: number; withheld: number };
  'query.citation_discarded': { discarded: number; accepted: number; provider: string };
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * Every filter the endpoint accepts (`audit.routes.ts:17-24`). There are no
 * others, and three absences shape the screen:
 *
 *   - NO date range. There is no `from`/`to`/`startDate`/`endDate` param. Do
 *     not build a date picker for this list; the backend cannot honour it.
 *   - NO `targetType`/`targetId` filter, so "everything that happened to this
 *     document" is not a question this endpoint can answer.
 *   - NO free-text search.
 */
export interface AuditLogFilters {
  /** Exact enum match. Offer `FILTERABLE_AUDIT_ACTIONS` in the picker. */
  action?: AuditAction;
  subsidiaryId?: string;
  /** 24-hex id. Only an admin can actually filter by it — see `canFilterAuditByUser`. */
  userId?: string;
}

/** Exported so a mutating module can invalidate the trail it just appended to. */
export const AUDIT_LIST_KEY = ['audit', 'logs'] as const;

/**
 * The audit log, newest first, cursor-paginated.
 *
 * Returns `useCursorList`'s shape: `items`, `fetchNextPage`, `hasNextPage`,
 * `isFetchingNextPage`. There is no `total`, no page count and no jump-to-page —
 * `pagination.nextCursor === null`, surfaced as `hasNextPage === false`, is the
 * only end-of-list signal the envelope carries (`utils/envelope.ts:29-36`).
 * `nextCursor` is an ObjectId, not an offset or a timestamp; it is handled
 * entirely inside the hook and never persisted, which matters because a stale
 * cursor fails the `/^[0-9a-fA-F]{24}$/` check with a 400 rather than an empty
 * page.
 *
 * ─── SCOPING IS A UNION, NOT AN INTERSECTION ─────────────────────────────────
 * Any authenticated role may call this — the router applies `requireAuth` and no
 * `roleGuard` at all (`audit.routes.ts:13`). What differs by role is the Mongo
 * filter, not a 403. For a non-admin the backend builds
 *
 *     $or: [ { subsidiaryId: <requested, or $in: your grants> }, { userId: <you> } ]
 *
 * (`audit.routes.ts:58-61`), so a subsidiary-filtered page STILL contains all of
 * that user's own activity, including rows whose `subsidiaryId` is null or
 * belongs to a different subsidiary. Show the subsidiary column and let the
 * reader see it; do not present the result as "everything in subsidiary X".
 * `auditRowMatchesSubsidiaryFilter` exists to label the exceptions. A non-admin
 * with no grants gets `$in: []` on the first clause and sees only their own
 * rows.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A 404 from this hook means DENIED, not empty — see `isAuditScopeDenied`.
 */
export function useAuditLogs(
  filters: AuditLogFilters = {},
  options: { limit?: number; enabled?: boolean } = {},
) {
  /**
   * The three keys are listed out rather than spread from `filters`.
   *
   * `rejectOperatorInjection` (`utils/sanitize.ts:45-59`, mounted at
   * `app.ts:102`) rejects the whole request with a 400 if ANY query key starts
   * with `$`, contains `.`, or contains `[$`. Spreading a caller's filter-state
   * object would forward whatever else happens to be on it into the query
   * string, where one stray key turns a working list into a hard validation
   * failure. Zod strips unknown params silently, but only after that middleware
   * has already run.
   */
  const params: QueryParams = {
    action: filters.action,
    subsidiaryId: filters.subsidiaryId,
    userId: filters.userId,
  };

  return useCursorList<AuditLogEntry>({
    key: AUDIT_LIST_KEY,
    path: '/audit-logs',
    params,
    // Server bounds: integer, min 1, max 100, default 25. Out of range is a
    // 400, not a clamp — and the Zod issue comes back keyed on the BARE param
    // name (`error.fields = { limit: [...] }`, `validate.ts:49-53`), never
    // `query.limit`, so a page-size control reads its message off `limit`.
    limit: options.limit,
    enabled: options.enabled ?? true,
    /**
     * No `refetchInterval`, deliberately. A poll on an infinite query refetches
     * EVERY page loaded so far, so ten loaded pages is ten sequential requests
     * per tick — against the only limiter this route has, the app-wide 100/min
     * keyed on IP (`app.ts:105`). New rows also land at the head between ticks,
     * so the window each cursor covers shifts underneath the reader. A Refresh
     * control that resets the chain is the honest way to see new entries.
     */
  });
}

// ─── Reading the result ──────────────────────────────────────────────────────

/**
 * Whether `filters.userId` will actually do anything.
 *
 * Only for an admin (`audit.routes.ts:47`). The param is validated for
 * everyone, but for a non-admin it is then dropped: passing someone else's id
 * is a 404 (`:50-55`), and passing your OWN id passes the check and is silently
 * ignored, because the `$or` above already contains `{ userId: <you> }`. So
 * `?userId=<me>` returns exactly the same rows as no filter at all.
 *
 * A "my activity only" toggle therefore cannot be built on this param for a
 * non-admin. Hide the user filter when this returns false rather than shipping
 * a control that appears to do nothing.
 */
export function canFilterAuditByUser(viewer: AuthUser | null): boolean {
  return isUnscoped(viewer);
}

/**
 * True when the row genuinely sits in the subsidiary that was filtered on.
 *
 * False marks a row that arrived through the own-activity clause of the `$or` —
 * legitimate data, not a bug, but not what the filter says. Use it to flag those
 * rows rather than to hide them: filtering them out client-side would show a
 * page with fewer rows than the cursor advanced past, and the count would never
 * settle.
 */
export function auditRowMatchesSubsidiaryFilter(
  entry: AuditLogEntry,
  subsidiaryId: string | null | undefined,
): boolean {
  if (!subsidiaryId) return true;
  return entry.subsidiaryId === subsidiaryId;
}

/**
 * A 404 here means "denied", never "no results".
 *
 * Cross-subsidiary and cross-user denials answer 404 NOT_FOUND, not 403
 * (`utils/authorization.ts:46-54`, `audit.routes.ts:51-54`) — the existence of
 * the rows is itself the secret, and the `reason` the backend logs is stripped
 * by the error handler. Rendering it as an empty table tells the user the
 * subsidiary has no activity, which is a different and false statement. Show
 * `NOT_FOUND_MESSAGE` from `@/lib/api/errors`.
 */
export function isAuditScopeDenied(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NOT_FOUND';
}

/**
 * The traceability deep-link for a row's target — screen 8, §5.10.
 *
 * Returns null when there is nowhere to go, and null MUST be rendered as inert
 * text rather than a dead-looking link (the same rule `safeUrl` states). Three
 * target types have no screen and no id from which one could be derived:
 *
 *   Session         no per-session route exists; `/settings/sessions` lists the
 *                   VIEWER's own sessions, which is a different set entirely.
 *   ExtractedField  `targetId` is the field's id and the row carries no document
 *                   id, so the owning document is not recoverable from the audit
 *                   row alone.
 *   ReportTemplate  templates are chosen inside the report flow; no route
 *                   addresses one.
 *
 * `User` and `Subsidiary` land in the Admin Panel, whose layout is
 * `RequireRole roles={['admin']}` (`app/(app)/admin/layout.tsx`), so they are
 * gated on the same capability instead of being offered to a CIL user who would
 * only reach the 403 page — every role can read this list, so those rows are in
 * front of non-admins routinely. The id rides in the query string because both
 * admin screens are lists: one that ignores the hint still lands on the right
 * page, whereas an invented path segment would 404.
 *
 * These are internal literal routes carrying an encoded id, so `safeUrl` does
 * not apply — it refuses relative paths by design.
 *
 * NOTE a returned href can still lead to a 404 detail page: a row visible
 * through the own-activity clause may point at a document in a subsidiary the
 * viewer does not hold. Pre-checking would cost one request per row, and the
 * 404 is deliberately indistinguishable from "does not exist", so let the
 * destination screen report it.
 */
export function auditTargetHref(
  entry: Pick<AuditLogEntry, 'targetType' | 'targetId'>,
  viewer: AuthUser | null,
): string | null {
  const { targetType, targetId } = entry;
  if (!targetType || !targetId) return null;

  const id = encodeURIComponent(targetId);
  // `user:manage` is the CAPABILITIES mirror of the /admin route guard.
  const canReachAdmin = can(viewer, 'user:manage');

  switch (targetType) {
    case 'Document':
      return `/documents/${id}`;
    case 'Report':
      return `/reports/${id}`;
    case 'Query':
      return `/queries/${id}`;
    case 'User':
      return canReachAdmin ? `/admin/users?userId=${id}` : null;
    case 'Subsidiary':
      return canReachAdmin ? `/admin/subsidiaries?subsidiaryId=${id}` : null;
    case 'Session':
    case 'ExtractedField':
    case 'ReportTemplate':
      return null;
    // `targetType` is a free string column, so an unknown literal is possible.
    default:
      return null;
  }
}
