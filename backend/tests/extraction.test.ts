/**
 * Layout-aware PDF field extraction — PRD §4.1, §4.5, §8.1.
 *
 * Pure: no database, no network, no PDF. Every case here is built from
 * synthetic `LayoutRow`s so the ALGORITHM is under test rather than one
 * document, and so a regression is a fast red test instead of a slow one.
 *
 * ─── WHAT THIS FILE EXISTS TO PREVENT ───────────────────────────────────────
 * The extractor used to read a FLATTENED text layer with a single `Label: value`
 * grammar. On a real quarterly filing that produced four fields, all of them
 * wrong or useless, and missed every financial figure in the document:
 *
 *     Date  = "05.08.2025 Executive Chairman"     <- two columns, one line
 *     Place = "Hyderabad Challa Rajendra Prasad"  <- same
 *
 * while Revenue, Profit before tax and EPS — the figures a report actually
 * cites — were extracted as nothing at all, because a financial table is
 * aligned by whitespace and contains no colons.
 *
 * The cases below pin the four properties that fix depends on.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from 'vitest';
import {
  cleanLabel,
  detectNumericColumns,
  detectPeriodLabels,
  harvestLayoutFields,
  isNumericCell,
  rowsFromRuns,
  type LayoutRow,
  type PositionedRun,
} from '../src/services/ocr/local.adapter.js';
import { scaleForOcr } from '../src/services/ocr/scanned.js';
import { visionConfigured } from '../src/services/ocr/googleVision.js';

/** Build a row from `[x, endX, text]` triples — the shape `layoutRowsOf` produces. */
const row = (page: number, cells: Array<[number, number, string]>): LayoutRow => ({
  page,
  cells: cells.map(([x, endX, text]) => ({ x, endX, text })),
});

/**
 * A miniature of the real filing: a stacked three-line header over four period
 * columns, then data rows. Coordinates are taken from the measured document.
 */
const HEADER_ROWS: LayoutRow[] = [
  row(1, [
    [367, 419, 'Quarter ended'],
    [435, 487, 'Quarter ended'],
    [498, 550, 'Quarter ended'],
    [567, 608, 'Year ended'],
  ]),
  row(1, [
    [369, 417, 'June 30,2025'],
    [435, 487, 'March 31,2025'],
    [500, 547, 'June 30,2024'],
    [561, 613, 'March 31,2025'],
  ]),
  row(1, [
    [373, 414, 'Un Audited'],
    [447, 475, 'Audited'],
    [504, 544, 'Un Audited'],
    [573, 601, 'Audited'],
  ]),
];

const DATA_ROWS: LayoutRow[] = [
  row(1, [
    [90, 200, 'a) Revenue from Operations'],
    [390, 424, '53,481.08'],
    [456, 492, '44,789.98'],
    [516, 549, '43,159.80'],
    [576, 619, '1,71,799.71'],
  ]),
  row(1, [
    [90, 200, 'b) Other Income'],
    [401, 424, '274.91'],
    [467, 492, '790.26'],
    [526, 549, '251.31'],
    [587, 619, '1,391.19'],
  ]),
  row(1, [
    [83, 200, '3 Profit before tax (1-2)'],
    [394, 424, '5,147.88'],
    [460, 492, '2,974.85'],
    [520, 549, '4,195.04'],
    [583, 619, '13,045.32'],
  ]),
  row(1, [
    [90, 200, 'Changes in inventories'],
    [394, 424, '2,942.72'],
    [456, 492, '(2,916.88)'],
    [520, 549, '2,001.42'],
    [583, 619, '1,538.32'],
  ]),
];

