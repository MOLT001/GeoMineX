/**
 * Cross-subsidiary isolation and role-permission tests — PRD §9.9, §13.
 *
 * These are the tests the PRD names explicitly as MVP-blocking: no protected
 * resource may bypass role or subsidiary authorization, and an out-of-scope
 * request must return 404 rather than 403.
 */
import { describe, it, expect } from 'vitest';
import { api, makeUser, makeSubsidiary, authFor, askAndDrain, makeDocumentWithChunks } from './helpers.js';
import { User } from '../src/modules/users/user.model.js';
import { Session } from '../src/modules/auth/session.model.js';

/**
 * A well-formed id that belongs to nothing. The auth sweep needs one so the
 * :id routes fail on the missing token rather than on ObjectId shape — an
 * ordering regression (validate before requireAuth) would otherwise hide
 * behind a 400 that looks like a pass.
 */
const WELL_FORMED_ID = '507f1f77bcf86cd799439011';

describe('Authentication is required on protected routes', () => {
  const protectedRoutes = [
    { name: 'GET /users/me', run: () => api().get('/api/v1/users/me') },
    { name: 'GET /users', run: () => api().get('/api/v1/users') },
    { name: 'GET /subsidiaries', run: () => api().get('/api/v1/subsidiaries') },
    { name: 'GET /audit-logs', run: () => api().get('/api/v1/audit-logs') },
    { name: 'GET /auth/sessions', run: () => api().get('/api/v1/auth/sessions') },
    { name: 'POST /users/invite', run: () => api().post('/api/v1/users/invite').send({}) },
    { name: 'POST /subsidiaries', run: () => api().post('/api/v1/subsidiaries').send({}) },
    // Phase 2 (spec §12.7) — swept here, not only by their own suites, so a
    // new router mounted without `requireAuth` fails the same table Phase 1
    // routes do.
    { name: 'POST /queries', run: () => api().post('/api/v1/queries').send({}) },
    { name: 'GET /queries', run: () => api().get('/api/v1/queries') },
    { name: 'GET /queries/:id', run: () => api().get(`/api/v1/queries/${WELL_FORMED_ID}`) },
    { name: 'PATCH /queries/:id', run: () => api().patch(`/api/v1/queries/${WELL_FORMED_ID}`).send({}) },
    { name: 'POST /queries/:id/retry', run: () => api().post(`/api/v1/queries/${WELL_FORMED_ID}/retry`) },
    { name: 'GET /topics', run: () => api().get('/api/v1/topics') },
    { name: 'GET /analytics', run: () => api().get('/api/v1/analytics') },
  ];

  it.each(protectedRoutes)('rejects $name without a token', async ({ run }) => {
    const res = await run();
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await api().get('/api/v1/users/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token for a deactivated user', async () => {
    const user = await makeUser({ email: 'deact@cil.gov.in', role: 'cil_user' });
    const auth = await authFor(user.id, 'cil_user');

    await api().get('/api/v1/users/me').set(auth.header).expect(200);

    await User.updateOne({ _id: user.id }, { $set: { isActive: false } });
    await api().get('/api/v1/users/me').set(auth.header).expect(401);
  });

  it('rejects a token whose session has been revoked', async () => {
    const user = await makeUser({ email: 'revoked@cil.gov.in', role: 'cil_user' });
    const auth = await authFor(user.id, 'cil_user');

    await Session.updateOne({ _id: auth.sessionId }, { $set: { revokedAt: new Date() } });
    await api().get('/api/v1/users/me').set(auth.header).expect(401);
  });
});

describe('Subsidiary isolation (PRD §9.1)', () => {
  it('shows a CIL user only the subsidiaries they hold grants for', async () => {
    const bccl = await makeSubsidiary('BCCL');
    await makeSubsidiary('WCL');

    const user = await makeUser({ email: 'scoped@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
    const auth = await authFor(user.id, 'cil_user');

    const res = await api().get('/api/v1/subsidiaries').set(auth.header).expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].code).toBe('BCCL');
    // The un-granted subsidiary must not leak, even by name.
    expect(JSON.stringify(res.body)).not.toContain('WCL');
  });

  it('shows an admin every subsidiary', async () => {
    await makeSubsidiary('BCCL');
    await makeSubsidiary('WCL');

    const admin = await makeUser({ email: 'admin@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    const res = await api().get('/api/v1/subsidiaries').set(auth.header).expect(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('grants an MoC official only explicitly granted subsidiaries, not all', async () => {
    const bccl = await makeSubsidiary('BCCL');
    await makeSubsidiary('WCL');

    const moc = await makeUser({ email: 'moc@moc.gov.in', role: 'moc_official', subsidiaryAccess: [bccl.id] });
    const auth = await authFor(moc.id, 'moc_official');

    const res = await api().get('/api/v1/subsidiaries').set(auth.header).expect(200);
    expect(res.body.data.map((s: { code: string }) => s.code)).toEqual(['BCCL']);
  });

  it('returns 404 — not 403 — for audit logs of an unheld subsidiary', async () => {
    const bccl = await makeSubsidiary('BCCL');
    const wcl = await makeSubsidiary('WCL');

    const user = await makeUser({ email: 'iso@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
    const auth = await authFor(user.id, 'cil_user');

    const res = await api().get(`/api/v1/audit-logs?subsidiaryId=${wcl.id}`).set(auth.header).expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    // 403 would confirm that WCL exists and holds data.
    expect(res.body.error.code).not.toBe('FORBIDDEN');
  });

  it("returns 404 when a CIL user filters the audit trail by another user's id", async () => {
    const bccl = await makeSubsidiary('BCCL');
    const user = await makeUser({ email: 'self@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
    const other = await makeUser({ email: 'other@cil.gov.in', role: 'cil_user', subsidiaryAccess: [bccl.id] });
    const auth = await authFor(user.id, 'cil_user');

    await api().get(`/api/v1/audit-logs?userId=${other.id}`).set(auth.header).expect(404);
  });
});

describe('Role permissions (PRD §9.1)', () => {
  it('returns 403 when a CIL user calls an admin-only endpoint', async () => {
    const user = await makeUser({ email: 'cil@cil.gov.in', role: 'cil_user' });
    const auth = await authFor(user.id, 'cil_user');

    const res = await api().get('/api/v1/users').set(auth.header).expect(403);

    // 403 is correct here, not 404: the caller may know the admin API exists;
    // only the action is denied. The 404 convention covers cross-subsidiary
    // *resources*, which is a different question.
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when an MoC official tries to invite a user', async () => {
    const moc = await makeUser({ email: 'moc2@moc.gov.in', role: 'moc_official' });
    const auth = await authFor(moc.id, 'moc_official');

    await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({ email: 'new@cil.gov.in', name: 'New', role: 'cil_user' })
      .expect(403);
  });

  it('allows an admin to invite a user', async () => {
    const bccl = await makeSubsidiary('BCCL');
    const admin = await makeUser({ email: 'admin2@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    const res = await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({ email: 'invitee@cil.gov.in', name: 'Invitee', role: 'cil_user', subsidiaryAccess: [bccl.id] })
      .expect(201);

    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.isInvitePending).toBe(true);
  });

  it('rejects a grant naming a subsidiary that does not exist', async () => {
    const admin = await makeUser({ email: 'admin3@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    await api()
      .post('/api/v1/users/invite')
      .set(auth.header)
      .send({
        email: 'bad@cil.gov.in',
        name: 'Bad',
        role: 'cil_user',
        subsidiaryAccess: ['507f1f77bcf86cd799439011'],
      })
      .expect(400);
  });
});

describe('Self-demotion and destructive-action guards (PRD §8.3)', () => {
  it('prevents an admin from changing their own role', async () => {
    const admin = await makeUser({ email: 'lastadmin@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    const res = await api()
      .patch(`/api/v1/users/${admin.id}`)
      .set(auth.header)
      .send({ role: 'cil_user' })
      .expect(403);

    expect(res.body.error.code).toBe('CANNOT_SELF_DEMOTE');
  });

  it('prevents an admin from deactivating themselves', async () => {
    const admin = await makeUser({ email: 'lastadmin2@moc.gov.in', role: 'admin' });
    const auth = await authFor(admin.id, 'admin');

    const res = await api()
      .patch(`/api/v1/users/${admin.id}`)
      .set(auth.header)
      .send({ isActive: false, confirm: 'lastadmin2@moc.gov.in' })
      .expect(403);

    expect(res.body.error.code).toBe('CANNOT_SELF_DEMOTE');
  });

  it('requires typed confirmation to deactivate another user', async () => {
    const admin = await makeUser({ email: 'admin4@moc.gov.in', role: 'admin' });
    const target = await makeUser({ email: 'target@cil.gov.in', role: 'cil_user' });
    const auth = await authFor(admin.id, 'admin');

    const missing = await api()
      .patch(`/api/v1/users/${target.id}`)
      .set(auth.header)
      .send({ isActive: false })
      .expect(400);
    expect(missing.body.error.code).toBe('CONFIRM_TEXT_MISMATCH');

    await api()
      .patch(`/api/v1/users/${target.id}`)
      .set(auth.header)
      .send({ isActive: false, confirm: 'target@cil.gov.in' })
      .expect(200);
  });

  it("revokes a deactivated user's live sessions immediately", async () => {
    const admin = await makeUser({ email: 'admin5@moc.gov.in', role: 'admin' });
    const target = await makeUser({ email: 'kill@cil.gov.in', role: 'cil_user' });

    const adminAuth = await authFor(admin.id, 'admin');
    const targetAuth = await authFor(target.id, 'cil_user');

    await api().get('/api/v1/users/me').set(targetAuth.header).expect(200);

    await api()
      .patch(`/api/v1/users/${target.id}`)
      .set(adminAuth.header)
      .send({ isActive: false, confirm: 'kill@cil.gov.in' })
      .expect(200);

    await api().get('/api/v1/users/me').set(targetAuth.header).expect(401);
  });

  it('lets an admin force-logout a user', async () => {
    const admin = await makeUser({ email: 'admin6@moc.gov.in', role: 'admin' });
    const target = await makeUser({ email: 'forced@cil.gov.in', role: 'cil_user' });

    const adminAuth = await authFor(admin.id, 'admin');
    const targetAuth = await authFor(target.id, 'cil_user');

    const res = await api().delete(`/api/v1/users/${target.id}/sessions`).set(adminAuth.header).expect(200);
    expect(res.body.data.revokedCount).toBe(1);

    await api().get('/api/v1/users/me').set(targetAuth.header).expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — the same isolation sweep over the query, topic and analytics
// families (PRD §9.1, §9.9; spec §12.7).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 404 with NOT_FOUND, never 403.
 *
 * A 403 would confirm that the named subsidiary exists and holds the resource,
 * which is precisely the fact the isolation rule exists to withhold. The code
 * is asserted as well as the status because the error handler maps several
 * conditions onto 404 and only one of them is the scoped miss.
 */
function expectHidden(res: { status: number; body: { error?: { code?: string } } }): void {
  expect(res.status).toBe(404);
  expect(res.body.error?.code).toBe('NOT_FOUND');
  expect(res.body.error?.code).not.toBe('FORBIDDEN');
}

describe('Subsidiary isolation on the Phase 2 surfaces (PRD §9.1, §9.9)', () => {
  /** BCCL insider, WCL outsider, and an admin who can see across both. */
  async function twoTenants() {
    const bccl = await makeSubsidiary('BCCL');
    const wcl = await makeSubsidiary('WCL');

    const insider = await makeUser({
      email: 'insider@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [bccl.id],
    });
    const outsider = await makeUser({
      email: 'outsider@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [wcl.id],
    });
    const admin = await makeUser({ email: 'crossadmin@moc.gov.in', role: 'admin' });

    return {
      bccl,
      wcl,
      insider: { ...insider, auth: await authFor(insider.id, 'cil_user') },
      outsider: { ...outsider, auth: await authFor(outsider.id, 'cil_user') },
      admin: { ...admin, auth: await authFor(admin.id, 'admin') },
    };
  }

  /** A query asked and answered inside WCL, by the WCL user. */
  async function wclQuery(ctx: Awaited<ReturnType<typeof twoTenants>>): Promise<string> {
    const asked = await askAndDrain(ctx.outsider.auth, {
      questionText: 'What production tonnage did Western Coalfields record last quarter?',
    });
    return asked.id as string;
  }

  it('rejects a query opened against an unheld subsidiary with 404, not 403', async () => {
    const ctx = await twoTenants();

    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.insider.auth.header)
      .send({
        questionText: 'What production tonnage was recorded last quarter?',
        subsidiaryId: ctx.wcl.id,
      });

    expectHidden(res);
  });

  it('rejects a query narrowed to a document in an unheld subsidiary', async () => {
    const ctx = await twoTenants();
    const planted = await makeDocumentWithChunks({
      subsidiaryId: ctx.wcl.id,
      uploadedBy: ctx.outsider.id,
      text: 'Western Coalfields recorded eighty four lakh tonnes of production in the quarter.',
    });

    const res = await api()
      .post('/api/v1/queries')
      .set(ctx.insider.auth.header)
      .send({
        questionText: 'What production tonnage was recorded last quarter?',
        documentIds: [planted.documentId],
      });

    // The document is real and validated; it is simply not the caller's to
    // name, so the answer is indistinguishable from "no such document".
    expectHidden(res);
  });

  it('rejects a query log filtered by an unheld subsidiary', async () => {
    const ctx = await twoTenants();

    const res = await api()
      .get(`/api/v1/queries?subsidiaryId=${ctx.wcl.id}`)
      .set(ctx.insider.auth.header);

    expectHidden(res);
  });

  it('returns 404 — not 403 — when reading a query held by another subsidiary', async () => {
    const ctx = await twoTenants();
    const id = await wclQuery(ctx);

    expectHidden(await api().get(`/api/v1/queries/${id}`).set(ctx.insider.auth.header));
  });

  it('returns 404 when reviewing a query held by another subsidiary', async () => {
    const ctx = await twoTenants();
    const id = await wclQuery(ctx);

    // roleGuard admits a cil_user to PATCH, so the 404 here is the SCOPE check
    // firing rather than the role check.
    expectHidden(
      await api()
        .patch(`/api/v1/queries/${id}`)
        .set(ctx.insider.auth.header)
        .send({ reviewNote: 'Not mine to annotate' }),
    );
  });

  it('returns 404 when retrying a query held by another subsidiary', async () => {
    const ctx = await twoTenants();
    const id = await wclQuery(ctx);

    // Retry answers 403 for a VISIBLE query the caller did not author, so a
    // 403 here would mean the row was loaded before the scope was considered.
    expectHidden(await api().post(`/api/v1/queries/${id}/retry`).set(ctx.insider.auth.header));
  });

  it('hides a cross-subsidiary query from a user granted only one of its subsidiaries', async () => {
    const ctx = await twoTenants();
    const asked = await askAndDrain(ctx.admin.auth, {
      questionText: 'What production tonnage was recorded across the group last quarter?',
    });
    const scope = asked.contextScope as { subsidiaryIds: string[] };

    expect(scope.subsidiaryIds).toHaveLength(2);
    expect(scope.subsidiaryIds).toContain(ctx.bccl.id);

    // D3, containment rather than intersection: BCCL IS in this query's scope,
    // but the prose may carry WCL's figures, so a BCCL-only reader is not
    // entitled to it. Intersection would hand it over.
    expectHidden(
      await api().get(`/api/v1/queries/${asked.id as string}`).set(ctx.insider.auth.header),
    );

    const list = await api().get('/api/v1/queries').set(ctx.insider.auth.header).expect(200);
    expect(list.body.success).toBe(true);
    expect(list.body.data).toHaveLength(0);
  });

  it('rejects a word cloud requested for an unheld subsidiary', async () => {
    const ctx = await twoTenants();

    expectHidden(
      await api().get(`/api/v1/topics?subsidiaryId=${ctx.wcl.id}`).set(ctx.insider.auth.header),
    );
  });

  it('rejects analytics requested for an unheld subsidiary', async () => {
    const ctx = await twoTenants();

    expectHidden(
      await api().get(`/api/v1/analytics?subsidiaryId=${ctx.wcl.id}`).set(ctx.insider.auth.header),
    );
  });

  it('serves both aggregate surfaces for a subsidiary the caller does hold', async () => {
    const ctx = await twoTenants();

    // The refusals above only mean something if the permitted case works: an
    // endpoint that 404s for everybody would pass every other test here.
    const topics = await api()
      .get(`/api/v1/topics?subsidiaryId=${ctx.bccl.id}`)
      .set(ctx.insider.auth.header)
      .expect(200);
    expect(topics.body.success).toBe(true);
    expect(topics.body.data.scope.subsidiaryIds).toEqual([ctx.bccl.id]);

    const analytics = await api()
      .get(`/api/v1/analytics?subsidiaryId=${ctx.bccl.id}`)
      .set(ctx.insider.auth.header)
      .expect(200);
    expect(analytics.body.data.scope.subsidiaryIds).toEqual([ctx.bccl.id]);
  });
});

describe('Role permissions on the Phase 2 surfaces (PRD §9.1)', () => {
  it('returns 403 — not 404 — when an MoC official tries to review a query', async () => {
    const bccl = await makeSubsidiary('BCCL');
    const asker = await makeUser({
      email: 'asker@cil.gov.in',
      role: 'cil_user',
      subsidiaryAccess: [bccl.id],
    });
    const moc = await makeUser({
      email: 'mocreview@moc.gov.in',
      role: 'moc_official',
      subsidiaryAccess: [bccl.id],
    });

    const askerAuth = await authFor(asker.id, 'cil_user');
    const mocAuth = await authFor(moc.id, 'moc_official');

    const asked = await askAndDrain(askerAuth, {
      questionText: 'What production tonnage was recorded last quarter?',
    });
    const id = asked.id as string;

    // The query sits inside a subsidiary this official holds, so it is
    // legitimately visible — only the ACTION is denied. This is the one shape
    // where 403 is right and 404 would be a lie.
    await api().get(`/api/v1/queries/${id}`).set(mocAuth.header).expect(200);

    const res = await api()
      .patch(`/api/v1/queries/${id}`)
      .set(mocAuth.header)
      .send({ reviewNote: 'Looks fine to me' })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
