'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { useAuth } from '@/auth/AuthProvider';
import { isUnscoped } from '@/auth/permissions';
import { Button } from '@/components/ui/Button';
import { InlineError, Skeleton } from '@/components/ui/Feedback';
import { AlertTriangleIcon, RefreshIcon } from '@/components/ui/Icon';
import { Card } from '@/components/ui/Layout';
import {
  AnswerStatusBadge,
  QueryStatusBadge,
  answerStatusHelp,
  canRetryQuery,
  isQueryPending,
  type AnswerStatus,
  type QueryStatus,
} from '@/components/ui/StatusBadge';
import {
  isScopeRevokedFailure,
  parseAnswerSegments,
  useRetryQuery,
  type AnswerSegment,
  type QueryCitation,
  type QueryDetail,
} from '@/features/queries/api';
import { userMessage } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/datetime';
import { citationHref, citationSourceLabel } from './CitationList';

/**
 * The answer, in whichever of its three shapes this query is currently in —
 * PRD §5.7, §13.
 *
 * The branch that matters most is the one that is easy to miss: a query can
 * STOP MOVING WITHOUT HAVING AN ANSWER. `responseText`, `answerStatus`,
 * `provider`, `promptVersion`, `generationMs` and `answeredAt` are all written
 * by the worker's `finish()`, which runs only for `answered` and `unsupported`
 * (query.worker.ts:404-446) — so `failed` and `dead_lettered` carry nulls
 * everywhere despite being at rest. Rendering an "answer" area for those two
 * shows an empty panel where a person expects prose.
 */
export function AnswerView({ query }: { query: QueryDetail }) {
  if (isQueryPending(query.status)) return <PendingAnswer query={query} />;
  if (query.status === 'failed' || query.status === 'dead_lettered') {
    return <FailedAnswer query={query} />;
  }
  return <FinishedAnswer query={query} />;
}

// ─── Still working ───────────────────────────────────────────────────────────

const PHASES: ReadonlyArray<{ status: QueryStatus; label: string; help: string }> = [
  { status: 'queued', label: 'Queued', help: 'Waiting for a worker to pick the question up.' },
  {
    status: 'retrieving',
    label: 'Retrieving sources',
    help: 'Searching the documents you are authorised to read.',
  },
  {
    status: 'answering',
    label: 'Composing answer',
    help: 'Drafting an answer from the retrieved passages.',
  },
];

/**
 * Queued, retrieving or answering.
 *
 * The phase strip is recomputed from the CURRENT status on every render and
 * remembers nothing, which is what makes it honest: `recoverStuckQueries()`
 * resets any row stranded in `retrieving`/`answering` back to `queued` on boot
 * with no age guard (query.worker.ts:482-537), so a query moves BACKWARDS with
 * no user action. Nothing here is marked "done", because a completed step can
 * be un-completed.
 */
function PendingAnswer({ query }: { query: QueryDetail }) {
  const current = PHASES.findIndex((phase) => phase.status === query.status);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <QueryStatusBadge status={query.status} />
        <span className="text-sm text-text-muted">
          Asked {formatRelative(query.createdAt)}
          <span className="sr-only"> ({formatDateTime(query.createdAt)})</span>
        </span>
      </div>

      <ol className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
        {PHASES.map((phase, index) => {
          const active = index === current;
          return (
            <li
              key={phase.status}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-baseline gap-2 text-sm',
                active ? 'font-semibold text-primary-dark' : 'text-text-muted',
              )}
            >
              {/* The number carries the ordering for a screen reader; the weight
                  and colour only reinforce it for a sighted reader. */}
              <span className="tabular-nums">{index + 1}.</span>
              {phase.label}
            </li>
          );
        })}
      </ol>

      {/*
        One polite live region for the whole phase change. The skeletons below
        are `aria-hidden`, so this sentence is the only thing announced when the
        worker moves the query on — or moves it back.
      */}
      <p role="status" aria-live="polite" className="text-sm text-text-muted">
        {PHASES[current]?.help ?? 'Working on this question.'} This page updates itself; there is no
        need to reload it.
      </p>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-9/12" />
      </div>
    </Card>
  );
}

