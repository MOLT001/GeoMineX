'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { type Report, type ReportStatus, useReports } from '@/features/reports/api';
import { NewReportPanel } from '@/features/reports/components/NewReportPanel';
import { SubsidiaryLabel, SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock, StatusMessage } from '@/components/ui/Feedback';
import { Field, Select } from '@/components/ui/Field';
import { PlusIcon } from '@/components/ui/Icon';
import { PageHeader, Section, Toolbar } from '@/components/ui/Layout';
import { ReportStatusBadge } from '@/components/ui/StatusBadge';
import {
  OffsetPagination,
  TableFrame,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/Table';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/datetime';

/**
 * An exhaustive `Record`, not an array of literals.
 *
 * `ReportStatusBadge` owns how a status LOOKS, but a dropdown option cannot
 * host a badge, so the plain-text labels live here. Typed as a `Record` over
 * `ReportStatus` on purpose: a status added to the backend enum then fails to
 * compile here rather than quietly going missing from the dropdown. The empty
 * "any" sentinel is rendered separately because it is not a status.
 */
const STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
};

/**
 * Reports — PRD §5.5.
 *
 * Offset-paginated, unlike documents and queries: `GET /reports` returns
 * `{ total, page, limit, totalPages }`, so this screen can show real page
 * numbers and a result count. There is no search here and no sort control
 * because the endpoint has neither — ordering is fixed at createdAt DESC
 * server-side (report.service.ts:290).
 */
