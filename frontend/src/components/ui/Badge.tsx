import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  type IconProps,
  SpinnerIcon,
  XCircleIcon,
} from './Icon';

/**
 * Status badges.
 *
 * ─── THE RULE THIS COMPONENT EXISTS TO ENFORCE ──────────────────────────────
 * Colour never carries meaning alone. §6 specifies a contrast floor and stops
 * there, which leaves out roughly one man in twelve: red and green at the same
 * lightness are the same swatch to a deuteranope, and `failed` / `validated` is
 * exactly the pair this app needs them to tell apart. So every tone is bound to
 * a SHAPE as well as a colour, and the label is always present as text — a
 * badge is never reduced to a coloured dot.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ─── WHY THE CHIP IS SQUARED AND OUTLINED ───────────────────────────────────
 * A soft pill filled with a 10% tint is the consumer-software status marker.
 * On a dense record it has no edge, so it floats in the row rather than
 * belonging to a column, and at 10% the tint alone is barely a shape at all.
 * Squaring it and giving it a rule turns it into an object — the same move the
 * rest of this product makes, where structure comes from 1px lines rather than
 * from fills and shadows.
 *
 * The rule is each tone's OWN ink at half strength. One formula, so no tone
 * needs a second hex value invented for it, and the edge always agrees with the
 * text and the icon it encloses instead of introducing a third colour.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `tone` is the visual vocabulary. The per-domain maps that translate a backend
 * status string into a tone live in `StatusBadge.tsx`, next to the enums they
 * mirror, so a status added on the server has one obvious place to be handled.
 */

export type Tone = 'success' | 'warning' | 'danger' | 'progress' | 'pending' | 'neutral' | 'info';

const TONES: Record<Tone, { className: string; Icon: (props: IconProps) => ReactNode }> = {
  /** Terminal and good: validated, published, answered, sourced, approved. */
  success: { className: 'border-success/50 bg-success/10 text-success', Icon: CheckCircleIcon },
  /**
   * Wants a human: requires review, partially sourced, unreviewed figures.
   *
   * The fill is the §6 yellow and the ink is not: `--color-accent-yellow` is
   * 1.7:1 on white and cannot carry type anywhere, which is precisely what
   * `--color-warning-ink` exists for. It reads 5.5:1 against this tint, and it
   * keeps the chip amber rather than resolving the contrast problem by turning
   * the warning navy — which would make it look like the `info` tone.
   */
  warning: {
    className: 'border-warning-ink/50 bg-accent-yellow/25 text-warning-ink',
    Icon: AlertTriangleIcon,
  },
  /** Terminal and bad: failed, dead-lettered, unsupported, rejected. */
  danger: { className: 'border-danger/50 bg-danger/10 text-danger', Icon: XCircleIcon },
  /** Running right now — the only tone a poller expects to see change. */
  progress: { className: 'border-sih-blue/50 bg-sih-blue/10 text-sih-blue', Icon: SpinnerIcon },
  /** Accepted, not started. */
  pending: {
    className: 'border-text-muted/50 bg-surface-muted text-text-muted',
    Icon: ClockIcon,
  },
  /** Resting, neither good nor bad: draft, archived. */
  neutral: {
    className: 'border-text-muted/50 bg-surface-muted text-text-muted',
    Icon: CircleIcon,
  },
  /** A scope marker or count, not a lifecycle state. */
  info: {
    className: 'border-primary-dark/50 bg-primary-dark/10 text-primary-dark',
    Icon: CircleIcon,
  },
};

export interface BadgeProps {
  tone: Tone;
  children: ReactNode;
  /**
   * Prefixes the badge's accessible text, so a bare "validated" is announced as
   * "Document status: validated". Any screen showing more than one badge family
   * in a row should set it — otherwise a screen reader emits a run of
   * unattributed adjectives.
   */
  srPrefix?: string;
  className?: string;
}

