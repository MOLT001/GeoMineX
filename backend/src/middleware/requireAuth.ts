import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { ApiError, ErrorCode } from '../utils/apiError.js';
import { User } from '../modules/users/user.model.js';
import { Session } from '../modules/auth/session.model.js';

/**
 * Authenticate the caller — PRD §9.1.
 *
 * Beyond verifying the JWT signature, this re-checks two pieces of live state
 * the token cannot know about: whether the user is still active, and whether
 * the session behind the token has been revoked. Without those checks a
 * deactivated user or a revoked session would keep working until the access
 * token expired.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Authentication required');
    }

    const payload = verifyAccessToken(header.slice('Bearer '.length).trim());

    const [user, session] = await Promise.all([
      User.findOne({ _id: payload.sub, isDeleted: false }).lean(),
      Session.findById(payload.sid).lean(),
    ]);

    // Generic message: do not reveal which of the checks failed.
    if (!user || !user.isActive) {
      throw new ApiError(ErrorCode.TOKEN_INVALID, 'Invalid access token');
    }
    if (!session || session.revokedAt) {
      throw new ApiError(ErrorCode.TOKEN_INVALID, 'Session is no longer valid');
    }

    req.user = {
      id: String(user._id),
      role: user.role,
      sessionId: String(session._id),
      subsidiaryAccess: (user.subsidiaryAccess ?? []).map(String),
    };
    next();
  } catch (err) {
    next(err);
  }
}
