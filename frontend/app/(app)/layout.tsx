'use client';

import { Suspense } from 'react';
import { usePathname } from 'next/navigation';
import { RequireAuth } from '@/components/AuthGate';
import { useAuth } from '@/auth/AuthProvider';
import { Sidebar, type NavItem } from '@/components/Sidebar';
import {
  ChatIcon,
  ClipboardIcon,
  FileTextIcon,
  GridIcon,
  ShieldIcon,
  TagIcon,
  UsersIcon,
} from '@/components/ui/Icon';
import { Tricolour } from '@/components/brand/Tricolour';

/**
 * The authenticated shell. `RequireAuth` runs here and nowhere else, so every
 * route beneath this layout inherits one guard rather than repeating it.
 *
 * This is client-rendered by constraint, not preference: §11.10 resolved to
 * client-side fetching because the access token lives in memory where no server
 * can read it.
 *
 * ─── FROM THREE STACKED BANDS TO A RAIL AND A STRIP ─────────────────────────
 * This shell used to be the three-band government header — utility strip,
 * identity masthead, navigation band — plus a drawer behind a menu button. Each
 * band answered one question: what IS this, whose service is this and who am I,
 * and where can I go.
 *
 * Those questions still get answered; two of them moved. Navigation and
 * identity are now a permanent left rail, which is what an internal working
 * tool wants: on a portal you visit once a year the masthead IS the product,
 * but here someone moves between Documents, Queries and Reports all day, and
 * every one of those moves was costing a horizontal scan across a band or a
 * click on a hamburger first.
 *
 * What stays full-width at the top is the utility strip and the tricolour rule
 * beneath it, and they stay for a reason worth stating: they are the only
 * chrome that says this is a government-facing service rather than a generic
 * dashboard, and the rail cannot carry that — a claim of provenance belongs
 * across the top of the page, not tucked into a column beside it.
 *
 * The vertical space this returns is the point. Roughly 120px of stacked
 * chrome became a 28px strip, on screens whose main job is a dense table.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * `adminOnly` hides a link the server would refuse anyway. That is a courtesy,
 * not a control — §9.1: "hiding UI elements is not authorization." The Admin
 * Panel is protected by `RequireRole` in its own layout, and by `roleGuard` on
 * every endpoint beneath it.
 *
 * The icon is part of the destination, not decoration: below `lg` the rail
 * collapses to icons alone, so this is the only thing naming the section on
 * screen. See the note in components/Sidebar.tsx.
 *
 * `strokeWidth={2.4}` is arithmetic, not taste. A stroke renders at
 * `strokeWidth * size / 24`, so the default 2 at size 20 is 1.67 device pixels
 * — antialiased across two columns, which is what made these read as furry
 * beside the labels. 2.4 lands on exactly 2px.
 */
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: <GridIcon size={20} strokeWidth={2.4} /> },
  { href: '/documents', label: 'Documents', icon: <FileTextIcon size={20} strokeWidth={2.4} /> },
  // Directly under Documents: it is a second way into the same collection —
  // by subject rather than by file — and the pair reads as one idea there.
  { href: '/topics', label: 'Topics', icon: <TagIcon size={20} strokeWidth={2.4} /> },
  { href: '/reports', label: 'Reports', icon: <ClipboardIcon size={20} strokeWidth={2.4} /> },
  { href: '/queries', label: 'Queries', icon: <ChatIcon size={20} strokeWidth={2.4} /> },
  { href: '/audit', label: 'Audit', icon: <ShieldIcon size={20} strokeWidth={2.4} /> },
  { href: '/admin/users', label: 'Admin', icon: <UsersIcon size={20} strokeWidth={2.4} />, adminOnly: true },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <RequireAuth>
        <AppShell>{children}</AppShell>
      </RequireAuth>
    </Suspense>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const pathname = usePathname();

  return (
    /**
     * Keyed on the user id so that switching accounts remounts the entire tree.
     * Clearing the query cache does not reset component-local state — a
     * half-typed report draft would otherwise survive into the next session.
     */
    /*
     * A fixed-height shell whose CONTENT scrolls, rather than a tall page that
     * scrolls as a whole. That is what a permanent rail needs: `position:
     * sticky` would have to know the strip's height to offset against, and the
     * strip wraps to two lines on a narrow screen, so any number written here
     * would be wrong at some width. Giving the row a bounded height instead
     * means the rail is exactly as tall as the space beside it, always.
     */
    <div key={user?.id ?? 'anon'} className="flex h-dvh flex-col overflow-hidden bg-canvas">
      {/* ── The utility strip, and the tricolour under it ─────────────────── */}
      <header className="shrink-0">
        <div className="bg-primary-deep text-white/70">
          <div className="flex items-center justify-between gap-4 px-4 py-1.5 text-xs sm:px-6">
            <p className="truncate">
              An evidence-locked reporting service for CMPDI and Coal India subsidiaries
            </p>
            {/*
              Factual, and deliberately the only claim of provenance anywhere in
              the chrome. Naming the hackathon states the connection without
              implying government authority — the same reasoning that kept the
              State Emblem off the brand mark.
            */}
            <p className="hidden shrink-0 sm:block">Smart India Hackathon 2026</p>
          </div>
        </div>
        <Tricolour />
      </header>

      {/*
        `min-h-0` on the row: a flex child defaults to `min-height: auto` and
        refuses to shrink below its content, which would push the row past the
        viewport and put the scrollbar back on the page instead of on the column.
      */}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          items={NAV}
          pathname={pathname}
          user={user}
          onSignOut={() => void signOut()}
        />

        {/*
          The scroller. `min-w-0` is the horizontal counterpart of `min-h-0`
          above — without it one wide table refuses to shrink, widens the row,
          and drags the rail off the side of the screen.

          `overflow-x-hidden` because every genuinely wide thing in the product
          already scrolls inside its own container (Table sets `overflow-x-auto`),
          so anything reaching this level is a few pixels of stray margin rather
          than content someone needs to reach sideways.

          `relative` is what makes that clipping actually apply. An
          absolutely-positioned descendant is laid out against its nearest
          POSITIONED ancestor, and is only clipped by an `overflow` on that same
          element — so without this, `.sr-only` spans inside the wide query-log
          table resolved against the initial containing block, escaped the clip,
          and dragged the whole page 28px wide. The symptom was a page that
          scrolled sideways onto nothing; the cause was a 1px invisible span.
          (`relative` does NOT capture `position: fixed`, so the dropdown panel
          is unaffected — only transform/filter/contain would do that.)
        */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          <main id="main-content" className="w-full flex-1 px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </main>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}

/**
 * The authenticated footer.
 *
 * Deliberately spare. A public portal footer carries wayfinding; an internal
 * one carries provenance, and nothing else — every link here would be a second
 * copy of what the rail already lists.
 */
function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-primary-dark text-white/70">
      <div className="flex flex-col gap-2 px-4 py-5 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          GeoMineX &middot; Evidence-locked document intelligence for CMPDI and Coal India
          subsidiaries
        </p>
        <p>
          A Smart India Hackathon 2026 project &middot; Not an official system of the Ministry of
          Coal, CIL or CMPDI
        </p>
      </div>
    </footer>
  );
}
