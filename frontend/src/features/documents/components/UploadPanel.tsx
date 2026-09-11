'use client';

import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { ErrorState, InlineError } from '@/components/ui/Feedback';
import { FormError, fieldErrorsOf } from '@/components/ui/Field';
import { CloseIcon, FileTextIcon, UploadIcon } from '@/components/ui/Icon';
import { Card } from '@/components/ui/Layout';
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  useUploadDocument,
  type UploadProgress,
} from '@/features/documents/api';
import { useSubsidiaries } from '@/features/subsidiaries/api';
import { ApiError, userMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';

/**
 * Upload a document — PRD §5.4.
 *
 * One file at a time, deliberately: the 201 is an acknowledgement rather than a
 * result, and the only way to learn what the worker made of the file is to poll
 * `GET /documents/:id`. So a successful upload hands the user straight to the
 * detail screen and lets its poller take over — which is a single destination,
 * and a batch would have no single destination to offer.
 *
 * Everything checked here is checked again on the server. The size cap and the
 * extension allowlist below exist to save a 25 MiB round trip, not to decide
 * anything: the server additionally sniffs the magic bytes, so a `.pdf` that is
 * really a JPEG passes every test in this file and is still rejected with a 400.
 */
export function UploadPanel() {
  const router = useRouter();
  const subsidiaries = useSubsidiaries();
  const upload = useUploadDocument();

  const [file, setFile] = useState<File | null>(null);
  const [subsidiaryId, setSubsidiaryId] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  /** Non-blocking asides — a multi-file drop, a cancelled transfer. */
  const [notice, setNotice] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const options = subsidiaries.data ?? [];
  const noGrants = !subsidiaries.isPending && !subsidiaries.isError && options.length === 0;
  const percent = progress?.percent ?? 0;

  function selectFiles(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    const candidate = files[0];
    if (!candidate) return;

    upload.reset();
    setProgress(null);
    // `attempted` deliberately survives choosing a file: if the last submit
    // stalled on a missing subsidiary, that is still true and the message
    // beside the picker should stay put.
    setNotice(
      files.length > 1 ? 'One file is uploaded at a time — the first one is selected.' : null,
    );
    setFileError(checkFile(candidate));
    setFile(candidate);
  }

  function clearFile() {
    upload.reset();
    setFile(null);
    setFileError(null);
    setNotice(null);
    setProgress(null);
    setAttempted(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    setNotice(null);
    if (!file || fileError !== null || subsidiaryId === '') return;

    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ loaded: 0, total: file.size, percent: 0 });

    upload.mutate(
      { file, subsidiaryId, onProgress: setProgress, signal: controller.signal },
      {
        // The 201 carries status 'queued' with `ocrConfidence` and `processedAt`
        // null — nothing has been read yet. The detail screen polls for the
        // outcome, so send the user there rather than reporting a result this
        // response does not contain.
        onSuccess: (created) => {
          router.push(`/documents/${created.id}`);
        },
        onError: (error) => {
          setProgress(null);
          if (error instanceof DOMException && error.name === 'AbortError') {
            // The user's own cancellation is not a failure. Clearing the
            // mutation stops the panel rendering it as a server error.
            upload.reset();
            setNotice('Upload cancelled. The file is still selected if you want to try again.');
          }
        },
        onSettled: () => {
          abortRef.current = null;
        },
      },
    );
  }

  /**
   * A failed subsidiary list is not survivable here — every upload must name
   * one — so the form is replaced rather than rendered against an empty picker.
   */
  if (subsidiaries.isError) {
    return <ErrorState error={subsidiaries.error} onRetry={() => void subsidiaries.refetch()} />;
  }

  /**
   * Zero grants is HTTP 200 with an empty array, never an error, so a screen
   * that waits for a failure waits forever. Say so instead of offering a form
   * whose required field has nothing in it.
   */
  if (noGrants) {
    return (
      <Card muted>
        <p className="font-medium text-text-default">Nothing to upload against yet</p>
        <p className="mt-1 text-sm text-text-muted">
          Every document is filed against a subsidiary, and you have not been granted access to
          any. Ask an administrator to grant one.
        </p>
      </Card>
    );
  }

  const serverFieldError = fieldErrorsOf(upload.error);
  const subsidiaryError =
    attempted && subsidiaryId === '' ? 'Choose a subsidiary.' : serverFieldError('subsidiaryId');
  const shownFileError = fileError ?? (attempted && !file ? 'Choose a file to upload.' : null);

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div
          onDragOver={(event: DragEvent<HTMLDivElement>) => {
            // Without preventDefault the browser refuses the drop entirely.
            event.preventDefault();
            if (!upload.isPending) setDragging(true);
          }}
          onDragLeave={(event: DragEvent<HTMLDivElement>) => {
            // dragleave also fires when the pointer crosses onto a CHILD of the
            // zone, which would flicker the highlight off over the label.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            if (upload.isPending) return;
            selectFiles(event.dataTransfer.files);
          }}
          className={cn(
            'flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
            dragging ? 'border-sih-blue bg-sih-blue/5' : 'border-border bg-surface-muted',
          )}
        >
          <UploadIcon size={20} className="text-text-muted" />
          <p className="text-sm text-text-default">
            Drag a file here, or{' '}
            {/*
              The real control is the file input, kept `sr-only` so it is still
              focusable, with this label as its visible surface: one tab stop,
              and Enter or Space opens the picker. Drag-and-drop is a
              pointer-only affordance and can never be the only way in.
            */}
            <label className="cursor-pointer rounded-sm px-0.5 font-semibold text-sih-blue underline underline-offset-2 focus-within:ring-2 focus-within:ring-sih-blue">
              choose one
              <input
                type="file"
                className="sr-only"
                accept={ACCEPTED_UPLOAD_EXTENSIONS.join(',')}
                disabled={upload.isPending}
                onChange={(event) => {
                  selectFiles(event.target.files);
                  // Clearing the value lets the same file be re-chosen after a
                  // failed attempt; otherwise no change event fires.
                  event.target.value = '';
                }}
              />
            </label>
          </p>
          <p className="text-xs text-text-muted">
            PDF, scan, image, .xlsx, .csv, .txt or a .zip of them · up to {formatBytes(MAX_UPLOAD_BYTES)}
          </p>
        </div>

        {file ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-surface p-3">
            <FileTextIcon size={16} className="shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-default">
              {file.name}
            </span>
            <span className="text-xs tabular-nums text-text-muted">{formatBytes(file.size)}</span>
            <Button
              variant="ghost"
              size="sm"
              icon={<CloseIcon size={14} />}
              onClick={clearFile}
              disabled={upload.isPending}
            >
              Remove
            </Button>
          </div>
        ) : null}

        {shownFileError ? <InlineError>{shownFileError}</InlineError> : null}
        {notice ? <p className="text-sm text-text-muted">{notice}</p> : null}

        {upload.isPending ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              {/*
                `onProgress` counts BYTES SENT, not work done: at 100% the body
                has left the browser and the server has still to sniff the magic
                bytes and write to storage. "Done" here would be a lie about the
                slowest part of the request. A progress event that is not
                length-computable reports 0, so the bar simply stays at zero
                rather than jumping about.
              */}
              <span aria-live="polite" className="text-text-default">
                {percent >= 100 ? 'Checking the file on the server…' : 'Uploading…'}
              </span>
              <span className="tabular-nums text-text-muted">{percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
            >
              <div className="h-full rounded-full bg-sih-blue" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}

        <SubsidiaryPicker
          value={subsidiaryId}
          onChange={setSubsidiaryId}
          required
          disabled={upload.isPending}
          error={subsidiaryError}
        />

        {upload.error ? <FormError>{uploadErrorMessage(upload.error)}</FormError> : null}

        <div className="flex flex-wrap items-center gap-2">
          {/* §6 reserves Accent Orange for two actions, and this is one of them. */}
          <Button
            type="submit"
            variant="cta"
            icon={<UploadIcon size={16} />}
            busy={upload.isPending}
            busyLabel={percent >= 100 ? 'Checking…' : 'Uploading…'}
          >
            Upload
          </Button>
          {upload.isPending ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

/**
 * Pre-flight checks, for latency and nothing else.
 *
 * The server repeats every one of them and adds a magic-byte sniff, so a pass
 * here is never permission to skip handling the 400 (§10.5's rule that the
 * client's copy of a constraint drifts silently from the server's).
 */
function checkFile(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase();

  if (!(ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
    return `That file type is not accepted. Choose one of ${ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}.`;
  }
  if (file.size === 0) return 'That file is empty, so there would be nothing to extract.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is ${formatBytes(file.size)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`;
  }
  return null;
}

/**
 * Upload failures, phrased as the remedy the user actually has.
 *
 * The two 404s this route can return are distinguishable only by MESSAGE and
 * have different remedies: 'Subsidiary not found' means the subsidiary is gone
 * or soft-deleted, while 'Resource not found' means it is outside the caller's
 * grants — which, since the picker only ever offers their own, means a grant
 * changed under them. Neither wording names anything the user did not already
 * choose from their own list, so nothing here rebuilds the existence oracle the
 * 404-not-403 convention hides; collapsing both into "Not found." would just
 * leave the remedy unsaid.
 *
 * The 403 is the role guard, which runs before multer reads a byte. §9.1 —
 * hiding the panel is a courtesy, so this has to be handled even though the
 * page only renders it for `document:upload` holders.
 */
function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Your role cannot upload documents. Ask an administrator if you need to.';
    }
    if (error.status === 404) {
      return error.message === 'Subsidiary not found'
        ? 'That subsidiary no longer exists. Choose another one and try again.'
        : 'That subsidiary is no longer available to you. Choose another one and try again.';
    }
  }
  return userMessage(error);
}
