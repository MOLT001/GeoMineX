import { z } from 'zod';

/**
 * The one place this codebase reads `process.env` — PRD §7.1, §10.5.
 *
 * Two rules that look like style and are not:
 *
 *   1. `NEXT_PUBLIC_` is a DISCLOSURE BOUNDARY, not a naming convention.
 *      Anything carrying it is inlined into the client bundle at build time and
 *      is readable by anyone who loads a page. No OCR key, AI key, storage
 *      credential, JWT secret or database URI may ever carry the prefix (§9.10).
 *      The frontend needs exactly one variable, and that is not an accident —
 *      every secret this product holds belongs to the backend.
 *
 *   2. Validation happens at BUILD time, so a misconfigured deployment fails
 *      the build instead of the user's first page load. Next inlines these at
 *      compile time, so this module is evaluated during the build and a bad
 *      value stops it there.
 *
 * `process.env.NEXT_PUBLIC_*` must be written out in full rather than accessed
 * dynamically: Next performs a literal text substitution, so `process.env[key]`
 * silently yields `undefined` in the browser.
 */
const envSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.url('must be a valid absolute URL, e.g. http://localhost:5000'),
  /**
   * This app's own public origin. Needed only to resolve absolute URLs in
   * metadata — the Open Graph image, and canonical links. Without it Next warns
   * at build time and falls back to `http://localhost:3000`, which would ship a
   * link preview pointing at the developer's own machine.
   *
   * Public by nature: it is the address users type. It is not a second API URL,
   * and nothing should fetch from it.
   */
  NEXT_PUBLIC_SITE_URL: z.url('must be a valid absolute URL, e.g. http://localhost:3000'),
});

const parsed = envSchema.safeParse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});

if (!parsed.success) {
  // Matches the backend's fail-fast pattern in config/env.ts: flatten, report
  // every field at once, and refuse to continue with partial configuration.
  const fields = z.flattenError(parsed.error).fieldErrors;
  console.error('Invalid frontend environment variables:', fields);
  throw new Error(
    'Invalid frontend environment. See frontend/.env.example for the required variables.',
  );
}

export const env = parsed.data;

/**
 * Where authenticated API calls actually go.
 *
 * Deliberately a RELATIVE path, not `env.NEXT_PUBLIC_API_BASE_URL`. §11.9
 * resolved to a same-site topology, so the browser must address the API through
 * the Next rewrite on its own origin — that is what keeps the `SameSite=Strict`
 * refresh cookie attached and lets the CSP hold `connect-src 'self'`.
 *
 * The absolute origin above is consumed by `next.config.ts` on the server, to
 * decide where the rewrite forwards to. Client code should not use it; calling
 * the API cross-origin would drop the cookie and break sign-in.
 */
export const API_PREFIX = '/api/v1';

/**
 * Build mode. Lives here because §7.1 makes this module the only one permitted
 * to read `process.env`, and NODE_ENV is inlined by the bundler at build time
 * rather than being part of the runtime environment contract above.
 */
export const IS_DEV = process.env.NODE_ENV !== 'production';
