import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { ChevronLeftIcon, ChevronRightIcon } from './Icon';

/**
 * Table primitives and the two — deliberately two — pagination controls.
 *
 * ─── WHY PAGINATION IS TWO COMPONENTS AND NOT ONE ───────────────────────────
 * The API paginates in two different ways, and the difference is not cosmetic
 * (`backend/src/utils/envelope.ts`):
 *
 *   offset  { total, page, limit, totalPages }   users, reports
 *   cursor  { nextCursor, limit }                documents, queries, audit logs
 *
 * The cursor envelope omits `total` ON PURPOSE — counting an append-heavy
 * collection on every page load is the expensive part, and these are the three
 * collections that grow without bound. So a cursor list cannot render "Page 3
 * of 47", cannot render a page-number strip, and cannot say how many results
 * matched. Building one control that "handles both" means inventing a total,
 * and the invented value is wrong in the exact case the omission was protecting.
 *
 * Hence: `OffsetPagination` for the lists that have counts, `LoadMore` for the
 * lists that do not.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * A horizontally scrollable table.
 *
 * The scroll container is focusable (`tabIndex={0}`) with an accessible name.
 * A region that scrolls but cannot be focused is unreachable by keyboard —
 * a WCAG 2.1 failure that is invisible on a wide desktop monitor and appears
 * the moment the table is narrower than its content.
 */
export function TableFrame({
  caption,
  children,
  className,
}: {
  /** Names the table for assistive technology. Required — there is no good default. */
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      // `border-strong`, not `border`: the outer edge of a table is an object
      // boundary rather than a decorative separator, so it is one of the edges
      // §6 requires to clear 3:1. The ground is painted here as well as on the
      // rows, so the empty case still reads as a record and not as page canvas.
      //
      // `shadow-sm` is UX4G Level 1 — the resting step, the same one a Card
      // takes, because a table frame is the same kind of object: a panel at
      // rest on the canvas. Their rule "pair elevation with a border" is
      // already satisfied by the frame above, and nothing here escalates on
      // hover, since the FRAME is not the interactive thing — the rows are.
      className={cn(
        'overflow-x-auto rounded-md border border-border-strong bg-surface shadow-sm',
        className,
      )}
    >
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    /**
     * The heavier 2px rule under the header is the classic printed-table
     * signal: it separates the column NAMES from the data in a way a 1px
     * divider — the same weight as every row divider below it — cannot. Paired
     * with the muted ground it makes the header a band rather than a first row.
     * It stays exactly as it was; only the type inside the band moved.
     *
     * ─── 14px SEMIBOLD, NOT 12px UPPERCASE TRACKED ────────────────────────────
     * UX4G maps a table column header to Heading/2XS — 14px at 600 — and this
     * band was carrying three emphasis devices at once instead: a size step
     * DOWN, all caps, and `tracking-wider`. That combination is the one their
     * type guidance argues against from both ends. It says hierarchy is carried
     * by weight rather than by stacking devices, and it warns against custom
     * tracking, which at 12px all-caps is where a column header stops being
     * scannable — a header is a label a reader glances at sideways while
     * following a row, so it has to be read at a glance or it is decoration.
     *
     * The weight (`font-semibold`, on `TH`) is now the only thing marking the
     * band's type, which is exactly what they ask for. Some screen readers also
     * spell all-caps words letter by letter, so this costs nothing there either.
     * ──────────────────────────────────────────────────────────────────────────
     */
    <thead className="border-b-2 border-border-strong bg-surface-muted text-sm text-text-muted">
      {children}
    </thead>
  );
}

