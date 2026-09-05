/**
 * Analytics tests — PRD §4.6, §1.5, §5.3, instructions §4a.
 *
 * The cases that carry weight here are the ones whose failure mode is a
 * PLAUSIBLE WRONG NUMBER rather than an error:
 *
 *   D13  An empty period reports `0` for counts and `null` for ratios. A
 *        plotted 0% accuracy for a period with no extractions is a fabricated
 *        figure — asserted field by field, because this is exactly what a
 *        well-meaning "just default it to zero" refactor flattens.
 *   D11  A quarter's accuracy is total correct / total fields FOR THE QUARTER,
 *        never the mean of three monthly percentages, and it agrees with the
 *        dashboard snapshot over the same corpus.
 *   D12  Retuning a metric assumption changes the cache key, so a figure
 *        computed under the old constants cannot be served for a whole TTL.
 *   §9.1 Scope lives in both the pipeline and the cache key, so two callers
 *        with disjoint grants can neither compute nor read each other's
 *        aggregate.
 *
 * Fixed IST ranges are written out wherever the assertion is about bucketing,
 * so nothing depends on the day the suite runs. The cases that necessarily
 * involve "now" — fresh uploads, answered queries, queue depth — use the
 * default range (fiscal year to date) for that reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
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
import { setAiProvider } from '../src/services/ai/index.js';
import { ExtractedField } from '../src/modules/documents/extractedField.model.js';
import { QueryModel } from '../src/modules/queries/query.model.js';
import { AnalyticsCache } from '../src/modules/analytics/analyticsCache.model.js';
import {
  PAYLOAD_VERSION,
  cacheKeyOf,
  metricAssumptionsFingerprint,
} from '../src/utils/scopeKey.js';
import { env } from '../src/config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** FY2025-Q1 .. FY2026-Q1 — five quarter buckets, four of them empty. */
const ACROSS_THE_BOUNDARY = 'from=2025-04-01&to=2026-06-30&granularity=quarter';

/** FY2026-Q1, as three months and then as one quarter. */
const Q1_MONTHS = 'from=2026-04-01&to=2026-06-30&granularity=month';
const Q1_QUARTER = 'from=2026-04-01&to=2026-06-30&granularity=quarter';

