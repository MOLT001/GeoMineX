/**
 * Seed bootstrap — the one path that creates an account without an invite,
 * so it is worth covering rather than only running by hand.
 */
import { describe, it, expect } from 'vitest';
import { api, loginViaOtp } from './helpers.js';
import { runSeed } from '../src/scripts/seed.js';
import { User } from '../src/modules/users/user.model.js';
import { Subsidiary } from '../src/modules/subsidiaries/subsidiary.model.js';

describe('Seed bootstrap', () => {
  it('creates an active, unscoped admin and the subsidiary list', async () => {
    const result = await runSeed('boot@moc.gov.in', 'System Admin');

    expect(result.adminCreated).toBe(true);
    expect(result.subsidiariesCreated).toBeGreaterThan(0);
    // A starter report template ships with the seed so drafting works at once.
    expect(result.templatesCreated).toBe(1);

    const admin = await User.findOne({ email: 'boot@moc.gov.in' }).lean();
    expect(admin!.role).toBe('admin');
    expect(admin!.isActive).toBe(true);
    // Invite-pending would block sign-in, defeating the point of the script.
    expect(admin!.isInvitePending).toBe(false);
    // Admin is unscoped; carrying grants would be misleading.
    expect(admin!.subsidiaryAccess).toHaveLength(0);

    expect(await Subsidiary.countDocuments()).toBe(result.subsidiariesCreated);
  });

  it('is idempotent', async () => {
    await runSeed('boot@moc.gov.in', 'System Admin');
    const second = await runSeed('boot@moc.gov.in', 'System Admin');

    expect(second.adminCreated).toBe(false);
    expect(second.subsidiariesCreated).toBe(0);
    expect(second.templatesCreated).toBe(0);
    expect(await User.countDocuments({ email: 'boot@moc.gov.in' })).toBe(1);
  });

  it('produces an admin who can sign in and immediately invite a user', async () => {
    await runSeed('boot@moc.gov.in', 'System Admin');
    const { accessToken } = await loginViaOtp('boot@moc.gov.in');

    const subsidiary = await Subsidiary.findOne({ code: 'BCCL' }).lean();

    await api()
      .post('/api/v1/users/invite')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        email: 'first.user@cil.gov.in',
        name: 'First User',
        role: 'cil_user',
        subsidiaryAccess: [String(subsidiary!._id)],
      })
      .expect(201);
  });
});
