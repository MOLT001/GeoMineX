/**
 * Return-to-route handling for sign-in — PRD §5.2 requires that an interrupted
 * user lands back where they were headed, not always on the dashboard.
 *
 * The destination arrives as a `?next=` query parameter, which means it is
 * attacker-controllable: anyone can send a victim a link to
 * `/login?next=https://evil.example`, and a naive implementation redirects
 * there after a successful sign-in. That is an open redirect, and it is
 * especially useful to a phisher precisely because the hop starts on the real,
 * trusted origin.
 *
 * So `next` is validated as a same-origin PATH, and never parsed as a URL.
 */

const BLOCKED_PREFIXES = ['/login', '/invite'];

/**
 * Reject control characters without writing any into this file.
 *
 * A regex literal containing raw control bytes makes git treat the source as
 * binary — no diffs, no blame — so the check is done by code point instead.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function sanitizeNext(next: string | null | undefined): string | null {
  if (!next) return null;

  // The value has already been decoded once by URLSearchParams. Decode again
  // defensively so `%2f%2fevil.example` cannot slip past the checks below, and
  // treat a malformed sequence as hostile.
  let candidate = next;
  try {
    candidate = decodeURIComponent(next);
  } catch {
    return null;
  }

  // Must be a path on this origin.
  if (!candidate.startsWith('/')) return null;

  // `//evil.example` and `/\evil.example` are protocol-relative URLs: the
  // browser reads them as another host, so they are open redirects wearing a
  // path's clothing.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return null;

  // A scheme anywhere means it was never a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;

  // Newlines and control characters can split headers or confuse parsers.
  if (hasControlChars(candidate)) return null;

  // Bouncing back to the auth routes would loop, or re-consume a spent invite.
  //
  // Compare the PATH only. Matching against the whole string lets
  // `/login?next=/x` through — it starts with neither `/login` exactly nor
  // `/login/` — and signing in then redirects straight back to the login page.
  const path = candidate.split(/[?#]/)[0] ?? candidate;
  if (BLOCKED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return null;

  return candidate;
}

/** Build the login URL that remembers where the user was going. */
export function loginUrlFor(pathname: string, search: string): string {
  const target = `${pathname}${search}`;
  const safe = sanitizeNext(target);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : '/login';
}
