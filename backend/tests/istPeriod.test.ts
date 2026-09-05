/**
 * IST period arithmetic — PRD §4.6.
 *
 * The whole point of §4.6 is that a figure is bucketed identically wherever it
 * is computed. So this suite is mostly boundary arithmetic in TypeScript, plus
 * ONE database round trip: the same instants pushed through `istBucketExpr()`
 * in a real aggregation must come back as the same strings the TypeScript
 * functions produce. That agreement test is the one that fails if someone
 * swaps the fixed +05:30 offset for 'Asia/Kolkata' on one side only.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  FISCAL_YEAR_START_MONTH,
  GRANULARITIES,
  IST_OFFSET,
  IST_OFFSET_MINUTES,
  bucketLabel,
  bucketRangeUtc,
  enumerateBuckets,
  istBucketExpr,
  istBucketKey,
  istDateBoundaryToUtc,
  istDayStartUtc,
  istFiscalQuarterKey,
  istMonthKey,
  istParts,
  previousBucketKey,
  type Granularity,
} from '../src/utils/istPeriod.js';

/** 23:59:59.999 IST on 31 March 2026 — the last instant of FY2025. */
const LAST_INSTANT_OF_FY2025 = new Date('2026-03-31T18:29:59.999Z');
/** 00:00:00.000 IST on 1 April 2026 — the first instant of FY2026. */
const FIRST_INSTANT_OF_FY2026 = new Date('2026-03-31T18:30:00.000Z');

/**
 * 24 instants straddling every IST month boundary of 2026: the last
 * millisecond of the outgoing IST day and the first millisecond of the new
 * one. Every sample sits in the window where a UTC reading and an IST reading
 * disagree about the month — the only place two implementations can drift.
 */
const BOUNDARY_SAMPLES: Date[] = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((month) => {
  const start = istDayStartUtc(2026, month, 1);
  return [new Date(start.getTime() - 1), start];
});

describe('Fiscal-year turnover (PRD §4.6)', () => {
  it('places the last millisecond of 31 March IST in March and in FY2025 Q4', () => {
    expect(istMonthKey(LAST_INSTANT_OF_FY2025)).toBe('2026-03');
    expect(istFiscalQuarterKey(LAST_INSTANT_OF_FY2025)).toBe('FY2025-Q4');
  });

  it('places the first millisecond of 1 April IST in April and in FY2026 Q1', () => {
    expect(istMonthKey(FIRST_INSTANT_OF_FY2026)).toBe('2026-04');
    expect(istFiscalQuarterKey(FIRST_INSTANT_OF_FY2026)).toBe('FY2026-Q1');
  });

  it('reads both turnover instants as the same UTC calendar day, which is why UTC bucketing is wrong', () => {
    // Both are 31 March in UTC. Only the IST shift separates them, so a
    // pipeline that dropped the timezone argument would file both in FY2025
    // and nothing about the number would look wrong.
    expect(LAST_INSTANT_OF_FY2025.getUTCMonth()).toBe(FIRST_INSTANT_OF_FY2026.getUTCMonth());
    expect(istParts(FIRST_INSTANT_OF_FY2026)).toEqual({ year: 2026, month: 4, day: 1 });
  });
});

describe('Fiscal-quarter boundaries (PRD §4.6)', () => {
  const CASES = [
    { month: 4, quarter: 1 },
    { month: 6, quarter: 1 },
    { month: 7, quarter: 2 },
    { month: 9, quarter: 2 },
    { month: 10, quarter: 3 },
    { month: 12, quarter: 3 },
    { month: 1, quarter: 4 },
    { month: 3, quarter: 4 },
  ];

  it.each(CASES)('maps IST month $month to fiscal quarter Q$quarter', ({ month, quarter }) => {
    // A month before April belongs to the fiscal year that STARTED the previous
    // calendar year, which is exactly where a naive getFullYear() goes wrong.
    const fyStart = month >= FISCAL_YEAR_START_MONTH ? 2026 : 2025;
    const noonIst = new Date(istDayStartUtc(2026, month, 15).getTime() + 12 * 3_600_000);
    expect(istFiscalQuarterKey(noonIst)).toBe(`FY${fyStart}-Q${quarter}`);
  });

  it('keeps the fiscal start year on the earlier side of January', () => {
    expect(istFiscalQuarterKey(istDayStartUtc(2027, 1, 1))).toBe('FY2026-Q4');
    expect(istMonthKey(istDayStartUtc(2027, 1, 1))).toBe('2027-01');
  });

  it('files the twelve calendar months of 2026 into three quarters of FY2026 and the tail of FY2025', () => {
    const keys = Array.from({ length: 12 }, (_, i) =>
      istFiscalQuarterKey(new Date(istDayStartUtc(2026, i + 1, 15).getTime() + 12 * 3_600_000)),
    );

    // A calendar year is not a fiscal year: January to March close out FY2025,
    // and only April onwards opens FY2026.
    expect(keys).toEqual([
      'FY2025-Q4',
      'FY2025-Q4',
      'FY2025-Q4',
      'FY2026-Q1',
      'FY2026-Q1',
      'FY2026-Q1',
      'FY2026-Q2',
      'FY2026-Q2',
      'FY2026-Q2',
      'FY2026-Q3',
      'FY2026-Q3',
      'FY2026-Q3',
    ]);
  });
});

