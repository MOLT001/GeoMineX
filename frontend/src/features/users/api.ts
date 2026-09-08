import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { useOffsetList } from '@/lib/lists';
import type { Role } from '@/auth/types';

/**
 * Users — admin user management, plus the signed-in user's own record.
 *
 * Server-state hooks live in the feature module; components never call the
 * client directly (§10.5).
 *
 * `Role` is NOT redeclared here — it is already `@/auth/types`, alongside
 * `ROLE_LABELS` in `@/auth/permissions`. Import it from there.
 *
 * EVERY route below except GET /users/me is `roleGuard('admin')`, and the guard
 * is mounted AHEAD of `validate()` on all seven (user.routes.ts:24,26,28,33,40,
 * 47,54). So a non-admin gets 403 FORBIDDEN 'Insufficient permissions for this
 * action' (roleGuard.ts:20) whatever it sent — a malformed id and an empty body
 * both arrive as 403, never 400. Never read a 403 from this module as "the body
 * was fine": gate the screen with `can(user, 'user:manage')`
 * (`@/auth/permissions`) and treat a 403 that still arrives as drift.
 *
 * Two absences worth knowing before designing a screen against this module:
 *
 *   - There is NO delete-user endpoint. `DELETE /users/:id` is an unmatched
 *     route and answers 404 `Route not found: DELETE /users/<id>`
 *     (middleware/errorHandler.ts:7-12). Removal is deactivation via PATCH.
 *   - GET /users has no search and no subsidiary filter — only page, limit,
 *     role, isActive (user.schema.ts:47-52). "Find a user by email" must be
 *     built client-side over the paged results.
 */

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * The ONLY user shape this module emits.
 *
 * Every response here — GET /users/me included — goes through the single
 * `present()` at backend/src/modules/users/user.service.ts:16-38, so the self
 * read and the admin read are byte-for-byte identical. There is no
 * admin-enriched variant and no self-redacted variant; a second type would only
 * invite drift.
 *
 * Nine keys, all always present. `updatedAt`, `isDeleted` and `deletedAt` exist
 * on the model and are never serialised — do not reference them.
 */
export interface User {
  /** 24-hex ObjectId string. */
  id: string;
  /** Always lowercase: lowercased by the schema before validation, and again on save. */
  email: string;
  name: string;
  role: Role;
  /**
   * Subsidiary ids. Always an array, `[]` for admins — and NOT guaranteed
   * unique. POST /users/invite existence-checks a de-duplicated set
   * (user.service.ts:47) but persists the raw array (user.service.ts:66), so
   * `['X','X']` comes back duplicated. Only POST /users/:id/subsidiary-access
   * dedupes (user.service.ts:183). Key on index, or dedupe before rendering.
   */
  subsidiaryAccess: string[];
  isActive: boolean;
  isInvitePending: boolean;
  /**
   * ISO-8601 UTC, or `null` for a user who has never signed in. The KEY is
   * always present — `user.lastLoginAt ?? null` (user.service.ts:35).
   */
  lastLoginAt: string | null;
  /** ISO-8601 UTC. */
  createdAt: string;
}

/** The whole `data` payload of DELETE /users/:id/sessions. Not a User. */
export interface ForceLogoutResult {
  /**
   * Sessions actually flipped to revoked (Mongo `modifiedCount`).
   *
   * `0` is a normal 200 and is AMBIGUOUS: the route performs no existence check
   * at all (user.controller.ts:86), so it means either "had no live sessions"
   * or "no such user". The UI cannot distinguish them and must not claim to.
   */
  revokedCount: number;
}

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * One rule sits above every body and query below: the app-wide operator-injection
 * scanner rejects ANY key starting with `$`, containing `.`, or containing `[$`
 * with 400 VALIDATION_ERROR 'Request contains disallowed characters in a field
 * name' (utils/sanitize.ts:31,38; mounted app.ts:102, ahead of the API router).
 *
 * It reads the KEY, not the value — an email or a name may contain dots freely.
 * But a form library that serialises nested fields as `user.name` fails on every
 * endpoint in this module, and that error carries no `fields`, so nothing lights
 * up on the offending input.
 */

