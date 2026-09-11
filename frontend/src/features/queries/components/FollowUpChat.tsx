'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { InlineError } from '@/components/ui/Feedback';
import { TextArea } from '@/components/ui/Field';
import { Card } from '@/components/ui/Layout';
import type { QueryDetail } from '@/features/queries/api';
import {
  askGemini,
  buildDocumentContext,
  geminiConfigured,
  type ChatTurn,
} from '@/features/queries/gemini';
import { cn } from '@/lib/cn';

/**
 * Conversation about an answer the corpus has already produced.
 *
 * ─── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
 * The answer ABOVE this panel came from the corpus: retrieved passages, an
 * extractive provider, and a `[n]` on every figure pointing at a page. That is
 * the product's claim, it is produced entirely by the backend, and nothing here
 * touches it.
 *
 * This panel is a SECOND, weaker channel: a general-purpose model with no
 * retrieval and no citations. The two must never be confused, which is why
 * every reply is badged, sits on a tinted ground rather than the white of a
 * record, and says plainly that it is not evidence. Remove that framing and the
 * screen starts implying a traceability it does not have — the one failure §13
 * exists to prevent.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The exchange lives in component state and nowhere else. It is deliberately
 * not persisted and not sent to the API: it is not evidence, and filing it
 * beside the cited answers would blur the same line.
 */

/** The model gets the whole exchange, but an unbounded history is unbounded cost. */
const MAX_TURNS = 12;

interface Message extends ChatTurn {
  id: string;
}

