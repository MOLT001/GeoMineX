'use client';

import Link from 'next/link';
import { useDashboard, type PendingWork, type QuickStats } from '@/features/dashboard/api';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { PageHeader, Section } from '@/components/ui/Layout';
import { ReportStatusBadge } from '@/components/ui/StatusBadge';
import { formatRelative, formatDateTime } from '@/lib/datetime';

/** Dashboard — PRD §5.3. */
export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isPending, error, refetch } = useDashboard();

  return (
    <div className="flex flex-col gap-6">
      {/*
        `PageHeader` rather than a hand-set `<h1>`: the masthead rule beneath it
        is the page-level mark in the shared hierarchy, and a screen that draws
        its own is the one screen that drifts when the rule is retuned.
      */}
      <PageHeader
        title={user ? `Welcome back, ${user.name.split(' ')[0]}` : 'Dashboard'}
        description="Extraction accuracy, drafting time saved, and automation coverage across the documents you can access."
      />

      {isPending ? <LoadingBlock label="Loading dashboard" rows={3} /> : null}

      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {data ? (
        <>
          <Section
            id="stats"
            title="Quick stats"
            actions={<ComputedAt stats={data.quickStats} />}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Extraction accuracy"
                value={data.quickStats.extractionAccuracyPercent}
                target="≥ 90% target"
              />
              <Stat
                label="Time saved"
                value={data.quickStats.timeSavedPercent}
                target="≥ 50% target"
              />
              <Stat
                label="Automation coverage"
                value={data.quickStats.automationCoveragePercent}
                target="≥ 70% target"
              />
            </div>
          </Section>

          <Section
            id="docs"
            title="Documents"
            /*
              Repeated, not shared with Quick stats above: these counts come out
              of the SAME MetricsCache document, so they are exactly as cached
              and as stale, and §13 wants the stamp wherever a cached
              aggregation is shown — not only on whichever section happens to
              come first.
            */
            actions={<ComputedAt stats={data.quickStats} />}
          >
            {/*
              Two across on a phone rather than one. Four tallies stacked in a
              column is most of a screen of scrolling for sixteen characters of
              data, which is the opposite of what a dense portal is for.
            */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Count label="Total" value={data.documents.total} />
              <Count label="Validated" value={data.documents.validated} tone="success" />
              <Count label="Awaiting review" value={data.documents.awaitingReview} tone="warning" />
              <Count label="Failed" value={data.documents.failed} tone="danger" />
            </div>
          </Section>

          {/*
            ─── WHY THESE TWO SECTIONS ARE BANDED CARDS AND THE TWO ABOVE ARE NOT ─
            The shared hierarchy gives each level exactly one mark: a rule under
            the page, an accent bar beside a section head, a banded header on a
            card. These two sections ARE a single panel each — the section and
            the card are the same object — so the panel's band heads them and
            they do not also take the bar. The sections above head a GRID of
            separate tiles, which no band encloses, so they keep the bar.

            The rows are then divided by hairlines instead of floated apart as
            individual bordered cards: a register of filed items reads as one
            list, and fits appreciably more of it in the same height.
            ──────────────────────────────────────────────────────────────────────
          */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section
              aria-labelledby="pending-heading"
              className="flex flex-col border border-border bg-surface"
            >
              <div className="border-b border-border bg-surface-muted px-4 py-2.5">
                <h2
                  id="pending-heading"
                  className="font-serif text-lg font-semibold text-primary-dark"
                >
                  Needs your attention
                </h2>
              </div>
              {data.pendingWork.length === 0 ? (
                <Empty>Nothing is waiting on you right now.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {data.pendingWork.map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      <PendingRow item={item} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section
              aria-labelledby="reports-heading"
              className="flex flex-col border border-border bg-surface"
            >
              <div className="border-b border-border bg-surface-muted px-4 py-2.5">
                <h2
                  id="reports-heading"
                  className="font-serif text-lg font-semibold text-primary-dark"
                >
                  Recent reports
                </h2>
              </div>
              {data.recentReports.length === 0 ? (
                <Empty>No reports yet.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recentReports.map((report) => (
                    <li key={report.id}>
                      <Link
                        href={`/reports/${report.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-muted"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-text-default">
                            {report.title}
                          </span>
                          <span className="block text-xs text-text-muted tabular-nums">
                            v{report.currentVersion} · updated {formatRelative(report.updatedAt)}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          {/*
                            §13 — the traceability signal, carried on every
                            other report surface. This is the screen people
                            look at first, so dropping it here is where it
                            costs most.
                          */}
                          {report.hasUnreviewedFigures ? (
                            <Badge tone="warning" srPrefix="Traceability">
                              Unreviewed figures
                            </Badge>
                          ) : null}
                          <ReportStatusBadge status={report.status} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The KPI panel — the hero of this screen.
 *
 * White ground, a 1px frame, and a 3px rule across the top in the brand blue.
 * That rule is the whole difference between a bordered box and an OFFICIAL
 * panel: it is the same 3px `sih-blue` edge that marks the active tab in the
 * navigation band and the head of a section, so "this is a marked object" looks
 * the same everywhere in the product. No shadow — a figure that has been filed
 * does not float (§6) — and the ground is `surface` rather than the old muted
 * tint, because a headline metric is a record here, and white is what a record
 * sits on.
 *
 * The type does the ranking. The label is small, tracked, uppercase and muted,
 * set exactly like a table header, so it reads as a caption rather than as a
 * competing line of prose; the figure is large in the serif that carries every
 * heading on the page; and the target sits UNDER A HAIRLINE, because it is a
 * second fact about the figure and not a longer caption for it.
 */
function Stat({ label, value, target }: { label: string; value: number; target: string }) {
  return (
    <div className="border border-border border-t-[3px] border-t-sih-blue bg-surface p-4">
      <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</p>
      <p className="mt-2 font-serif text-4xl leading-none font-semibold text-text-strong tabular-nums">
        {Math.round(value)}%
      </p>
      <p className="mt-3 border-t border-border pt-2 text-xs text-text-muted">{target}</p>
    </div>
  );
}

function Count({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  // Colour never carries the meaning alone — the label always states it, so a
  // colour-blind user loses nothing. §6 covers contrast but not this.
  //
  // Each tone names two things now, because the tile takes the same top accent
  // rule as a Quick stats panel: the ink of the figure, and the colour of that
  // rule. Keeping them in one entry per tone is what stops the two drifting
  // apart into a red figure under an amber edge.
  //
  // `warning` reads in `warning-ink` rather than `accent-orange`. The orange is
  // reserved for Upload and Generate Report and never marks a metric, and both
  // a figure and a rule that carries meaning have to clear their contrast floor
  // — which the §6 yellow, at 1.7:1 on white, cannot.
  const { figure, rule } = {
    default: { figure: 'text-primary-dark', rule: 'border-t-primary-dark' },
    success: { figure: 'text-success', rule: 'border-t-success' },
    warning: { figure: 'text-warning-ink', rule: 'border-t-warning-ink' },
    danger: { figure: 'text-danger', rule: 'border-t-danger' },
  }[tone];

  return (
    <div className={`border border-border border-t-[3px] bg-surface p-4 ${rule}`}>
      <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</p>
      <p className={`mt-2 font-serif text-3xl leading-none font-semibold tabular-nums ${figure}`}>
        {value}
      </p>
    </div>
  );
}

function PendingRow({ item }: { item: PendingWork }) {
  const href = item.kind === 'document' ? `/documents/${item.id}` : `/queries/${item.id}`;
  const title = item.kind === 'document' ? item.originalFilename : item.questionText;

  return (
    <Link
      href={href}
      className="flex items-start justify-between gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-muted"
    >
      <span className="min-w-0">
        <span className="block truncate font-medium text-text-default">{title}</span>
        <span className="block text-xs text-text-muted">{item.reason}</span>
      </span>
      {/*
        Squared to the same 2px as `Badge` and `CountChip`, so it belongs to the
        same family of markers — a round pill would be the last soft corner left
        on the screen. It stays deliberately unfilled and un-toned: this is a
        kind marker, not a lifecycle state, and giving it a status badge's
        colour would imply a state that does not exist.
      */}
      <span className="shrink-0 rounded-sm border border-border bg-surface-muted px-2 py-0.5 text-xs text-text-muted">
        {item.kind}
      </span>
    </Link>
  );
}

/**
 * §13: the computed-at timestamp must be VISIBLE. These are cached
 * aggregations, and presenting a stale figure as live is a traceability defect
 * in a product built on traceable figures.
 *
 * Marked as a stamp with a short rule down its leading edge, so it reads as
 * provenance ATTACHED to the section rather than as a stray caption that
 * happens to share the heading's row — visible, without being promoted into a
 * figure of its own. The rule is `border-strong`: this one sits on white at
 * small size and a decorative border all but disappears under it.
 */
function ComputedAt({ stats }: { stats: QuickStats }) {
  return (
    <p className="border-l-2 border-border-strong pl-2 text-xs text-text-muted tabular-nums">
      Computed {formatRelative(stats.computedAt)}
      {stats.cached ? ' · cached' : ''}
      <span className="sr-only"> ({formatDateTime(stats.computedAt)})</span>
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    // Inset inside the panel rather than filling it edge to edge, and kept
    // dashed for the reason `EmptyState` gives: a solid rule draws a filed
    // record, a dashed one draws the space where a record would go. The margin
    // is what stops it reading as a box drawn inside a box — it sits in the
    // register as an empty slot, which is exactly what it is reporting.
    <p className="m-3 border border-dashed border-border-strong px-4 py-8 text-center text-sm text-text-muted">
      {children}
    </p>
  );
}