describe('isNumericCell', () => {
  it('accepts the shapes an Indian filing actually writes', () => {
    // Lakh grouping is 2-digit above the thousand: a Western-only regex fails.
    expect(isNumericCell('1,71,799.71')).toBe(true);
    // Accounting negatives are bracketed, not signed.
    expect(isNumericCell('(2,916.88)')).toBe(true);
    expect(isNumericCell('53,481.08')).toBe(true);
    expect(isNumericCell('2.36')).toBe(true);
  });

  it('rejects labels', () => {
    expect(isNumericCell('Revenue from Operations')).toBe(false);
    expect(isNumericCell('Q1 FY2026-27')).toBe(false);
  });
});

describe('cleanLabel', () => {
  it('strips the ordinal that ran into the label', () => {
    // Not a typo in the source: the serial number sits close enough to merge.
    expect(cleanLabel('8Paid-up Equity Share Capital')).toBe('Paid-up Equity Share Capital');
  });

  it('strips stacked markers, not just the first', () => {
    // A single pass would leave `(i)` behind.
    expect(cleanLabel('b) (i) Items that will be reclassified')).toBe(
      'Items that will be reclassified',
    );
  });

  it('strips bullets and numbering', () => {
    expect(cleanLabel('- Income Tax')).toBe('Income Tax');
    expect(cleanLabel('3 Profit before tax (1-2)')).toBe('Profit before tax (1-2)');
    expect(cleanLabel('(a) Basic')).toBe('Basic');
  });
});

describe('detectNumericColumns', () => {
  it('finds one column per period', () => {
    expect(detectNumericColumns(DATA_ROWS)).toHaveLength(4);
  });

  it('ignores the serial-number gutter', () => {
    // The S-No column is numeric too. Without the membership floor it becomes a
    // fifth column and every period label lands one place to the left.
    const withSerials = DATA_ROWS.map((r, i) => ({
      ...r,
      cells: [{ x: 76, endX: 82, text: String(i + 1) }, ...r.cells],
    }));
    expect(detectNumericColumns(withSerials)).toHaveLength(4);
  });

  it('reports nothing for a page with no table', () => {
    expect(detectNumericColumns([row(2, [[67, 300, 'Place : Hyderabad']])])).toEqual([]);
  });
});

describe('detectPeriodLabels', () => {
  const rows = [...HEADER_ROWS, ...DATA_ROWS];
  const columns = detectNumericColumns(DATA_ROWS);

  it('reads a stacked header down into one label per column', () => {
    expect(detectPeriodLabels(rows, columns)).toEqual([
      'Quarter ended June 30,2025 Un Audited',
      'Quarter ended March 31,2025 Audited',
      'Quarter ended June 30,2024 Un Audited',
      'Year ended March 31,2025 Audited',
    ]);
  });

  it('rejects a row that spans two columns', () => {
    // The statement title straddles the first two columns; treating it as a
    // header line would smear the title across every period label.
    const withTitle = [
      row(1, [[228, 459, 'Standalone financial results for the quarter ended June 30, 2025']]),
      ...rows,
    ];
    expect(detectPeriodLabels(withTitle, columns)).toEqual(detectPeriodLabels(rows, columns));
  });

  it('rejects a units note that covers only one column', () => {
    const withUnits = [row(1, [[566, 609, 'Rs.in Lakhs']]), ...rows];
    expect(detectPeriodLabels(withUnits, columns)).toEqual(detectPeriodLabels(rows, columns));
  });

  it('abstains rather than guess when two columns read the same', () => {
    // A figure filed under the wrong quarter is worse than one with no quarter.
    const ambiguous = [
      row(1, [
        [369, 417, 'June 30,2025'],
        [435, 487, 'June 30,2025'],
        [500, 547, 'June 30,2024'],
        [561, 613, 'March 31,2025'],
      ]),
      ...DATA_ROWS,
    ];
    expect(detectPeriodLabels(ambiguous, columns)).toBeNull();
  });
});

