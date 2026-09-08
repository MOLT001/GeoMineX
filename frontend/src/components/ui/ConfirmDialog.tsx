'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, userMessage } from '@/lib/api/errors';
import { Button } from './Button';
import { Field, TextInput } from './Field';
import { FormError } from './Field';

/**
 * Confirmation for destructive and irreversible actions.
 *
 * ─── WHY A NATIVE <dialog> ──────────────────────────────────────────────────
 * `showModal()` gives, from the platform: a focus trap, Escape to dismiss,
 * `inert` on everything behind it, the top layer (so no z-index arms race), and
 * a `::backdrop`. A hand-rolled modal reimplements all five and typically ships
 * three. It is also the reason this app needs no Radix dependency, and it means
 * nothing here writes an inline `style` attribute for positioning.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ─── TYPED CONFIRMATION ─────────────────────────────────────────────────────
 * Three call sites require the user to type an exact string, and the string
 * differs at each because the thing being confirmed differs:
 *
 *   deactivate a user           the user's EMAIL
 *   revoke subsidiary access    the subsidiary CODE
 *   archive a report            the report's EXACT TITLE
 *
 * The server checks it too and answers `CONFIRM_TEXT_MISMATCH`, which is
 * handled below — the client-side comparison exists to save a round trip, not
 * to be the control.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What will happen, in plain words. State the consequence, not the mechanism. */
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  /**
   * When set, the user must type this string exactly before confirming, and it
   * is passed to `onConfirm`. Omit for a simple yes/no.
   */
  expectedText?: string;
  /** What the typed value IS, e.g. "the user's email address". Shown as help text. */
  expectedTextLabel?: string;
  onConfirm: (confirmText: string) => Promise<unknown>;
  variant?: 'danger' | 'primary';
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  busyLabel = 'Working…',
  expectedText,
  expectedTextLabel,
  onConfirm,
  variant = 'danger',
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drive the native element from the `open` prop. `showModal()` is imperative
  // and has no declarative equivalent — rendering `<dialog open>` produces a
  // NON-modal dialog with no focus trap, no backdrop and no Escape handling,
  // which looks identical and behaves nothing alike.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      setTyped('');
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const matches = !expectedText || typed.trim() === expectedText;

  async function confirm() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'CONFIRM_TEXT_MISMATCH'
          ? 'That does not match. Check for extra spaces or different capitalisation.'
          : userMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  // Purely visual: the severity is already stated in the title and carried by
  // the confirm button, but a 3px rule across the top edge is read before
  // either — the same "marked on its edge" device the navigation band uses for
  // the current section. It decides nothing about what renders.
  const severityEdge = variant === 'danger' ? 'border-t-danger' : 'border-t-sih-blue';

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // Fires for Escape as well as `close()`. Without this the parent's `open`
      // state stays true after an Escape dismiss and the dialog cannot be
      // reopened.
      onClose={onClose}
      // A submit inside a modal would navigate; there is no form here, so the
      // only paths out are the two buttons and Escape.
      onCancel={onClose}
      /*
        ─── ELEVATION LEVEL 4, AND WHY THIS IS THE ONLY THING THAT GETS IT ─────
        UX4G's scale runs L1 resting cards, L2 hover and dropdowns, L3 popovers
        and menus, L4 "modals and dialogs — the highest, most focused layer",
        with the accompanying DON'T: "apply Level 4 to inline or resting
        elements". This is the one component in the product that is literally
        the thing L4 describes — it sits in the top layer, over an inert page —
        so `shadow-xl` here is elevation describing the truth rather than
        decorating. It was `shadow-lg`, which is the popover step: a menu's
        worth of lift under a dialog that has taken over the whole page.

        It keeps its border, per their pairing rule — a shadow alone leaves the
        top edge of a white dialog undefined against a pale backdrop.

        `overflow-y-auto` (never `flex`, which would defeat the UA's
        `dialog:not([open]) { display: none }` and leave a closed dialog on
        screen) keeps a long description reachable and clips the header and
        footer bands to the corner radius.
      */
      className={`m-auto w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-border-strong border-t-[3px] ${severityEdge} bg-surface p-0 text-text-default shadow-xl backdrop:bg-primary-deep/60`}
    >
      {/*
        Header, body, actions as three banded blocks rather than one padded
        stack: a confirmation is a form, and a government form states what it
        is on a tinted strip before it asks anything.

        The title takes Heading/S — 20px, UX4G's step for a panel title, which
        is what a 32rem dialog has. It was 18px, a size their scale spends on
        Body/L, so the heading was sitting one step below the copy weight it
        needed to outrank. Padding opens to 24/16 across all three bands so they
        share one measure down the left edge and the type has room at its new
        size; 20px of horizontal padding against a 16px body was the reading of
        a denser dialog than this one now is.
      */}
      <div className="border-b border-border bg-surface-muted px-6 py-4">
        <h2 id={titleId} className="font-serif text-xl font-semibold text-primary-dark">
          {title}
        </h2>
      </div>

      <div className="flex flex-col gap-5 px-6 py-5">
        {/*
          Full-strength ink, not muted. This sentence is the consequence of an
          irreversible action — it is the most important text in the dialog and
          the only thing standing between a click and a revoked account.

          Body/M, which is UX4G's floor and their default, and deliberately not
          Body/L: importance here is carried by full-strength ink and by being
          the first thing under the title, because their type rule forbids
          reaching for a larger size purely for emphasis. `leading-relaxed`
          comes off — the 16px step already ships 24px of line-height, exactly
          the 1.5x WCAG 1.4.12 asks for.
        */}
        <div className="text-base text-text-default">{description}</div>

        {expectedText ? (
          <Field
            label={`Type ${expectedTextLabel ?? 'the value below'} to confirm`}
            description={
              <>
                Type{' '}
                {/*
                  Set as a literal on its own ground: what has to be typed is a
                  value to be copied character for character, not prose, and the
                  chip is what stops a trailing space or a capital being missed.

                  It carries a border now. `surface-muted` against `surface` is
                  a deliberately slight step (globals.css), which is right for a
                  table header filling a whole band but not for a chip a few
                  characters wide — at that size the fill alone barely reads as
                  a boundary, and the boundary is the entire point of the chip.
                */}
                <span className="rounded-sm border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-text-strong">
                  {expectedText}
                </span>{' '}
                exactly.
              </>
            }
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={typed}
                autoComplete="off"
                // Not `autoFocus`: focus belongs on the dialog first so the
                // title is announced. `showModal()` focuses the first tabbable
                // element, which is this input, and the `aria-labelledby`
                // above is what gets read with it.
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches) void confirm();
                }}
              />
            )}
          </Field>
        ) : null}

        {error ? <FormError>{error}</FormError> : null}
      </div>

      {/*
        The actions sit on their own strip, separated by a rule. Cancel stays
        first in the DOM so it is the first thing Tab reaches after the field —
        the safe way out should not be the last stop before the irreversible
        one.

        Both buttons are `md`, which is now the 44px target UX4G requires
        (WCAG 2.5.5) — inherited from Button rather than restated here, which is
        the point of having the size live in one file. `gap-3` follows from it:
        two 44px targets set 8px apart read as one control that has been split,
        and on a destructive pair the gap between Cancel and Confirm is doing
        safety work. It is also what keeps them apart when `flex-wrap` stacks
        them on a narrow screen.
      */}
      <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-surface-muted px-6 py-4">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={variant}
          disabled={!matches}
          busy={busy}
          busyLabel={busyLabel}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