export default function ReportsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canDraft = can(user, 'report:draft');

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ReportStatus | ''>('');
  const [subsidiaryId, setSubsidiaryId] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [created, setCreated] = useState<Report | null>(null);

  const { items, pagination, isPending, isError, error, refetch, isPlaceholderData } = useReports({
    page,
    status: status || undefined,
    subsidiaryId: subsidiaryId || undefined,
  });

  const filtered = status !== '' || subsidiaryId !== '';

  /**
   * An empty page that is not page one.
   *
   * Offset paging is not stable under a moving collection: an archive by
   * someone else, or this screen's own post-create invalidation, can shrink the
   * result set beneath a reader sitting on page 3. "No reports yet" would then
   * be a flat lie, and with the pager unmounted alongside the table there is no
   * control left to get back with.
   */
  const pastEnd = items.length === 0 && page > 1;

  /**
   * §13 — the traceability signal. `hasUnreviewedFigures` is computed once, at
   * CREATE, from the confidence of the extracted fields the draft cited, and is
   * never recomputed (not even on publish). It is deliberately counted over the
   * loaded page only: the API offers no filter and no aggregate for it, so a
   * corpus-wide figure would be invented.
   */
  const unreviewedOnPage = items.filter((report) => report.hasUnreviewedFigures).length;

  function changeFilter(apply: () => void) {
    apply();
    // A filter change re-queries from the first page; keeping the old page
    // number lands on an empty page whenever the result set shrank.
    setPage(1);
  }

  function clearFilters() {
    changeFilter(() => {
      setStatus('');
      setSubsidiaryId('');
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Reports"
        description="Reports drafted from a template and the figures extracted from validated documents."
        actions={
          canDraft ? (
            <Button
              /*
                Demoted, not unmounted, while the panel is open. §6 reserves
                Accent Orange for Upload and Generate Report, and two of them at
                once is what stops an accent reading as an accent — the panel's
                submit button is the same slot. But a disclosure trigger that
                deletes itself on press throws focus back to <body>, so it stays
                mounted and gives up the accent instead.
              */
              variant={panelOpen ? 'secondary' : 'cta'}
              icon={<PlusIcon size={16} />}
              // The label stays put: `aria-expanded` is what carries the state,
              // and a trigger that renames itself on press is announced as a
              // different control each time.
              aria-expanded={panelOpen}
              aria-controls="new-report-panel"
              onClick={() => {
                if (panelOpen) {
                  setPanelOpen(false);
                  return;
                }
                // The confirmation names the PREVIOUS draft; leaving it up
                // beside a fresh empty form claims a report that is not the one
                // being drafted.
                setCreated(null);
                setPanelOpen(true);
              }}
            >
              New report
            </Button>
          ) : null
        }
      />

      {created ? (
        <div className="flex flex-wrap items-center gap-3">
          <StatusMessage>Draft created: {created.title}</StatusMessage>
          {/*
            A direct link because the new draft is not necessarily in view — the
            active filter may exclude it, and on a later page it would be below
            the fold even without one.
          */}
          <Link
            href={`/reports/${created.id}`}
            className="text-sm text-sih-blue underline underline-offset-2"
          >
            Open draft
          </Link>
          {created.hasUnreviewedFigures ? (
            <Badge tone="warning" srPrefix="Traceability">
              Unreviewed figures
            </Badge>
          ) : null}
        </div>
      ) : null}

      {/*
        The wrapper is always in the tree so the trigger's `aria-controls` has
        something to resolve to — a dangling reference makes `aria-expanded`
        describe nothing. `hidden` rather than an empty div: this is a flex
        column with a gap, and an empty item still spends one.

        The panel itself is unmounted while closed, which is deliberate — a
        half-filled draft form should not survive a close and reappear later.
      */}
      <div id="new-report-panel" hidden={!panelOpen}>
        {canDraft && panelOpen ? (
          <NewReportPanel
            onClose={() => setPanelOpen(false)}
            onCreated={(report) => {
              setCreated(report);
              setPanelOpen(false);
              // The list is sorted newest-first and the hook has already
              // invalidated it, so page one is where the new row appears.
              setPage(1);
            }}
          />
        ) : null}
      </div>

      <Section
        id="report-list"
        title="Results"
        description="Newest first. The API sorts by creation date and offers no other ordering."
      >
        <Toolbar>
          <Field label="Status" className="w-full sm:w-48">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={status}
                onChange={(next) => changeFilter(() => setStatus(next as ReportStatus | ''))}
              >
                <option value="">All statuses</option>
                {(Object.entries(STATUS_LABELS) as Array<[ReportStatus, string]>).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </Select>
            )}
          </Field>

          <div className="w-full sm:w-64">
            <SubsidiaryPicker
              value={subsidiaryId}
              onChange={(next) => changeFilter(() => setSubsidiaryId(next))}
              allowAll
            />
          </div>

          {filtered ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </Toolbar>

        {/*
          Gated on the same condition as the table it describes: `keepPreviousData`
          holds the previous page in `items` across a refetch, so without this the
          line goes on counting rows while a skeleton or an ErrorState stands where
          they used to be.
        */}
        {!isPending && !isError && unreviewedOnPage > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
            <Badge tone="warning" srPrefix="Traceability">
              Unreviewed figures
            </Badge>
            on {unreviewedOnPage} of the {items.length} reports on this page. A flagged report cites
            at least one figure whose extraction confidence was at or below the review threshold
            when the draft was generated.
          </p>
        ) : null}

        {isPending ? <LoadingBlock label="Loading reports" rows={5} /> : null}

        {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

        {!isPending && !isError ? (
          items.length === 0 ? (
            <EmptyState
              title={
                pastEnd
                  ? 'Nothing on this page'
                  : filtered
                    ? 'No reports match these filters'
                    : 'No reports yet'
              }
              description={
                pastEnd
                  ? 'The list shrank while this page was open, so it now sits past the end of the results.'
                  : filtered
                    ? 'Try a different status or subsidiary.'
                    : canDraft
                      ? 'A report is drafted from a template and the validated documents you choose as sources.'
                      : 'Reports appear here once someone drafts one.'
              }
              action={
                pastEnd ? (
                  <Button variant="secondary" size="sm" onClick={() => setPage(1)}>
                    Back to the first page
                  </Button>
                ) : filtered ? (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : canDraft && !panelOpen ? (
                  /*
                    Deliberately NOT `cta`. Whenever this is on screen the
                    header's trigger is too, and it is wearing the accent — two
                    Accent Orange controls at once is exactly what §6 reserves
                    the accent against. Same action, lesser emphasis. This one
                    does stand down while the panel is open, because unlike the
                    header trigger it is not the labelled disclosure control and
                    focus has already been moved into the panel.
                  */
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<PlusIcon size={16} />}
                    onClick={() => setPanelOpen(true)}
                  >
                    New report
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {/*
                Dimmed, not unmounted, while the next page is in flight:
                `useOffsetList` keeps the previous page on screen through
                `keepPreviousData`, and swapping it for a spinner would collapse
                the page height and read as a failed request.
              */}
              <div
                aria-busy={isPlaceholderData || undefined}
                className={cn('transition-opacity', isPlaceholderData && 'opacity-60')}
              >
                <TableFrame caption="Reports">
                  <THead>
                    <tr>
                      <TH>Report</TH>
                      <TH>Subsidiary</TH>
                      <TH>Status</TH>
                      <TH>Figures</TH>
                      <TH numeric>Version</TH>
                      <TH>Created</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {items.map((report) => (
                      <TR key={report.id} onClick={() => router.push(`/reports/${report.id}`)}>
                        <TD>
                          {/*
                            Clamped, with the full string on hover: `title` is
                            `safeText` up to 250 characters and the invisible-
                            character strip deliberately KEEPS \t \n \r
                            (unicodeNormalize.ts:20), so an unclamped cell can
                            push the table wider than the frame it scrolls
                            inside, or run to two lines. `truncate`'s nowrap
                            handles both.
                          */}
                          <Link
                            href={`/reports/${report.id}`}
                            title={report.title}
                            className="block max-w-[24rem] truncate font-medium text-sih-blue underline-offset-2 hover:underline"
                          >
                            {report.title}
                          </Link>
                        </TD>
                        <TD>
                          {/*
                            A bare 24-hex id on the wire — nothing in a report
                            response is ever populated with a name. `SubsidiaryLabel`
                            resolves it and renders a dash on a miss.
                          */}
                          <SubsidiaryLabel id={report.subsidiaryId} />
                        </TD>
                        <TD>
                          <ReportStatusBadge status={report.status} />
                        </TD>
                        <TD>
                          {report.hasUnreviewedFigures ? (
                            <Badge tone="warning" srPrefix="Traceability">
                              Unreviewed figures
                            </Badge>
                          ) : (
                            <>
                              <span aria-hidden className="text-text-muted">
                                —
                              </span>
                              <span className="sr-only">No unreviewed figures</span>
                            </>
                          )}
                        </TD>
                        <TD numeric>{report.currentVersion}</TD>
                        {/*
                          Time, not just the date: the ONLY ordering this
                          endpoint offers is createdAt DESC
                          (report.service.ts:290), so this column is what
                          explains the row order — and a day's worth of drafts
                          all reading "7 Sep 2026" explains nothing. Matches
                          "Uploaded" on documents and "When" on audit.
                        */}
                        <TD className="whitespace-nowrap">{formatDateTime(report.createdAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </TableFrame>
              </div>

              <OffsetPagination
                page={page}
                // `totalPages` is 0 rather than 1 on an empty result
                // (report.service.ts:303); that case renders the empty state
                // above instead, so it never reaches this control.
                totalPages={pagination?.totalPages ?? 1}
                total={pagination?.total ?? items.length}
                onPageChange={setPage}
                busy={isPlaceholderData}
              />
            </>
          )
        ) : null}
      </Section>
    </div>
  );
}
