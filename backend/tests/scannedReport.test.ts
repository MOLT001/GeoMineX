/**
 * Layout extraction from a PHOTOGRAPHED technical report — PRD §4.1, §4.5.
 *
 * `extraction.test.ts` covers the same extractor against a financial filing: a
 * DIGITAL PDF whose baselines are exact, whose table is four columns of bare
 * numbers, and whose only prose is a signature block. A Department of Mines
 * inspection report photographed on a desk is none of those things, and on the
 * real one the extractor produced five fields of which four were rubbish —
 *
 *     quality       = "No significant contamination observed."  <- a bullet
 *     Afforestation = "12 hectares covered under reclamation"   <- a bullet
 *     Date          = "16"                                      <- half a date
 *     Date: 16      = "2025"                                    <- the other half
 *
 * — while every one of the six figures the report exists to state (production,
 * grade, overburden, workers, safety compliance, water consumption) was
 * extracted as nothing at all.
 *
 * Three independent causes, one per describe block below. Pure and synthetic:
 * the coordinates are the ones measured off the real page, so the ALGORITHM is
 * under test rather than a 170 KB photograph and a second of OCR per run.
 */
import { describe, it, expect } from 'vitest';
import {
  detectNumericColumns,
  detectValueColumn,
  estimateSkew,
  harvestLayoutFields,
  isMeasuredValue,
  isNumericCell,
  rowsFromRuns,
  type LayoutRow,
  type PositionedRun,
} from '../src/services/ocr/local.adapter.js';

/** Build a row from `[x, endX, text]` triples — the shape `layoutRowsOf` produces. */
const row = (page: number, cells: Array<[number, number, string]>): LayoutRow => ({
  page,
  cells: cells.map(([x, endX, text]) => ({ x, endX, text })),
});

/** A word box as tesseract reports it, converted the way `ocrImage` does. */
const word = (x0: number, x1: number, y0: number, y1: number, text: string): PositionedRun => ({
  x: x0,
  // The BASELINE, negated — see the note in scanned.ts.
  y: -y1,
  width: x1 - x0,
  size: Math.max(1, y1 - y0),
  text,
});

// ── Cause 1: the page is not square to the camera ───────────────────────────

describe('page skew', () => {
  /** Six lines of eight words, rotated by `slope`, as a photograph would be. */
  const skewedPage = (slope: number): PositionedRun[] =>
    Array.from({ length: 6 }).flatMap((_line, lineIndex) =>
      Array.from({ length: 8 }).map((_w, i) => {
        const x = 100 + i * 110;
        const top = 100 + lineIndex * 40 - slope * x;
        return word(x, x + 90, top, top + 20, 'w' + String(lineIndex) + String(i));
      }),
    );

  it('measures a real rotation', () => {
    // 0.02 is the angle measured on the real inspection report.
    expect(estimateSkew(skewedPage(0.02))).toBeCloseTo(0.02, 2);
    expect(estimateSkew(skewedPage(-0.015))).toBeCloseTo(-0.015, 2);
  });

  it('leaves a square page alone', () => {
    // The guard that keeps every digital PDF on exactly the path it had before
    // deskewing existed. A text layer sits on exact baselines, so a fitted
    // angle could only move figures between rows that were already correct.
    expect(estimateSkew(skewedPage(0))).toBe(0);
  });

  it('keeps a rotated line in ONE row', () => {
    // THE BUG. Across eight words a 0.02 drift reaches 15px — three times the
    // grouping tolerance — so one printed line arrived as three rows. On the
    // real report that split the table header into four rows and
    // `Date: 16 April 2025` into two, which is where `Date = 16` came from.
    expect(rowsFromRuns(skewedPage(0.02), 1)).toHaveLength(6);
  });

  it('follows a bowed line, not just a straight one', () => {
    // A sheet lying on a desk is not flat. Once the rotation is taken out the
    // baseline is still a shallow CURVE, so a row has to be matched against its
    // own nearest run rather than against the baseline it started at.
    const bowed = Array.from({ length: 9 }).map((_w, i) => {
      const x = 100 + i * 110;
      // A 6px sag across the line: well under a line height, well over the
      // per-run tolerance.
      const top = 100 + 6 * Math.sin((i / 8) * Math.PI);
      return word(x, x + 90, top, top + 20, 'w' + String(i));
    });
    expect(rowsFromRuns(bowed, 1)).toHaveLength(1);
  });
});

// ── Cause 2: a technical table is not a financial table ─────────────────────

