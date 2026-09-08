import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Contact — PRD §5.1.
 *
 * Informational, with no form. There is no contact endpoint in the API, and a
 * form that posts nowhere is worse than no form: it silently swallows a message
 * the sender believes was delivered. If a contact channel is added later it
 * needs its own endpoint, its own rate limit and its own spam handling, none of
 * which exist today.
 *
 * Account requests are deliberately routed to an administrator rather than to a
 * general inbox — §2 makes provisioning an administrative action, and there is
 * no self-registration to point people at.
 *
 * With no form to fill in, the page is a directory: four service cards, each
 * one a bordered white record with its heading on a tinted caption band. That
 * is the shape a counter-service listing takes on a government portal, and it
 * makes "which of these am I" answerable at a glance.
 */

export const metadata: Metadata = {
  title: 'Contact',
  description: 'How to reach the GeoMineX project team, and how to request an account.',
};

export default function ContactPage() {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
      <header className="border-b-2 border-primary-dark pb-4">
        <h1 className="font-serif text-3xl font-semibold text-primary-dark">Contact</h1>
      </header>

      <p className="mt-5 max-w-[68ch] leading-7 text-text-default">
        GeoMineX is an internal system built for Smart India Hackathon 2026. How to reach us depends
        on what you need.
      </p>

      {/* Tight gaps between the cards: four routes to the same service belong to
          one list, and air between them would read as four unrelated notices. */}
      <div className="mt-8 flex flex-col gap-4">
        <Panel title="You already have an account">
          <p>
            Sign in and use the application. If you cannot sign in, your account may not yet have
            been activated, or your access to a particular subsidiary may not have been granted
            &mdash; both are handled by an administrator in your organisation, not by this team.
          </p>
          <Link
            href="/login"
            className="mt-1 inline-flex w-fit rounded-md bg-sih-blue px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sih-blue-dark"
          >
            Go to sign in
          </Link>
        </Panel>

        <Panel title="You need an account">
          <p>
            There is no self-registration. Accounts are created by an administrator, who sends an
            invitation to your work email address. Ask the GeoMineX administrator in your
            organisation to invite you, and mention which subsidiaries you need access to.
          </p>
        </Panel>

        <Panel title="You are asking about the project itself">
          <p>
            For questions about the system, the problem statement, or the technical approach, write
            to{' '}
            <a
              href="mailto:team@geominex.example"
              className="text-sih-blue underline underline-offset-2 transition-colors hover:text-sih-blue-dark"
            >
              team@geominex.example
            </a>
            .
          </p>
        </Panel>

        <Panel title="You have found a security issue">
          <p>
            Please report it privately to{' '}
            <a
              href="mailto:security@geominex.example"
              className="text-sih-blue underline underline-offset-2 transition-colors hover:text-sih-blue-dark"
            >
              security@geominex.example
            </a>{' '}
            rather than raising it publicly, and give us a reasonable window to fix it before
            disclosing. Include enough detail to reproduce the issue. We will confirm receipt.
          </p>
        </Panel>
      </div>

      {/* The disclaimer is a footnote to the page, so it is ruled off rather
          than left floating at the bottom of the column. */}
      <p className="mt-8 border-t border-border pt-5 text-sm leading-relaxed text-text-muted">
        GeoMineX is a student project. It is not affiliated with, endorsed by, or an official system
        of the Ministry of Coal, Coal India Limited, or CMPDI.
      </p>
    </article>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-border bg-surface">
      {/*
        The heading sits on a caption band with a rule under it, and the content
        on white. Splitting the two is what makes the panel read as a record
        with a label rather than as a tinted box of text — the same relationship
        a table header has to its rows.
      */}
      <h2 className="border-b border-border bg-surface-muted px-5 py-3 font-serif text-base font-semibold text-primary-dark">
        {title}
      </h2>
      <div className="flex flex-col gap-3 px-5 py-4 text-sm leading-relaxed text-text-default">
        {children}
      </div>
    </section>
  );
}
