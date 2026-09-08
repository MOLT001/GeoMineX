import { Badge, type Tone } from './Badge';

/**
 * Backend status enums, their human labels, and the predicates that depend on
 * them — in one file, because they are one thing.
 *
 * Every list here was read out of the backend source and then independently
 * re-verified against it. Where a value looks redundant or a predicate looks
 * over-specified, it is not: each of the surprises below was found in the code,
 * and getting any of them wrong produces a UI that hangs, offers a button that
 * always fails, or silently drops a row.
 */

// ─── Documents ───────────────────────────────────────────────────────────────

/** `document.model.ts` — the complete set. There is no `archived` or `deleted`. */
export type DocumentStatus = 'queued' | 'processing' | 'validated' | 'failed';

const DOCUMENT_STATUS: Record<DocumentStatus, { tone: Tone; label: string }> = {
  queued: { tone: 'pending', label: 'Queued' },
  processing: { tone: 'progress', label: 'Processing' },
  validated: { tone: 'success', label: 'Validated' },
  failed: { tone: 'danger', label: 'Failed' },
};

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const { tone, label } = DOCUMENT_STATUS[status];
  return (
    <Badge tone={tone} srPrefix="Document status">
      {label}
    </Badge>
  );
}

/**
 * Keep polling while the document is still moving.
 *
 * `queued` counts as moving, and not only after an upload: `recoverStuckDocuments()`
 * resets anything stranded in `processing` back to `queued` on boot, so a
 * document can legitimately travel BACKWARDS from processing to queued. A
 * poller that treats a backward transition as terminal stops watching a
 * document that is about to start again.
 */
export function isDocumentPending(status: DocumentStatus): boolean {
  return status === 'queued' || status === 'processing';
}

/**
 * Retry is offered ONLY for a failed document that has attempts left.
 *
 * `MAX_ATTEMPTS` is 3 and the server's guard is `attempts < 3`, so 0/1/2 may
 * retry and 3 is terminal — the endpoint answers 409 for the latter. The count
 * is incremented by the worker when it CLAIMS the job, not at enqueue, which is
 * why a freshly failed document reads 1 rather than 0.
 */
export function canRetryDocument(doc: { status: DocumentStatus; processingAttempts: number }): boolean {
  return doc.status === 'failed' && doc.processingAttempts < 3;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export type ReportStatus = 'draft' | 'published' | 'archived';

const REPORT_STATUS: Record<ReportStatus, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  published: { tone: 'success', label: 'Published' },
  archived: { tone: 'neutral', label: 'Archived' },
};

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  const { tone, label } = REPORT_STATUS[status];
  return (
    <Badge tone={tone} srPrefix="Report status">
      {label}
    </Badge>
  );
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * SEVEN values, not five.
 *
 * `retrieving` and `answering` are real states the worker passes through, and a
 * client that only knows `queued` renders an unlabelled row for most of a
 * query's life.
 */
export type QueryStatus =
  | 'queued'
  | 'retrieving'
  | 'answering'
  | 'answered'
  | 'unsupported'
  | 'failed'
  | 'dead_lettered';

const QUERY_STATUS: Record<QueryStatus, { tone: Tone; label: string }> = {
  queued: { tone: 'pending', label: 'Queued' },
  retrieving: { tone: 'progress', label: 'Retrieving sources' },
  answering: { tone: 'progress', label: 'Composing answer' },
  answered: { tone: 'success', label: 'Answered' },
  /**
   * Warning, not danger. An unsupported answer is the system working correctly:
   * the corpus did not support an answer and it said so instead of inventing
   * one. Painting it red teaches people to treat honest refusals as faults.
   */
  unsupported: { tone: 'warning', label: 'Not supported by sources' },
  failed: { tone: 'danger', label: 'Failed' },
  dead_lettered: { tone: 'danger', label: 'Needs manual review' },
};

export function QueryStatusBadge({ status }: { status: QueryStatus }) {
  const { tone, label } = QUERY_STATUS[status];
  return (
    <Badge tone={tone} srPrefix="Query status">
      {label}
    </Badge>
  );
}

