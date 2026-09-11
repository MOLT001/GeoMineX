import { strToU8, zipSync } from 'fflate';
import { describe, it, expect } from 'vitest';
import { mimeForExtension, readArchive } from '../src/services/ocr/archive.js';
import { readWorkbook } from '../src/services/ocr/spreadsheet.js';

/**
 * Spreadsheets and archives — the two inputs PS 26023 names that the pipeline
 * accepted and then read as nothing.
 *
 * Both are zips, so both are built here with the same library the readers use.
 * That keeps the fixtures honest: a hand-written byte blob would test a format
 * of my own invention rather than the one Excel writes.
 */

/** Minimal but REAL xlsx: content types, workbook, rels, shared strings, a sheet. */
function makeXlsx(sheetName = 'Q1 Production'): Buffer {
  const shared = ['Particulars', 'Q1 FY2026-27', 'Q1 FY2025-26', 'Production Tonnes', 'Subsidiary', 'BCCL'];
  const si =
    `<?xml version="1.0"?><sst count="${shared.length}">` +
    shared.map((t) => `<si><t>${t}</t></si>`).join('') +
    '</sst>';

  const s = (i: number) => `t="s"><v>${i}</v>`;
  const rows = [
    `<row r="1"><c r="A1" ${s(4)}</c><c r="B1" ${s(5)}</c></row>`,
    `<row r="3"><c r="A3" ${s(0)}</c><c r="B3" ${s(1)}</c><c r="C3" ${s(2)}</c></row>`,
    `<row r="4"><c r="A4" ${s(3)}</c><c r="B4"><v>1284500</v></c><c r="C4"><v>1190200</v></c></row>`,
  ].join('');

  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0"?><workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(si),
      'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`),
    }),
  );
}

describe('readWorkbook', () => {
  it('reads the sheet name and its rows', () => {
    const sheets = readWorkbook(makeXlsx());
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.sheetName).toBe('Q1 Production');
    expect(sheets[0]!.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('resolves shared strings, which is what makes labels readable', () => {
    // A text cell stores an INDEX into sharedStrings.xml, never the text. Miss
    // this and every label in the workbook reads as a small integer.
    const rows = readWorkbook(makeXlsx())[0]!.rows;
    const flat = rows.flatMap((r) => r.cells.map((c) => c.text));
    expect(flat).toContain('Production Tonnes');
    expect(flat).toContain('Q1 FY2026-27');
    expect(flat).not.toContain('3');
  });

  it('places a cell by its column reference, not its order', () => {
    // Excel omits empty cells entirely, so `A4,C4` must land in columns 0 and 2
    // — reading them as "first, second" would shift a figure under the wrong
    // period header.
    const xlsx = Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>',
        ),
      }),
    );
    const cells = readWorkbook(xlsx)[0]!.rows[0]!.cells;
    expect(cells.map((c) => c.text)).toEqual(['1', '3']);
    // Column 2 sits at twice the pitch of column 0, with column 1 left empty.
    expect(cells[1]!.x).toBe(cells[0]!.x + 200);
  });

  it('carries a column past Z', () => {
    // Columns are bijective base-26: AA is 26, not 0. Getting this wrong only
    // shows up on a wide return, which is exactly where it would go unnoticed.
    const xlsx = Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="AA1"><v>27</v></c></row></sheetData></worksheet>',
        ),
      }),
    );
    const cells = readWorkbook(xlsx)[0]!.rows[0]!.cells;
    expect(cells[1]!.x - cells[0]!.x).toBe(26 * 100);
  });

  it('decodes escaped text without double-decoding an ampersand', () => {
    const xlsx = Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        'xl/sharedStrings.xml': strToU8('<?xml version="1.0"?><sst><si><t>Coal &amp;amp; Coke</t></si></sst>'),
        'xl/worksheets/sheet1.xml': strToU8(
          '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
        ),
      }),
    );
    // `&amp;amp;` is an escaped `&amp;`. Decoding the ampersand first would
    // yield `&` and then wrongly decode again.
    expect(readWorkbook(xlsx)[0]!.rows[0]!.cells[0]!.text).toBe('Coal &amp; Coke');
  });
});

describe('readArchive', () => {
  const build = (entries: Record<string, string>) =>
    Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))));

  it('takes the members worth reading, in a stable order', () => {
    const { members } = readArchive(
      build({ 'b/second.txt': 'two', 'a/first.csv': 'one', 'notes.txt': 'three' }),
    );
    // Sorted, so the same archive always yields the same figures in the same
    // sequence rather than depending on zip ordering.
    expect(members.map((m) => m.name)).toEqual(['a/first.csv', 'b/second.txt', 'notes.txt']);
  });

  it('refuses to open a nested archive, and says so', () => {
    // A zip inside a zip is the cheapest way to multiply a bomb past any single
    // limit, so it is reported rather than silently ignored.
    const { members, skipped } = readArchive(build({ 'inner.zip': 'x', 'keep.txt': 'y' }));
    expect(members.map((m) => m.name)).toEqual(['keep.txt']);
    expect(skipped.join(' ')).toContain('nested archives are not opened');
  });

  it('reports an unsupported type instead of dropping it quietly', () => {
    const { members, skipped } = readArchive(build({ 'report.docx': 'x' }));
    expect(members).toHaveLength(0);
    expect(skipped.join(' ')).toContain('unsupported type');
  });

  it('rejects a path that tries to escape the archive', () => {
    // Nothing here writes a member to disk, so classic zip-slip does not apply —
    // but the NAME is stored on every figure as provenance, and a traversal
    // there is at best confusing and at worst a lure.
    const { members } = readArchive(
      build({ '../../etc/passwd': 'x', '/absolute.txt': 'y', 'safe.txt': 'z' }),
    );
    expect(members.map((m) => m.name)).toEqual(['safe.txt']);
  });

  it('drops macOS metadata without calling it a skipped document', () => {
    const { members, skipped } = readArchive(
      build({ '__MACOSX/._data.csv': 'junk', 'data.csv': 'real' }),
    );
    expect(members.map((m) => m.name)).toEqual(['data.csv']);
    // Not worth reporting: it is noise the zipper added, not something the user
    // chose to submit.
    expect(skipped.join(' ')).not.toContain('__MACOSX');
  });

  it('ignores directory entries', () => {
    const { members } = readArchive(build({ 'march/': '', 'march/data.csv': 'x' }));
    expect(members.map((m) => m.name)).toEqual(['march/data.csv']);
  });
});

describe('mimeForExtension', () => {
  it('maps every extension the archive reader admits', () => {
    for (const ext of ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.xlsx', '.csv', '.txt']) {
      expect(mimeForExtension(ext), ext).not.toBeNull();
    }
  });

  it('returns null for anything else, so a member is skipped rather than guessed', () => {
    expect(mimeForExtension('.docx')).toBeNull();
    expect(mimeForExtension('')).toBeNull();
  });
});
