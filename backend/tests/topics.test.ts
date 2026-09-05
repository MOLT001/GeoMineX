/**
 * Word cloud, clusters and trend tests — PRD §4.3, §5.6, §4.6.
 *
 * Three properties here would fail SILENTLY in production, so each gets its
 * own case rather than riding along on a happy path:
 *
 *   1. SUBSIDIARY SCOPING. A term that exists only in WCL must never reach a
 *      BCCL-only caller, and the two callers' cache rows must carry different
 *      keys — a shared key would serve one tenant's aggregate to the other
 *      with no error raised anywhere.
 *   2. IDEMPOTENCY (D5). Term rows are delete-then-insert per source, so
 *      reprocessing a document must leave the cloud UNCHANGED, not doubled.
 *   3. IST BUCKETING. A document created at 19:00 UTC on 31 March is 00:30 IST
 *      on 1 April, so it belongs to FY2026-Q1. Bucketing it in UTC moves a
 *      whole day of the corpus into the previous fiscal year.
 *
 * Every range is written out explicitly rather than relying on the default
 * (fiscal year to date), so no assertion depends on the day the suite runs.
 * The two cases that necessarily involve "now" — a fresh upload and an
 * answered query — use the default range for exactly that reason.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  api,
  makeUser,
  makeSubsidiary,
  authFor,
  makeDocumentWithChunks,
  askAndDrain,
  drainAll,
  hostileProvider,
} from './helpers.js';
import { setStorageAdapter } from '../src/services/storage/index.js';
import { createLocalStorageAdapter } from '../src/services/storage/local.adapter.js';
import { setAiProvider } from '../src/services/ai/index.js';
import { DocumentModel } from '../src/modules/documents/document.model.js';
import { WordFrequency } from '../src/modules/topics/wordFrequency.model.js';
import { TopicCache } from '../src/modules/topics/topicCache.model.js';
import { env } from '../src/config/env.js';

let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'gmx-topics-'));
  setStorageAdapter(createLocalStorageAdapter(storageRoot));
});

afterAll(async () => {
  setStorageAdapter(null);
  await rm(storageRoot, { recursive: true, force: true });
});

afterEach(() => {
  setAiProvider(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** FY2025 runs 1 April 2025 – 31 March 2026 (IST). Four quarter buckets. */
const FY2025 = 'from=2025-04-01&to=2026-03-31';

/** One instant inside each FY2025 quarter, chosen far from any boundary. */
const Q1 = new Date('2025-05-15T06:00:00.000Z');
const Q3 = new Date('2025-11-15T06:00:00.000Z');
const Q4A = new Date('2026-02-15T06:00:00.000Z');
const Q4B = new Date('2026-02-16T06:00:00.000Z');

const CSV = 'Production Tonnes: 125000\nGrade: G7\nQuarter: Q1 2026\n';

async function setup() {
  const bccl = await makeSubsidiary('BCCL');
  const wcl = await makeSubsidiary('WCL');

  const cil = await makeUser({
    email: 'topics@cil.gov.in',
    role: 'cil_user',
    subsidiaryAccess: [bccl.id],
  });
  const cilAuth = await authFor(cil.id, 'cil_user');

  const wclUser = await makeUser({
    email: 'topics-wcl@cil.gov.in',
    role: 'cil_user',
    subsidiaryAccess: [wcl.id],
  });
  const wclAuth = await authFor(wclUser.id, 'cil_user');

  return { bccl, wcl, cil, cilAuth, wclUser, wclAuth };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/**
 * The FY2025 corpus, laid out so every comparison figure is checkable by hand:
 *
 *   colliery                    Q1:1  Q2:0  Q3:1  Q4:2  -> up,   +1, +100%
 *   production / rose / tonnage Q1:1  Q2:0  Q3:1  Q4:0  -> down, -1, -100%, fading
 *   zebracrossing / survey      Q1:0  Q2:0  Q3:0  Q4:2  -> up,   +2,  null%, emerging
 *
 * Q2 is deliberately left empty: a zero-filled bucket in the MIDDLE of a
 * series is the case a positional join silently drops.
 */
async function plantFy2025Corpus(ctx: Ctx) {
  const older = 'Colliery production tonnage rose.';
  const newer = 'Colliery zebracrossing survey.';
  for (const [text, createdAt] of [
    [older, Q1],
    [older, Q3],
    [newer, Q4A],
    [newer, Q4B],
  ] as const) {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text,
      createdAt,
    });
  }
}