/**
 * The Key Findings table of the real report, at its measured coordinates:
 *
 *   S.No. | Parameter | Unit | Observed Value | Remarks
 */
const INSPECTION_ROWS: LayoutRow[] = [
  row(1, [
    [165, 218, 'S.No.'],
    [264, 344, 'Parameter'],
    [516, 549, 'Unit'],
    [602, 726, 'Observed Value'],
    [819, 890, 'Remarks'],
  ]),
  row(1, [
    [194, 198, '1'],
    [247, 439, 'Coal Production (till date)'],
    [509, 557, 'tonnes'],
    [636, 690, '48,600'],
    [763, 900, 'As per site records'],
  ]),
  row(1, [
    [191, 200, '2.'],
    [246, 354, 'Average Grade'],
    [526, 541, '%'],
    [646, 681, '62%'],
    [764, 936, 'Within approved range'],
  ]),
  row(1, [
    [191, 198, '3'],
    [246, 399, 'Overburden Removal'],
    [524, 538, 'm'],
    [640, 691, '17,450'],
    [765, 853, 'Satisfactory'],
  ]),
  row(1, [
    [245, 349, 'Total Workers'],
    [519, 545, 'nos.'],
    [652, 679, '126,'],
    [766, 963, 'As per attendance register'],
  ]),
  row(1, [
    [245, 380, 'Safety Compliance'],
    [527, 542, '%'],
    [647, 683, '98%'],
    [766, 917, 'No major violations'],
  ]),
  row(1, [
    [245, 389, 'Water Consumption'],
    [507, 562, 'm?/day'],
    [645, 687, '1,250'],
    [768, 859, 'Within limit'],
  ]),
];

describe('parameter tables', () => {
  it('treats a reading with its unit attached as a figure', () => {
    // `isNumericCell` must NOT accept these. It decides what makes a FINANCIAL
    // row, where every figure is a bare number, and widening it would change
    // how a filing is read.
    expect(isMeasuredValue('62%')).toBe(true);
    expect(isMeasuredValue('1,250')).toBe(true);
    expect(isNumericCell('62%')).toBe(false);

    // Not readings: a reference, a plan period, a remark.
    expect(isMeasuredValue('MPI/2025/0417')).toBe(false);
    expect(isMeasuredValue('2023-2028')).toBe(false);
    expect(isMeasuredValue('As per site records')).toBe(false);
  });

  it('finds the value column, which the financial detector cannot', () => {
    // `detectNumericColumns` needs TWO numeric cells in a row, because a
    // results statement prints the same measure across four period columns. A
    // technical table states one figure per row, so it finds nothing here — and
    // that is precisely the condition under which the value-column rule runs.
    expect(detectNumericColumns(INSPECTION_ROWS)).toHaveLength(0);

    const found = detectValueColumn(INSPECTION_ROWS);
    expect(found).not.toBeNull();
    expect(found?.header).toBe('Observed Value');
    // The serial-number gutter at x≈195 must not win it.
    expect(found!.span.x).toBeGreaterThan(600);
  });

  it('extracts every figure the report exists to state', () => {
    const byName = new Map(harvestLayoutFields(INSPECTION_ROWS).map((f) => [f.fieldName, f.value]));

    expect(byName.get('Coal Production (till date)')).toBe('48,600');
    expect(byName.get('Average Grade')).toBe('62%');
    expect(byName.get('Overburden Removal')).toBe('17,450');
    // OCR reads a trailing column rule as a comma; it is furniture, not a digit.
    expect(byName.get('Total Workers')).toBe('126');
    expect(byName.get('Safety Compliance')).toBe('98%');
    expect(byName.get('Water Consumption')).toBe('1,250');
  });

  it('records the unit as provenance rather than inside the figure', () => {
    // OCR renders `m³` as `m` and `m³/day` as `m?/day` on the real page, so
    // folding the unit into the value would embed a WRONG unit in a right
    // number — and a report could then substitute `17,450 m` for a volume.
    const production = harvestLayoutFields(INSPECTION_ROWS).find(
      (f) => f.fieldName === 'Coal Production (till date)',
    );
    expect(production?.value).toBe('48,600');
    expect(production?.sourceLocation?.section).toBe('Observed Value (tonnes)');
  });

  it('never writes the pivot separator into a parameter provenance', () => {
    /**
     * ` · ` is a CONTRACT with the document view: it splits a provenance
     * there and reads the halves as statement and PERIOD, then pivots the
     * figures into one column per period. A parameter table's second half is a
     * UNIT, so writing `Observed Value · tonnes` gave every row its own
     * column and the table rendered as a diagonal of single figures under
     * headings reading `tonnes`, `nos.` and `%`.
     */
    for (const field of harvestLayoutFields(INSPECTION_ROWS)) {
      expect(field.sourceLocation?.section ?? '').not.toContain(' · ');
    }
  });

  it('does not take the remark or the header as the figure', () => {
    const fields = harvestLayoutFields(INSPECTION_ROWS);
    for (const field of fields) {
      expect(field.value).not.toMatch(/Satisfactory|Within limit|attendance/);
    }
    // The header row states no reading, so it yields no figure.
    expect(fields.some((f) => f.fieldName === 'Parameter')).toBe(false);
  });

  it('leaves a financial statement on the path it already had', () => {
    /**
     * The guard is that a page with period columns never reaches the new rule.
     * Without it, a results row the all-numeric test rejects would be re-read by
     * the value-column rule and published with no period attached — which is
     * the §4.5 traceability failure the period key exists to prevent.
     */
    const statement: LayoutRow[] = [
      row(1, [
        [300, 420, 'Quarter ended'],
        [470, 590, 'Year ended'],
      ]),
      row(1, [
        [300, 420, 'June 30,2025'],
        [470, 590, 'March 31,2025'],
      ]),
      row(1, [
        [60, 250, 'Revenue from Operations'],
        [300, 420, '53,481.08'],
        [470, 590, '1,71,799.71'],
      ]),
      row(1, [
        [60, 250, 'Profit before tax'],
        [300, 420, '8,412.60'],
        [470, 590, '31,204.50'],
      ]),
      row(1, [
        [60, 250, 'Earnings per share'],
        [300, 420, '3.21'],
        [470, 590, '12.04'],
      ]),
    ];

    const fields = harvestLayoutFields(statement);
    // Both columns of all three rows, each carrying its own period.
    expect(fields).toHaveLength(6);
    for (const field of fields) {
      expect(field.sourceLocation?.section).toMatch(/ended/);
      expect(field.sourceLocation?.section).not.toContain('Observed Value');
    }
  });
});

