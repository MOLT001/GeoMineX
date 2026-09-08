'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api/client';
import { userMessage } from '@/lib/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { landingRoute } from '@/auth/permissions';
import type { AuthResult } from '@/auth/types';
import { LockupVertical } from '@/components/brand/Lockup';
import { Button } from '@/components/ui/Button';
import { Field, FormError, TextInput, fieldErrorsOf } from '@/components/ui/Field';

/**
 * Accept an invitation — PRD §5.2, §9.3.
 *
 * The backend emails `${CLIENT_URL}/invite/accept?token=…`, so this route must
 * exist at exactly that path.
 *
 * ─── THE TOKEN MUST LEAVE THE URL IMMEDIATELY ───────────────────────────────
 * §5.2 requires the credential to be scrubbed from the address bar with
 * `history.replaceState` as soon as it is read. Left in place it persists in
 * browser history and leaks through the `Referer` header on any outbound link.
 * That requirement does NOT apply to login, where §11.1's OTP flow keeps the
 * code out of the URL entirely — this is the one route where it bites.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** `safeText({ max: 120 })` on the server — auth.schema.ts:33. */
const NAME_MAX = 120;

export default function InviteAcceptPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn } = useAuth();

  const [name, setName] = useState('');
  /**
   * The raw error, not a rendered message, because the two failures this form
   * can raise do not belong in the same place. `acceptInviteSchema` validates
   * `name` as well as `token` (auth.schema.ts:31-34): a `body.name` rejection
   * is the input's problem and goes on the input, where `Field` wires it into
   * `aria-describedby` and `aria-invalid`. A refused token is not the field's
   * fault and must not mark it invalid.
   */
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Capture the token on the FIRST render, via a lazy initialiser, because the
   * effect below strips it from the URL — after that `searchParams` no longer
   * carries it, so it must be held somewhere that survives the scrub.
   *
   * State rather than a ref: refs may not be read during render, and `missing`
   * is needed to decide what to render. Deriving it here also avoids a
   * set-state-in-effect round trip that would flash the form before the error.
   */
  const [token] = useState(() => searchParams.get('token'));
  const missing = token === null;

  const nameError = fieldErrorsOf(error)('name');

  useEffect(() => {
    if (!token) return;
    // Scrub before anything can render a link or navigate away, so the
    // credential never reaches browser history or an outbound Referer header.
    window.history.replaceState(null, '', window.location.pathname);
  }, [token]);

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;

    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<AuthResult>(
        '/auth/invites/accept',
        name.trim() ? { token, name: name.trim() } : { token },
        { credentials: 'include' },
      );
      signIn(data);
      router.replace(landingRoute(data.user.role));
    } catch (err) {
      // Invalid, expired and already-used tokens all return the same message,
      // which is the point — anything more specific tells an attacker whether
      // a token existed.
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-7 flex justify-center">
        <LockupVertical markSize={76} />
      </div>

      {/* The same banded panel as sign-in — the two entry points to the service
          should be visibly the same kind of official form. */}
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
        <div className="border-b border-border-strong bg-primary-dark px-5 py-3.5 sm:px-6">
          <h1 className="font-serif text-lg font-semibold text-white">Accept your invitation</h1>
        </div>

        <div className="px-5 py-5 sm:px-6 sm:py-6">
        {missing ? (
          <p className="mt-4 text-sm text-danger" role="alert">
            This link is missing its invitation code. Ask your administrator to send a new invite.
          </p>
        ) : (
          <>
            <p className="mb-6 text-sm text-text-muted">
              Confirm your name to finish setting up your account. You can change it later.
            </p>
            <form onSubmit={(e) => void accept(e)} className="flex flex-col gap-4">
              <Field label="Full name (optional)" error={nameError}>
                {(fieldProps) => (
                  <TextInput
                    {...fieldProps}
                    autoComplete="name"
                    autoFocus
                    maxLength={NAME_MAX}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              {/*
                Whole-form, because a refused token has no input to sit under.
                Silent when the failure was a field one — `Field` has already
                rendered that message on the control above.
              */}
              {error !== null && nameError === undefined ? (
                <FormError>{userMessage(error)}</FormError>
              ) : null}
              <Button type="submit" busy={busy} busyLabel="Setting up…">
                Accept invitation
              </Button>
            </form>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
