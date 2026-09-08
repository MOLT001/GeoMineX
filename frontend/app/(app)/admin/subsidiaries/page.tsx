'use client';

import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { type Subsidiary, useSubsidiaries } from '@/features/subsidiaries/api';
import { CreateSubsidiaryPanel } from '@/features/subsidiaries/components/CreateSubsidiaryPanel';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock, StatusMessage } from '@/components/ui/Feedback';
import { PlusIcon } from '@/components/ui/Icon';
import { PageHeader, Section } from '@/components/ui/Layout';
import { TBody, TD, TH, THead, TR, TableFrame } from '@/components/ui/Table';

/**
 * Subsidiaries — PRD §5.9.
 *
 * The whole backend module is two routes, list and create (subsidiary.routes.ts,
 * 70 lines). There is no by-id route, no PATCH and no DELETE, so this screen has
 * no row actions at all: an Edit or Remove control could not be wired to
 * anything. The page states that outright rather than leaving it to be found by
 * hunting for a button that was never built.
 *
 * `AdminLayout` has already established `role === 'admin'`, and admin is the one
 * unscoped role (utils/authorization.ts:33-35), so the list below is every
 * subsidiary that is not soft-deleted — the whole set, not a scoped view of it.
 */

/** The create panel's wrapper, which every trigger's `aria-controls` names. */
const PANEL_ID = 'new-subsidiary-panel';

export default function AdminSubsidiariesPage() {
  const { user } = useAuth();
  const canCreate = can(user, 'subsidiary:create');

  const [panelOpen, setPanelOpen] = useState(false);
  const [created, setCreated] = useState<Subsidiary | null>(null);

  const { data, isPending, isError, error, refetch } = useSubsidiaries();
  const subsidiaries = data ?? [];

  function togglePanel() {
    // The confirmation below names the row that was just created; reopening the
    // form is the start of a different one.
    setCreated(null);
    setPanelOpen((open) => !open);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Subsidiaries"
        description="The reference list behind every subsidiary picker in the app. Entries are permanent: the API cannot rename, recode or remove one, so a code is spent the moment it is created."
        actions={
          canCreate ? <NewSubsidiaryTrigger open={panelOpen} onToggle={togglePanel} /> : null
        }
      />

      {created ? (
        <StatusMessage>
          {/*
            The RESPONSE row, never the submitted values: both fields are trimmed
            server-side and `code` is uppercased twice on the way in, so what was
            typed and what now exists can differ. The revoke-access confirmation
            in the users module compares against this stored uppercase code.
          */}
          Created {created.code} — {created.name}.
        </StatusMessage>
      ) : null}

      {/* Always in the tree, so the triggers' `aria-controls` never dangles. */}
      <div id={PANEL_ID}>
        {canCreate && panelOpen ? (
          <CreateSubsidiaryPanel
            onClose={() => setPanelOpen(false)}
            onCreated={(subsidiary) => {
              setCreated(subsidiary);
              setPanelOpen(false);
              // No refetch here — the mutation already invalidated
              // ['subsidiaries'], and that invalidation is the only thing that
              // refreshes this list inside its 30-minute staleTime.
            }}
          />
        ) : null}
      </div>

      <Section
        id="subsidiary-list"
        title="All subsidiaries"
        description="Sorted by code, as the API returns them. There is no search and no filter because the endpoint reads no query parameters."
      >
        {isPending ? <LoadingBlock label="Loading subsidiaries" rows={4} /> : null}

        {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

        {!isPending && !isError ? (
          subsidiaries.length === 0 ? (
            <EmptyState
              title="No subsidiaries yet"
              // Not an idle empty list: documents, reports and queries are all
              // filed against a subsidiary, so nothing can be uploaded or
              // drafted until one exists.
              description="Every document, report and query is filed against a subsidiary. Until one exists, uploads and report drafting have nothing to attach to."
              action={
                canCreate ? (
                  <NewSubsidiaryTrigger open={panelOpen} onToggle={togglePanel} />
                ) : undefined
              }
            />
          ) : (
            <>
              {/*
                A plain count, and deliberately not a pager. The route reads no
                query params and its envelope carries no `pagination` key, so
                this array is the entire visible set and its length is a real
                total — `OffsetPagination` would be inventing pages and
                `LoadMore` would be inventing a next cursor.
              */}
              <p className="text-sm text-text-muted">
                {subsidiaries.length.toLocaleString('en-IN')}{' '}
                {subsidiaries.length === 1 ? 'subsidiary' : 'subsidiaries'}
              </p>

              <TableFrame caption="Subsidiaries">
                <THead>
                  <tr>
                    <TH className="w-40">Code</TH>
                    <TH>Name</TH>
                  </tr>
                </THead>
                <TBody>
                  {/*
                    Two columns because two columns is the whole record: the
                    handler serialises `{ id, name, code }` inline
                    (subsidiary.routes.ts:41) and this module emits no timestamps
                    at all. Rows do not link anywhere either — there is no
                    `GET /subsidiaries/:id` for a detail screen to read.
                  */}
                  {subsidiaries.map((subsidiary) => (
                    <TR key={subsidiary.id}>
                      <TD className="font-medium whitespace-nowrap text-text-default">
                        <ValueOrDash value={subsidiary.code} missing="No code recorded" />
                      </TD>
                      <TD className="break-words">
                        <ValueOrDash value={subsidiary.name} missing="No name recorded" />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </TableFrame>
            </>
          )
        ) : null}
      </Section>
    </div>
  );
}

/**
 * The control that opens the form, in both slots that offer it.
 *
 * It toggles and reports its state rather than unmounting on click. A trigger
 * that removes itself drops keyboard focus to `<body>`, so the panel it just
 * opened is never announced and a keyboard user restarts from the top of the
 * page — the same reasoning as the invite trigger on /admin/users. (Reports
 * hides its trigger for a different reason: §6 allows one Accent Orange control
 * on screen at a time. This one is Primary, so that does not apply.)
 */
function NewSubsidiaryTrigger({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="primary"
      icon={<PlusIcon size={16} />}
      aria-expanded={open}
      aria-controls={PANEL_ID}
      onClick={onToggle}
    >
      {open ? 'Close new subsidiary form' : 'New subsidiary'}
    </Button>
  );
}

/**
 * A cell whose value the API can legitimately return empty.
 *
 * Zod measures `.min()` BEFORE `.trim()` (subsidiary.routes.ts:18-19), so
 * `name: "   "` is stored as `''` and `code: "  "` — two characters, past
 * `min(2)` — as `''` too. The form above cannot produce either, because it
 * measures the trimmed string, but another client can, and the row is then
 * permanent: no route renames or removes a subsidiary. A blank cell would read
 * as a broken table rather than as the record, and the dash carries an
 * accessible label because on its own it says nothing aloud.
 */
function ValueOrDash({ value, missing }: { value: string; missing: string }) {
  if (value !== '') return <>{value}</>;

  return (
    <span className="text-text-muted">
      <span aria-hidden>—</span>
      <span className="sr-only">{missing}</span>
    </span>
  );
}
