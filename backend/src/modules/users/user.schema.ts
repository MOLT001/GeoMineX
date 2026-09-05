import { z } from 'zod';
import { ROLES } from './user.model.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

/** Same trim-then-validate ordering as auth.schema.ts — see the note there. */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address'));

export const inviteUserSchema = z.object({
  email: emailField,
  name: z.string().min(1).max(120).trim(),
  role: z.enum(ROLES),
  subsidiaryAccess: z.array(objectId).default([]),
});

export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(120).trim().optional(),
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
    /**
     * Typed confirmation for the irreversible half of this endpoint —
     * PRD §8.3. Required only when deactivating.
     */
    confirm: z.string().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'confirm'), {
    message: 'At least one field must be provided',
  });

export const subsidiaryAccessSchema = z.object({
  subsidiaryId: objectId,
});

export const userIdParamSchema = z.object({ id: objectId });

export const userAccessParamSchema = z.object({
  id: objectId,
  subsidiaryId: objectId,
});

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(ROLES).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
