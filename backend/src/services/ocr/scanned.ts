/**
 * Optical character recognition for scanned pages — PS 26023, PRD §4.1.
 *
 * The problem statement names "scanned PDFs" as its FIRST input, so a document
 * whose pages are pixels has to yield figures like any other. Until this
 * existed, an image-only PDF reached `validated` with zero fields: not an error,
 * not a warning, just an empty table that looked like a bug.
 *
 * ─── THIS IS THE ENGINE IN USE ──────────────────────────────────────────────
 * `ocrImage` will try Google Cloud Vision first IF credentials are present
 * (`googleVision.ts`), but none are configured and none are planned: Vision
 * requires a billing account with a standing autopay mandate, which this
 * project will not take on for a demo. PRD §11.7 permits external providers —
 * the blocker is commercial, not regulatory — so that adapter is built, tested
 * and dormant, and everything below is what actually reads a scanned page.
 *
 * Being the only engine raises the stakes on accuracy. The measurements
 * recorded on PAGE_SEG_SPARSE_TEXT and RENDER_SCALE below are therefore not
 * incidental tuning; they are the difference between reading a table and
 * returning noise. Re-measure before changing either.
 *
 * ─── WHAT THIS MODULE IS NOT ────────────────────────────────────────────────
 * It is not a second extractor. It converts pixels into the SAME
 * `PositionedRun` shape the digital text layer produces, and hands them to
 * `rowsFromRuns`. Every downstream behaviour — numeric column clustering,
 * period-header matching, standalone/consolidated separation, label cleaning,
 * nil handling — is the code that already runs for digital PDFs. Table
 * reconstruction was the hard half and it was already built; this is only a new
 * way in.
 */
import { renderPageAsImage } from 'unpdf';
import { logger } from '../../utils/logger.js';
import { rowsFromRuns, type LayoutRow, type PositionedRun } from './local.adapter.js';
import { visionCeiling, visionConfigured, visionOcrImage } from './googleVision.js';

/**
 * Page-segmentation mode 11, "sparse text", and this is the single most
 * consequential setting in the file.
 *
 * Measured against a scanned production return with a bordered table. Tesseract
 * finds six of six target figures under SPARSE_TEXT and ZERO under the default
 * AUTO at the same scale — AUTO tries to infer a page layout, decides the ruled
 * table is a graphic, and returns the surrounding prose with the numbers
 * replaced by two characters of noise. Sparse mode makes no layout assumption
 * and simply reports the text it finds, which is precisely what a caller that
 * does its OWN geometry wants.
 */
const PAGE_SEG_SPARSE_TEXT = '11';

/**
 * Rasterisation scale. Measured on the same page: 2 and 3 both recover 6/6
 * figures at ~92% confidence, while 4 collapses to 1/6 — past a point the
 * upscaled artefacts of a compressed scan hurt more than the resolution helps.
 * 2 is chosen over 3 for being a third of the pixels at the same result.
 */
/**
 * How big a rasterised page should be, on its long edge, before OCR reads it.
 *
 * ─── WHY A TARGET AND NOT A MULTIPLIER ──────────────────────────────────────
 * This was a fixed `scale: 2` — two times whatever the PDF happened to declare
 * as its page size. That is not a resolution, it is a guess about one: the same
 * multiplier turns a phone photo wrapped in a letter-sized page into 1224px and
 * a 300 DPI office scan into 5000px, and Tesseract wants neither. Measured
 * across three real scanned filings, a fixed 2x read `62%` as `2%` and dropped
 * two whole table rows that came back correctly at 3x and 4x.
 *
 * 2400px on the long edge is about 300 DPI for A4 — the resolution OCR is
 * actually tuned for, reached from either direction.
 */
const TARGET_LONG_EDGE = 2400;

/**
 * Bounds on the multiplier, whatever the target implies.
 *
 * The floor keeps a page that already declares a huge point size from being
 * rendered BELOW its own text size; the ceiling stops a pathologically small
 * declared page from asking for a 30,000px bitmap and exhausting the worker.
 */
const MIN_RENDER_SCALE = 1.5;
const MAX_RENDER_SCALE = 6;

