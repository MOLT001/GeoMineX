'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api/client';
import { ApiError, userMessage } from '@/lib/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { landingRoute } from '@/auth/permissions';
import { sanitizeNext } from '@/auth/redirect';
import type { AuthResult } from '@/auth/types';
import { LockupVertical } from '@/components/brand/Lockup';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/Field';
import { DEFAULT_OTP_LENGTH, OtpInput } from '@/components/ui/OtpInput';

/**
 * How long before "Resend" is offered again.
 *
 * Not cosmetic. `authLimiter` allows 10 requests a minute per IP, and every
 * refused request still spends quota — so an impatient user tapping Resend can
 * lock themselves out of the sign-in they are trying to complete. A visible
 * countdown turns that from a mystery 429 into an obvious wait.
 */
const RESEND_SECONDS = 30;

/**
 * Sign in — PRD §5.2.
 *
 * Email-only, two steps: request a code, then exchange it. There is no password
 * and no signup; accounts are provisioned by an administrator (§2).
 *
 * §11.1 resolved to OTP rather than a magic link, which is why there is no
 * `history.replaceState` scrub here — nothing sensitive ever enters the URL.
 * The invite-accept route DOES carry its token in the query string, and does
 * scrub it.
 */
export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn } = useAuth();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // One interval while the countdown is live, cleared the moment it reaches
  // zero so an idle sign-in page is not ticking in the background.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => {
      setResendIn((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/request-code', { email });
      setStep('code');
      setResendIn(RESEND_SECONDS);
    } catch (err) {
      // The endpoint answers with an identical generic 200 whether or not the
      // account exists, so it cannot be used to enumerate users. Only a
      // transport failure or a rate limit can land here.
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    await sendCode();
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post<AuthResult>(
        '/auth/verify-code',
        { email, code },
        { credentials: 'include' },
      );
      signIn(data);
      router.replace(sanitizeNext(searchParams.get('next')) ?? landingRoute(data.user.role));
    } catch (err) {
      // Every failure — unknown account, wrong code, expired code, locked
      // account — returns the same message by design. Do not try to be more
      // helpful than the server; that is the enumeration defence.
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That code is not valid. Request a new one and try again.'
          : userMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-7 flex justify-center">
        <LockupVertical markSize={76} />
      </div>

      {/*
        A banded panel rather than a floating card. The header band in the §6
        navy is what makes this read as an official sign-in rather than as a
        generic login box — the same device the masthead uses, at panel scale.
        No shadow: the panel is filed on the page, not hovering above it.
      */}
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
        <div className="border-b border-border-strong bg-primary-dark px-5 py-3.5 sm:px-6">
          <h1 className="font-serif text-lg font-semibold text-white">Sign in</h1>
        </div>

        <div className="px-5 py-5 sm:px-6 sm:py-6">
          {/*
            The two steps of an existing state machine, drawn. A government
            form tells you where you are in it; this renders `step` and nothing
            more — it holds no state of its own and drives nothing.
          */}
          <ol aria-hidden className="mb-5 flex items-center gap-2 text-xs font-medium">
            <li
              className={`flex items-center gap-1.5 ${
                step === 'email' ? 'text-sih-blue' : 'text-text-muted'
              }`}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full text-[0.6875rem] ${
                  step === 'email'
                    ? 'bg-sih-blue text-white'
                    : 'bg-success text-white'
                }`}
              >
                {step === 'email' ? '1' : '✓'}
              </span>
              Email
            </li>
            <li aria-hidden className="h-px w-6 bg-border" />
            <li
              className={`flex items-center gap-1.5 ${
                step === 'code' ? 'text-sih-blue' : 'text-text-muted'
              }`}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full text-[0.6875rem] ${
                  step === 'code' ? 'bg-sih-blue text-white' : 'bg-surface-muted text-text-muted'
                }`}
              >
                2
              </span>
              Code
            </li>
          </ol>

          <p className="mb-5 text-sm text-text-muted">
            {step === 'email'
              ? 'Enter your work email and we will send you a sign-in code.'
              : `We sent a code to ${email}. It expires in a few minutes.`}
          </p>

        {/*
          The single `error` string belongs to whichever step is on screen —
          each has exactly one control, so the message is always about that
          control. Handing it to `Field` is what puts it in the input's
          `aria-describedby` and sets `aria-invalid`; as a loose paragraph it
          was announced with nothing to tie it to. The copy itself stays
          deliberately generic — see the catch blocks above.
        */}
        {step === 'email' ? (
          <form onSubmit={(e) => void requestCode(e)} className="flex flex-col gap-4">
            <Field label="Email address" error={error ?? undefined}>
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@coalindia.in"
                />
              )}
            </Field>
            <Button type="submit" busy={busy} busyLabel="Sending…">
              Send code
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => void verifyCode(e)} className="flex flex-col gap-4">
            <Field label="Sign-in code" error={error ?? undefined}>
              {(fieldProps) => (
                <OtpInput
                  {...fieldProps}
                  value={code}
                  onChange={setCode}
                  disabled={busy}
                  autoFocus
                />
              )}
            </Field>

            {/*
              Resend, gated by a countdown. The button is disabled rather than
              hidden so the wait is legible: `authLimiter` spends quota on
              refused requests too, so an impatient user tapping this can lock
              themselves out of the very sign-in they are attempting.

              `aria-live="polite"` on the wrapper, not on the ticking number —
              announcing every second would be unusable. The region announces
              once when the wait ends and the control becomes available.
            */}
            <p className="text-sm text-text-muted" aria-live="polite">
              Didn&rsquo;t receive it?{' '}
              {resendIn > 0 ? (
                <span className="font-medium text-text-strong tabular-nums">
                  Resend in {formatCountdown(resendIn)}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendCode()}
                  disabled={busy}
                  className="font-semibold text-sih-blue underline underline-offset-2 hover:text-sih-blue-dark disabled:no-underline disabled:opacity-60"
                >
                  Resend code
                </button>
              )}
            </p>

            <Button
              type="submit"
              busy={busy}
              busyLabel="Checking…"
              // The server is the authority on the code; this only stops a
              // submit that is certain to fail for want of digits.
              disabled={code.length < DEFAULT_OTP_LENGTH}
            >
              Sign in
            </Button>
            <button
              type="button"
              onClick={() => {
                setStep('email');
                setCode('');
                setError(null);
                setResendIn(0);
              }}
              // A real control, so it takes the 44px target minimum like every
              // other one — it sits directly under the submit button, which is
              // exactly where a mis-tap is costly.
              className="inline-flex min-h-11 items-center self-start text-base text-sih-blue underline underline-offset-2 transition-colors duration-150 hover:text-sih-blue-dark"
            >
              Use a different email
            </button>
          </form>
        )}
        </div>
      </div>

      {/*
        An advisory footnote, set as one: a tinted strip under the panel rather
        than loose text, so it reads as part of the form's official framing.
      */}
      <p className="mt-4 rounded-md border border-border bg-surface-muted px-4 py-3 text-center text-xs text-text-muted">
        Accounts are created by an administrator. There is no self-registration.
      </p>
    </div>
  );
}

/** `00:07` — mm:ss, so the wait reads as a duration rather than a bare number. */
function formatCountdown(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
