/**
 * Dates are stored and transported in UTC, and displayed in IST — PRD §4.6.
 *
 * The rule is not cosmetic. Trend bucketing converts to IST at query time so
 * Indian fiscal quarter and month boundaries are computed identically in the
 * worker and in the API; rendering in the viewer's local zone would put a
 * figure in a different quarter for a user abroad than the one the server
 * aggregated it into.
 *
 * `Intl` handles this without a date library, which keeps the dependency out
 * of the bundle. The IST offset is fixed (+05:30, no daylight saving), so
 * there is no ambiguity to resolve.
 */

const IST = 'Asia/Kolkata';

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDate(iso: string | Date): string {
  return dateFmt.format(new Date(iso));
}

export function formatDateTime(iso: string | Date): string {
  return `${dateTimeFmt.format(new Date(iso))} IST`;
}

/**
 * The `from`/`to` parameters for `/topics` and `/analytics` are IST CALENDAR
 * DATES (`YYYY-MM-DD`), not instants. Sending `toISOString()` fails validation
 * outright — the schema regex rejects anything with a time component.
 */
export function toIstCalendarDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Relative phrasing for "computed at" lines, falling back to an absolute time. */
export function formatRelative(iso: string | Date): string {
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return formatDateTime(iso);
}

/**
 * Indian fiscal year starts in April — `FISCAL_YEAR_START_MONTH = 4` in the
 * backend. Q1 is Apr–Jun, so a calendar-quarter label would be wrong by one
 * quarter for nine months of the year.
 */
export function fiscalQuarterLabel(value: Date): string {
  const istMonth = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: IST, month: 'numeric' }).format(value),
  );
  const istYear = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric' }).format(value),
  );
  const fyStart = istMonth >= 4 ? istYear : istYear - 1;
  const quarter = Math.floor(((istMonth - 4 + 12) % 12) / 3) + 1;
  return `Q${quarter} FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
}
