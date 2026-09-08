import type { Metadata } from 'next';

/**
 * About — PRD §5.1.
 *
 * Public-safe copy only. It describes what the system does and the constraints
 * it was built under; it names no subsidiary's data, quotes no extracted
 * figure, and shows no report.
 *
 * Set as a DOCUMENT rather than as a page of marketing sections: a white sheet
 * on the tinted page ground, one column at a reading measure of roughly 70
 * characters, a heavy rule under the title the way a circular carries one, and
 * an accent bar beside each section heading. This is where the serif/sans
 * pairing earns its keep — the headings are set like a gazette and the body
 * like something meant to be read to the end.
 */

export const metadata: Metadata = {
  title: 'About',
  description:
    'What GeoMineX does, the problem it addresses, and the traceability constraints it was built under.',
};

export default function AboutPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
      <article className="border border-border bg-surface px-5 py-8 sm:px-10 sm:py-10">
        {/*
          A 2px rule in the navy under the title, not a hairline: it is the
          masthead of the document, and it is the one place on the page where a
          border is allowed to be assertive.
        */}
        <header className="border-b-2 border-primary-dark pb-4">
          <h1 className="font-serif text-3xl font-semibold text-primary-dark">About GeoMineX</h1>
        </header>

        <div className="mt-8 flex max-w-[68ch] flex-col gap-10">
          <Prose title="The problem">
            <p>
              Coal India&rsquo;s subsidiaries and CMPDI produce a large, continuous body of
              technical documentation &mdash; annual reports, production statements, geological
              survey reports, environmental filings. The information needed to answer an
              administrative or parliamentary question is almost always somewhere in that corpus.
              Finding it means knowing which document, opening it, and reading until the figure
              appears.
            </p>
            <p>
              That work is slow, and it does not scale with the number of questions asked. It is
              also fragile in a specific way: once a figure has been copied out of a PDF into a
              reply, the link back to the page it came from exists only in the memory of whoever
              copied it.
            </p>
          </Prose>

          <Prose title="What GeoMineX does">
            <p>
              Documents are uploaded once and processed into text, with each numeric figure
              extracted alongside a confidence score and the page it appeared on. Low-confidence
              extractions are routed to a human for review rather than being accepted silently, and
              a reviewer&rsquo;s correction is recorded as an override with the original value
              preserved.
            </p>
            <p>
              Questions are asked in plain language and answered from that corpus alone. Every
              number in an answer carries a citation that opens the source document at the page the
              figure came from. Draft reports are assembled from the same material, so a published
              report and the answer to a question about it rest on the same evidence.
            </p>
          </Prose>

          <Prose title="What it will not do">
            <p>
              The system does not answer from general knowledge. If the corpus does not support an
              answer, it says so and stops &mdash; a response marked unsupported is a correct
              response, and it is treated as one rather than as a failure to be papered over. An
              answer supported by only part of the corpus is marked as partially sourced rather than
              presented with the same confidence as a fully sourced one.
            </p>
            <p>
              No figure reaches a published report without a traceable page reference behind it, and
              publishing is a deliberate, separately authorised step &mdash; the person who drafts a
              report is not the person who publishes it.
            </p>
          </Prose>

          <Prose title="Access and scope">
            <p>
              GeoMineX is an internal system. Accounts are created by an administrator; there is no
              self-registration. Each user sees only the subsidiaries they hold access to, and that
              boundary is enforced by the server on every request rather than by hiding controls in
              the interface.
            </p>
            <p>
              Every consequential action &mdash; an upload, an override, a publication, a grant of
              access &mdash; is written to an audit log that records who did it, when, and to what.
            </p>
          </Prose>

          <Prose title="The project">
            <p>
              GeoMineX was built for Smart India Hackathon 2026 against problem statement SIH26023.
              It is a student project and is not affiliated with, endorsed by, or an official system
              of the Ministry of Coal, Coal India Limited, or CMPDI.
            </p>
          </Prose>
        </div>
      </article>
    </div>
  );
}

function Prose({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      {/*
        An accent bar rather than a rule across the column: a full-width divider
        between every section chops a document into unrelated cards, where a bar
        beside the heading marks the break and leaves the reading continuous.
      */}
      <h2 className="border-l-[3px] border-sih-blue pl-3 font-serif text-xl font-semibold text-primary-dark">
        {title}
      </h2>
      {/* Body copy at full text colour and open leading — this is the content
          of the page, not supporting text, so it is not set in the muted ink. */}
      <div className="flex flex-col gap-4 leading-7 text-text-default">{children}</div>
    </section>
  );
}
