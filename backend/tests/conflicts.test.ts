/**
 * Cross-document conflict detection — PRD §4.5.
 *
 * Two monthly returns for the same area reporting 128,450 and 131,200 tonnes
 * of coal production is not a data-quality curiosity: one of those figures is
 * going to be quoted in a Parliamentary answer. These cases pin the four
 * properties that stop it happening silently — it is detected at INGESTION, it
 * is scoped to one subsidiary, it warns on an ANSWER drawn from the documents
 * that disagree, and it never decides which figure is right.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import {
  api,
  makeSubsidiary,
  makeUser,
  authFor,
  makeDocumentWithChunks,
  askAndDrain,
} from './helpers.js';
import { setAiProvider } from '../src/services/ai/index.js';
import { ExtractedField } from '../src/modules/documents/extractedField.model.js';
import { DocumentModel } from '../src/modules/documents/document.model.js';
import { DocumentConflict } from '../src/modules/documents/documentConflict.model.js';
import {
  detectConflictsForDocument,
  metricKeyOf,
  numericValueOf,
} from '../src/modules/documents/conflictDetection.js';

describe('what counts as a comparable figure', () => {
  it('parses the shapes a filing writes', () => {
    expect(numericValueOf('128,450')).toBe(128450);
    expect(numericValueOf('62%')).toBe(62);
    expect(numericValueOf('(1,234)')).toBe(-1234); // accounting negative
  });

  it('refuses what cannot be compared', () => {
    // A date and a reference are not quantities; comparing them would raise a
    // conflict every time two documents were filed on different days.
    expect(numericValueOf('06.09.2026')).toBeNull();
    expect(numericValueOf('16 April 2025')).toBeNull();
    expect(numericValueOf('CCL/PROD/2026-27/1187')).toBeNull();
    expect(numericValueOf('Satisfactory')).toBeNull();
  });

  it('keeps a cumulative metric distinct from a monthly one', () => {
    // `Coal Production` is a month; `Coal Production (till date)` is cumulative.
    // Folding them together would flag two correct numbers as a contradiction.
    expect(metricKeyOf('Coal Production')).not.toBe(metricKeyOf('Coal Production (till date)'));
    // Punctuation and spacing still fold, because OCR is inconsistent on both.
    expect(metricKeyOf('Offtake (Rail)')).toBe(metricKeyOf('offtake  rail'));
  });
});

describe('detection', () => {
  let ccl: Awaited<ReturnType<typeof makeSubsidiary>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  /** Plant a document that states one figure, as the extractor would have. */
  async function fileReturn(
    subsidiaryId: string,
    filename: string,
    fields: Record<string, string>,
  ): Promise<Types.ObjectId> {
    const { documentId } = await makeDocumentWithChunks({
      subsidiaryId,
      uploadedBy: owner.id,
      text: `MONTHLY PRODUCTION RETURN\n\n${Object.entries(fields)
        .map(([k, v]) => `${k}  ${v}`)
        .join('\n')}`,
      filename,
    });

    await ExtractedField.insertMany(
      Object.entries(fields).map(([fieldName, value]) => ({
        documentId: new Types.ObjectId(documentId),
        subsidiaryId: new Types.ObjectId(subsidiaryId),
        fieldName,
        value,
        confidenceScore: 0.8,
        sourceLocation: { chunkIndex: 0 },
        isDeleted: false,
      })),
    );

    return new Types.ObjectId(documentId);
  }

  beforeEach(async () => {
    ccl = await makeSubsidiary('CCL');
    owner = await makeUser({ email: 'ccl@geominex.test', role: 'admin' });
  });

  it('raises a conflict when two returns disagree', async () => {
    await fileReturn(ccl.id, 'August-return-v1.pdf', { 'Coal Production': '128,450' });
    const second = await fileReturn(ccl.id, 'August-return-v2.pdf', { 'Coal Production': '131,200' });

    const outcome = await detectConflictsForDocument(second);
    expect(outcome.conflicts).toBe(1);

    const raised = await DocumentConflict.findOne({ metricKey: 'coal production' }).lean();
    expect(raised?.status).toBe('open');
    expect(raised?.spread).toBe(2750);
    // BOTH readings are recorded — the system does not pick a winner.
    expect(raised?.readings.map((r) => r.value).sort()).toEqual(['128,450', '131,200']);
  });

  it('says nothing when the returns agree', async () => {
    await fileReturn(ccl.id, 'a.pdf', { 'Coal Production': '128,450' });
    const second = await fileReturn(ccl.id, 'b.pdf', { 'Coal Production': '128,450' });

    expect((await detectConflictsForDocument(second)).conflicts).toBe(0);
    expect(await DocumentConflict.countDocuments({})).toBe(0);
  });

  it('never compares across subsidiaries', async () => {
    // Two AREAS reporting different production is the normal case, not a
    // discrepancy — and a conflict that crossed the boundary would also be a
    // §9.1 leak, showing one subsidiary's figure inside another's queue.
    const bccl = await makeSubsidiary('BCCL');
    await fileReturn(ccl.id, 'ccl.pdf', { 'Coal Production': '128,450' });
    const other = await fileReturn(bccl.id, 'bccl.pdf', { 'Coal Production': '99,000' });

    expect((await detectConflictsForDocument(other)).conflicts).toBe(0);
  });

  it('puts both documents in the review queue', async () => {
    // The one signal that can promote a CONFIDENT extraction to review: a
    // figure read perfectly off a page that contradicts another page is exactly
    // what would otherwise pass straight into a report.
    const first = await fileReturn(ccl.id, 'a.pdf', { 'Coal Dispatch': '119,800' });
    const second = await fileReturn(ccl.id, 'b.pdf', { 'Coal Dispatch': '121,650' });
    await detectConflictsForDocument(second);

    for (const id of [first, second]) {
      const doc = await DocumentModel.findById(id).lean();
      expect(doc?.requiresReview).toBe(true);
    }
  });

  it('does not queue the same finding twice when a document is reprocessed', async () => {
    await fileReturn(ccl.id, 'a.pdf', { 'Coal Production': '128,450' });
    const second = await fileReturn(ccl.id, 'b.pdf', { 'Coal Production': '131,200' });

    await detectConflictsForDocument(second);
    await detectConflictsForDocument(second);

    expect(await DocumentConflict.countDocuments({ metricKey: 'coal production' })).toBe(1);
  });

  it('ignores a difference small enough to be OCR noise in the last digit', async () => {
    await fileReturn(ccl.id, 'a.pdf', { 'Coal Production': '128,450' });
    const second = await fileReturn(ccl.id, 'b.pdf', { 'Coal Production': '128,451' });
    expect((await detectConflictsForDocument(second)).conflicts).toBe(0);
  });
});

