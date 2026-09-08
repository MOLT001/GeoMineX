import type { Metadata } from 'next';
import Link from 'next/link';
import { LockupVertical } from '@/components/brand/Lockup';
import { CheckCircleIcon, FileTextIcon, SourceLinkIcon } from '@/components/ui/Icon';

/**
 * Public landing page — PRD §5.1.
 *
 * Carries no internal data and no preview of any report or extracted figure.
 * The header and footer now live in the route-group layout, shared with About,
 * Contact and Privacy.
 *
 * ─── WHY THERE IS NO HERO TREATMENT ─────────────────────────────────────────
 * The landing page of a government service is the same object as every other
 * screen in it: a sheet with rules on it. So the hero is a plain `surface`
 * band closed by a 1px rule, the three sections separate themselves by
 * alternating white and muted ground rather than by floating above each other,
 * and nothing is tinted, blurred or gradiented. A marketing hero here would be
 * the one screen in the product that behaves like a product launch, which is
 * precisely what costs an official service its credibility.
 * ────────────────────────────────────────────────────────────────────────────
 */

export const metadata: Metadata = {
  title: 'GeoMineX',
  description:
    'Evidence-locked document intelligence for CMPDI and Coal India subsidiaries. Every published figure traces back to the page it came from.',
};

export default function HomePage() {
  return (
    <>
      <section className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-4 py-14 text-center sm:px-6 sm:py-16">
          <LockupVertical markSize={96} />

          {/*
            A hairline between the identity and the message. The lockup answers
            "whose service is this"; the headline answers "what does it do".
            They are two statements, and a rule is the cheapest way to say so.
          */}
          <span aria-hidden className="h-px w-16 bg-border-strong" />

          <h1 className="max-w-2xl text-balance font-serif text-3xl leading-tight font-semibold text-primary-dark sm:text-4xl">
            Every figure traces back to the page it came from
          </h1>

          {/*
            The lede is the one paragraph most visitors read in full, so it is
            set at body colour rather than muted — hierarchy comes from size and
            measure here, not from draining the contrast out of the sentence.
          */}
          <p className="max-w-[62ch] leading-relaxed text-text-default sm:text-lg">
            GeoMineX ingests the reports CMPDI and Coal India subsidiaries already produce, extracts
            each figure with a confidence score and a page reference, and answers administrative and
            parliamentary questions from that corpus &mdash; with a citation on every number.
          </p>

          {/*
            One call to action, and Sign in is not it.

            Sign in lives in the masthead, top right, where every government
            portal puts it and where a returning user already looks. Repeating
            it here gave the page two primary buttons competing for the same
            press, and a landing page that asks twice reads as less certain of
            itself, not more helpful. What remains is the one thing a first-time
            visitor actually needs from this screen.
          */}
          <Link
            href="/about"
            className="rounded-md border border-border-strong bg-surface px-6 py-2.5 font-semibold text-primary-dark transition-colors hover:bg-surface-muted"
          >
            About the project
          </Link>
        </div>
      </section>

      <section aria-labelledby="how-heading" className="border-b border-border bg-surface-muted">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-14">
          <h2
            id="how-heading"
            className="text-center font-serif text-2xl font-semibold text-primary-dark"
          >
            How it works
          </h2>
          {/* A short rule under a section heading, the way a circular sets one. */}
          <span aria-hidden className="mx-auto mt-3 block h-[3px] w-12 bg-sih-blue" />

          <ol className="mt-8 grid gap-4 sm:grid-cols-3">
            <Step
              n={1}
              icon={<FileTextIcon size={22} />}
              title="Ingest what already exists"
              body="Upload the annual reports, production statements and geological surveys your subsidiary already files. Nothing has to be re-keyed or reformatted."
            />
            <Step
              n={2}
              icon={<SourceLinkIcon size={22} />}
              title="Extract with provenance"
              body="Each figure is pulled out with a confidence score and the page it came from. Anything the model is unsure of is flagged for a human rather than published quietly."
            />
            <Step
              n={3}
              icon={<CheckCircleIcon size={22} />}
              title="Answer, with citations"
              body="Ask a question in plain language. The answer is assembled only from your corpus, and every number in it links back to the source page."
            />
          </ol>
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto w-full max-w-3xl px-4 py-14 text-center sm:px-6">
          <h2 className="font-serif text-2xl font-semibold text-primary-dark">
            Built for people who have to defend the number
          </h2>
          <p className="mx-auto mt-4 max-w-[68ch] leading-7 text-text-default">
            A figure quoted in a parliamentary reply has to survive being asked where it came from.
            GeoMineX is built around that constraint: an answer with no supporting source says so
            plainly rather than filling the gap, and no figure reaches a published report without a
            traceable page reference behind it.
          </p>
        </div>
      </section>
    </>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    /*
     * A bordered panel on white, not a tinted circle on the page ground.
     * The step marker is a ruled square tile: a soft disc behind an icon is the
     * consumer-software idiom, and the whole point of this language is that a
     * thing with edges reads as a record rather than as an illustration. The
     * ordinal stays inside the heading, where it belongs to the sentence.
     */
    <li className="flex flex-col gap-3 border border-border bg-surface p-5">
      <span className="flex size-10 items-center justify-center border border-border-strong bg-sih-blue-tint text-sih-blue">
        {icon}
      </span>
      <h3 className="font-serif text-lg font-semibold text-primary-dark">
        <span className="text-sih-blue tabular-nums">{n}. </span>
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-text-muted">{body}</p>
    </li>
  );
}