describe('harvestLayoutFields', () => {
  it('reads table figures the colon grammar could never see', () => {
    const fields = harvestLayoutFields([...HEADER_ROWS, ...DATA_ROWS]);
    const revenue = fields.filter((f) => f.fieldName === 'Revenue from Operations');
    expect(revenue[0]?.value).toBe('53,481.08');
    expect(fields.find((f) => f.fieldName === 'Profit before tax (1-2)')?.value).toBe('5,147.88');
  });

  it('names the period, because a row carries four figures', () => {
    const fields = harvestLayoutFields([...HEADER_ROWS, ...DATA_ROWS]);
    const revenue = fields.find((f) => f.fieldName === 'Revenue from Operations');
    expect(revenue?.sourceLocation?.section).toContain('Quarter ended June 30,2025');
    expect(revenue?.confidenceScore).toBe(0.82);
  });

  it('drops to the review band when the period cannot be recovered', () => {
    // Data with no header above it: the number is read, the column is unknown.
    const fields = harvestLayoutFields(DATA_ROWS);
    const revenue = fields.find((f) => f.fieldName === 'Revenue from Operations');
    expect(revenue?.value).toBe('53,481.08');
    expect(revenue?.sourceLocation?.section).toBeUndefined();
    // At or below OCR_REVIEW_THRESHOLD (0.75) this is flagged for a human.
    expect(revenue?.confidenceScore).toBe(0.6);
  });

  it('keeps a column-neighbour out of a labelled value', () => {
    // THE ORIGINAL BUG. Two cells on one visual row; the grammar must match
    // inside a cell so the chairman's name cannot become the place.
    const fields = harvestLayoutFields([
      row(2, [
        [67, 200, 'Place : Hyderabad'],
        [556, 700, 'Challa Rajendra Prasad'],
      ]),
      row(2, [
        [67, 92, 'Date'],
        [93, 200, ': 05.08.2025'],
        [556, 700, 'Executive Chairman'],
      ]),
    ]);
    expect(fields.find((f) => f.fieldName === 'Place')?.value).toBe('Hyderabad');
    expect(fields.find((f) => f.fieldName === 'Date')?.value).toBe('05.08.2025');
  });

  it('keeps standalone and consolidated figures apart', () => {
    // Same labels, different numbers. Deduplicating on the label alone silently
    // publishes one statement's figure under the other's name.
    const fields = harvestLayoutFields([
      row(1, [[228, 459, 'Standalone financial results for the quarter ended June 30, 2025']]),
      ...DATA_ROWS,
      // The source really does misspell this heading.
      row(3, [[228, 459, 'Conosolidated financial results for the quarter ended June 30, 2025']]),
      row(3, [
        [90, 200, 'a) Revenue from Operations'],
        [390, 424, '1,05,563.89'],
        [456, 492, '83,584.76'],
        [516, 549, '77,329.36'],
        [576, 619, '3,10,574.99'],
      ]),
    ]);

    // Four columns per statement, so eight figures, cleanly split by statement.
    const revenues = fields.filter((f) => f.fieldName === 'Revenue from Operations');
    const byStatement = new Map<string, string[]>();
    for (const f of revenues) {
      const statement = f.sourceLocation?.section?.split(' · ')[0] ?? '(none)';
      byStatement.set(statement, [...(byStatement.get(statement) ?? []), f.value]);
    }
    expect([...byStatement.keys()].sort()).toEqual(['Consolidated', 'Standalone']);
    expect(byStatement.get('Standalone')?.[0]).toBe('53,481.08');
    expect(byStatement.get('Consolidated')?.[0]).toBe('1,05,563.89');
  });

  it('distinguishes a label repeated as a breakdown of three different figures', () => {
    // `Owners of the company` appears under net profit, under other
    // comprehensive income and under total comprehensive income, each with a
    // different value. Keying on the label alone keeps one and loses two.
    // One figure per row, so this case tests ONLY the breakdown disambiguation
    // and not its interaction with multi-column expansion.
    const block = (parent: string, value: string): LayoutRow[] => [
      row(3, [
        [143, 300, parent],
        [393, 424, value],
      ]),
      row(3, [[143, 220, 'Attributable to:']]),
      row(3, [
        [161, 300, 'Owners of the company'],
        [393, 424, value],
      ]),
    ];

    const fields = harvestLayoutFields([
      ...block('Net profit for the year', '7,244.86'),
      ...block('Other comprehensive income for the year', '961.88'),
      ...block('Total comprehensive income for the year', '8,206.74'),
    ]);

    const owners = fields.filter((f) => f.fieldName.includes('Owners of the company'));
    expect(owners).toHaveLength(3);
    expect(owners.map((f) => f.value).sort()).toEqual(['7,244.86', '8,206.74', '961.88']);
  });

  it('emits every period column, not just the reporting one', () => {
    // THE SECOND BUG. A results row states the same measure four times, and the
    // comparatives are the point of the statement — keeping only the first threw
    // away three quarters of the table.
    const fields = harvestLayoutFields([...HEADER_ROWS, ...DATA_ROWS]);
    const revenue = fields.filter((f) => f.fieldName === 'Revenue from Operations');

    expect(revenue.map((f) => f.value)).toEqual([
      '53,481.08',
      '44,789.98',
      '43,159.80',
      '1,71,799.71',
    ]);
    // Each carries its OWN period, which is what lets the view pivot them back
    // into the columns the filing prints.
    expect(revenue.map((f) => f.sourceLocation?.section)).toEqual([
      'Quarter ended June 30,2025 Un Audited',
      'Quarter ended March 31,2025 Audited',
      'Quarter ended June 30,2024 Un Audited',
      'Year ended March 31,2025 Audited',
    ]);
  });

  it('keeps a self-describing label unprefixed so it stays findable', () => {
    // `Income — Revenue from Operations` filed revenue under I in an
    // alphabetical list. Only a label that says nothing alone takes the group.
    const fields = harvestLayoutFields([...HEADER_ROWS, ...DATA_ROWS]);
    expect(fields.some((f) => f.fieldName === 'Revenue from Operations')).toBe(true);
    expect(fields.some((f) => f.fieldName.startsWith('Income —'))).toBe(false);
  });

  it('does not publish a nil marker as a figure', () => {
    const fields = harvestLayoutFields([
      row(3, [
        [161, 300, 'Non-controlling interest'],
        [408, 424, '-'],
        [466, 492, '-'],
      ]),
    ]);
    expect(fields).toHaveLength(0);
  });
});