export function FollowUpChat({ query }: { query: QueryDetail }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  /** Abort in flight on unmount, so a reply cannot land on a dead component. */
  const inFlight = useRef<AbortController | null>(null);
  /** Which query id has already been auto-asked, so it happens exactly once. */
  const seededFor = useRef<string | null>(null);

  useEffect(
    () => () => {
      inFlight.current?.abort();
      /**
       * Releasing the lock IMMEDIATELY is half of surviving StrictMode, and the
       * half that is easy to miss.
       *
       * `abort()` rejects the fetch asynchronously, so the `finally` that would
       * normally clear this has NOT run by the time React re-runs the setups on
       * the same tick. The second auto-ask then finds the lock still held by the
       * controller that was just cancelled and returns early — one aborted
       * request, no reply, an empty panel. Clearing it here is safe because the
       * aborted turn's `finally` re-checks identity before nulling.
       */
      inFlight.current = null;
      /**
       * Clearing the marker is what makes the auto-ask survive StrictMode.
       *
       * React runs setup → cleanup → setup in development. Without this the
       * first setup would seed and fire, this cleanup would ABORT that request,
       * and the second setup would find the marker already set and never retry —
       * leaving the panel permanently empty on every dev page load. Resetting
       * lets the second setup re-seed, which is also the right behaviour for a
       * genuine remount.
       */
      seededFor.current = null;
    },
    [],
  );

  /**
   * One path for every question, typed or automatic.
   *
   * A `useCallback` rather than a function declaration because the auto-ask
   * effect below CALLS it, and the React compiler rejects reading a binding
   * declared further down the component — rightly, since that effect would
   * otherwise be free to capture a stale one.
   */
  const ask = useCallback(
    /**
     * `turnId` lets a caller name the turn it is asking, so asking twice for the
     * same one cannot post the question twice — see the auto-ask below.
     */
    async (question: string, turnId?: string) => {
      // `inFlight` is the lock. It also stops the auto-ask and a fast typist
      // from overlapping, which would interleave two replies into one thread.
      if (!question || inFlight.current) return;

      const id = turnId ?? `u${(counter.current += 1)}`;
      const asked: Message = { id, role: 'user', text: question };
      /**
       * The history sent is what was on screen BEFORE this turn; the new
       * question is appended by `askGemini` itself, so it is never sent twice.
       * This turn is filtered OUT explicitly, because a re-ask of a named turn
       * finds its own question already in the transcript and would otherwise
       * send it as both history and question.
       */
      const history = messages
        .filter((m) => m.id !== id)
        .slice(-MAX_TURNS)
        .map(({ role, text }) => ({ role, text }));

      /**
       * Appended ONCE per turn id.
       *
       * React runs setup → cleanup → setup in development, and the cleanup
       * below deliberately clears the auto-ask marker so the second setup
       * re-seeds — otherwise the aborted first request would leave the panel
       * permanently empty. What it could not undo was the message the first
       * setup had ALREADY appended, so the opening question appeared twice in
       * the transcript with a single answer under it.
       */
      setMessages((current) =>
        current.some((m) => m.id === id) ? current : [...current, asked],
      );
      setError(null);
      setBusy(true);

      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const reply = await askGemini(
          question,
          buildDocumentContext(query),
          history,
          controller.signal,
        );
        setMessages((current) => [
          ...current,
          { id: `m${(counter.current += 1)}`, role: 'model', text: reply },
        ]);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'The assistant failed.');
        // The question stays in the transcript. Removing it would make a failed
        // turn look like it never happened, and the user would retype it.
      } finally {
        if (inFlight.current === controller) inFlight.current = null;
        setBusy(false);
      }
    },
    [messages, query],
  );

  /**
   * Answer the ORIGINAL question too, not only follow-ups.
   *
   * The cited answer above is the record and is produced entirely by the
   * backend pipeline, untouched. This adds the assistant's plain-language take
   * on the same question as the opening turn, so nobody has to retype what they
   * just asked.
   *
   * It waits for `responseText` deliberately. Before the worker finishes there
   * are no citations, and an ungrounded answer arriving FIRST is the one a
   * reader would anchor on. It DOES run when the status is `unsupported` — that
   * is precisely the case where the corpus held nothing and a general answer is
   * worth the most, provided it stays labelled as one.
   */
  useEffect(() => {
    if (!geminiConfigured() || !query.responseText) return;
    if (seededFor.current === query.id) return;
    seededFor.current = query.id;
    // Named after the query, so a second setup re-asks this turn rather than
    // posting the question again.
    void ask(query.questionText, `seed:${query.id}`);
  }, [query.id, query.responseText, query.questionText, ask]);

  /**
   * Follow the conversation as it grows.
   *
   * `block: 'nearest'` on the LAST message rather than scrolling the window:
   * this panel sits inside a long page, and pulling the whole document to the
   * bottom on every reply would yank the cited answer out of view.
   */
  useEffect(() => {
    if (messages.length === 0) return;
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [messages]);

  /**
   * Absent key, absent feature. Rendering a dead input that fails on submit
   * would be worse than not offering it — see `gemini.ts` for why the key is
   * optional at all.
   */
  if (!geminiConfigured()) return null;

  /** Nothing to discuss until the pipeline has produced something. */
  if (!query.responseText) return null;

  function send() {
    const question = draft.trim();
    if (!question) return;
    setDraft('');
    void ask(question);
  }

  return (
    <Card className="mt-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-serif text-base font-semibold text-primary-dark">Assistant</h3>
        <p className="text-sm text-text-muted">
          A plain-language take on the same question, and anything you want to ask about it.
          Replies come from a general assistant and carry{' '}
          <strong className="font-semibold">no citations</strong> — the cited answer above remains
          the record.
        </p>
      </div>

      {messages.length > 0 ? (
        <div
          ref={listRef}
          className="flex max-h-96 flex-col gap-3 overflow-y-auto"
          // Replies arrive after a wait, so they are announced rather than
          // silently appearing for someone not watching the screen.
          aria-live="polite"
          aria-busy={busy}
        >
          {messages.map((message) => (
            <Turn key={message.id} message={message} />
          ))}

          {busy ? (
            <p className="text-sm text-text-muted" role="status">
              Thinking&hellip;
            </p>
          ) : null}
        </div>
      ) : busy ? (
        // The automatic first answer is in flight and there is nothing on screen
        // yet, so the wait needs its own indicator rather than an empty panel.
        <p className="text-sm text-text-muted" role="status">
          Thinking&hellip;
        </p>
      ) : null}

      {error ? <InlineError>{error}</InlineError> : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex flex-col gap-2"
      >
        <label htmlFor={inputId} className="sr-only">
          Ask a follow-up question about this answer
        </label>
        <TextArea
          id={inputId}
          rows={2}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Explain this in simple terms"
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the convention every
            // chat input uses, and the reason this is a textarea.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" busy={busy} busyLabel="Asking…" disabled={!draft.trim()}>
            Ask
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** One turn. The asymmetry is the point: a reply must not look like a record. */
function Turn({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <span className="text-xs font-medium tracking-wide text-text-muted uppercase">
        {isUser ? 'You' : 'Assistant · not a cited source'}
      </span>
      <div
        className={cn(
          'max-w-[85%] rounded-md border px-3 py-2 text-base',
          isUser
            ? 'border-border-strong bg-surface-muted text-text-default'
            : // Tinted, never the white of a record — see the note at the top.
              'border-sih-blue/30 bg-sih-blue-tint text-text-default',
        )}
      >
        <AssistantText text={message.text} />
      </div>
    </div>
  );
}

/**
 * Render the reply as paragraphs and bullets.
 *
 * A deliberately tiny renderer, NOT a markdown library. Everything here is
 * model output, which §9.13 treats as untrusted: React text nodes make
 * injection impossible by construction, where a markdown renderer would
 * manufacture exactly the HTML surface the rule exists to avoid.
 */
function AssistantText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      {toBlocks(text).map((block, index) =>
        block.kind === 'list' ? (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {block.lines.map((line, i) => (
              <li key={i}>{stripEmphasis(line)}</li>
            ))}
          </ul>
        ) : (
          <p key={index} className="whitespace-pre-wrap">
            {stripEmphasis(block.lines.join('\n'))}
          </p>
        ),
      )}
    </div>
  );
}

interface Block {
  kind: 'list' | 'prose';
  lines: string[];
}

const BULLET = /^\s*[-*•]\s+/;

/**
 * Split a reply into runs of prose and runs of bullets, LINE BY LINE.
 *
 * Line by line rather than block by block, because a model writes
 *
 *     First set of figures:
 *     * Quarter ended June 2025: 53,481.08
 *     * Quarter ended June 2024: 43,159.80
 *
 * as one paragraph. Asking whether EVERY line in the block is a bullet fails on
 * the lead-in, so the whole thing fell through to prose and the asterisks
 * appeared on screen as literal characters. Grouping CONSECUTIVE bullet lines
 * keeps the lead-in a sentence and the lines under it a list.
 */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let breakRun = false;

  for (const paragraph of text.split(/\n{2,}/)) {
    for (const line of paragraph.split('\n')) {
      if (!line.trim()) continue;

      const kind: Block['kind'] = BULLET.test(line) ? 'list' : 'prose';
      const content = kind === 'list' ? line.replace(BULLET, '') : line;
      const last = blocks[blocks.length - 1];

      // A run continues only while the kind holds AND no paragraph break has
      // intervened, so two paragraphs never merge and two lists stay separate.
      if (!breakRun && last && last.kind === kind) last.lines.push(content);
      else blocks.push({ kind, lines: [content] });
      breakRun = false;
    }
    breakRun = true;
  }

  return blocks;
}

/**
 * Drop the `**` and `*` a model sprinkles through prose.
 *
 * Rendering them as bold would mean parsing model output into markup; leaving
 * them in reads as noise. Removing the markers keeps it plain text, which is
 * what this renderer promises.
 */
function stripEmphasis(line: string): string {
  return (
    line
      // `[\s\S]`, not `.`, because a bold span can straddle a line break inside
      // one paragraph — which left a literal `(**June 30,` on screen.
      .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
      .replace(/(^|\s)\*(\S(?:[\s\S]*?\S)?)\*(?=\s|$)/g, '$1$2')
      // An UNPAIRED `**` survives both passes — a reply cut off by the token
      // budget ends mid-span every time. Drop the orphan rather than show it.
      .replace(/\*\*/g, '')
  );
}
