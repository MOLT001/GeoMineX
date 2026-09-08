'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { RedirectIfAuthenticated } from '@/components/AuthGate';
import { Tricolour } from '@/components/brand/Tricolour';

/**
 * Public auth routes.
 *
 * Wrapped in Suspense because both children read `useSearchParams` (`?next=`
 * on login, `?token=` on invite accept), and Next requires a suspense boundary
 * around that or the build fails.
 *
 * The sign-in screen carries the same utility strip and tricolour rule as the
 * rest of the product, and for a reason beyond consistency: signing in is where
 * a user decides whether a service is genuine. A bare centred card on an empty
 * page is what a phishing clone looks like; the banded chrome, the stated
 * provenance and the explicit "not an official system" disclaimer are what an
 * official service looks like. The identity itself sits inside the panel, next
 * to the form, rather than in a masthead — there is nowhere else to navigate
 * from here, so a full header would be furniture with no function.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <RedirectIfAuthenticated>
        <div className="flex min-h-dvh flex-col bg-canvas">
          <div className="bg-primary-deep text-white/70">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-1.5 text-xs sm:px-6">
              <p>An evidence-locked reporting service for CMPDI and Coal India subsidiaries</p>
              <p className="hidden shrink-0 sm:block">Smart India Hackathon 2026</p>
            </div>
          </div>
          <Tricolour />

          {/*
            The <main> lives here, as it does in every other route group's
            layout, because neither child renders a landmark of its own —
            without it these two screens have none at all and there is nothing
            for a screen reader to jump to. One per page: children must not add
            a second.
          */}
          <main
            id="main-content"
            className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6"
          >
            {children}
          </main>

          <footer className="border-t border-border px-4 py-5 text-center text-xs text-text-muted sm:px-6">
            <p>
              A Smart India Hackathon 2026 project &middot; Not an official system of the Ministry
              of Coal, CIL or CMPDI
            </p>
            <p className="mt-1">
              <Link href="/privacy" className="underline underline-offset-2 hover:text-primary-dark">
                Privacy
              </Link>
            </p>
          </footer>
        </div>
      </RedirectIfAuthenticated>
    </Suspense>
  );
}
