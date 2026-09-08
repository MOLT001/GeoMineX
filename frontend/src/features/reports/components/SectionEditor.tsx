'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MAX_REQUEST_BODY_BYTES,
  REPORT_LIMITS,
  SECTION_LIMITS,
  hasUnresolvedPlaceholders,
  requestBodyBytes,
  useUpdateReport,
  type Report,
  type ReportSection,
  type UpdateReportBody,
} from '@/features/reports/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  CharCount,
  Field,
  FormError,
  TextArea,
  TextInput,
  fieldErrorsOf,
} from '@/components/ui/Field';
import { StatusMessage } from '@/components/ui/Feedback';
import { ChevronDownIcon, CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { Card, Section } from '@/components/ui/Layout';
import { ApiError, userMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';

/**
 * The report editor — PRD §5.5.
 *
 * Deliberately NOT a rich-text editor. `sections` is an array of
 * `{ heading, body }` PLAIN STRINGS server-side; there is no markup to author,
 * no markup to store and no markup to render back. So this is a structured
 * list editor — add, remove, reorder, two text controls per section — and the
 * body control is a bare `<textarea>`. Introducing a WYSIWYG here would invent
 * a format the API cannot hold and the §9.13 renderer refuses to display.
 *
 * Only a draft is editable and only `report:draft` may edit it; the caller
 * decides whether to mount this at all.
 */

/**
 * A stable client-side key per row.
 *
 * Sections carry no `_id` — every section subschema is `{ _id: false }` — so
 * the module says to key them by index. Index keys survive an append, but not a
 * reorder: React would re-use the DOM node in place and the focused Move button
 * would jump to whichever section took that slot. A uid assigned on the client
 * keeps the row identity through a move, which is what keeps keyboard focus on
 * the button the user just pressed.
 */
interface DraftSection extends ReportSection {
  uid: string;
}

let uidSequence = 0;

function withUid(section: ReportSection): DraftSection {
  uidSequence += 1;
  return { uid: `section-${uidSequence}`, heading: section.heading, body: section.body };
}

function sameSections(draft: DraftSection[], saved: ReportSection[]): boolean {
  if (draft.length !== saved.length) return false;
  return draft.every((section, index) => {
    const other = saved[index];
    return other !== undefined && other.heading === section.heading && other.body === section.body;
  });
}

export function SectionEditor({
  report,
  onDirtyChange,
}: {
  report: Report;
  /**
   * Lifted so the page can guard navigation and warn before publishing or
   * archiving over unsaved text. Must be referentially stable — pass a
   * `useState` setter or a `useCallback`.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const update = useUpdateReport();

  /**
   * The last state the SERVER confirmed, and the only baseline dirtiness is
   * measured against.
   *
   * It is seeded once and then advanced only by a successful save — never
   * re-synced from the `report` prop. The detail query is invalidated by every
   * mutation on this page (publish, archive, this save), and re-seeding on each
   * refetch would silently overwrite whatever the user had typed since.
   */
  const [saved, setSaved] = useState<{ title: string; sections: ReportSection[] }>(() => ({
    title: report.title,
    sections: report.sections,
  }));
  const [title, setTitle] = useState(report.title);
  const [sections, setSections] = useState<DraftSection[]>(() => report.sections.map(withUid));
  const [changeSummary, setChangeSummary] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const titleDirty = title !== saved.title;
  const sectionsDirty = !sameSections(sections, saved.sections);
  const dirty = titleDirty || sectionsDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
    // On unmount the editor's state goes with it, so nothing is at risk any
    // more. The intermediate false→true on a dirty change lands in the same
    // commit and batches into one render.
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  /**
   * Exactly the JSON the PATCH will carry, so the byte budget below measures
   * the real request rather than an approximation.
   *
   * Two contract rules shape it. `changeSummary` is read only inside the
   * server's `if (input.sections)` branch, so sending one without sections
   * validates, returns 200 and records nothing — it is omitted unless the
   * sections actually changed. And the arrays go out NESTED: flattening form
   * state into top-level keys like `sections.0.body` trips the operator
   * injection scanner, which 400s before validation and returns no `fields`,
   * so nothing on screen would light up.
   */
  const body = useMemo<UpdateReportBody>(() => {
    const next: UpdateReportBody = {};
    if (titleDirty) next.title = title.trim();
    if (sectionsDirty) {
      next.sections = sections.map((section) => ({
        heading: section.heading.trim(),
        body: section.body,
      }));
      const summary = changeSummary.trim();
      if (summary) next.changeSummary = summary;
    }
    return next;
  }, [title, titleDirty, sections, sectionsDirty, changeSummary]);

  /**
   * THE LIMIT THAT ACTUALLY BINDS. `express.json({ limit: '10kb' })` is mounted
   * app-wide, so a section body can never approach the schema's 50,000
   * characters. Crossing it is HTTP 413 with no `fields` object — an error that
   * highlights no input and reads like the save simply vanished. Budget the
   * whole body before sending, and show the user where they are.
   */
  const bytes = requestBodyBytes(body);
  const overBudget = bytes > MAX_REQUEST_BODY_BYTES;

  const trimmedTitle = title.trim();
  const titleClientError =
    trimmedTitle.length === 0
      ? 'A title is required.'
      : trimmedTitle.length > REPORT_LIMITS.titleMax
        ? `Titles are limited to ${REPORT_LIMITS.titleMax} characters.`
        : undefined;

  /**
   * A latency optimisation, never the control — the server re-validates, and
   * its `safeText` normalises and strips invisible characters BEFORE measuring,
   * so a heading that looks one character long here can still be rejected as
   * empty there. That failure comes back keyed per field and is rendered below.
   *
   * Kept as one message PER CONTROL rather than one per section: `heading` and
   * `body` are separate inputs with separate server keys, and a single shared
   * string puts the body's length error under the heading input — where it
   * reads as nonsense and sets `aria-invalid` on the wrong control.
   */
  const sectionClientErrors = sections.map((section) => {
    const heading = section.heading.trim();
    return {
      heading:
        heading.length < SECTION_LIMITS.headingMin
          ? 'A heading is required.'
          : heading.length > SECTION_LIMITS.headingMax
            ? `Headings are limited to ${SECTION_LIMITS.headingMax} characters.`
            : undefined,
      body:
        section.body.length > SECTION_LIMITS.bodyMax
          ? `Section bodies are limited to ${SECTION_LIMITS.bodyMax.toLocaleString('en-IN')} characters.`
          : undefined,
    };
  });

  const hasClientErrors =
    titleClientError !== undefined ||
    sectionClientErrors.some((errors) => errors.heading !== undefined || errors.body !== undefined);

  // Keyed by DOTTED PATH from the request root, so `sections.0.heading` resolves
  // against the server's `body.sections.0.heading`.
  const serverFieldError = fieldErrorsOf(update.error);
  const unresolvedCount = sections.filter((section) =>
    hasUnresolvedPlaceholders(section.body),
  ).length;

  function updateSection(index: number, patch: Partial<ReportSection>) {
    setSections((previous) =>
      previous.map((section, i) => (i === index ? { ...section, ...patch } : section)),
    );
  }

  /**
   * Every edit that changes the SHAPE of the list — add, remove, move — rather
   * than the text inside a row.
   *
   * It goes through one function because all three share a hazard: server field
   * errors are keyed by section INDEX (`body.sections.2.heading`), so the moment
   * the list changes shape the messages from the last failed save describe a
   * different row than the one they are now rendered against. Dropping them is
   * the only honest option — re-anchoring is guesswork, and leaving them puts a
   * real server error underneath innocent text.
   */
  function restructure(next: (previous: DraftSection[]) => DraftSection[]) {
    if (update.error) update.reset();
    setSections(next);
  }

  function moveSection(from: number, to: number) {
    restructure((previous) => {
      if (to < 0 || to >= previous.length) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      if (!moved) return previous;
      next.splice(to, 0, moved);
      return next;
    });
  }

  function reset() {
    setTitle(saved.title);
    setSections(saved.sections.map(withUid));
    setChangeSummary('');
    setShowErrors(false);
    // Discarding the edits discards the failed save that went with them.
    update.reset();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (!dirty || hasClientErrors || overBudget) return;

    try {
      const updated = await update.mutateAsync({ id: report.id, ...body });
      /**
       * Re-seed from the RESPONSE, not from what was typed. `safeText`
       * NFKC-normalises, strips invisible characters and trims both the title
       * and every heading, so the stored strings can differ from the input —
       * and no schema here is `.strict()`, so a 2xx is not confirmation that
       * everything sent was honoured.
       */
      setTitle(updated.title);
      setSections(updated.sections.map(withUid));
      setSaved({ title: updated.title, sections: updated.sections });
      setChangeSummary('');
      setShowErrors(false);
    } catch {
      // Rendered from `update.error` below, field errors included.
    }
  }

  return (
    <Section
      id="report-sections"
      title="Sections"
      description="Headings and bodies are stored as plain text. There is no formatting to apply, and none would survive."
    >
      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4" noValidate>
        <Card>
          <Field
            label="Report title"
            required
            error={serverFieldError('title') ?? (showErrors ? titleClientError : undefined)}
            description="Renaming the report also changes the text an administrator must type to archive it."
          >
            {(fieldProps) => (
              <TextInput
                {...fieldProps}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <CharCount value={title} max={REPORT_LIMITS.titleMax} />
        </Card>

        {unresolvedCount > 0 ? (
          <Card muted>
            <p className="flex flex-wrap items-center gap-2 font-medium text-text-default">
              <Badge tone="warning" srPrefix="Content warning">
                Unresolved placeholders
              </Badge>
              <span>
                {unresolvedCount} of {sections.length} sections still contain one
              </span>
            </p>
            {/*
              Two literal spellings reach the prose, and a reader who only knows
              the first misses half of them: `[[unresolved: Field]]` when the
              placeholder matched the drafter's regex but no extracted field,
              and a bare `{{Field}}` when the placeholder held a character the
              regex rejects — a dot, a colon, an accent.
            */}
            <p className="mt-2 text-sm text-text-muted">
              Drafting leaves them in the text on purpose, as{' '}
              <span className="font-mono text-text-default">[[unresolved: Field]]</span> or as a
              bare <span className="font-mono text-text-default">{'{{Field}}'}</span>. Replace them
              by hand before this report is published.
            </p>
          </Card>
        ) : null}

        <ol className="flex flex-col gap-4">
          {sections.map((section, index) => {
            const clientError = sectionClientErrors[index];
            return (
              <li key={section.uid}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-serif text-base font-semibold text-primary-dark">
                      Section {index + 1}
                    </h3>

                    <div className="flex items-center gap-1">
                      {hasUnresolvedPlaceholders(section.body) ? (
                        <Badge tone="warning" srPrefix="Content warning">
                          Unresolved placeholder
                        </Badge>
                      ) : null}

                      {/*
                        Icon-only controls, so the accessible name is the
                        sr-only child rather than the arrow. Disabled at the
                        ends: a control that silently does nothing is worse
                        than one that says it cannot.
                      */}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === 0}
                        onClick={() => moveSection(index, index - 1)}
                        icon={<ChevronDownIcon size={14} className="rotate-180" />}
                      >
                        <span className="sr-only">Move section {index + 1} up</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === sections.length - 1}
                        onClick={() => moveSection(index, index + 1)}
                        icon={<ChevronDownIcon size={14} />}
                      >
                        <span className="sr-only">Move section {index + 1} down</span>
                      </Button>

                      {/*
                        The server requires at least one section, so at the
                        minimum the control is not offered — it would only ever
                        return a 400.
                      */}
                      {sections.length > SECTION_LIMITS.minCount ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            restructure((previous) => previous.filter((_, i) => i !== index))
                          }
                          icon={<CloseIcon size={14} />}
                        >
                          <span className="sr-only">Remove section {index + 1}</span>
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-col gap-3">
                    <div>
                      <Field
                        label="Heading"
                        required
                        error={
                          serverFieldError(`sections.${index}.heading`) ??
                          (showErrors ? clientError?.heading : undefined)
                        }
                      >
                        {(fieldProps) => (
                          <TextInput
                            {...fieldProps}
                            value={section.heading}
                            /*
                              The server's control-character strip keeps \t \n \r,
                              so a multi-line heading is accepted by the API and
                              would break this layout. Clamp it to one line here
                              rather than discovering it after a save.
                            */
                            onChange={(event) =>
                              updateSection(index, {
                                heading: event.target.value.replace(/[\r\n]+/g, ' '),
                              })
                            }
                          />
                        )}
                      </Field>
                      <CharCount value={section.heading} max={SECTION_LIMITS.headingMax} />
                    </div>

                    <div>
                      <Field
                        label="Body"
                        description="Plain text. Blank is valid and is stored as written."
                        error={
                          serverFieldError(`sections.${index}.body`) ??
                          (showErrors ? clientError?.body : undefined)
                        }
                      >
                        {(fieldProps) => (
                          <TextArea
                            {...fieldProps}
                            rows={8}
                            value={section.body}
                            onChange={(event) => updateSection(index, { body: event.target.value })}
                          />
                        )}
                      </Field>
                      <CharCount value={section.body} max={SECTION_LIMITS.bodyMax} />
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="secondary"
            icon={<PlusIcon size={14} />}
            disabled={sections.length >= SECTION_LIMITS.maxCount}
            onClick={() => restructure((previous) => [...previous, withUid({ heading: '', body: '' })])}
          >
            Add section
          </Button>
          {/*
            Both server-side bounds, said in words at the moment they bind — a
            disabled Add button and a missing Remove button are otherwise just
            controls that appear broken.
          */}
          <p className="text-xs text-text-muted">
            <span className="tabular-nums">
              {sections.length} of {SECTION_LIMITS.maxCount}
            </span>{' '}
            sections
            {sections.length >= SECTION_LIMITS.maxCount
              ? ' — the API rejects a report with more.'
              : null}
            {sections.length === SECTION_LIMITS.minCount
              ? ' — a report must keep at least one, so this one cannot be removed.'
              : null}
          </p>
        </div>

        {/*
          Only rendered while the sections are dirty, because that is the only
          request that can carry it: the server reads `changeSummary` inside the
          `if (input.sections)` branch and drops it otherwise. Offering the field
          on a title-only save would invite people to write a note that is
          discarded with a 200.
        */}
        {sectionsDirty ? (
          <Card muted>
            <Field
              label="Change summary"
              description="Recorded against the new version in the history below. Optional."
              error={serverFieldError('changeSummary')}
            >
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  value={changeSummary}
                  onChange={(event) => setChangeSummary(event.target.value)}
                  placeholder="What changed, and why"
                />
              )}
            </Field>
            <CharCount value={changeSummary} max={REPORT_LIMITS.changeSummaryMax} />
          </Card>
        ) : null}

        <p
          className={cn('text-xs tabular-nums', overBudget ? 'text-danger' : 'text-text-muted')}
          role={overBudget ? 'alert' : undefined}
        >
          Save size {bytes.toLocaleString('en-IN')} of{' '}
          {MAX_REQUEST_BODY_BYTES.toLocaleString('en-IN')} bytes
          {overBudget
            ? ' — too large to send. The server caps a request body at 10 KB of JSON, which binds long before a single section reaches its 50,000-character limit. Shorten the text.'
            : null}
        </p>

        {update.error ? <FormError>{saveErrorMessage(update.error)}</FormError> : null}

        {update.isSuccess && update.data && !dirty ? (
          <StatusMessage>
            {update.variables?.sections
              ? `Saved as version ${update.data.currentVersion}.`
              : 'Title saved. A title-only change does not create a new version.'}
          </StatusMessage>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            busy={update.isPending}
            busyLabel="Saving…"
            disabled={!dirty || overBudget}
          >
            Save changes
          </Button>
          {dirty ? (
            <Button variant="secondary" onClick={reset} disabled={update.isPending}>
              Discard changes
            </Button>
          ) : null}
          {dirty ? (
            <span className="text-xs text-text-muted">Unsaved changes</span>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

/**
 * Three failures need saying in words the API does not supply.
 *
 * The 413 carries no `fields`, so nothing would otherwise explain it. The 403
 * means this table drifted from the server's `roleGuard` — §9.1, the hidden
 * button was never the control. And `INVALID_REQUEST` here is almost always
 * "someone published or archived this report while you were typing", which the
 * server states but does not tell you what to do about.
 */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'PAYLOAD_TOO_LARGE') {
      return 'This save is larger than the 10 KB the server accepts. Shorten the section text and try again.';
    }
    if (error.code === 'FORBIDDEN') {
      return 'Your account is not allowed to edit reports. Nothing was saved.';
    }
    if (error.code === 'INVALID_REQUEST') {
      return `${error.message} Reload the page to see its current state — your text is still in the form.`;
    }
  }
  return userMessage(error);
}
