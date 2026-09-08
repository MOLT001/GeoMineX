/**
 * The 3px tricolour rule that sits under the identity masthead.
 *
 * ─── WHY THIS IS PERMITTED WHERE THE EMBLEM IS NOT ──────────────────────────
 * §3 of the State Emblem of India (Prohibition of Improper Use) Act, 2005 bars
 * a private body from using the Lion Capital — which is why the brand mark
 * crops it out of the source artwork. The FLAG'S COLOURS carry no equivalent
 * prohibition, and a saffron/white/green rule is the standard visual signal of
 * an Indian government digital service. It is the one national reference this
 * product can legitimately make, so it is worth making well.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Two rules for it, both deliberate:
 *
 *   1. It is DECORATIVE. `aria-hidden`, no text, nothing encoded in it — so it
 *      is announced to nobody, and its contrast is not an accessibility factor.
 *   2. It appears EXACTLY ONCE per page, directly beneath the identity band.
 *      That is the convention on India.gov.in and DigiLocker; repeating it as a
 *      divider elsewhere would turn a national reference into a texture, which
 *      is both worse design and worse taste.
 *
 * Shared between the authenticated shell and the public layout so the two
 * cannot drift, and so neither has to import from the other's route file.
 */
export function Tricolour() {
  return (
    <div aria-hidden className="flex h-[3px] w-full">
      <div className="flex-1 bg-tricolour-saffron" />
      <div className="flex-1 bg-surface" />
      <div className="flex-1 bg-tricolour-green" />
    </div>
  );
}
