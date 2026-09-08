import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ApiError, NOT_FOUND_MESSAGE, userMessage } from '@/lib/api/errors';
import { Button } from './Button';

/**
 * Loading, empty and error states.
 *
 * Every list and detail screen in this app has all three, so they are one
 * component each rather than an improvisation per screen. The improvisations
 * are where the accessibility slips happen: a spinner with no accessible name,
 * an error rendered as ordinary text that a screen reader never announces, an
 * empty state indistinguishable from a still-loading one.
 *
 * ─── WHY THESE ARE NOTICES, NOT CARDS ───────────────────────────────────────
 * `ErrorState` and `StatusMessage` are square panels bounded by a rule with the
 * outcome declared on the LEADING EDGE — the shape a government notice takes,
 * and the shape `AnswerView` already gives an unsupported answer. A rounded,
 * tinted card reads as page furniture: one more grey box among the grey boxes.
 * These two are the blocks on a screen that must not be mistaken for furniture,
 * so they are given an edge rather than a fill.
 *
 * The weight of each mirrors its live-region politeness, which is the only
 * honest way to rank them: `ErrorState` is assertive and interrupts, so it
 * takes the perceivable `border-strong` frame; `StatusMessage` is polite and
 * was asked for, so it takes the quiet one.
 *
 * None of them carries a shadow, and that follows UX4G's elevation rule rather
 * than dodging it. Level 1 is for "resting cards" — and these blocks almost
 * always render INSIDE one, so a second shadow stacked on the card's own would
 * lift a notice into the layer their guidance reserves for popovers and modals.
 * The 1px rule is the separator instead, which is the border-plus-elevation
 * pairing UX4G asks for with the elevation half set to nothing.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** A grey block standing in for content that has not arrived. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      // Purely decorative: the surrounding region carries `aria-busy`, so
      // announcing individual placeholder blocks would just be noise.
      aria-hidden
      className={cn(
        // Filled with the PAGE GROUND rather than the card tint, and the choice
        // is literal: what you are looking at is the ground showing through,
        // because nothing has been placed on it yet. It is also the only fill
        // that survives the pulse — `animate-pulse` drops to 50% opacity, and
        // `surface-muted` at half strength on a white card is not a placeholder,
        // it is a gap. Under `motion-reduce` the animation goes entirely and
        // the fill is the sole signal, so it has to hold on its own.
        'animate-pulse rounded-sm bg-canvas motion-reduce:animate-none',
        className,
      )}
    />
  );
}

/**
 * The standard "still loading" block for a whole region.
 *
 * `role="status"` with a visually hidden label is what makes the wait
 * perceivable without sight. The skeleton alone is not.
 */
export function LoadingBlock({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-1.5">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        // Ruled, and tighter than before: a region-sized wait reads as a set of
        // empty records waiting to be filed, which is what it is. The rule is
        // load-bearing here — this block often lands directly on the canvas
        // ground, where the placeholder's own fill matches the page.
        <Skeleton key={i} className="h-12 border border-border-strong" />
      ))}
    </div>
  );
}

