/**
 * Authentication and session lifecycle — PRD §9.3.
 *
 * Flow (§11.1 decision: email OTP, not magic link — nothing sensitive ever
 * enters a URL, so the §5.2 URL-scrubbing requirement does not arise):
 *
 *   request-code → verify-code → { access token + refresh cookie }
 *   refresh      → rotates the credential, revoking the presented one
 *   logout       → revokes the session
 *
 * Every error path returns the same generic message so an attacker cannot
 * distinguish "no such account" from "wrong code" from "locked".
 */
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError, ErrorCode } from '../../utils/apiError.js';
import { generateNumericCode, generateToken, hashToken, verifyToken } from '../../utils/secureToken.js';
import { signAccessToken } from '../../utils/jwt.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit/audit.service.js';
import { emailService } from '../../services/email.service.js';
import { User, type UserAttrs } from '../users/user.model.js';
import { Session } from './session.model.js';
import { OtpCode } from './otpCode.model.js';
import { InviteToken } from './inviteToken.model.js';
import { LoginAttempt } from './loginAttempt.model.js';

/** One message for every authentication failure — PRD §9.3. */
const GENERIC_AUTH_ERROR = 'Invalid or expired code';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string; role: string; subsidiaryAccess: string[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// OTP issuance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issue a sign-in code.
 *
 * Always resolves, whether or not the account exists — the caller receives the
 * same response either way, which is what prevents email enumeration.
 */
export async function requestCode(email: string, meta: RequestMeta): Promise<void> {
  const user = await User.findOne({ email, isDeleted: false });

  if (!user || !user.isActive) {
    // Deliberate no-op. Logged for monitoring, invisible to the caller.
    logger.info('OTP requested for unknown or inactive account', { emailDomain: email.split('@')[1] });
    return;
  }

  const lock = await LoginAttempt.findOne({ userId: user._id });
  if (lock?.lockedUntil && lock.lockedUntil > new Date()) {
    // Silently decline to issue. Telling the caller the account is locked
    // would itself confirm the account exists.
    logger.warn('OTP requested for locked account', { userId: String(user._id) });
    return;
  }

  // Invalidate any outstanding codes so only the newest is usable.
  await OtpCode.updateMany({ userId: user._id, consumedAt: { $exists: false } }, { consumedAt: new Date() });

  const code = generateNumericCode(env.OTP_LENGTH);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

  await OtpCode.create({ userId: user._id, codeHash: hashToken(code), expiresAt, attempts: 0 });
  await emailService.sendOtpCode(user.email, code, env.OTP_TTL_MINUTES);

  await recordAudit({
    action: 'auth.otp_requested',
    userId: String(user._id),
    ipAddress: meta.ipAddress,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OTP verification
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyCode(email: string, code: string, meta: RequestMeta): Promise<AuthResult> {
  const user = await User.findOne({ email, isDeleted: false });
  if (!user || !user.isActive) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, GENERIC_AUTH_ERROR);
  }

  const userId = String(user._id);
  const now = new Date();

  // ── Per-account lockout (PRD §9.3) ──────────────────────────────────────
  const attempt = await LoginAttempt.findOne({ userId: user._id });
  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    throw new ApiError(ErrorCode.UNAUTHORIZED, GENERIC_AUTH_ERROR);
  }

  const otp = await OtpCode.findOne({
    userId: user._id,
    consumedAt: { $exists: false },
    expiresAt: { $gt: now },
  }).sort({ createdAt: -1 });

  const ok = Boolean(otp) && otp!.attempts < env.OTP_MAX_ATTEMPTS && verifyToken(code, otp!.codeHash);

  if (!ok) {
    if (otp) {
      otp.attempts += 1;
      await otp.save();
    }
    await registerFailure(userId, meta);
    throw new ApiError(ErrorCode.UNAUTHORIZED, GENERIC_AUTH_ERROR);
  }

  // Single use.
  otp!.consumedAt = now;
  await otp!.save();

  await LoginAttempt.deleteOne({ userId: user._id });

  user.lastLoginAt = now;
  await user.save();

  const result = await issueSession(user, meta);

  await recordAudit({ action: 'auth.login_success', userId, ipAddress: meta.ipAddress });
  return result;
}

async function registerFailure(userId: string, meta: RequestMeta): Promise<void> {
  const horizon = new Date(Date.now() + 24 * 60 * 60_000);
  const record = await LoginAttempt.findOneAndUpdate(
    { userId: new Types.ObjectId(userId) },
    { $inc: { failedCount: 1 }, $set: { lastFailureAt: new Date(), expiresAt: horizon } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  await recordAudit({ action: 'auth.login_failed', userId, ipAddress: meta.ipAddress });

  if (record && record.failedCount >= env.OTP_MAX_ATTEMPTS) {
    record.lockedUntil = new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * 60_000);
    record.failedCount = 0;
    await record.save();

    logger.warn('Account locked after repeated failures', { userId });
    await recordAudit({
      action: 'auth.account_locked',
      userId,
      ipAddress: meta.ipAddress,
      metadata: { lockMinutes: env.ACCOUNT_LOCK_MINUTES },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

async function issueSession(
  user: { _id: unknown } & UserAttrs,
  meta: RequestMeta,
  familyId: string = crypto.randomUUID(),
): Promise<AuthResult> {
  const refreshToken = generateToken(32);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60_000);

  const session = await Session.create({
    userId: user._id as Types.ObjectId,
    tokenHash: hashToken(refreshToken),
    familyId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent?.slice(0, 300),
    lastActiveAt: new Date(),
    expiresAt,
  });

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role,
    sid: String(session._id),
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      subsidiaryAccess: (user.subsidiaryAccess ?? []).map(String),
    },
  };
}

/**
 * Rotate a refresh credential — PRD §9.3.
 *
 * Reuse detection: presenting a credential that has already been rotated means
 * either the token was stolen or a legitimate client replayed an old one.
 * Either way the whole family is revoked; that is the primary signal of theft.
 */
export async function refreshSession(presentedToken: string, meta: RequestMeta): Promise<AuthResult> {
  const session = await Session.findOne({ tokenHash: hashToken(presentedToken) });

  if (!session) {
    throw new ApiError(ErrorCode.REFRESH_TOKEN_INVALID, 'Session is no longer valid');
  }

  if (session.rotatedAt || session.revokedAt) {
    // ── Reuse detected ────────────────────────────────────────────────────
    await Session.updateMany(
      { familyId: session.familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
    );

    logger.warn('Refresh token reuse detected — family revoked', {
      userId: String(session.userId),
      familyId: session.familyId,
    });
    await recordAudit({
      action: 'auth.token_reuse_detected',
      userId: String(session.userId),
      ipAddress: meta.ipAddress,
    });

    throw new ApiError(ErrorCode.REFRESH_TOKEN_INVALID, 'Session is no longer valid');
  }

  if (session.expiresAt <= new Date()) {
    throw new ApiError(ErrorCode.REFRESH_TOKEN_INVALID, 'Session is no longer valid');
  }

  const user = await User.findOne({ _id: session.userId, isDeleted: false });
  if (!user || !user.isActive) {
    throw new ApiError(ErrorCode.REFRESH_TOKEN_INVALID, 'Session is no longer valid');
  }

  // Mark the presented credential spent, then issue its successor in the
  // same family.
  session.rotatedAt = new Date();
  session.revokedAt = new Date();
  await session.save();

  const result = await issueSession(user, meta, session.familyId);

  await recordAudit({
    action: 'auth.token_refreshed',
    userId: String(user._id),
    ipAddress: meta.ipAddress,
  });
  return result;
}

export async function logout(refreshTokenValue: string | undefined, meta: RequestMeta): Promise<void> {
  if (!refreshTokenValue) return;

  const session = await Session.findOne({ tokenHash: hashToken(refreshTokenValue) });
  if (!session || session.revokedAt) return;

  session.revokedAt = new Date();
  session.revokedReason = 'logout';
  await session.save();

  await recordAudit({
    action: 'auth.logout',
    userId: String(session.userId),
    ipAddress: meta.ipAddress,
  });
}

/** The user's own active sessions — PRD §9.3. Never exposes token material. */
export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await Session.find({
    userId: new Types.ObjectId(userId),
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastActiveAt: -1 })
    .lean();

  return sessions.map((s) => ({
    id: String(s._id),
    ipAddress: s.ipAddress ?? null,
    userAgent: s.userAgent ?? null,
    lastActiveAt: s.lastActiveAt,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    isCurrent: String(s._id) === currentSessionId,
  }));
}

export async function revokeOwnSession(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
  const session = await Session.findOne({
    _id: new Types.ObjectId(sessionId),
    userId: new Types.ObjectId(userId),
    revokedAt: { $exists: false },
  });

  // 404 rather than 403 — do not confirm another user's session exists.
  if (!session) throw ApiError.notFound('Session not found');

  session.revokedAt = new Date();
  session.revokedReason = 'user_revoked';
  await session.save();

  await recordAudit({
    action: 'auth.session_revoked',
    userId,
    targetType: 'Session',
    targetId: sessionId,
    ipAddress: meta.ipAddress,
  });
}

/** Admin-initiated forced logout — PRD §9.3. */
export async function revokeAllSessionsForUser(
  targetUserId: string,
  actorId: string,
  meta: RequestMeta,
): Promise<number> {
  const result = await Session.updateMany(
    { userId: new Types.ObjectId(targetUserId), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokedReason: 'admin_revoked' } },
  );

  await recordAudit({
    action: 'auth.sessions_revoked_all',
    userId: actorId,
    targetType: 'User',
    targetId: targetUserId,
    metadata: { revokedCount: result.modifiedCount },
    ipAddress: meta.ipAddress,
  });

  return result.modifiedCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invitations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accept an invitation — PRD §9.3.
 *
 * Invalid, expired and already-consumed tokens all produce the same generic
 * error, which is what prevents enumeration on this public endpoint.
 */
export async function acceptInvite(token: string, name: string | undefined, meta: RequestMeta): Promise<AuthResult> {
  const generic = new ApiError(ErrorCode.UNAUTHORIZED, 'This invitation link is invalid or has expired');

  const invite = await InviteToken.findOne({ tokenHash: hashToken(token) });
  if (!invite || invite.consumedAt || invite.expiresAt <= new Date()) {
    throw generic;
  }

  const user = await User.findOne({ _id: invite.userId, isDeleted: false });
  if (!user) throw generic;

  invite.consumedAt = new Date();
  await invite.save();

  user.isActive = true;
  user.isInvitePending = false;
  if (name) user.name = name;
  user.lastLoginAt = new Date();
  await user.save();

  const result = await issueSession(user, meta);

  await recordAudit({
    action: 'invite.accepted',
    userId: String(user._id),
    ipAddress: meta.ipAddress,
  });
  return result;
}

/** Issue an invitation for an existing (pending) user. Returns the raw token. */
export async function createInviteToken(userId: string, invitedBy: string): Promise<string> {
  const token = generateToken(32);
  await InviteToken.create({
    userId: new Types.ObjectId(userId),
    tokenHash: hashToken(token),
    invitedBy: new Types.ObjectId(invitedBy),
    expiresAt: new Date(Date.now() + env.INVITE_TTL_HOURS * 60 * 60_000),
  });
  return token;
}
