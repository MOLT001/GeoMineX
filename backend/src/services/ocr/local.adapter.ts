/**
 * The extraction provider — one entry point, five kinds of input.
 *
 * PS 26023 asks for report generation from "scanned PDFs, spreadsheets, and
 * archives", and this dispatches all of them plus the digital PDFs and text
 * files that were supported first:
 *
 *   digital PDF   the embedded text layer, read by geometry (see below)
 *   scanned PDF   rasterised, then OCR — `scanned.ts`
 *   image         OCR directly; there is nothing to rasterise
 *   .xlsx         the sheet grid, read as cells — `spreadsheet.ts`
 *   .zip          unpacked, each member re-entering here — `archive.ts`
 *
 * ─── ONE SHAPE, MANY WAYS IN ────────────────────────────────────────────────
 * Every path converges on `LayoutRow[]` and then on `harvestLayoutFields`, so
 * column clustering, period headers, statement sections, label cleaning and
 * duplicate handling are written ONCE and apply to a scan, a workbook and a
 * filing alike. Adding an input means producing that shape, never adding a
 * second extractor.
 *
 * ─── §11.7 IS RESOLVED, AND WHAT SURVIVED IT ────────────────────────────────
 * This file once opened "no data leaves this machine", because §11.7 — may
 * external providers process government documents? — was open and blocking. It
 * was resolved on 9 September 2026: they may. Google Cloud Vision is now the
 * primary OCR engine, with the offline engine kept as the automatic fallback.
 *
 * What that decision did NOT change: a figure recovered from PIXELS is still
 * capped below one parsed from a text layer, and one read by the weaker engine
 * below one read by the better. Permission to use a vendor is not evidence
 * about the reading — a misread digit in a tonnage is invisible downstream
 * whichever engine misread it, and only the source page settles it.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { logger } from '../../utils/logger.js';
import { ocrImage, ocrPdf, scaleForOcr, type OcrEngine } from './scanned.js';
import { readWorkbook } from './spreadsheet.js';
import { mimeForExtension, readArchive } from './archive.js';
import type { ExtractionInput, ExtractionResult, ExtractedFieldResult, OcrProvider } from './ocr.types.js';

const TEXT_LIKE = new Set(['text/plain', 'text/csv', 'application/csv']);

/** Uploads that ARE a page rather than containing one. See fileValidation.ts. */
const IMAGE_LIKE = new Set(['image/png', 'image/jpeg', 'image/tiff']);

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_MIME = 'application/zip';
const MAX_CHUNK_CHARS = 1_200;

/**
 * Ceiling on fields per document.
 *
 * A four-page results filing carries about fifty line items across two
 * statements, and each states four periods — so the honest figure count is
 * closer to two hundred. This is a runaway guard against a pathological
 * document, not a budget: truncating a real filing would silently drop the
 * consolidated statement, which always sorts last.
 */
const MAX_FIELDS = 600;

/**
 * The slice of pdf.js this file uses.
 *
 * Declared locally rather than imported: unpdf re-exports pdf.js's runtime but
 * its bundled typings move between releases, and the three properties below are
 * the stable part of the text-content API. `transform` is an affine matrix —
 * [0] is the horizontal scale (effectively the font size) and [4]/[5] are the x
 * and y of the run's origin.
 */
interface PdfTextRun {
  str?: string;
  width?: number;
  transform: number[];
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextRun[] }>;
}

/**
 * PRD §9.5: document text is untrusted input. Chunks are stored as data and
 * must never be concatenated into an instruction position in a prompt. This
 * strips control characters so extracted text cannot smuggle terminal escapes
 * or null bytes downstream.
 */
