'use client';

import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { useSubsidiaries } from '@/features/subsidiaries/api';
import {
  MAX_REQUEST_BODY_BYTES,
  SECTION_LIMITS,
  TEMPLATE_LIMITS,
  useCreateReportTemplate,
  type CreateTemplateBody,
  type ReportSection,
} from '@/features/reports/api';
import { Button } from '@/components/ui/Button';
import { CharCount, Field, FormError, TextArea, TextInput, fieldErrorsOf } from '@/components/ui/Field';
import { StatusMessage } from '@/components/ui/Feedback';
import { Card } from '@/components/ui/Layout';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { userMessage } from '@/lib/api/errors';

/**
 * Create a report template — PRD §5.5, admin only.
 *
 * A template is the skeleton a draft report is stamped from: its section bodies
 * keep their `{{placeholder}}` markers, which the drafting flow fills in.
 *
 * ─── TEMPLATES ARE WRITE-ONCE ───────────────────────────────────────────────
 * The API has exactly two template routes, GET and POST. There is no PATCH and
 * no DELETE, and `version` is hardcoded to 1 on create because nothing ever
 * updates one. So this form is the only moment a template's content is ever
 * decided, and the copy says so — offering an Edit control that cannot exist
 * would be worse than the absence of one.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** A stable client-side id, so a row keeps its identity across a removal. */
let uidSequence = 0;
function newSection(): ReportSection & { uid: string } {
  uidSequence += 1;
  return { uid: `template-section-${uidSequence}`, heading: '', body: '' };
}

