import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/client';

/**
 * Subsidiaries — the reference list behind every subsidiary picker in the app.
 *
 * The backend module is two routes and nothing else: `GET /subsidiaries` and
 * `POST /subsidiaries` (subsidiary.routes.ts, 70 lines; mounted once at
 * routes/index.ts:50). There is no by-id route, no PATCH and no DELETE — a
 * subsidiary cannot be renamed or recoded through the API at all, and a screen
 * that needs ONE subsidiary reads the list and looks it up. `useSubsidiaryMap`
 * exists for exactly that.
 */

/**
 * The only subsidiary shape this API returns — identical for the list item and
 * the create response, both produced by inline object literals
 * (subsidiary.routes.ts:41 and :66).
 *
 * `isDeleted`, `deletedAt`, `createdAt` and `updatedAt` all exist on the model
 * (subsidiary.model.ts:3-11) and are stripped by those literals. There are no
 * timestamps anywhere in this module; do not type this off the Mongoose schema.
 */
export interface Subsidiary {
  id: string;
  /** Free text as submitted, trimmed server-side. e.g. "Bharat Coking Coal Limited" */
  name: string;
  /** Always uppercase on the way out — see `useCreateSubsidiary`. e.g. "BCCL" */
  code: string;
}

/** What a picker option or a table cell needs in order to render a bare id. */
export interface SubsidiaryLabel {
  code: string;
  name: string;
}

/**
 * Every subsidiary the signed-in user may see, already sorted by `code`
 * ascending (`.sort({ code: 1 })` at the handler) — render as-is, do not
 * re-sort.
 *
 * The base filter is always `{ isDeleted: false }`, so a soft-deleted
 * subsidiary is missing from this list while its id lives on in the documents,
 * reports and analytics rows that already reference it — analytics looks those
 * up with no `isDeleted` filter and still returns their `code`
 * (analytics.service.ts:415-420). This list is therefore not a complete
 * id → label table for historical rows; see `useSubsidiaryMap`.
 *
 * SCOPED, and not the way the rest of the product reads. On top of that base
 * filter the handler adds
 * `_id: { $in: user.subsidiaryAccess.map((id) => new Types.ObjectId(id)) }`
 * for every role except `admin` — the grants are CAST, not matched as the raw
 * strings `requireAuth` put on `req.user` (subsidiary.routes.ts:29-46, cast at
 * :35; `isUnscoped()` is true for `admin` only, utils/authorization.ts:33-35).
 * An `moc_official` is scoped here exactly like a `cil_user` despite being a
 * cross-subsidiary reviewer elsewhere — it sees only its explicit grants. An
 * out-of-scope subsidiary is simply absent from the array, never flagged.
 *
 * So a user with no grants gets HTTP 200 and `data: []`, never an error. Any
 * screen that gates on a chosen subsidiary (document upload, report drafting)
 * has to treat "zero options" as a state of its own; waiting for a failure that
 * never arrives leaves a dead picker on screen.
 *
 * Not paginated and not filterable: the route reads no query params and emits
 * no `pagination` key, so `data` is always the complete visible set and its
 * length is a real total, not a page. Passing arbitrary client state through as
 * a query param is worse than useless here — it is ignored, and the app-wide
 * operator-injection scanner 400s any key containing `.` or starting with `$`
 * (utils/sanitize.ts:45-59).
 */
export function useSubsidiaries() {
  return useQuery({
    queryKey: ['subsidiaries'],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<Subsidiary[]>('/subsidiaries', { signal });
      return data;
    },
    /**
     * Deliberately far above the 30s global default, and paired with a gcTime
     * long enough to survive navigation between screens.
     *
     * This list is edited by hand roughly never, and it is read by a picker on
     * most screens — so the cost of a short staleTime is a refetch per mount
     * for data that did not change. Both routes sit under `globalLimiter`
     * alone: 100 requests/minute keyed on IP across ALL /api traffic
     * (rateLimiters.ts:30, app.ts:105). Behind the §11.9 same-origin rewrite an
     * office can share one source IP, so a chatty picker spends everyone's
     * budget.
     */
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
  });
}

