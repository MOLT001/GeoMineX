'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useWordcloud } from '@visx/wordcloud';
import { sequentialStep } from '@/components/charts/palette';
import { Button } from '@/components/ui/Button';
import { EmptyState, Skeleton } from '@/components/ui/Feedback';
import { TBody, TD, TH, THead, TR, TableFrame } from '@/components/ui/Table';
import { cn } from '@/lib/cn';
import type { WordCloudEntry } from '@/features/topics/api';

/**
 * The word cloud — PRD §5.6.
 *
 * ─── WHY THE TABLE UNDERNEATH IS NOT OPTIONAL ───────────────────────────────
 * A word cloud encodes magnitude as glyph area, which is the least accurately
 * read of all the visual variables, and it encodes nothing at all for a
 * screen-reader user: the SVG is a scatter of `<text>` in layout order, not
 * reading order. So the cloud is marked `role="img"` with a summary label, and
 * the numbers live in a real table beside it. The table is the data; the cloud
 * is the index into it.
 *
 * The layout also DROPS words it cannot place — `d3-cloud` only keeps a tag
 * when `place()` succeeds — so on a narrow viewport the cloud is silently a
 * subset. That is fine for a picture and unacceptable for a figure, which is
 * the second reason the table exists, and why the omission is stated rather
 * than hidden.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Layout inputs that must keep a stable identity.
 *
 * `useWordcloud` lists every accessor in its effect's dependency array, so a
 * function or array rebuilt each render re-runs the whole layout on every
 * keystroke elsewhere on the page — and, because `random` seeds each word's
 * start position, re-runs it to a DIFFERENT arrangement. Module scope for the
 * constants, `useMemo` for the words, and a fixed `random` so the cloud stays
 * put while the rest of the page changes.
 */
const CLOUD_FONT = 'Georgia, serif';
const CLOUD_WEIGHT = 600;
const CLOUD_PADDING = 3;
const FIXED_RANDOM = () => 0.5;

/**
 * No rotation, deliberately.
 *
 * The rotated words in a stock word cloud are the ones nobody reads, and a
 * vertical label fails the same "can this be read at a glance" test the rest of
 * the design system is held to. Horizontal costs some packing density.
 */
const NO_ROTATION = 0;

const MIN_FONT_PX = 13;
const MAX_FONT_PX = 56;

/** `d3-cloud` reads the pre-computed size off the datum, so this stays stable. */
const fontSizeOf = (datum: CloudDatum) => datum.size;

interface CloudDatum {
  /** `BaseDatum.text` — what `d3-cloud` measures and what we key the lookup on. */
  text: string;
  size: number;
}

/**
 * Ink for one word, from the sequential ramp.
 *
 * Magnitude is one hue light→dark (never a rainbow), but the light end of
 * `SEQUENTIAL_BLUE` is a FILL colour: `#CFE0EF` and `#A7C6E2` sit near 1.3:1 and
 * 1.8:1 on white, and this ramp is being used on TEXT. Shifting the domain so
 * `weight` (which is `frequency / topFrequency`, always in `(0, 1]`) lands in
 * the top third of the ramp keeps every word at or above roughly 5:1 while
 * still stepping light→dark with frequency. Size carries the magnitude
 * precisely; the shade is the redundant encoding, so losing its bottom half
 * costs nothing.
 */
function wordInk(weight: number): string {
  return sequentialStep(weight, -2, 1);
}

