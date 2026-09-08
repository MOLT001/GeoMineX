/**
 * The icon set, hand-authored as inline SVG.
 *
 * Three reasons this is not a dependency (`lucide-react` et al):
 *
 *   1. Colour must never be the only carrier of meaning. §6 specifies contrast
 *      and says nothing about colour-blind users, so every status in this app
 *      pairs its colour with a SHAPE. That makes the icon set part of the
 *      status vocabulary rather than decoration, and a fixed, reviewed set of
 *      nine is easier to keep honest than a library of a thousand.
 *   2. Presentation attributes only, never a `<style>` element. An SVG carrying
 *      inline CSS needs the per-request nonce from `proxy.ts`; without it the
 *      icon renders unstyled and nothing reports an error.
 *   3. `currentColor` throughout, so an icon inherits its badge's or button's
 *      colour with no variant plumbing.
 *
 * Icons are `aria-hidden` by default. They sit beside a visible text label
 * everywhere in this app; announcing them would double every status. Pass a
 * `title` only for the rare icon-only control, which also needs its own
 * accessible name on the button.
 */

export interface IconProps {
  size?: number;
  className?: string;
  /** Supply ONLY when the icon carries meaning no adjacent text conveys. */
  title?: string;
  /**
   * Override the stroke, in viewBox units.
   *
   * The RENDERED stroke is `strokeWidth * size / 24`, so the default 2 lands on
   * a fractional device pixel at most sizes — 1.67px at `size={20}`, which the
   * browser has to antialias across two pixel columns and which reads as a
   * soft, slightly furry line next to crisp text. Pass a value that makes the
   * product whole: 2.4 at size 20 gives exactly 2px. The sidebar does this.
   */
  strokeWidth?: number;
}

function svgProps({ size = 16, className, title, strokeWidth }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    /**
     * Optical compensation, not a style choice.
     *
     * The width is in the 24-unit viewBox, so the RENDERED stroke scales with
     * the icon: 2 lands at 1.33px at `size={16}` but at exactly 1px at
     * `size={12}`, the badge size. A one-pixel hairline reads a full step
     * lighter than the 12px semibold label it is set beside, which makes the
     * status shape — the thing that carries meaning for a colour-blind reader —
     * the faintest mark in the badge. Nudged up at that end only; every larger
     * size is already at the right weight and is left alone.
     */
    strokeWidth: strokeWidth ?? (size <= 12 ? 2.25 : 2),
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    ...(title ? { role: 'img' as const } : { 'aria-hidden': true }),
  };
}

function Titled({ title }: { title?: string }) {
  return title ? <title>{title}</title> : null;
}

/* ── Section icons ──────────────────────────────────────────────────────────
 *
 * One per destination in the sidebar, and they exist for a reason the rest of
 * this set does not share: in the collapsed rail below `lg` the icon is the
 * ONLY thing on screen, so it is carrying the whole label. Each is therefore
 * the most conventional glyph for its section rather than the most interesting
 * one — a chart for Analytics, a shield for Audit — because a reader gets no
 * second chance at a rail 64px wide. Each link still carries its name as an
 * `aria-label`, so nothing here is the only route to the meaning.
 * ────────────────────────────────────────────────────────────────────────── */

/** Dashboard — the four-panel overview. */
export function GridIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Reports — a drafted document on a board, distinct from a plain file. */
export function ClipboardIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

/**
 * Queries — a question asked of the corpus.
 *
 * Squared off rather than the circular bubble that was here first: that path's
 * ink reached x = -1.4 in a 0-24 viewBox, so the left of the bubble was cut off
 * against the edge. Measured, not guessed — `getBBox` plus half the stroke.
 * Everything here now sits inside 1..23, which leaves room for the 2-unit
 * stroke at any size.
 */
export function ChatIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M20 4H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l5-4h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z" />
    </svg>
  );
}

/** Topics — what the corpus is about. */
export function TagIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M20.5 13.5 13 21a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 2.6 12.6L3 5a2 2 0 0 1 2-2l7.6-.4a2 2 0 0 1 1.5.6l6.4 6.4a2 2 0 0 1 0 2.9Z" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

/** Analytics — figures over time. */
export function BarChartIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7.5" y="12" width="3" height="5" rx="0.5" />
      <rect x="13" y="8" width="3" height="9" rx="0.5" />
      <rect x="18" y="14" width="3" height="3" rx="0.5" />
    </svg>
  );
}

/** Audit — the compliance trail, §9.6. */
export function ShieldIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M12 3l7.5 3v6c0 4.4-3 8.3-7.5 9.5C7.5 20.3 4.5 16.4 4.5 12V6L12 3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** Admin — the people the panel manages. */
export function UsersIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.25 3.25 0 0 1 0 5.6" />
      <path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 20" />
    </svg>
  );
}

/* ── Document-type icons ────────────────────────────────────────────────────
 *
 * One per `DocumentType`, so a long list is scannable by shape before it is
 * read. They sit beside the type's written label everywhere, never instead of
 * it: §6's contrast rule says nothing about colour-blind users, and a glyph
 * that is the ONLY carrier of "this is a spreadsheet" would be the same mistake
 * in a different medium.
 * ────────────────────────────────────────────────────────────────────────── */

/** A raster image or photograph. */
export function ImageIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m3.5 17 4.5-4.5 3.5 3.5 3-3 6 6" />
    </svg>
  );
}

/** A scanned page — the platen line is what separates it from a plain file. */
export function ScanIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M20 8V6a2 2 0 0 0-2-2h-2" />
      <path d="M4 16v2a2 2 0 0 0 2 2h2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M3 12h18" />
    </svg>
  );
}

/** A spreadsheet — ruled rows and columns. */
export function TableIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9.5h18" />
      <path d="M9 9.5V20" />
    </svg>
  );
}

/** Terminal success — a validated document, a published report. */
export function CheckCircleIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

/**
 * A bare tick, for marking the chosen option in a listbox.
 *
 * Distinct from `CheckCircleIcon`, which is a STATUS — a validated document, a
 * published report. This one means "this is the one you picked", so it carries
 * no enclosing shape that would read as a badge.
 */
export function CheckIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

/** Needs a human — review required, partially sourced, unreviewed figures. */
export function AlertTriangleIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17.4h.01" />
    </svg>
  );
}

/** Terminal failure — failed, dead-lettered, rejected. */
export function XCircleIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </svg>
  );
}

/** Waiting, not yet started — queued. */
export function ClockIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.9" />
    </svg>
  );
}

/**
 * In progress. Static by design — the animation lives on the element via a
 * Tailwind class, so `motion-reduce:animate-none` can switch it off. Baking a
 * `<animateTransform>` into the SVG would ignore that preference.
 */
export function SpinnerIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/** Draft, archived, and other neutral resting states. */
export function CircleIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M12 4v12" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </svg>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5L14 3Z" />
      <path d="M13.75 3.2V8h4.8" />
      <path d="M9 13h6M9 16.5h4" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

/**
 * Marks a figure that traces back to a source page — the product's core claim,
 * so it gets its own mark rather than reusing the generic file icon.
 */
export function SourceLinkIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1.5 1.5" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1.5-1.5" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <Titled title={props.title} />
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