async function setup() {
  const bccl = await makeSubsidiary('BCCL');
  const wcl = await makeSubsidiary('WCL');
  const secl = await makeSubsidiary('SECL');

  const cil = await makeUser({
    email: 'analytics@cil.gov.in',
    role: 'cil_user',
    subsidiaryAccess: [bccl.id],
  });
  const cilAuth = await authFor(cil.id, 'cil_user');

  const wclUser = await makeUser({
    email: 'analytics-wcl@cil.gov.in',
    role: 'cil_user',
    subsidiaryAccess: [wcl.id],
  });
  const wclAuth = await authFor(wclUser.id, 'cil_user');

  const both = await makeUser({
    email: 'analytics-both@cil.gov.in',
    role: 'cil_user',
    subsidiaryAccess: [bccl.id, wcl.id],
  });
  const bothAuth = await authFor(both.id, 'cil_user');

  const moc = await makeUser({
    email: 'analytics@moc.gov.in',
    role: 'moc_official',
    subsidiaryAccess: [bccl.id],
  });
  const mocAuth = await authFor(moc.id, 'moc_official');

  const admin = await makeUser({ email: 'analytics-admin@cil.gov.in', role: 'admin' });
  const adminAuth = await authFor(admin.id, 'admin');

  return {
    bccl,
    wcl,
    secl,
    cil,
    cilAuth,
    wclUser,
    wclAuth,
    both,
    bothAuth,
    moc,
    mocAuth,
    admin,
    adminAuth,
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function getAnalytics(auth: { header: Record<string, string> }, query = '') {
  return api().get(`/api/v1/analytics${query ? `?${query}` : ''}`).set(auth.header);
}

/**
 * Extracted fields are bucketed on their OWN createdAt, and Mongoose treats a
 * timestamp path as immutable on update — so the date has to be written at
 * insert time with `timestamps: false`, exactly as the chunk fixture does.
 */
async function plantFields(opts: {
  documentId: string;
  subsidiaryId: string;
  createdAt: Date;
  count: number;
  overridden: number;
  overriddenBy: string;
  prefix?: string;
}): Promise<string[]> {
  const rows = Array.from({ length: opts.count }, (_, i) => ({
    documentId: new Types.ObjectId(opts.documentId),
    subsidiaryId: new Types.ObjectId(opts.subsidiaryId),
    fieldName: `${opts.prefix ?? 'field'}-${i}`,
    value: String(1000 + i),
    confidenceScore: 0.9,
    isDeleted: false,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
    ...(i < opts.overridden
      ? {
          overriddenBy: new Types.ObjectId(opts.overriddenBy),
          overrideReason: 'planted correction',
          overriddenAt: opts.createdAt,
          originalValue: 'original',
        }
      : {}),
  }));
  const inserted = await ExtractedField.insertMany(rows, { timestamps: false });
  return inserted.map((f) => String(f._id));
}

/**
 * The series comes back as JSON, so a local shape keeps the assertions typed
 * without importing the service's `Block | null` unions and sprinkling a
 * non-null assertion over every metric.
 */
type MetricBlock = Record<string, number | null>;
interface SeriesRow {
  bucket: string;
  label: string;
  bucketStart: string;
  bucketEnd: string;
  documents: MetricBlock;
  extraction: MetricBlock;
  reports: MetricBlock;
  queries: MetricBlock;
  automationCoveragePercent: number | null;
  timeSavedPercent: number | null;
}

const bucket = (body: { data: { series: SeriesRow[] } }, key: string): SeriesRow | undefined =>
  body.data.series.find((b) => b.bucket === key);

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /analytics — access and shape (PRD §4.6, §10.3)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('requires authentication', async () => {
    const res = await api().get('/api/v1/analytics').expect(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns series, totals, breakdown, pipeline health, assumptions and freshness', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
    });

    const res = await getAnalytics(ctx.cilAuth).expect(200);

    expect(res.body.success).toBe(true);
    for (const key of [
      'series',
      'totals',
      'bySubsidiary',
      'pipeline',
      'assumptions',
      'computedAt',
      'cached',
      'range',
      'scope',
    ]) {
      expect(res.body.data).toHaveProperty(key);
    }
    expect(res.body.data.range.timezone).toContain('+05:30');
    expect(res.body.data.range.fiscalYearStartMonth).toBe(4);
    // The assumptions travel WITH the figures: a derived percentage whose
    // assumptions are invisible is not a traceable figure (§4.6).
    expect(res.body.data.assumptions.baselineManualMinutesPerDoc).toBe(
      env.BASELINE_MANUAL_MINUTES_PER_DOC,
    );
    expect(res.body.data.assumptions.extractionAccuracyDefinition).toContain('overridden');
    expect(res.body.data.totals.documents.total).toBe(1);
    // An empty queue has no age — null, not 0, which would read as "something
    // has been waiting for no time at all".
    expect(res.body.data.pipeline.oldestQueuedAgeSeconds).toBeNull();
  });

  it('is readable by all three roles inside their own scope', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
    });

    const cil = await getAnalytics(ctx.cilAuth).expect(200);
    const moc = await getAnalytics(ctx.mocAuth).expect(200);
    const admin = await getAnalytics(ctx.adminAuth).expect(200);

    expect(cil.body.data.scope.subsidiaryIds).toEqual([ctx.bccl.id]);
    expect(cil.body.data.scope.unscoped).toBe(false);
    // §2 grants MoC officials analytics explicitly; they are scoped like a CIL
    // user, not unscoped like an admin.
    expect(moc.body.data.scope.subsidiaryIds).toEqual([ctx.bccl.id]);
    expect(moc.body.data.scope.unscoped).toBe(false);
    expect(admin.body.data.scope.unscoped).toBe(true);
    expect(admin.body.data.totals.documents.total).toBe(1);
  });

  it('reports a block the caller did not request as null, not as a block of zeroes', async () => {
    const res = await getAnalytics(ctx.cilAuth, 'include=documents').expect(200);

    expect(res.body.data.totals.documents).not.toBeNull();
    // "You did not ask for this" and "this period had none" are different
    // statements and must not render the same.
    expect(res.body.data.totals.extraction).toBeNull();
    expect(res.body.data.totals.queries).toBeNull();
    // Both cross-section figures need documents AND extraction to mean
    // anything, so a half-present denominator yields null rather than a number.
    expect(res.body.data.totals.automationCoveragePercent).toBeNull();
    expect(res.body.data.totals.timeSavedPercent).toBeNull();
  });
});