describe('IST calendar-date boundaries (PRD §4.6)', () => {
  it('converts an IST calendar start date to the UTC instant five and a half hours earlier', () => {
    expect(istDateBoundaryToUtc('2026-04-01', 'start').toISOString()).toBe('2026-03-31T18:30:00.000Z');
  });

  it('converts an inclusive IST end date to the exclusive start of the following IST day', () => {
    // `to=2026-06-30` has to include all of 30 June IST, so the half-open upper
    // bound is the start of 1 July IST, not midnight on the 30th.
    expect(istDateBoundaryToUtc('2026-06-30', 'endExclusive').toISOString()).toBe('2026-06-30T18:30:00.000Z');
  });

  it('rolls a year-end endExclusive boundary into the following year', () => {
    const boundary = istDateBoundaryToUtc('2026-12-31', 'endExclusive');
    expect(boundary.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    expect(istMonthKey(boundary)).toBe('2027-01');
  });
});

describe('Bucket ranges round-trip (PRD §4.6)', () => {
  const KEYS: { key: string; g: Granularity }[] = [
    ...Array.from({ length: 12 }, (_, i) => ({
      key: `2026-${String(i + 1).padStart(2, '0')}`,
      g: 'month' as const,
    })),
    { key: 'FY2025-Q4', g: 'quarter' },
    { key: 'FY2026-Q1', g: 'quarter' },
    { key: 'FY2026-Q2', g: 'quarter' },
    { key: 'FY2026-Q3', g: 'quarter' },
    { key: 'FY2026-Q4', g: 'quarter' },
  ];

  it.each(KEYS)('maps every sampled instant inside $key back to $key', ({ key, g }) => {
    const { gte, lt } = bucketRangeUtc(key, g);
    const span = lt.getTime() - gte.getTime();
    const inside = [
      gte,
      new Date(gte.getTime() + 1),
      new Date(gte.getTime() + Math.floor(span / 3)),
      new Date(gte.getTime() + Math.floor(span / 2)),
      new Date(lt.getTime() - 1),
    ];
    for (const instant of inside) expect(istBucketKey(instant, g)).toBe(key);
  });

  it.each(KEYS)('excludes the upper bound of $key, so adjacent buckets never double-count a row', ({ key, g }) => {
    expect(istBucketKey(bucketRangeUtc(key, g).lt, g)).not.toBe(key);
  });

  it('rejects a month key handed to the quarter range rather than guessing at it', () => {
    expect(() => bucketRangeUtc('2026-04', 'quarter')).toThrow(/Not a fiscal-quarter key/);
  });
});

describe('Previous-bucket arithmetic (PRD §4.6)', () => {
  it('steps back across the fiscal-year boundary', () => {
    expect(previousBucketKey('FY2026-Q1', 'quarter')).toBe('FY2025-Q4');
  });

  it('steps back across the calendar-year boundary', () => {
    expect(previousBucketKey('2026-01', 'month')).toBe('2025-12');
  });

  it('steps back inside a fiscal year without moving the fiscal year', () => {
    expect(previousBucketKey('FY2026-Q3', 'quarter')).toBe('FY2026-Q2');
    expect(previousBucketKey('2026-05', 'month')).toBe('2026-04');
  });
});

describe('Bucket enumeration for zero-fill (PRD §4.6)', () => {
  const from = istDateBoundaryToUtc('2026-01-01', 'start');
  const to = istDateBoundaryToUtc('2026-06-30', 'endExclusive');

  it.each([...GRANULARITIES])(
    'enumerates %s buckets contiguously and gap-free across a fiscal-year boundary',
    (g) => {
      const keys = enumerateBuckets(g, from, to);
      expect(keys.length).toBeGreaterThan(1);
      expect(new Set(keys).size).toBe(keys.length);

      for (let i = 0; i + 1 < keys.length; i += 1) {
        // Contiguity means the exclusive end of one bucket IS the inclusive
        // start of the next; anything else leaves a hole or an overlap in a
        // zero-filled series and the chart quietly loses or doubles a period.
        expect(bucketRangeUtc(keys[i]!, g).lt.toISOString()).toBe(
          bucketRangeUtc(keys[i + 1]!, g).gte.toISOString(),
        );
      }
    },
  );

  it.each([...GRANULARITIES])('sorts %s keys identically as strings and as chronology', (g) => {
    const keys = enumerateBuckets(g, from, to);
    const lexicographic = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const chronological = [...keys].sort(
      (a, b) => bucketRangeUtc(a, g).gte.getTime() - bucketRangeUtc(b, g).gte.getTime(),
    );
    // `$sort: { _id: 1 }` on a bucket key has to be chronological on its own,
    // or every chart needs a second mapping nobody remembers to apply.
    expect(lexicographic).toEqual(chronological);
    expect(lexicographic).toEqual(keys);
  });

  it('spans the fiscal-year boundary rather than stopping at it', () => {
    expect(enumerateBuckets('month', from, to)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
    expect(enumerateBuckets('quarter', from, to)).toEqual(['FY2025-Q4', 'FY2026-Q1']);
  });

  it('returns nothing for an empty range', () => {
    expect(enumerateBuckets('month', from, from)).toEqual([]);
  });
});

describe('No daylight saving in IST (PRD §4.6)', () => {
  it('applies exactly +05:30 in all twelve months, which is what makes a fixed offset correct', () => {
    for (let month = 1; month <= 12; month += 1) {
      const offsetMinutes = (Date.UTC(2026, month - 1, 15) - istDayStartUtc(2026, month, 15).getTime()) / 60_000;
      expect(offsetMinutes).toBe(IST_OFFSET_MINUTES);
    }
    expect(IST_OFFSET).toBe('+05:30');
  });

  it('puts the millisecond before every IST month start in the previous month, in all twelve months', () => {
    for (let month = 1; month <= 12; month += 1) {
      const start = istDayStartUtc(2026, month, 1);
      const previousMonth = month === 1 ? '2025-12' : `2026-${String(month - 1).padStart(2, '0')}`;
      expect(istMonthKey(new Date(start.getTime() - 1))).toBe(previousMonth);
      expect(istMonthKey(start)).toBe(`2026-${String(month).padStart(2, '0')}`);
    }
  });
});

describe('Human-readable bucket labels (PRD §4.6)', () => {
  it('renders a month key as a month name and year', () => {
    expect(bucketLabel('2026-04')).toBe('April 2026');
    expect(bucketLabel('2026-01')).toBe('January 2026');
    expect(bucketLabel('2026-12')).toBe('December 2026');
  });

  it('renders a fiscal-quarter key in the two-year Indian FY form', () => {
    expect(bucketLabel('FY2026-Q1')).toBe('FY2026-27 Q1');
    expect(bucketLabel('FY2025-Q4')).toBe('FY2025-26 Q4');
  });

  it('returns an unrecognised key unchanged rather than inventing a label', () => {
    expect(bucketLabel('not-a-bucket')).toBe('not-a-bucket');
  });
});

describe('MongoDB and TypeScript agree on every bucket (PRD §4.6)', () => {
  const PROBE = 'istPeriodAgreementProbe';

  /**
   * §4.6's real requirement: a period computed in the worker and a period
   * computed in an aggregation must be the SAME STRING. Two implementations of
   * one piece of arithmetic is exactly the shape of defect that has a landing
   * card and a chart disagreeing about one quarter, so these assert the two
   * against each other rather than each against a hand-written expectation.
   */
  async function bucketsFromMongo(instants: Date[]) {
    const collection = mongoose.connection.db!.collection(PROBE);
    await collection.insertMany(instants.map((createdAt, i) => ({ i, createdAt })));

    const rows = await collection
      .aggregate([
        {
          $project: {
            _id: 0,
            i: 1,
            month: istBucketExpr('$createdAt', 'month'),
            quarter: istBucketExpr('$createdAt', 'quarter'),
          },
        },
      ])
      .toArray();

    return rows
      .sort((a, b) => (a.i as number) - (b.i as number))
      .map((r) => ({ month: r.month as string, quarter: r.quarter as string }));
  }

  it('returns the same strings as the TypeScript functions at the fiscal-year turnover', async () => {
    const turnover = [LAST_INSTANT_OF_FY2025, FIRST_INSTANT_OF_FY2026];
    const fromMongo = await bucketsFromMongo(turnover);

    expect(fromMongo).toEqual([
      { month: '2026-03', quarter: 'FY2025-Q4' },
      { month: '2026-04', quarter: 'FY2026-Q1' },
    ]);
    expect(fromMongo).toEqual(
      turnover.map((d) => ({ month: istMonthKey(d), quarter: istFiscalQuarterKey(d) })),
    );
  });

  it('returns the same strings as the TypeScript functions across every month boundary of a year', async () => {
    const fromMongo = await bucketsFromMongo(BOUNDARY_SAMPLES);

    expect(fromMongo).toEqual(
      BOUNDARY_SAMPLES.map((d) => ({
        month: istBucketKey(d, 'month'),
        quarter: istBucketKey(d, 'quarter'),
      })),
    );
  });

  it('disagrees with a UTC-bucketed pipeline, proving the timezone argument is doing the work', async () => {
    const collection = mongoose.connection.db!.collection(PROBE);
    await collection.insertOne({ i: 0, createdAt: FIRST_INSTANT_OF_FY2026 });

    const rows = await collection
      .aggregate([
        {
          $project: {
            _id: 0,
            ist: istBucketExpr('$createdAt', 'month'),
            utc: { $dateToString: { date: '$createdAt', format: '%Y-%m' } },
          },
        },
      ])
      .toArray();

    expect(rows[0]!.ist).toBe('2026-04');
    expect(rows[0]!.utc).toBe('2026-03');
  });
});
