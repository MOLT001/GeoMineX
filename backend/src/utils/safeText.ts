/**
 * Zod helper for user-supplied text — PRD §9.2, §9.5.
 *
 * `normaliseUntrusted` was already applied to DOCUMENT text on the retrieval
 * path, but nothing applied it to REQUEST BODIES. The result was that a name
 * submitted as "A\u0000B" was stored with the null byte intact, while the same
 * bytes arriving inside a PDF were stripped. Same threat, two different
 * answers, and the weaker one guarding the easier input to control.
 *
 * Why it matters for a field as dull as a user's name:
 *
 *   - a NUL truncates the string in anything C-backed downstream — CSV export,
 *     PDF generation, a log shipper — so "Admin\u0000ignore" can display as
 *     "Admin" in one place and something else in another;
 *   - bidi overrides (U+202E) visually reverse the text after them, the classic
 *     way to make `report-fdp.exe` render as `report-exe.pdf`;
 *   - zero-width characters defeat exact-match comparisons, which matters
 *     because §8.3's destructive actions are gated on typed confirmation.
 *
 * Normalisation runs BEFORE the length checks, so a value that is only
 * invisibles collapses to empty and fails `min(1)` rather than being stored as
 * a blank name. That ordering is the same lesson as the email trim fix: a
 * transform placed after validation cannot rescue input the validator already
 * rejected, and one placed before it must not smuggle empties through.
 */
import { z } from 'zod';
import { normalisedText } from './unicodeNormalize.js';

export interface SafeTextOptions {
  min?: number;
  max: number;
  /** Field name used in the error message. */
  label?: string;
}

/**
 * NFKC-normalise, strip invisibles and control characters, trim, then enforce
 * length. Legitimate scripts are unaffected — Devanagari, Arabic and emoji all
 * survive; only characters with no visible representation are removed.
 */
export function safeText({ min = 1, max, label }: SafeTextOptions) {
  const noun = label ? `${label} ` : '';
  return z
    .string({ error: `${noun}must be text` })
    .transform((raw) => normalisedText(raw).trim())
    .pipe(
      z
        .string()
        .min(min, `${noun}must be at least ${min} character${min === 1 ? '' : 's'} after removing invisible characters`)
        .max(max, `${noun}must be at most ${max} characters`),
    );
}

/** Optional variant — absent stays absent, present is normalised. */
export function safeTextOptional(opts: SafeTextOptions) {
  return safeText(opts).optional();
}
