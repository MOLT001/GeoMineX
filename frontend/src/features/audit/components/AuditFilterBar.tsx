'use client';

import { useAuth } from '@/auth/AuthProvider';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import {
  canFilterAuditByUser,
  FILTERABLE_AUDIT_ACTIONS,
  type AuditAction,
  type AuditLogFilters,
} from '@/features/audit/api';
import { useUsers } from '@/features/users/api';
import { auditActionParts } from './AuditEntryRow';

/**
 * The audit filter strip — PRD §5.10.
 *
 * Three controls, because the endpoint accepts three params and no others
 * (audit.routes.ts:17-24): `action`, `subsidiaryId`, `userId`. There is no
 * `from`/`to`, no `targetType` and no free-text search, so this bar deliberately
 * offers no date range: a picker the API cannot honour either lies about the
 * result set or has to be applied to the loaded pages only, which would report
 * "N loaded" for a number the cursor never advanced past.
 */

/** `''` is "no filter" for each control, so every dropdown stays controlled. */
export interface AuditFilterState {
  action: AuditAction | '';
  subsidiaryId: string;
  /** Admin only — see `canFilterAuditByUser`. */
  userId: string;
}

export const NO_AUDIT_FILTERS: AuditFilterState = { action: '', subsidiaryId: '', userId: '' };

export function hasAuditFilters(filters: AuditFilterState): boolean {
  return filters.action !== '' || filters.subsidiaryId !== '' || filters.userId !== '';
}

/**
 * Only the keys that carry a value are sent. An empty `action` would serialise
 * as `?action=` and fail the enum with a 400 rather than meaning "any", and
 * every key is listed out rather than spread so nothing else can ride along into
 * the query string past `rejectOperatorInjection` (utils/sanitize.ts:45-59).
 */
export function toAuditLogFilters(filters: AuditFilterState): AuditLogFilters {
  return {
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.subsidiaryId ? { subsidiaryId: filters.subsidiaryId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
  };
}

/**
 * The size of one page of the user directory — the schema's CEILING, not a
 * clamp (user.schema.ts:47-52): 101 would be a 400, not a truncated page.
 *
 * Exported because the audit page resolves actor names from the same
 * `useUsers` call. `useOffsetList` puts params, page and limit in the query
 * key, so the two hooks share one cache entry only while both pass this value.
 */
export const USER_DIRECTORY_PAGE = 100;

export function AuditFilterBar({
  value,
  onChange,
}: {
  value: AuditFilterState;
  onChange: (next: AuditFilterState) => void;
}) {
  const { user } = useAuth();

  /*
    The user filter exists for an admin and nobody else. For a non-admin the
    param is validated and then dropped: another user's id answers 404 and denies
    the whole list, and their own id returns exactly the rows they already see
    (audit.routes.ts:47-62). Shipping the control to them would be a no-op that
    looks broken, so it is not rendered — and `enabled` keeps GET /users, which is
    roleGuard('admin'), from being called by someone who would only get a 403.
  */
  const canFilterByUser = canFilterAuditByUser(user);
  const directory = useUsers({ limit: USER_DIRECTORY_PAGE, enabled: canFilterByUser });

  return (
    <Toolbar>
      <Field label="Action" className="w-full sm:w-56">
        {(fieldProps) => (
          <Select
            {...fieldProps}
            value={value.action}
            onChange={(next) => {
              onChange({ ...value, action: isFilterableAction(next) ? next : '' });
            }}
          >
            <option value="">All actions</option>
            {ACTION_GROUPS.map((group) => (
              <optgroup key={group.domain} label={group.label}>
                {group.actions.map((action) => (
                  <option key={action} value={action}>
                    {auditActionParts(action).verbLabel}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
      </Field>

      <div className="w-full sm:w-56">
        <SubsidiaryPicker
          value={value.subsidiaryId}
          onChange={(subsidiaryId) => onChange({ ...value, subsidiaryId })}
          allowAll
        />
      </div>

      {canFilterByUser ? (
        <Field
          label="User"
          className="w-full sm:w-64"
          /*
            The directory is offset-paginated, sorted `createdAt` DESC
            (user.service.ts:94), and this reads page one only — so older
            accounts are genuinely absent rather than merely unlisted. A FAILED
            read leaves the same control holding a single "All users" option,
            which is indistinguishable from "there is nobody else" unless it
            says so.
          */
          description={
            directory.isError
              ? 'The user directory could not be loaded, so no users are listed.'
              : directory.hasNextPage
                ? `The ${USER_DIRECTORY_PAGE} most recently created accounts.`
                : undefined
          }
        >
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.userId}
              disabled={directory.isPending}
              onChange={(userId) => onChange({ ...value, userId })}
            >
              <option value="">{directory.isPending ? 'Loading…' : 'All users'}</option>
              {directory.items.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} — {account.email}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {hasAuditFilters(value) ? (
        <Button variant="secondary" size="sm" onClick={() => onChange(NO_AUDIT_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </Toolbar>
  );
}

function isFilterableAction(candidate: string): candidate is AuditAction {
  return (FILTERABLE_AUDIT_ACTIONS as readonly string[]).includes(candidate);
}

/**
 * The picker groups by domain, so `document.uploaded` and `document.retried` sit
 * together instead of forty flat values in enum order. `FILTERABLE_AUDIT_ACTIONS`
 * rather than `AUDIT_ACTIONS`: the three the running API can never emit would
 * return an empty page every time and read as a broken filter.
 *
 * Module scope — the enum is a constant, so there is nothing here to recompute
 * per render.
 */
const ACTION_GROUPS = groupActionsByDomain(FILTERABLE_AUDIT_ACTIONS);

function groupActionsByDomain(actions: readonly AuditAction[]) {
  const byDomain = new Map<string, { label: string; actions: AuditAction[] }>();

  for (const action of actions) {
    const { domain, domainLabel } = auditActionParts(action);
    const group = byDomain.get(domain);
    if (group) group.actions.push(action);
    else byDomain.set(domain, { label: domainLabel, actions: [action] });
  }

  return [...byDomain.entries()].map(([domain, group]) => ({ domain, ...group }));
}
