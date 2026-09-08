'use client';

import { useId } from 'react';

/**
 * The GeoMineX badge — PRD §6.
 *
 * Rebuilt as vector from the supplied reference raster, which could not be
 * shipped: it was a JPEG carrying the State Emblem of India (which private
 * bodies may not use — State Emblem of India (Prohibition of Improper Use)
 * Act, 2005 §3) and had a transparency checkerboard baked into its pixels, so
 * it rendered a grey chequered square on any coloured ground.
 *
 * Two deliberate constraints:
 *
 *   - **No `<style>` element, presentation attributes only.** An SVG carrying
 *     inline CSS would need the per-request nonce from `app/proxy.ts`; without
 *     it the browser drops the styles and the logo renders unstyled, silently.
 *   - **Client component, for `useId`.** The strata overflow the disc and are
 *     clipped to it, and a hardcoded clipPath id would collide the moment two
 *     marks appear on one page — the second instance would clip against the
 *     first. `useId` gives SSR-stable unique ids.
 *
 * Legible down to roughly 48px. Below that use `favicon.svg`, which is a
 * separate, simplified drawing rather than this artwork scaled down.
 */
export function Mark({
  size = 40,
  title = 'GeoMineX',
  decorative = false,
  className,
}: {
  size?: number | string;
  /** Accessible name. Ignored when `decorative`. */
  title?: string;
  /** Set when the visible word "GeoMineX" sits alongside, to avoid announcing it twice. */
  decorative?: boolean;
  className?: string;
}) {
  const clipId = `${useId()}-disc`;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="50" cy="50" r="41" />
        </clipPath>
      </defs>

      {/* Tricolour ring. Left arc saffron, right arc green, open at top and
          bottom — the legitimate national reference, unlike the emblem. */}
      <path
        d="M 42.01 4.70 A 46 46 0 0 0 42.01 95.30"
        fill="none"
        stroke="#F58220"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      <path
        d="M 57.99 4.70 A 46 46 0 0 1 57.99 95.30"
        fill="none"
        stroke="#1E7A3C"
        strokeWidth="4.2"
        strokeLinecap="round"
      />

      <g clipPath={`url(#${clipId})`}>
        {/* Opaque disc: this is what lets the mark sit on the §6 navy header
            without the artwork muddying into the background. */}
        <circle cx="50" cy="50" r="41" fill="#FFFFFF" />

        {/* Geospatial globe */}
        <g fill="none" stroke="#1E88E5" strokeWidth="1.3">
          <circle cx="32" cy="28" r="12.5" />
          <ellipse cx="32" cy="28" rx="12.5" ry="4.8" strokeWidth="1.1" />
          <ellipse cx="32" cy="28" rx="4.8" ry="12.5" strokeWidth="1.1" />
          <path d="M 19.5 28 H 44.5" strokeWidth="1.1" />
        </g>

        {/* Survey satellite and downlink */}
        <g fill="#0B1F3A" transform="rotate(-28 72 24)">
          <rect x="68.5" y="21" width="7" height="6" rx="1.2" />
          <rect x="59" y="22.6" width="8.5" height="2.8" rx="0.6" />
          <rect x="76.5" y="22.6" width="8.5" height="2.8" rx="0.6" />
          <rect x="71.4" y="16.6" width="1.2" height="4.4" />
        </g>
        <g fill="none" stroke="#0B1F3A" strokeWidth="1.5" strokeLinecap="round">
          <path d="M 63.6 33.4 A 4.6 4.6 0 0 1 67.6 29.4" />
          <path d="M 61 35.8 A 8.2 8.2 0 0 1 68.2 28.6" />
        </g>

        {/* Range */}
        <path d="M 10 68 L 28 38 L 38 50 L 50 27 L 61 45 L 69 36 L 86 68 Z" fill="#0B1F3A" />
        <path d="M 50 27 L 55.5 35.5 L 50 33 L 44.5 39 Z" fill="#2A4E7E" />
        <path d="M 28 38 L 32 44 L 28 42.5 L 24.5 47 Z" fill="#2A4E7E" />

        {/* Geological strata. Sized to finish inside the r=41 disc (which
            bottoms out at y=91) so all four bands survive the clip. */}
        <path d="M 2 65 Q 26 60.5 50 63.5 T 98 61.5 L 98 71 Q 74 68 50 71 T 2 73 Z" fill="#6B3E20" />
        <path d="M 2 73 Q 26 68.5 50 71 T 98 69 L 98 78 Q 74 75 50 78 T 2 80 Z" fill="#96612C" />
        <path d="M 2 80 Q 26 76 50 78 T 98 76 L 98 85 Q 74 82 50 85 T 2 87 Z" fill="#C9862F" />
        <path d="M 2 87 Q 26 83 50 85 T 98 83 L 98 96 L 2 96 Z" fill="#E3A63C" />

        {/* Haul truck: tall dump bed against a short cab, so the silhouette
            reads as mining plant and not a car. The white halo is drawn under
            the fill (paint-order) to lift it off the navy range behind. */}
        <g
          fill="#0B1F3A"
          stroke="#FFFFFF"
          strokeWidth="1.3"
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          <path d="M 63 58 L 65 49 L 77 49 L 78.5 58 Z" />
          <path d="M 78.5 58 L 78.5 53 L 82 53 L 83.5 58 Z" />
          <rect x="62.5" y="57.6" width="21.5" height="1.8" rx="0.9" />
          <circle cx="68" cy="61.6" r="2.7" />
          <circle cx="79.5" cy="61.6" r="2.7" />
        </g>
      </g>
    </svg>
  );
}
