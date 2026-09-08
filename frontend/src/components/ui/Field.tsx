import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { ApiError } from '@/lib/api/errors';
import { AlertTriangleIcon } from './Icon';

/**
 * Form controls.
 *
 * Hand-rolled rather than `react-hook-form`. The forms in this app are small —
 * a two-step sign-in, an invite, a report draft, a handful of filters — and
 * none needs field arrays, watched cross-field validation, or the uncontrolled
 * re-render optimisation a form library exists to provide. What they DO need is
 * the label/description/error wiring below, which no form library does for you.
 *
 * ─── SERVER ERRORS ARE THE PRIMARY VALIDATION PATH ──────────────────────────
 * The backend validates every request with Zod and returns
 * `{ code: 'VALIDATION_ERROR', fields: { 'body.email': ['...'] } }`. That is
 * the authoritative answer, and `fieldErrorsOf` maps it straight onto the
 * inputs. Client-side checks here are a latency optimisation and a nicety —
 * never a substitute, because the client's copy of a constraint drifts from the
 * server's silently, and only one of the two is enforced.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ─── WHAT MAKES A GOVERNMENT FORM READ AS ONE ───────────────────────────────
 * Unambiguous, and four decisions carry it — made once here rather than per
 * screen, which is what keeps forty fields across nine screens consistent:
 *
 *   the label   UX4G Label/XL — 16px at weight 500, in the strongest ink,
 *               above its control
 *   the edge    `border-strong`, because a boundary you cannot find is a box
 *               people fill in the wrong one of
 *   the target  44px minimum, per WCAG 2.5.5 and UX4G's touch-target rule. See
 *               CONTROL_SIZE below — it is the one measurement in this file
 *               that is a published requirement rather than a judgement call
 *   the error   a red edge AND a message AND a shape, never one of the three
 *               on its own
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Pull per-field messages out of an ApiError.
 *
 * The backend keys them by DOTTED PATH from the request root (`body.email`,
 * `body.sections.0.heading`, `query.limit`), so a bare field name never matches.
 * The returned lookup tries the qualified forms before the bare one.
 */
export function fieldErrorsOf(error: unknown): (name: string) => string | undefined {
  if (!(error instanceof ApiError) || !error.fields) return () => undefined;
  const fields = error.fields;

  return (name: string) => {
    for (const key of [`body.${name}`, `query.${name}`, `params.${name}`, name]) {
      const messages = fields[key];
      if (messages?.length) return messages[0];
    }
    return undefined;
  };
}

interface FieldShellProps {
  label: string;
  /** Help text. Rendered before the error and announced with the control. */
  description?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => ReactNode;
  className?: string;
}

/**
 * Label + control + description + error, wired together.
 *
 * The wiring is the whole point, and it is what hand-written forms usually get
 * wrong: `aria-describedby` must reference BOTH the description and the error
 * (a control can have several descriptions, space-separated), and `aria-invalid`
 * must appear only when there is actually an error — an always-present
 * `aria-invalid="false"` is fine, but `aria-invalid="true"` on an untouched
 * field makes a screen reader announce the form as broken before it is filled.
 */
