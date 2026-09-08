'use client';

import { useState, type FormEvent } from 'react';
import { ROLE_LABELS } from '@/auth/permissions';
import { ROLES, type Role } from '@/auth/types';
import {
  canHoldSubsidiaryAccess,
  useInviteUser,
  type InviteUserBody,
  type User,
} from '@/features/users/api';
import { useSubsidiaryMap } from '@/features/subsidiaries/api';
import { SubsidiaryLabel, SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { StatusMessage } from '@/components/ui/Feedback';
import { Field, fieldErrorsOf, FormError, Select, TextInput } from '@/components/ui/Field';
import { Card, Section } from '@/components/ui/Layout';
import { ApiError, userMessage } from '@/lib/api/errors';

/**
 * Invite a user — PRD §5.9.
 *
 * The body is assembled by hand rather than by a form library on purpose: the
 * app-wide injection scanner rejects any request KEY containing a dot, so the
 * `user.name`-style names a nested-field serialiser produces would 400 every
 * endpoint in this module, with no `fields` to light up the offending input.
 */

/** 1–120 after the server's NFKC normalisation and stripping, so this is a floor. */
const NAME_MAX = 120;

/** Fields the server can key a validation error on — see `fieldErrorsOf`. */
const FIELDS = ['email', 'name', 'role', 'subsidiaryAccess'];

export function InviteUserPanel({ onClose }: { onClose: () => void }) {
  const invite = useInviteUser();
  // Already loaded for the `SubsidiaryLabel`s below — read here only so each
  // Remove button can name the grant it drops.
  const { byId } = useSubsidiaryMap();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('cil_user');
  const [grants, setGrants] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [invited, setInvited] = useState<User | null>(null);

  const fieldError = fieldErrorsOf(invite.error);
  const scoped = canHoldSubsidiaryAccess(role);

  /**
   * Every failure this form can raise describes the BODY that was submitted, so
   * the moment any part of that body changes the message is about a request
   * that no longer exists. TanStack holds a mutation error until the next
   * `mutate`, and the 409 is the one this form actually meets in use — without
   * this, correcting the address leaves "already belongs to an account" sitting
   * in red under an email nobody has tried yet.
   */
  function clearStaleError() {
    if (invite.isError) invite.reset();
  }

  function changeRole(next: Role) {
    clearStaleError();
    setRole(next);
    /**
     * An admin invite discards `subsidiaryAccess` — but only AFTER checking
     * every id exists, so a stale one 400s an invite that would have ignored
     * it. Dropping the ids here is what keeps the field out of the body
     * entirely rather than sending something we know is thrown away.
     */
    if (!canHoldSubsidiaryAccess(next)) {
      setGrants([]);
      setSelected('');
    }
  }

  function addGrant() {
    // The invite path persists this array verbatim — it de-duplicates only for
    // the existence check — so `['X','X']` comes back duplicated on the user.
    if (selected === '' || grants.includes(selected)) return;
    clearStaleError();
    setGrants([...grants, selected]);
    setSelected('');
  }

  function removeGrant(id: string) {
    clearStaleError();
    setGrants(grants.filter((granted) => granted !== id));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvited(null);

    const body: InviteUserBody = { email: email.trim(), name: name.trim(), role };
    if (scoped && grants.length > 0) body.subsidiaryAccess = grants;

    invite.mutate(body, {
      onSuccess: (user) => {
        // Seeded from the RESPONSE: the server lowercases the email and
        // NFKC-normalises and strips the name, so what was typed is not
        // necessarily what was stored.
        setInvited(user);
        setEmail('');
        setName('');
        setGrants([]);
        setSelected('');
      },
    });
  }

  const conflict = invite.error instanceof ApiError && invite.error.code === 'CONFLICT';
  const hasFieldError = FIELDS.some((field) => fieldError(field) !== undefined);

  return (
    <Section
      id="invite-user"
      title="Invite a user"
      description="They receive an emailed link. Until they accept it the account stays inactive and cannot sign in."
    >
      <Card>
        {/*
          Native `required` / `type="email"` constraints are left switched on:
          they cost nothing and save a round trip. They are not the validation —
          the server's Zod schema is, and its field errors land on the inputs
          below through `fieldErrorsOf`.
        */}
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email address" required error={fieldError('email')}>
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  type="email"
                  value={email}
                  required
                  autoComplete="off"
                  onChange={(event) => {
                    setEmail(event.target.value);
                    clearStaleError();
                  }}
                />
              )}
            </Field>

            <Field
              label="Full name"
              required
              error={fieldError('name')}
              description="Stored after normalisation, so it may come back slightly different."
            >
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  value={name}
                  required
                  maxLength={NAME_MAX}
                  onChange={(event) => {
                    setName(event.target.value);
                    clearStaleError();
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            label="Role"
            required
            error={fieldError('role')}
            className="max-w-sm"
            description={
              scoped
                ? 'Scoped: this user reads only the subsidiaries granted below.'
                : 'Administrators are unscoped — they read every subsidiary and hold no grants.'
            }
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={role}
                onChange={(next) => changeRole(next as Role)}
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {scoped ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-full max-w-sm">
                  <SubsidiaryPicker
                    value={selected}
                    onChange={setSelected}
                    label="Subsidiary access"
                    error={fieldError('subsidiaryAccess')}
                  />
                </div>
                <Button
                  variant="secondary"
                  disabled={selected === '' || grants.includes(selected)}
                  onClick={addGrant}
                >
                  Add
                </Button>
              </div>

              {grants.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No subsidiaries chosen. Invited with none, this user can read nothing until
                  someone grants access.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {grants.map((id) => (
                    <li
                      key={id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                    >
                      <SubsidiaryLabel id={id} showName />
                      <Button variant="ghost" size="sm" onClick={() => removeGrant(id)}>
                        {/*
                          The name has to say WHICH, or a screen reader hears
                          "Remove" once per chosen subsidiary with nothing to
                          tell them apart.
                        */}
                        Remove
                        <span className="sr-only">
                          {' '}
                          {byId.get(id)?.code ?? 'this subsidiary'} from the invite
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {invited ? (
            <StatusMessage>
              Invited {invited.name} ({invited.email}) as {ROLE_LABELS[invited.role]}
              {invited.subsidiaryAccess.length > 0
                ? `, with ${invited.subsidiaryAccess.length} subsidiary ${
                    invited.subsidiaryAccess.length === 1 ? 'grant' : 'grants'
                  }`
                : ''}
              . They cannot sign in until they accept the emailed link.
            </StatusMessage>
          ) : null}

          {/*
            Match on the CODE, never the message: a duplicate email answers 409
            under two different sentences depending on whether the existing
            account is live or soft-deleted, and only one of them mentions email
            at all. Field-level messages already cover a VALIDATION_ERROR, so
            this stays quiet when there are any.
          */}
          {invite.error && (conflict || !hasFieldError) ? (
            <FormError>
              {conflict
                ? 'That email address already belongs to an account — possibly one that was deactivated. Find it in the list and reactivate it instead.'
                : userMessage(invite.error)}
            </FormError>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" busy={invite.isPending} busyLabel="Sending invite…">
              Send invite
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={invite.isPending}>
              Close
            </Button>
          </div>
        </form>
      </Card>
    </Section>
  );
}
