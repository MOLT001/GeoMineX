/**
 * Generation and hashing of high-entropy credentials — PRD §9.3, §11.11.
 *
 * Hashing primitive: HMAC-SHA256, per the §11.11 recommendation, NOT bcrypt.
 * bcrypt is built for low-entropy human passwords; for a 32-byte random token
 * it silently truncates input past 72 bytes and costs ~100 ms on the most
 * frequently called authenticated endpoint in the system, while its work
 * factor buys nothing against 256 bits of entropy.
 *
 * Swapping this primitive means changing only this file — every caller goes
 * through `hashToken`. bcrypt remains the correct choice for passwords,
 * should a password flow ever be introduced.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { safeCompare } from './tokenCompare.js';

/** Opaque session/invite token: 32 random bytes, URL-safe. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Numeric OTP code, uniformly distributed.
 *
 * `randomInt` is rejection-sampled by Node, so this carries none of the modulo
 * bias that `randomBytes % 10` would introduce.
 */
export function generateNumericCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i += 1) code += crypto.randomInt(0, 10).toString();
  return code;
}

/** Keyed hash for storage. The key never leaves the environment. */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', env.TOKEN_HASH_SECRET).update(token).digest('hex');
}

/** Timing-safe verification of a presented token against a stored hash. */
export function verifyToken(presented: string, storedHash: string): boolean {
  return safeCompare(hashToken(presented), storedHash);
}
