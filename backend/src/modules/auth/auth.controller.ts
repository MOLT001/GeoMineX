import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env.js';
import { sendData } from '../../utils/envelope.js';
import { ApiError, ErrorCode } from '../../utils/apiError.js';
import * as authService from './auth.service.js';
import type { RequestCodeInput, VerifyCodeInput, AcceptInviteInput } from './auth.schema.js';

function meta(req: Request): authService.RequestMeta {
  return { ipAddress: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

/**
 * PRD §9.3 / §9.14. The refresh credential lives only in this cookie; the
 * frontend never reads it. `sameSite` follows the deployment-topology decision
 * in env.ts — `strict` for the same-site deployment chosen in §11.9.
 *
 * `path` is scoped to the auth routes so the cookie is not attached to every
 * API request, which shrinks its exposure.
 */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(env.refreshCookie.name, token, {
    httpOnly: true,
    secure: env.refreshCookie.secure,
    sameSite: env.refreshCookie.sameSite,
    maxAge: env.refreshCookie.maxAgeMs,
    path: env.refreshCookie.path,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(env.refreshCookie.name, {
    httpOnly: true,
    secure: env.refreshCookie.secure,
    sameSite: env.refreshCookie.sameSite,
    path: env.refreshCookie.path,
  });
}

export async function requestCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.body as RequestCodeInput;
    await authService.requestCode(email, meta(req));
    // Identical response whether or not the account exists (PRD §9.3).
    sendData(res, { message: 'If that account exists, a sign-in code has been sent.' });
  } catch (err) {
    next(err);
  }
}

export async function verifyCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, code } = req.body as VerifyCodeInput;
    const result = await authService.verifyCode(email, code, meta(req));
    setRefreshCookie(res, result.refreshToken);
    sendData(res, { accessToken: result.accessToken, user: result.user });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[env.refreshCookie.name] as string | undefined;
    if (!token) {
      throw new ApiError(ErrorCode.REFRESH_TOKEN_INVALID, 'Session is no longer valid');
    }

    const result = await authService.refreshSession(token, meta(req));
    setRefreshCookie(res, result.refreshToken);
    sendData(res, { accessToken: result.accessToken, user: result.user });
  } catch (err) {
    // On any refresh failure the cookie is cleared, so a revoked family cannot
    // keep re-triggering reuse detection on every page load.
    clearRefreshCookie(res);
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await authService.logout(req.cookies?.[env.refreshCookie.name] as string | undefined, meta(req));
    clearRefreshCookie(res);
    sendData(res, { message: 'Signed out' });
  } catch (err) {
    next(err);
  }
}

export async function acceptInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, name } = req.body as AcceptInviteInput;
    const result = await authService.acceptInvite(token, name, meta(req));
    setRefreshCookie(res, result.refreshToken);
    sendData(res, { accessToken: result.accessToken, user: result.user });
  } catch (err) {
    next(err);
  }
}

export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    sendData(res, await authService.listSessions(user.id, user.sessionId));
  } catch (err) {
    next(err);
  }
}

export async function revokeSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user!;
    await authService.revokeOwnSession(user.id, req.params.id as string, meta(req));
    sendData(res, { message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
}