/** POST /users/invite — body (user.schema.ts:14-19). */
export interface InviteUserBody {
  /** Trimmed and lowercased before validation, so the response echoes lowercase. */
  email: string;
  /**
   * 1–120 characters AFTER NFKC normalisation, invisible/control-character
   * stripping and trim (utils/safeText.ts). The stored and returned `name` may
   * therefore differ from what was typed — render from the response.
   */
  name: string;
  role: Role;
  /**
   * 24-hex ids, default `[]`.
   *
   * Omit it (or send `[]`) when `role === 'admin'`: the ids are DISCARDED from
   * persistence (user.service.ts:60) but existence-checked FIRST
   * (user.service.ts:57), so a stale or soft-deleted id still 400s an invite
   * that would otherwise have ignored it.
   */
  subsidiaryAccess?: string[];
}

/**
 * PATCH /users/:id — body (user.schema.ts:21-34).
 * At least one of name | role | isActive must be present — see
 * `hasUpdatableFields`. Unknown keys are stripped by Zod, not rejected.
 */
export interface UpdateUserBody {
  name?: string;
  role?: Role;
  isActive?: boolean;
  /**
   * Required only on a true → false transition — `requiresDeactivationConfirm`
   * decides WHEN, `isDeactivationConfirmValid` decides WHAT it must equal.
   */
  confirm?: string;
}

/** POST /users/:id/subsidiary-access — body (user.schema.ts:36-38). */
export interface GrantSubsidiaryAccessBody {
  /** 24-hex id. */
  subsidiaryId: string;
}

/** DELETE /users/:id/subsidiary-access/:subsidiaryId — body. Mandatory. */
export interface RevokeSubsidiaryAccessBody {
  /** The subsidiary's UPPERCASE `code`. See `isRevokeConfirmValid`. */
  confirm: string;
}

/** GET /users — query (user.schema.ts:47-52). Every key optional. */
export interface ListUsersQuery {
  /** Integer ≥ 1, default 1. */
  page?: number;
  /**
   * Integer 1–100, default 20. 100 is a CEILING, not a clamp: the schema is
   * `.max(100)` (user.schema.ts:47-52), so `limit: 250` is 400 VALIDATION_ERROR,
   * not a page silently truncated to 100. An "export everything" view has to
   * walk the pages.
   */
  limit?: number;
  role?: Role;
  /**
   * A STRING enum on the way in, a real boolean on the way back.
   * `z.enum(['true','false'])` at user.schema.ts:51, compared as
   * `query.isActive === 'true'` at user.service.ts:90 — `?isActive=1` or an
   * empty value is 400 VALIDATION_ERROR.
   */
  isActive?: 'true' | 'false';
}

export interface UseUsersOptions extends ListUsersQuery {
  enabled?: boolean;
}

export interface UpdateUserVariables {
  id: string;
  body: UpdateUserBody;
}

export interface GrantSubsidiaryAccessVariables extends GrantSubsidiaryAccessBody {
  /** The user receiving the grant. */
  id: string;
}

