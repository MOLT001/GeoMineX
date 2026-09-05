/**
 * Local extraction provider — no data leaves this machine.
 *
 * This is deliberately NOT OCR, and the distinction matters for PRD §11.7
 * ("are external providers permitted to process government documents?", marked
 * blocking for production):
 *
 *   - A **digital PDF** carries an embedded text layer. Reading it is parsing,
 *     done offline by a pure-JavaScript library. No third party sees the
 *     document, so §11.7 does not apply and this works today.
 *   - A **scanned PDF or image** is pixels. Recovering text needs real OCR,
 *     which is what §11.7 gates. Those still return zero confidence and are
 *     flagged for manual review rather than being given invented figures.
 *
 * So this provider does genuine work where it honestly can, and refuses to
 * guess where it cannot. A provider that fabricated plausible tonnages for a
 * scanned production report would be far more dangerous than one that admits
 * it could not read the file.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import type { ExtractionInput, ExtractionResult, ExtractedFieldResult, OcrProvider } from './ocr.types.js';

const TEXT_LIKE = new Set(['text/plain', 'text/csv', 'application/csv']);
const MAX_CHUNK_CHARS = 1_200;

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
  return out.slice(0, 100);
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

  // A scanned PDF has pages but no text layer. That is not a failure — it is
  // the honest answer that this provider cannot read it, and real OCR (§11.7)
  // is required.
  if (!joined.trim()) return { chunks: [], fields: [], ocrConfidence: 0 };

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

  return { ...result, chunks: chunksWithPages };
}

export function createLocalOcrProvider(): OcrProvider {
  return {
    name: 'local',

    async extract({ buffer, mimeType }: ExtractionInput): Promise<ExtractionResult> {
      if (TEXT_LIKE.has(mimeType)) {
        return buildResult(buffer.toString('utf8'), () => undefined);
      }

      if (mimeType === 'application/pdf') {
        try {
          return await extractPdf(buffer);
        } catch {
          // A malformed or encrypted PDF is not a crash — it is a document
          // this provider cannot read, which is a review case.
          return { chunks: [], fields: [], ocrConfidence: 0 };
        }
      }

      // Images, TIFF scans and spreadsheets need real OCR / a parser that
      // §11.7 and §11.2 have not yet authorised.
      return { chunks: [], fields: [], ocrConfidence: 0 };
    },
  };
}