function getTopics(auth: { header: Record<string, string> }, query: string) {
  return api().get(`/api/v1/topics?${query}`).set(auth.header);
}

const termsOf = (body: { data: { wordCloud: { term: string }[] } }): string[] =>
  body.data.wordCloud.map((w) => w.term);

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /topics — word cloud (PRD §4.3, §5.6)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('requires authentication', async () => {
    const res = await api().get('/api/v1/topics').expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns the terms of the corpus in the standard envelope', async () => {
    await plantFy2025Corpus(ctx);

    const res = await getTopics(ctx.cilAuth, FY2025).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('wordCloud');
    expect(res.body.data).toHaveProperty('clusters');
    expect(res.body.data).toHaveProperty('trend');
    expect(res.body.data).toHaveProperty('comparison');
    expect(res.body.data).toHaveProperty('computedAt');
    expect(res.body.data.range.granularity).toBe('quarter');
    expect(res.body.data.range.timezone).toContain('+05:30');

    expect(termsOf(res.body)).toContain('colliery');
    // Frequency sums counts across sources; weight normalises to the top term.
    const colliery = res.body.data.wordCloud.find((w: { term: string }) => w.term === 'colliery');
    expect(colliery.frequency).toBe(4);
    expect(colliery.sourceCount).toBe(4);
    expect(colliery.weight).toBe(1);
  });

  it('omits stopwords from the cloud', async () => {
    const filler = 'The report and the section for that annexure with those figures.';
    for (const at of [Q1, Q3]) {
      await makeDocumentWithChunks({
        subsidiaryId: ctx.bccl.id,
        uploadedBy: ctx.cil.id,
        text: `Colliery output. ${filler}`,
        createdAt: at,
      });
    }

    const terms = termsOf((await getTopics(ctx.cilAuth, FY2025).expect(200)).body);

    expect(terms).toContain('colliery');
    for (const stop of ['the', 'and', 'that', 'with', 'those', 'report', 'section', 'annexure']) {
      expect(terms).not.toContain(stop);
    }
  });

  it('excludes a term that dominates a single document, because one source is not a topic', async () => {
    // 50 occurrences in ONE document. Frequency alone would put it at the top
    // of the cloud; minSources is what stops a single file owning the corpus.
    const solo = new Array(50).fill('zircondust').join(' ');
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: solo,
      createdAt: Q1,
    });
    await plantFy2025Corpus(ctx);

    const excluded = await getTopics(ctx.cilAuth, `${FY2025}&minSources=2`).expect(200);
    expect(termsOf(excluded.body)).not.toContain('zircondust');

    const included = await getTopics(ctx.cilAuth, `${FY2025}&minSources=1`).expect(200);
    const row = included.body.data.wordCloud.find((w: { term: string }) => w.term === 'zircondust');
    expect(row.frequency).toBe(50);
    expect(row.sourceCount).toBe(1);
  });

  it('returns byte-identical terms, clusters and labels on a recomputation', async () => {
    await plantFy2025Corpus(ctx);

    const first = await getTopics(ctx.cilAuth, FY2025).expect(200);
    // Comparing two CACHED responses would prove only that the cache returns
    // what it stored. Dropping the row forces a second real aggregation, which
    // is where a non-total sort order would show up.
    await TopicCache.deleteMany({});
    const second = await getTopics(ctx.cilAuth, FY2025).expect(200);

    expect(first.body.data.cached).toBe(false);
    expect(second.body.data.cached).toBe(false);

    const shape = (b: { data: Record<string, unknown> }) =>
      JSON.stringify({
        wordCloud: b.data.wordCloud,
        clusters: b.data.clusters,
        trend: b.data.trend,
        comparison: b.data.comparison,
      });
    expect(shape(second.body)).toBe(shape(first.body));
    expect(first.body.data.clusters.length).toBeGreaterThan(0);
    expect(first.body.data.clusters[0].label).toBe('Colliery');
  });
});

