/** Access-token signing and verification — PRD §9.3 (15-minute lifetime). */
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError, ErrorCode } from './apiError.js';
import type { Role } from '../modules/users/user.model.js';

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  /** Session this token was minted from — lets logout/revocation kill it. */
  sid: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: 'geominex',
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'], // Pinned — prevents algorithm-confusion attacks.
      issuer: 'geominex',
    });
    if (typeof decoded === 'string') {
      throw new ApiError(ErrorCode.TOKEN_INVALID, 'Malformed access token');
    }
    return decoded as unknown as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // Distinct from TOKEN_INVALID so the client knows to refresh rather
      // than re-authenticate (PRD §9.8).
      throw new ApiError(ErrorCode.TOKEN_EXPIRED, 'Access token expired');
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(ErrorCode.TOKEN_INVALID, 'Invalid access token');
  }
}