/** PNG dimensions, straight from the IHDR chunk — no decode needed. */
function pngDimensions(png: Buffer): { width: number; height: number } | null {
  // 8-byte signature, 4-byte length, 4-byte type, then width and height.
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * A page is only worth OCR-ing if it might carry figures, and OCR is SLOW —
 * seconds per page, on the same worker that processes every other upload. A
 * two-hundred page archive scan would otherwise hold the queue for an hour.
 * Pages past this are not read, and `pagesSkipped` says so rather than letting
 * the document look complete.
 */
const MAX_OCR_PAGES = 25;

/**
 * A figure read from PIXELS never scores above the review threshold.
 *
 * `OCR_REVIEW_THRESHOLD` defaults to 0.75, so this ceiling guarantees every
 * scanned figure arrives flagged for a human. That is not pessimism about
 * Tesseract; it is that a misread digit in a tonnage or a rupee figure is
 * invisible downstream — `1,284,500` and `1,234,500` are equally plausible, and
 * only the source page settles it. The digital path earns 0.82 because a text
 * layer is what the author typed; this path is a machine's reading of a
 * photograph, and §4.5 asks for a confidence that means something.
 */
const OCR_CONFIDENCE_CEILING = 0.7;

/** Words Tesseract is this unsure of are noise, and noise in a table is worse than a gap. */
const MIN_WORD_CONFIDENCE = 45;

/** Which engine read a page. The two are graded differently — see `scaleForOcr`. */
export type OcrEngine = 'vision' | 'tesseract';

export interface OcrPageResult {
  rows: LayoutRow[];
  text: string;
  /** Mean per-word confidence, 0..1, over the words that survived filtering. */
  confidence: number;
  engine: OcrEngine;
}

export interface OcrResult {
  rows: LayoutRow[];
  text: string;
  confidence: number;
  engine: OcrEngine;
  pagesRead: number;
  pagesSkipped: number;
}

/** Shape of the bits of tesseract.js this module uses. */
interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(
    image: Buffer,
    options?: unknown,
    output?: { blocks?: boolean; text?: boolean },
  ): Promise<{ data: { text: string; blocks?: unknown } }>;
  terminate(): Promise<unknown>;
}

/**
 * One worker, created on first use and kept.
 *
 * Starting a Tesseract worker costs a second or two and loads a 5 MB language
 * model, so doing it per document would dominate the cost of reading a
 * one-page scan. The document worker processes uploads one at a time, so a
 * single shared instance needs no pooling — but it DOES need the in-flight
 * promise below, or two uploads arriving together would each start one.
 */
let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(): Promise<TesseractWorker> {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const { createWorker } = await import('tesseract.js');
    /**
     * `cachePath` is set because tesseract.js otherwise writes `eng.traineddata`
     * into the process's working directory — which for this server is the repo
     * root, where a 5 MB binary promptly showed up as an untracked file.
     *
     * First use DOWNLOADS that model from a CDN. No document is sent anywhere;
     * it is the model coming in, not a page going out. But it is a network
     * dependency at cold start, so an air-gapped deployment must ship the file
     * in this directory ahead of time.
     */
    const worker = (await createWorker('eng', undefined, {
      cachePath: '.tesseract',
      logger: () => undefined,
    })) as unknown as TesseractWorker;

    await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEG_SPARSE_TEXT });
    return worker;
  })().catch((error: unknown) => {
    // Do not cache a failed start: the next upload should try again rather than
    // inherit a permanently rejected promise.
    workerPromise = null;
    throw error;
  });

  return workerPromise;
}

/** Release the worker. Called on shutdown; safe to call when none was started. */
export async function shutdownOcr(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    await (await pending).terminate();
  } catch {
    // A worker that will not stop must not block process shutdown.
  }
}

/** Pull the flat word list out of tesseract's nested block structure. */
function wordsOf(data: { blocks?: unknown }): TesseractWord[] {
  const words: TesseractWord[] = [];
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  for (const block of blocks as Array<{ paragraphs?: unknown }>) {
    for (const paragraph of (Array.isArray(block.paragraphs) ? block.paragraphs : []) as Array<{
      lines?: unknown;
    }>) {
      for (const line of (Array.isArray(paragraph.lines) ? paragraph.lines : []) as Array<{
        words?: unknown;
      }>) {
        for (const word of (Array.isArray(line.words) ? line.words : []) as TesseractWord[]) {
          if (typeof word?.text === 'string' && word.bbox) words.push(word);
        }
      }
    }
  }
  return words;
}

/**
 * Recognise one already-rasterised page — Vision first, Tesseract second.
 *
 * §11.7 permits an external provider, and Vision reads Indian government forms
 * and ruled tables materially better, so it goes first WHEN CONFIGURED. The
 * offline engine is kept as the automatic fallback rather than deleted: a
 * credential-less or air-gapped deployment must still read scans, and a
 * transient Vision failure should degrade rather than lose the document.
 *
 * `engine` travels with the result so the caller can grade confidence by which
 * engine actually read the page. The two ceilings differ, and attributing a
 * Tesseract read to Vision would overstate it.
 */
