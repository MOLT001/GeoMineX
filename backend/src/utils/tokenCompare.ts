/**
 * Timing-safe comparison for secret material — PRD §9.3.
 *
 * Never use `===` on tokens, hashes, or codes: a short-circuiting comparison
 * leaks how many leading characters were correct.
 */
import crypto from 'node:crypto';

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, so compare digests of equal
  // length instead of returning early on `.length` — the early return would
  // itself leak the length of the expected value.
  const digestA = crypto.createHash('sha256').update(bufA).digest();
  const digestB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}