describe('GET /analytics — IST bucketing and zero-fill (D13, D14, PRD §4.6)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('lands a document created at 19:00 UTC on 31 March in FY2026-Q1, not FY2025-Q4', async () => {
    // 00:30 IST on 1 April 2026 — the first half hour of the new Indian
    // fiscal year. Bucketed in UTC it would fall a quarter earlier, which is
    // the whole reason §4.6 pins the timezone rather than leaving it implicit.
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
      createdAt: new Date('2026-03-31T19:00:00.000Z'),
    });

    const res = await getAnalytics(ctx.cilAuth, ACROSS_THE_BOUNDARY).expect(200);

    expect(res.body.data.range.buckets).toEqual([
      'FY2025-Q1',
      'FY2025-Q2',
      'FY2025-Q3',
      'FY2025-Q4',
      'FY2026-Q1',
    ]);
    expect(bucket(res.body, 'FY2026-Q1')!.documents.total).toBe(1);
    expect(bucket(res.body, 'FY2026-Q1')!.label).toBe('FY2026-27 Q1');
    expect(bucket(res.body, 'FY2025-Q4')!.documents.total).toBe(0);
    expect(res.body.data.totals.documents.total).toBe(1);
  });

  it('fills an empty period with 0 for counts and null for ratios, never 0% accuracy', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
      createdAt: new Date('2026-03-31T19:00:00.000Z'),
    });

    const res = await getAnalytics(ctx.cilAuth, ACROSS_THE_BOUNDARY).expect(200);
    const empty = bucket(res.body, 'FY2025-Q2')!;

    // Counts: zero documents in a quarter is a TRUE statement.
    expect(empty.documents.total).toBe(0);
    expect(empty.documents.validated).toBe(0);
    expect(empty.extraction.totalFields).toBe(0);
    expect(empty.queries.total).toBe(0);
    expect(empty.reports.published).toBe(0);

    // Ratios: a plotted 0% accuracy for a quarter with no extractions is a
    // FABRICATED figure — the defect D13 exists to prevent. Asserted both
    // ways round, because `null` and `0` are both falsy and a refactor that
    // coerced one into the other would pass a truthiness check.
    expect(empty.extraction.accuracyPercent).toBeNull();
    expect(empty.extraction.accuracyPercent).not.toBe(0);
    expect(empty.documents.avgOcrConfidence).toBeNull();
    expect(empty.extraction.avgConfidence).toBeNull();
    expect(empty.queries.citationCoveragePercent).toBeNull();
    expect(empty.queries.citationIntegrityPercent).toBeNull();
    expect(empty.automationCoveragePercent).toBeNull();
    expect(empty.timeSavedPercent).toBeNull();
  });

  it('carries the half-open UTC window of each bucket, so a chart axis re-derives nothing', async () => {
    const res = await getAnalytics(ctx.cilAuth, Q1_QUARTER).expect(200);
    const q1 = bucket(res.body, 'FY2026-Q1')!;

    // 1 April 2026 00:00 IST and 1 July 2026 00:00 IST, expressed in UTC.
    expect(q1.bucketStart).toBe('2026-03-31T18:30:00.000Z');
    expect(q1.bucketEnd).toBe('2026-06-30T18:30:00.000Z');
  });
});

