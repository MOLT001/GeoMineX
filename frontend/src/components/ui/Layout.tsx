import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Page furniture — the repeated structural shapes, in one place.
 *
 * These carry the §6 hierarchy rules so screens do not each re-decide them:
 * headings on the shared type scale, hierarchy through 1px rules and surface
 * tone, and one `<h1>` per page.
 *
 * ─── THE TYPE STEPS ARE UX4G'S USAGE MAP, NOT A LOCAL TASTE CALL ────────────
 * Every size in this file is a named step in UX4G's scale, and the step is
 * chosen by ROLE rather than by how big the heading wanted to look:
 *
 *   page title    text-4xl  32px  Heading/XL
 *   section head  text-2xl  24px  Heading/M
 *   card title    text-xl   20px  Heading/S
 *   body, values  text-base 16px  Body/M — and their published floor
 *   record label  text-xs   12px  Label/M
 *
 * The previous pass set the `<h1>` at 24px and everything under it at 14px,
 * which put the DEFAULT body text of twenty routes below UX4G's stated 16px
 * minimum ("smaller text fails AA for many readers"). 14px survives here only
 * where their scale genuinely allows it — helper text, dense table cells —
 * never as the default a screen inherits.
 *
 * Their companion rule is why nothing below reaches for a bigger size to make
 * a point: "never increase font size purely for emphasis — use the Strong
 * weight instead".
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ─── ONE MARK PER LEVEL ─────────────────────────────────────────────────────
 * An official document tells you where you are by how a heading is MARKED, not
 * only by how large it is, so each level here gets exactly one device and never
 * a second:
 *
 *   page     a full-width 1px rule beneath the whole header block
 *   section  a short accent bar in the gutter to the left of the `<h2>`
 *   card     an optional banded header in the muted ground, ruled off from its body
 *
 * They are deliberately different shapes rather than three weights of the same
 * rule: a reader dropped into the middle of a long screen can tell a section
 * head from a card head at a glance, which is the whole job of the hierarchy.
 * Adding a fourth device, or giving one level two of them, is what turns a
 * portal back into a dashboard.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The top of every authenticated screen.
 *
 * `title` renders the page's only `<h1>`. Section headings beneath it are
 * `<h2>` via `Section`, which keeps the outline navigable — a page with three
 * `<h1>`s and one with none are equally unusable with a screen reader's
 * heading-jump.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Primary actions for the page, right-aligned. */
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  /**
   * A section glyph set beside the title.
   *
   * Purely decorative and rendered `aria-hidden`: it repeats what the `<h1>`
   * beside it already says, and announcing it would make a screen reader read
   * the page name twice. Pass one only where the page is a top-level section a
   * reader arrives at repeatedly — it is a landmark, not an ornament for every
   * detail screen.
   */
  icon?: ReactNode;
}) {
  return (
    /**
     * The rule under the header is the single most "official document" move
     * available: it turns the title, its description and its actions into a
     * masthead for the page rather than the first item in a stack of panels.
     *
     * It is `border-strong` and not `border`, because this block sits directly
     * on `canvas` — the light decorative border is barely a step from that tint
     * and all but disappears on it, and a rule that cannot be seen is doing
     * none of the work it was added for.
     */
    <div className="flex flex-col gap-3 border-b border-border-strong pb-5">
      {breadcrumb ? (
        /**
         * The breadcrumb slot, styled here rather than at the three call sites.
         *
         * UX4G puts breadcrumbs at the top of the page, above the title, with
         * every crumb clickable — so this wrapper owns the two things a caller
         * keeps getting wrong and cannot fix consistently on its own:
         *
         *   TARGET SIZE. `[&_a]:min-h-11` gives every crumb the 44px minimum
         *   (WCAG 2.5.5). A bare 14px text link is roughly a 20px target, and a
         *   breadcrumb is the one control on a detail screen a phone user
         *   reaches for most — the way back.
         *
         *   AFFORDANCE. `underline` on every crumb, not `hover:underline`: a
         *   link identified by colour alone fails WCAG 1.4.1, and it failed
         *   inconsistently here because two call sites underlined and one did
         *   not. `underline-offset-4` keeps the rule off the descenders.
         *
         * Descendant selectors, deliberately: the prop is a `ReactNode` slot
         * whose signature must not change, so the only way to reach the crumbs
         * is through the wrapper. `gap-x-2` is the room a caller's own
         * separator sits in when a screen renders more than one crumb.
         */
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:gap-1 [&_a]:underline [&_a]:underline-offset-4">
          {breadcrumb}
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-4">
          {icon ? (
            /*
              A ruled tile, not a tinted disc. §6's language is that a thing
              with edges reads as a record and a soft circle reads as an app
              icon — the same reasoning that shapes the step markers on the
              public page. `mt-1` sets it optically level with the cap height
              of a 32px title rather than its box.
            */
            <span
              aria-hidden
              className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-md border border-border-strong bg-sih-blue-tint text-sih-blue"
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
          {/**
           * Heading/XL — UX4G's page-title step, 32px on a 40px line.
           *
           * No `leading-tight`. The scale in globals.css ships each size PAIRED
           * with its line-height, so overriding the leading here would take the
           * size from UX4G and the rhythm from somewhere else.
           */}
          <h1 className="font-serif text-4xl font-semibold text-text-strong">{title}</h1>
          {description ? (
            /**
             * Body/M, because this is the page's own explanatory line and 16px
             * is UX4G's floor for text meant to be read. `max-w-2xl` is the
             * reading measure at this size — about 84 characters, inside their
             * 50–90 band — so a wide monitor does not stretch it into a ribbon.
             */
            <p className="mt-2 max-w-2xl text-base text-text-muted">{description}</p>
          ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * A labelled region with an `<h2>`.
 *
 * The heading and the region are wired together with `aria-labelledby` rather
 * than left as neighbouring elements, so a screen reader announces "Citations,
 * region" on entry instead of dropping the user into unattributed content.
 */
export function Section({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  /** Must be unique on the page — it becomes the heading's element id. */
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/**
         * The accent bar, and why it is a bar rather than another rule.
         *
         * A section head repeats down a long screen; a horizontal rule at every
         * one would stripe the page and compete with the single rule under the
         * `<h1>`. A vertical bar marks the heading without crossing the column,
         * so the page keeps exactly one full-width division.
         *
         * 3px in `sih-blue` — the same weight as the active-tab edge in the
         * navigation band, so "this is the marked one" looks the same in the
         * chrome and in the content. `accent-orange` is reserved for Upload and
         * Generate Report and never marks structure.
         *
         * The heading indents WITH the bar rather than the bar hanging outside
         * it: a negative offset would collide with the padding of a Card
         * whenever a Section is nested inside one, which several screens do.
         */}
        <div className="min-w-0 border-l-[3px] border-sih-blue pl-3">
          {/**
           * Heading/M (24px), and the choice between UX4G's two section steps —
           * L at 28px and M at 24px — is made ONCE here rather than per screen.
           * M is the one that fits: it sits a clear step under the 32px `<h1>`
           * and leaves the 20px card title a step of its own, where 28px would
           * squeeze the three levels into 4px of each other and force the card
           * band down to a size that reads as a label rather than a title.
           */}
          <h2 id={headingId} className="font-serif text-2xl font-semibold text-primary-dark">
            {title}
          </h2>
          {/* Body/M — the same 16px floor the page description sits at. */}
          {description ? <p className="mt-1 text-base text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A bordered panel. §6 asks for hierarchy through tone, so the border is light.
 *
 * `title` is optional and adds the banded header that is the backbone of a
 * government data portal: a muted strip, ruled off from the body, naming what
 * the panel holds. Omitted, the card is exactly what it was — one padded box.
 *
 * The two shapes are written out separately below because the padding has to
 * move inside the body once there is a band, and every existing caller passes
 * its `className` expecting to style the padded box itself.
 */
export function Card({
  children,
  className,
  muted = false,
  title,
}: {
  children: ReactNode;
  className?: string;
  /** Recessed ground, for supporting content beside a primary panel. */
  muted?: boolean;
  /** Renders a header band above the body. Omitted, the card is a plain panel. */
  title?: ReactNode;
}) {
  const ground = muted ? 'bg-surface-muted' : 'bg-surface';

  /**
   * Level 1 at rest — `shadow-sm`, and it goes on BOTH shapes.
   *
   * UX4G's elevation guidance names this case directly: L1 is "a subtle lift to
   * separate [a resting card] from the background", and its companion rule is
   * "pair elevation with a border", which is what the border here already does.
   * At 4% opacity the lift is barely visible on its own; the pairing is the
   * point, not the shadow.
   *
   * Nothing escalates on hover, because a Card is not interactive — L2 is for
   * "hover/focus on interactive elements", and their explicit DON'T is applying
   * a high level "to inline or resting elements". A resting panel that lifts
   * under the pointer is claiming an affordance it does not have.
   */
  const elevation = 'shadow-sm';

  if (title === undefined) {
    return (
      <div className={cn('rounded-lg border border-border p-4', elevation, ground, className)}>
        {children}
      </div>
    );
  }

  return (
    /* `overflow-hidden` so the band's corners follow the card's own radius
       instead of squaring off inside it. */
    <div
      className={cn('overflow-hidden rounded-lg border border-border', elevation, ground, className)}
    >
      {/**
       * Heading/S (20px) — a card TITLE on UX4G's usage map, which is where
       * this belongs; it was set at 12px uppercase and tracked, which is their
       * Label step and made the band read as a column header rather than as the
       * name of the panel under it.
       *
       * Losing the uppercase is deliberate and not only typographic: UX4G
       * carries hierarchy in weight rather than in a second device, and some
       * screen readers spell out an all-caps word letter by letter. The band
       * itself — muted ground, ruled off from the body — is still what marks
       * this level, so the "one mark per level" rule at the top of this file
       * holds; only the type inside the band moved onto the scale.
       *
       * Still deliberately not an `<h2>`/`<h3>` — a Card can sit at any depth
       * inside a Section, and a component that silently injects heading levels
       * is how a document outline becomes unreadable.
       */}
      <div className="border-b border-border bg-surface-muted px-4 py-3">
        <p className="text-xl font-semibold text-primary-dark">{title}</p>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/**
 * The filter/search strip above a list.
 *
 * Reads as an inset control strip and not as another card: muted ground and a
 * `border-strong` frame, because this edge encloses controls rather than
 * decorating a panel.
 *
 * The padding and gaps grew a step. Every child is a 44px control now (WCAG
 * 2.5.5), and the previous 12px/8px spacing was set around 36px ones — packed
 * that tightly, adjacent targets touch, which is the other half of the target
 * rule: a 44px box with no space around it still gets mis-tapped.
 *
 * `items-end` is load-bearing. Every child is a `Field` — a label stacked over
 * an input — so their tops are ragged and only their control edges line up.
 * Aligning on that bottom edge is what puts the inputs, the selects and the
 * reset button on one line.
 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-x-4 gap-y-3 rounded-md border border-border-strong bg-surface-muted px-4 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Key/value metadata — document properties, report attributes, audit details.
 *
 * A real `<dl>`, not a two-column grid of `<div>`s: the association between a
 * label and its value is then in the markup, so a screen reader can pair them.
 * A grid conveys that relationship through position alone, which is exactly the
 * information a linear reading loses.
 */
export function DescriptionList({
  items,
  className,
  columns = 2,
}: {
  items: Array<{ label: string; value: ReactNode }>;
  className?: string;
  columns?: 1 | 2 | 3;
}) {
  const gridClass = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' }[columns];
  return (
    /**
     * Ruled entries, because this is a RECORD and a record is read by scanning
     * down it. The vertical gap is dropped and each entry carries its own top
     * rule instead, so the pairs sit in a ruled grid the way a specification
     * table does rather than floating in white space.
     *
     * EVERY entry is ruled, the first row included. Tempting as it is to skip
     * that one, "first row" is not a fixed set of entries here: the grid
     * collapses to a single column below `sm`, so anything keyed on the column
     * count would leave a hole in the ruling at the breakpoint it stops being
     * true.
     */
    <dl className={cn('grid gap-x-6', gridClass, className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-t border-border py-2.5">
          {/**
           * Label/M — 12px at medium weight, UX4G's label step, which is what a
           * `<dt>` is. It keeps `tracking-wide`: their tracking rule bars
           * "custom tracking into unreadable values", and opening up an
           * all-caps label is the case that moves in the other direction.
           */}
          <dt className="text-xs font-medium tracking-wide text-text-muted uppercase">{item.label}</dt>
          {/**
           * Body/M. The VALUE is the record — the thing someone came to this
           * screen to read — so it sits at UX4G's 16px body floor rather than
           * at the 14px helper step its label pairs with. The extra weight is
           * what makes the value, not its label, where the eye lands when
           * scanning the column; the size step now says the same thing.
           */}
          <dd className="mt-1 text-base font-medium break-words text-text-default">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Text that came out of a PDF or a language model.
 *
 * Rendered as a React text node with `whitespace-pre-wrap` — never as HTML.
 * The backend stores report bodies, query answers and citation quotes as plain
 * strings, so there is no markup to preserve, and introducing a markdown or
 * rich-text renderer here would manufacture precisely the XSS surface §9.13
 * exists to prevent. `break-words` matters too: extracted text contains long
 * unbroken identifiers that would otherwise push the page sideways.
 *
 * `leading-6` rather than `leading-relaxed`: 24px is a whole number of the 4px
 * step everything else in this file is spaced on, so a wrapped paragraph stacks
 * on the same rhythm as the rows beside it instead of drifting off it. It is
 * also exactly the line-height the 16px step ships with, so writing it out is a
 * restatement rather than an override.
 *
 * ─── THE TWO THINGS THAT CHANGED, AND THE ONE THAT MUST NOT ─────────────────
 * SIZE. Body/M, 16px. This component renders the report bodies, model answers
 * and citation quotes — the text in this product people actually read end to
 * end — and 14px is below the floor UX4G sets for exactly that ("minimum body
 * size 16px").
 *
 * MEASURE. 68ch, the same value `.measure` carries in globals.css, from UX4G's
 * "aim for 50–90 characters per line". The old note here said the measure had
 * to be left to the caller because this also renders inside a table cell — but
 * a MAX-width only ever caps, never stretches, so a cell narrower than 68ch is
 * untouched by it and only the full-panel case is reined in. It is spelled as
 * a utility rather than as the `.measure` class on purpose: `.measure` is
 * unlayered and would outrank any width a caller passes in `className`, which
 * is the same trap the heading rule in globals.css documents.
 *
 * `whitespace-pre-wrap` and `break-words` are NOT design decisions and are not
 * to be retuned: this is the §9.13 plain-text rendering path, and the reason it
 * is a text node instead of markup.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function ProseText({ children, className }: { children: string; className?: string }) {
  return (
    <p
      className={cn(
        'max-w-[68ch] text-base leading-6 break-words whitespace-pre-wrap text-text-default',
        className,
      )}
    >
      {children}
    </p>
  );
}
