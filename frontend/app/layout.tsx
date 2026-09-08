import type { Metadata, Viewport } from 'next';
import { Noto_Sans } from 'next/font/google';
import { env } from '@/lib/env';
import { Providers } from './providers';
import './globals.css';

/**
 * Noto, self-hosted.
 *
 * `next/font/google` fetches the files at BUILD time and serves them from this
 * origin, which is what keeps `font-src 'self'` in the CSP intact — a Google
 * Fonts <link> would need `fonts.googleapis.com` added to style-src AND
 * `fonts.gstatic.com` to font-src, widening the policy for a typeface. It also
 * removes a third-party request from every page load, which for a government
 * system is a privacy property and not only a performance one.
 *
 * `display: 'swap'` so text is readable while the face loads; a government
 * portal should never render an invisible paragraph waiting on a font.
 */
const notoSans = Noto_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-sans',
  display: 'swap',
});

/**
 * Noto Serif is intentionally NOT loaded.
 *
 * UX4G sets its whole type system in one family and carries hierarchy in
 * weight, so the serif/sans pairing this app used to have was not the
 * government standard — it was my own inference about what reads as
 * institutional. `--font-serif` in globals.css now resolves to the Noto Sans
 * stack, so the existing `font-serif` call sites keep working and two fewer
 * font files are downloaded on every page load.
 */

/**
 * Root layout.
 *
 * The CSP nonce is NOT read or threaded through here: `app/proxy.ts` sets the
 * `content-security-policy` header on the *request*, and Next reads the nonce
 * out of it and stamps it onto its own bootstrap and hydration scripts. Doing
 * it manually would produce a second, conflicting nonce.
 */

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: {
    default: 'GeoMineX',
    template: '%s · GeoMineX',
  },
  description:
    'Evidence-locked document intelligence and reporting for CMPDI and Coal India subsidiaries. Every published figure traces back to the page it came from.',
  applicationName: 'GeoMineX',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/favicon.svg', type: 'image/svg+xml' },
      { url: '/brand/favicon.ico', sizes: '16x16 32x32 48x48' },
    ],
    apple: '/brand/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'GeoMineX',
    title: 'GeoMineX',
    description: 'Evidence-locked document intelligence and reporting for CMPDI and CIL subsidiaries.',
    images: [{ url: '/brand/og-image.png', width: 1200, height: 630, alt: 'GeoMineX' }],
  },
  /**
   * §1.4 makes this an internal, authorised-user system — only Home, About,
   * Contact and Privacy are public. Nothing here should be indexed.
   */
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0B1F3A',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Opt the whole tree into dynamic rendering. This is the price of a real CSP,
 * and it is not optional — verified against a running build:
 *
 * A statically prerendered page is generated once, with no request in scope, so
 * Next cannot stamp a nonce on its scripts. `proxy.ts` still sends a fresh
 * per-request `nonce-…`, and because `'strict-dynamic'` makes CSP3 browsers
 * ignore the `'self'` source expression, every `<script src="/_next/static/…">`
 * and both inline bootstrap scripts end up unnonced and therefore blocked. The
 * page renders as inert HTML with no hydration — intermittently, depending on
 * what is cached, which is the worst failure shape available.
 *
 * Rendering dynamically lets Next read the nonce out of the request's CSP
 * header and apply it. The cost is losing static generation on the four public
 * pages; the authenticated app is client-rendered by constraint anyway (§11.10),
 * so nothing is lost there.
 *
 * For the same reason, do NOT enable `cacheComponents`/PPR: a prerendered shell
 * carrying a stale nonce reintroduces exactly this bug.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={notoSans.variable}>
      <body className="min-h-dvh bg-canvas text-text-default antialiased">
        {/*
          First focusable element on every page, and invisible until it has
          focus. The headers in this product carry up to eight navigation links
          across two bands; without this a keyboard user tabs through all of
          them on every page load before reaching anything they came for.

          It targets `#main-content`, which each route group's layout puts on
          its own <main>.
        */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
