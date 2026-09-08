'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { LockupHorizontal } from '@/components/brand/Lockup';
import { Mark } from '@/components/brand/Mark';
import { ROLE_LABELS } from '@/auth/permissions';
import type { AuthUser, Role } from '@/auth/types';
import { cn } from '@/lib/cn';

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
}

/**
 * The navigation, as a permanent left rail.
 *
 * ─── WHY THIS REPLACED A DRAWER, AND WHY THERE IS NO HAMBURGER ──────────────
 * This was a slide-over on a native <dialog>, opened from a menu button. A
 * drawer is the right shape when navigation has to be summoned; it is the wrong
 * shape when there is room to just show it. Eight destinations fit in a column
 * with space to spare, and a sidebar that is always there costs nothing to
 * read: no open state, no focus trap, no Escape handling, and no button whose
 * only job is to reveal what could have been on screen the whole time.
 *
 * The trade a permanent rail makes is horizontal space, and that is what the
 * `lg` breakpoint below is for — NOT a hamburger returning by another name.
 * Under `lg` the rail keeps every destination and drops only the words: the
 * icons stay, the column narrows to 64px, and each link carries its name as an
 * `aria-label`, so nothing becomes unreachable and nothing needs opening. That
 * is why the section icons in ui/Icon.tsx had to be the conventional glyph for
 * each section rather than the interesting one — in the rail the icon is the
 * label.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `<aside>` rather than a bare <div>, and one <nav> inside it: the landmark is
 * what lets a screen-reader user jump straight here, and it is the thing a
 * drawer could never offer without being opened first.
 */
export function Sidebar({
  items,
  pathname,
  user,
  onSignOut,
}: {
  items: readonly NavItem[];
  pathname: string;
  user: AuthUser | null;
  onSignOut: () => void;
}) {
  const role: Role | undefined = user?.role;

  return (
    <aside
      className={cn(
        // `h-full`, not `h-dvh`, and no `sticky`. The shell in (app)/layout.tsx
        // is a fixed-height column whose CONTENT scrolls, so the rail is simply
        // as tall as the row it sits in. `h-dvh` here made it a strip's height
        // taller than the space available and clipped Sign out off the bottom.
        'flex h-full shrink-0 flex-col',
        'border-r border-border bg-surface',
        'w-16 lg:w-60',
      )}
    >
      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <div className="flex h-16 shrink-0 items-center justify-center border-b border-border px-3 lg:justify-start lg:px-4">
        <Link href="/dashboard" aria-label="GeoMineX — go to dashboard">
          {/*
            Two components rather than one hidden by CSS: the horizontal lockup
            has the wordmark baked into its SVG, so at rail width it would not
            shrink, it would overflow.
          */}
          <span className="lg:hidden">
            <Mark size={32} />
          </span>
          <span className="hidden lg:block">
            <LockupHorizontal markSize={34} />
          </span>
        </Link>
      </div>

      {/* ── Destinations ─────────────────────────────────────────────────── */}
      <nav aria-label="Sections" className="flex-1 overflow-y-auto p-2 lg:p-3">
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            // Hiding a link the server would refuse is a courtesy, not a
            // control — §9.1. `RequireRole` and `roleGuard` are the control.
            if (item.adminOnly && role !== 'admin') return null;

            // `/admin/users` must read as current across the whole panel, so
            // the compared prefix is the section, not this link's target.
            const section = item.adminOnly ? '/admin' : item.href;
            const active = pathname === section || pathname.startsWith(`${section}/`);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  // The name for the collapsed rail, where the label is not
                  // rendered. Harmless when the words ARE visible: an explicit
                  // label simply wins over the same text content.
                  aria-label={item.label}
                  title={item.label}
                  className={cn(
                    // 44px minimum, UX4G's hard rule for an interactive control.
                    'flex min-h-11 items-center gap-3 rounded-md text-base transition-colors duration-150',
                    'justify-center px-2 lg:justify-start lg:px-3',
                    active
                      ? // A solid fill, not a tint. This is the one element on
                        // screen that answers "where am I", and a 15% wash does
                        // not survive a glance the way a filled row does.
                        'bg-sih-blue font-semibold text-white'
                      : 'text-text-default hover:bg-surface-muted hover:text-primary-dark',
                  )}
                >
                  <span className="shrink-0" aria-hidden>
                    {item.icon}
                  </span>
                  {/* Hidden by width, not removed: it is the accessible name. */}
                  <span className="hidden truncate lg:block">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border p-2 lg:p-3">
        {user ? (
          <Link
            href="/settings/sessions"
            className="flex min-h-11 items-center gap-2.5 rounded-md px-1 transition-colors hover:bg-surface-muted lg:px-2"
            aria-label={`${user.name} — ${ROLE_LABELS[user.role]}. Sessions and account.`}
          >
            <Avatar name={user.name} />
            <span className="hidden min-w-0 flex-col leading-tight lg:flex">
              <span className="truncate text-sm font-semibold text-text-strong">{user.name}</span>
              <span className="truncate text-xs text-text-muted">{ROLE_LABELS[user.role]}</span>
            </span>
          </Link>
        ) : null}

        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className={cn(
            'mt-1 flex min-h-11 w-full items-center gap-3 rounded-md text-base font-medium',
            'text-primary-dark transition-colors duration-150 hover:bg-surface-muted',
            'justify-center px-2 lg:justify-start lg:px-3',
          )}
        >
          <SignOutIcon />
          <span className="hidden lg:block">Sign out</span>
        </button>
      </div>
    </aside>
  );
}

/**
 * Initials on a tinted disc.
 *
 * A photograph is what the reference design shows, but this product has no
 * avatar field and inventing one would mean a new upload path, a new storage
 * decision (§11.6 is still open) and a new thing to moderate. Initials carry
 * the same "this is your account" signal at the same size for none of that.
 */
function Avatar({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sih-blue-tint text-sm font-semibold text-sih-blue"
    >
      {initials}
    </span>
  );
}

/**
 * Kept local rather than added to ui/Icon.tsx: it labels one control in one
 * place, where that module's set is the shared status and section vocabulary.
 */
function SignOutIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M15 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2" />
      <path d="M10 17l-5-5 5-5" />
      <path d="M5 12h9" />
    </svg>
  );
}