export function TH({
  children,
  className,
  numeric = false,
}: {
  children: ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        // The gutter matches `TD` exactly, so a column's name sits over its
        // values rather than a half-step inside them. The header no longer buys
        // back rows by being smaller than the cells — it is the same 14px now —
        // so the old tighter padding was only making the band cramped.
        'px-4 py-3 font-semibold',
        numeric && 'text-right tabular-nums',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      // A whole-row click handler is a convenience layered on top of a real
      // link inside the row — never the only way to open the record. A row is
      // not focusable and does not appear in the tab order, so a keyboard user
      // reaching it any other way would be stuck.
      onClick={onClick}
      className={cn(
        'bg-surface',
        // The hover tint is the BLUE tint, not the grey one. In a dense ruled
        // table the pointed-at row has to be unmistakable at a glance, and
        // `surface-muted` is the same tone as the header band — too quiet to
        // separate one row of twenty-five from its neighbours.
        //
        // Colour only, at the fast step, and off entirely under
        // `prefers-reduced-motion` — a row that moved or scaled under the
        // pointer would be the one thing in this product that animates
        // position. `motion-reduce` is belt-and-braces alongside the global
        // block in globals.css, since this component adds its own transition.
        onClick &&
          'cursor-pointer transition-colors duration-150 hover:bg-sih-blue-tint motion-reduce:transition-none',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TD({
  children,
  className,
  numeric = false,
}: {
  children: ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    // Body/S (14px, inherited from the frame) is a legitimate step for dense
    // tabular data on UX4G's own scale — it is the DEFAULT body size that has
    // to clear 16px, not every cell of a twenty-five row table. What the row
    // does owe is height: `py-3` gives a cell with a link or a badge in it the
    // vertical room to reach the 36px dense-context target floor.
    <td className={cn('px-4 py-3 align-top', numeric && 'text-right tabular-nums', className)}>
      {children}
    </td>
  );
}

/** A row spanning the full width, for the empty case inside a rendered table. */
export function TEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      {/* Body/M here, not the 14px of a data cell: the empty case is a sentence
          addressed to the reader rather than tabular data, so it takes the
          16px floor the rest of the product's prose sits at. */}
      <td colSpan={colSpan} className="bg-surface px-4 py-10 text-center text-base text-text-muted">
        {children}
      </td>
    </tr>
  );
}

/**
 * Both pagination controls sit directly under a table frame, so both are drawn
 * as the same footer band: a ruled strip on the header's ground, bookending the
 * toolbar above the table. It also keeps the page from reflowing when a list
 * crosses from one page to two and the control changes shape.
 *
 * The padding grew to match `Toolbar`, and for the same reason: the band holds
 * controls, and a control needs clear space around it as much as it needs its
 * own 36px box. 8px of vertical padding around a 36px target left the strip
 * looking shrink-wrapped and put the outer buttons within a few pixels of the
 * frame edge.
 */
const FOOTER_BAND = 'rounded-md border border-border bg-surface-muted px-4 py-3';

/**
 * Pagination for OFFSET lists — the ones whose envelope carries `total`.
 *
 * Renders a compact window of page numbers rather than all of them: at 40 pages
 * a full strip is unusable with a screen reader and wraps to three lines on a
 * phone.
 */
export function OffsetPagination({
  page,
  totalPages,
  total,
  onPageChange,
  busy = false,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  busy?: boolean;
}) {
  if (totalPages <= 1) {
    return (
      <p className={cn(FOOTER_BAND, 'text-sm tabular-nums text-text-muted')}>
        {total.toLocaleString('en-IN')} {total === 1 ? 'result' : 'results'}
      </p>
    );
  }

  const pages = pageWindow(page, totalPages);

  return (
    <nav
      aria-label="Pagination"
      className={cn(FOOTER_BAND, 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2')}
    >
      <p className="text-sm tabular-nums text-text-muted">
        Page {page} of {totalPages} · {total.toLocaleString('en-IN')} results
      </p>

      {/**
       * `gap-2` between every control in the strip, where it used to be 4px.
       * The target-size rule is not only about the box: two 36px boxes 4px
       * apart are one mis-tap away from each other, and page numbers are the
       * densest cluster of adjacent targets in the product.
       */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1 || busy}
          onClick={() => onPageChange(page - 1)}
          icon={<ChevronLeftIcon size={14} />}
        >
          Previous
        </Button>

        {pages.map((p, i) =>
          p === null ? (
            // Sized to the same 36px row as the numerals either side of it so
            // the strip reads as one line of boxes with a gap in it, rather
            // than as boxes with a smaller thing wedged between them. It is
            // `aria-hidden` and not a control, so it gets height but no box.
            <span
              key={`gap-${i}`}
              aria-hidden
              className="inline-flex min-h-9 items-center px-1 text-sm text-text-muted select-none"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              disabled={busy}
              onClick={() => onPageChange(p)}
              // `aria-current="page"` is what tells a screen reader which page
              // it is on. The bold weight only tells a sighted user.
              aria-current={p === page ? 'page' : undefined}
              aria-label={`Page ${p}`}
              className={cn(
                // Bordered boxes rather than bare numerals: sitting on the
                // band's own ground, an unbordered number does not read as a
                // control until it is hovered.
                //
                // ─── 36px SQUARE, AND WHY 36 RATHER THAN 44 ──────────────────
                // `min-h-9 min-w-9` pins both dimensions, so the target is a
                // square that does not shrink as the digit count changes — a
                // page-number strip where "9" is a smaller target than "10" is
                // the failure this replaces (`min-w-9` alone left the HEIGHT at
                // whatever the 14px line-height plus 4px of padding came to,
                // about 30px, under the AA floor).
                //
                // 36px is the dense-context exception, not the default: these
                // are a row of numerals inside a table's footer band, the same
                // context that lets a cell control drop below 44px, and it
                // clears the WCAG 2.5.8 AA minimum of 24px with half again to
                // spare. The `gap-2` above is the other half of that trade —
                // 2.5.8 is satisfied by spacing where it is not by size.
                // ─────────────────────────────────────────────────────────────
                'inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border px-2.5',
                // Colour only, at the fast step, and off under reduced motion.
                'text-sm tabular-nums transition-colors duration-150 motion-reduce:transition-none',
                'disabled:cursor-not-allowed disabled:opacity-60',
                p === page
                  ? 'border-sih-blue bg-sih-blue font-semibold text-white'
                  : 'border-border bg-surface text-text-default hover:border-border-strong hover:bg-sih-blue-tint',
              )}
            >
              {p}
            </button>
          ),
        )}

        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages || busy}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRightIcon size={14} />
        </Button>
      </div>
    </nav>
  );
}

/** First, last, and a window around the current page; `null` marks an ellipsis. */
function pageWindow(page: number, totalPages: number): Array<number | null> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const out: Array<number | null> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);

  if (start > 2) out.push(null);
  for (let p = start; p <= end; p += 1) out.push(p);
  if (end < totalPages - 1) out.push(null);

  out.push(totalPages);
  return out;
}

/**
 * Pagination for CURSOR lists — the ones with no `total`.
 *
 * An explicit button rather than scroll-triggered loading. Infinite scroll on
 * an audit log is actively hostile: it makes the page footer unreachable, it
 * breaks Ctrl+F over the full result set, and it loads records the user never
 * asked for. A button also gives the screen reader a place to land.
 *
 * The count shown is "N loaded", never "N results" — the API does not know how
 * many match, and neither do we.
 */
export function LoadMore({
  loaded,
  hasMore,
  isLoading,
  onLoadMore,
  noun = 'results',
}: {
  loaded: number;
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  noun?: string;
}) {
  return (
    <div
      className={cn(
        FOOTER_BAND,
        // One centred row rather than a stacked column: the count and the
        // control are a single statement, and the row costs half the height.
        'flex flex-wrap items-center justify-center gap-x-4 gap-y-2',
      )}
    >
      <p aria-live="polite" className="text-sm tabular-nums text-text-muted">
        {loaded.toLocaleString('en-IN')} {noun} loaded
        {hasMore ? '' : ' · end of list'}
      </p>
      {hasMore ? (
        <Button
          variant="secondary"
          size="sm"
          busy={isLoading}
          busyLabel="Loading…"
          onClick={onLoadMore}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