describe('GET /analytics — metric folding (D11, PRD §4.6)', () => {
  let ctx: Ctx;
  let documentId: string;

  beforeEach(async () => {
    ctx = await setup();
    ({ documentId } = await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
      createdAt: new Date('2026-04-10T06:00:00.000Z'),
    }));

    // April: 10 fields, 1 overridden -> 90%
    // May:    4 fields, 2 overridden -> 50%
    // June:   6 fields, 3 overridden -> 50%
    // Quarter: 20 fields, 6 overridden -> 70%, NOT (90+50+50)/3 = 63.3.
    await plantFields({
      documentId,
      subsidiaryId: ctx.bccl.id,
      createdAt: new Date('2026-04-10T06:00:00.000Z'),
      count: 10,
      overridden: 1,
      overriddenBy: ctx.cil.id,
      prefix: 'apr',
    });
    await plantFields({
      documentId,
      subsidiaryId: ctx.bccl.id,
      createdAt: new Date('2026-05-10T06:00:00.000Z'),
      count: 4,
      overridden: 2,
      overriddenBy: ctx.cil.id,
      prefix: 'may',
    });
    await plantFields({
      documentId,
      subsidiaryId: ctx.bccl.id,
      createdAt: new Date('2026-06-10T06:00:00.000Z'),
      count: 6,
      overridden: 3,
      overriddenBy: ctx.cil.id,
      prefix: 'jun',
    });
  });

  it('reports each month from its own counters', async () => {
    const res = await getAnalytics(ctx.cilAuth, Q1_MONTHS).expect(200);

    expect(res.body.data.range.buckets).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(bucket(res.body, '2026-04')!.extraction).toMatchObject({
      totalFields: 10,
      overriddenFields: 1,
      accuracyPercent: 90,
    });
    expect(bucket(res.body, '2026-05')!.extraction.accuracyPercent).toBe(50);
    expect(bucket(res.body, '2026-06')!.extraction.accuracyPercent).toBe(50);
  });

  it('folds a quarter by summing counters, not by averaging the monthly percentages', async () => {
    const res = await getAnalytics(ctx.cilAuth, Q1_QUARTER).expect(200);
    const q1 = bucket(res.body, 'FY2026-Q1')!;

    expect(q1.extraction.totalFields).toBe(20);
    expect(q1.extraction.overriddenFields).toBe(6);
    // 14/20. Averaging the three monthly percentages gives 63.3 and weights a
    // quiet May equally with a busy April — a plausible wrong number, which is
    // the failure §4.6 is most concerned with.
    expect(q1.extraction.accuracyPercent).toBe(70);
    expect(q1.extraction.accuracyPercent).not.toBeCloseTo(63.3, 1);
    // Totals come from the pipeline's own `_id: null` group, not from folding
    // the series, and must agree with it.
    expect(res.body.data.totals.extraction.accuracyPercent).toBe(70);
  });

  it('agrees with the dashboard snapshot over the same corpus (the shared metricFormulas)', async () => {
    // Both surfaces are asked about the same rows: the dashboard is unranged,
    // so the analytics range is widened to cover the planted dates and today.
    const analytics = await getAnalytics(
      ctx.cilAuth,
      'from=2026-04-01&to=2027-03-31&granularity=quarter',
    ).expect(200);
    const dashboard = await api()
      .get('/api/v1/dashboard/metrics')
      .set(ctx.cilAuth.header)
      .expect(200);

    const t = analytics.body.data.totals;
    const d = dashboard.body.data;

    // Pinned first, so "they agree" cannot be satisfied by two empty corpora.
    expect(d.documentsTotal).toBe(1);
    expect(d.extractionAccuracyPercent).toBe(70);

    expect(t.documents.total).toBe(d.documentsTotal);
    expect(t.documents.validated).toBe(d.documentsValidated);
    expect(t.documents.failed).toBe(d.documentsFailed);
    expect(t.documents.awaitingReview).toBe(d.documentsAwaitingReview);
    // The definitions live in exactly one module (D11). Two surfaces reporting
    // different accuracy for the same period is what that extraction prevents.
    expect(t.extraction.accuracyPercent).toBe(d.extractionAccuracyPercent);
    expect(t.automationCoveragePercent).toBe(d.automationCoveragePercent);
    expect(t.timeSavedPercent).toBe(d.timeSavedPercent);
  });
});