describe('GET /topics — trend and comparison (PRD §5.6, §4.3)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
    await plantFy2025Corpus(ctx);
  });

  it('returns one series point per requested bucket, zero-filling the empty ones', async () => {
    const res = await getTopics(ctx.cilAuth, FY2025).expect(200);

    expect(res.body.data.range.buckets).toEqual([
      'FY2025-Q1',
      'FY2025-Q2',
      'FY2025-Q3',
      'FY2025-Q4',
    ]);

    const colliery = res.body.data.trend.find((t: { term: string }) => t.term === 'colliery');
    // A series, not a current/previous pair — §5.6 asks for a line chart.
    expect(colliery.series.map((p: { bucket: string }) => p.bucket)).toEqual(
      res.body.data.range.buckets,
    );
    expect(colliery.series.map((p: { frequency: number }) => p.frequency)).toEqual([1, 0, 1, 2]);
    // D13: a COUNT of zero for an empty period is a true statement, so counts
    // zero-fill rather than going missing.
    expect(colliery.series[1].sourceCount).toBe(0);
    expect(colliery.total).toBe(4);

    expect(res.body.data.trend.every((t: { series: unknown[] }) => t.series.length === 4)).toBe(
      true,
    );
  });

  it('labels every bucket in the series for a chart axis', async () => {
    const res = await getTopics(ctx.cilAuth, FY2025).expect(200);
    const colliery = res.body.data.trend.find((t: { term: string }) => t.term === 'colliery');
    expect(colliery.series[0].label).toBe('FY2025-26 Q1');
  });

  it('compares the last requested quarter against the one before it', async () => {
    const res = await getTopics(ctx.cilAuth, FY2025).expect(200);
    const cmp = res.body.data.comparison;

    expect(cmp.currentPeriod).toBe('FY2025-Q4');
    expect(cmp.previousPeriod).toBe('FY2025-Q3');

    const colliery = cmp.terms.find((t: { term: string }) => t.term === 'colliery');
    expect(colliery).toMatchObject({
      current: 2,
      previous: 1,
      change: 1,
      changePercent: 100,
      direction: 'up',
    });

    const tonnage = cmp.terms.find((t: { term: string }) => t.term === 'tonnage');
    expect(tonnage).toMatchObject({
      current: 0,
      previous: 1,
      change: -1,
      changePercent: -100,
      direction: 'down',
    });
  });

  it('reports a null change percentage for a term with no previous quarter, never 100 or Infinity', async () => {
    const res = await getTopics(ctx.cilAuth, FY2025).expect(200);
    const emerging = res.body.data.comparison.terms.find(
      (t: { term: string }) => t.term === 'zebracrossing',
    );

    expect(emerging.previous).toBe(0);
    expect(emerging.current).toBe(2);
    // Growth from zero has no percentage. Reporting 100 — or Infinity — would
    // be a fabricated figure, the defect D13 exists to prevent.
    expect(emerging.changePercent).toBeNull();
    expect(emerging.direction).toBe('up');
  });

  it('sorts emerging and fading terms deterministically', async () => {
    const cmp = (await getTopics(ctx.cilAuth, FY2025).expect(200)).body.data.comparison;

    expect(cmp.emerging).toEqual(['survey', 'zebracrossing']);
    expect(cmp.fading).toEqual(['production', 'rose', 'tonnage']);
  });

  it('refuses to compare when the range holds a single bucket, rather than inventing a previous one', async () => {
    // The previous quarter was never queried, so a zero there would mean "not
    // fetched", not "not present". `null` says so honestly.
    const res = await getTopics(ctx.cilAuth, 'from=2026-01-01&to=2026-03-31').expect(200);
    expect(res.body.data.range.buckets).toEqual(['FY2025-Q4']);
    expect(res.body.data.comparison).toBeNull();
  });

  it('honours compare=none', async () => {
    const res = await getTopics(ctx.cilAuth, `${FY2025}&compare=none`).expect(200);
    expect(res.body.data.comparison).toBeNull();
  });
});

