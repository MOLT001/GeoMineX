/**
 * Join class names, dropping falsy entries.
 *
 * Deliberately not `clsx` + `tailwind-merge`. Neither earns a dependency here:
 * the components in `components/ui` own their own base classes and expose a
 * `className` prop that is appended last, and Tailwind's later-wins ordering in
 * the generated stylesheet is not what resolves a conflict — source order in
 * the class attribute is irrelevant to CSS. Where a caller genuinely needs to
 * override a base class, the component takes a variant prop instead. That keeps
 * the override surface explicit and reviewable rather than accidental.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
