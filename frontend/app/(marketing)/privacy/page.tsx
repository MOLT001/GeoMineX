import type { Metadata } from 'next';

/**
 * Privacy — PRD §5.1.
 *
 * Every claim on this page describes behaviour the system actually has, and
 * each is checkable in the code:
 *
 *   - no tokens in browser storage  →  src/auth/tokenStore.ts (memory only),
 *     asserted by a §13 acceptance check
 *   - audit trail                   →  backend recordAudit(), §9.6
 *   - subsidiary scoping            →  backend/src/utils/authorization.ts
 *   - no third-party analytics      →  CSP `connect-src 'self'`, src/lib/csp.ts
 *
 * A privacy page that promises more than the code does is worse than none, so
 * anything added here must be traceable to an enforced behaviour.
 *
 * Set as a document, on the same sheet as About: a policy people are expected
 * to read in full is typeset for reading, not laid out for scanning.
 */

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What GeoMineX stores, who can see it, and how long it is kept.',
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
      <article className="border border-border bg-surface px-5 py-8 sm:px-10 sm:py-10">
        <header className="border-b-2 border-primary-dark pb-4">
          <h1 className="font-serif text-3xl font-semibold text-primary-dark">Privacy</h1>
        </header>

        {/* The standfirst: the scope of the document, set at body colour and
            open leading so the frame around the policy is read, not skipped. */}
        <p className="mt-6 max-w-[68ch] leading-7 text-text-default">
          GeoMineX is an internal system used by authorised staff of CMPDI and Coal India
          subsidiaries. This page describes what it stores about those users and the documents they
          upload.
        </p>

        <div className="mt-10 flex max-w-[68ch] flex-col gap-10">
          <Prose title="What we store about you">
            <p>
              Your name, work email address, assigned role, and the subsidiaries you have been
              granted access to. There is no password: signing in sends a one-time code to your
              email address, so no password is ever created, transmitted or stored.
            </p>
            <p>
              For each active session we record the IP address and browser user-agent it was created
              from, together with when it was created and last used. You can view your own sessions
              and revoke any of them from your account settings at any time.
            </p>
          </Prose>

          <Prose title="What we store about your activity">
            <p>
              Consequential actions are written to an audit log: uploading a document, correcting an
              extracted figure, creating or publishing a report, asking a question, granting or
              revoking someone&rsquo;s access, and signing in. Each entry records who acted, what
              they acted on, and when.
            </p>
            <p>
              This log exists so that a published figure can be traced back to the people and
              documents behind it. It is not used to measure individual productivity.
            </p>
          </Prose>

          <Prose title="Documents you upload">
            <p>
              Uploaded documents are stored, converted to text, and split into passages so that
              figures and citations can be located within them. Extracted figures are retained
              alongside the page and passage they came from. Both the document and everything
              derived from it inherit the subsidiary it was uploaded against.
            </p>
            <p>
              Do not upload documents containing personal information about individuals unless it is
              necessary and you are authorised to do so. The system is designed for technical and
              operational reporting, not for personnel records.
            </p>
          </Prose>

          <Prose title="Who can see it">
            <p>
              Access is scoped by subsidiary. You see documents, reports, questions and audit
              entries belonging to the subsidiaries you hold access to, and nothing else. This is
              enforced by the server on every request &mdash; not by hiding controls in the
              interface &mdash; and a request for a record outside your scope is answered as though
              the record does not exist.
            </p>
            <p>
              Administrators have unscoped access, and can grant or revoke another user&rsquo;s
              access to a subsidiary. Both actions are recorded in the audit log.
            </p>
          </Prose>

          <Prose title="What we do not do">
            {/*
              The one list on the page, and it stays a real list. The markers
              take the blue so the column of them reads as structure; the text
              keeps the body ink, because a coloured marker is decoration where
              a coloured sentence would be a claim.
            */}
            <ul className="ml-5 flex list-disc flex-col gap-2 marker:text-sih-blue">
              <li>
                We do not store your sign-in credential in your browser. The token that
                authenticates your requests is held in memory for the life of the tab and is gone
                when you close it.
              </li>
              <li>
                We do not use third-party analytics, advertising, or tracking of any kind. The
                application&rsquo;s content security policy permits network connections to its own
                origin only, so a third-party script could not send data anywhere even if one were
                introduced.
              </li>
              <li>We do not sell, rent or share your data with anyone.</li>
              <li>
                We do not use your documents or questions to train models for use outside this
                system.
              </li>
            </ul>
          </Prose>

          <Prose title="Cookies">
            <p>
              One cookie is set, and only when you sign in. It holds the credential used to renew
              your session, is restricted to the sign-in endpoints, cannot be read by JavaScript,
              and is not sent to any other site. There are no analytics or preference cookies, so
              there is nothing to consent to and no banner to dismiss.
            </p>
          </Prose>

          <Prose title="Retention">
            <p>
              Documents, extracted figures, reports and audit entries are retained for as long as
              the system operates, because they are the evidence trail behind published figures
              &mdash; deleting them would break the traceability the system exists to provide.
              Sessions expire on their own and can be revoked sooner by you or by an administrator.
            </p>
            <p>
              If your account is deactivated, you lose access immediately and every one of your
              sessions is ended, but the audit record of what you did remains.
            </p>
          </Prose>

          <Prose title="Questions">
            <p>
              Contact the GeoMineX administrator in your organisation, or write to{' '}
              <a
                href="mailto:team@geominex.example"
                className="text-sih-blue underline underline-offset-2 transition-colors hover:text-sih-blue-dark"
              >
                team@geominex.example
              </a>
              .
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
      {/* The same accent bar as About — the two are one set of documents, and a
          policy that looks like a different product is a policy people
          distrust. A bar beside the heading marks the section break without
          cutting the column into cards the way a full-width rule would. */}
      <h2 className="border-l-[3px] border-sih-blue pl-3 font-serif text-xl font-semibold text-primary-dark">
        {title}
      </h2>
      <div className="flex flex-col gap-4 leading-7 text-text-default">{children}</div>
    </section>
  );
}
