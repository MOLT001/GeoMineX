/**
 * Spreadsheet reading — PS 26023 names "spreadsheets" as a required input.
 *
 * `.xlsx` was already accepted by `fileValidation.ts` and already yielded zero
 * fields: the upload succeeded, the document reached `validated`, and the
 * figures table was empty. That is the worst shape of gap, because it looks
 * like a bug rather than an unsupported format.
 *
 * ─── WHY THIS PARSES THE FORMAT RATHER THAN IMPORTING A READER ──────────────
 * An `.xlsx` IS a zip of XML — the same zip this codebase must already open for
 * archives — so the only new capability needed is reading two well-defined
 * parts. The obvious library, `exceljs`, brings five transitive dependencies
 * and, measured at the time of writing, two moderate advisories through `uuid`;
 * `xlsx` on npm is the stale fork with its own history. Neither is worth adding
 * to a government-facing service to read a value out of a cell.
 *
 * What is deliberately NOT implemented: formulas (the cached `<v>` is read, the
 * formula is ignored), styles, dates as dates, merged-cell geometry, charts.
 * A figure in a return is a number in a cell, and that is what this reads.
 *
 * ─── IT IS AN INPUT ADAPTER, LIKE OCR ───────────────────────────────────────
 * A sheet is already a grid, so it needs no column clustering — but it still
 * produces the same `LayoutRow` shape, so `harvestLayoutFields` applies the
 * same label cleaning, numeric-column detection, period-header matching and
 * duplicate handling it applies to a PDF. Nothing downstream knows the figures
 * came from a spreadsheet.
 */
import { unzipSync } from 'fflate';
import type { LayoutRow } from './local.adapter.js';

/**
 * Synthetic geometry. A sheet has columns, not coordinates, so a column index
 * is projected onto an x range wide enough that `detectNumericColumns` sees the
 * same clean separation it sees in a PDF. The numbers are arbitrary; only their
 * ratio matters, and a gap this wide can never be mistaken for a word space.
 */
const COLUMN_PITCH = 100;
const COLUMN_WIDTH = 80;

/** Guards against a hostile or accidental workbook holding the worker for ever. */
const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 5_000;

export interface SheetRows {
  sheetName: string;
  rows: LayoutRow[];
}

/** XML entities that appear in shared strings and inline text. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Ampersand LAST, or `&amp;lt;` would decode twice into a bare `<`.
    .replace(/&amp;/g, '&');
}

/** Strip tags from a run of rich text, keeping the characters. */
function textOfXml(fragment: string): string {
  return decodeXml(fragment.replace(/<[^>]*>/g, ''));
}

/**
 * `sharedStrings.xml` — the string table almost every text cell points into.
 *
 * A string cell stores an INDEX, not a value, so without this every label in
 * the workbook reads as a number.
 */
function readSharedStrings(files: Record<string, Uint8Array>): string[] {
  const raw = files['xl/sharedStrings.xml'];
  if (!raw) return [];
  const xml = new TextDecoder().decode(raw);
  // `<si>` is one shared string; it may hold one `<t>` or several rich-text runs.
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOfXml(m[1] ?? ''));
}

/** `B7` -> 1. Spreadsheet columns are bijective base-26, so `Z`,`AA` must carry. */
function columnIndexOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1];
  if (!letters) return 0;
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** Sheet name and part path, in workbook order. */
function readSheetIndex(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const workbook = files['xl/workbook.xml'];
  const relsRaw = files['xl/_rels/workbook.xml.rels'];
  if (!workbook) return [];

  const rels = new Map<string, string>();
  if (relsRaw) {
    const relsXml = new TextDecoder().decode(relsRaw);
    for (const m of relsXml.matchAll(/<Relationship([^>]*)\/>/g)) {
      const attrs = m[1] ?? '';
      const id = /Id="([^"]+)"/.exec(attrs)?.[1];
      const target = /Target="([^"]+)"/.exec(attrs)?.[1];
      if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }

  const xml = new TextDecoder().decode(workbook);
  const sheets: Array<{ name: string; path: string }> = [];
  for (const m of xml.matchAll(/<sheet([^>]*)\/?>/g)) {
    const attrs = m[1] ?? '';
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    const target = rid ? rels.get(rid) : undefined;
    const path = `xl/${target ?? `worksheets/sheet${sheets.length + 1}.xml`}`;
    sheets.push({ name: decodeXml(name), path });
  }
  return sheets.slice(0, MAX_SHEETS);
}

/** One worksheet part into rows of cells. */
function readSheet(xml: string, sharedStrings: string[], pageNumber: number): LayoutRow[] {
  const rows: LayoutRow[] = [];

  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS_PER_SHEET) break;
    const body = rowMatch[1] ?? '';
    const cells: LayoutRow['cells'] = [];

    // A cell is `<c r="A1" t="s"><v>3</v></c>`, or self-closing when empty.
    for (const cellMatch of body.matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      // Declared without an initialiser: every branch below assigns, and a
      // placeholder would just be dead.
      let text: string;
      if (type === 's') {
        // Shared string: the value is an index into the table.
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        text = Number.isFinite(index) ? (sharedStrings[index] ?? '') : '';
      } else if (type === 'inlineStr') {
        text = textOfXml(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      } else {
        // Number, boolean, or a formula's CACHED result. The `<f>` is ignored
        // on purpose: this reads what the sheet SAYS, never what it computes.
        text = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '').trim();
      }

      text = text.trim();
      if (!text) continue;

      const column = ref ? columnIndexOf(ref) : cells.length;
      cells.push({
        x: column * COLUMN_PITCH,
        endX: column * COLUMN_PITCH + COLUMN_WIDTH,
        text,
      });
    }

    if (cells.length > 0) rows.push({ page: pageNumber, cells });
  }

  return rows;
}

/**
 * Read every sheet in a workbook.
 *
 * Each sheet becomes its own "page", so a figure's `sourceLocation.pageNumber`
 * points at the sheet it came from — the nearest honest equivalent of a page
 * reference in a file that has none.
 */
export function readWorkbook(buffer: Buffer): SheetRows[] {
  const files = unzipSync(new Uint8Array(buffer)) as unknown as Record<string, Uint8Array>;
  const sharedStrings = readSharedStrings(files);
  const index = readSheetIndex(files);

  // A workbook with no readable index is still worth trying by convention.
  const parts =
    index.length > 0
      ? index
      : Object.keys(files)
          .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
          .sort()
          .slice(0, MAX_SHEETS)
          .map((path, i) => ({ name: `Sheet${i + 1}`, path }));

  const out: SheetRows[] = [];
  parts.forEach(({ name, path }, i) => {
    const raw = files[path];
    if (!raw) return;
    const rows = readSheet(new TextDecoder().decode(raw), sharedStrings, i + 1);
    if (rows.length > 0) out.push({ sheetName: name, rows });
  });
  return out;
}