describe('GET /analytics — caching and assumptions (D12, PRD §4.6)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('serves the second identical call from cache with an unchanged computedAt', async () => {
    const first = await getAnalytics(ctx.cilAuth, Q1_QUARTER).expect(200);
    const second = await getAnalytics(ctx.cilAuth, Q1_QUARTER).expect(200);

    expect(first.body.data.cached).toBe(false);
    expect(second.body.data.cached).toBe(true);
    expect(second.body.data.computedAt).toBe(first.body.data.computedAt);
  });

  it('keys the cache on the request parameters, not only on the caller scope', async () => {
    await getAnalytics(ctx.cilAuth, Q1_QUARTER).expect(200);
    await getAnalytics(ctx.cilAuth, Q1_MONTHS).expect(200);
    await getAnalytics(ctx.cilAuth, 'from=2026-04-01&to=2026-09-30&granularity=quarter').expect(200);
    await getAnalytics(ctx.cilAuth, `${Q1_QUARTER}&includeBySubsidiary=false`).expect(200);

    // One caller's Q1 must never be served as another's Q3.
    const keys = (await AnalyticsCache.find().lean()).map((c) => c.cacheKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('invalidates the cached series when an extracted field is overridden', async () => {
    const { documentId } = await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
    });
    const fieldIds = await plantFields({
      documentId,
      subsidiaryId: ctx.bccl.id,
      createdAt: new Date(),
      count: 10,
      overridden: 0,
      overriddenBy: ctx.cil.id,
    });

    const before = await getAnalytics(ctx.cilAuth).expect(200);
    expect(before.body.data.totals.extraction.accuracyPercent).toBe(100);

    await api()
      .patch(`/api/v1/extracted-fields/${fieldIds[0]}`)
      .set(ctx.cilAuth.header)
      .send({ value: '999', reason: 'wrong figure' })
      .expect(200);
    // The override's cache invalidation is fire-and-forget, so let the deferred
    // write land before reading the figure it is supposed to have dropped.
    await drainAll();

    const after = await getAnalytics(ctx.cilAuth).expect(200);
    expect(after.body.data.cached).toBe(false);
    // An override is the operator saying the extraction was wrong, so accuracy
    // must fall — a stale 100% here is §4.6's traceability defect exactly.
    expect(after.body.data.totals.extraction.accuracyPercent).toBe(90);
  });

  it('changes the cache key when a metric assumption is retuned', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
    });
    const { documentId } = await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery overburden ratio steady.',
    });
    await plantFields({
      documentId,
      subsidiaryId: ctx.bccl.id,
      createdAt: new Date(),
      count: 10,
      overridden: 1,
      overriddenBy: ctx.cil.id,
    });

    const first = await getAnalytics(ctx.cilAuth).expect(200);
    expect(first.body.data.cached).toBe(false);
    expect((await getAnalytics(ctx.cilAuth).expect(200)).body.data.cached).toBe(true);

    // Two documents at the default 45 minutes each, against one 3-minute
    // override: 87/90 = 96.7%.
    expect(first.body.data.totals.timeSavedPercent).toBe(96.7);

    const tunable = env as unknown as { BASELINE_MANUAL_MINUTES_PER_DOC: number };
    const original = tunable.BASELINE_MANUAL_MINUTES_PER_DOC;
    try {
      tunable.BASELINE_MANUAL_MINUTES_PER_DOC = 5;
      const retuned = await getAnalytics(ctx.cilAuth).expect(200);

      // The whole point of D12: the retuned figure is computed fresh rather
      // than served from a cache entry built under the old constant for a
      // full TTL.
      expect(retuned.body.data.cached).toBe(false);
      expect(retuned.body.data.totals.timeSavedPercent).toBe(70);
      expect(retuned.body.data.assumptions.baselineManualMinutesPerDoc).toBe(5);
    } finally {
      tunable.BASELINE_MANUAL_MINUTES_PER_DOC = original;
    }
  });

  it('derives a bounded, unambiguous cache key (a unit test on cacheKeyOf)', () => {
    const parts = [
      'analytics',
      PAYLOAD_VERSION,
      metricAssumptionsFingerprint(),
      'sub:aaaaaaaaaaaaaaaaaaaaaaaa',
      'quarter',
      '2026-04-01',
      '2026-06-30',
      'all',
      'true',
    ];
    const baseline = cacheKeyOf(parts);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);

    // The NUL separator is what stops two different part lists joining into
    // the same string.
    expect(cacheKeyOf(['sub:a,b', 'X'])).not.toBe(cacheKeyOf(['sub:a', 'bX']));

    const tunable = env as unknown as { BASELINE_MANUAL_MINUTES_PER_DOC: number };
    const original = tunable.BASELINE_MANUAL_MINUTES_PER_DOC;
    try {
      tunable.BASELINE_MANUAL_MINUTES_PER_DOC = original + 15;
      const retuned = cacheKeyOf([
        parts[0]!,
        parts[1]!,
        metricAssumptionsFingerprint(),
        ...parts.slice(3),
      ]);
      expect(retuned).not.toBe(baseline);
    } finally {
      tunable.BASELINE_MANUAL_MINUTES_PER_DOC = original;
    }

    // Restoring the constant restores the fingerprint, so the assertion above
    // was about the assumption and not about some other drift.
    expect(cacheKeyOf([parts[0]!, parts[1]!, metricAssumptionsFingerprint(), ...parts.slice(3)])).toBe(
      baseline,
    );
  });
});

