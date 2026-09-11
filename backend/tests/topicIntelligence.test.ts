import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { api, authFor, makeSubsidiary, makeUser, makeDocumentWithChunks, drainAll } from './helpers.js';
import { retrievePassages } from '../src/modules/queries/retrieval.service.js';
import { extractTopics, isNoiseTerm, EXTRACTION_VERSION } from '../src/modules/topics/topicExtraction.js';
import { classifyQuestion, MIN_INTENT_CONFIDENCE } from '../src/modules/topics/questionIntent.js';
import { DocumentTopic } from '../src/modules/topics/documentTopic.model.js';
import { DocumentIntelligence } from '../src/modules/topics/documentIntelligence.model.js';
import { clearCorpusBaselineCache } from '../src/modules/topics/corpusBaseline.js';
import type { CorpusBaseline } from '../src/modules/topics/topicExtraction.js';

/**
 * Topic & Keyword Intelligence.
 *
 * The unit half tests the SCORER, because that is where the specification's
 * central requirement lives — "do NOT simply extract the most frequently
 * occurring words" is a claim about ranking, and only a ranking test can hold
 * it. The integration half tests that stored topics actually do the jobs they
 * were extracted for: filtering, search, related documents, RAG ordering, and
 * refusing to cross a subsidiary boundary on any of those paths.
 */

// ── Fixtures ───────────────────────────────────────────────────────────────

const GEOLOGY_REPORT = `GEOLOGICAL INVESTIGATION REPORT - TALCHER COALFIELD

This geological investigation report covers the detailed exploration carried out in the
Talcher Coalfield during the field season. The exploration was undertaken to establish the
geological reserve of the block and to support preparation of the mining plan.

A total of 48 boreholes were drilled in the block, aggregating 14,250 metres of drilling
metreage. Core recovery in the coal horizon averaged 92 per cent. Each borehole log was
correlated with adjacent boreholes to establish seam continuity. Exploratory drilling
confirmed the persistence of the coal seam over the eastern flank.

Geological reserve has been estimated following the Indian Standard Procedure. The proved
reserve is 412.6 million tonnes and the indicated reserve 188.2 million tonnes. Reserve
estimation was carried out seam wise using the sectional area method.`;

const SAFETY_REPORT = `MINE SAFETY REVIEW - UNDERGROUND OPERATIONS

The safety audit examined ventilation adequacy across the underground mine. Roof support
practice was reviewed in every depillaring district and the bord and pillar workings were
inspected for strata control.

Two reportable accidents occurred during the period. Spontaneous heating was detected in
one sealed goaf and the mines rescue team was placed on standby. Methane concentration
readings were within statutory limits throughout.

The internal safety organisation has recommended a revised risk assessment for the
depillaring panels and additional roof bolting in the main gallery.`;

const ENVIRONMENT_REPORT = `ENVIRONMENTAL MANAGEMENT PLAN - OPENCAST PROJECT

The environment management plan sets out ambient air quality monitoring for the opencast
project. Fugitive dust suppression along the haul road is reviewed quarterly and effluent
treatment capacity has been assessed.

Land reclamation of the external dump is proceeding. Biological reclamation through
plantation covered 128 hectares during the year. Technical reclamation of the overburden
dump slopes was completed ahead of schedule.

Groundwater monitoring wells recorded no deterioration in water quality. The environmental
clearance conditions have been complied with in full.`;

const emptyBaseline: CorpusBaseline = { documentCount: 0, documentFrequency: new Map() };

function extract(text: string, filename = 'report.pdf', overrides: Partial<Parameters<typeof extractTopics>[0]> = {}) {
  return extractTopics({
    chunks: text.split(/\n\s*\n/).map((t, i) => ({ text: t, pageNumber: i + 1 })),
    filename,
    ocrTolerant: false,
    ocrConfidence: 0.95,
    baseline: emptyBaseline,
    ...overrides,
  });
}

// ── Extraction ─────────────────────────────────────────────────────────────

