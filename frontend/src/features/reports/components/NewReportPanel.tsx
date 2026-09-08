'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { type Document, useDocuments } from '@/features/documents/api';
import {
  REPORT_LIMITS,
  type Report,
  useCreateReport,
  useReportTemplates,
} from '@/features/reports/api';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState, ErrorState, InlineError, LoadingBlock } from '@/components/ui/Feedback';
import {
  CharCount,
  Field,
  fieldErrorsOf,
  FormError,
  Select,
  TextInput,
} from '@/components/ui/Field';
import { CloseIcon } from '@/components/ui/Icon';
import { Card, Section } from '@/components/ui/Layout';
import { InjectionFlag, ReviewRequiredFlag } from '@/components/ui/StatusBadge';
import { LoadMore } from '@/components/ui/Table';
import { ApiError, userMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/datetime';

/**
 * Draft a new report — PRD §5.5, the §6 "Generate Report" slot.
 *
 * Rendered inline above the list rather than in a modal. The form is four
 * fields deep and one of them is a paginated, searchable multi-select; a dialog
 * would have to trap focus around a control that fetches more rows as you use
 * it, and `ConfirmDialog` is built for a confirmation, not for a form.
 *
 * THE PANEL LOOKS LIKE THIS BECAUSE DRAFTING IS SERVER-SIDE. `POST /reports`
 * renders the template's sections with their `{{placeholder}}` markers resolved
 * against the extracted fields of the source documents, so the caller must name
 * those documents up front — there is no "create empty, fill it in later" path.
 */
export function NewReportPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The page keeps the returned row: it carries the id and `hasUnreviewedFigures`. */
  onCreated: (report: Report) => void;
}) {
  const templates = useReportTemplates();
  const create = useCreateReport();

  const formRef = useRef<HTMLFormElement>(null);

  /**
   * Focus follows the disclosure.
   *
   * The trigger that opens this panel stays mounted (it is a real
   * `aria-expanded` toggle), so without this focus never leaves it and the
   * panel simply appears further down the page — a keyboard or screen-reader
   * user is given no indication anything happened. Focusing the form puts the
   * first field one Tab away, and because `Section` names its region the move
   * is announced as "New report, region".
   *
   * Mount only: re-running it would drag focus off whatever field is being
   * filled on every render.
   */
  useEffect(() => {
    formRef.current?.focus();
  }, []);

  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [subsidiaryId, setSubsidiaryId] = useState('');
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);

  // Two pieces of state, not one: the documents query is keyed on the APPLIED
  // term. Refetching per keystroke would spend the shared 100/min per-IP budget
  // on a search the user has not finished typing.
  const [documentSearch, setDocumentSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  const documents = useDocuments(
    // Sources must be `validated` AND inside `subsidiaryId` or the POST fails,
    // so both constraints go to the server rather than being filtered here: a
    // client-side filter over a cursor page hides rows without loading the ones
    // that would take their place.
    { subsidiaryId, status: 'validated', q: appliedSearch || undefined },
    { limit: 25, enabled: subsidiaryId !== '' },
  );

  const selected = useMemo(() => new Set(selectedDocumentIds), [selectedDocumentIds]);
  const atSelectionLimit = selectedDocumentIds.length >= REPORT_LIMITS.sourceDocumentsMax;

  const template = templates.data?.find((candidate) => candidate.id === templateId) ?? null;
  const noTemplates =
    !templates.isPending && !templates.isError && (templates.data?.length ?? 0) === 0;

  /**
   * `title` is `safeText`: the server NFKC-normalises it, strips invisible
   * characters, trims, and only THEN measures. A whitespace-only title passes a
   * raw `.length` check here and is rejected there, so everything client-side
   * measures the trimmed string.
   */
  const trimmedTitle = title.trim();
  const titleTooLong = trimmedTitle.length > REPORT_LIMITS.titleMax;

  const ready =
    templateId !== '' &&
    subsidiaryId !== '' &&
    trimmedTitle.length > 0 &&
    !titleTooLong &&
    selectedDocumentIds.length >= REPORT_LIMITS.sourceDocumentsMin;

  const fieldError = fieldErrorsOf(create.error);

  /**
   * Whether the failure already lit up one of the four inputs.
   *
   * A `VALIDATION_ERROR` from `validate()` carries the literal message
   * 'Validation failed' (validate.ts:42), so repeating it in a whole-form
   * banner beside the per-field messages it produced adds a line that says
   * nothing. The banner is for the failures that reach no field at all —
   * a 403, a 404, the not-validated 400, operator injection and a 413 all
   * arrive with no `fields` object.
   */
  const shownFieldError =
    fieldError('title') ??
    fieldError('templateId') ??
    fieldError('subsidiaryId') ??
    fieldError('sourceDocumentIds');

  function chooseSubsidiary(next: string) {
    setSubsidiaryId(next);
    // Every selected id belonged to the previous subsidiary, and one source
    // document outside `subsidiaryId` makes the whole POST a 404 — so the
    // selection cannot survive the change.
    setSelectedDocumentIds([]);
    setDocumentSearch('');
    setAppliedSearch('');
  }

  function applySearch() {
    // The `$text` index covers `originalFilename` and `tags` only and the
    // schema caps the term at 120 characters; extracted values are deliberately
    // not searchable (§8.2).
    setAppliedSearch(documentSearch.trim().slice(0, 120));
  }

  function toggleDocument(id: string) {
    setSelectedDocumentIds((current) => {
      if (current.includes(id)) return current.filter((candidate) => candidate !== id);
      if (current.length >= REPORT_LIMITS.sourceDocumentsMax) return current;
      return [...current, id];
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || create.isPending) return;
    create.mutate(
      { title: trimmedTitle, templateId, subsidiaryId, sourceDocumentIds: selectedDocumentIds },
      { onSuccess: onCreated },
    );
  }

  return (
    <Section
      id="new-report"
      title="New report"
      description="The server drafts the sections from a template, resolving each placeholder against the extracted fields of the documents you pick."
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          // Locked while the POST is in flight, exactly like Cancel below.
          // Unmounting the panel destroys the mutation observer, so TanStack
          // never runs the per-call `onSuccess` — a report the server really
          // did create would vanish with no confirmation and no link to it.
          disabled={create.isPending}
          icon={<CloseIcon size={14} />}
        >
          Close
        </Button>
      }
    >
      <Card>
        <form
          ref={formRef}
          // A programmatic focus target, never a tab stop — hence -1, and hence
          // `outline-none`: nothing keyboard-reachable loses its indicator.
          tabIndex={-1}
          onSubmit={submit}
          className="flex flex-col gap-5 outline-none"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Template"
              required
              error={
                fieldError('templateId') ??
                (templates.isError ? userMessage(templates.error) : undefined)
              }
              description={
                noTemplates
                  ? 'No templates are available to you. An administrator creates them.'
                  : template
                    ? // `||`, not `??`: description is `safeText` with min 0, so
                      // '' is as much a "no description" state as null is.
                      template.description ||
                      `${template.sections.length} section${template.sections.length === 1 ? '' : 's'}`
                    : undefined
              }
            >
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={templateId}
                  disabled={templates.isPending || templates.isError || noTemplates}
                  onChange={(next) => setTemplateId(next)}
                >
                  {templates.isPending ? <option value="">Loading…</option> : null}
                  {noTemplates ? <option value="">No templates available</option> : null}
                  {!templates.isPending && !noTemplates ? (
                    <option value="">Select a template…</option>
                  ) : null}
                  {(templates.data ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label="Title"
              required
              error={fieldError('title') ?? (titleTooLong ? 'Title is too long.' : undefined)}
            >
              {(fieldProps) => (
                <>
                  <TextInput
                    {...fieldProps}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Q2 production summary"
                  />
                  {/* Counts the trimmed string, because that is what the server measures. */}
                  <CharCount value={trimmedTitle} max={REPORT_LIMITS.titleMax} />
                </>
              )}
            </Field>

            <div className="sm:col-span-2">
              <SubsidiaryPicker
                value={subsidiaryId}
                onChange={chooseSubsidiary}
                required
                error={fieldError('subsidiaryId')}
              />
            </div>
          </div>

          {/*
            A checkbox group, so a `fieldset`/`legend` rather than `Field`:
            `Field` binds one label to one control id, which is the wrong
            association for a set of related checkboxes.
          */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-text-default">
              Source documents{' '}
              <span aria-hidden className="text-danger">
                *
              </span>
              <span className="sr-only">(required)</span>
            </legend>
            <p className="text-xs text-text-muted">
              Between {REPORT_LIMITS.sourceDocumentsMin} and {REPORT_LIMITS.sourceDocumentsMax}{' '}
              validated documents from the chosen subsidiary — only a validated document has
              extracted fields for the template to draw on.
            </p>

            {subsidiaryId === '' ? (
              <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
                Choose a subsidiary first — source documents are scoped to it.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <TextInput
                    type="search"
                    value={documentSearch}
                    onChange={(event) => setDocumentSearch(event.target.value)}
                    // Enter must not reach the outer form, which would submit a
                    // half-filled draft. A nested <form> would be invalid HTML,
                    // so the search applies from here and from the button.
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      applySearch();
                    }}
                    aria-label="Search documents by filename or tag"
                    placeholder="Search filenames and tags…"
                    className="min-w-0 flex-1"
                  />
                  <Button variant="secondary" size="sm" onClick={applySearch}>
                    Search
                  </Button>
                  {appliedSearch !== '' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDocumentSearch('');
                        setAppliedSearch('');
                      }}
                    >
                      Clear search
                    </Button>
                  ) : null}
                </div>

                {documents.isPending ? <LoadingBlock label="Loading documents" rows={3} /> : null}

                {/*
                  Gated on an EMPTY list, because `isError` is also what a
                  failed SECOND page reports. The pages already loaded are still
                  good, and replacing them with an error would throw away every
                  selection the user has made out of them. `refetch()` is the
                  right remedy only here: on an infinite query it re-requests
                  every page loaded so far, which against a 100/60s IP-keyed
                  limiter is the wrong answer to one failed page — that recovery
                  sits under the list instead.
                */}
                {documents.isError && documents.items.length === 0 ? (
                  <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
                ) : null}

                {!documents.isPending && !documents.isError && documents.items.length === 0 ? (
                  <EmptyState
                    title={
                      appliedSearch === ''
                        ? 'No validated documents in this subsidiary'
                        : 'No documents match that search'
                    }
                    description={
                      appliedSearch === ''
                        ? 'A document has to finish processing before its figures can be drafted into a report.'
                        : undefined
                    }
                    action={
                      appliedSearch === '' ? (
                        <ButtonLink href="/documents" variant="secondary" size="sm">
                          Go to documents
                        </ButtonLink>
                      ) : undefined
                    }
                  />
                ) : null}

                {documents.items.length > 0 ? (
                  <>
                    <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-surface-muted p-2">
                      <ul className="flex flex-col gap-2">
                        {documents.items.map((doc) => (
                          <li key={doc.id}>
                            <DocumentOption
                              doc={doc}
                              checked={selected.has(doc.id)}
                              // At the cap, unchecked rows go disabled rather than
                              // swallowing the click with no explanation.
                              disabled={!selected.has(doc.id) && atSelectionLimit}
                              onToggle={() => toggleDocument(doc.id)}
                            />
                          </li>
                        ))}
                      </ul>
                      {/*
                        `LoadMore`, not a pager: /documents is cursor-paginated and
                        its envelope carries no total, so there is no page count to
                        render and nothing to jump to.
                      */}
                      <LoadMore
                        loaded={documents.items.length}
                        hasMore={documents.hasNextPage}
                        isLoading={documents.isFetchingNextPage}
                        onLoadMore={() => void documents.fetchNextPage()}
                        noun="validated documents"
                      />
                    </div>

                    {/*
                      A failed next page keeps the pages already on screen.
                      Outside the scroll box, not in it: an error 72 rows down
                      an overflow container can sit entirely out of view, and
                      `LoadMore` above it goes on reading "N loaded" as though
                      nothing failed.
                    */}
                    {documents.isError ? (
                      <ErrorState
                        error={documents.error}
                        onRetry={() => void documents.fetchNextPage()}
                      />
                    ) : null}
                  </>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs tabular-nums text-text-muted">
                    {selectedDocumentIds.length} of {REPORT_LIMITS.sourceDocumentsMax} selected
                    {atSelectionLimit ? ' · limit reached' : ''}
                  </p>
                  {selectedDocumentIds.length > 0 ? (
                    // Reachable even when a selected row has scrolled out of the
                    // loaded pages or out of the current search.
                    <Button variant="ghost" size="sm" onClick={() => setSelectedDocumentIds([])}>
                      Clear selection
                    </Button>
                  ) : null}
                </div>

                {fieldError('sourceDocumentIds') ? (
                  <InlineError>{fieldError('sourceDocumentIds')}</InlineError>
                ) : null}
              </>
            )}
          </fieldset>

          {/*
            Suppressed once the failure has already lit up an input above. A
            `VALIDATION_ERROR` from validate() carries only the literal
            'Validation failed', so a banner repeating it beside the per-field
            messages it produced adds a line that says nothing.
          */}
          {create.isError && !shownFieldError ? (
            <FormError>{draftErrorMessage(create.error)}</FormError>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              // §6 reserves Accent Orange for Upload and Generate Report. This is
              // that second slot, which is why the list's own trigger stands down
              // while this panel is open.
              variant="cta"
              disabled={!ready}
              busy={create.isPending}
              busyLabel="Generating…"
            >
              Generate report
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </Section>
  );
}

function DocumentOption({
  doc,
  checked,
  disabled,
  onToggle,
}: {
  doc: Document;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border border-border bg-surface p-3 transition-colors ${
        disabled ? 'opacity-60' : 'cursor-pointer hover:bg-surface-muted'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        className="mt-1 size-4 shrink-0 accent-sih-blue"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-text-default">{doc.originalFilename}</span>
        {/* Same precision as the documents table's "Uploaded" column — this is
            how two same-day scans of the same filename are told apart. */}
        <span className="block text-xs text-text-muted">
          Uploaded {formatDateTime(doc.createdAt)}
        </span>
      </span>
      {/*
        Shown while choosing rather than afterwards: a low-confidence document is
        what makes the drafted report's `hasUnreviewedFigures` true (§13), and an
        injection-flagged one (§9.5) is a property of the SOURCE that a reader of
        the finished report cannot recover from the report itself.

        Both flags, review first — the same pair in the same order as the
        documents list and the document detail screen. The worker derives
        `requiresReview` as `(lowConfidence || noFields) || injectionSuspected`
        (document.worker.ts:139-140), so an injection-flagged document always
        sets it too; they remain two separate facts, and a row showing only the
        injection badge reads as "suspicious but otherwise fine" when the
        figures underneath it may equally be low-confidence.
      */}
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {doc.requiresReview ? <ReviewRequiredFlag /> : null}
        {doc.injectionSuspected ? <InjectionFlag /> : null}
      </span>
    </label>
  );
}

/**
 * Drafting fails in four documented ways and three of them are 404s
 * (`report.service.ts:187`, `:189`, `:200`): the caller lacks the subsidiary,
 * the template is gone, or a source document is missing, soft-deleted or in
 * another subsidiary. `userMessage` flattens all three to "Not found.", which
 * leaves the user with no idea which input to change — so the server's own
 * message is shown instead. None of them names a resource the caller could not
 * already see, so the 404-not-403 convention still holds.
 */
function draftErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // §9.1: the capability gate on the trigger is UX, never authorisation. The
    // server is the control and it can still say no.
    if (error.status === 403) {
      return 'Your role cannot draft reports. Ask an administrator if you need to.';
    }
    if (error.code === 'NOT_FOUND') return error.message;
  }
  // The fourth: a document that was validated when the list loaded can fail or
  // be retried before submit, and drafting then rejects the whole request with
  // 'All source documents must be validated before drafting (N are not)' —
  // which `userMessage` passes through verbatim.
  return userMessage(error);
}