function sanitiseText(raw: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

/**
 * Chunk a scan from its reconstructed ROWS rather than the engine's raw text.
 *
 * ─── WHY THE RAW TEXT IS UNUSABLE FOR RETRIEVAL ─────────────────────────────
 * Tesseract emits a table one CELL per line, ordered by box rather than by
 * printed row. On a real CCL production report the stored passage read:
 *
 *     Particulars
 *     Quantity (Tonnes)
 *     1
 *     128,450
 *     | Coal Production
 *     2
 *     | Coal Dispatch
 *
 * — every figure separated from the label it belongs to. A keyword search for
 * "coal production" then retrieves a passage in which the number is three lines
 * away and unattributable, and the extractive answerer, which selects whole
 * sentences, had nothing to select but the report's title. That is exactly why
 * a question about grade-wise production came back quoting "MONTHLY PRODUCTION
 * & DISPATCH REPORT" and nothing else.
 *
 * The rows are already reconstructed for field extraction, so joining their
 * cells costs nothing and makes a table line read as it is printed:
 * `1  Coal Production  128,450`.
 */
function chunkRows(rows: LayoutRow[]): string[] {
  const lines = rows
    .map((r) => r.cells.map((c) => c.text).join('  ').trim())
    .filter((line) => line.length > 0);

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const line of lines) {
    if (length + line.length + 1 > MAX_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > MAX_CHUNK_CHARS && current) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Field grammar: `Label: value` or `Label = value` on its own line.
 *
 * Deliberately conservative. Anything it cannot parse confidently is left for
 * a human rather than guessed at.
 */
function harvestFields(text: string, pageOf: (index: number) => number | undefined): ExtractedFieldResult[] {
  const out: ExtractedFieldResult[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const m = /^\s*([A-Za-z][A-Za-z0-9 _/()%-]{1,48}?)\s*[:=]\s*(.{1,200}?)\s*$/.exec(line);
    if (!m) continue;

    const fieldName = m[1]!.trim();
    const value = m[2]!.trim();
    const key = fieldName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Numeric values are the ones a report actually cites, so they score
    // higher — but never high enough to imply a verified figure.
    const numeric = /^-?[\d,.]+\s*[A-Za-z%]{0,12}$/.test(value);

    out.push({
      fieldName,
      value,
      confidenceScore: numeric ? 0.82 : 0.6,
      sourceLocation: { pageNumber: pageOf(index), chunkIndex: 0 },
    });
  }
  return out.slice(0, MAX_FIELDS);
}

/**
 * ─── WHY A PDF IS READ BY GEOMETRY AND NOT BY LINES ─────────────────────────
 * `harvestFields` above reads a FLATTENED text layer, and on a real filing that
 * loses the two things that carry all the meaning.
 *
 * 1. COLUMNS COLLAPSE INTO ONE LINE. A signature block laid out as
 *
 *        Place : Hyderabad                       Challa Rajendra Prasad
 *        Date  : 05.08.2025                      Executive Chairman
 *
 *    flattens to `Place : Hyderabad Challa Rajendra Prasad`, and the grammar
 *    dutifully extracts the chairman's name as the place. There is no
 *    whitespace to split on — the gutter arrives as a SINGLE space — so no
 *    amount of cleverness on the string can recover it. The x coordinates can:
 *    those two runs sit at x=67 and x=556.
 *
 * 2. FINANCIAL TABLES HAVE NO COLONS, so the grammar could not see them at all.
 *    On a quarterly results filing that meant every figure a report would ever
 *    cite — revenue, profit before tax, EPS — was extracted as nothing, while
 *    the only fields harvested were the four in the signature block.
 *
 * pdf.js gives each run its own `transform`, so grouping runs by y rebuilds the
 * visual ROW and splitting on x gaps rebuilds the CELLS. That is the whole idea.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** One run of text with its position on the page. */
export interface PositionedRun {
  x: number;
  y: number;
  width: number;
  size: number;
  text: string;
}

/** A cell keeps its horizontal EXTENT, not just its origin — columns are matched by overlap. */
export interface LayoutCell {
  x: number;
  endX: number;
  text: string;
}

/** A visual row, already split into cells. */
export interface LayoutRow {
  page: number;
  cells: LayoutCell[];
}

/** The horizontal extent of one table column, unioned over its cells. */
export interface ColumnSpan {
  x: number;
  endX: number;
}

const overlaps = (a: ColumnSpan, b: ColumnSpan): boolean => a.x < b.endX && b.x < a.endX;

/**
 * Find the numeric columns on a page by clustering the extents of numeric cells.
 *
 * The `count` filter is not tidying — it is load-bearing. The serial-number
 * gutter ("8", "9") is numeric and forms its own cluster, so without a minimum
 * membership a results table reports five columns and every period label lands
 * one place to the left.
 */
export function detectNumericColumns(rows: LayoutRow[]): ColumnSpan[] {
  const dataRows = rows.filter((r) => r.cells.filter((c) => isNumericCell(c.text)).length >= 2);
  if (dataRows.length === 0) return [];

  const clusters: Array<ColumnSpan & { count: number }> = [];
  for (const row of dataRows) {
    // Everything left of the row LABEL is furniture, not data. A serial-number
    // gutter is a column of numbers like any other and would otherwise cluster
    // into a fifth period, pushing every header label one place out of step.
    const labelAt = row.cells.findIndex((c) => !isNumericCell(c.text));
    if (labelAt < 0) continue;
    for (const cell of row.cells.slice(labelAt + 1)) {
      if (!isNumericCell(cell.text)) continue;
      const hit = clusters.find((c) => overlaps(c, cell));
      if (hit) {
        hit.x = Math.min(hit.x, cell.x);
        hit.endX = Math.max(hit.endX, cell.endX);
        hit.count += 1;
      } else {
        clusters.push({ x: cell.x, endX: cell.endX, count: 1 });
      }
    }
  }

  const floor = Math.max(3, Math.ceil(dataRows.length * 0.25));
  return clusters
    .filter((c) => c.count >= floor)
    .sort((a, b) => a.x - b.x)
    .map(({ x, endX }) => ({ x, endX }));
}

/**
 * Recover each column's period label from the stacked header above the table.
 *
 * A results table heads its columns with several lines — "Quarter ended" /
 * "June 30,2025" / "Un Audited" — so a label is built by reading DOWN the rows
 * that sit above the first data row and align with exactly one column each.
 *
 * The alignment test does all the discrimination: a row is taken only when it
 * has exactly one item over each column and none straddling two. That accepts
 * the three header lines and rejects the company name, the CIN, the units note
 * ("Rs.in Lakhs" covers one column of four) and the spanning statement title.
 *
 * Returns `null` rather than a guess when the labels come out ambiguous — a
 * figure attributed to the wrong quarter is worse than one with no quarter.
 */
export function detectPeriodLabels(rows: LayoutRow[], columns: ColumnSpan[]): string[] | null {
  if (columns.length === 0) return null;
  const firstDataRow = rows.findIndex(
    (r) => r.cells.filter((c) => isNumericCell(c.text)).length >= 2,
  );
  if (firstDataRow <= 0) return null;

  const parts: string[][] = columns.map(() => []);
  for (const row of rows.slice(0, firstDataRow)) {
    const mapped: Array<{ column: number; text: string }> = [];
    let straddles = false;
    for (const cell of row.cells) {
      const hits = columns
        .map((col, i) => (overlaps(col, cell) ? i : -1))
        .filter((i) => i >= 0);
      if (hits.length > 1) { straddles = true; break; }
      if (hits.length === 1) mapped.push({ column: hits[0]!, text: cell.text });
    }
    if (straddles || mapped.length !== columns.length) continue;
    if (new Set(mapped.map((m) => m.column)).size !== columns.length) continue;
    for (const m of mapped) parts[m.column]!.push(m.text);
  }

  const labels = parts.map((p) => p.join(' ').trim());
  if (labels.some((l) => !l)) return null;
  // Two columns that read the same cannot both be cited, so abstain.
  if (new Set(labels).size !== labels.length) return null;
  return labels;
}

/**
 * Runs whose gap is under this multiple of the font size belong to one cell.
 *
 * Measured against a real filing: gaps WITHIN a cell are 0–7pt while the
 * narrowest gap BETWEEN columns is about 60pt, so the boundary is wide and the
 * exact multiple is not delicate. Scaling by font size rather than fixing a
 * constant keeps it right for a document set in a different body size.
 */
const CELL_GAP_FACTOR = 1.1;

/** Numbers as a filing writes them: Indian grouping, and `(1,234)` for negative. */
const NUMERIC_CELL = /^\(?-?\d[\d,]*(\.\d+)?\)?$/;

/** A nil marker. Present in the source, but not a figure anyone can cite. */
const NIL_CELL = /^[-–—]$/;

export function isNumericCell(text: string): boolean {
  return NUMERIC_CELL.test(text.replace(/\s+/g, ''));
}

/**
 * A figure as a TECHNICAL table prints it: a number that may carry its own unit.
 *
 * Deliberately separate from `isNumericCell` rather than a widening of it. That
 * predicate decides which cells make a FINANCIAL statement row, where every
 * figure is a bare number and admitting `62%` would change how a filing is
 * read. This one answers a different question — "is this cell a reading?" — for
 * the parameter tables an inspection or survey report is built from.
 */
const MEASURED_VALUE = /^\(?-?\d[\d,]*(\.\d+)?\)?\s*(%|°[CF]|[A-Za-z][A-Za-z/³²°.]{0,7})?$/;

export function isMeasuredValue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A bare year or serial is a number, not a reading — but it is still admitted
  // here, because the COLUMN it sits in is what decides, not the cell alone.
  return MEASURED_VALUE.test(t);
}

const hasLetters = (text: string): boolean => /[A-Za-z]/.test(text);

/** Column headers that name a reading, for the provenance of a parameter row. */
const VALUE_HEADER = /\b(value|observed|quantity|amount|figure|reading|result|qty)\b/i;

/**
 * Find the single VALUE column of a parameter table — §4.5.
 *
 * ─── WHY THE FINANCIAL DETECTOR CANNOT DO THIS ──────────────────────────────
 * `detectNumericColumns` requires a row to hold two or more numeric cells,
 * because a results statement prints the same measure across four period
 * columns. A technical report does not: its table is
 *
 *     S.No. | Parameter | Unit | Observed Value | Remarks
 *       1.  | Coal Production | tonnes | 48,600 | As per site records
 *
 * — ONE figure per row, flanked by text on both sides. Measured on a real
 * Department of Mines inspection report, the financial detector found no
 * columns at all and `harvestLayoutFields` extracted none of the six key
 * findings, while happily harvesting three prose bullets and a fragment of the
 * date as "fields".
 *
 * Clustering the readings by x recovers the column: six figures — 48,600, 62%,
 * 17,450, 126, 98%, 1,250 — land within the same 55px band while the serial
 * gutter forms a cluster of two and is rejected by the count floor.
 */
export function detectValueColumn(
  rows: LayoutRow[],
): { span: ColumnSpan; header?: string } | null {
  const clusters: Array<ColumnSpan & { count: number }> = [];

  for (const row of rows) {
    // Everything up to and including the label is furniture. Starting after it
    // is what keeps the serial-number gutter out of the running.
    const labelAt = row.cells.findIndex((c) => hasLetters(c.text) && !isMeasuredValue(c.text));
    if (labelAt < 0) continue;

    for (const cell of row.cells.slice(labelAt + 1)) {
      if (!isMeasuredValue(cell.text)) continue;
      const hit = clusters.find((c) => overlaps(c, cell));
      if (hit) {
        hit.x = Math.min(hit.x, cell.x);
        hit.endX = Math.max(hit.endX, cell.endX);
        hit.count += 1;
      } else {
        clusters.push({ x: cell.x, endX: cell.endX, count: 1 });
      }
    }
  }

  // Three aligned readings is the floor. Two is a coincidence between a serial
  // number and a page number; three in a column is a table.
  const best = clusters.sort((a, b) => b.count - a.count)[0];
  if (!best || best.count < 3) return null;

  const span: ColumnSpan = { x: best.x, endX: best.endX };

  /**
   * The column's own header, when the table prints one.
   *
   * Only a cell that overlaps the column AND reads like a heading for a
   * reading — `Observed Value`, `Quantity` — is accepted. Without that test a
   * figure from the row above would be adopted as the header of the column
   * below it, which would attach a confident-looking but invented provenance.
   */
  const header = rows
    .flatMap((row) => row.cells)
    .find((cell) => overlaps(span, cell) && VALUE_HEADER.test(cell.text) && hasLetters(cell.text));

  return header ? { span, header: header.text.trim() } : { span };
}

/**
 * Provisionally group runs onto baselines, given an assumed page skew.
 *
 * Shared by the estimator and the real grouping below, so the fragments the
 * angle is measured from are built by exactly the same rule as the rows it is
 * then used to build.
 */
function groupByBaseline(
  runs: PositionedRun[],
  slope: number,
): Array<{ y: number; runs: PositionedRun[] }> {
  /**
   * Left to right, so a row is always extended by the run that comes NEXT
   * along the line rather than by whichever run the OCR engine happened to
   * emit next. That ordering is what makes the local anchor below work.
   */
  const byX = [...runs].sort((a, b) => a.x - b.x);

  const rows: Array<{
    /** The baseline of this row's RIGHTMOST run so far — see below. */
    anchor: number;
    sum: number;
    runs: PositionedRun[];
  }> = [];

  for (const run of byX) {
    // The baseline this run would have had on a square page.
    const baseline = run.y - slope * run.x;
    const tolerance = Math.max(2, run.size * 0.5);

    /**
     * Match against the row's most recent run, and take the CLOSEST row rather
     * than the first one within tolerance.
     *
     * Both halves matter, and both were found by measurement. A sheet of paper
     * photographed on a desk is not flat — it bows — so a printed line is a
     * shallow CURVE, not a straight one even after the page rotation is taken
     * out. Comparing every run against the baseline the line started at
     * therefore drops the far end of a wide row: on the inspection report that
     * split `Coal Production (till date) | tonnes | 48,600 | As per site
     * records` between two rows at the point where the accumulated bow passed
     * the tolerance. Comparing against the nearest preceding run instead means
     * the row only ever has to track its own local gradient, which a bow of a
     * few pixels per hundred never exceeds.
     *
     * Closest-rather-than-first is the guard that buys back the safety: with a
     * looser tolerance two lines can both be candidates, and taking whichever
     * was created first would assign the run by accident of construction order.
     */
    let best: (typeof rows)[number] | undefined;
    let bestDistance = Infinity;
    for (const row of rows) {
      const distance = Math.abs(row.anchor - baseline);
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }

    if (best) {
      best.runs.push(run);
      best.sum += baseline;
      best.anchor = baseline;
    } else {
      rows.push({ anchor: baseline, sum: baseline, runs: [run] });
    }
  }

  return rows
    // Sorted on the row's MEAN baseline, not its anchor: the anchor has walked
    // along with the curve and no longer says where the row sits on the page.
    .map((r) => ({ y: r.sum / r.runs.length, runs: r.runs }))
    .sort((a, b) => b.y - a.y); // top of the page first
}

/**
 * The widest page rotation this will correct, as rise over run.
 *
 * 0.03 is about 1.7 degrees — comfortably more than a page photographed on a
 * desk, and deliberately less than the angle at which a correction could shift
 * one text line onto the baseline of the next. That ceiling is what stops the
 * search below from "winning" by collapsing the page into a few fat rows.
 */
const MAX_SKEW = 0.03;

/**
 * How sharply the text lines stack up at an assumed skew.
 *
 * The classic projection profile: deskew every run's baseline by the candidate
 * angle, drop it in a histogram bin, and sum the squares of the bin counts. At
 * the true angle a line's runs all land in the same one or two bins and the sum
 * is large; at any other angle they smear across many bins and it falls away.
 * Squaring is what makes a tall narrow peak beat a broad low one.
 */
function profileScore(runs: PositionedRun[], slope: number, binSize: number): number {
  const bins = new Map<number, number>();
  for (const run of runs) {
    const bin = Math.round((run.y - slope * run.x) / binSize);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let score = 0;
  for (const count of bins.values()) score += count * count;
  return score;
}

/**
 * Estimate the page's skew, in rise over run.
 *
 * ─── WHY A PHOTOGRAPHED PAGE NEEDS THIS ─────────────────────────────────────
 * A photograph of a page is never square to the sensor. On a real inspection
 * report shot on a desk the text rises about one pixel for every sixty across —
 * invisible to a reader, and fatal to a grouper that compares raw baselines:
 * across a 900px table row the drift exceeds the tolerance, so ONE printed line
 * arrives as three "rows". Measured on that page, the table header
 * `S.No. | Parameter | Unit | Observed Value | Remarks` came out as four
 * separate rows and `Date: 16 April 2025` as two — which is where the
 * nonsensical `Date = 16` field came from.
 *
 * ─── TWO ESTIMATORS THAT DID NOT WORK, AND WHY ──────────────────────────────
 * Both were written, measured, and discarded; they are recorded so the third is
 * not "simplified" back into one of them.
 *
 * 1. MEDIAN ANGLE BETWEEN NEIGHBOURING RUNS returned exactly 0 on a page with a
 *    real 0.017 skew. Sorted by x across the whole page, a run's nearest
 *    neighbours belong to other lines as often as to its own; and a genuine
 *    same-line neighbour sits only a couple of character-widths away, where
 *    ±1px of box noise over a ~25px span is ±0.04 of slope — twenty times the
 *    signal. The sample had a median of 0 with quartiles at ±0.04: all noise.
 *
 * 2. FITTING ROW FRAGMENTS AND ITERATING measured 0.008 on the first pass —
 *    the fragments it fits were cut short by the very skew being measured — and
 *    then DIVERGED when refined, reaching 0.046 and splitting the page into
 *    more rows than it started with. Each over-correction merges lines that do
 *    not belong together, and a merged fragment has a large spurious slope that
 *    feeds the next round.
 *
 * The projection profile has neither failure mode: it is a direct search over a
 * bounded range, it reads every run on the page at once rather than local
 * pairs, and nothing about it compounds.
 */
export function estimateSkew(runs: PositionedRun[]): number {
  if (runs.length < 20) return 0;

  // Bins about a quarter of a line's height: fine enough to separate adjacent
  // lines, coarse enough that one line does not split across several bins.
  const sizes = runs.map((r) => r.size).sort((a, b) => a - b);
  const binSize = Math.max(2, sizes[Math.floor(sizes.length / 2)]! * 0.25);

  const search = (from: number, to: number, step: number): number => {
    let best = from;
    let bestScore = -1;
    for (let slope = from; slope <= to + step / 2; slope += step) {
      const score = profileScore(runs, slope, binSize);
      /**
       * Ties go to the SMALLER rotation.
       *
       * Angles that differ by less than a bin are indistinguishable to the
       * profile, so a square page scores identically across a small band and
       * first-wins would return whichever end of the sweep was scanned first.
       * The least rotation that explains the page is the right reading of it —
       * and on a digital PDF it is the zero that keeps this inert.
       */
      if (score > bestScore || (score === bestScore && Math.abs(slope) < Math.abs(best))) {
        bestScore = score;
        best = slope;
      }
    }
    return best;
  };

  // Coarse sweep, then a fine one around the winner — 31 + 21 groupings rather
  // than the 301 a single fine sweep would cost.
  const coarse = search(-MAX_SKEW, MAX_SKEW, 0.002);
  const slope = search(coarse - 0.002, coarse + 0.002, 0.0002);

  /**
   * Correct only a real skew. Below this a digital PDF — whose runs sit on
   * exact baselines — is left completely untouched, so the correction cannot
   * perturb the financial-filing path it was not written for.
   */
  return Math.abs(slope) > 0.002 ? slope : 0;
}

/** Rebuild one page's visual rows from positioned runs. */
async function layoutRowsOf(page: PdfPageLike, pageNumber: number): Promise<LayoutRow[]> {
  const content = await page.getTextContent();

  const runs: PositionedRun[] = [];
  for (const item of content.items) {
    // `getTextContent` also yields marked-content markers. They carry no
    // `str`, which is why it is optional on PdfTextRun.
    if (typeof item.str !== 'string' || !item.str.trim()) continue;

    // The affine matrix: [0] horizontal scale, [4] x, [5] y. Destructured with
    // a guard because `noUncheckedIndexedAccess` is on and a malformed run
    // should be skipped rather than crash an ingestion.
    const [scaleX, , , , originX, originY] = item.transform;
    if (scaleX === undefined || originX === undefined || originY === undefined) continue;

    const size = Math.abs(scaleX) || 8;
    runs.push({
      x: originX,
      y: originY,
      width: item.width ?? item.str.length * size * 0.5,
      size,
      text: item.str,
    });
  }

  return rowsFromRuns(runs, pageNumber);
}

/**
 * Group positioned runs into visual rows of cells.
 *
 * Factored out because it is the ONE piece both input paths share. A digital
 * PDF supplies runs from its text layer; a scan supplies them from OCR word
 * boxes. Everything downstream — column clustering, period headers, statement
 * sections, label cleaning — then works on scanned documents unchanged, which
 * is what makes OCR an input adapter rather than a second extractor.
 *
 * Runs must arrive with y INCREASING UPWARD, as PDF user space has it. The OCR
 * path negates image coordinates before calling this, because image y grows
 * downward and the `b.y - a.y` sort below would otherwise read the page bottom
 * to top.
 */
/**
 * A printed table RULE, which OCR reports as a character.
 *
 * A vertical rule comes back as `|`, `I`, `[` or `l` in a box many times taller
 * than it is wide — nothing in real type has that aspect. Left in, each one is
 * a run whose `size` is a whole row height, which distorts both the grouping
 * tolerance and the skew profile measured from it, and whose text turns a label
 * into `| Coal Dispatch`.
 *
 * The aspect test is what makes this safe: a genuine capital `I` in a word is
 * roughly twice as tall as wide, nowhere near the threshold here.
 */
function isTableRule(run: PositionedRun): boolean {
  if (!/^[|Il!¦[\]{}]$/.test(run.text.trim())) return false;
  return run.width > 0 && run.size / run.width >= 3;
}

export function rowsFromRuns(runs: PositionedRun[], pageNumber: number): LayoutRow[] {
  /**
   * Group by DESKEWED baseline, so a photographed line stays one row however
   * far it drifts across the page. On a digital PDF the slope is 0 and this is
   * the plain baseline comparison it has always been.
   */
  const printed = runs.filter((run) => !isTableRule(run));
  const rows = groupByBaseline(printed, estimateSkew(printed));

  return rows
    .map(({ runs: rowRuns }) => {
      rowRuns.sort((a, b) => a.x - b.x);
      const cells: Array<{ x: number; endX: number; text: string }> = [];
      for (const run of rowRuns) {
        const last = cells[cells.length - 1];
        if (last && run.x - last.endX <= Math.max(6, run.size * CELL_GAP_FACTOR)) {
          /**
           * A visible gap between two runs was a SPACE, and it has to be put
           * back. pdf.js often hands over a whole phrase in one run, so this
           * rarely fires on a digital page — but OCR reports one box per WORD
           * and never includes the space between them, which turned
           * `Production Tonnes` into `ProductionTonnes` and, worse, hid the
           * colon in `Subsidiary : BCCL` so the field was never harvested.
           *
           * The threshold is well under the cell break above, so runs that
           * genuinely abut mid-word still join seamlessly.
           */
          const gap = run.x - last.endX;
          last.text += (gap > run.size * 0.15 ? ' ' : '') + run.text;
          last.endX = run.x + run.width;
        } else {
          cells.push({ x: run.x, endX: run.x + run.width, text: run.text });
        }
      }
      return {
        page: pageNumber,
        cells: cells
          .map((c) => ({
            x: c.x,
            endX: c.endX,
            /**
             * A rule that survived the aspect test — because OCR merged it into
             * a neighbouring word's box — still has to come off the text, or
             * the field is named `| Coal Dispatch`. Only the unambiguous rule
             * glyphs are stripped: taking `I` or `l` off the front of a cell
             * would eat the first letter of a real word.
             */
            text: c.text
              .trim()
              .replace(/^[|¦[\]]+\s*/, '')
              .replace(/\s*[|¦[\]]+$/, '')
              .trim(),
          }))
          .filter((c) => c.text),
      };
    })
    .filter((r) => r.cells.length > 0);
}

/**
 * Strip the ordinal and bullet furniture a filing puts in front of a label.
 *
 * `8Paid-up Equity Share Capital` is not a typo in the source — the serial
 * number sits in its own column close enough to merge into the label, so the
 * digit has to come off here.
 */
export function cleanLabel(raw: string): string {
  // Looped, because a filing stacks markers: `b) (i) Items that will be ...`
  // carries two, and a single pass would leave the inner one behind.
  let label = raw.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = label;
    label = label
      .replace(/^\s*\d{1,2}(?=[A-Za-z(])/, '')       // `8Paid-up` — serial ran into the label
      .replace(/^\s*\d{1,2}[\s.)]+/, '')             // `3 Profit before tax`
      .replace(/^\s*\(?[a-z]{1,3}[).]\s*/i, '')      // `a)` and `(ii)` alike
      .replace(/^\s*[-–—•]\s*/, '')  // `- Income Tax`
      .trim();
    if (label === before) break;
  }
  return label;
}

/**
 * Which statement a row belongs to.
 *
 * A results filing carries the SAME row labels twice — once standalone, once
 * consolidated — with different figures. Without this, deduplication by label
 * silently keeps whichever came first and throws the other away, which is the
 * traceability failure §4.5 exists to prevent.
 *
 * The spelling test is deliberately anchored on STANDALONE. The filing this was
 * built against spells the other heading `Conosolidated`, and a discriminator
 * looking for `cons` quietly filed every consolidated figure under standalone.
 */
const STATEMENT_HEADING = /^\s*(standalone|cono?solidated)\b[^.]*\bresults\b/i;

export function harvestLayoutFields(rows: LayoutRow[]): ExtractedFieldResult[] {
  const out: ExtractedFieldResult[] = [];
  const seen = new Set<string>();
  let section: string | undefined;
  let group: string | undefined;
  /** The last table figure emitted — the parent of any breakdown that follows. */
  let lastFigureName: string | undefined;

  const push = (
    fieldName: string,
    value: string,
    page: number,
    confidence: number,
    period?: string,
    scoped = true,
    /**
     * Which column the figure came from. Only used to keep the columns APART
     * when the period could not be read — without it every column of a row
     * hashes to the same key and all but the first are dropped as duplicates,
     * which is exactly what happened on a scan whose stacked header OCR'd into
     * one cell.
     */
    column = 0,
  ) => {
    if (!fieldName || !value) return;

    // Document metadata (`Registered Office`, `DIN`) is the same fact wherever
    // it is restated, so it dedupes on the NAME alone and appears once. A table
    // figure dedupes on the SECTION too, because the consolidated statement
    // repeats every standalone label with a different number and dropping one
    // as a duplicate would silently publish the wrong figure.
    // The PERIOD is part of the identity of a table figure: the same label in the
    // same statement legitimately holds four different numbers, one per column.
    // Leaving it out of the key kept only the first and silently dropped the
    // comparatives — which are most of the table.
    const key = scoped
      ? `${section ?? ''}|${period ?? `col${column}`}|${fieldName.toLowerCase()}`
      : `meta|${fieldName.toLowerCase()}`;
    if (seen.has(key)) {
      // A label repeated INSIDE one statement is a breakdown of the figure
      // above it — `Owners of the company` appears under net profit, under
      // other comprehensive income and under total comprehensive income, with
      // three different values. Qualify by the block it belongs to rather than
      // discarding two of the three.
      if (!scoped || !group) return;
      const qualified = `${group} — ${fieldName}`;
      const retry = `${section ?? ''}|${period ?? ''}|${qualified.toLowerCase()}`;
      if (seen.has(retry)) return;
      seen.add(retry);
      fieldName = qualified;
    } else {
      seen.add(key);
    }

    // `section` is where a figure says WHICH statement and WHICH period it came
    // from. Without the period a table figure is not citable: the row it was
    // read from carries four of them, and a reader checking the source cannot
    // tell which number was meant.
    const provenance = [section, period].filter(Boolean).join(' · ') || undefined;

    out.push({
      fieldName,
      value,
      confidenceScore: confidence,
      sourceLocation: { pageNumber: page, section: provenance, chunkIndex: 0 },
    });
  };

  // Column geometry is per PAGE: the standalone and consolidated tables in one
  // filing are set at different sizes and different x positions, so anything
  // derived once for the document would be wrong for half of it.
  const pageMeta = new Map<number, string[] | null>();
  /**
   * The parameter-table geometry, computed only where the FINANCIAL geometry
   * found nothing.
   *
   * That condition is the discriminator between the two table shapes, and it
   * keeps the two rules from ever competing for the same row: a results filing
   * has period columns and takes the all-numeric path exactly as before, while
   * a technical report has none and takes the value-column path below.
   */
  const pageValueColumn = new Map<number, { span: ColumnSpan; header?: string } | null>();

  for (const page of new Set(rows.map((r) => r.page))) {
    const pageRows = rows.filter((r) => r.page === page);
    const numericColumns = detectNumericColumns(pageRows);
    pageMeta.set(page, detectPeriodLabels(pageRows, numericColumns));
    pageValueColumn.set(page, numericColumns.length === 0 ? detectValueColumn(pageRows) : null);
  }

  for (const row of rows) {
    const joined = row.cells.map((c) => c.text).join(' ');

    const heading = STATEMENT_HEADING.exec(joined);
    if (heading) {
      section = /^standalone$/i.test(heading[1]!) ? 'Standalone' : 'Consolidated';
      group = undefined;
      continue;
    }

    const [head] = row.cells;
    if (!head) continue;

    // `Label: value` is matched WITHIN a single cell, which is what makes the
    // column bleed impossible: `Challa Rajendra Prasad` is a different cell and
    // can never be swept into the value of `Place`.
    for (const [i, cell] of row.cells.entries()) {
      // A wide gutter can leave `Date` and `: 05.08.2025` as separate cells, so
      // a cell whose neighbour opens with the separator is tried joined. Only
      // the immediate neighbour, and only when it starts with `:` or `=`, so
      // this cannot reach across a column the way the flat grammar did.
      const next = row.cells[i + 1];
      const candidate =
        !/[:=]/.test(cell.text) && next && /^\s*[:=]/.test(next.text)
          ? `${cell.text} ${next.text}`
          : cell.text;
      /**
       * A label may end in a full stop — `Inspection No. : MPI/2025/0417` is a
       * real line on a real form, and without the trailing `\.?` the whole
       * field was dropped. It is ONLY allowed at the end, so a label can still
       * never swallow a sentence that happens to precede a colon.
       */
      const m = /^\s*([A-Za-z][A-Za-z0-9 _/()%-]{1,48}?\.?)\s*[:=]\s*(.{1,200}?)\s*$/.exec(candidate);
      if (!m) continue;
      const value = m[2]!.trim();
      /**
       * A SENTENCE is prose, not a field value.
       *
       * `Label: value` is the grammar of a cover block — `Place : Dhanbad`,
       * `Inspection No. : MPI/2025/0417` — but it is also the shape of an
       * ordinary bulleted sentence, and on a real inspection report it dutifully
       * harvested `Water quality = No significant contamination observed.` and
       * `Air quality = Within permissible limits.` as extracted figures.
       *
       * Ending in sentence punctuation AND containing a space is what separates
       * the two. A field value is a name, a number or a reference, and those do
       * not end in a stop — while `Dhanbad.`, where OCR added one, has no space
       * and is still kept.
       *
       * The comma matters as much as the full stop: OCR reads the final `.` of
       * `12 hectares covered under reclamation plan.` as a comma often enough
       * that testing only for a period let that whole bullet through as an
       * extracted figure.
       */
      if (/\s/.test(value) && /[.,;]$/.test(value)) continue;
      /**
       * A vertical bar is a column rule the OCR read as a character, never part
       * of a value — this page's letterhead prints
       * `Email: dgm@smrd.gov.in | Phone: 0326-2635487` as one line, and without
       * this the phone number is stored inside the email address.
       */
      const single = value.split(/\s\|\s/)[0]!.trim();
      if (!single) continue;
      // Unchanged from the line grammar: a figure outscores free text.
      push(m[1]!.trim(), single, row.page, isNumericCell(single) ? 0.82 : 0.6, undefined, false);
    }

    // A numbered row carrying no figures heads the rows beneath it.
    if (row.cells.length === 1 && !isNumericCell(head.text) && /^\s*\d{1,2}[\s.)]?\s*[A-Za-z]/.test(head.text)) {
      group = cleanLabel(head.text);
      continue;
    }

    // `Attributable to:` does not head a section — it splits the figure on the
    // row ABOVE it, so the block parent is the last figure emitted.
    if (row.cells.length === 1 && /:\s*$/.test(head.text) && lastFigureName) {
      group = lastFigureName;
      continue;
    }

    // A table row: a text label followed by aligned numeric cells. The label is
    // the first NON-numeric cell, so a row that opens with its serial number is
    // still read rather than skipped for having a numeric first cell.
    const labelAt = row.cells.findIndex((c) => !isNumericCell(c.text));
    const label = labelAt >= 0 ? row.cells[labelAt]! : undefined;
    const figures = labelAt >= 0 ? row.cells.slice(labelAt + 1) : [];
    /**
     * A label has to be a WORD. Without this, the smudge of a rubber stamp
     * OCR'd as `%` beside a stray `2` satisfied every other test and was
     * published as the extracted field `% = 2`.
     */
    const labelIsWord = label !== undefined && hasLetters(label.text) && label.text.trim().length >= 3;

    if (labelIsWord && figures.length > 0 && figures.every((c) => isNumericCell(c.text) || NIL_CELL.test(c.text))) {
      let name = cleanLabel(label.text);

      /**
       * Qualify only a label that says nothing on its own.
       *
       * `Basic` and `Diluted` are meaningless without `Earnings per share`, so
       * they take the group. `Revenue from Operations` is not — and prefixing it
       * to `Income — Revenue from Operations` actively HID it, because a reader
       * looking down an alphabetical list of figures now finds revenue filed
       * under I. The threshold is short on purpose: a label long enough to
       * describe itself keeps its own name.
       */
      if (group && /^\s*[([]?[a-z][)\].]/i.test(label.text) && name.length <= 10) {
        name = `${group} — ${name}`;
      }

      /**
       * EVERY period column, not just the reporting one.
       *
       * A results row states the same measure four times — this quarter, the
       * previous quarter, the same quarter last year, and the full year — and
       * the comparatives are the entire point of the statement. Keeping only the
       * first threw away three quarters of the table, so a reader could see
       * revenue for June 2025 but not that it rose from 43,159.80 a year before.
       *
       * Each column is emitted as its own figure carrying its own period, which
       * is what lets the document view pivot them back into the rows and columns
       * the filing actually prints.
       */
      const periods = pageMeta.get(row.page);
      figures.forEach((cell, columnIndex) => {
        // Nil is real in the statement but is not a figure anyone can cite, and
        // publishing "-" as an extracted value helps nobody.
        if (!/\d/.test(cell.text)) return;
        // A figure whose period could NOT be recovered still gets published, but
        // in the review band: the number was read confidently while the column
        // it belongs to is unknown, and that is what a human should settle.
        const period = periods?.[columnIndex];
        push(name, cell.text, row.page, period ? 0.82 : 0.6, period, true, columnIndex);
      });
      lastFigureName = name;
      continue;
    }

    /**
     * ── A PARAMETER TABLE ROW ────────────────────────────────────────────────
     * `Coal Production (till date) | tonnes | 48,600 | As per site records`.
     *
     * The rule above cannot read this, and deliberately so: it requires every
     * cell after the label to be a figure, which is true of a financial
     * statement and false of every technical table, where the reading is
     * flanked by its unit on one side and a remark on the other. Position is
     * what disambiguates them — the reading is the cell sitting in the column
     * that three or more other readings also sit in.
     */
    const valueColumn = pageValueColumn.get(row.page);
    if (!valueColumn) continue;

    const paramAt = row.cells.findIndex((c) => hasLetters(c.text) && !isMeasuredValue(c.text));
    if (paramAt < 0) continue;

    const after = row.cells.slice(paramAt + 1);
    const reading = after.find((c) => isMeasuredValue(c.text) && overlaps(valueColumn.span, c));
    if (!reading) continue;

    const name = cleanLabel(row.cells[paramAt]!.text);
    // Same word test as above, and for the same reason.
    if (!hasLetters(name) || name.length < 3) continue;

    /**
     * The unit column, recorded as PROVENANCE rather than folded into the value.
     *
     * `48,600` and `tonnes` are printed in separate columns and they stay
     * separate here. Appending the unit to the value would put OCR's reading of
     * it inside a citable figure — and OCR renders `m³` as `m` and `m³/day` as
     * `m?/day` on this very page, so `17,450 m` would be a wrong unit embedded
     * in a right number. Alongside the figure in the provenance line it is
     * visible, checkable, and cannot be substituted into a report by mistake.
     */
    const unit = after.find(
      (c) => c.endX <= reading.x && !isMeasuredValue(c.text) && c.text.trim().length <= 12,
    );
    /**
     * ONE segment, never two — and the parentheses are load-bearing.
     *
     * ` · ` is a CONTRACT with the document view: it splits a provenance there
     * and reads the halves as statement and PERIOD, pivoting the figures into a
     * column per period. That is right for a results filing and catastrophic
     * here, because a parameter table's second half is a unit, not a period:
     * writing `Observed Value · tonnes` gave every row its own column and the
     * table rendered as a diagonal of single figures under headings reading
     * `tonnes`, `nos.` and `%`.
     *
     * Kept to one segment, these fields fall through to the flat list instead —
     * which is exactly how the source document prints them.
     */
    const unitText = unit?.text.trim();
    const provenance =
      valueColumn.header && unitText
        ? `${valueColumn.header} (${unitText})`
        : (valueColumn.header ?? unitText);

    // A trailing comma or stop is OCR furniture on the end of a figure, not
    // part of it: this page reads `126` as `126,`.
    const figure = reading.text.trim().replace(/[.,]$/, '');

    push(name, figure, row.page, 0.82, provenance, true, 0);
    lastFigureName = name;
  }

  return out.slice(0, MAX_FIELDS);
}

