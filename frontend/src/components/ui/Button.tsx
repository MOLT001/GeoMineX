import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SpinnerIcon } from './Icon';

/**
 * The button vocabulary — PRD §6.
 *
 * §6 assigns the palette by ROLE, and the variants encode that assignment so a
 * screen never has to decide which blue is the right blue:
 *
 *   primary   SIH Blue      the ordinary affirmative action
 *   cta       Accent Orange reserved, by §6, for the two headline actions:
 *                           Upload and Generate Report. Using it anywhere else
 *                           is what stops an accent reading as an accent.
 *   secondary outline       the alternative in a pair
 *   danger    Danger        destructive and irreversible: archive, revoke,
 *                           deactivate, force-logout
 *   ghost     bare          tertiary controls inside dense rows
 *
 * ─── HOW A STATE IS EXPRESSED ───────────────────────────────────────────────
 * Three states, three real colour steps, and nothing else moves. A government
 * control is a solid rectangle that changes shade — it does not lift, scale,
 * glow or cast a shadow, because those idioms say "app surface" where this
 * product needs to say "control on a record". UX4G is explicit about the last
 * of those: elevation is for resting cards, dropdowns, popovers and modals,
 * and a button is none of them.
 *
 *   rest    the §6 hue
 *   hover   a step DARKER, never a step more transparent. `bg-x/90` fades the
 *           fill toward the page, so a hovered button on white gets paler and
 *           drifts toward looking disabled; darkening reads as pressure.
 *   active  darker again. §6 names one shade per accent and no pressed
 *           variant, so rather than invent five more hex values the pressed
 *           step MIXES each variant's own hue toward the §6 navy. It stays
 *           token-derived, so a later palette change carries it along.
 * ────────────────────────────────────────────────────────────────────────────
 */

type Variant = 'primary' | 'cta' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  // Two named §6 blues exist for exactly this pair, so hover is a token here
  // rather than a computed step.
  primary:
    'border-transparent bg-sih-blue text-white hover:bg-sih-blue-dark ' +
    'active:bg-[color-mix(in_srgb,var(--color-sih-blue-dark)_85%,var(--color-primary-dark))]',

  /**
   * Orange is fixed by §6; the TEXT on it is not, and it had to change. White
   * on #F58220 measures about 2.8:1 — below the AA floor the rest of this
   * product holds itself to — and the fill cannot be darkened to fix it
   * without re-speccing a mandated colour. Navy ink clears 4.5:1 at rest and
   * stays above it through both darker states, which is why the hover and
   * pressed mixes stop where they do rather than going further.
   */
  cta:
    'border-transparent bg-accent-orange text-primary-dark ' +
    'hover:bg-[color-mix(in_srgb,var(--color-accent-orange)_90%,var(--color-primary-dark))] ' +
    'active:bg-[color-mix(in_srgb,var(--color-accent-orange)_85%,var(--color-primary-dark))]',

  /**
   * `border-strong`, not `border`. The decorative border sits under 3:1 by
   * design, and an outline button whose outline you cannot quite see reads as
   * a disabled control — the one thing a secondary action must not look like.
   * UX4G asks for 3:1 on the edge of a UI component for exactly this reason.
   * Matches the Sign out control in the app shell, which is the same object.
   */
  secondary:
    'border-border-strong bg-surface text-primary-dark ' +
    'hover:border-primary-dark hover:bg-surface-muted active:bg-canvas',

  danger:
    'border-transparent bg-danger text-white ' +
    'hover:bg-[color-mix(in_srgb,var(--color-danger)_90%,var(--color-primary-dark))] ' +
    'active:bg-[color-mix(in_srgb,var(--color-danger)_82%,var(--color-primary-dark))]',

  ghost:
    'border-transparent text-sih-blue hover:bg-surface-muted hover:text-sih-blue-dark ' +
    'active:bg-sih-blue-tint',
};

