/**
 * Dashboard tests — PRD §5.3, §4.6.
 *
 * The cache-scoping test is the important one: a cached aggregate must never
 * be readable by a user whose subsidiaries it was not computed over.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { api, makeUser, makeSubsidiary, authFor, askAndDrain } from './helpers.js';
import { setStorageAdapter } from '../src/services/storage/index.js';
import { createLocalStorageAdapter } from '../src/services/storage/local.adapter.js';
import { drainProcessing } from '../src/modules/documents/document.worker.js';
import { MetricsCache } from '../src/modules/dashboard/metricsCache.model.js';

let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'gmx-dash-'));
  setStorageAdapter(createLocalStorageAdapter(storageRoot));
});

afterAll(async () => {
  setStorageAdapter(null);
  await rm(storageRoot, { recursive: true, force: true });
});

const CSV = 'Production Tonnes: 125000\nGrade: G7\n';

async function setup() {
  const bccl = await makeSubsidiary('BCCL');
  const wcl = await makeSubsidiary('WCL');

  const cil = await makeUser({ email: 'dash@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
  const cilAuth = await authFor(cil.id, 'cil_user');

  const other = await makeUser({ email: 'dash2@cil.gov.in', role: 'cil_user', subsidiaryAccess: [wcl.id] });
  const otherAuth = await authFor(other.id, 'cil_user');

  return { bccl, wcl, cilAuth, otherAuth };
}

async function uploadTo(auth: { header: Record<string, string> }, subsidiaryId: string) {
  const res = await api()
    .post('/api/v1/documents')
    .set(auth.header)
    .field('subsidiaryId', subsidiaryId)
    .attach('file', Buffer.from(CSV), { filename: 'd.csv', contentType: 'text/csv' })
    .expect(201);
  await drainProcessing();
  return res.body.data.id as string;
}

describe('Dashboard (PRD §5.3)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('requires authentication', async () => {
    await api().get('/api/v1/dashboard').expect(401);
  });

  it('returns quick stats, document counts, recent reports and pending work', async () => {
    await uploadTo(ctx.cilAuth, ctx.bccl.id);

    const res = await api().get('/api/v1/dashboard').set(ctx.cilAuth.header).expect(200);

    expect(res.body.data.quickStats).toHaveProperty('extractionAccuracyPercent');
    expect(res.body.data.quickStats).toHaveProperty('timeSavedPercent');
    expect(res.body.data.quickStats).toHaveProperty('automationCoveragePercent');
    expect(res.body.data.documents.total).toBe(1);
    expect(Array.isArray(res.body.data.recentReports)).toBe(true);
    expect(Array.isArray(res.body.data.pendingWork)).toBe(true);
  });

  it('reports how fresh the figures are (§4.6)', async () => {
    const res = await api().get('/api/v1/dashboard').set(ctx.cilAuth.header).expect(200);
    // A stale figure shown as live is a traceability defect, so freshness
    // must travel with the numbers.
    expect(res.body.data.quickStats.computedAt).toBeTruthy();
    expect(res.body.data.quickStats).toHaveProperty('cached');
  });

  it('caches the computation and serves the second call from cache', async () => {
    const first = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);
    const second = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);

    expect(first.body.data.cached).toBe(false);
    expect(second.body.data.cached).toBe(true);
    expect(second.body.data.computedAt).toBe(first.body.data.computedAt);
  });

  it('drops the cached figures when a document finishes processing', async () => {
    /**
     * THE BUG. `MetricsCache` predates the shared cache helper and stores its
     * figures as flat columns rather than an opaque payload, so it carried no
     * record of the scope it covered — and `invalidateForSubsidiary`, which
     * matches on exactly that, could not see it. The result was that NOTHING
     * invalidated it: the landing page went on reporting zero documents for the
     * full `METRICS_CACHE_TTL_SECONDS` after an upload had already been read,
     * processed and validated.
     */
    const before = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);
    expect(before.body.data.documentsTotal).toBe(0);
    expect(before.body.data.cached).toBe(false);

    await uploadTo(ctx.cilAuth, ctx.bccl.id);

    const after = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);
    // Recomputed, not served from the row written a moment ago.
    expect(after.body.data.cached).toBe(false);
    expect(after.body.data.documentsTotal).toBe(1);
    expect(after.body.data.documentsValidated).toBe(1);
  });

  it('scopes cached metrics per subsidiary — no cross-tenant leakage', async () => {
    await uploadTo(ctx.cilAuth, ctx.bccl.id);

    const mine = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);
    const theirs = await api().get('/api/v1/dashboard/metrics').set(ctx.otherAuth.header).expect(200);

    expect(mine.body.data.documentsTotal).toBe(1);
    // The WCL user must not see BCCL's document in their aggregate, even
    // though a cache entry already exists.
    expect(theirs.body.data.documentsTotal).toBe(0);

    const keys = (await MetricsCache.find().lean()).map((c) => c.scopeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('reports 0% accuracy rather than a fabricated 100% when there is no data', async () => {
    const res = await api().get('/api/v1/dashboard/metrics').set(ctx.otherAuth.header).expect(200);

    expect(res.body.data.documentsTotal).toBe(0);
    // With no extractions there is no evidence either way; claiming perfect
    // accuracy would be a fabricated success.
    expect(res.body.data.extractionAccuracyPercent).toBe(0);
  });

  it('counts an overridden field against extraction accuracy', async () => {
    const docId = await uploadTo(ctx.cilAuth, ctx.bccl.id);

    const fields = await api()
      .get(`/api/v1/documents/${docId}/extracted-fields`)
      .set(ctx.cilAuth.header)
      .expect(200);

    await api()
      .patch(`/api/v1/extracted-fields/${fields.body.data[0].id}`)
      .set(ctx.cilAuth.header)
      .send({ value: '999', reason: 'wrong figure' })
      .expect(200);

    await MetricsCache.deleteMany({}); // force recomputation
    const res = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);

    expect(res.body.data.extractionAccuracyPercent).toBeLessThan(100);
    expect(res.body.data.extractionAccuracyPercent).toBeGreaterThan(0);
  });

  it('surfaces documents needing review as pending work', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
    await api()
      .post('/api/v1/documents')
      .set(ctx.cilAuth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', pdf, { filename: 'scan.pdf', contentType: 'application/pdf' })
      .expect(201);
    await drainProcessing();

    const res = await api().get('/api/v1/dashboard').set(ctx.cilAuth.header).expect(200);
    expect(res.body.data.pendingWork.length).toBeGreaterThan(0);
    expect(res.body.data.pendingWork[0].reason).toMatch(/Low-confidence/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — the pending-work panel gains queries, and the metrics gain a
// second surface that must agree with this one (spec §12.8).
// ─────────────────────────────────────────────────────────────────────────────

describe('Dashboard, Phase 2 (PRD §5.3, §4.6)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('lists a parliamentary query awaiting review as pending work', async () => {
    // No corpus: `reviewStatus` is set when the question is ASKED, so the
    // review backlog exists whether or not the answer turned out to be
    // supported. That is the point of the panel.
    const asked = await askAndDrain(ctx.cilAuth, {
      questionText: 'What production tonnage did the subsidiary record last quarter?',
      isParliamentary: true,
    });
    expect(asked.reviewStatus).toBe('pending');

    const res = await api().get('/api/v1/dashboard').set(ctx.cilAuth.header).expect(200);
    expect(res.body.success).toBe(true);

    const rows = res.body.data.pendingWork as { kind: string; id: string; reason: string }[];
    const row = rows.find((w) => w.kind === 'query');

    // Closes the Phase 1 note in dashboard.service.ts: the panel used to hold
    // documents only, so a parliamentary answer could sit unapproved with
    // nothing on the landing page saying so.
    expect(row).toBeDefined();
    expect(row!.id).toBe(asked.id as string);
    expect(row!.reason).toBe('Answer awaiting review');
  });

  it('counts a pending query in the metrics snapshot', async () => {
    await askAndDrain(ctx.cilAuth, {
      questionText: 'What production tonnage did the subsidiary record last quarter?',
      isParliamentary: true,
    });

    const res = await api().get('/api/v1/dashboard/metrics').set(ctx.cilAuth.header).expect(200);
    expect(res.body.data.queriesPendingReview).toBe(1);
  });

  it("keeps another subsidiary's pending query out of the panel", async () => {
    await askAndDrain(ctx.cilAuth, {
      questionText: 'What production tonnage did the subsidiary record last quarter?',
      isParliamentary: true,
    });

    const res = await api().get('/api/v1/dashboard').set(ctx.otherAuth.header).expect(200);
    expect(res.body.data.pendingWork).toHaveLength(0);
    const metrics = await api().get('/api/v1/dashboard/metrics').set(ctx.otherAuth.header).expect(200);
    expect(metrics.body.data.queriesPendingReview).toBe(0);
  });

  /**
   * D11 IN ONE ASSERTION.
   *
   * The landing card and the §4.6 chart derive their percentages from the same
   * `metricFormulas.ts` functions, so for the same corpus and the same period
   * they must print the same digits. This is exactly what drifts unnoticed
   * once someone restates a definition in a header comment: both surfaces keep
   * returning plausible numbers, and only a reader comparing two screens ever
   * notices they disagree.
   *
   * The corpus is deliberately lopsided — two documents, one corrected field —
   * so accuracy and time-saved land away from 0 and 100, where an accidental
   * agreement would prove nothing.
   */
  it('prints the same figures as /analytics totals for the same corpus', async () => {
    const corrected = await uploadTo(ctx.cilAuth, ctx.bccl.id);
    await uploadTo(ctx.cilAuth, ctx.bccl.id);

    const fields = await api()
      .get(`/api/v1/documents/${corrected}/extracted-fields`)
      .set(ctx.cilAuth.header)
      .expect(200);

    await api()
      .patch(`/api/v1/extracted-fields/${fields.body.data[0].id}`)
      .set(ctx.cilAuth.header)
      .send({ value: '999', reason: 'wrong figure' })
      .expect(200);

    // Neither cache has been warmed in this test, so both surfaces compute
    // from the corpus as it stands now rather than from a stale entry.
    const dash = await api().get('/api/v1/dashboard').set(ctx.cilAuth.header).expect(200);
    const analytics = await api().get('/api/v1/analytics').set(ctx.cilAuth.header).expect(200);

    const stats = dash.body.data.quickStats;
    const totals = analytics.body.data.totals;

    // The COUNTERS the formulas consume must agree before the percentages
    // they produce can mean anything.
    expect(dash.body.data.documents.total).toBe(totals.documents.total);
    expect(dash.body.data.documents.validated).toBe(totals.documents.validated);
    expect(dash.body.data.documents.awaitingReview).toBe(totals.documents.awaitingReview);

    // Guard the guard: 0 === 0 or 100 === 100 would satisfy the lines below
    // without either surface having computed anything.
    expect(stats.extractionAccuracyPercent).toBeGreaterThan(0);
    expect(stats.extractionAccuracyPercent).toBeLessThan(100);
    expect(stats.timeSavedPercent).toBeGreaterThan(0);
    expect(stats.timeSavedPercent).toBeLessThan(100);

    expect(stats.extractionAccuracyPercent).toBe(totals.extraction.accuracyPercent);
    expect(stats.automationCoveragePercent).toBe(totals.automationCoveragePercent);
    expect(stats.timeSavedPercent).toBe(totals.timeSavedPercent);

    // Automation Coverage is at its `Math.max(0, …)` clamp for this fixture —
    // the CSV extractor's confidence sits under OCR_REVIEW_THRESHOLD, so both
    // documents are awaiting review and the numerator goes negative. The two
    // surfaces must clamp identically, which is only a real assertion because
    // the counters above were shown to match first.
    expect(stats.automationCoveragePercent).toBe(0);
  });

  it("agrees with /analytics on an empty corpus, allowing for the snapshot's ?? 0", async () => {
    const dash = await api().get('/api/v1/dashboard').set(ctx.cilAuth.header).expect(200);
    const analytics = await api().get('/api/v1/analytics').set(ctx.cilAuth.header).expect(200);

    // D13: with no evidence the SERIES/totals keep null — a plotted 0% for a
    // period with no extractions is a fabricated figure — while the snapshot
    // coerces to 0 beside visible counts that make the 0 unambiguous. The two
    // are the same statement, rendered for two different surfaces.
    expect(analytics.body.data.totals.extraction.accuracyPercent).toBeNull();
    expect(analytics.body.data.totals.automationCoveragePercent).toBeNull();
    expect(analytics.body.data.totals.timeSavedPercent).toBeNull();

    expect(dash.body.data.quickStats.extractionAccuracyPercent).toBe(0);
    expect(dash.body.data.quickStats.automationCoveragePercent).toBe(0);
    expect(dash.body.data.quickStats.timeSavedPercent).toBe(0);
  });
});
