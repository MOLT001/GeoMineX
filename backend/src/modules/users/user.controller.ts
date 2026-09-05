import type { Request, Response, NextFunction } from 'express';
import { sendCreated, sendData, sendPaginated } from '../../utils/envelope.js';
import { validatedQuery } from '../../middleware/validate.js';
import { revokeAllSessionsForUser } from '../auth/auth.service.js';
import * as userService from './user.service.js';
import type { InviteUserInput, ListUsersQuery, UpdateUserInput } from './user.schema.js';

function actor(req: Request): userService.ActorMeta {
  return { actorId: req.user!.id, ipAddress: req.ip };
}

/** The caller's own profile. */
export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await userService.getUserById(req.user!.id));
  } catch (err) {
    next(err);
  }
}

export async function inviteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendCreated(res, await userService.inviteUser(req.body as InviteUserInput, actor(req)));
  } catch (err) {
    next(err);
  }
}

export async function listUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await userService.listUsers(validatedQuery<ListUsersQuery>(res));
    sendPaginated(res, result.data, result.pagination);
  } catch (err) {
    next(err);
  }
}

export async function getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(res, await userService.getUserById(req.params.id as string));
  } catch (err) {
    next(err);
  }
}

export async function updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendData(
      res,
      await userService.updateUser(req.params.id as string, req.body as UpdateUserInput, actor(req)),
    );
  } catch (err) {
    next(err);
  }
}

export async function grantAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { subsidiaryId } = req.body as { subsidiaryId: string };
    sendData(res, await userService.grantSubsidiaryAccess(req.params.id as string, subsidiaryId, actor(req)));
  } catch (err) {
    next(err);
  }
}

export async function revokeAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { confirm } = (req.body ?? {}) as { confirm?: string };
    sendData(
      res,
      await userService.revokeSubsidiaryAccess(
        req.params.id as string,
        req.params.subsidiaryId as string,
        confirm,
        actor(req),
      ),
    );
  } catch (err) {
    next(err);
  }
}

/** Admin-initiated forced logout — PRD §9.3. */
export async function forceLogout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const revokedCount = await revokeAllSessionsForUser(req.params.id as string, req.user!.id, { ipAddress: req.ip });
    sendData(res, { revokedCount });
  } catch (err) {
    next(err);
  }
}