describe('GET /topics — IST bucketing (PRD §4.6)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('buckets a document created at 19:00 UTC on 31 March into FY2026-Q1, not FY2025-Q4', async () => {
    // 2026-03-31T19:00Z is 00:30 IST on 1 April 2026 — the first half hour of
    // the new Indian fiscal year. Reading it in UTC would put a whole day of
    // the corpus in the wrong fiscal year, which is the off-by-one §4.6's
    // fixed +05:30 offset exists to prevent.
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Quartzite seam thickness measured.',
      createdAt: new Date('2026-03-31T19:00:00.000Z'),
    });

    const res = await getTopics(
      ctx.cilAuth,
      'from=2026-01-01&to=2026-06-30&minSources=1&source=document',
    ).expect(200);

    expect(res.body.data.range.buckets).toEqual(['FY2025-Q4', 'FY2026-Q1']);

    const quartzite = res.body.data.trend.find((t: { term: string }) => t.term === 'quartzite');
    expect(quartzite.series[0]).toMatchObject({ bucket: 'FY2025-Q4', frequency: 0 });
    expect(quartzite.series[1]).toMatchObject({ bucket: 'FY2026-Q1', frequency: 1 });

    const row = await WordFrequency.findOne({ term: 'quartzite' }).lean();
    expect(row!.periodQuarter).toBe('FY2026-Q1');
    expect(row!.periodMonth).toBe('2026-04');
  });

  it('buckets the millisecond before the fiscal year turns over into FY2025-Q4', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Quartzite seam thickness measured.',
      createdAt: new Date('2026-03-31T18:29:59.999Z'),
    });

    const row = await WordFrequency.findOne({ term: 'quartzite' }).lean();
    expect(row!.periodQuarter).toBe('FY2025-Q4');
    expect(row!.periodMonth).toBe('2026-03');
  });
});

describe('GET /topics — reindexing is idempotent (D5, PRD §9.4)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('replaces a document term rows on reprocessing instead of doubling them', async () => {
    const created = await api()
      .post('/api/v1/documents')
      .set(ctx.cilAuth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', Buffer.from(CSV), { filename: 'terms.csv', contentType: 'text/csv' })
      .expect(201);
    await drainAll();

    const documentId = created.body.data.id as string;
    const rowsFor = async () =>
      (
        await WordFrequency.find({ sourceType: 'document', sourceId: documentId })
          .sort({ term: 1 })
          .lean()
      ).map((r) => `${r.term}:${r.count}`);

    const before = await rowsFor();
    expect(before.length).toBeGreaterThan(0);

    // The retry endpoint accepts only a FAILED document, so plant the state a
    // crashed worker would have left behind rather than inventing a second
    // ingestion path. What is under test is the delete-then-insert contract,
    // not how the document came to need reprocessing.
    await DocumentModel.updateOne(
      { _id: documentId },
      { $set: { status: 'failed', processingError: 'planted for retry' } },
    );

    await api().post(`/api/v1/documents/${documentId}/retry`).set(ctx.cilAuth.header).expect(200);
    await drainAll();

    expect(await rowsFor()).toEqual(before);
  });
});