/**
 * `id -> { code, name }` for the subsidiary ids that arrive on documents,
 * reports and queries.
 *
 * There is no `GET /subsidiaries/:id`, so this list IS the lookup table. It
 * reads the same query key as `useSubsidiaries`, so the lookup costs no extra
 * request no matter how many cells call it.
 *
 * A miss returns `undefined` rather than a placeholder, because THREE different
 * situations produce one: the list has not loaded yet; the id belongs to a
 * subsidiary outside this user's grants; or the subsidiary is soft-deleted, so
 * the `{ isDeleted: false }` base filter drops it here while the document or
 * report still carries its id. Only the caller knows whether its cell should
 * show a skeleton or a dash.
 *
 * The spread query state (`isPending`) separates the first from the other two.
 * Nothing separates the second from the third, deliberately: naming a
 * subsidiary the user does not hold rebuilds the existence oracle the API's
 * 404-not-403 convention exists to hide (lib/api/errors.ts). Render a dash.
 */
export function useSubsidiaryMap() {
  const query = useSubsidiaries();

  const byId = useMemo(() => {
    const map = new Map<string, SubsidiaryLabel>();
    for (const subsidiary of query.data ?? []) {
      map.set(subsidiary.id, { code: subsidiary.code, name: subsidiary.name });
    }
    return map;
  }, [query.data]);

  return { ...query, byId };
}

/** Body for `POST /subsidiaries` — both fields required (subsidiary.routes.ts:17-20). */
export interface CreateSubsidiaryBody {
  name: string;
  code: string;
}

/**
 * The lengths the server enforces, mirrored so a form checks the same numbers.
 *
 * Validate the TRIMMED value against them. Zod runs `.min()`/`.max()` BEFORE
 * `.trim()` (subsidiary.routes.ts:18-19), so `name: "   "` passes `min(1)` and
 * is stored as `""`, and `code: " a "` is three characters, passes `min(2)`,
 * and is stored as `"A"` — one character, below the advertised minimum. A form
 * that measures the untrimmed string disagrees with the API about what is
 * valid, in the direction that lets junk through.
 */
export const SUBSIDIARY_LIMITS = {
  name: { min: 1, max: 200 },
  code: { min: 2, max: 16 },
} as const;

/**
 * Create a subsidiary. Admin only, and the gate runs EARLY: `roleGuard('admin')`
 * is mounted ahead of `validate()` (subsidiary.routes.ts:48), so a non-admin
 * submitting a malformed body gets 403 FORBIDDEN and never a 400. Do not read a
 * 403 as "the body was fine" — gate the control with
 * `can(user, 'subsidiary:create')` before the form is reachable.
 *
 * The row that comes back can differ from what was submitted: both fields are
 * trimmed, and `code` is uppercased twice — zod `.toUpperCase()` on input and
 * mongoose `uppercase: true` on the model (subsidiary.model.ts:18). Send any
 * case; render the RESPONSE, never the submitted values.
 *
 * A duplicate `code` answers 409 with two different messages. The pre-check on
 * `{ code, isDeleted: false }` says "A subsidiary with that code already
 * exists"; reusing the code of a SOFT-DELETED subsidiary slips past that check
 * (the unique index at subsidiary.model.ts:25 is global, not partial on
 * `isDeleted`) and dies on the Mongo duplicate-key path, which reports
 * "Resource already exists" instead (errorHandler.ts:49-56). Match on
 * `error.code === 'CONFLICT'`, never on the message string.
 *
 * And `VALIDATION_ERROR` does NOT imply `error.fields` exists — malformed JSON
 * fails outside `validate()` with a bare message (errorHandler.ts:71-77), as
 * does an over-10kb body with 413 PAYLOAD_TOO_LARGE (errorHandler.ts:62-69).
 * Guard the access and fall back to `userMessage(error)`.
 *
 * When `fields` IS present its keys are the BARE zod paths — `name`, `code` —
 * not the `body.`-qualified form (validate.ts:49-54). `fieldErrorsOf` in
 * components/ui/Field tries `body.name` first and falls through to `name`, so
 * use it rather than indexing `error.fields` directly. The remaining key,
 * `body`, is where a missing `Content-Type` lands because Express 5 leaves
 * `req.body` undefined; that one is unreachable from here — `rawFetch` sets the
 * header whenever a body is present.
 */
export function useCreateSubsidiary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSubsidiaryBody) => {
      const { data } = await api.post<Subsidiary>('/subsidiaries', body);
      return data;
    },
    // §10.5: invalidate on every mutation. The one key covers the list and the
    // `useSubsidiaryMap` lookup built on it — they share a cache entry. The long
    // staleTime above makes this the only thing that refreshes a picker within
    // the hour, so it must not be skipped.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['subsidiaries'] }),
  });
}
