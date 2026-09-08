'use client';

import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { Button } from '@/components/ui/Button';
import {
  CharCount,
  Field,
  FormError,
  Select,
  TextArea,
  fieldErrorsOf,
} from '@/components/ui/Field';
import { StatusMessage } from '@/components/ui/Feedback';
import { Card } from '@/components/ui/Layout';
import { QueryStatusBadge, ReviewStatusBadge } from '@/components/ui/StatusBadge';
import {
  canSetReviewStatus,
  useReviewQuery,
  type QueryDetail,
  type ReviewQueryBody,
} from '@/features/queries/api';
import { userMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/datetime';

/**
 * The human half of an answer — PRD §5.7, §8.1.
 *
 * Render this only for a user who holds `query:review`; an `moc_official` is
 * refused `PATCH /queries/:id` at the route for ANY body, even a bare note.
 *
 * ─── THE TWO GATES, AND WHY THEY ARE NOT THE SAME GATE ──────────────────────
 * ROLE: `reviewStatus: 'approved'` is admin-only and is checked in the SERVICE,
 * not the route (query.service.ts:391-394) — a `cil_user` passes `roleGuard`
 * and then takes a 403. So the Approve OPTION is gated on `query:approve`,
 * separately from the panel itself.
 *
 * STATUS: `reviewStatus` may only change while the query is `answered` or
 * `unsupported` (`canSetReviewStatus`). Deliberately not `isQueryTerminal`,
 * which also admits `dead_lettered` and would offer a decision the server
 * refuses with a 400. The OTHER fields have no status gate at all and can be
 * saved at any status, including `queued`, which is why the note and the
 * official response stay editable when the decision control is absent.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `officialResponseText` and `responseText` are DIFFERENT FIELDS. The first is
 * what a person writes here; the second is what the model produced. Nothing in
 * this panel touches the model's answer, and saving here never rewrites it.
 */

/**
 * query.schema.ts:59-67 — `officialResponseText` rejects '' (min 1); a
 * `reviewNote` of '' is accepted and clears the note.
 *
 * Both caps are measured server-side AFTER NFKC normalisation and
 * invisible-character stripping, so the counters below are an approximation and
 * the server's answer is the authoritative one — hence `fieldErrorsOf`.
 */
const OFFICIAL_MAX = 2000;
const NOTE_MAX = 500;

type Decision = '' | 'pending' | 'approved' | 'rejected';

export function ReviewPanel({ query }: { query: QueryDetail }) {
  const { user } = useAuth();
  const review = useReviewQuery();

  /**
   * Seeded from the row, then re-synced ONLY from a successful save.
   *
   * Not from the row itself: the detail query polls, and a poll landing
   * mid-sentence must not overwrite what someone is typing. But the saved text
   * is not necessarily the text that was typed — the server NFKC-normalises and
   * strips invisible characters — so a form that keeps the typed version reads
   * as permanently unsaved. The response is the authoritative copy.
   */
  const [official, setOfficial] = useState(query.officialResponseText ?? '');
  const [note, setNote] = useState(query.reviewNote ?? '');
  const [decision, setDecision] = useState<Decision>(
    query.reviewStatus === 'not_required' ? '' : query.reviewStatus,
  );

  const mayApprove = can(user, 'query:approve');
  const decisionAllowed = canSetReviewStatus(query.status);

  const officialTrimmed = official.trim();
  const noteTrimmed = note.trim();
  const storedOfficial = query.officialResponseText ?? '';
  const storedNote = query.reviewNote ?? '';

  /** Blanking the box cannot clear the stored answer — '' is a 400 — so it is
   *  simply not sent, and the user is told rather than left guessing. */
  const officialBlanked = officialTrimmed.length === 0 && storedOfficial.length > 0;

  const body: ReviewQueryBody = {};
  if (officialTrimmed.length > 0 && officialTrimmed !== storedOfficial) {
    body.officialResponseText = officialTrimmed;
  }
  if (noteTrimmed !== storedNote) body.reviewNote = noteTrimmed;
  if (decisionAllowed && decision !== '' && decision !== query.reviewStatus) {
    body.reviewStatus = decision;
  }

  const changed = Object.keys(body).length > 0;
  const overLimit = officialTrimmed.length > OFFICIAL_MAX || noteTrimmed.length > NOTE_MAX;

  const errorFor = fieldErrorsOf(review.error);
  const fieldLevel =
    errorFor('officialResponseText') ?? errorFor('reviewNote') ?? errorFor('reviewStatus');
  // A 403 (approval by a non-admin), a 400 status gate, a 404 on an unlinked
  // report and a rate limit all land here rather than on a field.
  const formError = review.error && !fieldLevel ? userMessage(review.error) : null;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ReviewStatusBadge status={query.reviewStatus} />
        {query.reviewedAt ? (
          <span className="text-sm text-text-muted">
            Last reviewed {formatDateTime(query.reviewedAt)}
            {user && query.reviewedBy === user.id ? ' by you' : ''}
          </span>
        ) : null}
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || overLimit) return;
          review.mutate(
            { id: query.id, ...body },
            {
              onSuccess: (updated) => {
                setOfficial(updated.officialResponseText ?? '');
                setNote(updated.reviewNote ?? '');
                setDecision(updated.reviewStatus === 'not_required' ? '' : updated.reviewStatus);
              },
            },
          );
        }}
      >
        <Field
          label="Official response"
          description="The department's own answer, stored separately from the model's answer above and never a replacement for it. It cannot be blanked once saved — replace the text instead."
          error={errorFor('officialResponseText')}
        >
          {(fieldProps) => (
            <>
              <TextArea
                {...fieldProps}
                rows={6}
                value={official}
                onChange={(event) => setOfficial(event.target.value)}
                placeholder="Write the response that will be issued."
              />
              {/* The TRIMMED length, because that is what `overLimit` gates
                  the submit on and what the server measures. Counting the raw
                  value turns the counter red — the only over-limit signal
                  there is — beside a Save button that is still enabled and a
                  request the server would still accept. */}
              <CharCount value={officialTrimmed} max={OFFICIAL_MAX} />
            </>
          )}
        </Field>

        {officialBlanked ? (
          <p className="text-sm text-text-muted">
            Clearing this box will not remove the saved official response. Type the replacement text
            instead.
          </p>
        ) : null}

        {decisionAllowed ? (
          <Field
            label="Review decision"
            description={
              mayApprove
                ? undefined
                : 'Only an administrator can approve a response. You can send it back for review or record a rejection.'
            }
            error={errorFor('reviewStatus')}
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={decision}
                onChange={(next) => setDecision(next as Decision)}
              >
                {/*
                  `not_required` can be filtered but never SET — there is no
                  route back to it (query.schema.ts:62). It is offered here only
                  as the disabled description of where the query currently is.
                */}
                {query.reviewStatus === 'not_required' ? (
                  <option value="" disabled>
                    No review needed (current)
                  </option>
                ) : null}
                <option value="pending">Awaiting review</option>
                {/*
                  Approval is admin-only, but an already-approved query must
                  still render its own state: a select whose value matches no
                  option silently displays the first one instead, which would
                  show an approved answer as "Awaiting review". So the option
                  stays, disabled, when it is the current value.
                */}
                {mayApprove || query.reviewStatus === 'approved' ? (
                  <option value="approved" disabled={!mayApprove}>
                    Approved
                  </option>
                ) : null}
                <option value="rejected">Rejected</option>
              </Select>
            )}
          </Field>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-text-default">Review decision</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
              {/*
                "Once it has finished" is only true while the worker is still
                holding the question. `failed` and `dead_lettered` have STOPPED
                without an answer — nothing moves a failed row but an explicit
                retry, and nothing moves a dead-lettered one at all — so the
                waiting sentence would promise a transition that is not coming.
              */}
              {query.status === 'dead_lettered'
                ? 'This question was set aside for manual review without producing an answer, so there is no answer to decide on.'
                : query.status === 'failed'
                  ? 'This question stopped without producing an answer. A decision can only be recorded once a retry has answered it.'
                  : 'A decision can only be recorded once the query has finished answering.'}
              <QueryStatusBadge status={query.status} />
            </p>
          </div>
        )}

        <Field
          label="Review note"
          description="Internal only. Leave it empty to clear a note that is already saved."
          error={errorFor('reviewNote')}
        >
          {(fieldProps) => (
            <>
              <TextArea
                {...fieldProps}
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <CharCount value={noteTrimmed} max={NOTE_MAX} />
            </>
          )}
        </Field>

        {formError ? <FormError>{formError}</FormError> : null}

        <div className="flex flex-wrap items-center gap-3">
          {/* `PATCH` with an empty body is a 400 carrying `fields.body`, so an
              unchanged form has nothing to send and says so by staying disabled. */}
          <Button
            type="submit"
            disabled={!changed || overLimit}
            busy={review.isPending}
            busyLabel="Saving…"
          >
            Save review
          </Button>
          {review.isSuccess && !changed ? <StatusMessage>Review saved.</StatusMessage> : null}
        </div>
      </form>

      {/*
        `linkedReportId` and `isParliamentary` are also PATCHable and are
        deliberately absent. Linking a report needs a scoped report picker, and
        flipping `isParliamentary` after creation does NOT recompute
        `reviewStatus` (query.service.ts:419) — a control that silently does
        less than its label promises is worse than no control.
      */}
    </Card>
  );
}
