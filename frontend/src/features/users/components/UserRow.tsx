'use client';

import { useState } from 'react';
import { ROLE_LABELS } from '@/auth/permissions';
import { ROLES, type Role } from '@/auth/types';
import {
  canChangeRole,
  canDeactivate,
  canHoldSubsidiaryAccess,
  forceLogoutEndsOwnSession,
  requiresDeactivationConfirm,
  useForceLogout,
  useUpdateUser,
  willWipeSubsidiaryAccess,
  type UpdateUserBody,
  type User,
} from '@/features/users/api';
import { SubsidiaryAccessPanel } from '@/features/users/components/SubsidiaryAccessPanel';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { InlineError, StatusMessage } from '@/components/ui/Feedback';
import { Field, Select } from '@/components/ui/Field';
import { ChevronDownIcon } from '@/components/ui/Icon';
import { TD, TR } from '@/components/ui/Table';
import { userMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/datetime';

/**
 * One user in the admin list, plus the controls for that user.
 *
 * The controls live in a details row rather than in the cells: a role
 * role dropdown sitting in a dense table is one stray click away from a role
 * change, and every action here is either irreversible or ends someone's
 * session. Opening "Manage" is the deliberate step before any of them.
 */

/** At most this many subsidiary codes in the summary cell before it counts. */
const CODES_SHOWN = 3;

type Dialog = 'promote' | 'deactivate' | 'force-logout';

export function UserRow({
  user,
  actorId,
  canManage,
  colSpan,
}: {
  user: User;
  /** The signed-in admin, for the two self-action guards. */
  actorId: string;
  canManage: boolean;
  colSpan: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [logoutNote, setLogoutNote] = useState<string | null>(null);

  const update = useUpdateUser();
  const forceLogout = useForceLogout();

  const isSelf = user.id === actorId;
  /**
   * `canChangeRole` compares against the role being SENT, not just "is this
   * me" — re-sending your own current role is a permitted no-op, only a
   * different one is 403 CANNOT_SELF_DEMOTE. Filtering the options with it
   * leaves an admin exactly one choice: the role they already have.
   */
  const roleOptions = ROLES.filter((option) => canChangeRole(actorId, user, option));
  const roleLocked = roleOptions.length < ROLES.length;

  const grants = [...new Set(user.subsidiaryAccess)];
  const detailsId = `user-${user.id}-manage`;
  const busy = update.isPending || forceLogout.isPending;

  function closeDialog() {
    setDialog(null);
    setPendingRole(null);
    // Clears a failure the dialog already showed, so the same message does not
    // reappear inline the moment the dialog is dismissed.
    update.reset();
  }

  function changeRole(next: Role) {
    if (next === user.role) return;
    if (willWipeSubsidiaryAccess(user, next)) {
      setPendingRole(next);
      setDialog('promote');
      return;
    }
    update.mutate({ id: user.id, body: { role: next } });
  }

  async function deactivate(confirmText: string) {
    const body: UpdateUserBody = { isActive: false };
    /**
     * `requiresDeactivationConfirm` decides WHEN the field is needed: only on a
     * true → false transition. Sending `isActive: false` to an already-inactive
     * user needs no confirm, revokes no sessions, and audits differently.
     */
    if (requiresDeactivationConfirm(user, false)) body.confirm = confirmText;
    await update.mutateAsync({ id: user.id, body });
  }

  async function endSessions() {
    const result = await forceLogout.mutateAsync(user.id);
    /**
     * `revokedCount: 0` is a normal 200 and genuinely ambiguous — the route
     * runs no existence check, so it means "had no live sessions" OR "no such
     * user". The wording below is true either way; anything more specific
     * would be a claim the API did not make.
     */
    setLogoutNote(
      result.revokedCount > 0
        ? `${result.revokedCount} session${result.revokedCount === 1 ? '' : 's'} revoked.`
        : 'No live sessions were revoked.',
    );
  }

  return (
    <>
      <TR>
        <TD>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text-default">{user.name}</span>
            {isSelf ? (
              <span className="rounded-full bg-primary-dark/10 px-2 py-0.5 text-xs font-medium text-primary-dark">
                You
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block break-all text-xs text-text-muted">{user.email}</span>
        </TD>

        <TD>{ROLE_LABELS[user.role]}</TD>

        <TD>
          {/*
            Two independent facts, so two badges: an invited account can also be
            deactivated, and collapsing them into one label hides whichever came
            second. Each badge carries its own shape and text (§6, Badge).
          */}
          <span className="flex flex-wrap gap-1.5">
            {user.isActive ? (
              <Badge tone="success" srPrefix="Account">
                Active
              </Badge>
            ) : (
              <Badge tone="neutral" srPrefix="Account">
                Deactivated
              </Badge>
            )}
            {user.isInvitePending ? (
              <Badge tone="pending" srPrefix="Invite">
                Invite pending
              </Badge>
            ) : null}
          </span>
        </TD>

        <TD>
          {!canHoldSubsidiaryAccess(user.role) ? (
            <span className="text-text-muted">Unscoped — reads every subsidiary</span>
          ) : grants.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              {grants.slice(0, CODES_SHOWN).map((id) => (
                <span key={id} className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">
                  <SubsidiaryLabel id={id} />
                </span>
              ))}
              {grants.length > CODES_SHOWN ? (
                <span className="text-xs text-text-muted">
                  +{grants.length - CODES_SHOWN} more
                </span>
              ) : null}
            </span>
          )}
        </TD>

        <TD>
          {user.lastLoginAt ? (
            <span className="text-text-muted">{formatRelative(user.lastLoginAt)}</span>
          ) : (
            <span className="text-text-muted">Never</span>
          )}
        </TD>

        <TD>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((open) => !open)}
            icon={
              <ChevronDownIcon
                size={14}
                className={cn('transition-transform', expanded && 'rotate-180')}
              />
            }
          >
            {/* The name has to say WHO, or a screen reader hears "Manage" six times. */}
            Manage<span className="sr-only"> {user.name}</span>
          </Button>
        </TD>
      </TR>

      {/*
        A details row spanning the table. Written as raw `tr`/`td` because `TD`
        takes no `colSpan` and `TEmpty` is the empty-list message, not this —
        the rest of the row furniture still comes from the library.

        Always in the tree, hidden by a class rather than unmounted, so the
        `aria-controls` above always resolves to a real element. Its CONTENTS
        are conditional: mounting a subsidiary panel per row would be twenty
        panels for the one a user opens.
      */}
      <tr id={detailsId} className={cn('bg-surface-muted', !expanded && 'hidden')}>
        <td colSpan={colSpan} className="px-4 py-5">
          {expanded ? (
            <div className="flex flex-col gap-6">
              {!canManage ? (
                <p className="text-sm text-text-muted">
                  Your role does not permit user administration.
                </p>
              ) : (
                <>
                  <div className="grid gap-6 md:grid-cols-2">
                    <Field
                      label="Role"
                      className="max-w-sm"
                      description={
                        roleLocked
                          ? 'You cannot change your own role. Another administrator has to do it.'
                          : 'Promoting to Administrator clears every subsidiary grant, and demoting again does not bring them back.'
                      }
                    >
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={user.role}
                          disabled={roleLocked || busy}
                          onChange={(role) => changeRole(role as Role)}
                        >
                          {roleOptions.map((option) => (
                            <option key={option} value={option}>
                              {ROLE_LABELS[option]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>

                    <div className="flex flex-col gap-2">
                      <p className="text-sm font-medium text-text-default">Account</p>
                      {user.isActive ? (
                        <>
                          <span>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={!canDeactivate(actorId, user) || busy}
                              onClick={() => setDialog('deactivate')}
                            >
                              Deactivate<span className="sr-only"> {user.name}</span>
                            </Button>
                          </span>
                          <p className="text-xs text-text-muted">
                            {canDeactivate(actorId, user)
                              ? 'Ends every session they hold and blocks sign-in. This is how an account is removed — there is no delete.'
                              : 'You cannot deactivate your own account.'}
                          </p>
                        </>
                      ) : (
                        <>
                          <span>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              busy={update.isPending}
                              busyLabel="Activating…"
                              onClick={() =>
                                update.mutate({ id: user.id, body: { isActive: true } })
                              }
                            >
                              Activate<span className="sr-only"> {user.name}</span>
                            </Button>
                          </span>
                          <p className="text-xs text-text-muted">
                            {user.isInvitePending
                              ? 'They still have to accept the emailed invite link before they can sign in.'
                              : 'Restores sign-in. Their subsidiary grants are unchanged.'}
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  <SubsidiaryAccessPanel user={user} disabled={busy} />

                  <div className="flex flex-col gap-2 border-t border-border pt-4">
                    <p className="text-sm font-medium text-text-default">Sessions</p>
                    <span>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDialog('force-logout')}
                      >
                        Force sign-out<span className="sr-only"> {user.name}</span>
                      </Button>
                    </span>
                    <p className="text-xs text-text-muted">
                      {/*
                        There is no self-guard on this endpoint, and killing your
                        own sessions is a legitimate "sign me out everywhere" —
                        so this warns rather than disables.
                      */}
                      {forceLogoutEndsOwnSession(actorId, user.id)
                        ? 'This is your own account: it will end this session too, and you will be signed out here.'
                        : 'Revokes every live session. It takes effect on their next request, not when their token expires.'}
                    </p>
                    {logoutNote ? <StatusMessage>{logoutNote}</StatusMessage> : null}
                    {/*
                      No inline copy of `forceLogout.error`. The dialog is this
                      mutation's only trigger, `ConfirmDialog` renders the
                      rejection it caught and stays open on it, and dismissing
                      the dialog resets the mutation — so a second alert here
                      could only ever fire simultaneously with the dialog's,
                      announcing one failure twice.
                    */}
                  </div>

                  {/*
                    Every mutation still handles its own failure: the predicates
                    above are UX, and a 403 that arrives anyway means this file
                    has drifted from the server (§9.1).
                  */}
                  {update.error && dialog === null ? (
                    <InlineError>{userMessage(update.error)}</InlineError>
                  ) : null}

                  {/*
                    The dialogs live inside this cell, not beside the rows: a
                    `dialog` element is flow content and `tbody` takes nothing
                    but `tr`, so parking them one level up would be markup the
                    HTML parser reshuffles out from under React. They are only
                    reachable from the controls above, which exist only here.
                  */}
                  {pendingRole ? (
                    <ConfirmDialog
                      open={dialog === 'promote'}
                      onClose={closeDialog}
                      title="Promote to Administrator?"
                      description={`${user.name} holds ${grants.length} subsidiary ${
                        grants.length === 1 ? 'grant' : 'grants'
                      }. Administrators are unscoped, so those grants are cleared — changing the role back later does not restore them.`}
                      confirmLabel="Promote"
                      busyLabel="Promoting…"
                      variant="primary"
                      onConfirm={() =>
                        update.mutateAsync({ id: user.id, body: { role: pendingRole } })
                      }
                    />
                  ) : null}

                  <ConfirmDialog
                    open={dialog === 'deactivate'}
                    onClose={closeDialog}
                    title="Deactivate this account?"
                    description={`${user.name} is signed out of every session and blocked from signing in again. An administrator can reactivate them later.`}
                    confirmLabel="Deactivate"
                    busyLabel="Deactivating…"
                    // Compared byte for byte on the server — no trim, no case
                    // folding — against the stored, lowercase email. That is
                    // the rule `isDeactivationConfirmValid` mirrors, and it is
                    // a DIFFERENT secret from the revoke dialog's.
                    expectedText={user.email}
                    expectedTextLabel="the email address"
                    onConfirm={deactivate}
                  />

                  <ConfirmDialog
                    open={dialog === 'force-logout'}
                    onClose={() => {
                      setDialog(null);
                      forceLogout.reset();
                    }}
                    title="End all sessions?"
                    description={
                      forceLogoutEndsOwnSession(actorId, user.id)
                        ? 'This is your own account. Every session is revoked, including this one, and the next thing you do here will send you back to sign-in.'
                        : `${user.name} is signed out everywhere on their next request. They can sign in again straight away.`
                    }
                    confirmLabel="Force sign-out"
                    busyLabel="Revoking…"
                    onConfirm={endSessions}
                  />
                </>
              )}
            </div>
          ) : null}
        </td>
      </tr>
    </>
  );
}
