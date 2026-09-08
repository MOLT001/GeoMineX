'use client';

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { CheckIcon, ChevronDownIcon } from './Icon';

/**
 * The dropdown — a custom listbox, and the reason it stopped being a <select>.
 *
 * ─── WHY THIS IS NO LONGER NATIVE ───────────────────────────────────────────
 * This used to be a native <select>, and the comment defending that was right
 * about the trade: native carries keyboard behaviour, type-ahead and the
 * platform's touch picker for free, "all of which a custom listbox has to
 * reimplement, and usually reimplements incompletely".
 *
 * What that reasoning cannot deliver is a designed dropdown. A native select's
 * POPUP is drawn by the operating system, not by the page: it ignores
 * essentially every property except font and a couple of colours, so the open
 * menu was a grey OS widget with a hard full-bleed blue selection bar sitting
 * in the middle of a government portal. No CSS reaches it. The only lever is to
 * stop using the native popup.
 *
 * So the trade is accepted and the debt is paid IN FULL below rather than waved
 * at — every behaviour that old comment named is reimplemented here and listed
 * in NATIVE_PARITY, so a reviewer can check them off one by one.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The ARIA shape is the APG "select-only combobox": role="combobox" on the
 * BUTTON, role="listbox" on the popup, and aria-activedescendant naming the
 * active option while DOM focus never leaves the button. The alternative —
 * moving real focus into the list — needs a focus trap and a restore-on-close,
 * which is a <dialog>-shaped set of problems to take on for a menu.
 *
 * ─── THE PANEL MUST BE PORTALED, AND THAT IS NOT A PREFERENCE ───────────────
 * `Card` sets `overflow-hidden` (ui/Layout.tsx), `Table` sets `overflow-x-auto`
 * (ui/Table.tsx) and NewReportPanel has a `max-h-72 overflow-y-auto` list. An
 * absolutely-positioned panel inside any of them is CLIPPED at the container's
 * edge — and nearly every dropdown in this product sits inside one, several
 * inside two. So the panel is portaled to <body> and positioned `fixed` against
 * the trigger's viewport rect.
 *
 * That is safe TODAY because no dropdown lives inside a <dialog>. A portal to
 * <body> renders BENEATH the top layer, so a Select added to ConfirmDialog,
 * FieldOverrideDialog or NavDrawer would open behind the modal and simply be
 * invisible. If that day comes, portal into the dialog element instead — do not
 * reach for z-index, which cannot beat the top layer at all.
 *
 * The inline `style` carrying the position is CSP-legal and deliberate:
 * `style-src-attr` allows attributes (lib/csp.ts) while `style-src` in
 * PRODUCTION is nonce-only and dev is 'unsafe-inline'. So a <style> element, a
 * styled-jsx block, or any positioning library that appends a stylesheet to
 * document.head works perfectly in `next dev` and is blocked after deploy —
 * which is the worst-shaped bug available here, and why this does its own maths.
 */

/**
 * The native behaviours this component owes, and where each is repaid. A real
 * exported constant rather than a comment, so it survives a refactor and can be
 * asserted by a test.
 */
export const NATIVE_PARITY = {
  keyboardOpen: 'Enter / Space / ArrowDown / ArrowUp / Alt+ArrowDown on the trigger',
  keyboardMove: 'ArrowUp, ArrowDown, Home, End, PageUp, PageDown while open',
  keyboardCommit: 'Enter or Space commits, Escape cancels, Tab commits and moves on',
  closedArrows: 'ArrowUp / ArrowDown while CLOSED step the value in place, as the platform does',
  typeAhead:
    'printable keys jump to the next matching label; a repeated letter cycles; 600ms buffer; IME-safe',
  activeIntoView:
    'the KEYBOARD caret is scrolled into view on open and on every move; hover never scrolls',
  disabledOptions: 'skipped by every movement key, and not selectable',
  groups: 'an <optgroup> becomes role="group" with an aria-label',
  mouseDragRelease: 'press, drag through the list, release on the option you want — no slop threshold',
  touchScroll: 'a drag scrolls the panel instead of choosing whatever it started on',
  secondaryButtons: 'a right- or middle-click reaches the context menu instead of committing',
  scrollAway: 'scrolling the trigger out of the viewport dismisses the panel, as the platform does',
  touchTarget: 'options are 44px tall — WCAG 2.5.5, which the native popup also met',
  forcedColors: 'the active row is outlined in the system Highlight colour',
  formAssociation:
    'a hidden input mirrors the value when `name` is given. No form in this product reads ' +
    'FormData today, but a native select DID contribute to its form and this keeps that true.',
} as const;

