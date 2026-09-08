'use client';

import { useReportVersions, type ReportVersionEntry } from '@/features/reports/api';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Card, ProseText, Section } from '@/components/ui/Layout';
import { formatDateTime, formatRelative } from '@/lib/datetime';

/**
 * Version history — PRD §5.5.
 *
 * `GET /reports/:id/versions` returns the WHOLE history as a bare array,
 * already sorted version-descending by the service. There is no pagination to
 * add, no total to fabricate, and nothing to re-sort.
 *
 * The timeline only advances on a SECTION edit: a title-only PATCH validates,
 * returns 200 and writes no row here. That surprises people who just renamed a
 * report, so the description says it on the screen rather than only in a
 * comment.
 */
export function VersionHistory({
  reportId,
  currentVersion,
}: {
  reportId: string;
  /** From the report itself — the versions endpoint does not mark its own head. */
  currentVersion: number;
}) {
  const { data: versions, isPending, error, refetch } = useReportVersions(reportId);

  return (
    <Section
      id="report-versions"
      title="Version history"
      description="Every section edit records a version; a title-only change does not. Older versions are read-only — the API has no restore endpoint, so recovering text means copying it back into the editor."
    >
      {isPending ? <LoadingBlock label="Loading version history" rows={2} /> : null}

      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {versions?.length === 0 ? (
        <EmptyState
          title="No versions recorded"
          description="Version 1 is written when a report is drafted, so an empty history means this report was created some other way."
        />
      ) : null}

      {versions && versions.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {versions.map((entry) => (
            <li key={entry.version}>
              <VersionCard entry={entry} isCurrent={entry.version === currentVersion} />
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  );
}

function VersionCard({ entry, isCurrent }: { entry: ReportVersionEntry; isCurrent: boolean }) {
  // `changeSummary` is never absent, but `null` and `''` are BOTH "no summary"
  // states — the field is safeText with a minimum of 0, so a client can store
  // the empty string. Testing only for null shows a blank line for the other.
  const summary = entry.changeSummary === null ? '' : entry.changeSummary.trim();

  return (
    /*
      The current version sits on the plain surface and the rest recede onto the
      muted one, so the head of the list is visible at a glance. The "Current"
      badge carries the same fact as text, because the tone difference alone is
      not readable to everyone.
    */
    <Card muted={!isCurrent}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-serif text-base font-semibold text-primary-dark">
          Version {entry.version}
        </h3>
        {isCurrent ? (
          <Badge tone="info" srPrefix="Version">
            Current
          </Badge>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-text-muted">
        Edited by <UserRef id={entry.editedBy} /> · {formatDateTime(entry.editedAt)} ·{' '}
        {formatRelative(entry.editedAt)}
      </p>

      {summary ? (
        <ProseText className="mt-2">{summary}</ProseText>
      ) : (
        <p className="mt-2 text-sm text-text-muted">No change summary was recorded.</p>
      )}

      {/*
        A native <details>. The disclosure needs no state, no aria wiring and no
        animation, and it keeps a long history from rendering every version's
        full prose on load.
      */}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-sih-blue">
          Show the {entry.sections.length} {entry.sections.length === 1 ? 'section' : 'sections'} in
          this version
        </summary>
        <ol className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
          {entry.sections.map((section, index) => (
            // Sections carry no `_id` anywhere in this module, and a stored
            // version is immutable, so the index is a stable key here.
            <li key={index}>
              {/* `safeText` keeps \t \n \r, so a stored heading can be long and
                  unbroken; wrap it rather than let it widen the page. */}
              <h4 className="text-sm font-semibold break-words text-text-default">
                {section.heading}
              </h4>
              {section.body ? (
                <ProseText className="mt-1">{section.body}</ProseText>
              ) : (
                <p className="mt-1 text-sm text-text-muted">This section was empty.</p>
              )}
            </li>
          ))}
        </ol>
      </details>
    </Card>
  );
}

/**
 * Who did something, from a bare user id.
 *
 * Nothing in the reports module is ever populated with a name, and `GET /users`
 * is admin-only with the role gate ahead of validation — so a CIL user has no
 * endpoint that would resolve one. The id is the honest answer: "Unknown user"
 * would read as a data fault rather than a deliberate absence, and a lookup
 * would 403 for most of the people who see this screen.
 *
 * Exported because the detail page renders the same three attributions
 * (created by, published by) from the same kind of bare id.
 */
export function UserRef({ id }: { id: string | null }) {
  const { user } = useAuth();

  if (!id) return <span className="text-text-muted">—</span>;
  if (user && user.id === id) return <span>you</span>;

  return (
    <span className="font-mono text-xs break-all" title="User id">
      {id}
    </span>
  );
}
