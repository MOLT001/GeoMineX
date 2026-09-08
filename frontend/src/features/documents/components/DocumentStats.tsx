'use client';

import type { ReactNode } from 'react';
import { useDashboard } from '@/features/dashboard/api';
import { AlertTriangleIcon, CheckCircleIcon, FileTextIcon, XCircleIcon } from '@/components/ui/Icon';
import { formatDateTime } from '@/lib/datetime';
import { cn } from '@/lib/cn';
import type { DocumentListFilters } from './DocumentFilterBar';

/**
 * The four counts above the document list.
 *
 * ─── WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT ──────────────────────────
 * They come from `GET /dashboard`, which counts every document in the
 * subsidiaries the caller can read. They are therefore SCOPE-WIDE and take no
 * notice of the filters below them.
 *
 * That distinction is the whole reason this component is written the way it is.
 * A row of totals sitting on top of a filtered table reads as a summary OF that
 * table, and in a product whose pitch is that every figure is traceable, a
 * headline number that quietly means something else is exactly the defect worth
 * avoiding. So the group is captioned with its scope, it sits ABOVE the filter
 * bar rather than between the filters and the results, and it carries the
 * `computedAt` line §13 requires on any cached aggregate.
 *
 * ─── WHAT THE REFERENCE DESIGN ASKED FOR AND WHY IT IS NOT HERE ─────────────
 * The layout this is modelled on carries a "Storage used — 4.8 GB of 25 GB"
 * tile and a "+12% vs last 30 days" delta. Neither exists:
 *
 *   STORAGE QUOTA. There is no per-tenant storage budget anywhere in the
 *   product. `MAX_UPLOAD_BYTES` is 25 MiB per FILE (§9.2), not a total, and
 *   presenting a per-file cap as a filling quota bar would be a fabricated
 *   constraint that also happens to be alarming.
 *
 *   TREND. No endpoint returns a previous-period count, so "+12%" could only
 *   be invented. A number with no source is the one thing this product must
 *   never render.
 *
 * Three of the four tiles are BUTTONS that apply the matching filter, because a
 * count you cannot act on is decoration. "Total" is not one: it is the absence
 * of a filter, which the Clear control below already expresses.
 */