/**
 * ─── TARGET SIZE, WHICH IS A RULE AND NOT A TASTE ───────────────────────────
 * UX4G states it plainly: "minimum 44x44px touch target size (WCAG 2.5.5)".
 *
 * `md` used to stand 36px tall, defended right here as "tighter than a SaaS
 * button, because a government screen is a dense one". That argument was mine;
 * the 44px is theirs, and a published accessibility minimum outranks a
 * preference about how much of a toolbar fits on one row. The density was also
 * bought from the wrong budget — it charged every touch and low-dexterity user
 * a harder target so that a desktop toolbar could be eight pixels shorter.
 *
 *   md  44px — THE DEFAULT, and the only size a form footer, a page header or
 *       a dialog should reach for. Label/XL Strong: 16px, semibold.
 *   sm  36px — the dense-context exception, for a control that lives INSIDE a
 *       table row or a filter bar, where 44px would set the row height. Still
 *       half again the 24px floor WCAG 2.5.8 sets at AA. It must not become
 *       the default by habit, which is why `md` is what the signature picks.
 *
 * Stated as `min-h-*` rather than as padding arithmetic, so the floor holds
 * even when a caller passes padding through `className`, the label wraps to
 * two lines, or an icon is taller than the text. The padding is tuned to land
 * on the same number, so nothing is stretched in the ordinary case.
 */
const SIZES: Record<Size, string> = {
  sm: 'min-h-9 gap-1.5 px-3 py-1.5 text-sm',
  md: 'min-h-11 gap-2 px-4 py-2 text-base',
};

const BASE =
  // Every variant carries a border, transparent where it is not wanted, so a
  // primary and a secondary sitting side by side in a form footer are the same
  // height. Without it the outlined one is 2px taller and the row looks set by
  // accident. It is also what keeps `min-h-*` honest: under `border-box` the
  // stated height is the rendered height, for outlined and solid alike.
  'inline-flex items-center justify-center rounded-md border ' +
  // `tracking-normal normal-case` is armour, not decoration: both properties
  // inherit, so a button dropped inside one of the small uppercase tracked
  // labels this product sets would otherwise take on the label's typography.
  //
  // `font-semibold` is UX4G's Label/XL Strong, and it is the reason a button
  // never needs a larger size to read as more important — their own type rule
  // is "never increase font size purely for emphasis; use the Strong weight".
  'font-semibold tracking-normal normal-case ' +
  // Colour only, 150ms, matching the fast end of the motion scale in
  // globals.css. Nothing translates, scales or gains a shadow on hover: the
  // state change is a shade, per the note at the top of this file.
  // `motion-reduce` is belt-and-braces over the global block, which already
  // flattens every transition in the product to a single frame.
  'transition-colors duration-150 motion-reduce:transition-none ' +
  // A disabled control has to stay distinguishable without relying on colour
  // saturation alone, hence the cursor change alongside the opacity drop.
  'disabled:cursor-not-allowed disabled:opacity-60';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  /**
   * Renders a spinner, disables the control, and sets `aria-busy`.
   *
   * `busyLabel` is not decorative: swapping the label to "Saving…" is what
   * tells a screen-reader user the click registered. A spinner alone is
   * invisible to them.
   */
  busy?: boolean;
  busyLabel?: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  busyLabel,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      // Defaults to `type="button"`, not the HTML default of `submit`: an
      // unmarked button inside a form submits it, which is how a Cancel control
      // ends up saving the record.
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {busy ? (
        // Sized to 1em at each step — 14px against the 14px `sm` label, 16px
        // against the 16px `md` one — so the spinner reads as part of the
        // label rather than as a graphic parked beside it.
        <SpinnerIcon
          size={size === 'sm' ? 14 : 16}
          className="animate-spin motion-reduce:animate-none"
        />
      ) : (
        icon
      )}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

/**
 * A link that looks like a button.
 *
 * Kept distinct from `Button` rather than folded in behind an `as` prop,
 * because the choice is semantic: navigation is an `<a>`, an action is a
 * `<button>`. A `<button>` that navigates loses middle-click, open-in-new-tab
 * and the status-bar preview; an `<a>` that mutates loses keyboard `Space` and
 * gets followed by prefetchers.
 *
 * Visually it must be indistinguishable, which is why it composes the same
 * BASE, VARIANTS and SIZES rather than restating them — the two cannot drift,
 * and the 44px target floor reaches both without being written down twice.
 */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Link>, 'href' | 'className' | 'children'>) {
  return (
    <Link href={href} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