export function Badge({ tone, children, srPrefix, className }: BadgeProps) {
  const { className: toneClass, Icon } = TONES[tone];
  return (
    <span
      className={cn(
        /**
         * `text-xs font-medium` is UX4G's Label/M Strong, which is the step
         * their usage map assigns to a badge, chip or tag. 12px is also their
         * absolute floor, so this is the smallest anything in the product is
         * allowed to be set — and it is legible here only because the label is
         * one or two words with an icon beside it, never running copy.
         *
         * No target-size rule applies: 44x44 governs INTERACTIVE controls, and
         * a badge is a read-only marker. The interactive member of this family
         * is `CountChip` below, which is sized accordingly.
         *
         * `rounded-sm`, not `rounded-full`: a filed status marker, not a pill.
         * Padding is trimmed to match, because the round chip needed the extra
         * horizontal room only to keep its label clear of the curve.
         */
        'inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-medium',
        toneClass,
        className,
      )}
    >
      {srPrefix ? <span className="sr-only">{srPrefix}: </span> : null}
      {/* 12px against the 12px label: the icon is part of the word, not an
          ornament next to it — and it is the non-colour half of the signal the
          block at the top of this file insists on. */}
      <Icon
        size={12}
        className={tone === 'progress' ? 'animate-spin motion-reduce:animate-none' : undefined}
      />
      {children}
    </span>
  );
}

/**
 * Both forms of the chip share one box, and that is the point: dropped into the
 * same toolbar row they sit level, and what tells them apart is the EDGE and
 * the ink, never the geometry. A row where the clickable chip is visibly taller
 * than the static one reads as two unrelated components.
 *
 * 36px, matching `Button size="sm"`. This is the dense-context exception UX4G
 * allows against its 44px default — a filter chip lives in a toolbar strip
 * alongside selects and a Clear control, and 44px would set the height of that
 * whole band. 36px still clears WCAG 2.5.8's 24px AA floor by half again in
 * BOTH dimensions, which means adjacent chips satisfy the target rule outright
 * and never have to lean on its spacing exception — whatever gap the parent row
 * happens to set. `px-3` is the horizontal half of the same guarantee.
 *
 * `text-sm` is Body/S, the step this product uses for dense table cells: the
 * chip is a tally, not running copy, and it sits below the 16px body default
 * for the same reason a table cell does.
 */
const CHIP_BOX = 'inline-flex min-h-9 items-center gap-2 rounded-sm border px-3 py-1.5 text-sm';

/**
 * A count paired with a label — the tallies above list screens, optionally
 * acting as a filter toggle.
 *
 * Deliberately not a `Badge`: a count is not a lifecycle state, and giving it
 * the same shape would imply a status that does not exist. It is squared to the
 * same 4px so the two families read as one system, and separated from `Badge`
 * by weight and edge instead — no fill, a plain rule, and a figure set bold.
 *
 * With `onClick` it is a real control and is sized as one; without it, it is a
 * caption wearing the same box. See CHIP_BOX above for why 36px and not 44.
 */
export function CountChip({
  label,
  value,
  active = false,
  onClick,
}: {
  label: string;
  value?: number | undefined;
  active?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      {label}
      {/*
        The figure was previously held at 70% opacity, which put a real datum
        under the AA floor to make it look secondary. Weight separates it from
        its label instead, and costs nothing in contrast.
      */}
      {value === undefined ? null : (
        <span className="tabular-nums font-semibold">{value.toLocaleString('en-IN')}</span>
      )}
    </>
  );

  if (!onClick) {
    return (
      // Static: a caption, so the decorative rule is the right weight for it.
      // It keeps the 36px box only to stay level with its clickable siblings —
      // nothing here is a target, so no minimum is being satisfied.
      <span className={cn(CHIP_BOX, 'border-border text-text-muted')}>{content}</span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      // `aria-pressed` rather than `aria-selected`: these are independent
      // toggles, not options within a single-select listbox.
      aria-pressed={active}
      className={cn(
        CHIP_BOX,
        // Colour only, 150ms, like every other control in the product. A chip
        // does not lift or grow when you point at it.
        'transition-colors duration-150 motion-reduce:transition-none',
        active
          ? // The selected ground is the same tint that marks a selected table
            // row, so "this filter is on" and "this record is chosen" are one
            // signal learned once.
            'border-sih-blue bg-sih-blue-tint font-medium text-sih-blue'
          : // Clickable, so the edge has to be perceivable: `border-strong` is
            // what separates a control from the static chip above, and it is
            // the token that meets UX4G's 3:1 for a UI component boundary.
            'border-border-strong text-text-muted hover:bg-surface-muted hover:text-text-default active:bg-canvas',
      )}
    >
      {content}
    </button>
  );
}