export function CreateTemplatePanel({ onCreated }: { onCreated?: (name: string) => void }) {
  const { user } = useAuth();
  const create = useCreateReportTemplate();
  const { data: subsidiaries } = useSubsidiaries();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [sections, setSections] = useState([newSection()]);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  // The panel is inside the admin route group, which RequireRole already gates.
  // This is the per-control check: §9.1, the server is the authorisation.
  if (!can(user, 'template:create')) return null;

  const fieldError = fieldErrorsOf(create.error);

  const trimmedName = name.trim();
  const nameError =
    showErrors && !trimmedName
      ? 'A template needs a name.'
      : showErrors && trimmedName.length > TEMPLATE_LIMITS.nameMax
        ? `Keep the name to ${TEMPLATE_LIMITS.nameMax} characters.`
        : fieldError('name');

  const sectionsValid = sections.every((s) => s.heading.trim().length > 0);
  const countValid =
    sections.length >= SECTION_LIMITS.minCount && sections.length <= SECTION_LIMITS.maxCount;

  /**
   * The limit that actually binds is NOT `SECTION_LIMITS.bodyMax`.
   *
   * `express.json({ limit: '10kb' })` is mounted app-wide with no per-route
   * override, so a body approaching the schema's 50,000 characters can never
   * reach the server — the request dies as a 413 before validation, with no
   * field errors to show against an input. Measuring here turns an opaque
   * rejection into a number the author can act on while they type.
   */
  const payload: CreateTemplateBody = {
    name: trimmedName,
    ...(description.trim() ? { description: description.trim() } : {}),
    sections: sections.map(({ heading, body }) => ({ heading: heading.trim(), body })),
    ...(scope.length ? { subsidiaryScope: scope } : {}),
  };
  // Measured in BYTES, not characters: `express.json` counts the encoded body,
  // and a section written in Devanagari is three bytes per character, so a
  // character count would under-report by a factor of three on exactly the
  // documents this product exists to handle.
  const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  const overBodyLimit = bodyBytes > MAX_REQUEST_BODY_BYTES;

  const canSubmit = Boolean(trimmedName) && sectionsValid && countValid && !overBodyLimit;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setShowErrors(true);
    if (!canSubmit) return;

    try {
      const template = await create.mutateAsync(payload);
      // Render the RESPONSE, never what was typed — the server trims and
      // normalises both text fields.
      setCreated(template.name);
      onCreated?.(template.name);
      setName('');
      setDescription('');
      setScope([]);
      setSections([newSection()]);
      setShowErrors(false);
    } catch {
      // Surfaced below from `create.error`; mutateAsync rejects and would
      // otherwise be an unhandled rejection.
    }
  }

  return (
    <Card>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <div>
          <h3 className="font-serif text-base font-semibold text-primary-dark">New template</h3>
          <p className="mt-1 text-sm text-text-muted">
            Section bodies keep their <code className="font-mono">{'{{placeholder}}'}</code> markers;
            the drafting flow fills them in. A template cannot be edited or removed once created, so
            check it before saving.
          </p>
        </div>

        <Field label="Name" required error={nameError}>
          {(props) => (
            <>
              <TextInput
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Quarterly production summary"
              />
              <CharCount value={name} max={TEMPLATE_LIMITS.nameMax} />
            </>
          )}
        </Field>

        <Field
          label="Description"
          description="Shown beside the name when someone picks a template."
          error={fieldError('description')}
        >
          {(props) => (
            <>
              <TextArea
                {...props}
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <CharCount value={description} max={TEMPLATE_LIMITS.descriptionMax} />
            </>
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-text-default">Available to</legend>
          {/*
            An EMPTY scope means every subsidiary, not none — the inverse of the
            obvious reading, and the reason this is phrased as an opt-in
            restriction rather than a picker that starts empty.
          */}
          <p className="text-xs text-text-muted">
            Leave everything unticked to make this template available to every subsidiary.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(subsidiaries ?? []).map((subsidiary) => (
              <label
                key={subsidiary.id}
                className="flex items-center gap-2 text-sm text-text-default"
              >
                <input
                  type="checkbox"
                  checked={scope.includes(subsidiary.id)}
                  onChange={(event) =>
                    setScope((current) =>
                      event.target.checked
                        ? [...current, subsidiary.id]
                        : current.filter((id) => id !== subsidiary.id),
                    )
                  }
                />
                {subsidiary.code}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h4 className="text-sm font-medium text-text-default">
              Sections{' '}
              <span className="font-normal text-text-muted">
                ({sections.length} of {SECTION_LIMITS.maxCount})
              </span>
            </h4>
            <span
              className={
                overBodyLimit ? 'text-xs tabular-nums text-danger' : 'text-xs tabular-nums text-text-muted'
              }
            >
              {(bodyBytes / 1024).toFixed(1)} / {(MAX_REQUEST_BODY_BYTES / 1024).toFixed(0)} KB
            </span>
          </div>

          {sections.map((section, index) => (
            <div key={section.uid} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <Field
                    label={`Section ${index + 1} heading`}
                    required
                    error={
                      showErrors && !section.heading.trim() ? 'Every section needs a heading.' : undefined
                    }
                  >
                    {(props) => (
                      <TextInput
                        {...props}
                        value={section.heading}
                        maxLength={SECTION_LIMITS.headingMax}
                        onChange={(event) =>
                          setSections((current) =>
                            current.map((s, i) =>
                              i === index ? { ...s, heading: event.target.value } : s,
                            ),
                          )
                        }
                      />
                    )}
                  </Field>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-7"
                  // Below the minimum the form would be invalid anyway; removing
                  // the control is clearer than a button that always refuses.
                  disabled={sections.length <= SECTION_LIMITS.minCount}
                  onClick={() => setSections((current) => current.filter((_, i) => i !== index))}
                >
                  <CloseIcon size={14} />
                  <span className="sr-only">Remove section {index + 1}</span>
                </Button>
              </div>

              <Field label={`Section ${index + 1} body`}>
                {(props) => (
                  <TextArea
                    {...props}
                    rows={3}
                    value={section.body}
                    onChange={(event) =>
                      setSections((current) =>
                        current.map((s, i) => (i === index ? { ...s, body: event.target.value } : s)),
                      )
                    }
                    placeholder="Production for {{subsidiary}} in {{period}} was…"
                  />
                )}
              </Field>
            </div>
          ))}

          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            disabled={sections.length >= SECTION_LIMITS.maxCount}
            onClick={() => setSections((current) => [...current, newSection()])}
          >
            Add section
          </Button>
        </div>

        {overBodyLimit ? (
          <FormError>
            This template is too large to send. The server accepts{' '}
            {(MAX_REQUEST_BODY_BYTES / 1024).toFixed(0)} KB per request — shorten the section bodies.
          </FormError>
        ) : null}

        {create.isError ? <FormError>{userMessage(create.error)}</FormError> : null}
        {created ? <StatusMessage>Template “{created}” created.</StatusMessage> : null}

        <div>
          <Button
            type="submit"
            busy={create.isPending}
            busyLabel="Creating…"
            disabled={!canSubmit && showErrors}
          >
            Create template
          </Button>
        </div>
      </form>
    </Card>
  );
}
