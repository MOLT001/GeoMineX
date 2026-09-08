import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from '@/lib/csp';

/**
 * Next 16 renamed `middleware.ts` to `proxy.ts` and moved it to the Node
 * runtime. Its job here is exactly one thing: mint a per-request CSP nonce and
 * attach the security policy to rendered documents.
 *
 * LOCATION MATTERS AND IS EASY TO GET WRONG. Next resolves this convention at
 * the project root or `src/proxy` only — see `isMiddlewareFile` in
 * next/dist/build/utils.js. Placed inside `app/` it is silently ignored: no
 * warning, no error, and every page simply ships without a CSP. Several guides
 * claim it belongs in `app/`; they are wrong.
 *
 * ─── THIS FILE MUST NEVER DO AUTHENTICATION ─────────────────────────────────
 * Two independent reasons, and the second is the stronger one:
 *
 *   1. The Next team scopes proxy.ts to routing — rewrites, redirects, headers.
 *   2. It is physically blind to our session. The refresh cookie is scoped
 *      `Path=/api/v1/auth` (backend/src/config/env.ts), so the browser does not
 *      send it to `/dashboard`, and the access token lives in memory in the
 *      browser tab where no server can read it. This code has zero evidence a
 *      session exists.
 *
 * Route protection is client-side, in the `(app)` route-group layout. See
 * PRD §11.10.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function proxy(request: NextRequest): NextResponse {
  // A nonce must be unpredictable per response, or it is decorative.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development');

  // Pass the nonce inward so the document can stamp it onto its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  /**
   * Static assets and image optimisation output are not documents and carry no
   * inline scripts, so a nonce buys nothing there — and running this on every
   * asset request would force needless work. `favicon.ico` and the brand
   * folder are excluded for the same reason.
   */
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|brand/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