describe('GET /analytics — subsidiary scoping (PRD §9.1, §4.6)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('gives two callers with disjoint grants their own corpus, not each other cached one', async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeDocumentWithChunks({
        subsidiaryId: ctx.bccl.id,
        uploadedBy: ctx.cil.id,
        text: 'Colliery production tonnage rose.',
      });
    }
    await makeDocumentWithChunks({
      subsidiaryId: ctx.wcl.id,
      uploadedBy: ctx.wclUser.id,
      text: 'Lignitefield extraction summary.',
    });

    // BCCL warms the cache first, so a shared key would show up as WCL reading
    // BCCL's larger corpus.
    const bccl = await getAnalytics(ctx.cilAuth).expect(200);
    const wcl = await getAnalytics(ctx.wclAuth).expect(200);

    expect(bccl.body.data.totals.documents.total).toBe(3);
    expect(wcl.body.data.totals.documents.total).toBe(1);

    const keys = (await AnalyticsCache.find().lean()).map((c) => c.cacheKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('breaks down exactly the subsidiaries the caller holds and no others', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
    });
    await makeDocumentWithChunks({
      subsidiaryId: ctx.wcl.id,
      uploadedBy: ctx.wclUser.id,
      text: 'Lignitefield extraction summary.',
    });
    // A third subsidiary the two-grant caller does not hold at all.
    await makeDocumentWithChunks({
      subsidiaryId: ctx.secl.id,
      uploadedBy: ctx.admin.id,
      text: 'Seclonly haulage report.',
    });

    const res = await getAnalytics(ctx.bothAuth).expect(200);

    expect(res.body.data.bySubsidiary.map((r: { code: string }) => r.code)).toEqual(['BCCL', 'WCL']);
    expect(res.body.data.bySubsidiary.map((r: { subsidiaryId: string }) => r.subsidiaryId)).not.toContain(
      ctx.secl.id,
    );
    expect(res.body.data.totals.documents.total).toBe(2);
  });

  it('narrows to a requested subsidiary and refuses one the caller does not hold with 404', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Colliery production tonnage rose.',
    });
    await makeDocumentWithChunks({
      subsidiaryId: ctx.wcl.id,
      uploadedBy: ctx.wclUser.id,
      text: 'Lignitefield extraction summary.',
    });

    const narrowed = await getAnalytics(ctx.bothAuth, `subsidiaryId=${ctx.bccl.id}`).expect(200);
    expect(narrowed.body.data.totals.documents.total).toBe(1);
    expect(narrowed.body.data.scope.subsidiaryIds).toEqual([ctx.bccl.id]);

    // 404 rather than 403: a caller must not learn that SECL exists.
    const denied = await getAnalytics(ctx.bothAuth, `subsidiaryId=${ctx.secl.id}`).expect(404);
    expect(denied.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /analytics — query telemetry (PRD §1.5, §9.5)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(() => {
    setAiProvider(null);
  });

  it('excludes unsupported answers from citation coverage and drops integrity on a discard', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Quartzite seam thickness measured at the eastern block.',
    });

    // 1. A clean answer: one claimed ref, one accepted citation.
    setAiProvider(hostileProvider());
    const clean = await askAndDrain(ctx.cilAuth, {
      questionText: 'What quartzite seam thickness was measured in the eastern block?',
    });
    expect(clean.status).toBe('answered');

    // 2. A provider claiming one real ref and one it was never issued:
    //    accepted 1, discarded 1. Both must be CLAIMED — a ref that appears
    //    only in the prose is no longer promoted to a citation, because that
    //    was the path a hostile document used to forge one.
    setAiProvider(hostileProvider({ citedRefs: ['S1', 'S999'] }));
    const partial = await askAndDrain(ctx.cilAuth, {
      questionText: 'Which quartzite seam was recorded by the survey team?',
    });
    expect(partial.status).toBe('answered');
    expect(partial.retrieval).toMatchObject({ discardedCitations: 1 });

    // 3. A question nothing in the corpus can answer.
    setAiProvider(hostileProvider());
    const unsupported = await askAndDrain(ctx.cilAuth, {
      questionText: 'Explain the wombat marsupial migration timetable in full detail.',
    });
    expect(unsupported.status).toBe('unsupported');

    const res = await getAnalytics(ctx.cilAuth).expect(200);
    const q = res.body.data.totals.queries;

    expect(q).toMatchObject({
      total: 3,
      answered: 2,
      unsupported: 1,
      withCitations: 2,
      citationsAccepted: 2,
      citationsDiscarded: 1,
    });

    // §1.5's target measures ANSWERS that carry a citation. Counting the
    // unsupported row in the denominator would report 66.7% and read as a
    // citation failure, when the honest refusal is the system working.
    expect(q.citationCoveragePercent).toBe(100);
    // §9.5's fabricated-citation alarm is a DIFFERENT number, and it must move
    // when a provider claims a source it was never given.
    expect(q.citationIntegrityPercent).toBe(66.7);
    expect(q.citationIntegrityPercent).toBeLessThan(100);
  });

  it('counts a parliamentary query awaiting review', async () => {
    await makeDocumentWithChunks({
      subsidiaryId: ctx.bccl.id,
      uploadedBy: ctx.cil.id,
      text: 'Quartzite seam thickness measured at the eastern block.',
    });
    setAiProvider(hostileProvider());
    await askAndDrain(ctx.cilAuth, {
      questionText: 'What quartzite seam thickness was measured in the eastern block?',
      isParliamentary: true,
    });

    const q = (await getAnalytics(ctx.cilAuth).expect(200)).body.data.totals.queries;
    expect(q.parliamentary).toBe(1);
    expect(q.pendingReview).toBe(1);
  });
});