export function Field({ label, description, error, required, children, className }: FieldShellProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    // gap-2 rather than gap-1.5. Every part of this stack steps up a size below,
    // and a stack only keeps its rhythm if the space between the parts grows
    // with the type it is separating.
    <div className={cn('flex flex-col gap-2', className)}>
      {/*
        A field label is not a caption. It is read BEFORE the control and has to
        survive a scan down a dense column of fields, so it takes weight and the
        strongest ink — deliberately NOT the small uppercase muted treatment
        used for table headers and detail-list terms, which label values already
        on the page rather than an empty box. Sentence case for the same reason:
        several of these labels are whole sentences, and uppercasing a sentence
        costs legibility and buys nothing.

        16px at weight 500 is UX4G's Label/XL, the step they assign to a form
        field label specifically. It was 14px semibold: below their 16px body
        floor, and reaching for extra weight to buy back the presence the
        missing 2px would have supplied. Their rule runs the other way — set the
        published size, and let weight do only what weight is for.

        `leading-snug` is gone with it. The scale in globals.css ships a
        line-height with every step, and overriding it here re-opens the 1.5x
        question (WCAG 1.4.12) that the token had already answered.
      */}
      <label htmlFor={id} className="text-base font-medium text-text-strong">
        {label}
        {required ? (
          <>
            {' '}
            <span aria-hidden className="text-danger">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </label>

      {/*
        Body/S — UX4G's step for helper text, and the smallest thing in a form
        that is still prose. It was 12px, which is their Body/XS: the caption
        size, for a timestamp or a legal line, not for the sentence explaining
        what to type into the box below it. `leading-relaxed` drops for the same
        reason as on the label — the token pairs 22px with 14px, over 1.5x
        already.
      */}
      {description ? (
        <p id={descriptionId} className="text-sm text-text-muted">
          {description}
        </p>
      ) : null}

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-sm font-medium text-danger"
        >
          {/*
            Shape beside colour. The red edge on the control and the red of this
            message are the same signal to anyone who cannot separate red from
            grey; the triangle is what survives that, and it is the reason the
            icon set exists at all (components/ui/Icon.tsx).

            Body/S, and deliberately NOT a step larger than the help text above
            it: UX4G's rule is "never increase font size purely for emphasis —
            use the Strong weight instead". The error is carried by weight,
            danger ink and the triangle, which is three signals where a size
            bump would have been one. The icon goes to 16 only to stay optically
            level with the 22px line it now sits on.
          */}
          <AlertTriangleIcon size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The shared control skin.
 *
 * `border-strong`, not `border`, and this is the one place in the product where
 * the heavier line is not a matter of taste. `--color-border` is deliberately
 * under 3:1 on white (globals.css) because it separates decoratively — but the
 * outline of a form control is a user-interface component boundary, which WCAG
 * 1.4.11 requires to be perceivable. A faint edge here is an accessibility
 * defect, not a lighter look.
 *
 * 16px for the value, not 14px. UX4G puts a hard floor under body text at 16px,
 * and the text a person is TYPING is the last place to sit beneath it — it is
 * also the threshold under which mobile Safari zooms the viewport on focus,
 * which is a layout bug people experience as the form fighting them.
 *
 * No `outline-none`. It used to sit here and it was never doing anything:
 * globals.css sets the focus ring UNLAYERED, which outranks every Tailwind
 * utility precisely so that no control can opt out. Removed rather than left
 * as decoration, because a reader who finds `outline-none` in a component
 * reasonably concludes the focus indicator is negotiable, and UX4G says it is
 * not — "should not be removed via CSS".
 */
const CONTROL_BASE =
  'w-full rounded-md border border-border-strong bg-surface text-base text-text-default ' +
  // Colour only, and only on the edge — nothing here moves, scales or slides.
  // `motion-reduce` because the transition is declared on the component rather
  // than inherited from the global block.
  'placeholder:text-text-muted transition-colors duration-150 motion-reduce:transition-none ' +
  'focus-visible:border-sih-blue ' +
  // A disabled control falls back to the decorative border and muted ink: its
  // edge no longer marks anything you can act on.
  'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:text-text-muted ' +
  'aria-[invalid]:border-danger';

/**
 * Height — and the reason it is not a density decision.
 *
 * WCAG 2.5.5 and UX4G both fix the minimum touch target at 44x44px, and a form
 * control is the target where it matters most: it is what someone aims at on a
 * phone, one-handed, to enter something they will be held to. These controls
 * stood at roughly 36px, which traded a published accessibility requirement for
 * a few rows of screen — exactly the trade the comment above already said must
 * never be made in this direction. `min-h-11` is 44px, and the padding is set
 * so a single 24px line clears it without relying on the minimum to do it.
 *
 * `dense` is the escape hatch, and it is a PROP rather than a `className`
 * override on purpose: `cn` is a plain join with no conflict resolution
 * (lib/cn.ts), so a caller passing `min-h-9` cannot beat `min-h-11` and would
 * get a silent no-op. 36px still clears WCAG 2.5.8's 24px AA floor, which is
 * what makes it legitimate for a control sitting INSIDE a table row — and
 * nothing else. It is not a size to reach for because a screen feels tall.
 */
const CONTROL_SIZE = {
  comfortable: 'min-h-11 px-3.5 py-2.5',
  dense: 'min-h-9 px-3 py-1.5',
} as const;

/** Opt into the 36px row-density height. Everything else gets the 44px target. */
interface ControlDensity {
  dense?: boolean;
}

function controlClass(dense: boolean | undefined, className: string | undefined) {
  return cn(CONTROL_BASE, dense ? CONTROL_SIZE.dense : CONTROL_SIZE.comfortable, className);
}

export function TextInput({
  className,
  dense,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { className?: string } & ControlDensity) {
  return <input className={controlClass(dense, className)} {...rest} />;
}

export function TextArea({
  className,
  dense,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { className?: string } & ControlDensity) {
  return <textarea className={controlClass(dense, className)} {...rest} />;
}

/**
 * `Select` lives in ./Select.tsx and is re-exported here.
 *
 * It stopped being a native <select> — the OS draws that popup and no CSS
 * reaches it — so it is now a portaled ARIA listbox, which is several hundred
 * lines of keyboard and positioning work that does not belong in this file.
 *
 * Re-exported rather than moved outright because eleven modules import it from
 * `@/components/ui/Field` alongside `Field` itself, and it is genuinely a form
 * control: `TextInput`, `TextArea` and `Select` are one vocabulary, and making
 * callers remember that one of the three lives elsewhere buys nothing.
 *
 * Note its `onChange` gives you the VALUE, not a ChangeEvent — see SelectProps.
 */
export { Select, type SelectProps } from './Select';

/**
 * A character counter for the fields with hard server-side caps — report
 * section headings (200) and bodies (50 000).
 *
 * Turns red only once the limit is actually exceeded, not as it approaches:
 * a warning colour on a field that is still valid trains people to ignore it.
 *
 * Body/S, so it lands on the same step as the help text and the error message.
 * The three are the same class of thing — a note attached to one control — and
 * UX4G gives that class one size; at 12px this was set as a caption on a
 * figure instead.
 */
export function CharCount({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <p
      className={cn(
        'text-right text-sm tabular-nums',
        // Weight as well as colour, on the same principle as the field error:
        // the over-limit state has to read at a glance without being red.
        over ? 'font-semibold text-danger' : 'text-text-muted',
      )}
      // Announcing every keystroke would be intolerable; the count is a visual
      // aid, and the error state below the field is what gets announced.
      aria-hidden
    >
      {value.length.toLocaleString('en-IN')} / {max.toLocaleString('en-IN')}
    </p>
  );
}

/**
 * A whole-form error, above the submit control.
 *
 * A panel rather than a line of red text, because this one reports that the
 * entire submission failed and it has to win against a full form for attention.
 * The 4px bar down the left edge is the device a printed government notice uses
 * for exactly this: it marks the block as an interruption without needing a
 * fill loud enough to hurt the type sitting on it.
 *
 * Body/M here, where the per-field error is Body/S, and the distinction is real
 * rather than emphasis by size: a field error annotates one control, but this
 * is the form's answer to the person who just submitted it and the only text on
 * screen they have to read. That makes it body copy, and UX4G's floor for body
 * copy is 16px. The padding steps up with the type — a 16px line needs room
 * around it before the panel reads as a block rather than as a tight box.
 */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-danger/30 border-l-4 border-l-danger bg-danger/5 px-4 py-3 text-base text-danger"
    >
      <AlertTriangleIcon size={18} className="mt-0.5 shrink-0" />
      {/*
        Wrapped so a message made of several children stays one paragraph
        instead of becoming that many flex items sitting side by side.
      */}
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}
