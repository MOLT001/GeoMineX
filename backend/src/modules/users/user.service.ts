import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { ApiError, ErrorCode } from '../../utils/apiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { emailService } from '../../services/email.service.js';
import { createInviteToken, revokeAllSessionsForUser } from '../auth/auth.service.js';
import { Subsidiary } from '../subsidiaries/subsidiary.model.js';
import { User } from './user.model.js';
import type { InviteUserInput, ListUsersQuery, UpdateUserInput } from './user.schema.js';

export interface ActorMeta {
  actorId: string;
  ipAddress?: string;
}

function present(user: {
  _id: unknown;
  email: string;
  name: string;
  role: string;
  subsidiaryAccess?: unknown[];
  isActive: boolean;
  isInvitePending: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
}) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    subsidiaryAccess: (user.subsidiaryAccess ?? []).map(String),
    isActive: user.isActive,
    isInvitePending: user.isInvitePending,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}

/** Reject grants that name a subsidiary which does not exist. */
async function assertSubsidiariesExist(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const count = await Subsidiary.countDocuments({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    isDeleted: false,
  });
  if (count !== new Set(ids).size) {
    throw ApiError.invalidRequest('One or more subsidiaries do not exist');
  }
}

/** Admin invites a user — PRD §5.9, §9.3. */
export async function inviteUser(input: InviteUserInput, meta: ActorMeta) {
  const existing = await User.findOne({ email: input.email, isDeleted: false });
  if (existing) throw ApiError.conflict('A user with that email already exists');

  await assertSubsidiariesExist(input.subsidiaryAccess);

  // An admin is unscoped by definition; carrying grants would be misleading.
  const grants = input.role === 'admin' ? [] : input.subsidiaryAccess;

  const user = await User.create({
    email: input.email,
    name: input.name,
    role: input.role,
    subsidiaryAccess: grants.map((id) => new Types.ObjectId(id)),
    isActive: false,
    isInvitePending: true,
  });

  const token = await createInviteToken(String(user._id), meta.actorId);
  const inviteUrl = `${env.CLIENT_URL}/invite/accept?token=${encodeURIComponent(token)}`;
  await emailService.sendInvite(user.email, inviteUrl, env.INVITE_TTL_HOURS);

  await recordAudit({
    action: 'invite.issued',
    userId: meta.actorId,
    targetType: 'User',
    targetId: String(user._id),
    metadata: { role: input.role },
    ipAddress: meta.ipAddress,
  });

  return present(user);
}

export async function listUsers(query: ListUsersQuery) {
  const filter: Record<string, unknown> = { isDeleted: false };
  if (query.role) filter.role = query.role;
  if (query.isActive) filter.isActive = query.isActive === 'true';

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    data: users.map(present),
    pagination: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit) || 0,
    },
  };
}

export async function getUserById(id: string) {
  const user = await User.findOne({ _id: id, isDeleted: false }).lean();
  if (!user) throw ApiError.notFound('User not found');
  return present(user);
}

/**
 * Update a user — PRD §5.9, §8.3.
 *
 * Two guards worth naming: an admin may not demote or deactivate themselves
 * (the last admin doing so would lock the deployment out of its own admin
 * panel), and deactivation is irreversible enough to require typed
 * confirmation.
 */
export async function updateUser(targetId: string, input: UpdateUserInput, meta: ActorMeta) {
  const user = await User.findOne({ _id: targetId, isDeleted: false });
  if (!user) throw ApiError.notFound('User not found');

  const isSelf = String(user._id) === meta.actorId;

  if (isSelf && input.role && input.role !== user.role) {
    throw new ApiError(ErrorCode.CANNOT_SELF_DEMOTE, 'You cannot change your own role');
  }
  if (isSelf && input.isActive === false) {
    throw new ApiError(ErrorCode.CANNOT_SELF_DEMOTE, 'You cannot deactivate your own account');
  }

  const isDeactivating = input.isActive === false && user.isActive;
  if (isDeactivating && input.confirm !== user.email) {
    throw new ApiError(
      ErrorCode.CONFIRM_TEXT_MISMATCH,
      "To deactivate this user, provide their email address in the 'confirm' field",
    );
  }

  if (input.name) user.name = input.name;
  if (input.role) {
    user.role = input.role;
    if (input.role === 'admin') user.subsidiaryAccess = [];
  }
  if (input.isActive !== undefined) user.isActive = input.isActive;
  await user.save();

  if (isDeactivating) {
    // A deactivated user must lose their live sessions immediately; otherwise
    // they stay signed in until their refresh credential lapses.
    await revokeAllSessionsForUser(targetId, meta.actorId, { ipAddress: meta.ipAddress });
  }

  await recordAudit({
    action: isDeactivating ? 'user.deactivated' : 'user.updated',
    userId: meta.actorId,
    targetType: 'User',
    targetId,
    metadata: { changed: Object.keys(input).filter((k) => k !== 'confirm') },
    ipAddress: meta.ipAddress,
  });

  return present(user);
}

export async function grantSubsidiaryAccess(targetId: string, subsidiaryId: string, meta: ActorMeta) {
  const user = await User.findOne({ _id: targetId, isDeleted: false });
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === 'admin') {
    throw ApiError.invalidRequest('Admin users are unscoped and do not take subsidiary grants');
  }

  await assertSubsidiariesExist([subsidiaryId]);

  const oid = new Types.ObjectId(subsidiaryId);
  if (!user.subsidiaryAccess.some((id) => id.equals(oid))) {
    user.subsidiaryAccess.push(oid);
    await user.save();
  }

  await recordAudit({
    action: 'user.subsidiary_access_granted',
    userId: meta.actorId,
    targetType: 'User',
    targetId,
    subsidiaryId,
    ipAddress: meta.ipAddress,
  });

  return present(user);
}

export async function revokeSubsidiaryAccess(
  targetId: string,
  subsidiaryId: string,
  confirm: string | undefined,
  meta: ActorMeta,
) {
  const user = await User.findOne({ _id: targetId, isDeleted: false });
  if (!user) throw ApiError.notFound('User not found');

  const subsidiary = await Subsidiary.findOne({ _id: subsidiaryId, isDeleted: false });
  if (!subsidiary) throw ApiError.notFound('Subsidiary not found');

  // Irreversible in effect — the user loses sight of that subsidiary's data
  // immediately (PRD §8.3).
  if (confirm !== subsidiary.code) {
    throw new ApiError(
      ErrorCode.CONFIRM_TEXT_MISMATCH,
      "To revoke access, provide the subsidiary code in the 'confirm' field",
    );
  }

  const oid = new Types.ObjectId(subsidiaryId);
  user.subsidiaryAccess = user.subsidiaryAccess.filter((id) => !id.equals(oid));
  await user.save();

  await recordAudit({
    action: 'user.subsidiary_access_revoked',
    userId: meta.actorId,
    targetType: 'User',
    targetId,
    subsidiaryId,
    ipAddress: meta.ipAddress,
  });

  return present(user);
}
