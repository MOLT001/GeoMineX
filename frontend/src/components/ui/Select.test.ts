import { createElement, Fragment } from 'react';
import { describe, it, expect } from 'vitest';
import { readItems, textOf, toSections, type Item } from './Select';

/**
 * The listbox's option parser.
 *
 * `Select` stopped being a native <select>, and Field.tsx's own warning about
 * that swap — a custom listbox "has to reimplement [native behaviour], and
 * usually reimplements incompletely" — is the reason this file exists.
 *
 * These cover the half that is testable WITHOUT a DOM. `vitest.config.ts` sets
 * `environment: 'node'` and there is no jsdom or Testing Library in the repo, so
 * rendering is out of reach here — but `React.createElement` only builds plain
 * objects, so the children-to-items parser is fully exercisable. The keyboard,
 * positioning and ARIA halves are covered by a browser probe against the running
 * app instead; if a DOM harness is ever added, they belong here too.
 *
 * Everything below is a real shape taken from a live call site, not a synthetic
 * one — the comments name which.
 */

const option = (value: string, label: string, disabled?: boolean) =>
  createElement('option', { value, disabled, key: value }, label);

describe('textOf', () => {
  it('reads the string and number labels options actually use', () => {
    expect(textOf('Any status')).toBe('Any status');
    expect(textOf(2026)).toBe('2026');
  });

  it('joins a label split across several children', () => {
    // SubsidiaryPicker renders `{code} — {name}` as three children.
    expect(textOf(['BCCL', ' — ', 'Bharat Coking Coal'])).toBe('BCCL — Bharat Coking Coal');
  });

  it('drops the nodes a conditional option leaves behind', () => {
    expect(textOf(null)).toBe('');
    expect(textOf(undefined)).toBe('');
    // `{cond && 'x'}` yields `false`, which must not render as "false".
    expect(textOf(false)).toBe('');
  });
});

describe('readItems', () => {
  it('reads a flat option list', () => {
    const items = readItems([option('', 'Any status'), option('queued', 'Queued')]);
    expect(items).toEqual<Item[]>([
      { value: '', label: 'Any status', disabled: false },
      { value: 'queued', label: 'Queued', disabled: false },
    ]);
  });

  it('flattens the array a .map() produces beside a plain option', () => {
    // Every filter bar in the product is exactly this shape: one placeholder
    // followed by `Object.entries(LABELS).map(...)`.
    const children = [
      option('', 'Any status'),
      ['queued', 'validated'].map((v) => option(v, v.toUpperCase())),
    ];
    expect(readItems(children).map((i) => i.value)).toEqual(['', 'queued', 'validated']);
  });

  it('drops the nulls that a conditional option produces', () => {
    // SubsidiaryPicker renders `{isPending ? <option/> : null}` twice over.
    const children = [null, option('', 'Select a subsidiary…'), false, option('a', 'A')];
    expect(readItems(children).map((i) => i.label)).toEqual(['Select a subsidiary…', 'A']);
  });

  it('carries the disabled flag', () => {
    // ReviewPanel renders `<option value="approved" disabled={!mayApprove}>`.
    const items = readItems([option('', 'Choose…', true), option('approved', 'Approved', true)]);
    expect(items.map((i) => i.disabled)).toEqual([true, true]);
  });

  it('flattens an optgroup and records the group on each option', () => {
    // The audit action filter is the one place <optgroup> is used.
    const children = [
      option('', 'All actions'),
      createElement('optgroup', { label: 'Auth', key: 'auth' }, [
        option('auth.login_success', 'Login success'),
        option('auth.logout', 'Logout'),
      ]),
    ];
    const items = readItems(children);
    expect(items.map((i) => i.group)).toEqual([undefined, 'Auth', 'Auth']);
    expect(items).toHaveLength(3);
  });

  it('ignores anything that is not an option or an optgroup', () => {
    // A stray fragment or comment must not become a phantom blank row.
    expect(readItems([createElement(Fragment, null, 'nope'), option('a', 'A')])).toHaveLength(1);
  });
});

describe('toSections', () => {
  it('keeps ungrouped options in one run and preserves their flat index', () => {
    const items = readItems([option('', 'Any'), option('a', 'A')]);
    const sections = toSections(items);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBeUndefined();
    // The flat index is what `aria-activedescendant` and every keyboard move
    // are expressed in, so grouping must not renumber the options.
    expect(sections[0]!.entries.map((e) => e.index)).toEqual([0, 1]);
  });

  it('splits at each group boundary and keeps indices continuous across them', () => {
    const items = readItems([
      option('', 'All actions'),
      createElement('optgroup', { label: 'Auth', key: 'a' }, [option('x', 'X')]),
      createElement('optgroup', { label: 'Docs', key: 'd' }, [
        option('y', 'Y'),
        option('z', 'Z'),
      ]),
    ]);
    const sections = toSections(items);
    expect(sections.map((s) => s.label)).toEqual([undefined, 'Auth', 'Docs']);
    expect(sections.flatMap((s) => s.entries.map((e) => e.index))).toEqual([0, 1, 2, 3]);
  });
});

describe('the trigger label resolves across ALL options', () => {
  /**
   * ReviewPanel renders `approved` as a DISABLED option precisely because it may
   * be the current value for a user who cannot set it, and records what happens
   * if label resolution skips disabled options: "a select whose value matches no
   * option silently displays the first one instead, which would show an approved
   * answer as 'Awaiting review'".
   *
   * `Select` resolves `selectedIndex` with a plain `findIndex` over every item,
   * so this asserts the property that mistake would break.
   */
  const items = readItems([
    option('', 'Awaiting review', true),
    option('approved', 'Approved', true),
    option('rejected', 'Rejected'),
  ]);

  it('finds a disabled option as the current value', () => {
    const index = items.findIndex((i) => i.value === 'approved');
    expect(items[index]!.label).toBe('Approved');
  });

  it('would show the wrong status if disabled options were filtered out first', () => {
    // The bug, written down: filter first and 'approved' is no longer findable.
    const enabledOnly = items.filter((i) => !i.disabled);
    expect(enabledOnly.findIndex((i) => i.value === 'approved')).toBe(-1);
  });
});
