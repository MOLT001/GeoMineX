'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useOverrideExtractedField, type ExtractedField } from '@/features/documents/api';
import { Button } from '@/components/ui/Button';
import { CharCount, Field, FormError, TextArea, fieldErrorsOf } from '@/components/ui/Field';
import { ProseText } from '@/components/ui/Layout';
import { ApiError, userMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/datetime';

/**
 * Correct one extracted figure — PRD §5.4.
 *
 * Not a `ConfirmDialog`: that component confirms a decision the user has
 * already made and takes at most one typed string. This is a two-field edit,
 * and both fields are load-bearing — the server rejects an override with no
 * reason outright, because a corrected figure with no recorded justification is
 * exactly the untraceable number §13 exists to prevent.
 *
 * The native `<dialog>` reasoning is ConfirmDialog's, unchanged: `showModal()`
 * supplies the focus trap, Escape, `inert` behind, the top layer and a backdrop.
 */

/** `document.schema.ts:33-37`, counted after the server's NFKC normalisation. */
const MAX_VALUE = 2000;
const MAX_REASON = 500;
const MIN_REASON = 3;

export function FieldOverrideDialog({
  field,
  documentId,
  onClose,
  onSaved,
}: {
  field: ExtractedField;
  /**
   * Not sent in the body — the endpoint hangs off its own top-level router and
   * its response omits `documentId`, so the hook needs it from here to know
   * which extracted-field list to refetch.
   */
  documentId: string;
  onClose: () => void;
  onSaved: (fieldName: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const override = useOverrideExtractedField();

  /**
   * The component is mounted only while the dialog is open, so the initial
   * state IS this field's value and there is no reset effect to get wrong —
   * reopening on a different row remounts with that row's value.
   */
  const [value, setValue] = useState(field.value);
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Open once, and DO NOT close on cleanup.
   *
   * The tidy-looking `return () => dialog.close()` made this dialog impossible
   * to open in development. The chain:
   *
   *   1. `reactStrictMode: true` wraps the App Router client tree in
   *      React.StrictMode (next/dist/client/app-index.js), which double-invokes
   *      mount effects: setup -> cleanup -> setup.
   *   2. So the sequence was showModal() -> close() -> showModal(). The dialog
   *      ends up OPEN, which is why this looked harmless.
   *   3. But `close()` also queues an asynchronous `close` EVENT, and React
   *      binds a non-delegated listener for it directly on every <dialog>
   *      (react-dom: `case "dialog": listenToNonDelegatedEvent("close", ...)`).
   *   4. That queued event lands in a LATER task — after the second showModal()
   *      has already re-opened the dialog — and calls `onClose`, which is
   *      `setEditing(null)` in the parent. The dialog unmounts a frame after it
   *      opened, so clicking "Correct" appeared to do nothing at all.
   *
   * Guarding on `!dialog.open` makes the second StrictMode run a no-op: the ref
   * is reattached before the effect re-runs, so run #2 sees an already-open
   * dialog and does nothing. That is exactly the shape `ConfirmDialog` uses,
   * which is why that dialog always worked and this one never did.
   *
   * Nothing is leaked by dropping the cleanup: removing an open modal <dialog>
   * from the DOM is specified to take it out of the top layer, and both exit
   * paths (save at `onSaved` below, and Cancel) unmount without calling close().
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const serverFieldError = fieldErrorsOf(override.error);
  const valueError = serverFieldError('value');
  const reasonError = serverFieldError('reason');

  const trimmedValue = value.trim();
  const trimmedReason = reason.trim();
  /**
   * Trimmed lengths, because the server normalises and strips before it
   * validates: a value made only of zero-width characters collapses to empty
   * and fails `min(1)` there. These checks save a round trip; the field errors
   * above are the authoritative answer (see the note in `Field.tsx`).
   */
  const canSubmit =
    trimmedValue.length > 0 &&
    trimmedValue.length <= MAX_VALUE &&
    trimmedReason.length >= MIN_REASON &&
    trimmedReason.length <= MAX_REASON;

  /** Before the first override `originalValue` is null and the current value is still the machine's. */
  const machineValue = field.originalValue ?? field.value;
  const sourcePage = field.sourceLocation?.pageNumber;

  async function save() {
    if (!canSubmit || override.isPending) return;
    setFormError(null);
    try {
      /**
       * The 200 body is deliberately narrower than `ExtractedField` — no
       * `overriddenBy`, `confidenceScore`, `requiresReview` or `sourceLocation`
       * — so nothing here reads it and nothing writes it into the cache. The
       * hook refetches the list, which is the only way to get a complete row.
       */
      await override.mutateAsync({
        fieldId: field.id,
        documentId,
        value: trimmedValue,
        reason: trimmedReason,
      });
      onSaved(field.fieldName);
      onClose();
    } catch (err) {
      /**
       * §9.1: the capability check that hid this control is UX, not
       * authorisation. A 403 landing here means the permission table drifted
       * from the server or the role changed mid-session — say which it is
       * rather than showing the generic failure.
       */
      setFormError(
        err instanceof ApiError && err.status === 403
          ? 'Your role cannot change extracted figures. Ask a CIL user or an administrator.'
          : userMessage(err),
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text-default backdrop:bg-primary-dark/50"
    >
      <div className="flex flex-col gap-4 p-6">
        <div>
          <h2
            id={titleId}
            className="font-serif text-lg font-semibold break-words text-primary-dark"
          >
            Correct “{field.fieldName}”
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            Your value replaces the extracted one wherever it is used. The machine value is kept
            beside it, and correcting a figure does not clear its review flag — that flag records
            how confident the extractor was, not whether the number is right.
          </p>
        </div>

        <div className="rounded-md bg-surface-muted p-3">
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
            Machine value
          </p>
          <ProseText>{machineValue}</ProseText>
          <p className="mt-2 text-xs text-text-muted">
            Extracted with {Math.round(field.confidenceScore * 100)}% confidence
            {sourcePage === undefined ? '' : ` from page ${sourcePage}`}.
          </p>
          {field.overriddenAt ? (
            <p className="mt-1 text-xs text-text-muted">
              Last corrected {formatDateTime(field.overriddenAt)}.
            </p>
          ) : null}
        </div>

        <Field
          label="Corrected value"
          required
          error={valueError}
          description="What the figure should read. Up to 2,000 characters."
        >
          {(fieldProps) => (
            <>
              <TextArea
                {...fieldProps}
                rows={3}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <CharCount value={trimmedValue} max={MAX_VALUE} />
            </>
          )}
        </Field>

        <Field
          label="Reason"
          required
          error={reasonError}
          description="Kept with the correction and shown to everyone who reads this figure. At least 3 characters."
        >
          {(fieldProps) => (
            <>
              <TextArea
                {...fieldProps}
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <CharCount value={trimmedReason} max={MAX_REASON} />
            </>
          )}
        </Field>

        {/*
          A VALIDATION_ERROR is already rendered against the offending input;
          repeating its generic message here would say it twice.
        */}
        {formError && !valueError && !reasonError ? <FormError>{formError}</FormError> : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={override.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            busy={override.isPending}
            busyLabel="Saving…"
            onClick={() => void save()}
          >
            Save correction
          </Button>
        </div>
      </div>
    </dialog>
  );
}
