import type { ExtractedField } from './api';

/**
 * Put a results table back into the shape the filing prints it in.
 *
 * The extractor emits one row per FIGURE — `Revenue from Operations` appears
 * four times, once per period column — because that is what an extracted field
 * is: a single value with a single provenance and its own confidence, override
 * history and correction trail. Listing them flat is faithful and unreadable:
 * a reader looking for revenue finds four rows that look like duplicates, sorted
 * apart from each other, and cannot see that it rose from 43,159.80 a year ago.
 *
 * So the flat list is pivoted back for DISPLAY only. Nothing here changes a
 * value, merges two figures, or computes anything — every cell is exactly one
 * `ExtractedField`, and a cell with no field renders empty rather than zero.
 *
 * ─── THE PROVENANCE CONTRACT ────────────────────────────────────────────────
 * `sourceLocation.section` is written by the extractor (backend
 * services/ocr/local.adapter.ts) as one of:
 *
 *     "Standalone · Quarter ended June 30,2025 Un Audited"   statement + period
 *     "Standalone"                                            statement only
 *     undefined                                               neither
 *
 * Only the first form can be pivoted, because only it names a column. The other
 * two fall through to the flat list, which is the right outcome for both: a
 * signature-block date is not a table figure, and a figure whose period could
 * not be established must not be filed under a column that was guessed for it.
 * ────────────────────────────────────────────────────────────────────────────
 */

const SEPARATOR = ' · ';

export interface PivotRow {
  name: string;
  /** One entry per column, in `periods` order. `undefined` where the filing prints nothing. */
  cells: Array<ExtractedField | undefined>;
}

export interface PivotGroup {
  /** `Standalone`, `Consolidated`, … — the statement these columns belong to. */
  statement: string;
  /** Column headings, in the order the document prints them. */
  periods: string[];
  rows: PivotRow[];
}

export interface PivotResult {
  groups: PivotGroup[];
  /** Everything that does not belong in a column: metadata, and unplaced figures. */
  loose: ExtractedField[];
}

/**
 * Group fields into one table per statement.
 *
 * Row and column order both follow FIRST APPEARANCE, never a sort. The API
 * returns fields in extraction order, which is reading order down the page, so
 * this reproduces the document's own sequence — `Revenue` above `Total Income`
 * above `Expenses` — instead of an alphabetical list that scatters a statement.
 */
export function pivotFields(fields: readonly ExtractedField[]): PivotResult {
  const groups = new Map<string, PivotGroup>();
  const loose: ExtractedField[] = [];

  for (const field of fields) {
    const section = field.sourceLocation?.section;
    const at = section?.indexOf(SEPARATOR) ?? -1;
    if (!section || at < 0) {
      loose.push(field);
      continue;
    }

    const statement = section.slice(0, at);
    const period = section.slice(at + SEPARATOR.length);

    let group = groups.get(statement);
    if (!group) {
      group = { statement, periods: [], rows: [] };
      groups.set(statement, group);
    }

    let column = group.periods.indexOf(period);
    if (column < 0) {
      column = group.periods.length;
      group.periods.push(period);
    }

    let row = group.rows.find((r) => r.name === field.fieldName);
    if (!row) {
      row = { name: field.fieldName, cells: [] };
      group.rows.push(row);
    }

    // A reprocess can leave a corrected figure beside a fresh machine one for
    // the same name and period. Keep the FIRST — the API returns the corrected
    // row first — rather than letting a later machine value overwrite a human's.
    if (row.cells[column] === undefined) row.cells[column] = field;
    else loose.push(field);
  }

  /**
   * Rebuild every row as a DENSE array of exactly the table's width.
   *
   * Two things are wrong with the array as assembled. Late columns leave earlier
   * rows short — and, less obviously, `cells[3] = field` on an empty array
   * creates a SPARSE array whose earlier indices are holes rather than
   * `undefined`. `Array.prototype.map` skips holes, so rendering the row emitted
   * two cells instead of four and the figures slid LEFT into the wrong periods:
   * a `(75.06)` that belongs to March appeared under June. `Array.from` fills
   * every index, which is what makes the row render positionally.
   */
  for (const group of groups.values()) {
    for (const row of group.rows) {
      row.cells = Array.from({ length: group.periods.length }, (_, i) => row.cells[i]);
    }
  }

  return { groups: [...groups.values()], loose };
}