describe('GET /analytics — pipeline health (instructions §4a)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('exports queue depth and the age of the oldest waiting job', async () => {
    // Without these numbers a wedged pipeline draws exactly the same chart as
    // an idle one: "no documents processed this quarter" is the same line
    // whether nobody uploaded anything or the worker died at 03:00.
    const waitingSince = new Date(Date.now() - 120_000);
    await QueryModel.insertMany(
      [
        {
          askedBy: new Types.ObjectId(ctx.cil.id),
          contextScope: {
            subsidiaryIds: [new Types.ObjectId(ctx.bccl.id)],
            documentIds: [],
          },
          subsidiaryId: new Types.ObjectId(ctx.bccl.id),
          questionText: 'A question that has been waiting in the queue.',
          isParliamentary: false,
          status: 'queued',
          createdAt: waitingSince,
          updatedAt: waitingSince,
        },
        {
          askedBy: new Types.ObjectId(ctx.cil.id),
          contextScope: {
            subsidiaryIds: [new Types.ObjectId(ctx.bccl.id)],
            documentIds: [],
          },
          subsidiaryId: new Types.ObjectId(ctx.bccl.id),
          questionText: 'A question whose generation failed until it was abandoned.',
          isParliamentary: false,
          status: 'dead_lettered',
          attempts: 3,
          failureReason: 'Answer generation failed repeatedly; manual review required',
          createdAt: waitingSince,
          updatedAt: waitingSince,
        },
      ],
      { timestamps: false },
    );

    const res = await getAnalytics(ctx.cilAuth).expect(200);
    const pipeline = res.body.data.pipeline;

    expect(pipeline.queriesQueued).toBe(1);
    expect(pipeline.queriesDeadLettered).toBe(1);
    expect(pipeline.queriesInFlight).toBe(0);
    expect(pipeline.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(115);
    expect(pipeline.oldestQueuedAgeSeconds).toBeLessThan(300);

    // The health block is deliberately NOT date-ranged: a job stuck since last
    // quarter is exactly the one an operator needs to see.
    const narrow = await getAnalytics(ctx.cilAuth, Q1_QUARTER).expect(200);
    expect(narrow.body.data.pipeline.queriesDeadLettered).toBe(1);
  });

  it('does not report another subsidiary stuck jobs to a caller who cannot see them', async () => {
    await QueryModel.insertMany(
      [
        {
          askedBy: new Types.ObjectId(ctx.wclUser.id),
          contextScope: { subsidiaryIds: [new Types.ObjectId(ctx.wcl.id)], documentIds: [] },
          subsidiaryId: new Types.ObjectId(ctx.wcl.id),
          questionText: 'A WCL question abandoned after repeated failures.',
          isParliamentary: false,
          status: 'dead_lettered',
          attempts: 3,
        },
      ],
      { timestamps: false },
    );

    const res = await getAnalytics(ctx.cilAuth).expect(200);
    expect(res.body.data.pipeline.queriesDeadLettered).toBe(0);
  });
});