describe('topic extraction', () => {
  it('names the document’s actual subject as the primary topic', () => {
    const result = extract(GEOLOGY_REPORT, 'Geological-Investigation-Talcher.pdf');
    expect(result.primary?.topicId).toBe('geological-exploration');
    expect(result.status).toBe('extracted');
  });

  it('reports the supporting subjects as secondary topics', () => {
    const result = extract(GEOLOGY_REPORT, 'Geological-Investigation-Talcher.pdf');
    const ids = result.secondary.map((t) => t.topicId);
    // The specification's own worked example: a Talcher geological report is
    // about exploration, and also about drilling, reserves and seams.
    expect(ids).toContain('drilling');
    expect(ids).toContain('coal-reserves');
    expect(ids).toContain('coal-seam');
    // Secondary means secondary: none of them may outrank the primary.
    for (const topic of result.secondary) expect(topic.relevance).toBeLessThanOrEqual(1);
  });

  it('lets the filename decide between two subjects the body treats equally', () => {
    // The same body, filed under two names. §23 asks for report titles to
    // count, and this is what that means in practice.
    expect(extract(GEOLOGY_REPORT, 'Geological-Investigation-Talcher.pdf').primary?.topicId).toBe(
      'geological-exploration',
    );
    expect(extract(GEOLOGY_REPORT, 'Coal-Reserve-Estimation-Talcher.pdf').primary?.topicId).toBe(
      'coal-reserves',
    );
  });

  it('does not rank by raw frequency', () => {
    /**
     * THE central requirement. `committee` is written seven times and every
     * mining term twice, so a word-count extractor puts `committee` first and
     * calls the document a committee document.
     */
    const text = `The committee met to consider the matter. The committee noted the position.
The committee observed that the position was unchanged. The committee will meet again.
The committee has recorded its view. The committee requested a further note.
The committee considered the note and the committee deferred the matter accordingly.

The stripping ratio governs overburden removal at the opencast project. Overburden
removal was rescheduled and the stripping ratio was revised for the coming season.`;
    const result = extract(text, 'x.pdf');
    expect(result.primary?.topicId).toBe('overburden');

    // The most frequent word in the document is not its leading keyword.
    const terms = result.keywords.map((k) => k.term);
    expect(terms[0]).not.toBe('committee');
    expect(terms.indexOf('overburden removal')).toBeLessThan(terms.indexOf('committee'));
    // Nor is it anywhere in the technical vocabulary.
    expect(result.technicalTerms.map((t) => t.term)).not.toContain('committee');
  });

  it('suppresses a term the whole corpus uses, however often it appears', () => {
    // `production` in a corpus where every document says it: 200 of 200.
    const saturated: CorpusBaseline = {
      documentCount: 200,
      documentFrequency: new Map([
        ['production', 200],
        ['coal', 200],
        ['stripping', 3],
        ['ratio', 4],
      ]),
    };
    const text = `Coal production and production targets were reviewed for the period.
Coal production against the approved production performance schedule was discussed.
Coal production figures and the production plan were tabled. Production was noted.
Coal production remains the principal measure of production performance here.

The stripping ratio was measured across each bench. The stripping ratio governs the
excavation schedule. Stripping ratio figures for the season follow in the annexure.`;

    const flat = extract(text, 'x.pdf', { baseline: emptyBaseline });
    const weighted = extract(text, 'x.pdf', { baseline: saturated });

    const relevanceOf = (r: typeof flat, id: string) =>
      r.topics.find((t) => t.topicId === id)?.relevance ?? 0;

    // Both readings agree on the subject — domain weight alone already knows
    // that `stripping ratio` says more than `production`. What the baseline
    // changes is how much the saturated term is worth, and it must fall.
    expect(weighted.primary?.topicId).toBe('overburden');
    expect(relevanceOf(weighted, 'coal-production')).toBeLessThan(relevanceOf(flat, 'coal-production'));

    // And it loses ground as a keyword against a term the corpus finds rare —
    // stated as a ratio, because both scores move and only their relation is
    // the claim being made.
    const keywordScore = (r: typeof flat, term: string) =>
      r.keywords.find((k) => k.term === term)?.score ?? 0;
    const standing = (r: typeof flat) =>
      keywordScore(r, 'coal production') / keywordScore(r, 'stripping ratio');

    expect(standing(weighted)).toBeLessThan(standing(flat));
  });

  it('prefers technical phrases to their component words', () => {
    const terms = extract(GEOLOGY_REPORT).technicalTerms.map((t) => t.term);
    expect(terms).toContain('geological reserve');
    expect(terms).toContain('reserve estimation');
  });

  it('normalises different wordings of one concept onto a single topic', () => {
    // §5 — "Coal Reserve Estimation" and "Reserve Assessment" are the same
    // subject, and must not become two topics.
    const result = extract(
      `Reserve estimation for the block was completed during the season. The resource
estimation followed the same procedure. A reserve assessment was undertaken and the
geological reserve was reported to the board. Coal reserve figures were tabulated
alongside the mineral reserve and the extractable reserve.

The indicated reserve and the inferred reserve were revised. Resource assessment work
continues in the adjoining block, where the proved reserve has not yet been declared.`,
      'x.pdf',
    );
    const reserveTopics = result.topics.filter((t) => t.topicId === 'coal-reserves');
    expect(reserveTopics).toHaveLength(1);
    // The original wordings survive alongside the normalised topic.
    expect(reserveTopics[0]!.matchedTerms.length).toBeGreaterThan(2);
  });

  it('is deterministic — the same input scores identically every time', () => {
    // Reprocessing must not change what a document is about.
    expect(JSON.stringify(extract(GEOLOGY_REPORT))).toBe(JSON.stringify(extract(GEOLOGY_REPORT)));
  });

  it('selects summary sentences verbatim from the document', () => {
    const result = extract(GEOLOGY_REPORT);
    expect(result.summary.length).toBeGreaterThan(40);
    // Every selected sentence must be findable in the source, ignoring the line
    // wrapping — a summary that cannot be located in the document is prose.
    const flatSource = GEOLOGY_REPORT.replace(/\s+/g, ' ');
    for (const sentence of result.summary.split(/(?<=\.)\s+/)) {
      expect(flatSource).toContain(sentence.trim());
    }
  });

  it('discovers a distinctive phrase the taxonomy does not know', () => {
    const text = `The sand stowing programme continued through the season. Sand stowing was
extended to three districts during the year and the results were reviewed by the
committee. Sand stowing capacity at the central plant was raised.

Additional sand stowing equipment was commissioned this period. The sand stowing
schedule for the coming season has been circulated for approval by the authority.`;
    const discovered = extract(text, 'x.pdf').topics.filter((t) => t.discovered);
    expect(discovered.map((d) => d.topicId)).toContain('discovered:sand-stowing');
  });

  it('attaches verbatim evidence to each topic', () => {
    const primary = extract(GEOLOGY_REPORT).primary!;
    expect(primary.evidence.length).toBeGreaterThan(0);
    const quote = primary.evidence[0]!.quote;
    expect(GEOLOGY_REPORT.replace(/\s+/g, ' ')).toContain(quote);
  });
});