/** How long a type-ahead buffer survives between keystrokes. */
const TYPEAHEAD_MS = 600;

/** Gap between trigger and panel, and the panel's minimum margin from the viewport edge. */
const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;

/** How far PageUp / PageDown travel, matching the platform's own jump. */
const PAGE_STEP = 10;

/**
 * How far a pointer may travel between press and release and still count as a
 * tap rather than a scroll. Below the ~10px most touch platforms use, a lazy
 * thumb selects the wrong row; far above it, a deliberate tap stops working.
 */
const TAP_SLOP_PX = 10;

/** The panel height assumed before the panel exists to be measured. */
const ASSUMED_PANEL_PX = 240;

/** A panel shorter than this is not worth showing; it scrolls instead. */
const MIN_PANEL_PX = 120;

/**
 * `useLayoutEffect` warns when React renders on the server, and every page here
 * is server-rendered. The effect genuinely must be layout-phase on the client —
 * positioning in a passive effect paints the panel at 0,0 for a frame — so the
 * hook is swapped rather than downgraded.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface Item {
  value: string;
  label: string;
  disabled: boolean;
  /** The `<optgroup label>` this came from, if any. */
  group?: string;
}

/** One run of consecutive options sharing an `<optgroup>` — or no group at all. */
export interface Section {
  label?: string;
  entries: Array<{ item: Item; index: number }>;
}

/**
 * Flatten a React node to its text.
 *
 * An option's label has to BE a string: type-ahead matches on it and the
 * trigger echoes it. Every option in this product is a string or a string
 * expression, so anything else is dropped rather than rendered.
 */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/**
 * Read `<option>` / `<optgroup>` children into a flat item list.
 *
 * The children API is kept EXACTLY as the native select had it, and that is the
 * point: twenty-three call sites build their options by mapping an exhaustive
 * Record, and not one of those option lists had to change. `Children.toArray`
 * flattens the arrays that `.map()` produces and drops the nulls that a
 * conditional option produces.
 */
export function readItems(children: ReactNode): Item[] {
  const items: Item[] = [];

  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;

    if (child.type === 'optgroup') {
      const group = child.props as { label?: string; children?: ReactNode };
      for (const inner of Children.toArray(group.children)) {
        if (!isValidElement(inner) || inner.type !== 'option') continue;
        const option = inner.props as { value?: string; disabled?: boolean; children?: ReactNode };
        items.push({
          value: String(option.value ?? ''),
          label: textOf(option.children),
          disabled: Boolean(option.disabled),
          group: group.label,
        });
      }
      continue;
    }

    if (child.type === 'option') {
      const option = child.props as { value?: string; disabled?: boolean; children?: ReactNode };
      items.push({
        value: String(option.value ?? ''),
        label: textOf(option.children),
        disabled: Boolean(option.disabled),
      });
    }
  }

  return items;
}

/** Group consecutive items by `optgroup`, keeping each item's flat index. */
export function toSections(items: Item[]): Section[] {
  const sections: Section[] = [];
  items.forEach((item, index) => {
    const last = sections[sections.length - 1];
    if (last && last.label === item.group) last.entries.push({ item, index });
    else sections.push({ label: item.group, entries: [{ item, index }] });
  });
  return sections;
}

export interface SelectProps {
  value: string;
  /**
   * Receives the VALUE, not a change event.
   *
   * The native version handed back a ChangeEvent and every call site wrote
   * `event.target.value` with a cast after it. A custom listbox has no such
   * event, and synthesising a fake one would be a lie that breaks the moment
   * anyone touches `currentTarget` or calls `preventDefault`. `SubsidiaryPicker`
   * already exposed `onChange(value)`, so this makes the two consistent rather
   * than inventing a third convention.
   */
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  /** 36px trigger, for a control inside a table row. See CONTROL_SIZE in Field.tsx. */
  dense?: boolean;
  className?: string;
  id?: string;
  name?: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
  'aria-label'?: string;
}

