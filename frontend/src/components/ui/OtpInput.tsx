'use client';

import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

/**
 * One box per digit of the sign-in code — PRD §5.2.
 *
 * ─── THE LENGTH IS COUPLED TO THE SERVER ────────────────────────────────────
 * `OTP_LENGTH` is configurable in the backend (6–10, default 6) and the verify
 * endpoint validates `/^\d{6,10}$/`. A boxed input has to commit to a count, so
 * this one commits to the default. If a deployment raises `OTP_LENGTH`, change
 * `DEFAULT_OTP_LENGTH` to match — there is no way for the client to discover it,
 * because exposing it would tell an unauthenticated caller how long a code to
 * guess.
 *
 * Paste is the safety valve: a pasted string longer than the boxes still fills
 * them left to right, so a mismatch degrades to "the code looks truncated"
 * rather than to an input that cannot accept what the email contains.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Accessibility notes, since split inputs are a common way to break a form:
 *   - `autoComplete="one-time-code"` sits on the FIRST box only. Repeating it
 *     makes the platform offer the whole code to every box in turn.
 *   - Each box names its position, so a screen-reader user knows where they are
 *     rather than hearing "edit blank" six times.
 *   - The group carries the error state, and `Field`'s label points at box one.
 */
export const DEFAULT_OTP_LENGTH = 6;

export function OtpInput({
  value,
  onChange,
  length = DEFAULT_OTP_LENGTH,
  disabled = false,
  autoFocus = false,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** From `Field` — lands on the first box so the label points somewhere real. */
  id?: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.padEnd(length, ' ').slice(0, length).split('');

  const focusBox = (index: number) => {
    const next = boxes.current[Math.max(0, Math.min(length - 1, index))];
    next?.focus();
    next?.select();
  };

  /** Rewrite one position and hand the whole string back to the parent. */
  const setDigit = (index: number, digit: string) => {
    const chars = value.padEnd(length, ' ').slice(0, length).split('');
    chars[index] = digit || ' ';
    onChange(chars.join('').replace(/ /g, '').slice(0, length));
  };

  function handleChange(index: number, raw: string) {
    const digit = raw.replace(/\D/g, '').slice(-1);
    if (!digit) return;
    setDigit(index, digit);
    if (index < length - 1) focusBox(index + 1);
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (digits[index]?.trim()) {
        // Clear where the caret is.
        setDigit(index, '');
      } else if (index > 0) {
        // Already empty: step back and clear that one, which is what a single
        // long input would do and therefore what muscle memory expects.
        setDigit(index - 1, '');
        focusBox(index - 1);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    // Pasting the code out of the email is the common path, and without this the
    // browser drops all but one character into the box under the cursor.
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '');
    if (!pasted) return;
    event.preventDefault();
    onChange(pasted.slice(0, length));
    focusBox(Math.min(pasted.length, length - 1));
  }

  return (
    <div className="flex items-center gap-2 sm:gap-2.5">
      {Array.from({ length }, (_, index) => {
        const digit = digits[index]?.trim() ?? '';
        return (
          <input
            key={index}
            ref={(el) => {
              boxes.current[index] = el;
            }}
            id={index === 0 ? id : undefined}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            aria-label={`Digit ${index + 1} of ${length}`}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            autoFocus={autoFocus && index === 0}
            disabled={disabled}
            // `maxLength` 1 keeps a box to one character; overtyping a filled
            // box replaces it, because `handleChange` takes the LAST digit.
            maxLength={1}
            value={digit}
            onChange={(e) => handleChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.currentTarget.select()}
            className={cn(
              'size-11 rounded-md border text-center font-mono text-lg font-semibold',
              'text-text-strong transition-colors sm:size-12 sm:text-xl',
              // No focus styling of its own. The two-tone ring in `globals.css`
              // is unlayered and therefore outranks any utility written here, so
              // an `outline-none` or `ring-*` on this element would be dead CSS
              // that only reads as though the box had a custom focus treatment.
              'disabled:cursor-not-allowed disabled:opacity-60',
              // A filled box reads as filled by its edge as well as its glyph,
              // so progress through the code is visible at a glance.
              digit ? 'border-sih-blue bg-surface' : 'border-border-strong bg-surface-muted',
              invalid && 'border-danger',
            )}
          />
        );
      })}
    </div>
  );
}
