'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LockupHorizontal } from '@/components/brand/Lockup';
import { Tricolour } from '@/components/brand/Tricolour';

/**
 * The four public routes — PRD §5.1, §1.4.
 *
 * Everything under this layout is reachable without signing in, so the rule for
 * the whole group is: NO INTERNAL DATA. No figures from the corpus, no report
 * titles, no subsidiary activity, no counts. §1.4 makes this an internal system
 * whose public surface exists to explain the project, not to preview it — and a
 * "sample extraction" on a landing page would be exactly the disclosure the
 * scoping rules elsewhere work to prevent.
 *
 * These pages render dynamically rather than statically, and not by choice:
 * the root layout sets `dynamic = 'force-dynamic'` so Next can stamp the
 * per-request CSP nonce onto its scripts. A prerendered public page would ship
 * with a stale nonce and no working JavaScript.
 *
 * A client component only so the two navs can read `usePathname` and mark the
 * current page. The children stay server components — they arrive as a prop —
 * so each page keeps its own `metadata` export.
 *
 * The header mirrors the authenticated shell's three bands (utility, identity,
 * navigation) so signing in is a change of content rather than a change of
 * product. The one difference: with three destinations the navigation sits in
 * the masthead rather than earning a band of its own.
 */

const NAV = [
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
  { href: '/privacy', label: 'Privacy' },
];

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Prefix match rather than equality, so a future `/privacy/cookies` still
  // marks Privacy as the section you are in — the same rule as the app nav.
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header>
        {/* ── Band 1: utility ─────────────────────────────────────────────── */}
        <div className="bg-primary-deep text-white/70">
          <div className="flex items-center justify-between gap-4 px-4 py-1.5 text-xs sm:px-6">
            <p>
              An evidence-locked reporting service for CMPDI and Coal India
              subsidiaries
            </p>
            <p className="hidden shrink-0 sm:block">
              Smart India Hackathon 2026
            </p>
          </div>
        </div>

        {/* ── Band 2: identity + navigation ───────────────────────────────── */}
        <div className="bg-surface">
          {/*
            ─── THE CHROME IS FULL-BLEED; THE CONTENT IS NOT ───────────────────
            Both header bands span the window rather than sitting in a centred
            1152px column. On a wide screen that column left roughly 370px of
            empty margin on each side, so the masthead ended well short of the
            window and the navigation read as floating in the middle of the page
            rather than belonging to its edges.

            The page BODY keeps its centred measure — a hero set 1900px wide is
            unreadable — which is the same split the authenticated shell makes:
            chrome to the edges, prose to a column. The tricolour rule below was
            always full-bleed, and the header now agrees with it.
            ────────────────────────────────────────────────────────────────────

            Logo left, links and Sign in together on the right. `ml-auto` on the
            group is what holds that at every width: below `sm` the three links
            are hidden, and without it Sign in would slide left against the logo
            and leave the whole right side of the header empty.
          */}
          <nav
            aria-label="Main"
            className="flex items-center gap-4 px-4 py-4 sm:gap-6 sm:px-6"
          >
            <Link href="/" aria-label="GeoMineX home" className="shrink-0">
              <LockupHorizontal markSize={40} />
            </Link>

            <div className="ml-auto flex items-center gap-2 sm:gap-5">
              <div className="hidden items-center gap-1 sm:flex">
                {NAV.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      // `aria-current` is what conveys "you are here" without
                      // sight; the underline and weight convey it only to
                      // people who can see them.
                      aria-current={active ? 'page' : undefined}
                      // Label/XL (16px) per UX4G's usage map for a navigation item, at a
                      // 44px target height.
                      className={`inline-flex min-h-11 items-center border-b-2 px-3 text-base transition-colors duration-150 ${
                        active
                          ? 'border-sih-blue font-semibold text-primary-dark'
                          : 'border-transparent text-text-muted hover:border-border-strong hover:text-primary-dark'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>

              <Link
                href="/login"
                className="inline-flex min-h-11 shrink-0 items-center rounded-sm bg-sih-blue px-5 text-base font-semibold text-white transition-colors duration-150 hover:bg-sih-blue-dark"
              >
                Sign in
              </Link>
            </div>
          </nav>
        </div>

        <Tricolour />
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-border bg-primary-dark text-white/75">
        {/* Full-bleed, to agree with the header above it. */}
        <div className="px-4 py-10 sm:px-6">
          <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
            <div className="max-w-sm">
              <LockupHorizontal variant="knockout" markSize={32} />
              <p className="mt-3 text-sm leading-relaxed">
                Every figure traces back to the page it came from.
              </p>
            </div>

            <nav aria-label="Footer" className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-wide text-white uppercase">
                About this service
              </h2>
              {/*
                No Sign in here. There is exactly one on the public site, in the
                masthead — a second copy in the footer is a duplicate route to
                the same screen, and duplicated calls to action are how a
                visitor ends up unsure which one is the real entrance.
              */}
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className="inline-flex min-h-11 items-center text-base transition-colors duration-150 hover:text-white hover:underline hover:underline-offset-4"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          {/*
            Factual framing of the government connection, and the reason the
            State Emblem was cropped out of the brand mark: naming the hackathon
            makes the association clear without implying authority. Claiming more
            than this is what the Emblem Act prohibits.
          */}
          <div className="mt-8 border-t border-white/15 pt-5 text-xs">
            <p>
              A Smart India Hackathon 2026 project &middot; Problem statement
              SIH26023
            </p>
            <p className="mt-1">
              Not affiliated with, endorsed by, or an official system of the
              Ministry of Coal, Coal India Limited, or CMPDI.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
