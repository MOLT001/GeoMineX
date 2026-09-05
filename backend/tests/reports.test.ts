/**
 * Report drafting and lifecycle tests — PRD §4.2, §5.5, §9.9.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { api, makeUser, makeSubsidiary, authFor } from './helpers.js';
import { setStorageAdapter } from '../src/services/storage/index.js';
import { createLocalStorageAdapter } from '../src/services/storage/local.adapter.js';
import { drainProcessing } from '../src/modules/documents/document.worker.js';

let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'gmx-reports-'));
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

  const admin = await makeUser({ email: 'radmin@moc.gov.in', role: 'admin' });
  const adminAuth = await authFor(admin.id, 'admin');

  const cil = await makeUser({ email: 'rcil@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
  const cilAuth = await authFor(cil.id, 'cil_user');

  const template = await api()
    .post('/api/v1/report-templates')
    .set(adminAuth.header)
    .send({
      name: 'Quarterly Production',
      sections: [
        { heading: 'Summary', body: 'Output was {{Production Tonnes}} tonnes at grade {{Grade}}.' },
        { heading: 'Notes', body: 'Missing: {{Nonexistent Field}}' },
      ],
    })
    .expect(201);

  const doc = await api()
    .post('/api/v1/documents')
    .set(cilAuth.header)
    .field('subsidiaryId', bccl.id)
    .attach('file', Buffer.from(CSV), { filename: 'q1.csv', contentType: 'text/csv' })
    .expect(201);

  await drainProcessing();

  return { bccl, wcl, adminAuth, cilAuth, templateId: template.body.data.id, documentId: doc.body.data.id };
}

/** Returns the supertest chain (not a promise) so callers can use .expect(). */
function draft(ctx: Awaited<ReturnType<typeof setup>>, title = 'Q1 2026 Production') {
  return api()
    .post('/api/v1/reports')
    .set(ctx.cilAuth.header)
    .send({
      title,
      templateId: ctx.templateId,
      subsidiaryId: ctx.bccl.id,
      sourceDocumentIds: [ctx.documentId],
    });
}

describe('Templates (PRD §5.5)', () => {
  it('restricts template creation to Admin', async () => {
    const ctx = await setup();
    const res = await api()
      .post('/api/v1/report-templates')
      .set(ctx.cilAuth.header)
      .send({ name: 'Nope', sections: [{ heading: 'H', body: 'B' }] });

    expect(res.status).toBe(403);
  });

  it('rejects a duplicate template name', async () => {
    const ctx = await setup();
    const res = await api()
      .post('/api/v1/report-templates')
      .set(ctx.adminAuth.header)
      .send({ name: 'Quarterly Production', sections: [{ heading: 'H', body: 'B' }] });

    expect(res.status).toBe(409);
  });
});

describe('Drafting (PRD §4.2)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('fills placeholders from extracted fields and emits citations', async () => {
    const res = await draft(ctx).expect(201);

    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.sections[0].body).toContain('125000');
    expect(res.body.data.sections[0].body).toContain('G7');

    // §8.1 — citations are structured metadata, not parsed out of prose.
    expect(res.body.data.citations.length).toBeGreaterThan(0);
    expect(res.body.data.citations[0]).toHaveProperty('documentId');
    expect(res.body.data.citations[0]).toHaveProperty('extractedFieldId');
  });

  it('leaves an unresolved placeholder visible rather than silently blank', async () => {
    const res = await draft(ctx).expect(201);
    // A missing figure must be obvious to the human editor.
    expect(res.body.data.sections[1].body).toContain('[[unresolved: Nonexistent Field]]');
  });

  it('never publishes automatically', async () => {
    const res = await draft(ctx).expect(201);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.publishedAt).toBeNull();
  });

  it('records an initial version', async () => {
    const res = await draft(ctx).expect(201);
    const versions = await api()
      .get(`/api/v1/reports/${res.body.data.id}/versions`)
      .set(ctx.cilAuth.header)
      .expect(200);

    expect(versions.body.data).toHaveLength(1);
    expect(versions.body.data[0].version).toBe(1);
  });

  it('refuses to draft from a document that is not validated', async () => {
    const { DocumentModel } = await import('../src/modules/documents/document.model.js');
    await DocumentModel.updateOne({ _id: ctx.documentId }, { $set: { status: 'failed' } });

    const res = await draft(ctx);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/validated/i);
  });

  it('returns 404 for a source document outside the subsidiary', async () => {
    const res = await api()
      .post('/api/v1/reports')
      .set(ctx.cilAuth.header)
      .send({
        title: 'Cross-tenant',
        templateId: ctx.templateId,
        subsidiaryId: ctx.wcl.id,
        sourceDocumentIds: [ctx.documentId],
      });

    expect(res.status).toBe(404);
  });
});

