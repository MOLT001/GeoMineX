import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { authLimiter, publicLimiter } from '../../middleware/rateLimiters.js';
import * as controller from './auth.controller.js';
import { requestCodeSchema, verifyCodeSchema, acceptInviteSchema, sessionIdParamSchema } from './auth.schema.js';

export const authRouter = Router();

// ── Public, strictly rate limited (PRD §9.2) ────────────────────────────────
authRouter.post('/request-code', authLimiter, validate({ body: requestCodeSchema }), controller.requestCode);
authRouter.post('/verify-code', authLimiter, validate({ body: verifyCodeSchema }), controller.verifyCode);
authRouter.post('/refresh', authLimiter, controller.refresh);
authRouter.post('/logout', controller.logout);

// Public invite acceptance gets its own limiter — it cannot be limited per
// user, since the caller is not yet authenticated (PRD §9.2).
authRouter.post('/invites/accept', publicLimiter, validate({ body: acceptInviteSchema }), controller.acceptInvite);

// ── Authenticated session management (PRD §9.3) ─────────────────────────────
authRouter.get('/sessions', requireAuth, controller.listSessions);
authRouter.delete(
  '/sessions/:id',
  requireAuth,
  validate({ params: sessionIdParamSchema }),
  controller.revokeSession,
);
