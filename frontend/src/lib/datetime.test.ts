import { describe, expect, it } from 'vitest';
import { fiscalQuarterLabel, formatDate, formatDateTime, toIstCalendarDate } from './datetime';

/**
 * IST rendering and Indian fiscal bucketing — PRD §4.6.
 *
 * The rule is not cosmetic. The backend buckets trends by converting to IST at
 * query time, so a figure rendered in the viewer's own zone can land in a
 * different quarter than the one the server aggregated it into — the report and
 * the chart then disagree, and neither is obviously wrong.
 */

describe('toIstCalendarDate', () => {
  it('returns a bare YYYY-MM-DD with no time component', () => {
    // The /topics and /analytics schemas reject anything with a time part
    // outright, so `toISOString()` is a 400 rather than a near miss.
    expect(toIstCalendarDate(new Date('2026-06-15T09:30:00Z'))).toBe('2026-06-15');
    expect(toIstCalendarDate(new Date('2026-06-15T09:30:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rolls into the next IST day for a late-evening UTC instant', () => {
    // IST is UTC+05:30 with no daylight saving, so 19:00Z is 00:30 the NEXT
    // day in Kolkata. A UTC-based date would report the day before and shift
    // the whole range by one.
    expect(toIstCalendarDate(new Date('2026-06-15T19:00:00Z'))).toBe('2026-06-16');
  });

  it('stays on the same IST day just before the boundary', () => {
    expect(toIstCalendarDate(new Date('2026-06-15T18:29:00Z'))).toBe('2026-06-15');
  });

  it('pads single-digit months and days', () => {
    expect(toIstCalendarDate(new Date('2026-01-05T06:00:00Z'))).toBe('2026-01-05');
  });
});

describe('fiscalQuarterLabel', () => {
  it('starts the fiscal year in April, not January', () => {
    // April is Q1 of FY2026-27. A calendar-quarter label would call it Q2 and
    // be wrong for nine months of every year.
    expect(fiscalQuarterLabel(new Date('2026-04-10T06:00:00Z'))).toBe('Q1 FY2026-27');
    expect(fiscalQuarterLabel(new Date('2026-06-30T06:00:00Z'))).toBe('Q1 FY2026-27');
  });

  it('walks the remaining quarters', () => {
    expect(fiscalQuarterLabel(new Date('2026-07-01T06:00:00Z'))).toBe('Q2 FY2026-27');
    expect(fiscalQuarterLabel(new Date('2026-10-01T06:00:00Z'))).toBe('Q3 FY2026-27');
    expect(fiscalQuarterLabel(new Date('2027-01-01T06:00:00Z'))).toBe('Q4 FY2026-27');
  });

  it('puts January to March in the PREVIOUS fiscal year', () => {
    // The trap: March 2026 belongs to FY2025-26, not FY2026-27.
    expect(fiscalQuarterLabel(new Date('2026-03-31T06:00:00Z'))).toBe('Q4 FY2025-26');
  });

  it('uses the IST calendar date when the two zones disagree', () => {
    // 31 March 19:00Z is already 1 April in Kolkata — the first day of the new
    // fiscal year. Bucketing on UTC would file it under the old one.
    expect(fiscalQuarterLabel(new Date('2026-03-31T19:00:00Z'))).toBe('Q1 FY2026-27');
  });
});

describe('formatting', () => {
  it('renders a date in IST', () => {
    expect(formatDate('2026-06-15T09:30:00Z')).toContain('2026');
  });

  it('labels a timestamp as IST so it is never read as local time', () => {
    // An unlabelled timestamp in a compliance trail is ambiguous, and the audit
    // log is precisely where that ambiguity is expensive.
    expect(formatDateTime('2026-06-15T09:30:00Z')).toMatch(/IST$/);
  });
});
