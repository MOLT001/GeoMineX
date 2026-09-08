import type { AuthUser, Role } from './types';

/**
 * A single mirror of every `roleGuard(...)` call in the backend, so there is
 * one place to audit when the API's authorisation changes.
 *
 * ─── THESE ARE UX, NOT AUTHORISATION ────────────────────────────────────────
 * PRD §9.1: "hiding UI elements is not authorization." The server is the
 * control. Everything here exists so a user is not offered a button that will
 * fail — every mutation must still handle a 403 gracefully, because this table
 * can drift and the server cannot.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const CAPABILITIES = {
  'document:upload': ['admin', 'cil_user'],
  'document:retry': ['admin', 'cil_user'],
  'field:override': ['admin', 'cil_user'],
  'report:draft': ['admin', 'cil_user'],
  'report:publish': ['admin'],
  'report:archive': ['admin'],
  'template:create': ['admin'],
  'query:ask': ['admin', 'cil_user', 'moc_official'],
  'query:review': ['admin', 'cil_user'],
  /**
   * The subtle one. The ROUTE allows admin and cil_user, but setting
   * `reviewStatus: 'approved'` is checked inside the service and rejected for
   * anyone but an admin (`query.service.ts`). So the Approve control must be
   * hidden from a CIL user even though the endpoint accepts their other edits.
   */
  'query:approve': ['admin'],
  'subsidiary:create': ['admin'],
  'user:manage': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(user: AuthUser | null, capability: Capability): boolean {
  if (!user) return false;
  return (CAPABILITIES[capability] as readonly Role[]).includes(user.role);
}

/**
 * Only `admin` is unscoped — `isUnscoped()` in the backend returns true for
 * `admin` and nothing else.
 *
 * An MoC Official reads across subsidiaries only through explicit grants
 * (§11.4). Assuming otherwise renders an empty dashboard for an MoC user with
 * no grants and gets reported as a data bug.
 */
export function isUnscoped(user: AuthUser | null): boolean {
  return user?.role === 'admin';
}

/** Subsidiaries this user may pick from. Admin sees everything available. */
export function visibleSubsidiaryIds(user: AuthUser | null, all: string[]): string[] {
  if (!user) return [];
  return isUnscoped(user) ? all : all.filter((id) => user.subsidiaryAccess.includes(id));
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  cil_user: 'CIL User',
  moc_official: 'MoC Official',
};

/** Where each role lands after sign-in when no specific route was requested (§5.2). */
export function landingRoute(role: Role): string {
  return role === 'admin' ? '/admin/users' : '/dashboard';
}