describe('GET /analytics — request bounds (PRD §9.8, §9.2)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('rejects a range that ends before it starts as INVALID_REQUEST, not VALIDATION_ERROR', async () => {
    // §9.8's own worked example: two well-formed dates that do not make a
    // range. Shape is Zod's job; coherence is the service's.
    const res = await getAnalytics(ctx.cilAuth, 'from=2026-06-30&to=2026-04-01').expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a range covering more buckets than ANALYTICS_MAX_BUCKETS', async () => {
    // A cheap authenticated request must not be able to schedule a hundred
    // group stages per collection (§9.2).
    const res = await getAnalytics(
      ctx.cilAuth,
      'from=2020-01-01&to=2026-01-01&granularity=month',
    ).expect(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(res.body.error.message).toContain(String(env.ANALYTICS_MAX_BUCKETS));

    // Five fiscal years at quarter granularity is 20 buckets — inside the
    // ceiling, and served. The cap must bound the request, not quietly become
    // a second, stricter default.
    await getAnalytics(ctx.cilAuth, 'from=2021-04-01&to=2026-03-31&granularity=quarter').expect(200);
  });

  it('rejects a malformed date shape as VALIDATION_ERROR', async () => {
    const res = await getAnalytics(ctx.cilAuth, 'from=2026-4-1').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed subsidiary id as VALIDATION_ERROR', async () => {
    const res = await getAnalytics(ctx.cilAuth, 'subsidiaryId=not-an-id').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
