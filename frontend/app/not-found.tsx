import Link from 'next/link';
import { Mark } from '@/components/brand/Mark';

/**
 * 404 — required by PRD §10.5 and §13.
 *
 * Wording matters. The API returns 404 both for "does not exist" and for
 * "exists, in a subsidiary you cannot read" — deliberately indistinguishable.
 * This page must not speculate about access, because a helpful "you may not
 * have permission for this subsidiary" would rebuild the existence oracle that
 * the 404-not-403 convention exists to hide.
 *
 * It renders outside both shells, so the card carries the identity on its own:
 * a white record with a navy edge on the tinted page ground, which is the same
 * object every other screen in the product is made of.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 py-16">
      <div className="w-full border border-border bg-surface text-center">
        {/* The navy edge stands in for the masthead this page does not have. */}
        <div aria-hidden className="h-[3px] bg-primary-dark" />

        <div className="flex flex-col items-center gap-4 px-6 py-10">
          <Mark size={64} decorative />
          <h1 className="font-serif text-2xl font-semibold text-primary-dark">Not found</h1>
          <p className="max-w-[42ch] leading-relaxed text-text-default">
            We couldn&rsquo;t find that page. It may have been moved, or the link may be out of
            date.
          </p>
          <Link
            href="/dashboard"
            className="mt-1 rounded-md bg-sih-blue px-5 py-2.5 font-semibold text-white transition-colors hover:bg-sih-blue-dark"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
