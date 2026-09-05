import { z } from 'zod';
import { safeText } from '../../utils/safeText.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

/**
 * Normalise before validating.
 *
 * `z.email().trim()` would validate *first* and reject a pasted address with a
 * stray leading/trailing space — a common and pointless failure. Trimming and
 * lower-casing up front means surrounding whitespace is forgiven while a
 * genuinely malformed address is still rejected.
 */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address'));

export const requestCodeSchema = z.object({
  email: emailField,
});

export const verifyCodeSchema = z.object({
  email: emailField,
  code: z
    .string()
    .regex(/^\d{6,10}$/, 'must be a numeric code'),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20, 'invalid invitation token'),
  name: safeText({ max: 120, label: 'name' }).optional(),
});

export const sessionIdParamSchema = z.object({
  id: objectId,
});

export type RequestCodeInput = z.infer<typeof requestCodeSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