function buildResult(text: string, pageOf: (index: number) => number | undefined): ExtractionResult {
  const clean = sanitiseText(text);
  if (!clean) return { chunks: [], fields: [], ocrConfidence: 0 };

  const chunks = chunkText(clean).map((t, i) => ({ text: t, chunkIndex: i }));
  const fields = harvestFields(clean, pageOf);

  const ocrConfidence =
    fields.length > 0 ? fields.reduce((a, f) => a + f.confidenceScore, 0) / fields.length : 0.5;

  return { chunks, fields, ocrConfidence };
}

/** Extract the embedded text layer from a digital PDF. */
async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text: pages } = await extractText(pdf, { mergePages: false });

  const pageTexts = Array.isArray(pages) ? pages : [pages];
  const joined = pageTexts.join('\n\n');

  /**
   * No text layer means the pages are pixels — a scan. PS 26023 names scanned
   * PDFs as its first input, so this hands off to OCR rather than giving up.
   *
   * Only when the layer is EMPTY: a PDF that can be parsed always is, because
   * a text layer is what the author typed while OCR is a machine's reading of a
   * photograph. The digital path is never second-guessed.
   */
  if (!joined.trim()) return await extractScannedPdf(buffer, pdf.numPages);

  // Map a line index back to the page it came from, so extracted figures carry
  // a page number for traceability (§8.1).
  const lineToPage: number[] = [];
  pageTexts.forEach((pageText, pageIndex) => {
    const lineCount = String(pageText).split(/\r?\n/).length;
    for (let i = 0; i < lineCount; i += 1) lineToPage.push(pageIndex + 1);
  });

  const result = buildResult(joined, (index) => lineToPage[index]);

  // Chunks carry their page number too.
  let cursor = 0;
  const chunksWithPages = result.chunks.map((c) => {
    const page = lineToPage[cursor] ?? 1;
    cursor += c.text.split(/\r?\n/).length;
    return { ...c, pageNumber: page };
  });

  /**
   * Fields come from the GEOMETRY; chunks keep coming from the flattened text.
   *
   * That split is deliberate. Chunks feed AI retrieval and the `$text` index,
   * both of which already work, and rewriting the text every chunk is built
   * from would put a working retrieval path at risk to fix an extraction bug.
   * Field harvesting is the part that needed the layout, so it is the only part
   * that got it.
   *
   * Page numbers improve as a side effect: a layout row knows which page it was
   * read from, where the line-index mapping above could only estimate.
   */
  const rows: LayoutRow[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = (await pdf.getPage(pageNumber)) as unknown as PdfPageLike;
    rows.push(...(await layoutRowsOf(page, pageNumber)));
  }
  const fields = harvestLayoutFields(rows);

  // A digital PDF whose geometry yields nothing falls back to the line grammar
  // rather than reporting no fields at all.
  const chosen = fields.length > 0 ? fields : result.fields;
  const ocrConfidence =
    chosen.length > 0 ? chosen.reduce((a, f) => a + f.confidenceScore, 0) / chosen.length : 0.5;

  return { chunks: chunksWithPages, fields: chosen, ocrConfidence };
}