describe('GET /topics — caching and subsidiary scoping (PRD §4.6, §9.1)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('serves the second identical call from cache with an unchanged computedAt', async () => {
    await plantFy2025Corpus(ctx);

    const first = await getTopics(ctx.cilAuth, FY2025).expect(200);
    const second = await getTopics(ctx.cilAuth, FY2025).expect(200);

    expect(first.body.data.cached).toBe(false);
    expect(second.body.data.cached).toBe(true);
    // A cached figure must never be presented as fresher than it is (§4.6).
    expect(second.body.data.computedAt).toBe(first.body.data.computedAt);
  });

  it('invalidates the cache when a new document is processed in that subsidiary', async () => {
    const first = await getTopics(ctx.cilAuth, FY2025).expect(200);
    expect(first.body.data.cached).toBe(false);
    expect((await getTopics(ctx.cilAuth, FY2025).expect(200)).body.data.cached).toBe(true);

    await api()
      .post('/api/v1/documents')
      .set(ctx.cilAuth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', Buffer.from(CSV), { filename: 'fresh.csv', contentType: 'text/csv' })
      .expect(201);
    await drainAll();

    const third = await getTopics(ctx.cilAuth, FY2025).expect(200);
    // `cached: false` is the assertion that carries the property; the
    // timestamp is compared with >= rather than > because both are minted from
    // the same millisecond-resolution clock and a strict comparison would be a
    // flake waiting for a fast machine.
    expect(third.body.data.cached).toBe(false);
    expect(new Date(third.body.data.computedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.body.data.computedAt).getTime(),
    );
  });

  it('keeps a term that exists only in WCL out of a BCCL-only caller cloud', async () => {
    await plantFy2025Corpus(ctx);
    for (const at of [Q1, Q3]) {
      await makeDocumentWithChunks({
        subsidiaryId: ctx.wcl.id,
        uploadedBy: ctx.wclUser.id,
        text: 'Lignitefield extraction summary.',
        createdAt: at,
      });
    }

    // BCCL warms the cache FIRST: with a shared cache key the WCL caller would
    // then be served BCCL's aggregate, and nothing anywhere would report an
    // error.
    const bcclRes = await getTopics(ctx.cilAuth, FY2025).expect(200);
    const wclRes = await getTopics(ctx.wclAuth, FY2025).expect(200);

    expect(termsOf(bcclRes.body)).toContain('colliery');
    expect(termsOf(bcclRes.body)).not.toContain('lignitefield');
    expect(termsOf(wclRes.body)).toContain('lignitefield');
    expect(termsOf(wclRes.body)).not.toContain('colliery');

    const keys = (await TopicCache.find().lean()).map((c) => c.cacheKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('keys the cache on every request parameter, not only on the scope', async () => {
    await plantFy2025Corpus(ctx);

    await getTopics(ctx.cilAuth, FY2025).expect(200);
    await getTopics(ctx.cilAuth, `${FY2025}&granularity=month`).expect(200);
    await getTopics(ctx.cilAuth, 'from=2025-04-01&to=2025-12-31').expect(200);

    const keys = (await TopicCache.find().lean()).map((c) => c.cacheKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('GET /topics — request bounds (PRD §9.8, §9.2)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('rejects a range that ends before it starts as INVALID_REQUEST, not VALIDATION_ERROR', async () => {
    // Two well-formed dates: schema-valid, logically invalid — §9.8's own
    // worked example of the distinction.
    const res = await getTopics(ctx.cilAuth, 'from=2026-06-01&to=2026-01-01').expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a span wider than TOPICS_MAX_RANGE_DAYS', async () => {
    const tooWide = await getTopics(ctx.cilAuth, 'from=2020-01-01&to=2026-01-01').expect(400);
    expect(tooWide.body.error.code).toBe('INVALID_REQUEST');
    expect(tooWide.body.error.message).toContain(String(env.TOPICS_MAX_RANGE_DAYS));

    // A span INSIDE the bound is still served — the cap must bound the request,
    // not quietly become a second, stricter default.
    await getTopics(ctx.cilAuth, 'from=2023-04-01&to=2026-03-31').expect(200);
  });

  it('rejects a malformed date shape as VALIDATION_ERROR', async () => {
    const res = await getTopics(ctx.cilAuth, 'from=April%202025').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404, not 403, for a subsidiary the caller does not hold', async () => {
    // 403 would confirm the subsidiary exists. §9.1 requires the caller to
    // learn nothing at all about another tenant's data.
    const res = await getTopics(ctx.cilAuth, `subsidiaryId=${ctx.wcl.id}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects an over-large limit rather than scheduling unbounded aggregation', async () => {
    const res = await getTopics(ctx.cilAuth, `${FY2025}&limit=500`).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /topics — queries in the corpus (PRD §4.3)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
    setAiProvider(hostileProvider());
  });

  it('counts an answered question own words as a query source, separately from documents', async () => {
    // A query row is created "now", so this is the one case that must use the
    // default (fiscal year to date) range.
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Quartzite seam thickness measured at the eastern block.',
    });

    const answered = await askAndDrain(ctx.cilAuth, {
      questionText: 'What is the quartzite blastingplan schedule for the eastern block?',
    });
    expect(answered.status).toBe('answered');

    const fromQueries = await getTopics(ctx.cilAuth, 'minSources=1&source=query').expect(200);
    const fromDocuments = await getTopics(ctx.cilAuth, 'minSources=1&source=document').expect(200);

    // The question term exists in no document, so its presence under
    // ?source=query and its absence under ?source=document is what proves the
    // two corpora are genuinely separable (§4.3's "documents/queries").
    expect(termsOf(fromQueries.body)).toContain('blastingplan');
    expect(termsOf(fromDocuments.body)).not.toContain('blastingplan');
    expect(termsOf(fromDocuments.body)).toContain('quartzite');

    const row = await WordFrequency.findOne({ term: 'blastingplan' }).lean();
    expect(row!.sourceType).toBe('query');
  });

  it('indexes only the question, never the generated answer', async () => {
    // Indexing the response would double-weight whatever the retriever
    // happened to surface — a cloud that amplifies its own retrieval bias.
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Quartzite seam thickness measured at the eastern block.',
    });
    await askAndDrain(ctx.cilAuth, {
      questionText: 'What is the quartzite blastingplan schedule for the eastern block?',
    });

    const queryTerms = (await WordFrequency.find({ sourceType: 'query' }).lean()).map((r) => r.term);
    expect(queryTerms).toContain('blastingplan');
    expect(queryTerms).not.toContain('thickness');
  });
});