/**
 * The scanned-document path — PS 26023 names "scanned PDFs" as its first input.
 *
 * OCR itself is not exercised here: it needs a rasteriser, a 5 MB language model
 * and about a second per page, none of which belong in a unit suite. What IS
 * pinned is the seam — the shape OCR must produce for the existing table logic
 * to work on it unchanged, and the three bugs that seam had.
 */
describe('OCR seam', () => {
  /** A word box as tesseract reports it, converted the way `ocrImage` does. */
  const word = (x0: number, x1: number, y0: number, y1: number, text: string): PositionedRun => ({
    x: x0,
    // The BASELINE, negated — see the note in scanned.ts.
    y: -y1,
    width: x1 - x0,
    size: Math.max(1, y1 - y0),
    text,
  });

  it('groups a line by its baseline, so a colon stays with its label', () => {
    // THE BUG. A colon has no ascender, so its box TOP sits far below the
    // capital beside it. Grouping on the top put `:` on a row of its own and
    // broke every `Label : value` line on a scan into three rows.
    const rows = rowsFromRuns(
      [
        word(48, 120, 100, 122, 'Subsidiary'),
        word(128, 131, 112, 122, ':'),
        word(140, 177, 100, 122, 'BCCL'),
      ],
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells.map((c) => c.text).join('')).toContain(':');
  });

  it('puts back the space a gap represents', () => {
    // OCR reports one box per WORD and never the space between them, which
    // produced `ProductionTonnes` and hid the colon above.
    const rows = rowsFromRuns(
      [word(55, 130, 100, 122, 'Production'), word(140, 190, 100, 122, 'Tonnes')],
      1,
    );
    expect(rows[0]!.cells[0]!.text).toBe('Production Tonnes');
  });

  it('does not inject a space into a run that genuinely abuts', () => {
    // A digital PDF can split mid-word; those runs touch, and a space there
    // would corrupt the label rather than repair it.
    const rows = rowsFromRuns(
      [word(55, 100, 100, 122, 'Strip'), word(100, 130, 100, 122, 'ping')],
      1,
    );
    expect(rows[0]!.cells[0]!.text).toBe('Stripping');
  });

  it('keeps every column when the period header cannot be read', () => {
    // A stacked header often OCRs into ONE cell, so no period is recoverable.
    // Keying only on (section, period, name) then hashed all three columns to
    // the same key and dropped two of them — a scan silently lost its
    // comparatives.
    const fields = harvestLayoutFields([
      row(1, [
        [55, 190, 'Production Tonnes'],
        [310, 379, '1,284,500'],
        [439, 507, '1,190,200'],
      ]),
    ]);
    expect(fields.map((f) => f.value)).toEqual(['1,284,500', '1,190,200']);
    // No period could be established, so both sit in the review band.
    expect(fields.every((f) => f.confidenceScore <= 0.75)).toBe(true);
  });
});