// ── Cause 3: `Label: value` is also the shape of a sentence ─────────────────

describe('prose is not a field', () => {
  it('refuses a bulleted sentence', () => {
    // THE BUG. `Label: value` is the grammar of a cover block, and equally of
    // an ordinary sentence — so the Environmental Status bullets were harvested
    // as extracted figures and shown beside real ones with a confidence score.
    const fields = harvestLayoutFields([
      row(1, [[184, 467, 'Air quality: Within permissible limits.']]),
      row(1, [[184, 590, 'Water quality: No significant contamination observed.']]),
    ]);
    expect(fields).toHaveLength(0);
  });

  it('refuses a sentence whose full stop OCR read as a comma', () => {
    // This bullet reached the extracted-figures table on the real report,
    // because the guard tested only for a trailing period.
    const fields = harvestLayoutFields([
      row(1, [[294, 626, 'Afforestation: 12 hectares covered under reclamation plan,']]),
    ]);
    expect(fields).toHaveLength(0);
  });

  it('still reads a real cover block', () => {
    const byName = new Map(
      harvestLayoutFields([
        row(1, [
          [139, 264, 'Date of Inspection'],
          [308, 403, ': 16 April 2025'],
        ]),
        row(1, [[116, 233, 'Place: Dhanbad.']]),
        row(1, [
          [139, 238, 'Inspection No.'],
          [306, 413, ': MPI/2025/0417'],
        ]),
      ]).map((f) => [f.fieldName, f.value]),
    );

    // A single word carrying a full stop OCR added is a value, not a sentence:
    // the test is a trailing stop AND a space, and this has no space.
    expect(byName.get('Place')).toBe('Dhanbad.');
    expect(byName.get('Date of Inspection')).toBe('16 April 2025');
    expect(byName.get('Inspection No.')).toBe('MPI/2025/0417');
  });

  it('splits a value at a column rule read as a character', () => {
    const fields = harvestLayoutFields([
      row(1, [[377, 730, 'Email: dgm@smrd.gov.in | Phone: 0326-2635487']]),
    ]);
    expect(fields[0]?.value).toBe('dgm@smrd.gov.in');
  });

  it('refuses a label that is not a word', () => {
    // The smudge of a rubber stamp OCR'd as `%` beside a stray `2` satisfied
    // every other test and was published as the extracted field `% = 2`.
    const fields = harvestLayoutFields([
      row(1, [
        [625, 648, '%'],
        [866, 902, '2'],
      ]),
    ]);
    expect(fields).toHaveLength(0);
  });
});
