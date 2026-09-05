/**
 * The three §4.6 metric definitions, as PURE FUNCTIONS.
 *
 * Extracted so the §5.3 landing-page card and the §4.6 analytics chart cannot
 * report different accuracy for the same period. dashboard.service.ts imports
 * these; restating the definitions in two header comments is exactly how the
 * two surfaces drift.
 *
 * The definitions themselves are lifted verbatim from dashboard.service.ts,
 * including the rules that make them honest:
 *
 *   Extraction Accuracy % = fields never manually overridden / total fields.
 *     An override is the operator saying the extraction was wrong, so it is
 *     the only ground truth available without a separate labelling exercise.
 *
 *   Automation Coverage % = validated documents needing no manual correction
 *     and not flagged for review / all validated documents.
 *
 *   Time Saved % = baseline manual effort minus estimated actual human effort,
 *     over baseline. Both constants are ASSUMPTIONS from env, not measurements.
 */
import { env } from '../../config/env.js';

/**
 * One decimal place, applied at the very end of every formula.
 *
 * Rounding once at the boundary — never on an intermediate — keeps the snapshot
 * and the series agreeing on the same period to the digit that is actually
 * rendered.
 */
export const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * `null` when there is no evidence either way.
 *
 * dashboard.service.ts reports 0 for a SNAPSHOT, where visible counts alongside
 * make a 0 unambiguous. In a SERIES a plotted 0% for an empty bucket is a
 * fabricated figure, so the series path passes the null through and the
 * dashboard path coerces `?? 0` at its own call site. See D13.
 */
export function extractionAccuracyPercent(totalFields: number, overriddenFields: number): number | null {
  if (totalFields === 0) return null;
  return round1(((totalFields - overriddenFields) / totalFields) * 100);
}

/**
 * §4.6 Automation Coverage %.
 *
 * `Math.max(0, …)` is applied AFTER rounding, matching dashboard.service.ts:
 * a document can be both corrected and awaiting review, so the numerator can go
 * negative and a negative "coverage" is not a statement anyone can act on.
 *
 * Returns `null` — not 0 — when nothing has been validated yet; see D13.
 */
export function automationCoveragePercent(
  validated: number,
  correctedDocuments: number,
  awaitingReview: number,
): number | null {
  if (validated === 0) return null;
  return Math.max(0, round1(((validated - correctedDocuments - awaitingReview) / validated) * 100));
}

/**
 * §4.6 Time Saved %, an ESTIMATE driven entirely by the two documented env
 * constants (`BASELINE_MANUAL_MINUTES_PER_DOC`, `MINUTES_PER_MANUAL_OVERRIDE`).
 *
 * Those two constants are part of `metricAssumptionsFingerprint()` precisely so
 * a figure computed under one set of assumptions can never be served from cache
 * under another.
 *
 * Returns `null` with no documents at all: with a zero baseline there is no
 * effort to have saved a share of; see D13.
 */
export function timeSavedPercent(documentsTotal: number, overriddenFields: number): number | null {
  const baselineMinutes = documentsTotal * env.BASELINE_MANUAL_MINUTES_PER_DOC;
  if (baselineMinutes === 0) return null;
  const actualMinutes = overriddenFields * env.MINUTES_PER_MANUAL_OVERRIDE;
  return round1(Math.max(0, ((baselineMinutes - actualMinutes) / baselineMinutes) * 100));
}

/** §1.5's "≥95% of query responses with correct source citation" target. */
export function citationCoveragePercent(answered: number, answeredWithCitations: number): number | null {
  if (answered === 0) return null;
  return round1((answeredWithCitations / answered) * 100);
}

/**
 * §9.5 telemetry: the rate at which model-CLAIMED citations survive validation.
 * A fall here is the system's own fabricated-citation alarm, and it is a
 * DIFFERENT number from citationCoveragePercent above.
 */
export function citationIntegrityPercent(accepted: number, discarded: number): number | null {
  const total = accepted + discarded;
  if (total === 0) return null;
  return round1((accepted / total) * 100);
}