/**
 * Turn OCR output into an extraction result.
 *
 * Shared by both scanned paths so a scanned PDF and a photographed page are
 * treated identically once the pixels have become rows.
 */
function resultFromOcr(
  rows: LayoutRow[],
  text: string,
  confidence: number,
  engine: OcrEngine,
  note?: string,
): ExtractionResult {
  /**
   * From the ROWS. `text` is still accepted and still sanitised, because it is
   * the fallback for a page whose layout produced nothing — but any page that
   * reconstructed into rows is chunked from those, so a retrieved passage
   * carries a readable table line rather than a column of orphaned cells.
   */
  const laidOut = chunkRows(rows);
  const chunks = (laidOut.length > 0 ? laidOut : chunkText(sanitiseText(text))).map((t, i) => ({
    text: t,
    chunkIndex: i,
  }));

  /**
   * The SAME harvester the digital path uses. Column clustering, period
   * headers, statement sections and label cleaning all apply to a scan without
   * a line of special-casing — which is the whole reason the row shape is
   * shared.
   */
  const fields = harvestLayoutFields(rows).map((field) => ({
    ...field,
    confidenceScore: scaleForOcr(field.confidenceScore, confidence, engine),
  }));

  if (note) logger.info(`ocr: ${note}`);

  /**
   * Document confidence is Tesseract's reading confidence, capped the same way
   * a field is. It sits under OCR_REVIEW_THRESHOLD by construction, so a
   * scanned document always arrives flagged for a human — which is the honest
   * position for figures recovered from pixels.
   */
  return {
    chunks,
    fields,
    ocrConfidence: fields.length > 0 ? scaleForOcr(1, confidence, engine) : 0,
  };
}