describe('scaleForOcr', () => {
  it('holds an OFFLINE-engine figure below the review threshold', () => {
    // OCR_REVIEW_THRESHOLD is 0.75. Tesseract never clears it: a misread digit
    // in a tonnage is invisible downstream, and the offline engine is not
    // accurate enough on a ruled form to be taken on trust.
    expect(scaleForOcr(0.82, 1, 'tesseract')).toBeLessThanOrEqual(0.75);
    expect(scaleForOcr(0.82, 0.93, 'tesseract')).toBeLessThanOrEqual(0.75);
  });

  it('defaults to the offline grading when no engine is named', () => {
    expect(scaleForOcr(0.82, 1)).toBe(scaleForOcr(0.82, 1, 'tesseract'));
  });

  it('lets a CLEAN Vision read clear the threshold, and a poor one not', () => {
    // §11.7 permits the external provider, and Vision reads well enough that
    // flagging every page for ever would make the flag meaningless. Page
    // quality decides instead — which is the whole point of grading by engine.
    expect(scaleForOcr(0.82, 0.98, 'vision')).toBeGreaterThan(0.75);
    expect(scaleForOcr(0.82, 0.6, 'vision')).toBeLessThanOrEqual(0.75);
  });

  it('still ranks a Vision read below a digital text layer', () => {
    // Permission to use a vendor is not evidence about the reading. A figure
    // from pixels never reaches the 0.82 a parsed text layer earns.
    expect(scaleForOcr(0.82, 1, 'vision')).toBeLessThan(0.82);
  });

  it('grades Vision above the offline engine on the same page', () => {
    expect(scaleForOcr(0.82, 0.95, 'vision')).toBeGreaterThan(scaleForOcr(0.82, 0.95, 'tesseract'));
  });

  it('lets a clean scan outrank a poor one', () => {
    expect(scaleForOcr(0.82, 0.95)).toBeGreaterThan(scaleForOcr(0.82, 0.5));
  });

  it('never raises a score the harvester already doubted', () => {
    expect(scaleForOcr(0.6, 1)).toBeLessThanOrEqual(0.6);
    expect(scaleForOcr(0.6, 1, 'vision')).toBeLessThanOrEqual(0.6);
  });

  it('is absent, not broken, when no credentials are configured', () => {
    // The fallback contract: unset credentials mean the offline engine runs,
    // never that scans stop being read.
    expect(visionConfigured()).toBe(false);
  });
});