/**
 * Stop polling here.
 *
 * `failed` is included, and that is the correction that matters: it is where a
 * query RESTS after a recoverable failure, so a client waiting for `answered`
 * polls a stationary row forever. It is a resting state, not a terminal one —
 * a retry can move it, which is why it is absent from `isQueryTerminal` below.
 */
const POLL_STOP: ReadonlySet<QueryStatus> = new Set([
  'answered',
  'unsupported',
  'failed',
  'dead_lettered',
]);

export function isQueryPending(status: QueryStatus): boolean {
  return !POLL_STOP.has(status);
}

/** Genuinely cannot move again without a retry. Note `failed` is NOT here. */
export function isQueryTerminal(status: QueryStatus): boolean {
  return status === 'answered' || status === 'unsupported' || status === 'dead_lettered';
}

/**
 * ONLY `failed` may be retried.
 *
 * `dead_lettered` is where the worker puts a query whose attempts are spent,
 * and no endpoint moves a row out of it. Offering a Retry button there gives
 * the user a control that always returns 409.
 */
export function canRetryQuery(status: QueryStatus): boolean {
  return status === 'failed';
}

/**
 * How well the corpus supported the answer.
 *
 * Null for every status except `answered` and `unsupported` — the failure paths
 * never reach the code that writes it, so a `failed` or `dead_lettered` query
 * carries a null here despite having stopped moving.
 */
export type AnswerStatus = 'sourced' | 'partially_sourced' | 'unsupported';

const ANSWER_STATUS: Record<AnswerStatus, { tone: Tone; label: string; help: string }> = {
  sourced: {
    tone: 'success',
    label: 'Fully sourced',
    help: 'Every claim in this answer is backed by a cited passage.',
  },
  partially_sourced: {
    tone: 'warning',
    label: 'Partially sourced',
    help: 'Some retrieved passages were discarded during validation. Check the citations before relying on this.',
  },
  unsupported: {
    tone: 'danger',
    label: 'Unsupported',
    help: 'No passage in your accessible documents supported an answer.',
  },
};

/**
 * §13 requires these three to be visually DISTINCT — presenting a partially
 * sourced answer with the same weight as a fully sourced one is the failure
 * mode this product exists to avoid.
 */
export function AnswerStatusBadge({ status }: { status: AnswerStatus }) {
  const { tone, label } = ANSWER_STATUS[status];
  return (
    <Badge tone={tone} srPrefix="Answer sourcing">
      {label}
    </Badge>
  );
}

export function answerStatusHelp(status: AnswerStatus): string {
  return ANSWER_STATUS[status].help;
}

export type QueryReviewStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

const REVIEW_STATUS: Record<QueryReviewStatus, { tone: Tone; label: string }> = {
  not_required: { tone: 'neutral', label: 'No review needed' },
  pending: { tone: 'warning', label: 'Awaiting review' },
  approved: { tone: 'success', label: 'Approved' },
  rejected: { tone: 'danger', label: 'Rejected' },
};

export function ReviewStatusBadge({ status }: { status: QueryReviewStatus }) {
  const { tone, label } = REVIEW_STATUS[status];
  return (
    <Badge tone={tone} srPrefix="Review status">
      {label}
    </Badge>
  );
}

// ─── Cross-cutting flags ─────────────────────────────────────────────────────

/**
 * §9.5 — the document contained something that looked like an attempt to steer
 * the model.
 *
 * Worth surfacing plainly: it is a property of the SOURCE, and a reader
 * weighing a figure extracted from that document should know. The rules that
 * fired are deliberately not exposed by the API, so there is nothing more to
 * show than the flag itself.
 */
export function InjectionFlag() {
  return (
    <Badge tone="warning" srPrefix="Content warning">
      Suspicious content
    </Badge>
  );
}

/** Extraction confidence fell below the review threshold. */
export function ReviewRequiredFlag() {
  return (
    <Badge tone="warning" srPrefix="Status">
      Needs review
    </Badge>
  );
}