/** A PDF whose pages carry no text layer. */
async function extractScannedPdf(buffer: Buffer, pageCount: number): Promise<ExtractionResult> {
  const ocr = await ocrPdf(buffer, pageCount);
  if (ocr.rows.length === 0) return { chunks: [], fields: [], ocrConfidence: 0 };
  return resultFromOcr(
    ocr.rows,
    ocr.text,
    ocr.confidence,
    ocr.engine,
    ocr.pagesSkipped > 0 ? `${ocr.pagesSkipped} page(s) beyond the OCR limit were not read` : undefined,
  );
}

/** A photographed or scanned page uploaded as an image. */
async function extractScannedImage(buffer: Buffer): Promise<ExtractionResult> {
  const page = await ocrImage(buffer, 1);
  if (page.rows.length === 0) return { chunks: [], fields: [], ocrConfidence: 0 };
  const withPage = page.rows.map((row) => ({ ...row, page: 1 }));
  return resultFromOcr(withPage, page.text, page.confidence, page.engine);
}

/**
 * A workbook. Each sheet becomes a page, and its name is carried into the
 * provenance so a figure says which sheet it was read from.
 */
function extractWorkbook(buffer: Buffer): ExtractionResult {
  const sheets = readWorkbook(buffer);
  if (sheets.length === 0) return { chunks: [], fields: [], ocrConfidence: 0 };

  const rows = sheets.flatMap((sheet) => sheet.rows);
  const fields = harvestLayoutFields(rows).map((field) => {
    const sheet = sheets[(field.sourceLocation?.pageNumber ?? 1) - 1];
    if (!sheet || sheets.length === 1) return field;
    // Several sheets in one file: say which, the way a PDF says which page.
    const existing = field.sourceLocation?.section;
    return {
      ...field,
      sourceLocation: {
        ...field.sourceLocation,
        section: existing ? `${sheet.sheetName} · ${existing}` : sheet.sheetName,
      },
    };
  });

  /**
   * Chunks come from the cell text, so `$text` search and AI retrieval see a
   * workbook the same way they see a page. Cells are tab-joined and rows
   * newline-joined, which keeps a row readable as a row in a citation quote.
   */
  const text = sheets
    .map((sheet) => {
      const body = sheet.rows
        .map((row) => row.cells.map((cell) => cell.text).join('\t'))
        .join('\n');
      return `${sheet.sheetName}\n${body}`;
    })
    .join('\n\n');

  const clean = sanitiseText(text);
  const chunks = chunkText(clean).map((t, i) => ({ text: t, chunkIndex: i }));

  const ocrConfidence =
    fields.length > 0 ? fields.reduce((a, f) => a + f.confidenceScore, 0) / fields.length : 0.5;
  return { chunks, fields, ocrConfidence };
}

