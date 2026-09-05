/**
 * AI query endpoint tests — PRD §4.4, §5.7, §9.2, §9.5, §9.8, §9.9;
 * instructions §4a (asynchronous answering with an explicit retry).
 *
 * Answering is ASYNCHRONOUS (D1): `POST /queries` returns 201 with the row in
 * `queued` and no answer. Every test that needs an answer awaits the worker's
 * quiescence seam (`drainQueries`, usually through `askAndDrain`) rather than
 * polling a clock, so nothing here depends on timing.
 *
 * WHY THERE IS NO END-TO-END 429 TEST FOR THE NORMAL PATH: every limiter in
 * middleware/rateLimiters.ts shares `skip: () => env.isTest`, so under test a
 * request is never counted and the 429 branch is unreachable through an
 * ordinary request. The last describe block therefore lifts that skip for the
 * duration of ONE test — restoring it in a `finally` — which is the only way
 * to assert the values that actually matter (`max`, `windowMs`, and per-user
 * keying); express-rate-limit v8 exposes neither its options nor its
 * keyGenerator on the returned middleware, so they cannot be read off it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { api, makeUser, makeSubsidiary, authFor, makeDocumentWithChunks, askAndDrain } from './helpers.js';
import { env } from '../src/config/env.js';
import { setAiProvider } from '../src/services/ai/index.js';
import type { AiProvider } from '../src/services/ai/ai.types.js';
import { QueryModel } from '../src/modules/queries/query.model.js';
import { drainQueries, recoverStuckQueries } from '../src/modules/queries/query.worker.js';
import { queryRouter } from '../src/modules/queries/query.routes.js';
import { aiLimiter } from '../src/middleware/rateLimiters.js';
import { AuditLog } from '../src/modules/audit/auditLog.model.js';
import { Report } from '../src/modules/reports/report.model.js';

const BCCL_TEXT = [
  'Coal production at the Jharia mine reached 125000 tonnes during the first quarter of 2026.',
  '',
  'Overburden removal totalled 43000 cubic metres over the same reporting window.',
].join('\n');

const QUESTION = 'What was the coal production in tonnes during the first quarter?';
/** Deliberately shares no term with the corpus — the honest `unsupported` path. */
const UNMATCHED_QUESTION = 'Describe the aardvark zeppelin marmalade telemetry arrangements.';