/**
 * An error, with an optional retry.
 *
 * The 404 case is special and is handled here rather than at each call site,
 * because getting it wrong leaks. The API returns 404 both for "no such record"
 * and for "a record you are not scoped to" — deliberately indistinguishable
 * (`backend/src/utils/authorization.ts`). A friendlier message naming the
 * subsidiary would rebuild exactly the existence oracle that convention hides.
 * So a 404 renders as a flat "Not found." with no retry: retrying will not
 * change the answer, and offering it implies the record might be there.
 *
 * 403 is a different thing and may be explicit — the record IS visible to you,
 * the action is not permitted.
 */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
  className?: string;
}) {
  const isNotFound = error instanceof ApiError && error.code === 'NOT_FOUND';
  const message = userMessage(error);

  return (
    <div
      // `role="alert"` is assertive on purpose: a failed action must interrupt,
      // because the user is about to act on the assumption it succeeded.
      role="alert"
      className={cn(
        // Square, seated on the white of a record and framed by a rule that
        // clears 3:1, because this edge carries meaning. Both branches keep the
        // one shape: "Not found." and "Something went wrong" must not be
        // separable by appearance either, or the panel re-opens by styling the
        // oracle the message closes.
        'flex flex-col items-start gap-3 border border-border-strong border-l-4 border-l-danger bg-surface p-4',
        className,
      )}
    >
      <div>
        {/*
          Heading/S. UX4G's usage map puts a panel title at 20–24px, and in the
          `isNotFound` branch this line IS the whole notice — at body size it
          was competing with the page copy around it instead of leading it.
          Weight stays at 600: their rule is that emphasis comes from the Strong
          weight and never from a size bump, so the step up here is this block's
          rank in the type scale, not shouting.
        */}
        <p className="text-xl font-semibold text-text-strong">
          {isNotFound ? NOT_FOUND_MESSAGE : 'Something went wrong'}
        </p>
        {/*
          Body/M, not Body/S. 14px is UX4G's helper-text step, and this line is
          not helper text — it is the only account of what actually failed, so
          it belongs at the 16px body floor.
        */}
        {!isNotFound ? <p className="mt-1.5 text-base text-text-muted">{message}</p> : null}
      </div>
      {onRetry && !isNotFound ? (
        // Default size, not `sm`. WCAG 2.5.5 puts the target floor at 44px and
        // UX4G restates it; the smaller step exists for genuinely dense
        // contexts — a control inside a table row — and a region-sized error
        // panel holding one control is the opposite of that.
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A short error beside the control that caused it. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    // Deliberately bare, not a notice: it belongs to the control above it, and a
    // framed panel here would compete with the field it is describing. The
    // added weight is what separates it from the help text it sits beside,
    // since colour alone would not.
    //
    // Body/S is the deliberate step and stays: this is the field-level message,
    // so it has to be typographically identical to the error `Field` renders
    // under a control (ui/Field.tsx) — two sizes for the same object would read
    // as two different kinds of problem. 14px is a real step in UX4G's scale,
    // not a breach of the 16px body floor, which governs prose.
    <p role="alert" className="text-sm font-medium text-danger">
      {children}
    </p>
  );
}

/**
 * Nothing here — and, where it matters, what to do about it.
 *
 * The distinction that earns the `action` slot: "no documents have been
 * uploaded yet" wants an Upload button, whereas "no documents match this
 * filter" wants a Clear filters control. Rendering the same empty state for
 * both is how a filtered-to-nothing list reads as a broken one.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    // The dashed rule is the point, and it stays: a solid rule draws a filed
    // record, a dashed one draws the space where a record would go. Squared and
    // strengthened so that space is actually visible against the canvas ground,
    // and the vertical padding cut back — three rems of air around one sentence
    // is a marketing empty state, not a government one.
    <div className="flex flex-col items-center gap-2 border border-dashed border-border-strong px-6 py-9 text-center">
      {/*
        Within its region this is a heading and is read as one, even though the
        page outline already owns the real headings above it — so it takes
        UX4G's Heading/S step (20px) rather than sitting at body size, where it
        was indistinguishable from the sentence beneath it.

        `font-serif` is kept, but only for consistency with its ~40 sibling call
        sites: it resolves to the same Noto stack as everything else now
        (globals.css), because UX4G carries heading hierarchy in weight rather
        than in a second family.
      */}
      <p className="font-serif text-xl font-semibold text-text-strong">{title}</p>
      {/* Body/M — 16px is UX4G's floor for anything read as prose. */}
      {description ? <p className="max-w-md text-base text-text-muted">{description}</p> : null}
      {/*
        The action gets its own step of space — it is a control, not a third
        line of prose. `empty:hidden` drops the wrapper, and with it the margin
        and the flex gap, when no action was supplied.
      */}
      <div className="mt-2 empty:hidden">{action}</div>
    </div>
  );
}

/**
 * A polite live region for the outcome of a mutation.
 *
 * Mutation results are the easiest thing in a SPA to make invisible to assistive
 * technology: a row quietly changes in place, and a sighted user sees it while a
 * screen-reader user gets nothing at all. Rendering the confirmation into a live
 * region is the cheapest fix.
 *
 * Polite, not assertive — the user asked for this and is not being interrupted.
 */
export function StatusMessage({ children }: { children: ReactNode }) {
  return (
    // The `ErrorState` notice shape at the weight a confirmation earns: a quiet
    // frame, the outcome on the leading edge, nothing that interrupts. A bare
    // green line was indistinguishable from ordinary body copy the moment it
    // landed beside any.
    <p
      role="status"
      aria-live="polite"
      // Body/M, with the padding opened a step to seat it. A confirmation is
      // read as a sentence, not scanned as helper text, so 14px put it under
      // UX4G's 16px body floor for no gain — the notice keeps its quiet rank
      // through its border weight, which is where that ranking belongs.
      className="border border-border border-l-4 border-l-success bg-surface px-4 py-2.5 text-base text-success"
    >
      {children}
    </p>
  );
}