/**
 * An archive: read each member with the provider itself, then merge.
 *
 * Recursion through `extractOne` is what keeps this small — a scanned PDF
 * inside a zip goes through OCR, a workbook through the sheet reader, with no
 * duplicated dispatch. `readArchive` refuses nested archives, so the recursion
 * is one level deep by construction and cannot be driven into a loop.
 */
async function extractArchive(buffer: Buffer): Promise<ExtractionResult> {
  const { members, skipped } = readArchive(buffer);
  if (skipped.length > 0) logger.info('archive: skipped members', { skipped: skipped.slice(0, 10) });
  if (members.length === 0) return { chunks: [], fields: [], ocrConfidence: 0 };

  const chunks: ExtractionResult['chunks'] = [];
  const fields: ExtractedFieldResult[] = [];
  const confidences: number[] = [];

  for (const member of members) {
    const mimeType = mimeForExtension(member.extension);
    if (!mimeType) continue;
    try {
      const result = await extractOne(member.buffer, mimeType);
      // Every figure records the member it came from. Without this an archive's
      // figures are indistinguishable from each other and the citation is lost.
      for (const field of result.fields) {
        const existing = field.sourceLocation?.section;
        fields.push({
          ...field,
          sourceLocation: {
            ...field.sourceLocation,
            section: existing ? `${member.name} · ${existing}` : member.name,
          },
        });
      }
      for (const chunk of result.chunks) {
        chunks.push({ ...chunk, chunkIndex: chunks.length, section: member.name });
      }
      if (result.fields.length > 0) confidences.push(result.ocrConfidence);
    } catch (error) {
      // One bad member must not lose the rest of the submission.
      logger.warn('archive: member could not be read', { member: member.name, error });
    }
  }

  return {
    chunks,
    fields: fields.slice(0, MAX_FIELDS),
    ocrConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
  };
}