// ─── Stopped without an answer ───────────────────────────────────────────────

/**
 * `failed` and `dead_lettered` — both at rest, neither with any text.
 *
 * The two are not the same thing and must not be offered the same control:
 * `failed` is a RESTING state a retry can move, `dead_lettered` is terminal and
 * the retry endpoint answers 400 for it. And within `failed`, the scope-revoked
 * case is a third thing again — a retry re-runs the identical authorization
 * check and fails identically, so no button is offered for it either.
 */
function FailedAnswer({ query }: { query: QueryDetail }) {
  const { user } = useAuth();
  const retry = useRetryQuery();

  const scopeRevoked = isScopeRevokedFailure(query.failureReason);
  /** Author-or-admin, checked in the service (query.service.ts:456-458) — the
   *  route itself lets all three roles through, so this is not covered by any
   *  entry in `CAPABILITIES`. UX only: the 403 is still handled below. */
  const mayRetry = isUnscoped(user) || (!!user && user.id === query.askedBy);
  const showRetry = canRetryQuery(query.status) && !scopeRevoked && mayRetry;

  return (
    <Card className="flex flex-col gap-3 border-l-4 border-l-danger">
      <QueryStatusBadge status={query.status} />

      {/* `failureReason` is one of four fixed, non-sensitive sentences written
          by the worker. Rendered as-is: there is no code to branch on, and
          rewording it would drift from what the audit log recorded. */}
      {query.failureReason ? (
        <p className="text-sm font-medium text-text-default">{query.failureReason}</p>
      ) : null}

      <p className="text-sm text-text-muted">
        {scopeRevoked
          ? 'Access to the subsidiaries this question covered has changed since it was asked, so it could not be answered. Retrying runs the same access check and fails the same way — ask an administrator about your subsidiary access, or ask the question again within the access you now hold.'
          : query.status === 'dead_lettered'
            ? 'This question has been set aside for manual review after repeated failures. It cannot be retried from here; an administrator has to look at it.'
            : 'No answer was produced, and nothing will happen to this question until someone retries it.'}
      </p>

      {canRetryQuery(query.status) && !scopeRevoked && !mayRetry ? (
        <p className="text-sm text-text-muted">
          Only the person who asked this question, or an administrator, can retry it.
        </p>
      ) : null}

      {showRetry ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            onClick={() => retry.mutate(query.id)}
            busy={retry.isPending}
            busyLabel="Queueing…"
            icon={<RefreshIcon size={16} />}
          >
            Retry this question
          </Button>
          {/* Retry shares one 12-per-minute AI budget with asking, and a 403
              is still possible if this table has drifted from the server. */}
          {retry.error ? <InlineError>{userMessage(retry.error)}</InlineError> : null}
        </div>
      ) : null}

      <p className="text-xs text-text-muted">
        Asked {formatDateTime(query.createdAt)} · {query.attempts}{' '}
        {query.attempts === 1 ? 'attempt' : 'attempts'}
      </p>
    </Card>
  );
}

// ─── Answered or unsupported ─────────────────────────────────────────────────

/**
 * §13 requires the three answer statuses to be VISUALLY DISTINCT. The badge
 * carries colour, icon and label; the help sentence says what it means in
 * words; and the accent rule below gives the panel itself a different weight,
 * so the difference survives a glance from across a room.
 */
const ANSWER_ACCENT: Record<AnswerStatus, string> = {
  sourced: 'border-l-success',
  partially_sourced: 'border-l-accent-yellow',
  unsupported: 'border-l-danger',
};

