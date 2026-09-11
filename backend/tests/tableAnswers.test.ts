/**
 * Answering from a TABLE — PRD §4.4, §8.1, §9.5.
 *
 * ─── WHAT THIS FILE EXISTS TO PREVENT ───────────────────────────────────────
 * Asked "what is the grade-wise production of G9" against a CCL monthly
 * production report that states it plainly, the system answered:
 *
 *     Based on 2 source passage(s): MONTHLY PRODUCTION & DISPATCH REPORT [1]
 *     Production and dispatch during the month of August 2026 have been
 *     satisfactory. [1] MONTHLY PRODUCTION & DISPATCH REPORT. [2]
 *
 * Fully sourced, every citation valid, and completely useless — three separate
 * defects compounding, none of which a citation check could catch:
 *
 *   1. The stored passage was Tesseract's raw text, which emits a table one
 *      CELL per line, so every figure sat lines away from its label and no
 *      passage contained a readable row. (See `scannedReport.test.ts` for the
 *      chunking half of this.)
 *   2. `splitSentences` discarded anything under twenty characters, and
 *      `G9  96,720` is ten — so the answer-bearing line was never a candidate.
 *   3. `TERM_REGEX` required three characters, so `G9` was not a term at all:
 *      dropped from the question before it reached the retriever, which scored
 *      it as "grade wise production" and returned the total.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeSubsidiary, makeUser, authFor, makeDocumentWithChunks, askAndDrain } from './helpers.js';
import { setAiProvider } from '../src/services/ai/index.js';
import { splitSentences, tokenize } from '../src/utils/textTerms.js';

/** A CCL monthly report as the layout chunker stores it: one printed row per line. */
const CCL_REPORT = `Ref. No.: CCL/PROD/2026-27/1187  Date: 05.09.2026
MONTHLY PRODUCTION & DISPATCH REPORT (AUGUST 2026)
Subsidiary  Central Coalfields Limited (CCL)
Area  North Karanpura Area
Month  August 2026
PRODUCTION & DISPATCH SUMMARY
S. No.  Particulars  Quantity (Tonnes)
1  Coal Production  128,450
2  Coal Dispatch  119,800
3  Offtake (Rail)  92,360
4  Offtake (Road)  27,440
GRADE-WISE PRODUCTION
Grade  Quantity (Tonnes)
G9  96,720
G10  31,730
Total  128,450
REMARKS
Production and dispatch during the month of August 2026 have been satisfactory.`;

describe('term shape', () => {
  it('reads a two-character grade code as a term', () => {
    // Indian non-coking coal is graded G1..G17; half those codes are two
    // characters, and under a flat three-character floor none of them existed.
    expect(tokenize('grade wise production of G9')).toContain('g9');
    expect(tokenize('G10 production')).toContain('g10');
  });

  it('still refuses two-letter English', () => {
    // The floor was there to keep these out, and it still does — the exception
    // is a letter followed by DIGITS, which no English word is.
    const tokens = tokenize('as of an in to it is by');
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(3);
  });
});

describe('table lines as answer candidates', () => {
  it('admits a short line that pairs a label with a figure', () => {
    const lines = splitSentences('G9  96,720\nG10  31,730\nTotal  128,450').map((s) => s.text);
    expect(lines).toContain('G9  96,720');
    expect(lines).toContain('Total  128,450');
  });

  it('still refuses a bare figure and a prose fragment', () => {
    // No label, so nothing to answer with; and the length floor still governs
    // anything that is not a label-and-figure pair.
    const lines = splitSentences('1\n62%\nand then\n128,450').map((s) => s.text);
    expect(lines).toHaveLength(0);
  });
});

describe('answering a question a table answers', () => {
  let auth: Awaited<ReturnType<typeof authFor>>;

  beforeEach(async () => {
    setAiProvider(null);
    const ccl = await makeSubsidiary('CCL');
    const user = await makeUser({
      email: 'ccl@geominex.test',
      role: 'cil_user',
      subsidiaryAccess: [ccl.id],
    });
    auth = await authFor(user.id, 'cil_user');
    await makeDocumentWithChunks({
      subsidiaryId: ccl.id,
      uploadedBy: user.id,
      text: CCL_REPORT,
      filename: 'CCL-Monthly-Production-August-2026.pdf',
    });
  });

  it('quotes the grade row, not the report title', async () => {
    const answer = await askAndDrain(auth, {
      questionText: 'what is the grade wise production of G9',
    });
    expect(answer.answerStatus).toBe('sourced');
    expect(String(answer.responseText)).toContain('96,720');
  });

  it('quotes the figure a summary row states', async () => {
    const answer = await askAndDrain(auth, { questionText: 'how much was dispatched by rail' });
    expect(String(answer.responseText)).toContain('92,360');
  });

  it('does not answer a figure question with the remarks paragraph', async () => {
    // The remarks sentence is the longest, most sentence-shaped text in the
    // document, and it is what the answerer fell back to when no table line
    // could be selected. It must not win a question about a number.
    const answer = await askAndDrain(auth, { questionText: 'what was the coal production' });
    expect(String(answer.responseText)).toContain('128,450');
    expect(String(answer.responseText)).not.toContain('satisfactory');
  });
});
