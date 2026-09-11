import { describe, it, expect } from 'vitest';
import { pivotFields } from './pivot';
import type { ExtractedField } from './api';

/**
 * Putting a results table back into rows and columns.
 *
 * The extractor emits one row per FIGURE, so `Revenue from Operations` arrives
 * four times — once per period column. Rendered flat those four read as
 * duplicates and sort away from each other, which is what sent a reader looking
 * for revenue and finding a single number with three missing comparatives.
 */

let counter = 0;
const field = (
  fieldName: string,
  value: string,
  section?: string,
  extra: Partial<ExtractedField> = {},
): ExtractedField => ({
  id: `f${(counter += 1)}`,
  documentId: 'd1',
  fieldName,
  value,
  confidenceScore: 0.82,
  requiresReview: false,
  sourceLocation: section ? { pageNumber: 1, section, chunkIndex: 0 } : { chunkIndex: 0 },
  overriddenBy: null,
  overrideReason: null,
  overriddenAt: null,
  originalValue: null,
  ...extra,
});

const STANDALONE = 'Standalone · Quarter ended June 30,2025 Un Audited';
const STANDALONE_PREV = 'Standalone · Quarter ended March 31,2025 Audited';
const CONSOLIDATED = 'Consolidated · Quarter ended June 30,2025 Un Audited';

describe('pivotFields', () => {
  it('turns four figures for one measure into one row of four cells', () => {
    const { groups } = pivotFields([
      field('Revenue from Operations', '53,481.08', STANDALONE),
      field('Revenue from Operations', '44,789.98', STANDALONE_PREV),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.periods).toEqual([
      'Quarter ended June 30,2025 Un Audited',
      'Quarter ended March 31,2025 Audited',
    ]);
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.rows[0]!.cells.map((c) => c?.value)).toEqual(['53,481.08', '44,789.98']);
  });

  it('keeps each statement in its own table', () => {
    // Same label, different statement, different number. Merging them would
    // publish the consolidated figure under the standalone heading.
    const { groups } = pivotFields([
      field('Revenue from Operations', '53,481.08', STANDALONE),
      field('Revenue from Operations', '1,05,563.89', CONSOLIDATED),
    ]);

    expect(groups.map((g) => g.statement)).toEqual(['Standalone', 'Consolidated']);
    expect(groups[0]!.rows[0]!.cells[0]?.value).toBe('53,481.08');
    expect(groups[1]!.rows[0]!.cells[0]?.value).toBe('1,05,563.89');
  });

  it('follows the document order, not an alphabetical one', () => {
    // Reading order is the statement's own argument: revenue, then total income,
    // then expenses. Sorting scatters it.
    const { groups } = pivotFields([
      field('Revenue from Operations', '53,481.08', STANDALONE),
      field('Total Income', '53,755.99', STANDALONE),
      field('Cost of materials Consumed', '29,147.04', STANDALONE),
    ]);
    expect(groups[0]!.rows.map((r) => r.name)).toEqual([
      'Revenue from Operations',
      'Total Income',
      'Cost of materials Consumed',
    ]);
  });

  it('pads a row that predates a later column', () => {
    const { groups } = pivotFields([
      field('Revenue from Operations', '53,481.08', STANDALONE),
      field('Other Equity', '1,16,177.71', STANDALONE_PREV),
    ]);
    // Both rows must be as wide as the table, or the cells shift left and a
    // figure lands under the wrong period.
    for (const row of groups[0]!.rows) expect(row.cells).toHaveLength(2);
    expect(groups[0]!.rows[0]!.cells[1]).toBeUndefined();
    expect(groups[0]!.rows[1]!.cells[0]).toBeUndefined();
  });

  it('renders a gap-leading row positionally, not shifted left', () => {
    // THE SPARSE-ARRAY BUG. The filing prints `- | (75.06) | - | (75.06)`, so
    // this row's only figures belong to columns 2 and 4. Assigning cells[1] and
    // cells[3] leaves holes at 0 and 2, and `map` SKIPS holes — which rendered
    // two cells and slid March's figure under June.
    const { groups } = pivotFields([
      field('Revenue from Operations', '53,481.08', STANDALONE),
      field('Revenue from Operations', '44,789.98', STANDALONE_PREV),
      field('Items that will not be reclassified', '(75.06)', STANDALONE_PREV),
    ]);

    const row = groups[0]!.rows.find((r) => r.name === 'Items that will not be reclassified')!;
    expect(row.cells).toHaveLength(2);
    // The assertion that actually catches it: a hole would make map() emit one.
    expect(row.cells.map((c) => c?.value ?? null)).toEqual([null, '(75.06)']);
    expect(Object.keys(row.cells)).toHaveLength(2);
  });

  it('leaves metadata and unplaced figures out of the matrix', () => {
    // A signature-block DIN is not a table cell. Neither is a figure whose
    // period could not be established — filing it under a guessed column is the
    // exact failure the extractor abstains to avoid.
    const { groups, loose } = pivotFields([
      field('Revenue from Operations', '53,481.08', STANDALONE),
      field('DIN', '00702292', 'Standalone'),
      field('Production Tonnes', '1,284,500'),
    ]);

    expect(groups).toHaveLength(1);
    expect(loose.map((f) => f.fieldName)).toEqual(['DIN', 'Production Tonnes']);
  });

  it('keeps a human correction when a reprocess adds a machine row beside it', () => {
    const corrected = field('Revenue from Operations', '53,481.99', STANDALONE, {
      overriddenAt: '2026-09-09T00:00:00.000Z',
      originalValue: '53,481.08',
    });
    const machine = field('Revenue from Operations', '53,481.08', STANDALONE);

    const { groups, loose } = pivotFields([corrected, machine]);
    expect(groups[0]!.rows[0]!.cells[0]?.value).toBe('53,481.99');
    // The displaced duplicate is surfaced rather than dropped.
    expect(loose).toEqual([machine]);
  });

  it('returns no groups at all for a document with no periods', () => {
    // The CMPDI production return is `Label: value` throughout — it must keep
    // rendering as a flat list rather than as an empty matrix.
    const { groups, loose } = pivotFields([
      field('Production Tonnes', '1,284,500'),
      field('Grade', 'G8'),
    ]);
    expect(groups).toEqual([]);
    expect(loose).toHaveLength(2);
  });
});
