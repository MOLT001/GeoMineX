'use client';

import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { can, ROLE_LABELS } from '@/auth/permissions';
import { ROLES, type Role } from '@/auth/types';
import { useUsers } from '@/features/users/api';
import { InviteUserPanel } from '@/features/users/components/InviteUserPanel';
import { UserRow } from '@/features/users/components/UserRow';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Field, Select } from '@/components/ui/Field';
import { PlusIcon } from '@/components/ui/Icon';
import { PageHeader, Section, Toolbar } from '@/components/ui/Layout';
import { OffsetPagination, TableFrame, TBody, TEmpty, TH, THead } from '@/components/ui/Table';
import { cn } from '@/lib/cn';

/**
 * User administration — PRD §5.9.
 *
 * `RequireRole` in app/(app)/admin/layout.tsx already refuses this route to
 * everyone but an admin, so nothing here re-checks the role for page access.
 * What this screen does enforce are the per-user rules the server applies on
 * top of it — self-demotion, self-deactivation and the two typed confirmations
 * — which live in `UserRow` and `SubsidiaryAccessPanel`.
 */

/** Header cells below. The details row a `UserRow` opens spans all of them. */
const COLUMNS = 6;

/** The server's own default, and well under the `.max(100)` ceiling on `limit`. */
const PAGE_SIZE = 20;

export default function AdminUsersPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState<Role | undefined>(undefined);
  const [isActive, setIsActive] = useState<'true' | 'false' | undefined>(undefined);
  const [inviteOpen, setInviteOpen] = useState(false);

  /**
   * Not the access control (§9.1) — the layout gate and `roleGuard('admin')`
   * are. Seven of the module's eight routes carry that guard
   * (user.routes.ts:24,26,28,33,40,47,54); GET /users/me is `requireAuth` only
   * (user.routes.ts:18,21) and is not reached from this screen. This mirrors
   * them so the controls disappear rather than 403 if the route gate and the
   * capability table ever drift apart.
   */
  const canManage = can(user, 'user:manage');

  const {
    items,
    pagination,
    page: listPage,
    isPending,
    isPlaceholderData,
    error,
    refetch,
  } = useUsers({ page, limit: PAGE_SIZE, role, isActive });

  const filtered = role !== undefined || isActive !== undefined;

  function clearFilters() {
    setRole(undefined);
    setIsActive(undefined);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Users"
        description="Invite people, set their role, and control which subsidiaries they can read. There is no delete: removing someone means deactivating them, which also ends every session they hold."
        actions={
          canManage ? (
            <Button
              variant="primary"
              // No plus sign while the label reads "Close": an icon that
              // contradicts its own label is worse than no icon.
              icon={inviteOpen ? undefined : <PlusIcon size={16} />}
              aria-expanded={inviteOpen}
              aria-controls="invite-panel"
              onClick={() => setInviteOpen((open) => !open)}
            >
              {inviteOpen ? 'Close invite form' : 'Invite user'}
            </Button>
          ) : null
        }
      />

      {/*
        Always in the tree, so the `aria-controls` above never dangles — but
        `hidden`, not merely empty. An empty div is still a flex item and still
        spends a `gap-8` slot, which doubled the space under the header in the
        state this page is in nearly all the time. `display: none` takes it out
        of the flex flow entirely.
      */}
      <div id="invite-panel" className={cn(!inviteOpen && 'hidden')}>
        {inviteOpen ? <InviteUserPanel onClose={() => setInviteOpen(false)} /> : null}
      </div>

      <Section
        id="user-list"
        title="All users"
        description="Newest first. An invited account stays inactive, and cannot sign in, until the emailed link is accepted."
      >
        <Toolbar>
          <Field label="Role" className="w-52">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={role ?? ''}
                onChange={(next) => {
                  setRole(next === '' ? undefined : (next as Role));
                  // A filter change re-slices the collection, so the old offset
                  // means nothing — page 4 of the new result set may not exist.
                  setPage(1);
                }}
              >
                <option value="">All roles</option>
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Status" className="w-64">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={isActive ?? ''}
                onChange={(next) => {
                  // The list filter is a STRING enum on the way in, even though
                  // the field comes back as a real boolean: `?isActive=1` or an
                  // empty value is 400, so these three states are all there are.
                  setIsActive(next === '' ? undefined : (next as 'true' | 'false'));
                  setPage(1);
                }}
              >
                <option value="">Any status</option>
                <option value="true">Active</option>
                <option value="false">Inactive (includes pending invites)</option>
              </Select>
            )}
          </Field>

          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </Toolbar>

        {isPending ? <LoadingBlock label="Loading users" rows={5} /> : null}

        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

        {!isPending && !error ? (
          <>
            {/*
              `keepPreviousData` keeps the previous page on screen while the next
              one loads. Dimming it and marking it busy is what says those rows
              are stale — without it, a page turn reads as nothing happening.
            */}
            <div
              aria-busy={isPlaceholderData || undefined}
              className={cn('transition-opacity', isPlaceholderData && 'opacity-60')}
            >
              <TableFrame caption="Users">
                <THead>
                  <tr>
                    <TH>User</TH>
                    <TH>Role</TH>
                    <TH>Status</TH>
                    <TH>Subsidiary access</TH>
                    <TH>Last sign-in</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {items.length === 0 ? (
                    <TEmpty colSpan={COLUMNS}>
                      {filtered ? (
                        <>
                          No users match these filters.
                          <span className="mt-3 block">
                            <Button variant="secondary" size="sm" onClick={clearFilters}>
                              Clear filters
                            </Button>
                          </span>
                        </>
                      ) : (
                        'No users yet.'
                      )}
                    </TEmpty>
                  ) : (
                    items.map((row) => (
                      <UserRow
                        key={row.id}
                        user={row}
                        // `RequireAuth` guarantees a user beneath this layout;
                        // the fallback only keeps the self-action guards from
                        // being evaluated against `undefined`, which would
                        // offer an admin the controls the server refuses.
                        actorId={user?.id ?? ''}
                        canManage={canManage}
                        colSpan={COLUMNS}
                      />
                    ))
                  )}
                </TBody>
              </TableFrame>
            </div>

            {pagination ? (
              <OffsetPagination
                // The page the hook was ASKED for, not the one the cached
                // envelope echoes: during a transition the envelope still
                // describes the previous page, which would print the wrong
                // number and leave Next live one page past the end.
                page={listPage}
                totalPages={pagination.totalPages}
                total={pagination.total}
                onPageChange={setPage}
                busy={isPlaceholderData}
              />
            ) : null}
          </>
        ) : null}
      </Section>
    </div>
  );
}
