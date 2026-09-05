import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { roleGuard } from '../../middleware/roleGuard.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './user.controller.js';
import {
  inviteUserSchema,
  listUsersQuerySchema,
  subsidiaryAccessSchema,
  updateUserSchema,
  userAccessParamSchema,
  userIdParamSchema,
} from './user.schema.js';

export const userRouter = Router();

// Every route here is authenticated.
userRouter.use(requireAuth);

// Any authenticated user may read their own profile.
userRouter.get('/me', controller.getMe);

// ── Admin-only user management (PRD §5.9) ───────────────────────────────────
userRouter.post('/invite', roleGuard('admin'), validate({ body: inviteUserSchema }), controller.inviteUser);

userRouter.get('/', roleGuard('admin'), validate({ query: listUsersQuerySchema }), controller.listUsers);

userRouter.get('/:id', roleGuard('admin'), validate({ params: userIdParamSchema }), controller.getUser);

userRouter.patch(
  '/:id',
  roleGuard('admin'),
  validate({ params: userIdParamSchema, body: updateUserSchema }),
  controller.updateUser,
);

userRouter.post(
  '/:id/subsidiary-access',
  roleGuard('admin'),
  validate({ params: userIdParamSchema, body: subsidiaryAccessSchema }),
  controller.grantAccess,
);

userRouter.delete(
  '/:id/subsidiary-access/:subsidiaryId',
  roleGuard('admin'),
  validate({ params: userAccessParamSchema }),
  controller.revokeAccess,
);

userRouter.delete(
  '/:id/sessions',
  roleGuard('admin'),
  validate({ params: userIdParamSchema }),
  controller.forceLogout,
);