// ── OCR quality (§22) and noise (§15) ──────────────────────────────────────

describe('OCR handling', () => {
  it('recognises a mis-scanned domain term', () => {
    const result = extract(
      `GEOLOGlCAL INVESTlGATlON REPORT. The exploratlon programme included borehoIe
drllling across the block. Coal seam thickness was measured at each borehole.

Geologlcal exploratlon continued. The geological reserve was estimated from the
borehole data and the coal seam correlation.`,
      'scan-0042.pdf',
      { ocrTolerant: true, ocrConfidence: 0.62 },
    );
    expect(result.topics.map((t) => t.topicId)).toContain('geological-exploration');
  });

  it('stores the canonical spelling, not the misreading', () => {
    const result = extract(
      `Geologlcal exploratlon of the block continued through the season. Geologlcal
exploratlon data was compiled from the field parties and checked. The geologlcal
exploratlon programme is complete for the year and the report has been submitted.

Further geologlcal exploratlon in the adjoining block will begin after the monsoon,
subject to approval of the revised geologlcal exploratlon estimate by the board.`,
      'scan.pdf',
      { ocrTolerant: true, ocrConfidence: 0.6 },
    );
    const terms = result.keywords.map((k) => k.term);
    // The canonical phrase is stored; the misreading appears nowhere.
    expect(terms).toContain('geological exploration');
    for (const term of [...terms, ...result.technicalTerms.map((t) => t.term)]) {
      expect(term, term).not.toMatch(/geologlcal|exploratlon/);
    }
  });

  it('does not apply the OCR fold to a digital text layer', () => {
    // The same mangled text from a PDF with a real text layer stays mangled:
    // repairing it there would invent matches the document does not contain.
    const result = extract(
      `Geologlcal exploratlon of the block continued through the season. Geologlcal
exploratlon data was compiled from the field parties and checked. The geologlcal
exploratlon programme is complete for the year and the report has been submitted.

Further geologlcal exploratlon in the adjoining block will begin after the monsoon,
subject to approval of the revised geologlcal exploratlon estimate by the board.`,
      'digital.pdf',
      { ocrTolerant: false },
    );
    // The misreading survives as itself, and no topic is claimed from it.
    expect(result.keywords.map((k) => k.term)).toContain('geologlcal exploratlon');
    expect(result.topics.map((t) => t.topicId)).not.toContain('geological-exploration');
  });

  it('rejects OCR debris rather than storing it as a keyword', () => {
    for (const junk of ['wrtsp', 'mnthy', '1284b', 'aaabaa', 'lililil', 'mplmnts']) {
      expect(isNoiseTerm(junk), junk).toBe(true);
    }
    // …while keeping vocabulary that merely looks like debris.
    for (const real of ['co2', 'pm10', 'strata', 'strength', 'fy2026', 'overburden']) {
      expect(isNoiseTerm(real), real).toBe(false);
    }
  });

  it('marks a poor scan low-quality instead of reporting confidence it does not have', () => {
    const result = extract(GEOLOGY_REPORT, 'scan.pdf', { ocrTolerant: true, ocrConfidence: 0.4 });
    expect(result.status).toBe('low_quality');
    expect(result.confidence).toBeLessThan(extract(GEOLOGY_REPORT).confidence);
  });
});

