/**
 * The GeoMineX wordmark — PRD §6.
 *
 * Rendered as HTML text rather than SVG paths, on purpose:
 *
 *   - it is selectable, searchable and read correctly by screen readers;
 *   - it reflows and scales with the surrounding type;
 *   - it costs nothing to ship, where outlined paths would.
 *
 * The base letters inherit `currentColor` — that is the whole knockout story.
 * §6 puts Primary Dark Blue behind the header and Admin Panel chrome, and a
 * navy wordmark on a navy ground is invisible; inheriting means one component
 * serves both grounds and no one has to remember to swap an asset.
 *
 * The trailing X keeps its own accent, and it has to change between grounds:
 * SIH Blue (#1261A0) is a 5.9:1 contrast on white but only 1.6:1 on the §6
 * navy, which would fail outright. The knockout variant lifts it to a light
 * blue that clears AA on navy.
 */
export function Wordmark({
  variant = 'default',
  className,
}: {
  /** `knockout` for placement on Primary Dark Blue chrome. */
  variant?: 'default' | 'knockout';
  className?: string;
}) {
  return (
    <span
      className={`font-serif font-semibold tracking-tight whitespace-nowrap ${className ?? ''}`}
    >
      GeoMine
      <span className={variant === 'knockout' ? 'text-[#7FB2E5]' : 'text-sih-blue'}>X</span>
    </span>
  );
}
