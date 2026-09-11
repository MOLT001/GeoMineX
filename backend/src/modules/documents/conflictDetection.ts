/**
 * Cross-document conflict detection — PRD §4.5.
 *
 * Two returns for the same area and month reporting 128,450 and 131,200 tonnes
 * of coal production are not a data-quality curiosity: one of them is going to
 * be quoted in a Parliamentary answer. This is the code that refuses to let
 * that happen silently.
 *
 * ─── WHERE IT RUNS, AND WHY THERE ────────────────────────────────────────────
 * At the END of ingestion, in the worker, once the incoming document's fields
 * are stored. Not at query time: a discrepancy that only surfaces when somebody
 * happens to ask the right question is a discrepancy that reaches a report
 * first. Detecting it on arrival puts it in the review queue whether or not
 * anyone ever asks.
 *
 * ─── WHAT IT COMPARES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
 * Only NUMERIC readings of the same metric inside the same subsidiary. It does
 * not compare across subsidiaries — two areas reporting different production is
 * the normal case, not a conflict — and it does not compare text values, where
 * "Satisfactory" against "satisfactory" is noise rather than a finding.
 *
 * It does NOT decide which figure is right. See the model's header: a revision,
 * a corrigendum and a genuine error are indistinguishable from the values
 * alone, so the output is a flagged pair for a human, never a correction.
 */
import { Types } from 'mongoose';
import { logger } from '../../utils/logger.js';
import { tokenize } from '../../utils/textTerms.js';
import { ExtractedField } from './extractedField.model.js';
import { DocumentModel } from './document.model.js';
import { DocumentConflict, type ConflictReading } from './documentConflict.model.js';

/**
 * Two readings must differ by more than this share of the larger to count.
 *
 * Not a tolerance for real disagreement — 128,450 against 131,200 is 2.1% and
 * is exactly what this exists to catch. It is a guard against OCR noise in the
 * last digit of a long figure, which would otherwise fill the review queue with
 * pairs that differ by a rounding artefact rather than by a claim.
 */
const RELATIVE_TOLERANCE = 0.001;

/** Metrics whose value is a reference or a date, not a quantity to compare. */
const NOT_A_QUANTITY = /\b(date|no|number|ref|reference|phone|email|page|year)\b/i;

/**
 * The identity of a metric.
 *
 * Punctuation and spacing are folded because OCR is inconsistent about both,
 * but WORDS are kept: `coal production` and `coal production till date` stay
 * distinct metrics, because one is a monthly figure and the other cumulative
 * and flagging them against each other would be a false conflict between two
 * correct numbers.
 */
export function metricKeyOf(fieldName: string): string {
  return fieldName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Parse the figure a comparison can be made on.
 *
 * Returns null for anything that is not a plain quantity — a percentage is
 * kept (98% against 62% is a real conflict) but a date, a reference number and
 * free text are not comparable and are excluded rather than coerced.
 */
export function numericValueOf(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  // A date in any of the forms these documents use is not a quantity.
  if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(text)) return null;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text)) return null;

  const match = /^\(?-?([\d,]+(?:\.\d+)?)\)?\s*%?$/.exec(text.replace(/\s/g, ''));
  if (!match) return null;

  const digits = match[1]!.replace(/,/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  // A negative in accounting parentheses keeps its sign.
  return /^\(/.test(text) ? -value : value;
}

/**
 * Does this answer actually QUOTE the disputed figure?
 *
 * A plain substring test is far too loose on a number. The value `2` — which a
 * mangled row label can genuinely produce — is inside `2026`, `826001` and half
 * the reference numbers on a letterhead, so every answer mentioning a date
 * collected a warning about a metric nobody had asked about.
 *
 * The figure must therefore stand alone: not bounded by another digit, a comma
 * or a decimal point. Anything shorter than three characters is refused
 * outright, because a one- or two-digit reading is almost always OCR debris and
 * can never be matched with confidence in running prose.
 */
function quotesFigure(answerText: string, value: string): boolean {
  const figure = value.trim();
  if (figure.length < 3) return false;
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`(?<![\d,.])${escaped}(?![\d,.])`).test(answerText);
}

/**
 * Why a conflict was attached to an answer.
 *
 *   `asked`  — the question named this metric.
 *   `quoted` — the answer states one of the disputed figures, whatever was
 *              asked. This is the safety net: a reader is about to copy a
 *              number the corpus disagrees about, and no phrasing test should
 *              be allowed to suppress that.
 */
