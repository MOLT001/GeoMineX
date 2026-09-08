import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * PRD §11.9 resolved to a SAME-SITE topology, and this file is what implements
 * it: the browser talks only to the Next origin, and `/api/v1/*` is proxied
 * through to Express. That is what keeps the refresh cookie `SameSite=Strict`
 * and lets the CSP in `app/proxy.ts` keep `connect-src 'self'`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DO NOT CHANGE THE `source` PREFIX. It is coupled to a backend constant.
 *
 * `backend/src/config/env.ts` sets the refresh cookie with `path: '/api/v1/auth'`.
 * Cookie path matching (RFC 6265 §5.1.4) is a prefix test on the URL the BROWSER
 * sees — which, behind a rewrite, is the `source`, not the `destination`. So the
 * source must begin `/api/v1/` for the cookie to be sent at all.
 *
 * Rewrite it to `/api/:path*` or `/backend/:path*` and the browser-visible path
 * stops matching the cookie's Path. The cookie is then silently never attached,
 * `POST /api/v1/auth/refresh` sees no credential, every user is logged out on
 * every reload, and nothing anywhere logs an error. It reads like a backend bug
 * for a day. There is a Playwright assertion on the cookie's `path` guarding
 * this; if it fails, look here first.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const API_ORIGIN = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:5000';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Pin Turbopack's workspace root to THIS directory.
   *
   * The repo holds three independent packages — root, `backend/` and
   * `frontend/` — each with its own `package-lock.json`, installed via
   * `npm --prefix`. It is deliberately NOT an npm workspaces setup.
   *
   * Turbopack infers a root by walking up for a lockfile, finds the one at the
   * repo root (which exists only to hold `concurrently` for the combined
   * `npm run dev` script), and concludes the whole repo is this app's
   * workspace. That is wrong, and it is not merely cosmetic: the inferred root
   * decides which files are watched and how modules resolve, so a wrong guess
   * can mean stale rebuilds and confusing resolution errors.
   *
   * Naming it here is the fix Next itself recommends, and it keeps working if
   * a fourth lockfile ever appears above us.
   */
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },

  // Fail the production build on type errors rather than shipping them. Stated
  // explicitly so a future edit cannot quietly flip it to `true` to "unblock"
  // a deploy.
  //
  // Next 16 removed `next lint` and no longer runs ESLint during `next build`,
  // so there is no `eslint` key here any more. Linting is therefore CI's job
  // alone — `npm run lint` in the frontend workflow job is the only thing
  // standing between a lint error and main.
  typescript: { ignoreBuildErrors: false },

  // Do not send the framework's version to every client.
  poweredByHeader: false,

  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${API_ORIGIN}/api/v1/:path*`,
      },
    ];
  },

  async headers() {
    // Content-Security-Policy is deliberately NOT set here — it needs a
    // per-request nonce and therefore lives in `app/proxy.ts`. These are the
    // headers that are genuinely static.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
