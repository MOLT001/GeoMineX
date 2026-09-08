'use client';

import { useState } from 'react';
import {
  canGrantSubsidiaryAccess,
  canRevokeSubsidiaryAccess,
  useGrantSubsidiaryAccess,
  useRevokeSubsidiaryAccess,
  type User,
} from '@/features/users/api';
import { useSubsidiaryMap } from '@/features/subsidiaries/api';
import { SubsidiaryLabel, SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { InlineError } from '@/components/ui/Feedback';
import { userMessage } from '@/lib/api/errors';

/**
 * Which subsidiaries one user may read — PRD §5.9, §11.4.
 *
 * Grant and revoke are not mirror images on the server, and the difference
 * shows up here: granting to an admin is a 400, while revoking has no admin
 * guard and no membership check at all, so revoking a grant nobody holds is a
 * 200 that changes nothing. Revoke is therefore offered only where a grant
 * actually exists — otherwise the dialog asks for a subsidiary code in order
 * to accomplish nothing.
 */
export function SubsidiaryAccessPanel({
  user,
  disabled = false,
}: {
  user: User;
  disabled?: boolean;
}) {
  const { byId, isPending: codesPending } = useSubsidiaryMap();
  const grant = useGrantSubsidiaryAccess();
  const revoke = useRevokeSubsidiaryAccess();
  const [selected, setSelected] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; code: string } | null>(null);

  /**
   * `subsidiaryAccess` is not a unique set — the invite path persists the array
   * it was sent verbatim, so `['X','X']` comes back duplicated. Deduplicating
   * before rendering keeps the list honest and the React keys unique.
   */
  const grants = [...new Set(user.subsidiaryAccess)];
  const canGrant = canGrantSubsidiaryAccess(user);
  const alreadyGranted = selected !== '' && grants.includes(selected);
  const busy = disabled || grant.isPending || revoke.isPending;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <p className="text-sm font-medium text-text-default">Subsidiary access</p>

      {grants.length === 0 ? (
        <p className="text-sm text-text-muted">
          {canGrant
            ? 'No grants yet. Without one, this user can read nothing.'
            : 'Administrators are unscoped: they read every subsidiary and hold no grants.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {grants.map((id) => {
            /**
             * A miss means the confirmation string is unknown, so Revoke cannot
             * be offered: the server compares the typed value against the
             * subsidiary's stored UPPERCASE code.
             *
             * OUT OF SCOPE and SOFT-DELETED must stay indistinguishable — saying
             * which rebuilds the existence oracle the API hides. STILL LOADING
             * is not one of those: it is a fact about this client, not about the
             * record, and reporting it as "no code available" tells an admin a
             * permanent failure while the 30-minute-cached list is in flight.
             */
            const code = byId.get(id)?.code;

            return (
              <li
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <SubsidiaryLabel id={id} showName />
                <span className="flex items-center gap-2">
                  {code === undefined ? (
                    <span className="text-xs text-text-muted">
                      {codesPending
                        ? 'Loading subsidiary codes…'
                        : 'No code available to confirm with'}
                    </span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || code === undefined || !canRevokeSubsidiaryAccess(user, id)}
                    onClick={() => {
                      if (code !== undefined) setRevokeTarget({ id, code });
                    }}
                  >
                    Revoke
                    <span className="sr-only"> access to {code ?? 'this subsidiary'}</span>
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {canGrant ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-sm">
            <SubsidiaryPicker
              value={selected}
              onChange={setSelected}
              label="Grant access to"
              disabled={busy}
              error={alreadyGranted ? 'Already granted.' : undefined}
            />
          </div>
          <Button
            variant="secondary"
            disabled={selected === '' || alreadyGranted || busy}
            busy={grant.isPending}
            busyLabel="Granting…"
            onClick={() =>
              grant.mutate(
                { id: user.id, subsidiaryId: selected },
                { onSuccess: () => setSelected('') },
              )
            }
          >
            Grant
          </Button>
        </div>
      ) : grants.length > 0 ? (
        <p className="text-sm text-text-muted">
          Administrators are unscoped and take no new grants. Change the role first to scope this
          user.
        </p>
      ) : null}

      {/* §9.1: the predicates above are UX. The server is the control, so its
          refusal still has to reach the screen. */}
      {grant.error ? <InlineError>{userMessage(grant.error)}</InlineError> : null}

      {revokeTarget ? (
        <ConfirmDialog
          open
          onClose={() => {
            setRevokeTarget(null);
            revoke.reset();
          }}
          title="Revoke subsidiary access?"
          description={`${user.name} loses access to every document, report and figure scoped to ${revokeTarget.code}. You can grant it again afterwards.`}
          confirmLabel="Revoke access"
          busyLabel="Revoking…"
          // The subsidiary's stored code — UPPERCASE, compared byte for byte
          // (`isRevokeConfirmValid`). Note this is NOT the same secret as the
          // deactivation dialog's, which wants the user's email: the URL
          // carries the subsidiary id, the body carries the code.
          expectedText={revokeTarget.code}
          expectedTextLabel="the subsidiary code"
          onConfirm={(confirmText) =>
            // A DELETE that requires a JSON body; `useRevokeSubsidiaryAccess`
            // is what gets the body onto the wire.
            revoke.mutateAsync({
              id: user.id,
              subsidiaryId: revokeTarget.id,
              confirm: confirmText,
            })
          }
        />
      ) : null}
    </div>
  );
}