export type ConflictReason = 'asked' | 'quoted';

export interface ConflictOutcome {
  /** Metrics on which this document disagrees with another. */
  conflicts: number;
  metrics: string[];
}

/**
 * Compare one freshly-processed document against its subsidiary's corpus.
 *
 * Never throws: a detection failure must not fail an ingestion that otherwise
 * succeeded, exactly as topic extraction and term indexing do not.
 */
export async function detectConflictsForDocument(documentId: Types.ObjectId): Promise<ConflictOutcome> {
  const empty: ConflictOutcome = { conflicts: 0, metrics: [] };

  try {
    const doc = await DocumentModel.findOne({ _id: documentId, isDeleted: false })
      .select({ subsidiaryId: 1, originalFilename: 1, createdAt: 1 })
      .lean();
    if (!doc) return empty;

    const mine = await ExtractedField.find({ documentId, isDeleted: false }).lean();
    if (mine.length === 0) return empty;

    // Only the comparable ones, keyed by metric. Where a document states the
    // same metric twice, the FIRST reading stands for it — a document that
    // disagrees with itself is a different problem from two documents that
    // disagree, and conflating them would report a document against itself.
    const byMetric = new Map<string, { field: (typeof mine)[number]; numeric: number }>();
    for (const field of mine) {
      if (NOT_A_QUANTITY.test(field.fieldName)) continue;
      const numeric = numericValueOf(field.value);
      if (numeric === null) continue;
      const key = metricKeyOf(field.fieldName);
      if (!key || byMetric.has(key)) continue;
      byMetric.set(key, { field, numeric });
    }
    if (byMetric.size === 0) return empty;

    // Every other document in the SAME subsidiary. Scope is the whole point:
    // two subsidiaries reporting different production is not a discrepancy.
    const others = await ExtractedField.find({
      subsidiaryId: doc.subsidiaryId,
      documentId: { $ne: documentId },
      isDeleted: false,
    }).lean();

    const otherDocIds = [...new Set(others.map((f) => String(f.documentId)))];
    const otherDocs = await DocumentModel.find({
      _id: { $in: otherDocIds.map((id) => new Types.ObjectId(id)) },
      isDeleted: false,
    })
      .select({ originalFilename: 1, createdAt: 1 })
      .lean();
    const docById = new Map(otherDocs.map((d) => [String(d._id), d]));

    const found: string[] = [];

    for (const [key, incoming] of byMetric) {
      const readings: ConflictReading[] = [
        {
          documentId,
          originalFilename: doc.originalFilename,
          extractedFieldId: incoming.field._id,
          value: incoming.field.value,
          numericValue: incoming.numeric,
          ...(incoming.field.sourceLocation?.section
            ? { section: incoming.field.sourceLocation.section }
            : {}),
          documentCreatedAt: doc.createdAt,
        },
      ];

      const seenDocuments = new Set<string>([String(documentId)]);

      for (const field of others) {
        if (metricKeyOf(field.fieldName) !== key) continue;
        const parent = docById.get(String(field.documentId));
        if (!parent) continue;
        // One reading per document, as above.
        if (seenDocuments.has(String(field.documentId))) continue;
        const numeric = numericValueOf(field.value);
        if (numeric === null) continue;

        const larger = Math.max(Math.abs(numeric), Math.abs(incoming.numeric), 1);
        if (Math.abs(numeric - incoming.numeric) / larger <= RELATIVE_TOLERANCE) continue;

        seenDocuments.add(String(field.documentId));
        readings.push({
          documentId: field.documentId,
          originalFilename: parent.originalFilename,
          extractedFieldId: field._id,
          value: field.value,
          numericValue: numeric,
          ...(field.sourceLocation?.section ? { section: field.sourceLocation.section } : {}),
          documentCreatedAt: parent.createdAt,
        });
      }

      if (readings.length < 2) continue;

      const values = readings.map((r) => r.numericValue);
      const spread = Math.max(...values) - Math.min(...values);

      /**
       * Upserted on (subsidiary, metric), so re-processing a document updates
       * the existing row rather than queueing a second copy of the same finding.
       * A conflict a human already resolved is REOPENED when the readings
       * change, because the thing they judged is no longer what is on file.
       */
      await DocumentConflict.updateOne(
        { subsidiaryId: doc.subsidiaryId, metricKey: key },
        {
          $set: {
            metricLabel: incoming.field.fieldName,
            readings,
            spread,
            status: 'open',
            detectedAt: new Date(),
            isDeleted: false,
          },
          $unset: { resolvedBy: '', resolvedAt: '', resolvedDocumentId: '', resolutionNote: '' },
        },
        { upsert: true },
      );

      found.push(incoming.field.fieldName);
    }

    /**
     * A document implicated in a conflict needs a human, whatever its OCR
     * confidence said. This is the one signal that can flip a clean, confident
     * extraction into the review queue — and it should, because a figure read
     * perfectly from a page that contradicts another page is exactly the case
     * that would otherwise pass straight into a report.
     */
    if (found.length > 0) {
      const implicated = await DocumentConflict.find({
        subsidiaryId: doc.subsidiaryId,
        status: 'open',
        isDeleted: false,
      })
        .select({ readings: 1 })
        .lean();

      const ids = new Set<string>();
      for (const conflict of implicated) {
        for (const reading of conflict.readings) ids.add(String(reading.documentId));
      }
      await DocumentModel.updateMany(
        { _id: { $in: [...ids].map((id) => new Types.ObjectId(id)) } },
        { $set: { requiresReview: true } },
      );
    }

    return { conflicts: found.length, metrics: found };
  } catch (err) {
    logger.warn('Conflict detection failed', {
      documentId: String(documentId),
      message: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

/**
 * Open conflicts touching any of these documents — the retrieval-time lookup.
 *
 * Used by the query worker to warn on an answer drawn from documents that
 * disagree. Reads a small indexed collection, so it costs one query on a path
 * that already made several.
 */
export async function openConflictsForDocuments(
  documentIds: Types.ObjectId[],
  /**
   * The question and the answer, used to keep the warning ABOUT THE QUESTION.
   *
   * Omit them and every open conflict touching a cited document is returned,
   * which is what a first version did: asked for total coal production, the
   * reader was handed four warnings, three of them about G10, road offtake and
   * a metric they had not mentioned. A caveat that buries the relevant one
   * under three irrelevant ones is not a safety feature.
   */
  context?: { questionText: string; answerText: string },
): Promise<Array<{ metricLabel: string; readings: ConflictReading[]; reason: ConflictReason; quoted?: string }>> {
  if (documentIds.length === 0) return [];
  const rows = await DocumentConflict.find({
    'readings.documentId': { $in: documentIds },
    status: 'open',
    isDeleted: false,
  })
    .sort({ spread: -1 })
    .limit(20)
    .select({ metricLabel: 1, readings: 1 })
    .lean();

  const all: Array<{
    metricLabel: string;
    readings: ConflictReading[];
    reason: ConflictReason;
    quoted?: string;
  }> = rows.map((r) => ({ metricLabel: r.metricLabel, readings: r.readings, reason: 'asked' }));
  if (!context) return all;

  const asked = new Set(tokenize(context.questionText));

  return all.filter((conflict) => {
    /**
     * Two ways in, and the second is the safety net.
     *
     * RELEVANT: every content word of the metric appears in the question, so
     * `Coal Production` warns on "total coal production" but not on "grade-wise
     * production of G9" — which mentions production but is asking about
     * something else.
     *
     * QUOTED: a contradicted figure is literally present in the answer. That
     * one warns regardless of wording, because a reader is about to copy a
     * number the corpus disagrees about, and no phrasing test should be
     * allowed to suppress that.
     */
    const metricTokens = tokenize(conflict.metricLabel);
    if (metricTokens.length > 0 && metricTokens.every((t) => asked.has(t))) return true;

    const quoted = conflict.readings.find((reading) =>
      quotesFigure(context.answerText, reading.value),
    );
    if (!quoted) return false;

    /**
     * Carried so the warning can SAY which trigger fired.
     *
     * Without it the two cases are indistinguishable on screen, and the second
     * one reads as a bug: asked about G9, the reader was shown a warning about
     * Coal Production and had no way to see that it fired because the answer
     * above literally quotes 128,450. Naming the figure turns a confusing
     * caveat into an obviously correct one.
     */
    conflict.reason = 'quoted';
    conflict.quoted = quoted.value;
    return true;
  });
}
