import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Cascade-layer guards for `globals.css`.
 *
 * Tailwind v4 puts every utility in `@layer utilities`, and unlayered CSS beats
 * ANY layered rule regardless of specificity. That makes "is this block in a
 * layer?" a load-bearing decision rather than a formatting one, and it is
 * invisible in review: a base rule that wrongly outranks `text-white` renders as
 * navy-on-navy, which looks like a missing heading rather than like a CSS bug.
 * It shipped exactly that way once — the login panel, the invite panel and the
 * public footer all had unreadable headings.
 *
 * These assert the source text because the failure is a property of the
 * stylesheet, not of any component: no render test would catch a revert here
 * without a real browser and a screenshot to compare against.
 */
const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');

/** The body of `@layer <name> { … }`, or null when there is no such block. */
function layerBody(name: string): string | null {
  const start = css.indexOf(`@layer ${name} {`);
  if (start === -1) return null;
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return null;
}

describe('globals.css cascade layers', () => {
  it('puts the heading defaults in @layer base so a utility can override them', () => {
    const base = layerBody('base');
    expect(base, 'globals.css has no @layer base block').not.toBeNull();
    // The `color` declaration is the one that bit: outside a layer it defeated
    // `text-white` on every heading sitting on the §6 navy.
    expect(base).toMatch(/h1,\s*h2,\s*h3\s*\{[^}]*color:/);
  });

  it('keeps :focus-visible unlayered so no component can weaken it', () => {
    // The inverse rule, and equally deliberate: the two-tone ring is an
    // accessibility floor (WCAG 2.4.11), so it must outrank `outline-none`.
    const base = layerBody('base');
    expect(base ?? '').not.toContain(':focus-visible');
    expect(css).toMatch(/^:focus-visible \{/m);
  });
});