// ── Degenerate input (§25) ─────────────────────────────────────────────────

describe('degenerate documents', () => {
  it('reports an empty document as insufficient text, not as a failure', () => {
    const result = extract('', 'empty.pdf');
    expect(result.status).toBe('insufficient_text');
    expect(result.primary).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('does not invent a subject for text that has none', () => {
    const result = extract(
      `Dear Sir, Please find enclosed the acknowledgement. Kindly acknowledge receipt at
your earliest convenience. Thanking you. Yours faithfully.

The undersigned has forwarded the enclosure vide the reference cited above for your
kind information and necessary action please.`,
      'covering-letter.pdf',
    );
    expect(result.primary).toBeNull();
    expect(result.topics).toHaveLength(0);
  });

  it('carries the extraction version, so a scoring change can be found later', () => {
    expect(extract(GEOLOGY_REPORT).version).toBe(EXTRACTION_VERSION);
  });
});

// ── Query understanding (§11) ──────────────────────────────────────────────

describe('question classification', () => {
  it('reads a topic out of a question that names one', () => {
    const intent = classifyQuestion('Give me reports related to borehole drilling.');
    expect(intent.topicIds).toContain('drilling');
    expect(intent.confidence).toBeGreaterThanOrEqual(MIN_INTENT_CONFIDENCE);
  });

  it('handles the specification’s reserve-estimation example', () => {
    const intent = classifyQuestion('What are the major findings related to coal reserve estimation?');
    expect(intent.topicIds).toContain('coal-reserves');
    expect(intent.confidence).toBeGreaterThanOrEqual(MIN_INTENT_CONFIDENCE);
  });

  it('does not force a topic onto a question that has none', () => {
    for (const question of [
      'What was the figure for last quarter?',
      'Who signed this and when?',
      'Please summarise the attached document.',
    ]) {
      expect(classifyQuestion(question).confidence, question).toBeLessThan(MIN_INTENT_CONFIDENCE);
    }
  });

  it('treats one incidental common word as too weak to act on', () => {
    // Every question in this system says "coal". A signal that fires on all of
    // them reorders nothing and only costs a query.
    expect(classifyQuestion('How much coal was there?').confidence).toBeLessThan(MIN_INTENT_CONFIDENCE);
  });
});

// ── Integration ────────────────────────────────────────────────────────────

describe('topic intelligence over the API', () => {
  let mcl: Awaited<ReturnType<typeof makeSubsidiary>>;
  let bccl: Awaited<ReturnType<typeof makeSubsidiary>>;
  let admin: Awaited<ReturnType<typeof authFor>>;
  let scoped: Awaited<ReturnType<typeof authFor>>;
  let adminUser: Awaited<ReturnType<typeof makeUser>>;
  let geologyId: string;
  let safetyId: string;
  let foreignId: string;

  beforeEach(async () => {
    clearCorpusBaselineCache();
    mcl = await makeSubsidiary('MCL');
    bccl = await makeSubsidiary('BCCL');

    adminUser = await makeUser({ email: 'admin@geominex.test', role: 'admin' });
    const scopedUser = await makeUser({
      email: 'mcl@geominex.test',
      role: 'cil_user',
      subsidiaryAccess: [mcl.id],
    });

    admin = await authFor(adminUser.id, 'admin');
    scoped = await authFor(scopedUser.id, 'cil_user');

    geologyId = (
      await makeDocumentWithChunks({
        subsidiaryId: mcl.id,
        uploadedBy: adminUser.id,
        text: GEOLOGY_REPORT,
        filename: 'Annual-Geological-Investigation-Report.pdf',
      })
    ).documentId;

    safetyId = (
      await makeDocumentWithChunks({
        subsidiaryId: mcl.id,
        uploadedBy: adminUser.id,
        text: SAFETY_REPORT,
        filename: 'Mine-Safety-Review.pdf',
      })
    ).documentId;

    await makeDocumentWithChunks({
      subsidiaryId: mcl.id,
      uploadedBy: adminUser.id,
      text: ENVIRONMENT_REPORT,
      filename: 'Environmental-Management-Plan.pdf',
    });

    foreignId = (
      await makeDocumentWithChunks({
        subsidiaryId: bccl.id,
        uploadedBy: adminUser.id,
        text: GEOLOGY_REPORT,
        filename: 'BCCL-Geological-Report.pdf',
      })
    ).documentId;

    await drainAll();
  });

  it('stores topics and intelligence when a document is processed', async () => {
    const rows = await DocumentTopic.find({ documentId: new Types.ObjectId(geologyId) }).lean();
    expect(rows.length).toBeGreaterThan(1);
    // Exactly one primary, by construction.
    expect(rows.filter((r) => r.rank === 'primary')).toHaveLength(1);

    const record = await DocumentIntelligence.findOne({ documentId: new Types.ObjectId(geologyId) }).lean();
    expect(record?.status).toBe('extracted');
    expect(record?.primaryTopicId).toBe('geological-exploration');
    expect(record?.keywords.length).toBeGreaterThan(0);
    expect(record?.summary.length).toBeGreaterThan(0);
  });

  it('serves a document’s intelligence on its own endpoint', async () => {
    const res = await api().get(`/api/v1/documents/${geologyId}/topics`).set(admin.header).expect(200);
    expect(res.body.data.primaryTopic.topicId).toBe('geological-exploration');
    expect(res.body.data.secondaryTopics.length).toBeGreaterThan(0);
    expect(res.body.data.technicalTerms.length).toBeGreaterThan(0);
    expect(res.body.data.status).toBe('extracted');
  });

  it('filters the documents list by topic', async () => {
    const res = await api()
      .get('/api/v1/documents?topic=mine-safety')
      .set(scoped.header)
      .expect(200);

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(safetyId);
    expect(ids).not.toContain(geologyId);
  });

  it('intersects stacked topic filters when asked to', async () => {
    const any = await api()
      .get('/api/v1/documents?topic=mine-safety&topic=geological-exploration&topicMatch=any')
      .set(scoped.header)
      .expect(200);
    const all = await api()
      .get('/api/v1/documents?topic=mine-safety&topic=geological-exploration&topicMatch=all')
      .set(scoped.header)
      .expect(200);

    expect(any.body.data.length).toBeGreaterThan(all.body.data.length);
    expect(all.body.data).toHaveLength(0);
  });

  it('rejects an unknown topic rather than silently returning everything', async () => {
    await api().get('/api/v1/documents?topic=not-a-real-topic').set(scoped.header).expect(400);
  });

  it('finds a document by a topic its filename never mentions', async () => {
    // §9's worked example: "Annual Geological Investigation Report" answers a
    // search for `drilling`, because Drilling is an extracted topic.
    const res = await api().get('/api/v1/documents?q=drilling').set(scoped.header).expect(200);
    const match = res.body.data.find((d: { id: string }) => d.id === geologyId);
    expect(match).toBeDefined();
    expect(match.matchedVia).toContain('topic');
  });

  it('still matches on the filename', async () => {
    const res = await api().get('/api/v1/documents?q=Environmental').set(scoped.header).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].matchedVia).toContain('filename');
  });

  it('carries the leading topic on each list row', async () => {
    const res = await api().get('/api/v1/documents').set(scoped.header).expect(200);
    const row = res.body.data.find((d: { id: string }) => d.id === safetyId);
    expect(row.primaryTopic.topicId).toBe('mine-safety');
    expect(row.topicStatus).toBe('extracted');
  });

  it('keeps cursor pagination working alongside a topic filter', async () => {
    const first = await api()
      .get('/api/v1/documents?limit=1&topic=geological-exploration&topic=mine-safety')
      .set(scoped.header)
      .expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.pagination.nextCursor).not.toBeNull();
    // `total` is deliberately absent from a cursor envelope (§9.8).
    expect(first.body.pagination.total).toBeUndefined();

    const second = await api()
      .get(
        `/api/v1/documents?limit=1&topic=geological-exploration&topic=mine-safety&cursor=${first.body.pagination.nextCursor}`,
      )
      .set(scoped.header)
      .expect(200);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it('suggests related documents through shared topics', async () => {
    const res = await api().get(`/api/v1/documents/${geologyId}/related`).set(admin.header).expect(200);
    // The BCCL copy is the same text, so it shares every topic — and an admin
    // is unscoped, so it is the one document that should surface.
    expect(res.body.data.related.map((r: { id: string }) => r.id)).toContain(foreignId);
    expect(res.body.data.related[0].sharedTopics.length).toBeGreaterThan(0);
    expect(res.body.data.related[0].similarity).toBeGreaterThan(0);
  });

  it('lists the topic catalogue with counts and recent documents', async () => {
    const res = await api().get('/api/v1/topics/catalog').set(scoped.header).expect(200);
    const safety = res.body.data.topics.find((t: { topicId: string }) => t.topicId === 'mine-safety');
    expect(safety.documentCount).toBe(1);
    expect(safety.recentDocuments[0].originalFilename).toBe('Mine-Safety-Review.pdf');
    expect(safety.relatedTopics.length).toBeGreaterThan(0);
  });

  it('serves the taxonomy as a filter option list', async () => {
    const res = await api().get('/api/v1/topics/vocabulary').set(scoped.header).expect(200);
    const ids = res.body.data.topics.map((t: { topicId: string }) => t.topicId);
    expect(ids).toContain('geological-exploration');
    expect(ids).toContain('mine-safety');
  });

  it('reports document-intelligence analytics for the dashboard', async () => {
    const res = await api().get('/api/v1/topics/analytics').set(scoped.header).expect(200);
    const { analytics } = res.body.data;
    expect(analytics.totalDocuments).toBe(3);
    expect(analytics.analysedDocuments).toBe(3);
    expect(analytics.topTopics.length).toBeGreaterThan(0);
    expect(analytics.extractionHealth.find((h: { status: string }) => h.status === 'extracted').count).toBe(3);
  });

  it('re-extracts on request without re-reading the file', async () => {
    await DocumentTopic.deleteMany({ documentId: new Types.ObjectId(geologyId) });

    const res = await api()
      .post(`/api/v1/documents/${geologyId}/reprocess-topics`)
      .set(admin.header)
      .expect(200);

    expect(res.body.data.primaryTopic.topicId).toBe('geological-exploration');
    const rows = await DocumentTopic.countDocuments({ documentId: new Types.ObjectId(geologyId) });
    expect(rows).toBeGreaterThan(1);
  });

  it('reprocessing is idempotent — it replaces rather than accumulates', async () => {
    const before = await DocumentTopic.countDocuments({ documentId: new Types.ObjectId(geologyId) });
    await api().post(`/api/v1/documents/${geologyId}/reprocess-topics`).set(admin.header).expect(200);
    await api().post(`/api/v1/documents/${geologyId}/reprocess-topics`).set(admin.header).expect(200);
    expect(await DocumentTopic.countDocuments({ documentId: new Types.ObjectId(geologyId) })).toBe(before);
  });

  it('refuses reprocessing to a read-only role', async () => {
    const mocUser = await makeUser({ email: 'moc@geominex.test', role: 'moc_official' });
    const moc = await authFor(mocUser.id, 'moc_official');
    await api().post(`/api/v1/documents/${geologyId}/reprocess-topics`).set(moc.header).expect(403);
  });
});

// ── Authorization (§26) ────────────────────────────────────────────────────

describe('topic intelligence authorization', () => {
  let mcl: Awaited<ReturnType<typeof makeSubsidiary>>;
  let bccl: Awaited<ReturnType<typeof makeSubsidiary>>;
  let scoped: Awaited<ReturnType<typeof authFor>>;
  let foreignId: string;

  beforeEach(async () => {
    clearCorpusBaselineCache();
    mcl = await makeSubsidiary('MCL');
    bccl = await makeSubsidiary('BCCL');
    const owner = await makeUser({ email: 'owner@geominex.test', role: 'admin' });
    const scopedUser = await makeUser({
      email: 'scoped@geominex.test',
      role: 'cil_user',
      subsidiaryAccess: [mcl.id],
    });
    scoped = await authFor(scopedUser.id, 'cil_user');

    await makeDocumentWithChunks({
      subsidiaryId: mcl.id,
      uploadedBy: owner.id,
      text: SAFETY_REPORT,
      filename: 'MCL-Safety.pdf',
    });
    foreignId = (
      await makeDocumentWithChunks({
        subsidiaryId: bccl.id,
        uploadedBy: owner.id,
        text: GEOLOGY_REPORT,
        filename: 'BCCL-Geology.pdf',
      })
    ).documentId;
    await drainAll();
  });

  it('renders another subsidiary’s document as not found, never forbidden', async () => {
    await api().get(`/api/v1/documents/${foreignId}/topics`).set(scoped.header).expect(404);
    await api().get(`/api/v1/documents/${foreignId}/related`).set(scoped.header).expect(404);
    await api().post(`/api/v1/documents/${foreignId}/reprocess-topics`).set(scoped.header).expect(404);
  });

  it('never leaks a foreign document through a topic filter', async () => {
    const res = await api()
      .get('/api/v1/documents?topic=geological-exploration')
      .set(scoped.header)
      .expect(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).not.toContain(foreignId);
  });

  it('never leaks a foreign document through topic-aware search', async () => {
    const res = await api().get('/api/v1/documents?q=drilling').set(scoped.header).expect(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).not.toContain(foreignId);
  });

  it('counts only the caller’s own corpus in the catalogue', async () => {
    const res = await api().get('/api/v1/topics/catalog').set(scoped.header).expect(200);
    const ids = res.body.data.topics.map((t: { topicId: string }) => t.topicId);
    // BCCL's geology report is the only source of these topics, and it is out
    // of scope — so they must not appear at all.
    expect(ids).not.toContain('geological-exploration');
    expect(ids).toContain('mine-safety');
  });

  it('requires authentication on every topic route', async () => {
    await api().get('/api/v1/topics/catalog').expect(401);
    await api().get('/api/v1/topics/vocabulary').expect(401);
    await api().get('/api/v1/topics/analytics').expect(401);
  });
});

// ── RAG integration (§10) ──────────────────────────────────────────────────

describe('topics as a retrieval signal', () => {
  /**
   * The document the question is about, and a document that merely says the
   * words.
   *
   * The decoy is a reclamation review that happens to mention borehole drilling
   * twice, for a nursery bore well. It is SHORTER on the terms that matter, so
   * MongoDB's text score puts it first — verified, not assumed: with the topic
   * rows deleted the decoy leads. That is the whole point of the fixture. A
   * corpus where the text index already gets the answer right cannot show that
   * re-ranking does anything, which is exactly what a first version of this
   * test did.
   */
  const DRILLING_REPORT = `EXPLORATORY DRILLING PROGRAMME - BLOCK IV

Exploratory drilling in Block IV used four departmental rigs this season. Core drilling
recovered 92 per cent through the coal horizon and each borehole log was correlated
against the adjacent boreholes to establish seam continuity.

Borehole drilling totalled 14250 metres of drilling metreage. The drilling investigation
confirmed seam persistence across the eastern flank of the block.`;

  const DECOY = `LAND RECLAMATION AND PLANTATION REVIEW

Biological reclamation through plantation covered 128 hectares. Technical reclamation of
the external dump slopes was completed. Land reclamation of the overburden dump continues
and afforestation of the reclaimed land is under way.

A borehole drilling contractor was engaged for the plantation water supply. Borehole
drilling for the nursery bore well was completed in March.`;

  const TOPIC_QUESTION = 'Give me reports related to borehole drilling.';

  let subsidiaryId: string;
  let drillingDocId: string;
  let decoyDocId: string;

  beforeEach(async () => {
    clearCorpusBaselineCache();
    const mcl = await makeSubsidiary('MCL');
    subsidiaryId = mcl.id;
    const user = await makeUser({ email: 'rag@geominex.test', role: 'admin' });

    decoyDocId = (
      await makeDocumentWithChunks({
        subsidiaryId,
        uploadedBy: user.id,
        text: DECOY,
        filename: 'Land-Reclamation-Review.pdf',
      })
    ).documentId;
    drillingDocId = (
      await makeDocumentWithChunks({
        subsidiaryId,
        uploadedBy: user.id,
        text: DRILLING_REPORT,
        filename: 'Exploratory-Drilling-Programme.pdf',
      })
    ).documentId;

    await drainAll();
  });

  const retrieve = (questionText: string) =>
    retrievePassages({
      questionText,
      scopeSubsidiaryIds: [new Types.ObjectId(subsidiaryId)],
      documentIds: [],
      nonce: 'test-nonce',
    });

  it('reads the topic out of the question and applies it', async () => {
    const result = await retrieve(TOPIC_QUESTION);
    expect(result.intent.topicIds).toContain('drilling');
    expect(result.intent.applied).toBe(true);
  });

  it('promotes the document the question is about over the one that says the words', async () => {
    const withTopics = await retrieve(TOPIC_QUESTION);
    expect(withTopics.byRef.get(withTopics.refs[0]!)!.documentId.toString()).toBe(drillingDocId);

    // Remove the signal and the ordering reverts — which is what makes the
    // assertion above about re-ranking rather than about the text index.
    await DocumentTopic.deleteMany({ topicId: 'drilling' });
    const without = await retrieve(TOPIC_QUESTION);
    expect(without.byRef.get(without.refs[0]!)!.documentId.toString()).toBe(decoyDocId);
  });

  it('changes only the order, never the membership', async () => {
    const withTopics = await retrieve(TOPIC_QUESTION);
    await DocumentTopic.deleteMany({ topicId: 'drilling' });
    const without = await retrieve(TOPIC_QUESTION);

    const documents = (r: Awaited<ReturnType<typeof retrieve>>) =>
      [...new Set(r.refs.map((ref) => String(r.byRef.get(ref)!.documentId)))].sort();

    // A topic match must never RETRIEVE a document the text search did not
    // find. If it could, a topic label would be doing the retrieving.
    expect(documents(withTopics)).toEqual(documents(without));
    expect(withTopics.candidatesConsidered).toBe(without.candidatesConsidered);
  });

  it('leaves a question with no topic exactly as it was', async () => {
    const plain = 'What was reconciled against the ledger for the nursery?';
    expect(classifyQuestion(plain).confidence).toBeLessThan(MIN_INTENT_CONFIDENCE);

    const before = await retrieve(plain);
    expect(before.intent.applied).toBe(false);

    await DocumentTopic.deleteMany({});
    const after = await retrieve(plain);
    expect(after.refs.map((r) => String(after.byRef.get(r)!.documentId))).toEqual(
      before.refs.map((r) => String(before.byRef.get(r)!.documentId)),
    );
  });

  it('keeps every citation a verbatim slice of a stored chunk', async () => {
    // §10's hard rule: topics may reorder evidence, never become it.
    const result = await retrieve(TOPIC_QUESTION);
    const corpus = `${DRILLING_REPORT} ${DECOY}`.replace(/\s+/g, ' ');
    for (const ref of result.refs) {
      const quote = result.byRef.get(ref)!.quote.replace(/\s+/g, ' ').trim();
      expect(corpus).toContain(quote);
    }
  });
});