interface Tile {
  key: string;
  label: string;
  hint: string;
  icon: ReactNode;
  value: number;
  /** The filter this tile narrows to, or null when it is not actionable. */
  filter: Partial<DocumentListFilters> | null;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

const TONES: Record<Tile['tone'], string> = {
  neutral: 'border-border-strong bg-surface-muted text-text-muted',
  success: 'border-success/30 bg-success/5 text-success',
  warning: 'border-accent-yellow bg-accent-yellow/10 text-warning-ink',
  danger: 'border-danger/30 bg-danger/5 text-danger',
};

export function DocumentStats({
  onApplyFilter,
}: {
  onApplyFilter: (filter: Partial<DocumentListFilters>) => void;
}) {
  const { data, isPending } = useDashboard();

  /*
   * ─── THE THREE STATES, AND WHY `isError` IS NOT ONE OF THEM ────────────────
   * This was `if (isPending || isError || !data) return null`, which had two
   * faults that only show up after the screen has been open a while.
   *
   * `isError` is set by a FAILED BACKGROUND REFETCH even when good data is
   * still in the cache. So one flaky refetch deleted the whole tile row —
   * including the provenance caption this component exists to carry — and
   * everything below jumped up to fill the gap, with no message explaining
   * why. Last-known counts with a timestamp on them are strictly better than
   * nothing, and the timestamp is what keeps that honest.
   *
   * Returning null while PENDING had the mirror fault: the tiles landed a beat
   * after the list and shoved it down the page, which on a slow dashboard
   * query is long enough for a click aimed at a filename to land on the row
   * below. The skeleton holds the space so nothing moves.
   *
   * Only a first load that has produced nothing at all renders nothing, and
   * then there is no space to reserve and no figure to caption.
   */
  if (!data) return isPending ? <StatsSkeleton /> : null;

  const { total, validated, failed, awaitingReview } = data.documents;

  const tiles: Tile[] = [
    {
      key: 'total',
      label: 'Documents',
      hint: 'Everything ingested for your subsidiaries',
      icon: <FileTextIcon size={18} strokeWidth={2.4} />,
      value: total,
      filter: null,
      tone: 'neutral',
    },
    {
      key: 'validated',
      label: 'Validated',
      hint: total > 0 ? `${percent(validated, total)} of all documents` : 'Read and indexed',
      icon: <CheckCircleIcon size={18} strokeWidth={2.4} />,
      value: validated,
      filter: { status: 'validated' },
      tone: 'success',
    },
    {
      key: 'review',
      label: 'Needs review',
      hint: 'Validated, but a human has to check a figure',
      icon: <AlertTriangleIcon size={18} strokeWidth={2.4} />,
      value: awaitingReview,
      filter: { status: 'validated', requiresReview: 'true' },
      tone: 'warning',
    },
    {
      key: 'failed',
      label: 'Failed',
      hint: 'Processing did not complete',
      icon: <XCircleIcon size={18} strokeWidth={2.4} />,
      value: failed,
      filter: { status: 'failed' },
      tone: 'danger',
    },
  ];

  return (
    <section aria-labelledby="document-counts" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="document-counts" className="text-base font-medium text-text-strong">
          Across the subsidiaries you can access
        </h2>
        {/*
          §13: a cached aggregate must say when it was computed. The list below
          is live and these are not, and on a screen showing both at once that
          difference has to be on the page rather than in someone's head.
        */}
        <p className="text-xs text-text-muted">
          Counted {formatDateTime(data.quickStats.computedAt)}
          {data.quickStats.cached ? ' · from cache' : null} · not affected by the filters below
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <TileBody tile={tile} onApplyFilter={onApplyFilter} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TileBody({
  tile,
  onApplyFilter,
}: {
  tile: Tile;
  onApplyFilter: (filter: Partial<DocumentListFilters>) => void;
}) {
  const inner = (
    <>
      <span
        aria-hidden
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-md border',
          TONES[tile.tone],
        )}
      >
        {tile.icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-2xl font-semibold text-text-strong tabular-nums">
          {tile.value.toLocaleString('en-IN')}
        </span>
        <span className="text-sm font-medium text-text-default">{tile.label}</span>
        <span className="mt-0.5 text-xs text-text-muted">{tile.hint}</span>
      </span>
    </>
  );

  // `h-full` so every tile fills its grid cell. Without it each sizes to its own
  // content and a two-line hint makes that one tile taller than its neighbours,
  // which reads as a layout bug rather than as a longer sentence.
  const shell =
    'flex h-full w-full items-start gap-3 rounded-md border border-border bg-surface p-4 text-left';

  if (!tile.filter) {
    return <div className={shell}>{inner}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => onApplyFilter(tile.filter!)}
      // The accessible name has to carry the ACTION, not just the number: a
      // button announced as "12 Failed" gives no clue that pressing it filters
      // the list, and the visible text cannot say so without repeating itself
      // four times.
      // "Filter the list to" rather than "to these": the count is a cached
      // aggregate up to five minutes old (METRICS_CACHE_TTL_SECONDS) while the
      // list is live, so the two can legitimately disagree — and a name that
      // promises the list will show exactly this many is a promise the cache
      // cannot keep.
      aria-label={`${tile.label}: ${tile.value}. Filter the list to ${tile.label.toLowerCase()} documents.`}
      className={cn(
        shell,
        'transition-colors duration-150 motion-reduce:transition-none',
        'hover:border-sih-blue hover:bg-sih-blue-tint',
      )}
    >
      {inner}
    </button>
  );
}

/**
 * The same footprint as the real row, so the list below does not move when the
 * counts arrive. Four cells, matching the grid the tiles use.
 */
function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      <div className="h-6" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((n) => (
          <div
            key={n}
            className="h-[5.75rem] rounded-md border border-border bg-surface motion-safe:animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}

/** Whole percent — a tenth of a percent on a document count is noise. */
function percent(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`;
}