/**
 * Re-threshold a page that the engine's own binarisation could not read.
 *
 * ─── THE FAILURE THIS RECOVERS ──────────────────────────────────────────────
 * Tesseract binarises with Otsu, which assumes the histogram has two modes:
 * ink and paper. A PHOTOGRAPHED or edge-scanned page has a third — the near
 * black margin around the sheet — and it is large enough to move Otsu's split
 * up between "margin" and "paper", which puts the mid-grey TEXT on the paper
 * side of the line. The engine then reads a blank sheet.
 *
 * Measured on a real CCL production report: Tesseract returned ZERO characters
 * in every page-segmentation mode, and re-encoding the image, converting to
 * greyscale and auto-contrast all left it at zero — while a plain fixed
 * threshold recovered 908 characters and the whole table. The page was
 * perfectly legible to a human throughout.
 *
 * The threshold is taken from the paper itself rather than fixed: the modal
 * value of the BRIGHT half of the histogram is the sheet, and ink is whatever
 * sits well below it. That survives a darker or lighter scan, which a constant
 * would not.
 */
async function binariseForRetry(image: Buffer): Promise<Buffer | null> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(image);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const frame = ctx.getImageData(0, 0, img.width, img.height);
    const px = frame.data;

    // Histogram of luma, so the threshold comes from this page, not a constant.
    const histogram = new Array<number>(256).fill(0);
    for (let i = 0; i < px.length; i += 4) {
      const luma = (0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!) | 0;
      histogram[luma] = (histogram[luma] ?? 0) + 1;
    }

    /**
     * The paper is the MEDIAN, not the brightest mode.
     *
     * Most of a page is paper, so the median luma is the sheet — and it is
     * robust to both the dark margin and, crucially, to the pure-white canvas
     * the rasteriser leaves around the photograph. Taking the brightest mode
     * instead reported 255 on a real scan, which set the threshold 60 points
     * too high and blacked out the text the retry existed to recover.
     *
     * Ink is taken at 70% of paper. Measured on that page, a sweep found every
     * threshold from 120 to 150 recovered the full table and 190 recovered
     * almost nothing; the median rule lands on 123.
     */
    let counted = 0;
    let paper = 200;
    const half = px.length / 4 / 2;
    for (let v = 0; v < 256; v += 1) {
      counted += histogram[v] ?? 0;
      if (counted >= half) {
        paper = v;
        break;
      }
    }
    const threshold = Math.max(60, Math.min(200, Math.round(paper * 0.7)));

    for (let i = 0; i < px.length; i += 4) {
      const luma = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
      const value = luma > threshold ? 255 : 0;
      px[i] = value;
      px[i + 1] = value;
      px[i + 2] = value;
      px[i + 3] = 255;
    }
    ctx.putImageData(frame, 0, 0);
    return canvas.toBuffer('image/png');
  } catch (error) {
    logger.warn('ocr: could not binarise for retry', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function ocrImage(image: Buffer, pageNumber: number): Promise<OcrPageResult> {
  if (visionConfigured()) {
    try {
      const page = await visionOcrImage(image, pageNumber);
      return { ...page, engine: 'vision' };
    } catch (error) {
      // Fall through. Vision throwing is a transport or credential problem; an
      // EMPTY Vision result is a genuine "no text here" and is returned above.
      logger.warn('vision: falling back to the offline engine', {
        pageNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const worker = await getWorker();
  let { data } = await worker.recognize(image, {}, { blocks: true, text: true });

  let words = wordsOf(data).filter(
    (word) => word.text.trim() && word.confidence >= MIN_WORD_CONFIDENCE,
  );

  /**
   * Nothing at all is a BINARISATION failure far more often than a blank page,
   * so the page is re-thresholded and read once more before being given up on.
   *
   * Gated on an empty result rather than run always, which is what makes it
   * free: a page the engine already read never reaches this, so the retry can
   * only ever turn a total loss into a read. The cost is one extra recognition
   * on a page that was going to yield nothing.
   */
  if (words.length === 0) {
    const rethresholded = await binariseForRetry(image);
    if (rethresholded) {
      const retry = await worker.recognize(rethresholded, {}, { blocks: true, text: true });
      const retryWords = wordsOf(retry.data).filter(
        (word) => word.text.trim() && word.confidence >= MIN_WORD_CONFIDENCE,
      );
      if (retryWords.length > 0) {
        logger.info('ocr: recovered a page by re-thresholding', {
          pageNumber,
          words: retryWords.length,
        });
        data = retry.data;
        words = retryWords;
      }
    }
  }

  const runs: PositionedRun[] = words.map((word) => ({
    x: word.bbox.x0,
    /**
     * The BASELINE — `y1`, the bottom of the box — and negated.
     *
     * Negated because image coordinates grow downward while `rowsFromRuns`
     * sorts descending for PDF user space, which grows upward; without it the
     * page is read bottom to top and every table comes out reversed.
     *
     * The bottom rather than the top because that is what aligns across a line.
     * Grouping on `y0` put a colon on a row of its own — a colon has no
     * ascender, so its box starts far below the capital beside it — which broke
     * every `Label : value` line on a scan into three separate rows.
     */
    y: -word.bbox.y1,
    width: word.bbox.x1 - word.bbox.x0,
    size: Math.max(1, word.bbox.y1 - word.bbox.y0),
    text: word.text,
  }));

  const confidence =
    words.length > 0 ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length / 100 : 0;

  return { rows: rowsFromRuns(runs, pageNumber), text: data.text ?? '', confidence, engine: 'tesseract' };
}

/**
 * Rasterise a PDF's pages and read them.
 *
 * Called only when the text layer is empty, so this never competes with the
 * digital path — a PDF that can be parsed always is.
 */
export async function ocrPdf(buffer: Buffer, pageCount: number): Promise<OcrResult> {
  const pagesToRead = Math.min(pageCount, MAX_OCR_PAGES);
  const rows: LayoutRow[] = [];
  const texts: string[] = [];
  const confidences: number[] = [];
  const engines = new Set<OcrEngine>();

  for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
    try {
      const canvasImport = () => import('@napi-rs/canvas');

      /**
       * Probe at 1:1 to learn the page's own size, then render to the target.
       *
       * unpdf takes a multiplier rather than a resolution, and the page size is
       * not known until something has been rendered — so the first render is
       * the measurement. It is cheap next to the OCR that follows, and it is
       * what makes the second render resolution-correct rather than a guess.
       */
      const probe = Buffer.from(
        await renderPageAsImage(new Uint8Array(buffer), pageNumber, { scale: 1, canvasImport }),
      );
      const size = pngDimensions(probe);

      let rendered = probe;
      if (size) {
        const scale = Math.min(
          MAX_RENDER_SCALE,
          Math.max(MIN_RENDER_SCALE, TARGET_LONG_EDGE / Math.max(size.width, size.height)),
        );
        rendered = Buffer.from(
          await renderPageAsImage(new Uint8Array(buffer), pageNumber, { scale, canvasImport }),
        );
      }

      const page = await ocrImage(rendered, pageNumber);
      rows.push(...page.rows);
      texts.push(page.text);
      engines.add(page.engine);
      if (page.confidence > 0) confidences.push(page.confidence);
    } catch (error) {
      // One unreadable page must not lose the other twenty-four.
      logger.warn('ocr: page could not be read', { pageNumber, error });
    }
  }

  return {
    rows,
    text: texts.join('\n\n'),
    confidence: confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0,
    // A mid-document fallback means SOME pages came from the weaker engine, so
    // the whole document is graded by the weaker one rather than the better.
    engine: engines.has('tesseract') || engines.size === 0 ? 'tesseract' : 'vision',
    pagesRead: pagesToRead,
    pagesSkipped: Math.max(0, pageCount - pagesToRead),
  };
}

/**
 * Cap a scanned figure's confidence.
 *
 * Two factors, both real: the ceiling above keeps every scanned figure inside
 * the review band, and Tesseract's own reading confidence scales it further so
 * a clean scan outranks a poor one. Never raises a score — a field the harvester
 * already doubted stays doubted.
 */
export function scaleForOcr(
  score: number,
  pageConfidence: number,
  engine: OcrEngine = 'tesseract',
): number {
  // Vision reads well enough that a CLEAN page may clear the review threshold;
  // the offline engine never does. Grading them alike would either flag every
  // Vision read for ever or let a Tesseract read pass unchecked.
  if (engine === 'vision') return visionCeiling(score, pageConfidence);
  return Math.min(score, OCR_CONFIDENCE_CEILING * Math.max(0.3, pageConfidence));
}