describe('a contradicted answer', () => {
  let auth: Awaited<ReturnType<typeof authFor>>;
  let ccl: Awaited<ReturnType<typeof makeSubsidiary>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    setAiProvider(null);
    ccl = await makeSubsidiary('CCL');
    owner = await makeUser({ email: 'q@geominex.test', role: 'admin' });
    auth = await authFor(owner.id, 'admin');

    for (const [filename, figure] of [
      ['CCL-August-1187.pdf', '128,450'],
      ['CCL-August-1243.pdf', '131,200'],
    ] as const) {
      const { documentId } = await makeDocumentWithChunks({
        subsidiaryId: ccl.id,
        uploadedBy: owner.id,
        filename,
        text: `MONTHLY PRODUCTION & DISPATCH REPORT (AUGUST 2026)\nArea  North Karanpura Area\n1  Coal Production  ${figure}`,
      });
      await ExtractedField.create({
        documentId: new Types.ObjectId(documentId),
        subsidiaryId: new Types.ObjectId(ccl.id),
        fieldName: 'Coal Production',
        value: figure,
        confidenceScore: 0.8,
        sourceLocation: { chunkIndex: 0 },
        isDeleted: false,
      });
      await detectConflictsForDocument(new Types.ObjectId(documentId));
    }
  });

  it('warns on the answer and sends the query for review', async () => {
    const answer = await askAndDrain(auth, {
      questionText: 'What was the coal production for North Karanpura Area?',
    });

    const warnings = (answer.warnings ?? []) as string[];
    const conflict = warnings.find((w) => w.includes('CONFLICTING DATA FOUND'));
    expect(conflict).toBeDefined();
    // Both figures and both filenames, so the reader can go and look.
    expect(conflict).toContain('128,450');
    expect(conflict).toContain('131,200');
    expect(conflict).toContain('CCL-August-1187.pdf');

    // It is not presented as answered-and-done.
    expect(answer.reviewStatus).toBe('pending');
  });

  it('warns only about the metric that was ASKED about', async () => {
    /**
     * A caveat that buries the relevant warning under three irrelevant ones is
     * not a safety feature. Asked for total coal production, the reader was
     * handed warnings about G10 and road offtake as well — metrics they had
     * not mentioned and the answer had not quoted.
     */
    await ExtractedField.create({
      documentId: (await DocumentModel.findOne({ originalFilename: 'CCL-August-1187.pdf' }).lean())!._id,
      subsidiaryId: new Types.ObjectId(ccl.id),
      fieldName: 'Offtake (Rail)',
      value: '92,360',
      confidenceScore: 0.8,
      sourceLocation: { chunkIndex: 0 },
      isDeleted: false,
    });
    const second = await DocumentModel.findOne({ originalFilename: 'CCL-August-1243.pdf' }).lean();
    await ExtractedField.create({
      documentId: second!._id,
      subsidiaryId: new Types.ObjectId(ccl.id),
      fieldName: 'Offtake (Rail)',
      value: '95,870',
      confidenceScore: 0.8,
      sourceLocation: { chunkIndex: 0 },
      isDeleted: false,
    });
    await detectConflictsForDocument(second!._id);
    // Both metrics are genuinely in conflict and both are in the queue.
    expect(await DocumentConflict.countDocuments({ status: 'open' })).toBe(2);

    const answer = await askAndDrain(auth, {
      questionText: 'What was the coal production for North Karanpura Area?',
    });
    const warnings = ((answer.warnings ?? []) as string[]).filter((w) =>
      w.includes('CONFLICTING DATA FOUND'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Coal Production');
    expect(warnings[0]).not.toContain('Offtake');
  });

  it('names the quoted figure when that is why it fired', async () => {
    /**
     * The safety net has to explain itself. Asked about a metric it does not
     * name, a reader was shown a warning with no way to see that it fired
     * because the answer above literally states a disputed figure — which
     * reads as a bug rather than as the correct, careful behaviour it is.
     */
    const answer = await askAndDrain(auth, {
      questionText: 'Which area does the August report cover?',
    });

    const warnings = ((answer.warnings ?? []) as string[]).filter((w) =>
      w.includes('CONFLICTING DATA FOUND'),
    );
    // It fires only if the answer actually states one of the disputed figures.
    const quotesFigure = String(answer.responseText).includes('128,450');
    if (quotesFigure) {
      expect(warnings[0]).toContain('This answer states 128,450');
    } else {
      expect(warnings).toHaveLength(0);
    }
  });

  it('exposes the review queue, widest disagreement first', async () => {
    const res = await api()
      .get('/api/v1/documents/conflicts')
      .set(auth.header)
      .expect(200);

    const [first] = res.body.data.conflicts as Array<{ metric: string; spread: number }>;
    expect(first?.metric).toBe('Coal Production');
    expect(first?.spread).toBe(2750);
  });
});
