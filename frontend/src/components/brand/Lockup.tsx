import { Mark } from './Mark';
import { Wordmark } from './Wordmark';

const TAGLINE = 'Smarter Geoscience · Stronger Mining';

/**
 * Horizontal lockup — mark left, wordmark right.
 *
 * For the public nav and the authenticated app header. The mark is marked
 * decorative because the word "GeoMineX" is right beside it; announcing both
 * makes a screen reader say the name twice.
 */
export function LockupHorizontal({
  markSize = 34,
  variant = 'default',
  className,
}: {
  markSize?: number;
  variant?: 'default' | 'knockout';
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <Mark size={markSize} decorative />
      <Wordmark variant={variant} className="text-[1.35rem] leading-none" />
    </span>
  );
}

/**
 * Vertical lockup — mark over wordmark over tagline.
 *
 * For the login and invite-accept screens and the public hero, where the brand
 * is the subject rather than the chrome.
 *
 * The tagline is dropped below roughly 120px of width because it becomes
 * unreadable rather than merely small; `showTagline={false}` is the explicit
 * way to do that, in preference to scaling it down until it is noise.
 */
export function LockupVertical({
  markSize = 96,
  variant = 'default',
  showTagline = true,
  className,
}: {
  markSize?: number;
  variant?: 'default' | 'knockout';
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex flex-col items-center gap-3 ${className ?? ''}`}>
      <Mark size={markSize} decorative />
      <Wordmark variant={variant} className="text-[2rem] leading-none" />
      {showTagline ? (
        <span
          className={`text-xs tracking-wide ${
            variant === 'knockout' ? 'text-white/70' : 'text-text-muted'
          }`}
        >
          {TAGLINE}
        </span>
      ) : null}
    </span>
  );
}