export function Select({
  value,
  onChange,
  children,
  disabled = false,
  dense = false,
  className,
  id,
  name,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-label': ariaLabel,
}: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listboxId = `${generatedId}-listbox`;

  const items = useMemo(() => readItems(children), [children]);
  const sections = useMemo(() => toSections(items), [items]);

  /**
   * Resolved across ALL options, disabled ones included.
   *
   * ReviewPanel renders `<option value="approved" disabled={!mayApprove}>`
   * precisely because `approved` may be the CURRENT value for a user who cannot
   * set it, and its comment records what happens if the label resolution skips
   * it: "a select whose value matches no option silently displays the first one
   * instead, which would show an approved answer as 'Awaiting review'". Filter
   * disabled options out here and that bug comes straight back.
   */
  const selectedIndex = items.findIndex((item) => item.value === value);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  const [open, setOpen] = useState(false);
  const [rawActiveIndex, setActiveIndex] = useState(-1);

  /**
   * Clamped at render, deliberately not in an effect.
   *
   * The option list can SHRINK under an open panel — SubsidiaryPicker and the
   * audit user filter both fill theirs from a query that can resolve, refetch
   * or error while the menu is on screen. A caret left pointing past the end
   * makes `aria-activedescendant` name an element that is no longer in the DOM
   * (screen readers then announce the combobox as empty) and makes Enter a
   * silent no-op that leaves the panel open, because `commit` bails on
   * `!items[index]` before it ever reaches `closePanel`.
   *
   * Deriving it during render fixes both without a synchronising effect — which
   * would be a second render pass, and which the repo's lint rules reject.
   */
  const activeIndex = rawActiveIndex < items.length ? rawActiveIndex : -1;
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ query: '', at: 0 });
  /** Where a press started, so a drag can be told from a tap. */
  const press = useRef<{
    x: number;
    y: number;
    pointerId: number;
    index: number;
    pointerType: string;
  } | null>(null);
  /**
   * The last real pointer position, so hover can be told from the list moving
   * underneath a stationary pointer. See the option's onPointerMove.
   */
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  /**
   * What last moved the caret. Only the keyboard is allowed to pull the list.
   * See the scroll-into-view effect.
   */
  const caretSource = useRef<'keyboard' | 'pointer'>('keyboard');
  /** Which way the panel opened last, so the choice does not flap while scrolling. */
  const flipped = useRef(false);

  /** The next selectable index in `step` direction, skipping disabled options. */
  const nextEnabled = useCallback(
    (from: number, step: number): number => {
      let index = from;
      // Bounded by the list length, so an all-disabled list terminates rather
      // than spinning.
      for (let guard = 0; guard < items.length; guard++) {
        index += step;
        if (index < 0 || index >= items.length) break;
        if (!items[index]!.disabled) return index;
      }
      // Nothing further that way: stay put if where we are is legal.
      return from >= 0 && from < items.length && !items[from]!.disabled ? from : -1;
    },
    [items],
  );

  const firstEnabled = useCallback(() => nextEnabled(-1, 1), [nextEnabled]);
  const lastEnabled = useCallback(() => nextEnabled(items.length, -1), [nextEnabled, items.length]);

  const openPanel = useCallback(() => {
    if (disabled) return;
    // Opening onto the current value SHOULD scroll it into view.
    caretSource.current = 'keyboard';
    // Open ONTO the current value, so the first arrow steps from where the user
    // already is rather than from the top of the list.
    setActiveIndex(
      selectedIndex >= 0 && !items[selectedIndex]!.disabled ? selectedIndex : firstEnabled(),
    );
    // Each open decides its own direction. The ref exists to stop the panel
    // flapping while the page scrolls under one open panel, not to bias the
    // next one.
    flipped.current = false;
    setOpen(true);
  }, [disabled, selectedIndex, items, firstEnabled]);

  const closePanel = useCallback((returnFocus = true) => {
    setOpen(false);
    setActiveIndex(-1);
    setPosition(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item || item.disabled) return;
      if (item.value !== value) onChange(item.value);
      closePanel();
    },
    [items, value, onChange, closePanel],
  );

  /**
   * Place the panel against the trigger's viewport rect.
   *
   * ─── WHY `hasPosition` IS IN THE DEPENDENCIES ───────────────────────────────
   * The flip decision needs the panel's height, and the panel does not exist
   * until `position` is set — so the first pass measures `null`, treats the
   * height as unknown, and would never flip. Depending on `hasPosition` makes
   * the effect run a SECOND time once the panel is really in the DOM, with a
   * real `scrollHeight` to decide on. It cannot loop: `hasPosition` only ever
   * goes false → true while open, and a plain re-position does not change it.
   *
   * Without this, a dropdown near the bottom of the page opened downwards into
   * a letterbox on its FIRST open and behaved correctly on every one after —
   * which is exactly the shape of bug that survives manual QA.
   */
  const hasPosition = position !== null;

  useIsomorphicLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();

      // The trigger has scrolled out of the viewport. A panel pinned to where
      // it used to be is worse than no panel, and closing is what the native
      // control does.
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        closePanel(false);
        return;
      }

      const below = window.innerHeight - rect.bottom - PANEL_GAP - VIEWPORT_MARGIN;
      const above = rect.top - PANEL_GAP - VIEWPORT_MARGIN;
      const content = panelRef.current?.scrollHeight ?? ASSUMED_PANEL_PX;

      // Hysteresis, so the panel does not flap between up and down as the page
      // scrolls it past the threshold: once flipped it stays flipped until the
      // list genuinely fits below again.
      const flip = flipped.current
        ? below < content
        : below < Math.min(content, ASSUMED_PANEL_PX) && above > below;
      flipped.current = flip;

      // The panel is never taller than the room it has, and never shorter than
      // MIN_PANEL_PX — a floor applied to the HEIGHT alone used to push the
      // panel past the bottom of the window when neither side had room.
      const height = Math.min(content, Math.max(MIN_PANEL_PX, flip ? above : below));

      // Placed by `top` from the measured height rather than by a -100%
      // transform. That removes the second set of keyframes the transform
      // needed, and makes this final clamp possible: whatever the maths above
      // decided, the panel ends up fully on screen.
      const wanted = flip ? rect.top - PANEL_GAP - height : rect.bottom + PANEL_GAP;
      const top = Math.min(
        Math.max(VIEWPORT_MARGIN, wanted),
        Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - height),
      );

      setPosition({
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_MARGIN),
        ),
        top,
        width: rect.width,
        maxHeight: height,
      });
    };

    place();

    // Capture phase, so a scroll in ANY ancestor repositions the panel — a
    // scroll event inside a nested container never bubbles to window.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, items.length, hasPosition, closePanel]);

  /**
   * Keep the active option in view as the caret moves through a long list.
   *
   * ─── `hasPosition` IS LOAD-BEARING IN THESE DEPS ────────────────────────────
   * Without it this effect ran exactly once per open, and always too early. The
   * panel is gated on `open && position`, and `position` is null at the moment
   * `open` flips true — so on that first commit `panelRef.current` is still
   * null and the `?.` swallowed the whole thing. The panel appears on the NEXT
   * commit, but `[open, activeIndex]` are unchanged by then, so React never
   * re-ran it.
   *
   * The effect was therefore dead for the one case that matters most: opening a
   * long list onto a value near the bottom. The audit Action filter has 38
   * options over ~1,900px in a ~500px panel, so it opened scrolled to the top
   * with the selected row nowhere on screen — reading as though nothing was
   * selected — and the first ArrowDown then jumped the list ~1,800px.
   */
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    /*
     * ─── ONLY THE KEYBOARD SCROLLS THE LIST ──────────────────────────────────
     * Hovering also moves the caret, and this used to fire for that too — so
     * putting the pointer on a half-visible row at the bottom of the panel
     * made the list jump to bring that row fully into view. The content slid
     * out from under the cursor with no scroll gesture behind it, which is the
     * opposite of smooth and, worse, lands a DIFFERENT option under the mouse
     * than the one aimed at.
     *
     * Keeping the caret in view is a KEYBOARD affordance: it exists because
     * arrowing past the edge of a scroller would otherwise walk the caret
     * somewhere invisible. A pointer never has that problem — where it is IS
     * what it can see — so the wheel stays the only thing that scrolls a panel
     * the mouse is in.
     */
    if (caretSource.current !== 'keyboard') return;
    panelRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, hasPosition]);

  /**
   * Dismiss on a pointer press outside.
   *
   * `pointerdown` rather than `click`: a click fires only after mouseup, so
   * pressing another control would close this panel after that control had
   * already been actioned through the open panel.
   */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;

      // The field's own <label> is not "outside". A <button> is a labelable
      // element, so clicking the label forwards a click to the trigger — which
      // toggles. Treating the label as outside closed the panel here and the
      // forwarded click reopened it, so the label appeared to do nothing.
      const label = (target as Element).closest?.('label');
      if (label && label.getAttribute('for') === triggerId) return;

      // No focus return: the press is already moving focus elsewhere, and
      // yanking it back to the trigger would fight the user.
      //
      // The press is deliberately NOT swallowed either, so it also reaches
      // whatever is under it. That is what makes moving between the four
      // dropdowns in a filter bar one click rather than two, and it is the
      // behaviour every adjacent control here benefits from.
      closePanel(false);
    };

    /**
     * Clear a press that ended OUTSIDE the panel.
     *
     * ─── THE `contains` CHECK IS WHY CLICKING WORKS ─────────────────────────────
     * This listener is on `document` in the CAPTURE phase, so it runs on the way
     * DOWN to the target — before the option's own React `onPointerUp`. Without
     * the guard below it nulled `press.current` first, `handleOptionPointerUp`
     * then hit its `if (!started) return`, and NO MOUSE CLICK COULD EVER SELECT
     * AN OPTION. Hovering still highlighted rows, so the menu looked alive and
     * was inert — and a keyboard-only test passes straight through it.
     *
     * A release inside the panel belongs to the option handler; this one exists
     * only so that a press which began on an option and ended somewhere else
     * does not leave a stale record and swallow the next press.
     */
    const clearPress = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      press.current = null;
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', clearPress, true);
    document.addEventListener('pointercancel', clearPress, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', clearPress, true);
      document.removeEventListener('pointercancel', clearPress, true);
    };
  }, [open, closePanel, triggerId]);

  /**
   * Type-ahead. Native selects have it, people use it without knowing that they
   * do, and its absence is the most-noticed regression in a custom listbox.
   *
   * Matching is a prefix match on the rendered label, which is the same limit
   * the native select had — so `SubsidiaryPicker`'s "BCCL — Bharat Coking Coal"
   * answers to "b-c-c" but not to "bharat". Recorded rather than fixed: making
   * it a substring match would jump on a letter buried in the middle of a
   * label, which is worse than the limitation.
   */
  const runTypeahead = useCallback(
    (char: string) => {
      const now = Date.now();
      const fresh = now - typeahead.current.at > TYPEAHEAD_MS;
      const buffer = fresh ? char : typeahead.current.query + char;

      /*
       * A buffer of one letter repeated CYCLES rather than searching for "cc".
       * This is the platform behaviour and the APG's `allSameLetter` rule, and
       * without it hammering a letter to walk through same-initial options —
       * the standard native-select gesture — died on the second press. Real
       * lists here need it: the audit filter has three "Created", three
       * "Updated" and two "Retried".
       */
      const allSame = [...buffer].every((c) => c === buffer[0]);
      const needle = (allSame ? buffer[0]! : buffer).toLowerCase();

      // Search from just after the current position and wrap.
      const from = (open ? activeIndex : selectedIndex) + 1;
      const ordered = [
        ...items.slice(from).map((item, offset) => ({ item, index: from + offset })),
        ...items.slice(0, Math.max(0, from)).map((item, index) => ({ item, index })),
      ];
      const hit = ordered.find(
        ({ item }) => !item.disabled && item.label.toLowerCase().startsWith(needle),
      );

      if (!hit) {
        // Drop a buffer that matches nothing, and do NOT refresh the deadline.
        // Keeping either made every following keystroke dead too, for as long
        // as the user kept typing faster than the timeout.
        typeahead.current = { query: '', at: 0 };
        return;
      }
      typeahead.current = { query: buffer, at: now };

      if (open) {
        caretSource.current = 'keyboard';
        setActiveIndex(hit.index);
      } else if (hit.item.value !== value) onChange(hit.item.value);
    },
    [open, activeIndex, selectedIndex, items, value, onChange],
  );

  /** Move the caret by `step`, repeated `times` — one place for arrows and paging. */
  const moveActive = useCallback(
    (step: number, times = 1) => {
      caretSource.current = 'keyboard';
      setActiveIndex((current) => {
        let index = current;
        for (let n = 0; n < times; n++) index = nextEnabled(index, step);
        return index;
      });
    },
    [nextEnabled],
  );

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const { key, altKey, ctrlKey, metaKey } = event;

    // An IME in composition reports every keystroke as a dead key. Typing
    // Devanagari into a filter would otherwise fire type-ahead on each one —
    // and globals.css already carries :lang(hi)/mr/ne/sa rules, so composition
    // input is expected here rather than hypothetical.
    if (event.nativeEvent.isComposing) return;

    const printable = key.length === 1 && !ctrlKey && !metaKey;

    if (!open) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        // Alt+ArrowDown opens without moving the value — the platform idiom.
        if (altKey || key === 'Enter' || key === ' ') {
          openPanel();
          return;
        }
        // Bare arrows on a CLOSED select step the value in place, which is what
        // the platform does and what muscle memory expects in a filter bar.
        const next = nextEnabled(selectedIndex, key === 'ArrowDown' ? 1 : -1);
        if (next >= 0 && items[next]!.value !== value) onChange(items[next]!.value);
        return;
      }
      if (printable && key !== ' ') {
        event.preventDefault();
        runTypeahead(key);
      }
      return;
    }

    switch (key) {
      case 'Escape':
        event.preventDefault();
        // The trigger may one day sit inside a <dialog>, and an Escape that
        // bubbles reaches the UA's close-request — which NavDrawer and
        // ConfirmDialog route straight to onClose. One Escape would then shut
        // the menu AND the dialog behind it.
        event.stopPropagation();
        closePanel();
        return;
      case 'Tab':
        // Commit and let the Tab travel — no preventDefault, because focus must
        // still move on, exactly as a native select behaves.
        if (activeIndex >= 0) commit(activeIndex);
        else closePanel(false);
        return;
      case 'Enter':
      case ' ':
        // preventDefault matters twice here: Space would scroll the page, and
        // Enter inside a <form> submits it. Three of these live in forms.
        event.preventDefault();
        commit(activeIndex);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        return;
      case 'Home':
        event.preventDefault();
        caretSource.current = 'keyboard';
        setActiveIndex(firstEnabled());
        return;
      case 'End':
        event.preventDefault();
        caretSource.current = 'keyboard';
        setActiveIndex(lastEnabled());
        return;
      case 'PageDown':
        event.preventDefault();
        moveActive(1, PAGE_STEP);
        return;
      case 'PageUp':
        event.preventDefault();
        moveActive(-1, PAGE_STEP);
        return;
      default:
        if (printable) {
          event.preventDefault();
          runTypeahead(key);
        }
    }
  }

  /**
   * Press and release on an option.
   *
   * ─── MOUSE AND TOUCH ARE NOT THE SAME GESTURE ───────────────────────────────
   * Committing on `pointerdown` makes the panel unscrollable on a touch screen:
   * options are 44px tall inside a height-capped scroller, so almost every drag
   * STARTS on one, and a `preventDefault` there cancels the scroll as well.
   *
   * But the fix for touch is wrong for a mouse. A native select lets you press,
   * drag down through the list and release on the option you want — so for a
   * mouse the option under the RELEASE wins, and there is no movement
   * threshold, because a threshold means a slightly shaky click does nothing at
   * all. For touch and pen the opposite holds: the release must land on the
   * same row, within `TAP_SLOP_PX`, or it was a scroll.
   *
   * `preventDefault` is still right for a mouse press — it keeps focus on the
   * trigger, which `aria-activedescendant` depends on — and still wrong for
   * touch, where it kills the scroll gesture.
   */
  function handleOptionPointerDown(event: ReactPointerEvent<HTMLDivElement>, index: number) {
    // Secondary buttons must reach the context menu, not choose an option.
    if (event.button !== 0) return;
    // A second contact while one is already down is a pinch or a stray palm,
    // and must not overwrite the first finger's record.
    if (press.current && press.current.pointerId !== event.pointerId) return;
    if (event.pointerType === 'mouse') event.preventDefault();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      index,
      pointerType: event.pointerType,
    };
  }

  function handleOptionPointerUp(event: ReactPointerEvent<HTMLDivElement>, index: number) {
    const started = press.current;
    if (!started || started.pointerId !== event.pointerId) return;
    press.current = null;
    if (event.button !== 0) return;

    if (started.pointerType === 'mouse') {
      commit(index);
      return;
    }

    if (started.index !== index) return;
    if (Math.hypot(event.clientX - started.x, event.clientY - started.y) > TAP_SLOP_PX) return;
    commit(index);
  }

  /**
   * Hover moves the caret — but only on a REAL pointer movement.
   *
   * This was `onPointerEnter`, and that fires when the content moves under a
   * stationary pointer as well as when the pointer moves. Arrowing down a long
   * list scrolls the panel, a new row slides under the motionless cursor, and
   * `pointerenter` dragged the caret straight back to wherever the mouse was
   * sitting — so the keyboard could not get past whatever row the pointer
   * happened to be over. Comparing coordinates makes scroll-induced enters
   * inert, because a scroll does not change where the pointer is.
   */
  function handleOptionPointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
    index: number,
    isDisabled: boolean,
  ) {
    const last = lastPointer.current;
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (isDisabled) return;
    // Highlight the row, but do not let the effect above scroll to it.
    caretSource.current = 'pointer';
    setActiveIndex(index);
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        // A bare <button> defaults to type="submit", and three of these sit
        // inside a <form onSubmit> — opening the dropdown would send the invite.
        type="button"
        // The APG select-only combobox: the BUTTON is the combobox, and DOM
        // focus stays on it for as long as the list is open.
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        // Both are dropped entirely when closed rather than left pointing at an
        // element that is no longer rendered. A dangling aria-activedescendant
        // makes the combobox announce as empty.
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
        }
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={handleKeyDown}
        className={cn(
          TRIGGER_BASE,
          dense ? TRIGGER_SIZE.dense : TRIGGER_SIZE.comfortable,
          className,
        )}
      >
        {/*
          `truncate` with `min-w-0`, because several of these sit in a 176px
          filter column where the longest option does not fit. A native select
          ellipsises; without this the label would push the chevron out of the
          box instead.
        */}
        <span className="min-w-0 flex-1 truncate text-left">{selected ? selected.label : ''}</span>
        <ChevronDownIcon
          size={dense ? 16 : 18}
          aria-hidden
          className={cn(
            'shrink-0 text-text-muted transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>

      {/*
        A hidden mirror of the value. Nothing reads it today — every form in the
        product is controlled — but a native <select> DID contribute to its
        form, and dropping that silently is the kind of difference that surfaces
        much later as "the field just isn't being submitted".
      */}
      {name ? <input type="hidden" name={name} value={value} /> : null}

      {/*
        No `mounted` guard before `document.body`. `createPortal` would indeed
        throw during SSR — but `open` starts false and only a click or a
        keystroke sets it, so this branch is unreachable on the server and the
        extra state was a render that bought nothing.
      */}
      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              className={cn(
                // `scrollbar-none` hides the bar without disabling the scroll —
                // see the utility in globals.css.
                'fixed overflow-y-auto overscroll-contain scrollbar-none',
                // A real shadow, and it is not a departure from the "structure
                // by rules, not elevation" rule in globals.css — UX4G assigns
                // elevation to "cards, dropdowns, popovers and modals", and
                // this is literally the second of those. A panel floating over
                // the page is the one thing that genuinely IS above the page.
                'rounded-md border border-border bg-surface py-1 shadow-lg',
                'motion-safe:animate-[dropdown-in_120ms_ease-out]',
              )}
              style={{
                left: position.left,
                top: position.top,
                minWidth: position.width,
                maxHeight: position.maxHeight,
                // The token, not a raw `z-50`: globals.css owns the stacking
                // order and a literal here is invisible to it.
                zIndex: 'var(--z-overlay)',
              }}
            >
              <div role="listbox" id={listboxId} aria-labelledby={triggerId}>
                {sections.map((section) => {
                  const options = section.entries.map(({ item, index }) => {
                    const isSelected = item.value === value;
                    const isActive = index === activeIndex;

                    return (
                      <div
                        key={`${item.value}-${index}`}
                        id={`${listboxId}-option-${index}`}
                        data-index={index}
                        // Read by the forced-colors rule in globals.css, where
                        // the tint below is discarded by the browser and the
                        // active row would otherwise be unmarked.
                        data-active={isActive ? 'true' : undefined}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={item.disabled || undefined}
                        onPointerDown={(event) => handleOptionPointerDown(event, index)}
                        onPointerUp={(event) => handleOptionPointerUp(event, index)}
                        onPointerCancel={() => {
                          press.current = null;
                        }}
                        onPointerMove={(event) =>
                          handleOptionPointerMove(event, index, item.disabled)
                        }
                        className={cn(
                          // 44px — the same touch target the native popup met.
                          // `border-l-2` on every row, transparent at rest, so
                          // the active row's bar costs no layout shift.
                          'flex min-h-11 items-center gap-2.5 border-l-2 border-transparent',
                          'px-4 py-2.5 text-base',
                          item.disabled
                            ? 'cursor-not-allowed text-text-muted opacity-60'
                            : 'cursor-pointer text-text-default',
                          // The ACTIVE row — keyboard caret or hover.
                          // Deliberately NOT the native widget's hard
                          // full-bleed blue bar with white type, which was the
                          // loudest thing in the old dropdown. The tint alone
                          // is only ~1.1:1 against white though, well under the
                          // 3:1 a WCAG 1.4.11 indicator needs, so the solid
                          // blue edge is what actually carries the state.
                          isActive &&
                            !item.disabled &&
                            'border-l-sih-blue bg-sih-blue-tint text-text-strong',
                          isSelected && 'font-semibold text-text-strong',
                        )}
                      >
                        {/*
                          A tick, not colour alone. Selected and active are two
                          different states visible at the same time, and a tint
                          plus a weight cannot separate them for someone who
                          cannot see the tint.
                        */}
                        <CheckIcon
                          size={16}
                          aria-hidden
                          className={cn('shrink-0 text-sih-blue', !isSelected && 'invisible')}
                        />
                        <span className="min-w-0 flex-1">{item.label}</span>
                      </div>
                    );
                  });

                  if (!section.label) return options;

                  return (
                    /*
                      A real `role="group"` with an accessible name, not just a
                      styled caption. The one place this is used — the audit
                      action filter — has labels that are BARE VERBS: `Create`
                      appears under Documents, Users and Reports alike, because
                      the label is only the part after the dot. Without the
                      group name announced, a screen-reader user hears "Create,
                      Create, Create" and has no way to tell them apart.
                    */
                    <div key={section.label} role="group" aria-label={section.label}>
                      <p
                        aria-hidden
                        className="px-4 pt-2.5 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase"
                      >
                        {section.label}
                      </p>
                      {options}
                    </div>
                  );
                })}

                {items.length === 0 ? (
                  <p className="px-4 py-2.5 text-base text-text-muted">No options</p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The trigger's skin — deliberately the same vocabulary as `TextInput` and
 * `TextArea` in Field.tsx, because a dropdown stands beside them in every
 * filter bar, and a control that does not match its neighbours reads as a
 * different kind of thing.
 *
 * No focus styling here: globals.css sets the ring unlayered so that no
 * component can weaken it, which means anything written here would be dead CSS.
 */
const TRIGGER_BASE =
  // `rounded-md` and `focus-visible:border-sih-blue` are here to MATCH
  // CONTROL_BASE in Field.tsx, not by coincidence: a filter bar puts this
  // shoulder to shoulder with a TextInput, and a 4px difference in corner
  // radius between two adjacent boxes is visible even when nobody can say why.
  'flex w-full items-center gap-2 rounded-md border border-border-strong bg-surface ' +
  'text-base text-text-default transition-colors duration-150 motion-reduce:transition-none ' +
  'hover:border-sih-blue focus-visible:border-sih-blue aria-expanded:border-sih-blue ' +
  'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-muted disabled:text-text-muted ' +
  'aria-[invalid]:border-danger';

const TRIGGER_SIZE = {
  comfortable: 'min-h-11 px-3.5 py-2.5',
  dense: 'min-h-9 px-3 py-1.5',
} as const;
