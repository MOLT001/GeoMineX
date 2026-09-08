'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { CharCount, Field, FormError, TextArea, fieldErrorsOf } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Feedback';
import { Card } from '@/components/ui/Layout';
import { type CreateQueryBody, useAskQuery } from '@/features/queries/api';
import { useSubsidiaries } from '@/features/subsidiaries/api';
import { ApiError, userMessage } from '@/lib/api/errors';

/**
 * Ask a question — PRD §5.7.
 *
 * This panel hands the API one question and then gets out of the way. `POST
 * /queries` answers 201 with an EMPTY row in status `queued` — no answer, no
 * citations, no `answeredAt` — so there is nothing here to wait for. On success
 * we route to the detail screen, which polls `GET /queries/:id` (that endpoint
 * is not AI-limited, so the poll is cheap). Rendering an answer area here would
 * mean standing up a second poller on the one screen that has to stay light.
 *
 * The caller gates rendering on `can(user, 'query:ask')`. That is UX only
 * (§9.1) — every server refusal below is still handled on its own terms.
 */

/**
 * `query.schema.ts:23-30`. Both ends inclusive, and measured AFTER the server
 * normalises the string — see `normalizeQuestion`.
 */
const QUESTION_MIN = 10;
const QUESTION_MAX = 2000;

