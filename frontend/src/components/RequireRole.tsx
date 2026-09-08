'use client';

import Link from 'next/link';
import { useId } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import type { Role } from '@/auth/types';

/**
 * Role gate for whole route subtrees — currently just the Admin Panel.
 *
 * Nested INSIDE the authenticated group, so `RequireAuth` has already run in a
 * parent layout and this is a pure role check with no duplicated bootstrap.
 *
 * Renders 403, not 404, and that asymmetry mirrors the backend exactly:
 *
 *   - `roleGuard` returns 403 — reaching a role-gated route means the caller
 *     may legitimately know it exists; only the ACTION is denied.
 *   - `assertSubsidiaryAccess` returns 404 — the resource's existence is itself
 *     the secret.
 *
 * A UI that showed "forbidden" for a cross-subsidiary miss would hand back the
 * existence oracle the backend goes out of its way to hide.
 */
export function RequireRole({
  roles,
  children,
}: {
  roles: readonly Role[];
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const headingId = useId();

  if (!user) return null; // RequireAuth above is already redirecting.

  if (!roles.includes(user.role)) {
    return (
      // A section, not a <main>: this gate always renders inside the app
      // layout's own <main>, and a second main landmark leaves a screen reader
      // with two candidates for "the page content" and no way to rank them.
      // `aria-labelledby` is what keeps the region named once the tag changes.
      // Set as an official refusal notice — a bordered panel with a left accent
      // bar — rather than as centred marketing text. A denial in a government
      // system is a formal outcome, and it should look like the system meant it.
      <section
        aria-labelledby={headingId}
        className="mx-auto my-10 max-w-2xl border border-border-strong border-l-4 border-l-danger bg-surface"
      >
        <div className="flex flex-col items-start gap-4 p-6 sm:p-8">
          <h1 id={headingId} className="font-serif text-xl font-semibold text-primary-dark">
            You don&rsquo;t have access to this page
          </h1>
          <p className="text-text-muted">
            This area is limited to administrators. If you think that&rsquo;s wrong, ask an
            administrator to review your role.
          </p>
          <Link
            href="/dashboard"
            className="rounded-md bg-sih-blue px-5 py-2.5 font-semibold text-white transition-colors hover:bg-sih-blue-dark"
          >
            Back to dashboard
          </Link>
        </div>
      </section>
    );
  }

  return <>{children}</>;
}