async function setup() {
  const bccl = await makeSubsidiary('BCCL');
  const wcl = await makeSubsidiary('WCL');

  const admin = await makeUser({ email: 'qadmin@moc.gov.in', role: 'admin' });
  const adminAuth = await authFor(admin.id, 'admin');

  const cil = await makeUser({ email: 'qcil@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
  const cilAuth = await authFor(cil.id, 'cil_user');

  const moc = await makeUser({ email: 'qmoc@moc.gov.in', role: 'moc_official', subsidiaryAccess: [bccl.id] });
  const mocAuth = await authFor(moc.id, 'moc_official');

  const planted = await makeDocumentWithChunks({
    subsidiaryId: bccl.id,
    uploadedBy: cil.id,
    text: BCCL_TEXT,
    filename: 'bccl-q1.pdf',
  });

  return { bccl, wcl, admin, adminAuth, cil, cilAuth, moc, mocAuth, planted };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Plant a query row directly — the only way to pin a NON-terminal status. */
async function plantQuery(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  return QueryModel.create({
    askedBy: new Types.ObjectId(ctx.cil.id),
    contextScope: { subsidiaryIds: [new Types.ObjectId(ctx.bccl.id)], documentIds: [] },
    subsidiaryId: new Types.ObjectId(ctx.bccl.id),
    questionText: QUESTION,
    isParliamentary: false,
    maxAttempts: env.QUERY_MAX_ATTEMPTS,
    ...overrides,
  });
}

/**
 * A provider that always fails, carrying a stack-shaped, path-bearing message.
 *
 * It THROWS rather than returning a rejected promise. Both reach the same
 * `catch` in query.worker.ts and produce the same terminal state, but a
 * rejected promise additionally escapes through `withTimeout`'s untracked
 * `void p.finally(...)` derivative as an unhandled rejection, which would
 * surface as a file-level error on every failure test rather than as one
 * finding. That leak is reported separately; nothing here depends on it.
 */
function explodingProvider(): AiProvider {
  return {
    name: 'exploding-stub',
    promptVersion: 'stub-v1',
    answer: () => {
      throw new Error('ECONNREFUSED reading /var/secrets/ai.key at answer (/srv/app/provider.ts:42:11)');
    },
  };
}

afterEach(() => {
  setAiProvider(null);
});

describe('POST /api/v1/queries — the asynchronous ask (instructions §4a, D1)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('returns 201 with the query queued and no answer yet', async () => {
    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.cilAuth.header)
      .send({ questionText: QUESTION })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.responseText).toBeNull();
    expect(res.body.data.citations).toEqual([]);
    expect(res.body.data.answerStatus).toBeNull();
  });

  it('answers the query with sourced citations once the worker has run', async () => {
    const q = await askAndDrain(ctx.cilAuth, { questionText: QUESTION });

    expect(q.status).toBe('answered');
    expect(q.answerStatus).toBe('sourced');
    expect(typeof q.responseText).toBe('string');
    expect((q.responseText as string).length).toBeGreaterThan(0);

    const citations = q.citations as Record<string, unknown>[];
    expect(citations.length).toBeGreaterThan(0);
    for (const c of citations) {
      expect(c.documentId).toBe(ctx.planted.documentId);
      expect(ctx.planted.chunkIds).toContain(c.chunkId);
      expect(typeof c.chunkIndex).toBe('number');
      expect(typeof c.quote).toBe('string');
      expect((c.quote as string).length).toBeGreaterThan(0);
    }
  });

  it('keeps citation ids out of the answer prose, as structured metadata only (§8.1)', async () => {
    const q = await askAndDrain(ctx.cilAuth, { questionText: QUESTION });
    const text = q.responseText as string;
    const citations = q.citations as Record<string, string>[];

    for (const c of citations) {
      expect(text).not.toContain(c.documentId);
      expect(text).not.toContain(c.chunkId);
    }
    // The provider's placeholder must have been rewritten, never passed through.
    expect(text).not.toContain('{{ref:');
    expect(text).toContain('[1]');
  });

  it('marks a parliamentary query as pending human review and a standard one as not_required', async () => {
    const parliamentary = await askAndDrain(ctx.cilAuth, { questionText: QUESTION, isParliamentary: true });
    const standard = await askAndDrain(ctx.cilAuth, { questionText: QUESTION, isParliamentary: false });

    expect(parliamentary.reviewStatus).toBe('pending');
    expect(standard.reviewStatus).toBe('not_required');
  });

  it('produces a byte-identical answer for the same question over the same corpus', async () => {
    const first = await askAndDrain(ctx.cilAuth, { questionText: QUESTION });
    const second = await askAndDrain(ctx.cilAuth, { questionText: QUESTION });

    expect(second.responseText).toBe(first.responseText);
    expect((second.citations as unknown[]).length).toBe((first.citations as unknown[]).length);
  });

  it('reports unsupported with zero citations when no chunk matches the question', async () => {
    const q = await askAndDrain(ctx.cilAuth, { questionText: UNMATCHED_QUESTION });

    expect(q.status).toBe('unsupported');
    expect(q.answerStatus).toBe('unsupported');
    expect(q.citations).toEqual([]);
    expect(q.warnings as string[]).toContain(
      'No authorised source in scope supports an answer to this question.',
    );
  });

  it('fails with a sanitised reason when the provider throws (§9.4)', async () => {
    setAiProvider(explodingProvider());
    const q = await askAndDrain(ctx.cilAuth, { questionText: QUESTION });

    expect(q.status).toBe('failed');
    const reason = q.failureReason as string;
    expect(reason).toBe('Answer generation failed; retry available');
    // No stack frame, no provider internals, no storage path reaches the client.
    expect(reason).not.toContain('ECONNREFUSED');
    expect(reason).not.toContain('/var/secrets');
    expect(reason).not.toContain('provider.ts');
    expect(reason).not.toContain('exploding-stub');
  });

  it('records query.asked without ever writing the question text into the audit trail (§9.6)', async () => {
    await api().post('/api/v1/queries').set(ctx.cilAuth.header).send({ questionText: QUESTION }).expect(201);
    await drainQueries();

    const asked = await AuditLog.findOne({ action: 'query.asked' }).lean();
    expect(asked).not.toBeNull();
    expect(JSON.stringify(asked!.metadata)).not.toContain(QUESTION);
    expect(JSON.stringify(asked!.metadata)).not.toContain('coal production');
  });
});