/**
 * Dispatch one buffer by type. Extracted from the provider so an archive member
 * can re-enter the same logic without the provider calling itself.
 */
async function extractOne(buffer: Buffer, mimeType: string): Promise<ExtractionResult> {
  if (TEXT_LIKE.has(mimeType)) return buildResult(buffer.toString('utf8'), () => undefined);

  if (mimeType === 'application/pdf') {
    try {
      return await extractPdf(buffer);
    } catch {
      // A malformed or encrypted PDF is not a crash — it is a document this
      // provider cannot read, which is a review case.
      return { chunks: [], fields: [], ocrConfidence: 0 };
    }
  }

  if (IMAGE_LIKE.has(mimeType)) {
    try {
      return await extractScannedImage(buffer);
    } catch (error) {
      logger.warn('ocr: image could not be read', { error });
      return { chunks: [], fields: [], ocrConfidence: 0 };
    }
  }

  if (mimeType === XLSX_MIME) {
    try {
      return extractWorkbook(buffer);
    } catch (error) {
      logger.warn('spreadsheet: workbook could not be read', { error });
      return { chunks: [], fields: [], ocrConfidence: 0 };
    }
  }

  if (mimeType === ZIP_MIME) {
    try {
      return await extractArchive(buffer);
    } catch (error) {
      logger.warn('archive: could not be opened', { error });
      return { chunks: [], fields: [], ocrConfidence: 0 };
    }
  }

  return { chunks: [], fields: [], ocrConfidence: 0 };
}

export function createLocalOcrProvider(): OcrProvider {
  return {
    name: 'local',
    extract: ({ buffer, mimeType }: ExtractionInput) => extractOne(buffer, mimeType),
  };
}
