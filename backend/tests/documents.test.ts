/**
 * Document ingestion tests — PRD §4.1, §4.5, §9.4, §9.9.
 *
 * Storage is pointed at a temp directory per run so nothing is written into
 * the repository.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { api, makeUser, makeSubsidiary, authFor } from './helpers.js';
import { setStorageAdapter } from '../src/services/storage/index.js';
import { createLocalStorageAdapter } from '../src/services/storage/local.adapter.js';
import { drainProcessing } from '../src/modules/documents/document.worker.js';
import { DocumentModel } from '../src/modules/documents/document.model.js';
import { ExtractedField } from '../src/modules/documents/extractedField.model.js';
import { AuditLog } from '../src/modules/audit/auditLog.model.js';

let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'gmx-storage-'));
  setStorageAdapter(createLocalStorageAdapter(storageRoot));
});

afterAll(async () => {
  setStorageAdapter(null);
  await rm(storageRoot, { recursive: true, force: true });
});

const CSV = 'Production Tonnes: 125000\nGrade: G7\nQuarter: Q1 2026\n';

async function setup() {
  const bccl = await makeSubsidiary('BCCL');
  const wcl = await makeSubsidiary('WCL');
  const user = await makeUser({ email: 'up@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
  const auth = await authFor(user.id, 'cil_user');
  return { bccl, wcl, user, auth };
}

function upload(auth: { header: Record<string, string> }, subsidiaryId: string, body = CSV, name = 'report.csv', type = 'text/csv') {
  return api()
    .post('/api/v1/documents')
    .set(auth.header)
    .field('subsidiaryId', subsidiaryId)
    .attach('file', Buffer.from(body), { filename: name, contentType: type });
}

describe('Upload validation (PRD §9.4)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('accepts a valid CSV and queues it for processing', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);

    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.type).toBe('spreadsheet');
    // §9.4 — the client must never be able to construct a storage path.
    expect(res.body.data.storageKey).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('storageKey');
  });

  it('auto-tags by subsidiary, date and type (§4.1)', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    const tags = res.body.data.tags as string[];

    expect(tags).toContain('BCCL');
    expect(tags).toContain('spreadsheet');
    expect(tags.some((t) => /^\d{4}-\d{2}$/.test(t))).toBe(true);
  });

  it('never uses the client filename as the storage path', async () => {
    await upload(ctx.auth, ctx.bccl.id, CSV, '../../etc/passwd.csv').expect(201);

    const doc = await DocumentModel.findOne().lean();
    expect(doc!.storageKey).not.toContain('..');
    expect(doc!.storageKey).not.toContain('passwd');
    // Server-generated: subsidiary/year/month/<32 hex>.csv
    expect(doc!.storageKey).toMatch(/^[a-f0-9]{24}\/\d{4}\/\d{2}\/[a-f0-9]{32}\.csv$/);
  });

  it('rejects a disallowed extension', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id, 'MZ\x00binary', 'malware.exe', 'application/octet-stream');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts application/octet-stream — Postman and browsers send it for .csv', async () => {
    // The declared type is client-supplied and worth nothing as a control;
    // rejecting "unknown" only blocked honest clients.
    const res = await upload(ctx.auth, ctx.bccl.id, CSV, 'report.csv', 'application/octet-stream');

    expect(res.status).toBe(201);
    // What we store is the canonical type, never the meaningless octet-stream.
    expect(res.body.data.mimeType).toBe('text/csv');
  });

  it('still rejects binary content hiding behind a .csv extension', async () => {
    // With an unknown declared type and no magic bytes for text formats, the
    // content check is what stops this.
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x10]);
    const res = await api()
      .post('/api/v1/documents')
      .set(ctx.auth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', binary, { filename: 'sneaky.csv', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not text/i);
  });

  it('rejects a mismatch between extension and declared content type', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id, CSV, 'report.csv', 'application/pdf');
    expect(res.status).toBe(400);
  });

  it('rejects a file whose CONTENTS do not match its claimed type', async () => {
    // A PNG renamed to .pdf and declared as application/pdf: extension and
    // MIME agree, so only the magic-byte check catches this.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const res = await api()
      .post('/api/v1/documents')
      .set(ctx.auth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', png, { filename: 'notreally.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/do not match/i);
  });

  it('rejects an empty file', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id, '');
    expect(res.status).toBe(400);
  });

  it('rejects an upload larger than the multipart limit', async () => {
    const big = 'x'.repeat(30 * 1024 * 1024);
    const res = await upload(ctx.auth, ctx.bccl.id, big, 'big.csv');
    expect(res.status).toBe(413);
  });

  it('does not raise the JSON body limit for other routes', async () => {
    // The upload route's larger cap must not leak into JSON endpoints (§9.2).
    const res = await api()
      .post('/api/v1/auth/request-code')
      .send({ email: 'a@b.com', padding: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
  });
});

describe('Upload authorization (PRD §9.1)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('returns 404 when uploading to a subsidiary the user does not hold', async () => {
    const res = await upload(ctx.auth, ctx.wcl.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('writes nothing to storage when authorization fails', async () => {
    await upload(ctx.auth, ctx.wcl.id).expect(404);
    expect(await DocumentModel.countDocuments()).toBe(0);
  });

  it('forbids an MoC official from uploading (read-only role)', async () => {
    const moc = await makeUser({
      email: 'moc@moc.gov.in',
      role: 'moc_official',
      subsidiaryAccess: [ctx.bccl.id],
    });
    const mocAuth = await authFor(moc.id, 'moc_official');

    const res = await upload(mocAuth, ctx.bccl.id);
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await api()
      .post('/api/v1/documents')
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', Buffer.from(CSV), { filename: 'r.csv', contentType: 'text/csv' });
    expect(res.status).toBe(401);
  });
});

describe('Processing pipeline (PRD §4.1)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('moves queued -> validated and extracts fields', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();

    const doc = await DocumentModel.findById(res.body.data.id).lean();
    expect(doc!.status).toBe('validated');
    expect(doc!.processedAt).toBeInstanceOf(Date);

    const fields = await ExtractedField.find({ documentId: doc!._id }).lean();
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.map((f) => f.fieldName)).toContain('Production Tonnes');
  });

  it('extracts fields from a digital PDF with a text layer', async () => {
    const pdf = readFileSync(path.join(process.cwd(), 'bccl-q1-production.pdf'));
    const res = await api()
      .post('/api/v1/documents')
      .set(ctx.auth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', pdf, { filename: 'bccl-q1.pdf', contentType: 'application/pdf' })
      .expect(201);

    await drainProcessing();

    const doc = await DocumentModel.findById(res.body.data.id).lean();
    expect(doc!.status).toBe('validated');
    expect(doc!.ocrConfidence).toBeGreaterThan(0);

    const fields = await ExtractedField.find({ documentId: doc!._id }).lean();
    expect(fields.length).toBeGreaterThanOrEqual(8);
    expect(fields.map((f) => f.fieldName)).toContain('Production Tonnes');
    // §8.1 — a cited figure must be traceable to a page.
    expect(fields.find((f) => f.fieldName === 'Production Tonnes')!.sourceLocation?.pageNumber).toBe(1);
  });

  it('flags a PDF with no text layer for review rather than inventing data', async () => {
    // Structurally a PDF but with no embedded text — i.e. a scan. Recovering
    // text needs real OCR (§11.7), so this must not produce figures.

    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
    const res = await api()
      .post('/api/v1/documents')
      .set(ctx.auth.header)
      .field('subsidiaryId', ctx.bccl.id)
      .attach('file', pdf, { filename: 'scan.pdf', contentType: 'application/pdf' })
      .expect(201);

    await drainProcessing();

    const doc = await DocumentModel.findById(res.body.data.id).lean();
    expect(doc!.status).toBe('validated');
    expect(doc!.requiresReview).toBe(true);
    expect(doc!.ocrConfidence).toBe(0);

    // Crucially: no fabricated figures.
    expect(await ExtractedField.countDocuments({ documentId: doc!._id })).toBe(0);
  });

  it('is idempotent — reprocessing does not duplicate extracted fields', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();
    const first = await ExtractedField.countDocuments({ documentId: res.body.data.id });

    const { enqueueDocument } = await import('../src/modules/documents/document.worker.js');
    await DocumentModel.updateOne({ _id: res.body.data.id }, { $set: { status: 'queued' } });
    enqueueDocument(res.body.data.id);
    await drainProcessing();

    expect(await ExtractedField.countDocuments({ documentId: res.body.data.id })).toBe(first);
  });

  it('rejects retry on a document that is not failed', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();

    const retry = await api().post(`/api/v1/documents/${res.body.data.id}/retry`).set(ctx.auth.header);
    expect(retry.status).toBe(400);
  });

  it('records a non-sensitive failure reason when processing fails', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();

    // Break storage so reprocessing genuinely fails.
    await DocumentModel.updateOne(
      { _id: res.body.data.id },
      { $set: { status: 'queued', storageKey: `${ctx.bccl.id}/2026/01/${'0'.repeat(32)}.csv` } },
    );
    const { enqueueDocument } = await import('../src/modules/documents/document.worker.js');
    enqueueDocument(res.body.data.id);
    await drainProcessing();

    const doc = await DocumentModel.findById(res.body.data.id).lean();
    expect(doc!.status).toBe('failed');
    expect(doc!.processingError).toBeTruthy();
    // No filesystem paths or stack traces leaked into the stored reason.
    expect(doc!.processingError).not.toMatch(/ENOENT|[A-Za-z]:\\|\/tmp\//);
  });
});

describe('Download (PRD §5.8, §9.4)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('streams the original file to an authorized caller', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);

    const file = await api().get(`/api/v1/documents/${res.body.data.id}/file`).set(ctx.auth.header).expect(200);

    expect(file.headers['content-disposition']).toMatch(/attachment/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.text).toBe(CSV);
  });

  it('returns 404 to a user from another subsidiary', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);

    const other = await makeUser({
      email: 'other@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [ctx.wcl.id],
    });
    const otherAuth = await authFor(other.id, 'cil_user');

    const file = await api().get(`/api/v1/documents/${res.body.data.id}/file`).set(otherAuth.header);
    expect(file.status).toBe(404);
  });

  it('audits every download', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await api().get(`/api/v1/documents/${res.body.data.id}/file`).set(ctx.auth.header).expect(200);

    const entry = await AuditLog.findOne({ action: 'document.downloaded' }).lean();
    expect(entry).toBeTruthy();
    expect(String(entry!.targetId)).toBe(res.body.data.id);
  });
});

describe('Listing and field override (PRD §4.5, §9.8)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('lists only documents in the caller\'s subsidiaries', async () => {
    await upload(ctx.auth, ctx.bccl.id).expect(201);

    const other = await makeUser({
      email: 'wcl@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [ctx.wcl.id],
    });
    const otherAuth = await authFor(other.id, 'cil_user');

    const mine = await api().get('/api/v1/documents').set(ctx.auth.header).expect(200);
    const theirs = await api().get('/api/v1/documents').set(otherAuth.header).expect(200);

    expect(mine.body.data).toHaveLength(1);
    expect(theirs.body.data).toHaveLength(0);
    expect(mine.body.pagination).toHaveProperty('nextCursor');
  });

  it('records an override with its reason and preserves the original value', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();

    const fields = await api()
      .get(`/api/v1/documents/${res.body.data.id}/extracted-fields`)
      .set(ctx.auth.header)
      .expect(200);

    const target = fields.body.data[0];
    const patched = await api()
      .patch(`/api/v1/extracted-fields/${target.id}`)
      .set(ctx.auth.header)
      .send({ value: '130000', reason: 'Corrected against signed production return' })
      .expect(200);

    expect(patched.body.data.value).toBe('130000');
    expect(patched.body.data.originalValue).toBe(target.value);
    expect(patched.body.data.overrideReason).toBeTruthy();
  });

  it('requires a reason for an override', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();

    const fields = await api()
      .get(`/api/v1/documents/${res.body.data.id}/extracted-fields`)
      .set(ctx.auth.header)
      .expect(200);

    const bad = await api()
      .patch(`/api/v1/extracted-fields/${fields.body.data[0].id}`)
      .set(ctx.auth.header)
      .send({ value: '1' });

    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never writes the overridden value into the audit trail', async () => {
    const res = await upload(ctx.auth, ctx.bccl.id).expect(201);
    await drainProcessing();

    const fields = await api()
      .get(`/api/v1/documents/${res.body.data.id}/extracted-fields`)
      .set(ctx.auth.header)
      .expect(200);

    await api()
      .patch(`/api/v1/extracted-fields/${fields.body.data[0].id}`)
      .set(ctx.auth.header)
      .send({ value: 'SENSITIVE-FIGURE-999', reason: 'correction' })
      .expect(200);

    const logs = await AuditLog.find({ action: 'extracted_field.overridden' }).lean();
    expect(logs).toHaveLength(1);
    // The figure may be sensitive operational data (§9.6) — reason yes, value no.
    expect(JSON.stringify(logs)).not.toContain('SENSITIVE-FIGURE-999');
  });
});