function FinishedAnswer({ query }: { query: QueryDetail }) {
  const segments = parseAnswerSegments(query.responseText, query.citations);

  return (
    <div className="flex flex-col gap-4">
      {query.answerStatus ? (
        <div className="flex flex-col gap-2">
          <AnswerStatusBadge status={query.answerStatus} />
          <p className="text-sm text-text-muted">{answerStatusHelp(query.answerStatus)}</p>
        </div>
      ) : null}

      {/* Pre-rendered English from the server (query.service.ts:157-173), not
          codes. Rendered verbatim — re-deriving these sentences from
          `retrieval` would state as fact something the server did not say. */}
      {query.warnings.length > 0 ? (
        <div className="rounded-md border border-accent-yellow bg-accent-yellow/10 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-primary-dark">
            <AlertTriangleIcon size={14} />
            Warnings
          </p>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-sm text-text-default">
            {query.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card
        className={cn(
          'border-l-4',
          query.answerStatus ? ANSWER_ACCENT[query.answerStatus] : 'border-l-border',
        )}
      >
        {segments.length > 0 ? (
          <AnswerBody segments={segments} />
        ) : (
          <p className="text-sm text-text-muted">No answer text was recorded for this question.</p>
        )}
      </Card>

      {/*
        Provenance, §13. `generationMs` is tested against null rather than for
        truthiness: 0 ms is a real, correct value on the zero-retrieval
        `unsupported` path, where the text is a fixed server sentence the
        provider never saw (query.worker.ts:217-222).
      */}
      <p className="text-xs text-text-muted">
        {query.answeredAt ? `Answered ${formatDateTime(query.answeredAt)}` : 'Not yet answered'}
        {query.provider ? ` · ${query.provider}` : ''}
        {query.promptVersion ? ` · ${query.promptVersion}` : ''}
        {query.generationMs !== null ? ` · ${query.generationMs.toLocaleString('en-IN')} ms` : ''}
      </p>
    </div>
  );
}

/**
 * The answer prose.
 *
 * `parseAnswerSegments` is the ONLY thing that reads the text, and all it takes
 * out of it is the digits inside `[n]`. Text runs come back as plain React text
 * nodes — never HTML, and never a markdown renderer (§9.13) — and each marker
 * that resolved to a citation becomes a link to that source.
 *
 * A marker with no matching citation never reaches this map: the parser folds
 * it back into the surrounding prose with its brackets intact, so it renders as
 * inert text rather than a link into a document the reader is no longer allowed
 * to open. We deliberately do not re-scan the merged prose to style it — that
 * would be parsing citation data out of the text, which is exactly what the
 * ordinal lookup exists to avoid.
 *
 * `ProseText` cannot wrap this: it accepts a string child, and an answer is a
 * mix of text and links. The classes below are its classes, for the same
 * reasons — `whitespace-pre-wrap` to keep the model's paragraphing, and
 * `break-words` because extracted identifiers would otherwise push the page
 * sideways.
 */
function AnswerBody({ segments }: { segments: AnswerSegment[] }) {
  return (
    <div className="text-sm leading-relaxed break-words whitespace-pre-wrap text-text-default">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <CitationMarker key={index} ordinal={segment.ordinal} citation={segment.citation} />
        ),
      )}
    </div>
  );
}

function CitationMarker({
  ordinal,
  citation,
}: {
  ordinal: number;
  citation: QueryCitation;
}) {
  const href = citationHref(citation);
  const label = `Source ${ordinal}: ${citationSourceLabel(citation)}`;

  // Same rule as the citation list: no usable id means no link, not a link that
  // fails. The number stays visible either way so the reader can still find the
  // entry in the citation list below.
  if (!href) {
    return <span className="text-xs font-semibold text-text-muted">[{ordinal}]</span>;
  }

  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="mx-0.5 rounded-sm bg-sih-blue/10 px-1 text-xs font-semibold tabular-nums text-sih-blue underline-offset-2 hover:underline"
    >
      [{ordinal}]
    </Link>
  );
}
