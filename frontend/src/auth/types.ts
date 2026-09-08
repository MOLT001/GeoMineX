/** Shapes returned by the auth endpoints — mirrors backend/src/modules/auth. */

export const ROLES = ['admin', 'cil_user', 'moc_official'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * Subsidiary ids this user may read. Empty for an admin, who is unscoped —
   * `isUnscoped()` in the backend returns true for `admin` ONLY.
   *
   * An MoC Official is NOT unscoped: they hold explicit per-subsidiary grants
   * (§11.4). A UI that assumes otherwise renders an empty dashboard for an MoC
   * user with no grants and reads it as a bug.
   */
  subsidiaryAccess: string[];
}

/** `POST /auth/verify-code`, `/auth/refresh` and `/auth/invites/accept` all return this. */
export interface AuthResult {
  accessToken: string;
  user: AuthUser;
}

export interface SessionSummary {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}