describe('POST /api/v1/queries/:id/retry — the §4a lifecycle', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  async function askAndFail(): Promise<string> {
    setAiProvider(explodingProvider());
    const created = await api()
      .post('/api/v1/queries')
      .set(ctx.cilAuth.header)
      .send({ questionText: QUESTION })
      .expect(201);
    await drainQueries();
    return created.body.data.id as string;
  }

  it('moves a failed query to answered once the provider recovers', async () => {
    const id = await askAndFail();
    setAiProvider(null); // the real local adapter answers this time

    const res = await api().post(`/api/v1/queries/${id}/retry`).set(ctx.cilAuth.header).expect(200);
    expect(res.body.data.status).toBe('queued');

    await drainQueries();
    const after = await api().get(`/api/v1/queries/${id}`).set(ctx.cilAuth.header).expect(200);
    expect(after.body.data.status).toBe('answered');
    expect(after.body.data.citations.length).toBeGreaterThan(0);
  });

  it('clears the stale failure reason once a retried query succeeds', async () => {
    // A query polled as `answered` must not still be reporting why it failed:
    // §9.4's "defined failure state" is a state, and an answer is not it.
    const id = await askAndFail();
    setAiProvider(null);

    await api().post(`/api/v1/queries/${id}/retry`).set(ctx.cilAuth.header).expect(200);
    await drainQueries();

    const after = await api().get(`/api/v1/queries/${id}`).set(ctx.cilAuth.header).expect(200);
    expect(after.body.data.status).toBe('answered');
    expect(after.body.data.failureReason).toBeNull();
  });

  it('rejects a retry of an already answered query with 400 INVALID_REQUEST', async () => {
    const q = await askAndDrain(ctx.cilAuth, { questionText: QUESTION });

    const res = await api().post(`/api/v1/queries/${q.id as string}/retry`).set(ctx.cilAuth.header);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('dead-letters after QUERY_MAX_ATTEMPTS and refuses any further retry', async () => {
    const id = await askAndFail(); // attempt 1

    for (let i = 1; i < env.QUERY_MAX_ATTEMPTS; i += 1) {
      await api().post(`/api/v1/queries/${id}/retry`).set(ctx.cilAuth.header).expect(200);
      await drainQueries();
    }

    const exhausted = await QueryModel.findById(id).lean();
    expect(exhausted!.attempts).toBe(env.QUERY_MAX_ATTEMPTS);
    expect(exhausted!.status).toBe('dead_lettered');

    const res = await api().post(`/api/v1/queries/${id}/retry`).set(ctx.cilAuth.header);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('lets an administrator retry a query they did not ask, and refuses a bystander', async () => {
    const id = await askAndFail();
    const other = await makeUser({
      email: 'qother@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [ctx.bccl.id],
    });
    const otherAuth = await authFor(other.id, 'cil_user');

    // 403, not 404: the row is legitimately visible; only the ACTION is denied.
    const denied = await api().post(`/api/v1/queries/${id}/retry`).set(otherAuth.header);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    setAiProvider(null);
    await api().post(`/api/v1/queries/${id}/retry`).set(ctx.adminAuth.header).expect(200);
  });

  it('requeues a query stranded mid-generation and dead-letters an exhausted one', async () => {
    const stale = new Date(Date.now() - (env.QUERY_STUCK_TIMEOUT_MINUTES + 5) * 60_000);
    const stranded = await plantQuery(ctx, {
      status: 'answering',
      attempts: 1,
      processingStartedAt: stale,
    });
    const burnt = await plantQuery(ctx, {
      status: 'retrieving',
      attempts: env.QUERY_MAX_ATTEMPTS,
      processingStartedAt: stale,
    });
    // Interrupted seconds ago rather than minutes. Recovery runs at BOOT, so
    // there is no live worker holding it either — a redeploy takes seconds, and
    // an age guard here would strand exactly the rows a redeploy interrupts.
    const recent = await plantQuery(ctx, { status: 'answering', attempts: 1, processingStartedAt: new Date() });

    const recovered = await recoverStuckQueries();
    expect(recovered).toBe(3);

    // Attempts exhausted -> terminal, and deliberately NOT handed back to the
    // worker. The age guard is kept on this sweep only, because burning a row's
    // last attempt is destructive.
    expect((await QueryModel.findById(burnt._id).lean())!.status).toBe('dead_lettered');

    // The other two were requeued AND re-enqueued. Resetting them to `queued`
    // without re-enqueueing was the defect: nothing else calls the worker for
    // an existing row, and POST /:id/retry refuses anything that is not
    // `failed`, so `queued` was a state neither the system nor the user could
    // leave. Reaching a terminal state is the proof that the work resumed.
    await drainQueries();
    for (const id of [stranded._id, recent._id]) {
      const row = (await QueryModel.findById(id).lean())!;
      expect(['answered', 'unsupported', 'failed', 'dead_lettered']).toContain(row.status);
    }
  });
});

describe('GET /api/v1/queries — cursor pagination and scoped search (§9.8, §8.2)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  async function page(cursor?: string) {
    const url = `/api/v1/queries?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await api().get(url).set(ctx.cilAuth.header).expect(200);
    return {
      ids: (res.body.data as { id: string }[]).map((r) => r.id),
      nextCursor: res.body.pagination.nextCursor as string | null,
    };
  }

  it('pages 30 queries without repeating or skipping a row, even when one is inserted mid-paging', async () => {
    const planted: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const row = await plantQuery(ctx, { questionText: `Question number ${i} about production` });
      planted.push(String(row._id));
    }
    const expectedDescending = [...planted].reverse();

    const first = await page();
    expect(first.ids).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();

    // The property offset pagination loses: a row inserted after page 1 was
    // read must not push page 2's rows down into page 3.
    await plantQuery(ctx, { questionText: 'A brand new question asked mid-paging' });

    const second = await page(first.nextCursor!);
    const third = await page(second.nextCursor!);

    const seen = [...first.ids, ...second.ids, ...third.ids];
    expect(new Set(seen).size).toBe(30);
    expect(seen).toEqual(expectedDescending);
    expect(third.nextCursor).toBeNull();
  });

  it('keeps ?q= inside the caller’s scope, so another subsidiary’s match is absent (§8.2)', async () => {
    await plantQuery(ctx, { questionText: 'What is the photosynthesis allowance for BCCL?' });
    await QueryModel.create({
      askedBy: new Types.ObjectId(ctx.admin.id),
      contextScope: { subsidiaryIds: [new Types.ObjectId(ctx.wcl.id)], documentIds: [] },
      subsidiaryId: new Types.ObjectId(ctx.wcl.id),
      questionText: 'What is the photosynthesis allowance for WCL?',
      isParliamentary: false,
      maxAttempts: env.QUERY_MAX_ATTEMPTS,
    });

    const mine = await api()
      .get('/api/v1/queries?q=photosynthesis')
      .set(ctx.cilAuth.header)
      .expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].questionText).toContain('BCCL');

    // The admin is unscoped, so both rows are reachable — proving the term
    // itself matches and the single result above is a SCOPE effect.
    const all = await api().get('/api/v1/queries?q=photosynthesis').set(ctx.adminAuth.header).expect(200);
    expect(all.body.data).toHaveLength(2);
  });

  it('filters the log by mine=true without leaving the scope clause behind', async () => {
    await plantQuery(ctx);
    await plantQuery(ctx, { askedBy: new Types.ObjectId(ctx.moc.id) });

    const res = await api().get('/api/v1/queries?mine=true').set(ctx.cilAuth.header).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].askedBy).toBe(ctx.cil.id);
  });
});

describe('PATCH /api/v1/queries/:id — human review (§5.7, §4.2)', () => {
  let ctx: Ctx;
  let answeredId: string;

  beforeEach(async () => {
    ctx = await setup();
    const q = await askAndDrain(ctx.cilAuth, { questionText: QUESTION, isParliamentary: true });
    answeredId = q.id as string;
  });

  async function makeReport(subsidiaryId: string) {
    const report = await Report.create({
      title: 'Q1 2026 Production',
      templateId: new Types.ObjectId(),
      subsidiaryId: new Types.ObjectId(subsidiaryId),
      createdBy: new Types.ObjectId(ctx.admin.id),
      sections: [{ heading: 'Summary', body: 'Output was 125000 tonnes.' }],
    });
    return String(report._id);
  }

  it('lets an administrator approve an answer, link a report and leaves a query.reviewed audit row', async () => {
    const reportId = await makeReport(ctx.bccl.id);

    const res = await api()
      .patch(`/api/v1/queries/${answeredId}`)
      .set(ctx.adminAuth.header)
      .send({ reviewStatus: 'approved', officialResponseText: 'Output was 125000 tonnes.', linkedReportId: reportId })
      .expect(200);

    expect(res.body.data.reviewStatus).toBe('approved');
    expect(res.body.data.linkedReportId).toBe(reportId);
    expect(res.body.data.reviewedBy).toBe(ctx.admin.id);

    const audit = await AuditLog.findOne({ action: 'query.reviewed', targetId: answeredId }).lean();
    expect(audit).not.toBeNull();
  });

  it('refuses an MoC official outright with 403 (the role cannot review at all)', async () => {
    const res = await api()
      .patch(`/api/v1/queries/${answeredId}`)
      .set(ctx.mocAuth.header)
      .send({ reviewNote: 'Looks fine to me' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a CIL user attempting to APPROVE, while still allowing them to annotate', async () => {
    // Separation of duties: the person drafting a figure is not the person
    // putting it on record. 403, not 404 — the row is legitimately visible.
    const denied = await api()
      .patch(`/api/v1/queries/${answeredId}`)
      .set(ctx.cilAuth.header)
      .send({ reviewStatus: 'approved' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    await api()
      .patch(`/api/v1/queries/${answeredId}`)
      .set(ctx.cilAuth.header)
      .send({ reviewNote: 'Figure checked against the source PDF' })
      .expect(200);
  });

  it('refuses a review while the query is still queued with 400 INVALID_REQUEST', async () => {
    const queued = await plantQuery(ctx, { status: 'queued' });

    const res = await api()
      .patch(`/api/v1/queries/${String(queued._id)}`)
      .set(ctx.adminAuth.header)
      .send({ reviewStatus: 'approved' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 404 for a linkedReportId outside the query’s own context scope', async () => {
    const foreign = await makeReport(ctx.wcl.id);

    const res = await api()
      .patch(`/api/v1/queries/${answeredId}`)
      .set(ctx.adminAuth.header)
      .send({ linkedReportId: foreign });

    // 404 rather than 403: the caller is never told the report exists elsewhere.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('strips a hand-authored citations array before it reaches the service', async () => {
    const before = await QueryModel.findById(answeredId).lean();

    await api()
      .patch(`/api/v1/queries/${answeredId}`)
      .set(ctx.adminAuth.header)
      .send({
        reviewNote: 'Approved wording',
        citations: [
          {
            ordinal: 1,
            documentId: new Types.ObjectId().toString(),
            documentFilename: 'forged.pdf',
            chunkId: new Types.ObjectId().toString(),
            chunkIndex: 0,
            quote: 'A figure nobody retrieved',
            relevance: 9,
            subsidiaryId: ctx.bccl.id,
          },
        ],
      })
      .expect(200);

    const after = await QueryModel.findById(answeredId).lean();
    expect(JSON.stringify(after!.citations)).toBe(JSON.stringify(before!.citations));
    expect(JSON.stringify(after!.citations)).not.toContain('forged.pdf');
  });
});

describe('Per-endpoint failure modes (§9.2, §9.8, §9.9)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('rejects a question shorter than 10 characters', async () => {
    const res = await api().post('/api/v1/queries').set(ctx.cilAuth.header).send({ questionText: 'a'.repeat(9) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a question longer than the 2000-character cap (D9)', async () => {
    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.cilAuth.header)
      .send({ questionText: 'a'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a question of exactly 2000 characters, so the cap is inclusive', async () => {
    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.cilAuth.header)
      .send({ questionText: 'a'.repeat(2000) });
    expect(res.status).toBe(201);
    await drainQueries();
  });

  it('rejects a malformed subsidiaryId before any query reaches Mongo', async () => {
    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.cilAuth.header)
      .send({ questionText: QUESTION, subsidiaryId: 'not-an-object-id' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty PATCH body', async () => {
    const q = await plantQuery(ctx, { status: 'answered', answerStatus: 'sourced', responseText: 'x' });
    const res = await api().patch(`/api/v1/queries/${String(q._id)}`).set(ctx.adminAuth.header).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a request with no token', async () => {
    const res = await api().get('/api/v1/queries');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired access token with TOKEN_EXPIRED, not a generic 401', async () => {
    // Distinct from TOKEN_INVALID so a client knows to refresh rather than
    // re-authenticate (§9.8).
    const expired = jwt.sign(
      { sub: ctx.cil.id, role: 'cil_user', sid: ctx.cilAuth.sessionId },
      env.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', issuer: 'geominex', expiresIn: '-1s' },
    );

    const res = await api().get('/api/v1/queries').set({ Authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects an MoC official from the review endpoint with 403', async () => {
    const q = await plantQuery(ctx, { status: 'answered', answerStatus: 'sourced', responseText: 'x' });
    const res = await api()
      .patch(`/api/v1/queries/${String(q._id)}`)
      .set(ctx.mocAuth.header)
      .send({ reviewNote: 'note' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for an unknown id and for an unparseable one alike', async () => {
    const unknown = await api()
      .get(`/api/v1/queries/${new Types.ObjectId().toString()}`)
      .set(ctx.cilAuth.header);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    // An unparseable id is a VALIDATION_ERROR at the param schema, before the
    // service is reached — the shape check and the scope check are separate.
    const malformed = await api().get('/api/v1/queries/not-an-id').set(ctx.cilAuth.header);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404, not 403, for a query belonging to another subsidiary (§9.1)', async () => {
    const foreign = await QueryModel.create({
      askedBy: new Types.ObjectId(ctx.admin.id),
      contextScope: { subsidiaryIds: [new Types.ObjectId(ctx.wcl.id)], documentIds: [] },
      subsidiaryId: new Types.ObjectId(ctx.wcl.id),
      questionText: 'What was WCL output last quarter?',
      isParliamentary: false,
      maxAttempts: env.QUERY_MAX_ATTEMPTS,
    });

    const res = await api().get(`/api/v1/queries/${String(foreign._id)}`).set(ctx.cilAuth.header);
    // 403 would confirm the row exists in a subsidiary the caller cannot see.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a body over the global 10kb JSON limit with 413 (D9’s reason for the 2000 cap)', async () => {
    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.cilAuth.header)
      .send({ questionText: 'a'.repeat(11_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('aiLimiter — the §9.2 stricter AI limit', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('is mounted on POST /queries and on the retry route', () => {
    // The MOUNTING is what regresses: a limiter nobody registered is invisible
    // in every behavioural test, because the route still works.
    const stack = queryRouter.stack as unknown as {
      route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
    }[];

    const ask = stack.find((l) => l.route?.path === '/' && l.route.methods.post === true);
    const retry = stack.find((l) => l.route?.path === '/:id/retry');

    expect(ask?.route?.stack.map((s) => s.handle)).toContain(aiLimiter);
    expect(retry?.route?.stack.map((s) => s.handle)).toContain(aiLimiter);
  });

  it('allows 12 asks per minute per USER and then returns 429', async () => {
    // `shared.skip = () => env.isTest` disables every limiter under test, so
    // the only way to assert the configured window, ceiling and key is to lift
    // that skip for this one test. express-rate-limit v8 exposes neither its
    // options nor its keyGenerator on the returned middleware, so they cannot
    // be read off `aiLimiter` directly.
    const mutable = env as unknown as { isTest: boolean };
    const other = await makeUser({
      email: 'qlimit@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [ctx.bccl.id],
    });
    const otherAuth = await authFor(other.id, 'cil_user');

    // A body that fails validation still passes THROUGH the limiter (it is
    // registered before `validate`), so the quota is consumed without queuing
    // twelve real answers.
    const shortBody = { questionText: 'too short' };

    mutable.isTest = false;
    try {
      for (let i = 0; i < 12; i += 1) {
        const res = await api().post('/api/v1/queries').set(ctx.cilAuth.header).send(shortBody);
        expect(res.status).toBe(400);
        if (i === 0) {
          // draft-7 policy header: `<max>;w=<windowSeconds>`.
          expect(res.headers['ratelimit-policy']).toBe('12;w=60');
        }
      }

      const blocked = await api().post('/api/v1/queries').set(ctx.cilAuth.header).send(shortBody);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');

      // Keyed on the USER, not the IP: a colleague behind the same NAT is
      // unaffected by the first caller exhausting their quota.
      const colleague = await api().post('/api/v1/queries').set(otherAuth.header).send(shortBody);
      expect(colleague.status).toBe(400);
    } finally {
      mutable.isTest = true;
    }
  });
});
