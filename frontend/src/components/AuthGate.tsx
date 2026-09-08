'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/auth/AuthProvider';
import { landingRoute } from '@/auth/permissions';
import { loginUrlFor, sanitizeNext } from '@/auth/redirect';
import { Mark } from './brand/Mark';

/**
 * One invariant, enforced in one place:
 *
 *   No route may render a terminal state — a login form, protected content, or
 *   a redirect — while the session is still bootstrapping.
 *
 * Both the authenticated group and the auth group use this. The second is the
 * one people forget: a signed-in user opening a bookmark to /login sees the
 * form flash for ~200ms before being bounced to their dashboard, which reads
 * as a broken app rather than a fast one.
 */

function BootScreen() {
  return (
    // `bg-canvas`, matching the page ground the shells now sit on — a white
    // boot screen flashed against the tinted canvas on every cold load.
    <div className="flex min-h-dvh items-center justify-center bg-canvas" aria-busy="true">
      <div className="flex flex-col items-center gap-4">
        <Mark size={56} decorative className="animate-pulse motion-reduce:animate-none" />
        <p className="text-sm text-text-muted">Restoring your session…</p>
      </div>
    </div>
  );
}

/** Guards the authenticated tree. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (status !== 'anonymous') return;
    const search = searchParams.toString();
    // `replace`, never `push` — otherwise Back lands on the guarded route and
    // bounces straight back here.
    router.replace(loginUrlFor(pathname, search ? `?${search}` : ''));
  }, [status, router, pathname, searchParams]);

  if (status !== 'authenticated') return <BootScreen />;
  return <>{children}</>;
}

/**
 * Guards the auth routes against an ALREADY signed-in user.
 *
 * Sends them to `?next=` if it survives validation, otherwise to their
 * role's landing route (§5.2).
 */
export function RedirectIfAuthenticated({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (status !== 'authenticated' || !user) return;
    router.replace(sanitizeNext(searchParams.get('next')) ?? landingRoute(user.role));
  }, [status, user, router, searchParams]);

  if (status === 'bootstrapping' || status === 'authenticated') return <BootScreen />;
  return <>{children}</>;
}