export interface RevokeSubsidiaryAccessVariables extends RevokeSubsidiaryAccessBody {
  id: string;
  subsidiaryId: string;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The signed-in user's own record. `requireAuth` only — every role may call it
 * (user.routes.ts:18,21).
 *
 * Not a replacement for `AuthProvider`'s user: this carries none of the session
 * context `req.user` holds internally (requireAuth.ts:38-43) — no sessionId, no
 * permissions, no subsidiary names. It is, however, the only place
 * `isInvitePending`, `lastLoginAt` and `createdAt` are available for oneself.
 */
export function useMe() {
  return useQuery({
    queryKey: ['users', 'me'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<User>('/users/me', { signal });
      return data;
    },
    // Nothing in this payload changes without an admin action, which
    // invalidates below. Refetching on every screen mount would only spend
    // globalLimiter budget (100/min per IP, app.ts:105).
    staleTime: 60_000,
  });
}

/**
 * The admin user list — offset-paginated, sorted `createdAt` DESC
 * (user.service.ts:94), always filtered to `isDeleted: false`.
 *
 * `hasNextPage` reads `page < totalPages`, and `totalPages` is
 * `Math.ceil(total/limit) || 0` (user.service.ts:107) — so an empty result set
 * gives page 1 of 0 pages, and this correctly returns false.
 */
export function useUsers({
  page = 1,
  limit = 20,
  role,
  isActive,
  enabled = true,
}: UseUsersOptions = {}) {
  const list = useOffsetList<User>({
    key: ['users', 'list'],
    path: '/users',
    params: { role, isActive },
    page,
    limit,
    enabled,
  });

  return {
    ...list,
    page,
    /**
     * Compared against the page the CALLER asked for, not the one the cached
     * envelope echoes. `keepPreviousData` holds the old page's envelope during
     * a transition, so reading `pagination.page` leaves Next enabled while the
     * final page loads and a second click requests a page past the end — which
     * answers 200 with an empty array, not an error, and blanks the table.
     */
    hasNextPage: list.pagination ? page < list.pagination.totalPages : false,
  };
}

/**
 * One user by id. Admin only.
 *
 * A malformed (non 24-hex) id is 400 VALIDATION_ERROR with
 * `fields: { id: ['must be a valid id'] }`, NOT 404 (user.schema.ts:5,
 * validate.ts:42). Since the id usually arrives from the URL, a detail screen
 * that renders every error as "Not found" will mislabel a typo — check
 * `isObjectId` first if you want to say something better.
 */
export function useUser(id: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['users', 'detail', id],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<User>(`/users/${id}`, { signal });
      return data;
    },
    enabled: (options?.enabled ?? true) && id.length > 0,
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Invite a user. Responds **201**, and is the only 201 in this module.
 *
 * The invited account is created `isActive: false`, `isInvitePending: true`
 * (user.service.ts:67-68) and cannot authenticate until the emailed link is
 * accepted — requireAuth rejects an inactive user with 401 TOKEN_INVALID
 * (requireAuth.ts:31-33). The link expires after INVITE_TTL_HOURS (default 72).
 *
 * Duplicate email surfaces as 409 under two different messages: 'A user with
 * that email already exists' for a live user (user.service.ts:55) and
 * 'Resource already exists' from the Mongo duplicate-key handler when the email
 * belongs to a SOFT-DELETED user (errorHandler.ts:49-56). Match on the code.
 */
export function useInviteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: InviteUserBody) => {
      const { data } = await api.post<User>('/users/invite', body);
      return data;
    },
    onSuccess: (user) => {
      // Seed from the RESPONSE, never from the submitted form: `name` may have
      // been NFKC-normalised and stripped, `email` lowercased, and an admin
      // invite echoes `subsidiaryAccess: []` whatever was sent.
      queryClient.setQueryData(['users', 'detail', user.id], user);
      // §10.5: invalidate on every mutation.
      return queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/**
 * Update name, role and/or active state.
 *
 * Three server behaviours the caller must plan for:
 *
 *   - Self-action guards, both 403 CANNOT_SELF_DEMOTE: changing your own role
 *     to a DIFFERENT value (user.service.ts:132-134) and deactivating yourself
 *     (user.service.ts:135-137). `canChangeRole` / `canDeactivate` mirror them.
 *   - Deactivating someone else needs `confirm` === their stored email, else
 *     400 CONFIRM_TEXT_MISMATCH (user.service.ts:140-145).
 *   - `role: 'admin'` silently wipes `subsidiaryAccess` to `[]`
 *     (user.service.ts:150), and a successful deactivation revokes every
 *     session that user holds (user.service.ts:158).
 */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: UpdateUserVariables) => {
      const { data } = await api.patch<User>(`/users/${id}`, body);
      return data;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(['users', 'detail', user.id], user);
      // Covers ['users','list',…] and ['users','me'] — an admin editing their
      // own name is the common case for the latter. It does NOT reach
      // `useAuth().user`, which is read from `tokenStore` and only changes on
      // sign-in or a token refresh (AuthProvider.tsx:47-51): rename yourself and
      // the header keeps the old name for up to the access token's remaining
      // life. Render self-facing name/role from `useMe()`, not from `useAuth()`.
      return queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/**
 * Grant one subsidiary. Responds **200**, not 201 — the controller uses
 * `sendData`, not `sendCreated` (user.controller.ts:60). Idempotent: re-granting
 * is a 200 no-op and does not duplicate the id (user.service.ts:183-186).
 *
 * Granting to an admin is 400 INVALID_REQUEST 'Admin users are unscoped and do
 * not take subsidiary grants' (user.service.ts:176-178) — see
 * `canGrantSubsidiaryAccess`. Check order: user 404 → admin 400 → subsidiary 400.
 */
export function useGrantSubsidiaryAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, subsidiaryId }: GrantSubsidiaryAccessVariables) => {
      const body: GrantSubsidiaryAccessBody = { subsidiaryId };
      const { data } = await api.post<User>(`/users/${id}/subsidiary-access`, body);
      return data;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(['users', 'detail', user.id], user);
      return queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/**
 * Revoke one subsidiary — a DELETE that REQUIRES a JSON body.
 *
 * `confirm` is not covered by any Zod schema; the controller reads it raw as
 * `(req.body ?? {})` (user.controller.ts:68) because Express 5 leaves
 * `req.body` UNDEFINED when no parser matched. Passing the body through
 * `api.delete` is what makes this work: rawFetch sets
 * `Content-Type: application/json` whenever a body is present, which is the
 * condition express.json() checks (app.ts:97). Send it any other way and you
 * get 400 CONFIRM_TEXT_MISMATCH with nothing to explain it — nothing ever
 * reports 'confirm is required'.
 *
 * NOT the mirror of grant: there is no admin guard here
 * (user.service.ts:206-223), so revoking from an admin, or revoking a grant the
 * user never held, succeeds as a 200 no-op. Check order: user 404 →
 * subsidiary 404 → confirm 400.
 */
export function useRevokeSubsidiaryAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, subsidiaryId, confirm }: RevokeSubsidiaryAccessVariables) => {
      const body: RevokeSubsidiaryAccessBody = { confirm };
      const { data } = await api.delete<User>(
        `/users/${id}/subsidiary-access/${subsidiaryId}`,
        body,
      );
      return data;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(['users', 'detail', user.id], user);
      return queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/**
 * Force-logout: revoke every live session a user holds.
 *
 * Takes effect on their next request, not at token expiry (requireAuth.ts:35).
 * The id is 24-hex validated (user.routes.ts:54) so a malformed one is 400, but
 * there is no existence check beyond that — an unknown well-formed id returns
 * 200 `{ revokedCount: 0 }`, never 404.
 *
 * No `['users']` invalidation on purpose: sessions are not part of the User
 * document and nothing in this module's payloads changes. What DOES change is
 * the caller's own session list when they target themselves — see
 * `forceLogoutEndsOwnSession`.
 */
export function useForceLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<ForceLogoutResult>(`/users/${id}/sessions`);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

// ─── Guards the UI can disable controls with ─────────────────────────────────

/**
 * ─── THESE ARE UX, NOT AUTHORISATION ────────────────────────────────────────
 * §9.1: "hiding UI elements is not authorization." Every predicate below
 * mirrors a check that also runs on the server, and exists so a user is not
 * offered a button that always fails. Each mutation must still handle the
 * error, because this file can drift and the server cannot.
 * ────────────────────────────────────────────────────────────────────────────
 */

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Ids are validated before the service runs (user.schema.ts:5), so a malformed
 * one is 400 VALIDATION_ERROR — only a well-formed unknown id reaches a 404.
 */
export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

/**
 * CANNOT_SELF_DEMOTE (403) is raised in exactly two places in the whole
 * backend, both in PATCH /users/:id. This is the first: changing your own role
 * to a different value — 'You cannot change your own role'
 * (user.service.ts:132-134).
 *
 * The guard compares `input.role !== user.role`, so re-sending your own CURRENT
 * role is a permitted no-op rather than a 403, which is why `nextRole` is a
 * parameter and not just "is this me".
 */
export function canChangeRole(actorId: string, target: User, nextRole: Role): boolean {
  return target.id !== actorId || nextRole === target.role;
}

/**
 * The second CANNOT_SELF_DEMOTE: 'You cannot deactivate your own account'
 * (user.service.ts:135-137). Renaming yourself is unguarded, and reactivating
 * is not covered at all.
 */
export function canDeactivate(actorId: string, target: User): boolean {
  return target.id !== actorId;
}

/**
 * Whether the PATCH must carry `confirm`.
 *
 * Deactivation is conditional on CURRENT state —
 * `isDeactivating = input.isActive === false && user.isActive`
 * (user.service.ts:139) — so sending `isActive: false` to an already-inactive
 * user needs no confirm, revokes no sessions, and audits as 'user.updated'
 * rather than 'user.deactivated'. Reactivation never needs one.
 */
export function requiresDeactivationConfirm(target: User, nextIsActive: boolean): boolean {
  return nextIsActive === false && target.isActive;
}

/**
 * The deactivation dialog's secret is the target's stored (lowercase) EMAIL,
 * compared raw: no trim, no lowercase, no unicode normalisation
 * (user.service.ts:140-145). A dialog that trims or lowercases the typed value
 * before enabling its button enables it for a string the server will reject
 * with 400 CONFIRM_TEXT_MISMATCH — so compare exactly, as here, and send
 * exactly what was typed.
 */
export function isDeactivationConfirmValid(input: string, target: User): boolean {
  return input === target.email;
}

/**
 * Revoke's secret is a different one: the subsidiary's `code`, which the
 * Subsidiary model stores UPPERCASE (subsidiary.model.ts:18) — 'BCCL', never
 * 'bccl' or ' BCCL'. Also unnormalised on the way in (user.service.ts:214).
 */
export function isRevokeConfirmValid(input: string, subsidiaryCode: string): boolean {
  return input === subsidiaryCode;
}

/**
 * Admins are unscoped and hold no grants. Governs the subsidiary picker on both
 * forms: granting to an admin is 400 (user.service.ts:176-178), and an admin
 * invite existence-checks the ids it is about to discard (user.service.ts:57
 * runs before :60), so a stale id 400s an invite that would have ignored it.
 */
export function canHoldSubsidiaryAccess(role: Role): boolean {
  return role !== 'admin';
}

export function canGrantSubsidiaryAccess(target: User): boolean {
  return canHoldSubsidiaryAccess(target.role);
}

/**
 * A UI rule ONLY — there is no server rule to mirror. `revokeSubsidiaryAccess`
 * (user.service.ts:206-223) has neither an admin guard nor a membership check,
 * so revoking a grant the user never held is a 200 no-op. Offering Revoke only
 * where a grant exists keeps the confirmation dialog from asking for a
 * subsidiary code to accomplish nothing.
 */
export function canRevokeSubsidiaryAccess(target: User, subsidiaryId: string): boolean {
  return target.subsidiaryAccess.includes(subsidiaryId);
}

/**
 * Promoting to admin SILENTLY WIPES `subsidiaryAccess` to `[]`
 * (user.service.ts:150), and demoting again does not restore the grants. Worth
 * a confirmation step, and worth re-rendering from the response afterwards.
 */
export function willWipeSubsidiaryAccess(target: User, nextRole: Role): boolean {
  return nextRole === 'admin' && target.subsidiaryAccess.length > 0;
}

/**
 * PATCH needs at least one of name | role | isActive. A body of `{}`, or one
 * carrying only `confirm`, fails with
 * `fields: { body: ['At least one field must be provided'] }` — keyed on 'body',
 * not on a field name (middleware/validate.ts:51), so a per-field form error
 * display shows the user nothing at all.
 */
export function hasUpdatableFields(body: UpdateUserBody): boolean {
  return body.name !== undefined || body.role !== undefined || body.isActive !== undefined;
}

/**
 * DELETE /users/:id/sessions has NO self-action guard — an admin may
 * force-logout themselves and the backend will do it, killing the current
 * session so that every subsequent request answers 401 TOKEN_INVALID 'Session
 * is no longer valid'. Warn on this; do not disable, because it is a legitimate
 * "sign me out everywhere" action.
 */
export function forceLogoutEndsOwnSession(actorId: string, targetId: string): boolean {
  return actorId === targetId;
}