export function TopicWordCloud({
  entries,
  selected,
  canSelectMore,
  onToggleTerm,
}: {
  entries: WordCloudEntry[];
  /** Terms currently plotted on the trend chart. */
  selected: readonly string[];
  /** False once every series slot on the trend chart is taken. */
  canSelectMore: boolean;
  onToggleTerm: (term: string) => void;
}) {
  const tableId = useId();
  const [showTable, setShowTable] = useState(false);
  /**
   * The hovered word, with the coordinates `d3-cloud` placed it at.
   *
   * Carrying the position in state rather than looking it up again is not an
   * optimisation: the layout runs asynchronously and drops words it cannot
   * place, so a lookup by term can miss for a word that is visibly on screen.
   */
  const [hovered, setHovered] = useState<{ term: string; x: number; y: number } | null>(null);

  /**
   * The measured node is held in STATE and the effect keys on it, rather than
   * a ref read once on mount.
   *
   * A mount-only effect never sees this container at all when the FIRST
   * payload has an empty `wordCloud` — a subsidiary with no corpus, a reader
   * holding no grants, a range nothing falls into. The early return below
   * renders `EmptyState` instead of the container, the effect runs once
   * against `null`, and the next payload — which does have terms —
   * re-renders the same component instance without re-running it. The observer
   * is then never attached, `width` stays 0, and the cloud is a skeleton for
   * good. A callback ref fires on the render the node actually appears in.
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  /**
   * `d3-cloud` needs pixel dimensions, not a percentage, so the container is
   * measured rather than styled. The height follows the width so the aspect
   * stays sane on a phone without a media query.
   */
  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver((observed) => {
      const box = observed[0]?.contentRect;
      if (box) setWidth(Math.round(box.width));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  const height = Math.min(420, Math.max(260, Math.round(width * 0.5)));

  const byTerm = useMemo(() => new Map(entries.map((entry) => [entry.term, entry])), [entries]);

  /**
   * Font size scales with the square root of `weight`, not with `weight`
   * itself: the reader compares glyph AREA, which grows as the square of the
   * point size, so a linear ramp exaggerates the top term by its own factor
   * again. `weight` comes off the API already normalised against the top term
   * (`topics.service.ts:182`) — do not recompute it from `frequency`.
   */
  const words = useMemo<CloudDatum[]>(
    () =>
      entries.map((entry) => ({
        text: entry.term,
        size: Math.round(MIN_FONT_PX + Math.sqrt(entry.weight) * (MAX_FONT_PX - MIN_FONT_PX)),
      })),
    [entries],
  );

  const laidOut = useWordcloud<CloudDatum>({
    width,
    height,
    words,
    font: CLOUD_FONT,
    fontWeight: CLOUD_WEIGHT,
    fontSize: fontSizeOf,
    padding: CLOUD_PADDING,
    rotate: NO_ROTATION,
    spiral: 'archimedean',
    random: FIXED_RANDOM,
  });

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No terms in this range"
        description="Nothing in the documents and questions you can see mentions a term often enough to chart."
      />
    );
  }

  const top = entries[0];
  const omitted = width > 0 && laidOut.length > 0 ? entries.length - laidOut.length : 0;
  const hoveredEntry = hovered === null ? undefined : byTerm.get(hovered.term);

  const summary = top
    ? `Word cloud of the ${entries.length} most frequent terms; larger, darker words occur more often. ` +
      `Most frequent: ${top.term}, ${top.frequency.toLocaleString('en-IN')} occurrences across ${top.sourceCount.toLocaleString('en-IN')} sources.`
    : 'Word cloud of the most frequent terms.';

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={setContainer}
        /*
          `role="img"` collapses the whole SVG to one node with one name, which
          is the honest description of it: the individual `<text>` elements are
          in packing order, carry no numbers, and would be read as a word salad.
          Everything an assistive-technology or keyboard user needs is in the
          table below, which is why its toggle is a real button.
        */
        role="img"
        aria-label={summary}
        className="relative overflow-hidden rounded-lg border border-border bg-surface"
        // A resolved height, not a `minHeight`: the loading Skeleton below is
        // `h-full`, and a percentage height against an auto-height parent
        // computes to auto, which collapses it to nothing.
        style={{ height }}
      >
        {width === 0 || laidOut.length === 0 ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <svg width={width} height={height} className="block">
            <g transform={`translate(${width / 2}, ${height / 2})`}>
              {laidOut.map((word) => {
                const term = word.text ?? '';
                const entry = byTerm.get(term);
                if (!entry) return null;
                const isSelected = selected.includes(term);
                return (
                  <text
                    key={term}
                    x={word.x ?? 0}
                    y={word.y ?? 0}
                    textAnchor="middle"
                    fontFamily={CLOUD_FONT}
                    fontSize={word.size ?? MIN_FONT_PX}
                    fontWeight={CLOUD_WEIGHT}
                    fill={wordInk(entry.weight)}
                    /*
                      Selection is marked with an underline, never with a colour
                      change: colour here already means frequency, and a second
                      meaning on the same channel makes both unreadable. Italic
                      or bold would also invalidate the measured metrics and
                      make the packed words overlap.
                    */
                    textDecoration={isSelected ? 'underline' : undefined}
                    style={{ cursor: canSelectMore || isSelected ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (canSelectMore || isSelected) onToggleTerm(term);
                    }}
                    onMouseEnter={() => setHovered({ term, x: word.x ?? 0, y: word.y ?? 0 })}
                    onMouseLeave={() =>
                      setHovered((current) => (current?.term === term ? null : current))
                    }
                  >
                    {term}
                  </text>
                );
              })}
            </g>
          </svg>
        )}

        {/* The hover readout. Pointer-events off so it never steals the click
            that adds the term to the trend chart. */}
        {hovered && hoveredEntry ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-sm"
            style={{
              // The `<g>` above is translated to the centre, so a word's own
              // coordinates are relative to it.
              left: width / 2 + hovered.x,
              top: height / 2 + hovered.y - 12,
            }}
          >
            <span className="font-medium text-text-default">{hoveredEntry.term}</span>
            <span className="ml-2 tabular-nums text-text-muted">
              {hoveredEntry.frequency.toLocaleString('en-IN')} in{' '}
              {hoveredEntry.sourceCount.toLocaleString('en-IN')} sources
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {omitted > 0
            ? `${omitted.toLocaleString('en-IN')} of ${entries.length.toLocaleString('en-IN')} terms did not fit the canvas — the table lists all of them.`
            : 'Select a word to plot it on the trend chart.'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowTable((current) => !current)}
          aria-expanded={showTable}
          aria-controls={tableId}
        >
          {showTable ? 'Hide the numbers' : 'Show the numbers'}
        </Button>
      </div>

      <div id={tableId} hidden={!showTable}>
        <TableFrame caption="Term frequency across the selected range">
          <THead>
            {/* A plain <tr>: `TR` paints `bg-surface` over the muted header ground. */}
            <tr>
              <TH>Term</TH>
              <TH numeric>Occurrences</TH>
              <TH numeric>Sources</TH>
              <TH numeric>Share of top term</TH>
              <TH>Trend chart</TH>
            </tr>
          </THead>
          <TBody>
            {entries.map((entry) => {
              const isSelected = selected.includes(entry.term);
              return (
                <TR key={entry.term}>
                  <TD className={cn(isSelected && 'font-medium')}>{entry.term}</TD>
                  <TD numeric>{entry.frequency.toLocaleString('en-IN')}</TD>
                  {/*
                    This is the TRUE distinct-source count, computed before the
                    25-source sampling cap (`topics.pipelines.ts:65`). The count
                    on a cluster is not the same number.
                  */}
                  <TD numeric>{entry.sourceCount.toLocaleString('en-IN')}</TD>
                  <TD numeric>{Math.round(entry.weight * 100)}%</TD>
                  <TD>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!isSelected && !canSelectMore}
                      onClick={() => onToggleTerm(entry.term)}
                    >
                      {isSelected ? 'Remove' : 'Plot'}
                      <span className="sr-only"> {entry.term}</span>
                    </Button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </TableFrame>
      </div>
    </div>
  );
}
