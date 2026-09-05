/**
 * Unicode normalisation for untrusted document text — PRD §9.5.
 *
 * WHY THIS EXISTS: a regex-based injection scanner and a delimiter escaper are
 * both defeated by characters the human eye cannot see. "i\u200Bgnore previous
 * instructions" matches no pattern; "<\u200B<<" is not a fence to a matcher but
 * reads as one to a model that strips it. Normalising BEFORE matching closes both.
 *
 * The count of stripped invisibles is returned rather than discarded: a
 * document with a high density of them is itself a signal (see injection.ts's
 * `obfuscation` rule). Deliberate obfuscation is evidence, not noise.
 */

/** Zero-width, word-joiner and BOM. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
/** Bidi overrides and isolates — used to visually reorder an injected payload. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
/** C0/C1 control characters, keeping \t \n \r. */
// eslint-disable-next-line no-control-regex -- deliberately stripping control characters
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface NormalisedText {
  text: string;
  /** How many invisible characters were removed. Feeds the obfuscation signal. */
  strippedCount: number;
}

/**
 * NFKC-normalise and strip invisibles.
 *
 * NFKC folds compatibility forms, so a fullwidth "ｉｇｎｏｒｅ" becomes "ignore"
 * and becomes matchable by an ASCII pattern.
 */
export function normaliseUntrusted(raw: string): NormalisedText {
  const nfkc = raw.normalize('NFKC');
  let stripped = 0;
  for (const re of [ZERO_WIDTH, BIDI, CONTROL]) {
    stripped += (nfkc.match(re) ?? []).length;
  }
  const text = nfkc.replace(ZERO_WIDTH, '').replace(BIDI, '').replace(CONTROL, '');
  return { text, strippedCount: stripped };
}

/** Convenience for call sites that do not need the obfuscation signal. */
export function normalisedText(raw: string): string {
  return normaliseUntrusted(raw).text;
}
