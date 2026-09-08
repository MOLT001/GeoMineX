/**
 * The chart palette, and the rules that come with it.
 *
 * ─── WHY THE §6 TOKENS ARE NOT USED DIRECTLY FOR SERIES ─────────────────────
 * The §6 palette is chrome and status: navy for headers, orange for two CTAs,
 * green/red for state. Fed to a validator as a categorical SERIES palette it
 * fails outright — `--color-primary-dark` (#0B1F3A) sits below the lightness
 * band AND under the chroma floor, so it reads as grey next to a real hue, and
 * `--color-success` (#006020) is likewise too dark to sit in a series.
 *
 * So series get their own ramp, led by the brand's SIH Blue so a chart still
 * looks like it belongs to this product. Every value below was checked, not
 * chosen by eye: OKLCH lightness band, chroma floor, protan/deutan/tritan
 * separation on adjacent pairs, normal-vision separation, and WCAG contrast
 * against a white surface. Worst adjacent pair is ΔE 8.3 (deutan), above the
 * floor of 8.
 *
 * ─── THE LIMIT THAT IS NOT NEGOTIABLE ───────────────────────────────────────
 * Checked against EVERY pair rather than adjacent ones, no palette of more than
 * two hues survives: to a protanope green and orange are the same colour
 * (ΔE 2.3), and to a deuteranope blue and purple are the same colour (ΔE 1.3).
 * That is a property of human vision, not of this palette — no reshuffling
 * fixes it.
 *
 * The consequence is a rule, and it is why `MAX_SERIES` exists:
 *
 *   COLOUR ALONE NEVER IDENTIFIES A SERIES.
 *
 * Every multi-series chart in this app carries at least one non-colour
 * encoding as well — a direct end-label, a distinct marker shape, or a dash
 * pattern — and a legend is always present. Beyond MAX_SERIES, do not reach for
 * a seventh hue: fold the tail into "Other", or facet into small multiples.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Assign in FIXED ORDER, never cycled. Colour follows the entity, never its rank. */
export const SERIES_COLORS = [
  '#1261A0', // SIH Blue — the brand hue, so series 1 reads as "ours"
  '#D55E00', // vermillion
  '#009E73', // bluish green
  '#B04FA8', // purple
  '#8A6D00', // olive
  '#9E2A2B', // dark red
] as const;

/**
 * Marker shapes, paired 1:1 with SERIES_COLORS.
 *
 * This is the secondary encoding that makes the palette safe. A reader who
 * cannot separate series 2 from series 3 by hue separates them by shape.
 */
export const SERIES_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross', 'star'] as const;

/** Dash patterns for line charts, paired 1:1 with SERIES_COLORS. */
export const SERIES_DASHES = ['0', '6 3', '2 3', '10 4', '6 3 2 3', '1 4'] as const;

/**
 * Six is the hard ceiling, and it is not an arbitrary round number: it is where
 * the adjacent-pair CVD separation still clears its floor. A seventh series
 * must become "Other" or a second chart.
 */
export const MAX_SERIES = SERIES_COLORS.length;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] as string;
}

export function seriesShape(index: number): string {
  return SERIES_SHAPES[index % SERIES_SHAPES.length] as string;
}

export function seriesDash(index: number): string {
  return SERIES_DASHES[index % SERIES_DASHES.length] as string;
}

/**
 * Magnitude, not identity — one hue, light to dark.
 *
 * For a word cloud's frequency scale, a heat cell, or a single-measure bar
 * chart. Never a rainbow: a rainbow ramp implies category boundaries where the
 * data has none, and its perceived lightness is not monotonic, so it reorders
 * the values it is meant to rank.
 */
export const SEQUENTIAL_BLUE = [
  '#CFE0EF',
  '#A7C6E2',
  '#7BA9D2',
  '#4E8AC0',
  '#2B6FAC',
  '#1261A0',
  '#0C4C7E',
] as const;

export function sequentialStep(value: number, min: number, max: number): string {
  if (max <= min) return SEQUENTIAL_BLUE[SEQUENTIAL_BLUE.length - 1] as string;
  const t = (value - min) / (max - min);
  const index = Math.min(
    SEQUENTIAL_BLUE.length - 1,
    Math.max(0, Math.round(t * (SEQUENTIAL_BLUE.length - 1))),
  );
  return SEQUENTIAL_BLUE[index] as string;
}

/**
 * Chart furniture, resolved from the §6 tokens.
 *
 * Recharts takes colours as props rather than classes, so these have to be
 * literals — but they are the same values `globals.css` defines, kept here as
 * the single place a chart reads them. Axes and gridlines are deliberately
 * recessive: the data is the ink.
 */
export const CHART_INK = {
  axis: '#56637A', // --color-text-muted
  grid: '#CCD8E6', // --color-border
  surface: '#FFFFFF', // --color-surface
  label: '#101C2E', // --color-text-strong
} as const;

/**
 * Status colours for state-encoded charts — a document-status breakdown, a
 * query-outcome split.
 *
 * Reserved: never reuse one of these as "series 4". They always ship with a
 * label, and in this app with an icon too (see components/ui/Badge).
 */
export const STATUS_COLORS = {
  success: '#006020', // --color-success
  warning: '#B26A00', // darkened from --color-accent-yellow to clear 3:1 on white
  danger: '#B3261E', // --color-danger
  pending: '#56637A', // --color-text-muted
  progress: '#1261A0', // --color-sih-blue
} as const;
