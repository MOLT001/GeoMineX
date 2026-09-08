/**
 * Scheme validation for URLs that did not originate in this codebase — PRD §9.13.
 *
 * Two sources feed URLs into this UI that a developer never reviewed: text
 * extracted from third-party PDFs, and text produced by a language model. A
 * `javascript:` URL in either is a script-execution path, and it is one an
 * HTML-tag allowlist does not close — sanitisers filter tags and attributes,
 * not the contents of an `href` the application itself decided to render.
 *
 * `data:` is refused alongside it. `data:text/html,...` navigates to attacker
 * controlled markup in this origin, which is the same capability by a different
 * spelling.
 *
 * Note this applies only to DERIVED urls. Internal `<Link href="/documents">`
 * targets are literals in the source and need no check.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns the URL if it is safe to place in an `href`/`src`, otherwise null.
 *
 * Callers must handle null by rendering the text INERT — as a plain text node,
 * never as a link with a neutered target. A link that looks clickable and does
 * nothing trains people to click it.
 */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  /**
   * Parsed with NO base, which is the whole check: a URL that cannot stand on
   * its own throws, and everything that survives has declared its own scheme.
   *
   * Supplying a base instead — the obvious first instinct — quietly defeats
   * this. `new URL('//evil.example/x', 'https://placeholder')` does not throw;
   * it inherits the base's scheme and yields `https://evil.example/x`, a
   * perfectly valid absolute URL on someone else's host. Any origin check
   * against the placeholder then passes it through. Requiring the input to
   * carry its own scheme rejects `//host`, `/path` and `../path` alike, which
   * is what a value arriving from an extracted PDF or a model deserves.
   */
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) return null;

  return parsed.toString();
}

/** True when the URL points somewhere other than this app. */
export function isExternal(url: string): boolean {
  try {
    return new URL(url).origin !== window.location.origin;
  } catch {
    return false;
  }
}