describe('Lifecycle (PRD §4.2, §11.5)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('creates a new attributable version on every edit', async () => {
    const res = await draft(ctx).expect(201);

    await api()
      .patch(`/api/v1/reports/${res.body.data.id}`)
      .set(ctx.cilAuth.header)
      .send({ sections: [{ heading: 'Summary', body: 'Revised' }], changeSummary: 'Tightened wording' })
      .expect(200);

    const versions = await api()
      .get(`/api/v1/reports/${res.body.data.id}/versions`)
      .set(ctx.cilAuth.header)
      .expect(200);

    expect(versions.body.data).toHaveLength(2);
    expect(versions.body.data[0].version).toBe(2);
    expect(versions.body.data[0].changeSummary).toBe('Tightened wording');
    expect(versions.body.data[0].editedBy).toBeTruthy();
  });

  it('forbids a CIL User from publishing (§11.5: Admin-only)', async () => {
    const res = await draft(ctx).expect(201);
    const pub = await api().post(`/api/v1/reports/${res.body.data.id}/publish`).set(ctx.cilAuth.header);
    expect(pub.status).toBe(403);
  });

  it('lets an Admin publish', async () => {
    const res = await draft(ctx).expect(201);
    const pub = await api()
      .post(`/api/v1/reports/${res.body.data.id}/publish`)
      .set(ctx.adminAuth.header)
      .expect(200);

    expect(pub.body.data.status).toBe('published');
    expect(pub.body.data.publishedAt).toBeTruthy();
    expect(pub.body.data.publishedBy).toBeTruthy();
  });

  it('refuses edits once published — a published report is a record', async () => {
    const res = await draft(ctx).expect(201);
    await api().post(`/api/v1/reports/${res.body.data.id}/publish`).set(ctx.adminAuth.header).expect(200);

    const edit = await api()
      .patch(`/api/v1/reports/${res.body.data.id}`)
      .set(ctx.cilAuth.header)
      .send({ sections: [{ heading: 'X', body: 'Y' }] });

    expect(edit.status).toBe(400);
  });

  it('requires typed confirmation to archive (§8.3)', async () => {
    const res = await draft(ctx, 'Archive Me').expect(201);

    const noConfirm = await api()
      .post(`/api/v1/reports/${res.body.data.id}/archive`)
      .set(ctx.adminAuth.header)
      .send({ confirm: 'wrong title' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('CONFIRM_TEXT_MISMATCH');

    const ok = await api()
      .post(`/api/v1/reports/${res.body.data.id}/archive`)
      .set(ctx.adminAuth.header)
      .send({ confirm: 'Archive Me' })
      .expect(200);
    expect(ok.body.data.status).toBe('archived');
  });

  it('scopes report listing to the caller\'s subsidiaries', async () => {
    await draft(ctx).expect(201);

    const outsider = await makeUser({
      email: 'outsider@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [ctx.wcl.id],
    });
    const outsiderAuth = await authFor(outsider.id, 'cil_user');

    const mine = await api().get('/api/v1/reports').set(ctx.cilAuth.header).expect(200);
    const theirs = await api().get('/api/v1/reports').set(outsiderAuth.header).expect(200);

    expect(mine.body.data).toHaveLength(1);
    expect(theirs.body.data).toHaveLength(0);
  });
});
