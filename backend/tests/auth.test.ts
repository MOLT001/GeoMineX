/** Authentication and session tests — PRD §9.9. */
import { describe, it, expect } from 'vitest';
import { api, makeUser, loginViaOtp, refreshCookieFrom, COOKIE_NAME } from './helpers.js';
import { OtpCode } from '../src/modules/auth/otpCode.model.js';
import { Session } from '../src/modules/auth/session.model.js';
import { LoginAttempt } from '../src/modules/auth/loginAttempt.model.js';
import { hashToken } from '../src/utils/secureToken.js';

describe('OTP issuance', () => {
  it('returns an identical response for known and unknown accounts (no enumeration)', async () => {
    await makeUser({ email: 'known@cil.gov.in', role: 'cil_user' });

    const known = await api().post('/api/v1/auth/request-code').send({ email: 'known@cil.gov.in' });
    const unknown = await api().post('/api/v1/auth/request-code').send({ email: 'nobody@cil.gov.in' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('does not issue a code to an inactive account', async () => {
    await makeUser({ email: 'pending@cil.gov.in', role: 'cil_user', isActive: false });
    await api().post('/api/v1/auth/request-code').send({ email: 'pending@cil.gov.in' }).expect(200);
    expect(await OtpCode.countDocuments()).toBe(0);
  });

  it('never stores the code in plaintext', async () => {
    await makeUser({ email: 'hash@cil.gov.in', role: 'cil_user' });
    const { code } = await loginViaOtp('hash@cil.gov.in');

    const stored = await OtpCode.findOne().lean();
    expect(stored!.codeHash).not.toBe(code);
    expect(stored!.codeHash).toBe(hashToken(code));
  });

  it('invalidates a previously issued code when a new one is requested', async () => {
    await makeUser({ email: 'reissue@cil.gov.in', role: 'cil_user' });
    await api().post('/api/v1/auth/request-code').send({ email: 'reissue@cil.gov.in' }).expect(200);
    await api().post('/api/v1/auth/request-code').send({ email: 'reissue@cil.gov.in' }).expect(200);

    expect(await OtpCode.countDocuments({ consumedAt: { $exists: false } })).toBe(1);
  });
});

describe('Email normalisation', () => {
  it('forgives surrounding whitespace and casing on a pasted address', async () => {
    await makeUser({ email: 'mixed.case@cil.gov.in', role: 'cil_user' });

    const res = await api()
      .post('/api/v1/auth/request-code')
      .send({ email: '  Mixed.Case@CIL.GOV.IN  ' })
      .expect(200);

    expect(res.body.success).toBe(true);
    // Trimmed + lower-cased before lookup, so a code really was issued.
    expect(await OtpCode.countDocuments()).toBe(1);
  });

  it('still rejects a genuinely malformed address', async () => {
    const res = await api().post('/api/v1/auth/request-code').send({ email: 'not-an-email' }).expect(400);
    expect(res.body.error.fields.email).toBeDefined();
  });
});

describe('OTP verification', () => {
  it('issues an access token and an HttpOnly refresh cookie on success', async () => {
    await makeUser({ email: 'ok@cil.gov.in', role: 'cil_user' });
    const { accessToken, cookies } = await loginViaOtp('ok@cil.gov.in');

    expect(accessToken).toBeTruthy();
    const cookie = cookies.find((c) => c.startsWith(COOKIE_NAME));
    expect(cookie).toContain('HttpOnly');
    // §11.9 decision: same-site deployment keeps SameSite=Strict.
    expect(cookie).toContain('SameSite=Strict');
  });

  it('rejects a wrong code with a generic error', async () => {
    await makeUser({ email: 'wrong@cil.gov.in', role: 'cil_user' });
    await api().post('/api/v1/auth/request-code').send({ email: 'wrong@cil.gov.in' }).expect(200);

    const res = await api()
      .post('/api/v1/auth/verify-code')
      .send({ email: 'wrong@cil.gov.in', code: '000000' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid or expired code');
  });

  it('gives the same error for an unknown account as for a wrong code', async () => {
    await makeUser({ email: 'real@cil.gov.in', role: 'cil_user' });
    await api().post('/api/v1/auth/request-code').send({ email: 'real@cil.gov.in' }).expect(200);

    const wrongCode = await api()
      .post('/api/v1/auth/verify-code')
      .send({ email: 'real@cil.gov.in', code: '111111' });
    const noAccount = await api()
      .post('/api/v1/auth/verify-code')
      .send({ email: 'ghost@cil.gov.in', code: '111111' });

    expect(wrongCode.status).toBe(noAccount.status);
    expect(wrongCode.body).toEqual(noAccount.body);
  });

  it('consumes the code so it cannot be replayed', async () => {
    await makeUser({ email: 'replay@cil.gov.in', role: 'cil_user' });
    const { code } = await loginViaOtp('replay@cil.gov.in');

    await api()
      .post('/api/v1/auth/verify-code')
      .send({ email: 'replay@cil.gov.in', code })
      .expect(401);
  });
});

describe('Per-account lockout (PRD §9.3)', () => {
  it('locks the account after the configured number of failures', async () => {
    await makeUser({ email: 'lock@cil.gov.in', role: 'cil_user' });
    await api().post('/api/v1/auth/request-code').send({ email: 'lock@cil.gov.in' }).expect(200);

    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/verify-code').send({ email: 'lock@cil.gov.in', code: '999999' }).expect(401);
    }

    const attempt = await LoginAttempt.findOne().lean();
    expect(attempt!.lockedUntil).toBeInstanceOf(Date);
    expect(attempt!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not disclose the lock to the caller', async () => {
    await makeUser({ email: 'quiet@cil.gov.in', role: 'cil_user' });
    await api().post('/api/v1/auth/request-code').send({ email: 'quiet@cil.gov.in' }).expect(200);

    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/verify-code').send({ email: 'quiet@cil.gov.in', code: '999999' });
    }

    const res = await api()
      .post('/api/v1/auth/verify-code')
      .send({ email: 'quiet@cil.gov.in', code: '888888' })
      .expect(401);

    expect(res.body.error.message).toBe('Invalid or expired code');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('lock');
  });
});

describe('Session rotation and reuse detection (PRD §9.3)', () => {
  it('stores the refresh credential hashed, never in plaintext', async () => {
    await makeUser({ email: 'store@cil.gov.in', role: 'cil_user' });
    const { cookies } = await loginViaOtp('store@cil.gov.in');
    const raw = refreshCookieFrom(cookies).split('=')[1]!;

    const session = await Session.findOne().lean();
    expect(session!.tokenHash).not.toBe(raw);
    expect(session!.tokenHash).toBe(hashToken(raw));
  });

  it('issues a new credential and revokes the old one on every refresh', async () => {
    await makeUser({ email: 'rotate@cil.gov.in', role: 'cil_user' });
    const { cookies } = await loginViaOtp('rotate@cil.gov.in');
    const first = refreshCookieFrom(cookies);

    const res = await api().post('/api/v1/auth/refresh').set('Cookie', first).expect(200);
    const second = refreshCookieFrom(res.headers['set-cookie'] as unknown as string[]);

    expect(second).not.toBe(first);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('revokes every session in the family when a rotated credential is replayed', async () => {
    const user = await makeUser({ email: 'reuse@cil.gov.in', role: 'cil_user' });
    const { cookies } = await loginViaOtp('reuse@cil.gov.in');
    const stolen = refreshCookieFrom(cookies);

    // Legitimate rotation.
    await api().post('/api/v1/auth/refresh').set('Cookie', stolen).expect(200);

    // The attacker replays the credential the legitimate client already spent.
    const replay = await api().post('/api/v1/auth/refresh').set('Cookie', stolen).expect(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_INVALID');

    // Every session for that user is now revoked — including the successor
    // the legitimate client is holding.
    const live = await Session.countDocuments({ userId: user.id, revokedAt: { $exists: false } });
    expect(live).toBe(0);
  });

  it('rejects an unknown refresh credential', async () => {
    const res = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${COOKIE_NAME}=not-a-real-token`)
      .expect(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('rejects a refresh with no cookie at all', async () => {
    await api().post('/api/v1/auth/refresh').expect(401);
  });
});

describe('Logout and session management', () => {
  it('revokes the session on logout so its access token stops working', async () => {
    await makeUser({ email: 'bye@cil.gov.in', role: 'cil_user' });
    const { accessToken, cookies } = await loginViaOtp('bye@cil.gov.in');
    const cookie = refreshCookieFrom(cookies);

    await api().get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    await api().post('/api/v1/auth/logout').set('Cookie', cookie).expect(200);

    // requireAuth re-checks live session state, so the still-unexpired access
    // token is rejected immediately rather than lingering for 15 minutes.
    await api().get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
  });

  it('lets a user list and revoke their own sessions', async () => {
    await makeUser({ email: 'sessions@cil.gov.in', role: 'cil_user' });
    const { accessToken } = await loginViaOtp('sessions@cil.gov.in');

    const list = await api()
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].isCurrent).toBe(true);
    // The session list must never carry token material.
    expect(JSON.stringify(list.body)).not.toContain('tokenHash');

    await api()
      .delete(`/api/v1/auth/sessions/${list.body.data[0].id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await api().get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`).expect(401);
  });

  it("returns 404, not 403, when revoking another user's session", async () => {
    await makeUser({ email: 'a@cil.gov.in', role: 'cil_user' });
    await makeUser({ email: 'b@cil.gov.in', role: 'cil_user' });

    const a = await loginViaOtp('a@cil.gov.in');
    const b = await loginViaOtp('b@cil.gov.in');

    const bSessions = await api()
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);

    const res = await api()
      .delete(`/api/v1/auth/sessions/${bSessions.body.data[0].id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
