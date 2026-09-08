'use client';

import { useState } from 'react';
import {
  SUBSIDIARY_LIMITS,
  type Subsidiary,
  useCreateSubsidiary,
} from '@/features/subsidiaries/api';
import { Button } from '@/components/ui/Button';
import { CharCount, Field, FormError, TextInput, fieldErrorsOf } from '@/components/ui/Field';
import { CloseIcon } from '@/components/ui/Icon';
import { Card, Section } from '@/components/ui/Layout';
import { ApiError, userMessage } from '@/lib/api/errors';

/**
 * Create a subsidiary — PRD §5.9.
 *
 * Inline above the list rather than in a dialog: the row this adds is the thing
 * the list is already showing, and `ConfirmDialog` is built for a confirmation,
 * not for a form.
 *
 * ─── EVERY LENGTH CHECK HERE MEASURES THE TRIMMED STRING ────────────────────
 * Zod runs `.min()`/`.max()` BEFORE `.trim()` (subsidiary.routes.ts:18-19), so
 * the API accepts `name: "   "` and stores `""`, and accepts `code: " a "` and
 * stores `"A"` — one character, below its own advertised minimum. Measuring the
 * raw value here would agree with the server in exactly the direction that lets
 * that junk into the reference list every picker in the app reads.
 *
 * Submitting the trimmed strings closes the other end of the same gap: at the
 * maximum the server measures the UNTRIMMED value, so a 200-character name with
 * a trailing space is 201 to it and 200 to us. Sending what was measured means
 * the two cannot disagree in either direction.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The caller gates the trigger on `can(user, 'subsidiary:create')`. That is UX
 * only (§9.1) — the 403 is still handled below.
 */
export function CreateSubsidiaryPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The created row as the SERVER returns it — see `submit`. */
  onCreated: (subsidiary: Subsidiary) => void;
}) {
  const create = useCreateSubsidiary();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const trimmedName = name.trim();
  const trimmedCode = code.trim();

  // Held back until the field has something in it: a "too short" message on an
  // untouched control announces the form as broken before it is filled in.
  const nameBlank = name !== '' && trimmedName.length < SUBSIDIARY_LIMITS.name.min;
  const nameTooLong = trimmedName.length > SUBSIDIARY_LIMITS.name.max;
  const codeTooShort = code !== '' && trimmedCode.length < SUBSIDIARY_LIMITS.code.min;
  const codeTooLong = trimmedCode.length > SUBSIDIARY_LIMITS.code.max;

  const ready =
    trimmedName.length >= SUBSIDIARY_LIMITS.name.min &&
    !nameTooLong &&
    trimmedCode.length >= SUBSIDIARY_LIMITS.code.min &&
    !codeTooLong;

  const fieldError = fieldErrorsOf(create.error);
  const nameServerError = fieldError('name');
  const codeServerError = fieldError('code');

  /**
   * The duplicate-code answer, matched on the CODE and never on the message.
   * A 409 arrives with two different strings — "A subsidiary with that code
   * already exists" from the handler's pre-check, and "Resource already exists"
   * from the Mongo unique index when the code belongs to a soft-deleted row
   * that slipped past that pre-check (errorHandler.ts:49-56).
   */
  const conflict = create.error instanceof ApiError && create.error.code === 'CONFLICT';

  /**
   * Every error this form can raise is about the PAIR that was submitted, so
   * the moment either input changes the error describes a body that no longer
   * exists. TanStack holds a mutation error until the next `mutate`, and the
   * 409 above is the one failure this form actually meets in use — without
   * this, correcting the code leaves "already in use" sitting in red under a
   * value nobody has tried yet.
   */
  function clearStaleError() {
    if (create.isError) create.reset();
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || create.isPending) return;
    // `onCreated` receives the mutation's RESPONSE, not this body: `code` is
    // uppercased twice on the way in (zod `.toUpperCase()`, then mongoose
    // `uppercase: true`, subsidiary.model.ts:18), so the stored row is not
    // necessarily what was typed.
    create.mutate({ name: trimmedName, code: trimmedCode }, { onSuccess: onCreated });
  }

  return (
    <Section
      id="new-subsidiary"
      title="New subsidiary"
      description="Both values are permanent. The API has no route that renames a subsidiary or removes one, so a typo can only be worked around by creating a second entry beside it."
      actions={
        <Button variant="ghost" size="sm" onClick={onClose} icon={<CloseIcon size={14} />}>
          Close
        </Button>
      }
    >
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Name"
              required
              className="sm:col-span-2"
              description="As it should read in pickers and on reports, e.g. Bharat Coking Coal Limited."
              error={
                nameServerError ??
                (nameBlank
                  ? 'Spaces alone are not a name — this would be stored empty.'
                  : nameTooLong
                    ? 'Name is too long.'
                    : undefined)
              }
            >
              {(fieldProps) => (
                <>
                  <TextInput
                    {...fieldProps}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      clearStaleError();
                    }}
                    placeholder="Bharat Coking Coal Limited"
                  />
                  {/* Counts the trimmed string, because that is what gets sent. */}
                  <CharCount value={trimmedName} max={SUBSIDIARY_LIMITS.name.max} />
                </>
              )}
            </Field>

            <Field
              label="Code"
              required
              description={`${SUBSIDIARY_LIMITS.code.min}–${SUBSIDIARY_LIMITS.code.max} characters. Stored in upper case whatever you type.`}
              error={
                codeServerError ??
                (conflict
                  ? // Explains why a code can be taken while nothing in the list
                    // below shows it: the unique index is global and covers
                    // soft-deleted rows (subsidiary.model.ts:25), which every
                    // read filters out.
                    'That code is already in use. Codes stay reserved even for entries that no longer appear in this list.'
                  : codeTooShort
                    ? `Code must be at least ${SUBSIDIARY_LIMITS.code.min} characters; surrounding spaces do not count.`
                    : codeTooLong
                      ? 'Code is too long.'
                      : undefined)
              }
            >
              {(fieldProps) => (
                <TextInput
                  {...fieldProps}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                    clearStaleError();
                  }}
                  placeholder="BCCL"
                  // Display only. The value in state stays as typed and the
                  // server does the actual uppercasing — a CSS transform that
                  // looked authoritative would be a promise this form cannot
                  // keep, which is why the created row is rendered from the
                  // response rather than from here.
                  className="uppercase"
                />
              )}
            </Field>
          </div>

          {/*
            Only for the failures that never reach a field. `VALIDATION_ERROR`
            does not imply `fields` exists — malformed JSON and a body over 10kb
            both arrive without one (errorHandler.ts:62-77) — and a 403 skips
            validation entirely.
          */}
          {create.isError && !conflict && !nameServerError && !codeServerError ? (
            <FormError>{createErrorMessage(create.error)}</FormError>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {/*
              Primary, not `cta`: §6 reserves Accent Orange for Upload and
              Generate Report, and an accent that turns up on every screen stops
              reading as an accent.
            */}
            <Button
              type="submit"
              variant="primary"
              disabled={!ready}
              busy={create.isPending}
              busyLabel="Creating…"
            >
              Create subsidiary
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

/**
 * `roleGuard('admin')` is mounted AHEAD of `validate()` on this route
 * (subsidiary.routes.ts:48), so a 403 says nothing about the body — it does not
 * mean "the fields were fine, but". The trigger is already gated on the
 * capability (§9.1: that is UX, not authorisation), so reaching this means the
 * account was demoted mid-session or the capability table has drifted.
 */
function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'Your role cannot create subsidiaries. Sign in again, or ask another administrator.';
  }
  return userMessage(error);
}
