'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  canArchiveReport,
  canEditReport,
  canPublishReport,
  hasUnresolvedPlaceholders,
  useArchiveReport,
  usePublishReport,
  useReport,
  useReportTemplates,
  type Report,
  type ReportSection,
} from '@/features/reports/api';
import { SectionEditor } from '@/features/reports/components/SectionEditor';
import { UserRef, VersionHistory } from '@/features/reports/components/VersionHistory';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { SubsidiaryLabel } from '@/components/SubsidiaryPicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorState, LoadingBlock, StatusMessage } from '@/components/ui/Feedback';
import { AlertTriangleIcon, FileTextIcon } from '@/components/ui/Icon';
import { Card, DescriptionList, PageHeader, ProseText, Section } from '@/components/ui/Layout';
import { ReportStatusBadge } from '@/components/ui/StatusBadge';
import { TBody, TD, TEmpty, TH, THead, TR, TableFrame } from '@/components/ui/Table';
import { ApiError, NOT_FOUND_MESSAGE, userMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/datetime';

/**
 * One report — PRD §5.5.
 *
 * The page is three things stacked: what the report IS (provenance), what it
 * SAYS (the editor for a draft, read-only prose otherwise), and how it got
 * there (sources and version history). Publish and Archive live in the header
 * because they are the only two irreversible things on the screen.
 */

/**
 * A 24-hex ObjectId, mirroring the server's `reportIdParamSchema`.
 *
 * A malformed id never reaches the 404 path — `validate()` rejects it first
 * with a 400 whose `fields.id` would light up an input this page does not have.
 * So the request is never made, and the user sees exactly what they would see
 * for any other unreachable report. That is also the only honest answer: a
 * report in another subsidiary, a deleted one and a nonexistent one are
 * deliberately indistinguishable, and this is the same experience.
 */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UNREACHABLE = new ApiError(404, { code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const validId = OBJECT_ID.test(id);
  const { data, isPending, error, refetch } = useReport(validId ? id : undefined);

  /**
   * A 404 arriving on a REFETCH means the row went away under an open page —
   * soft-deleted, or a subsidiary grant revoked — so the cached copy is dropped
   * rather than left on screen beside a "not found" line.
   *
   * Every OTHER refresh failure keeps the content, and says so under the
   * header. That distinction earns its keep here in a way it would not on a
   * read-only screen: every mutation on this page invalidates this key, so a
   * save is routinely followed by a refetch, and blanking the page when that
   * refetch hits a network blip would unmount an editor holding text the user
   * has typed since.
   */
  const notFound = error instanceof ApiError && error.code === 'NOT_FOUND';
  const report = notFound ? undefined : data;

  const publish = usePublishReport();
  const archive = useArchiveReport();
  const [confirming, setConfirming] = useState<'publish' | 'archive' | null>(null);

  // Lifted out of the editor so the two irreversible actions can warn about
  // unsaved text they would silently discard.
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const guard = useUnsavedEditGuard(hasUnsavedEdits);

  if (!validId) {
    return (
      <Frame>
        <PageHeader title="Report" breadcrumb={<Breadcrumb />} />
        <ErrorState error={UNREACHABLE} />
      </Frame>
    );
  }

  if (isPending) {
    return (
      <Frame>
        <PageHeader title="Report" breadcrumb={<Breadcrumb />} />
        <LoadingBlock label="Loading report" rows={4} />
      </Frame>
    );
  }

  // Reached with no readable report at all: the first load failed, or a
  // refetch answered 404 and the copy above was dropped.
  if (!report) {
    return (
      <Frame>
        <PageHeader title="Report" breadcrumb={<Breadcrumb />} />
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Frame>
    );
  }

  /**
   * §9.1: hiding a control is not authorization, it is courtesy. Each of these
   * is BOTH the row's rule and the caller's — `canPublishReport(status)` alone
   * would offer Publish to every CIL user, and every one of those clicks is a
   * 403. The mutations below still handle the 403 that arrives anyway.
   */
  const editable = canEditReport(report.status) && can(user, 'report:draft');
  const showPublish = canPublishReport(report.status) && can(user, 'report:publish');
  const showArchive = canArchiveReport(report.status) && can(user, 'report:archive');

  const readOnlyReason =
    report.status === 'published'
      ? 'Published reports are read-only. There is no unpublish endpoint — archiving is the only transition left.'
      : report.status === 'archived'
        ? 'Archived reports are read-only, and archiving cannot be undone.'
        : 'Your role can read this draft but not edit it.';

  return (
    <Frame>
      <PageHeader
        /*
          The title IS the page's identity, so it is the `<h1>` — but it is
          `safeText` up to 250 characters and the invisible-character strip
          deliberately KEEPS \t \n \r (unicodeNormalize.ts:20). An unbroken
          250-character run in a heading with no wrap rule pushes the whole page
          body sideways on a phone, and truncating it here would hide the one
          thing the reader came for.
        */
        title={<span className="break-words whitespace-pre-wrap">{report.title}</span>}
        // The one call site that HAS a report to name, so the trail ends in its
        // title rather than in the stable fallback.
        breadcrumb={<Breadcrumb title={report.title} />}
        actions={
          <>
            {showPublish ? (
              <Button onClick={() => setConfirming('publish')}>Publish</Button>
            ) : null}
            {showArchive ? (
              <Button variant="danger" onClick={() => setConfirming('archive')}>
                Archive
              </Button>
            ) : null}
          </>
        }
      />

      {/*
        A refresh that failed while the report itself is still readable. Stated
        rather than swallowed: everything below may be a version behind, and the
        reader is about to publish, archive or edit on the strength of it.
      */}
      {error ? (
        <p role="status" className="text-sm text-text-muted">
          Last refresh failed: {userMessage(error)} What you see here may be out of date.
        </p>
      ) : null}

      {publish.isSuccess ? (
        <StatusMessage>Published. This report is now read-only.</StatusMessage>
      ) : null}
      {archive.isSuccess ? (
        <StatusMessage>Archived. Nothing can restore it.</StatusMessage>
      ) : null}

      {report.hasUnreviewedFigures ? <UnreviewedFiguresNotice /> : null}

      <Section id="report-overview" title="Overview">
        <Card muted>
          <Overview report={report} />
        </Card>
      </Section>

      {editable ? (
        <SectionEditor key={report.id} report={report} onDirtyChange={setHasUnsavedEdits} />
      ) : (
        <ReadOnlySections sections={report.sections} reason={readOnlyReason} />
      )}

      <Sources report={report} />

      <VersionHistory reportId={report.id} currentVersion={report.currentVersion} />

      {/*
        Gated on the capability but NOT on the status predicate. A successful
        publish flips `status` and would otherwise tear the dialog out of the
        tree in the same commit that resolves its own confirm handler.
      */}
      {can(user, 'report:publish') ? (
        <ConfirmDialog
          open={confirming === 'publish'}
          onClose={() => setConfirming(null)}
          title="Publish this report?"
          description={
            <>
              Publishing records you as the publisher and closes the report to
              further editing. There is no unpublish endpoint — the only transition left afterwards
              is archiving.
              {hasUnsavedEdits ? (
                <strong className="mt-2 block text-text-default">
                  The editor below has unsaved changes. Publishing captures the last saved version;
                  those edits will be lost.
                </strong>
              ) : null}
            </>
          }
          confirmLabel="Publish"
          busyLabel="Publishing…"
          variant="primary"
          onConfirm={() => publish.mutateAsync(report.id)}
        />
      ) : null}

      {can(user, 'report:archive') ? (
        <ConfirmDialog
          open={confirming === 'archive'}
          onClose={() => setConfirming(null)}
          title="Archive this report?"
          description={
            <>
              Archiving is terminal: there is no unarchive, no unpublish and no delete. The report
              stays readable and stops counting towards the subsidiary&rsquo;s analytics.
              {hasUnsavedEdits ? (
                <strong className="mt-2 block text-text-default">
                  The editor below has unsaved changes, and archiving discards them.
                </strong>
              ) : null}
            </>
          }
          confirmLabel="Archive"
          busyLabel="Archiving…"
          /*
            The server compares against the report's CURRENT stored title, so a
            rename changes the string that has to be typed. `report.title` is the
            saved value, which is the one it will check — not whatever the editor
            happens to be holding.
          */
          expectedText={report.title}
          expectedTextLabel="the report title"
          onConfirm={(confirmText) => archive.mutateAsync({ id: report.id, confirm: confirmText })}
        />
      ) : null}

      <ConfirmDialog
        open={guard.pendingHref !== null}
        onClose={guard.stay}
        title="Leave with unsaved changes?"
        description="This report has edits that have not been saved. Leaving discards them — nothing is kept in the browser."
        confirmLabel="Discard and leave"
        onConfirm={guard.leave}
      />
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-8">{children}</div>;
}

/**
 * The trail, as UX4G specifies it rather than as the single back-link it was.
 *
 * Their rules are structural: it sits at the TOP of the page, EVERY crumb is
 * clickable except the one you are on, and the separator is clear. So the
 * `<nav>`/`<ol>` pair makes it a list of steps to a screen reader instead of a
 * loose link, `aria-current` marks where the trail ends, and the separator is
 * `aria-hidden` so it is not announced as a word between two names. The
 * back-pointing chevron went with it: a `‹` and a `›` in the same row leave no
 * way to tell which glyph is the separator.
 *
 * `title` defaults to the same stable label the `<h1>` uses, because three of
 * this component's four call sites render before there is a report to name —
 * invalid id, first load, and a load that failed. A trail that materialised
 * only on success would shift the heading down on every page load.
 */
function Breadcrumb({ title = 'Report' }: { title?: string }) {
  return (
    <nav aria-label="Breadcrumb">
      {/*
        16px, not 14px: UX4G sizes a navigation item at Label/XL, and Body/M is
        the floor for anything that is not helper text. The link is `min-h-11` —
        44px, WCAG 2.5.5 — which a text-sized crumb misses at its natural 24px
        line box. Its label is already wider than 44px, so height was the only
        dimension short of the rule, and there is no horizontal padding because
        it would push the crumb out of alignment with the `<h1>` beneath it.
      */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
        <li>
          <Link
            href="/reports"
            className="inline-flex min-h-11 items-center text-sih-blue underline underline-offset-2 transition-colors duration-150 hover:text-sih-blue-dark motion-reduce:transition-none"
          >
            All reports
          </Link>
        </li>
        <li className="flex min-w-0 items-center gap-x-2">
          <span aria-hidden="true" className="text-text-muted">
            &rsaquo;
          </span>
          {/*
            Capped and clipped, for the same reason the `<h1>` wraps: a title is
            `safeText` to 250 characters and keeps its newlines, and a crumb that
            runs to four lines has stopped being a trail. The heading below is
            where the whole string is read.
          */}
          <span aria-current="page" className="max-w-[40ch] truncate font-medium text-text-default">
            {title}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function Overview({ report }: { report: Report }) {
  /**
   * Drafting does NOT scope-check the template while `GET /report-templates`
   * does, and there is no by-id route to fall back on — so a report can
   * legitimately name a template this user cannot see. A miss here is not an
   * error and must not read as one: show the id.
   */
  const { data: templates } = useReportTemplates();
  const template = templates?.find((candidate) => candidate.id === report.templateId);

  const items: Array<{ label: string; value: ReactNode }> = [
    { label: 'Status', value: <ReportStatusBadge status={report.status} /> },
    { label: 'Subsidiary', value: <SubsidiaryLabel id={report.subsidiaryId} showName /> },
    {
      label: 'Template',
      value: template ? (
        template.name
      ) : (
        <span className="font-mono text-xs break-all" title="Template id">
          {report.templateId}
        </span>
      ),
    },
    { label: 'Current version', value: <span className="tabular-nums">{report.currentVersion}</span> },
    {
      label: 'Created',
      value: (
        <>
          {formatDateTime(report.createdAt)} by <UserRef id={report.createdBy} />
        </>
      ),
    },
    { label: 'Last updated', value: formatDateTime(report.updatedAt) },
  ];

  // Every nullable field arrives as an explicit null, so these are `=== null`
  // tests, not presence tests. A draft has no publication and no archival, and
  // an empty row for each would be noise rather than information.
  if (report.publishedAt !== null) {
    items.push({
      label: 'Published',
      value: (
        <>
          {formatDateTime(report.publishedAt)} by <UserRef id={report.publishedBy} />
        </>
      ),
    });
  }

  if (report.archivedAt !== null) {
    // No reports endpoint returns `archivedBy`. That attribution exists only in
    // the audit log, so this row is deliberately date-only.
    items.push({ label: 'Archived', value: formatDateTime(report.archivedAt) });
  }

  return <DescriptionList items={items} columns={3} />;
}

function ReadOnlySections({ sections, reason }: { sections: ReportSection[]; reason: string }) {
  return (
    <Section id="report-sections" title="Report content" description={reason}>
      <ol className="flex flex-col gap-4">
        {sections.map((section, index) => (
          // No `_id` exists on a section anywhere in this module, and nothing on
          // this path reorders them, so the index is the key.
          <li key={index}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-2">
                {/* Headings are `safeText` too, and the same strip keeps their
                    newlines — a flex item that will not wrap overflows the card
                    and takes the page with it. */}
                <h3 className="min-w-0 font-serif text-base font-semibold break-words text-primary-dark">
                  {section.heading}
                </h3>
                {hasUnresolvedPlaceholders(section.body) ? (
                  <Badge tone="warning" srPrefix="Content warning">
                    Unresolved placeholder
                  </Badge>
                ) : null}
              </div>
              {/*
                §9.13: report bodies are plain strings server-side and are
                rendered as text nodes. No markdown renderer, no
                dangerouslySetInnerHTML — there is no markup to preserve, and
                adding a renderer would manufacture the exact XSS surface the
                plain-string storage avoids.
              */}
              {section.body ? (
                <ProseText className="mt-2">{section.body}</ProseText>
              ) : (
                <p className="mt-2 text-sm text-text-muted">This section is empty.</p>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Sources({ report }: { report: Report }) {
  /**
   * Citations are pushed one per placeholder OCCURRENCE, so the same extracted
   * field cited in three sections yields three identical rows. They also carry
   * no back-pointer to a section — `section` is never populated — so there is
   * nothing to group them by. Dedupe on `extractedFieldId`, falling back to the
   * document and field name for the entries where it is null.
   */
  const citations = useMemo(() => {
    const seen = new Set<string>();
    return report.citations.flatMap((citation) => {
      const key = citation.extractedFieldId ?? `${citation.documentId}|${citation.fieldName ?? ''}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, citation }];
    });
  }, [report.citations]);

  return (
    <Section
      id="report-sources"
      title="Sources"
      description="The documents this report was drafted from, and the extracted fields its placeholders resolved to."
    >
      {/*
        §13 is about traceability, and the honest statement here is an awkward
        one: `updateReport` never touches citations. After any human edit these
        describe the ORIGINAL generated draft, so presenting them as verified
        for the text above would be a false claim.
      */}
      <p className="text-sm text-text-muted">
        Citations are captured when the report is drafted and are never regenerated. If the prose
        has been edited since, they describe the original draft.
      </p>

      <div>
        <h3 className="text-sm font-semibold text-text-default">
          Source documents ({report.sourceDocumentLinks.length})
        </h3>
        <ul className="mt-2 flex flex-wrap gap-2">
          {report.sourceDocumentLinks.map((documentId, index) => (
            // Duplicate ids are tolerated by the create endpoint — they are
            // compared against a Set but persisted as sent — so the id alone is
            // not a safe key.
            <li key={`${documentId}-${index}`}>
              <Link
                href={`/documents/${documentId}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-xs break-all text-sih-blue transition-colors hover:bg-surface-muted"
              >
                <FileTextIcon size={12} />
                {documentId}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <TableFrame caption="Extracted fields cited by this report">
        <THead>
          <tr>
            <TH>Field</TH>
            <TH numeric>Confidence at drafting</TH>
            <TH>Source document</TH>
          </tr>
        </THead>
        <TBody>
          {citations.length === 0 ? (
            <TEmpty colSpan={3}>
              No placeholder in this template resolved to an extracted field.
            </TEmpty>
          ) : (
            citations.map(({ key, citation }) => (
              <TR key={key}>
                <TD>{citation.fieldName ?? <span className="text-text-muted">—</span>}</TD>
                <TD numeric>
                  {/*
                    The score, not a verdict. Whether it counts as "needs
                    review" is decided against a server-side env threshold, and
                    re-deriving that number here would drift from it silently —
                    the report-level flag above is the server's own answer.
                  */}
                  {citation.confidenceScore === null ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    `${Math.round(citation.confidenceScore * 100)}%`
                  )}
                </TD>
                <TD>
                  <Link
                    href={`/documents/${citation.documentId}`}
                    className="font-mono text-xs break-all text-sih-blue underline underline-offset-2"
                  >
                    {citation.documentId}
                  </Link>
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </TableFrame>
    </Section>
  );
}

function UnreviewedFiguresNotice() {
  return (
    <Card muted className="flex items-start gap-3">
      {/* Colour never carries this alone: an icon, a heading and the body text
          all say it too. */}
      <AlertTriangleIcon size={18} className="mt-0.5 shrink-0 text-accent-orange" />
      <div>
        <p className="font-medium text-text-default">
          Some cited figures were flagged for review when this report was drafted
        </p>
        <p className="mt-1 text-sm text-text-muted">
          At least one citation scored at or below the extraction review threshold. The flag is
          computed once, at drafting, and is never recomputed — publishing does not clear it, and
          correcting a figure in the prose does not either.
        </p>
      </div>
    </Card>
  );
}

/**
 * Warn before an unsaved draft is abandoned.
 *
 * Two paths out of this page, and they need different mechanisms:
 *
 *   1. A real unload — reload, tab close, typing a URL. Only `beforeunload` can
 *      interrupt that, and only the browser's own dialog is allowed to ask.
 *
 *   2. A client-side navigation. `<Link onNavigate>` can cancel one, but only
 *      for links this component renders — and the links most likely to be
 *      clicked are in the app shell, which this screen does not own. Next has
 *      no global blocker; its documented cross-component pattern is a React
 *      context provider around the whole tree, which would mean editing the
 *      layout. So the interception happens where every link is reachable: a
 *      capture-phase listener on `document`, registered only while there is
 *      something to lose. Capture at the document runs before the click can
 *      reach React's own bubble-phase dispatch, so `stopPropagation` here is
 *      what stops `<Link>` navigating.
 *
 * Browser Back is not covered — `popstate` fires after the history entry has
 * already moved, and pushing a sentinel entry to fake a block breaks the back
 * button for everyone who has nothing unsaved.
 */
function useUnsavedEditGuard(dirty: boolean) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      // No browser has displayed a custom message since 2016, so there is none
      // to supply — but the two ways of ASKING for the prompt are not
      // interchangeable across engines: WebKit still keys off `returnValue`
      // while the standard is `preventDefault()`. Doing both is what makes the
      // prompt appear everywhere rather than only in Chrome.
      event.preventDefault();
      event.returnValue = '';
    }

    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      // A modified click opens a new tab or window and leaves this one — and
      // its state — exactly where it is.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.hasAttribute('download')) return;
      if (anchor.target && anchor.target !== '_self') return;

      const url = new URL(anchor.href, window.location.href);
      // Leaving the origin is a real unload, which `beforeunload` above already
      // owns. Intercepting it here as well would ask twice.
      if (url.origin !== window.location.origin) return;
      if (url.href === window.location.href) return;

      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    }

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  return {
    pendingHref,
    stay: () => setPendingHref(null),
    /** `router.push` is not a click, so it passes the interceptor untouched. */
    leave: () => {
      const href = pendingHref;
      setPendingHref(null);
      if (href) router.push(href);
      return Promise.resolve();
    },
  };
}