export function AskPanel() {
  const router = useRouter();
  const ask = useAskQuery();

  /**
   * Shares the 30-minute `['subsidiaries']` cache entry with the picker below,
   * so this costs no extra request.
   *
   * An empty list is a SUCCESS, not an error, and it is exactly the condition
   * the server answers with 400 'You have no subsidiary access; nothing can be
   * queried' — for a non-admin with no grants, and equally for an admin when no
   * subsidiary exists at all. Both land here rather than after 200 words of
   * typing.
   */
  const { data: subsidiaries, isPending: scopePending, isError: scopeFailed } = useSubsidiaries();
  const nothingInScope = !scopePending && !scopeFailed && (subsidiaries?.length ?? 0) === 0;

  const [questionText, setQuestionText] = useState('');
  const [subsidiaryId, setSubsidiaryId] = useState('');
  const [isParliamentary, setIsParliamentary] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const parliamentaryId = useId();

  const normalized = normalizeQuestion(questionText);
  const tooShort = normalized.length < QUESTION_MIN;
  const tooLong = normalized.length > QUESTION_MAX;

  /**
   * Held from the first click until the route actually changes. `isSuccess` is
   * part of it because the mutation settles a beat before the navigation
   * commits, and the ask and retry endpoints share ONE 12/minute budget keyed
   * on the user id — a second click inside that beat spends a second slot on a
   * question that has already been asked.
   */
  const locked = ask.isPending || ask.isSuccess;

  const error = ask.error;
  /**
   * 429 is a pacing problem, never an authentication one. It must not read as a
   * session failure and must not lead anywhere that looks like a sign-out; the
   * four 401 codes are the only auth signals (lib/api/errors.ts).
   *
   * Matched on the status as well as the code because the limiter answers ahead
   * of the route, before anything else in the request has run.
   */
  const rateLimited =
    error instanceof ApiError && (error.status === 429 || error.code === 'RATE_LIMIT_EXCEEDED');
  /**
   * The only 404 reachable from this form is a `subsidiaryId` outside the
   * caller's grants — the API answers 404 rather than 403 by design, and
   * `userMessage` renders the flat "Not found." that convention requires. What
   * is added is what to DO next, never which record exists.
   */
  const notFound = error instanceof ApiError && error.code === 'NOT_FOUND';

  const questionError = localError ?? fieldErrorsOf(error)('questionText');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (locked) return;

    /**
     * Checked before `mutate`, not after: `aiLimiter` is mounted BEFORE
     * `validate` on this route (query.routes.ts:38-39), so a body the server
     * then rejects as too short has already spent one of the twelve slots.
     * Local validation is a quota saver, not the authority — the server's
     * VALIDATION_ERROR still lands on the field through `fieldErrorsOf`.
     */
    if (tooShort) {
      setLocalError(
        questionText.trim().length >= QUESTION_MIN
          ? 'This question is shorter than it looks — invisible characters are not counted. Type at least 10 ordinary characters.'
          : `Questions need at least ${QUESTION_MIN} characters.`,
      );
      return;
    }
    if (tooLong) {
      setLocalError(`Shorten this to ${QUESTION_MAX.toLocaleString('en-IN')} characters or fewer.`);
      return;
    }
    setLocalError(null);

    const body: CreateQueryBody = {
      // Sent as typed. The server normalises and stores its own version, which
      // is why the detail screen renders the question from the RESPONSE.
      questionText,
      isParliamentary,
      // Omitted rather than sent empty: absent means "every subsidiary I can
      // read", while '' is not a 24-hex id and is a 400.
      ...(subsidiaryId ? { subsidiaryId } : {}),
      /**
       * `documentIds` is deliberately not offered here. It is ALL-OR-NOTHING
       * and validated-only: one id that is missing, out of scope, or not yet
       * `validated` rejects the whole ask without saying which one
       * (query.service.ts:111-120). A picker for it is only usable once it is
       * restricted to validated documents, and that belongs on a screen that
       * already lists them.
       */
    };

    ask.mutate(body, {
      // The hook has already seeded the detail cache with this row, so the
      // answer screen paints the question immediately instead of spinning
      // through its first poll.
      onSuccess: (created) => router.push(`/queries/${created.id}`),
    });
  }

  if (nothingInScope) {
    return (
      <EmptyState
        title="There is nothing to ask about yet"
        description="Answers are built only from documents in the subsidiaries you can read, and none are available to you. An administrator can grant access."
      />
    );
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Your question"
          required
          description="Answers are drawn only from documents you are allowed to read, and every claim carries a citation."
          error={questionError}
        >
          {(fieldProps) => (
            <TextArea
              {...fieldProps}
              rows={4}
              value={questionText}
              disabled={locked}
              placeholder="e.g. How did coking coal production change over the last two quarters?"
              onChange={(event) => {
                setQuestionText(event.target.value);
                setLocalError(null);
              }}
            />
          )}
        </Field>

        {/*
          Counts the NORMALISED string, not the raw one. The server measures
          `questionText` after NFKC normalisation and invisible-character
          stripping (utils/safeText.ts:41-52), so a box that looks full can be
          empty as far as validation is concerned — this counter is where that
          becomes visible instead of arriving later as a mystery 400.
        */}
        <CharCount value={normalized} max={QUESTION_MAX} />

        <div className="grid gap-4 sm:grid-cols-2">
          <SubsidiaryPicker
            value={subsidiaryId}
            onChange={setSubsidiaryId}
            label="Limit to a subsidiary"
            allowAll
            disabled={locked}
          />

          <div className="flex items-start gap-2 sm:pt-7">
            <input
              id={parliamentaryId}
              type="checkbox"
              checked={isParliamentary}
              disabled={locked}
              onChange={(event) => setIsParliamentary(event.target.checked)}
              aria-describedby={`${parliamentaryId}-help`}
              className="mt-0.5 size-4 shrink-0 accent-sih-blue"
            />
            <div>
              <label htmlFor={parliamentaryId} className="text-sm font-medium text-text-default">
                Parliamentary question
              </label>
              {/*
                Only true AT CREATION opens a review: `reviewStatus` is derived
                from this flag when the row is written and is never recomputed
                (query.service.ts:345, :419). Ticking it later on the detail
                screen changes the answer style and nothing else, so the choice
                genuinely belongs here.
              */}
              <p id={`${parliamentaryId}-help`} className="text-xs text-text-muted">
                Queues the answer for human review before it can be used, and asks for a
                parliamentary answer style.
              </p>
            </div>
          </div>
        </div>

        {error ? (
          <FormError>
            {rateLimited
              ? 'You are asking too quickly. The assistant takes 12 questions a minute per person, retries count against the same budget, and even a rejected question spends a slot. Wait a moment and ask again.'
              : userMessage(error)}
            {notFound ? ' Choose a different scope and try again.' : null}
          </FormError>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-text-muted">
            You will be taken to the answer while it is still being written.
          </p>
          <Button type="submit" busy={ask.isPending} busyLabel="Sending…" disabled={locked}>
            Ask
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * A close approximation of the server's `safeText` transform — NFKC, then
 * invisible and control characters removed, then trimmed
 * (utils/safeText.ts:41-52).
 *
 * Deliberately an approximation and not a re-implementation: the server is the
 * authority and its answer still reaches the field. What this buys is a counter
 * and a submit guard that agree with it closely enough that a pasted run of
 * zero-width characters reads as empty here rather than as a 400 later.
 *
 * Tab, newline and carriage return survive the server's strip
 * (unicodeNormalize.ts:20), so they survive here too — a multi-line question is
 * legitimate.
 */
function normalizeQuestion(value: string): string {
  const KEPT_CONTROLS = '\t\n\r';
  return value
    .normalize('NFKC')
    // Cf is the invisible formatting class — zero-width space and joiners, bidi
    // marks, the soft hyphen. Cc is the C0/C1 controls, of which the three
    // above are the only ones the server keeps.
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, (character) => (KEPT_CONTROLS.includes(character) ? character : ''))
    .trim();
}
