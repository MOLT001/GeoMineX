/**
 * IST period arithmetic — PRD §4.6.
 *
 * WHY A FIXED OFFSET RATHER THAN 'Asia/Kolkata':
 * India has observed no DST since 1945 and no offset change is scheduled, so
 * +05:30 is exactly correct. Unlike the IANA name, an offset does not depend on
 * the mongod build's bundled timezone database being present and current — and
 * it lets the TypeScript form and the pipeline form be provably the same
 * arithmetic, which §4.6 actually requires.
 *
 * IST_OFFSET_MINUTES and FISCAL_YEAR_START_MONTH are deliberately NOT env
 * variables. A configurable offset invites a deployment that silently moves
 * every fiscal-quarter boundary — a defect with no error message, in the
 * numbers a ministry reads. An Indian FY starting in April is law, not config.
 */
export const IST_OFFSET_MINUTES = 330;
export const IST_OFFSET = '+05:30';
export const IST_LABEL = 'Asia/Kolkata (+05:30)';
export const FISCAL_YEAR_START_MONTH = 4;

export const GRANULARITIES = ['month', 'quarter'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

// ── TypeScript form (used by the term indexer at write time) ────────────────

interface IstParts { year: number; month: number; day: number }

/** Shift by the fixed offset, then read UTC getters. Valid ONLY because IST has no DST. */
export function istParts(utc: Date): IstParts {
  const s = new Date(utc.getTime() + IST_OFFSET_MINUTES * 60_000);
  return { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() };
}

/** '2026-04' */
export function istMonthKey(utc: Date): string {
  const { year, month } = istParts(utc);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * 'FY2026-Q1'.
 *
 *   fyStart = m >= 4 ? y : y - 1
 *   q       = floor(((m + 8) % 12) / 3) + 1
 *
 * Checked at every boundary: m=4 -> Q1, m=6 -> Q1, m=7 -> Q2, m=9 -> Q2,
 * m=10 -> Q3, m=12 -> Q3, m=1 -> Q4, m=3 -> Q4.
 *
 * Both key forms are deliberately lexicographically sortable, so `$sort: {_id: 1}`
 * on a bucket key is chronological with no extra mapping.
 */
export function istFiscalQuarterKey(utc: Date): string {
  const { year, month } = istParts(utc);
  const fyStart = month >= FISCAL_YEAR_START_MONTH ? year : year - 1;
  const q = Math.floor(((month + 8) % 12) / 3) + 1;
  return `FY${fyStart}-Q${q}`;
}

export function istBucketKey(utc: Date, g: Granularity): string {
  return g === 'month' ? istMonthKey(utc) : istFiscalQuarterKey(utc);
}

/** '2026-04' -> 'April 2026';  'FY2026-Q1' -> 'FY2026-27 Q1'. */
export function bucketLabel(key: string): string {
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const fq = /^FY(\d{4})-Q([1-4])$/.exec(key);
  if (fq) {
    const y = Number(fq[1]);
    return `FY${y}-${String((y + 1) % 100).padStart(2, '0')} Q${fq[2]}`;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return key;
}

/** Start of an IST calendar day, as a UTC instant. */
export function istDayStartUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MINUTES * 60_000);
}

/**
 * 'YYYY-MM-DD' interpreted as an IST CALENDAR date.
 *
 * `edge: 'endExclusive'` returns the start of the FOLLOWING IST day, so `to` is
 * inclusive as a calendar day while the range stays half-open. The client never
 * sends an instant, so the client can never disagree with the server about
 * where a quarter starts.
 */
export function istDateBoundaryToUtc(isoDate: string, edge: 'start' | 'endExclusive'): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return edge === 'start' ? istDayStartUtc(y, m, d) : istDayStartUtc(y, m, d + 1);
}

/** Half-open UTC range covering one bucket key. */
export function bucketRangeUtc(key: string, g: Granularity): { gte: Date; lt: Date } {
  if (g === 'month') {
    const [y, m] = key.split('-').map(Number) as [number, number];
    return {
      gte: istDayStartUtc(y, m, 1),
      lt: istDayStartUtc(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1),
    };
  }
  const fq = /^FY(\d{4})-Q([1-4])$/.exec(key);
  if (!fq) throw new Error(`Not a fiscal-quarter key: ${key}`);
  const fy = Number(fq[1]);
  const q = Number(fq[2]);
  const startAbs = FISCAL_YEAR_START_MONTH + (q - 1) * 3;   // 4, 7, 10, 13
  const endAbs = startAbs + 3;                              // 7, 10, 13, 16
  const sy = startAbs > 12 ? fy + 1 : fy;
  const sm = startAbs > 12 ? startAbs - 12 : startAbs;
  const ey = endAbs > 12 ? fy + 1 : fy;
  const em = endAbs > 12 ? endAbs - 12 : endAbs;
  return { gte: istDayStartUtc(sy, sm, 1), lt: istDayStartUtc(ey, em, 1) };
}

/** 'FY2026-Q1' -> 'FY2025-Q4';  '2026-01' -> '2025-12'. Crosses the FY boundary correctly. */
export function previousBucketKey(key: string, g: Granularity): string {
  const { gte } = bucketRangeUtc(key, g);
  return istBucketKey(new Date(gte.getTime() - 1), g);
}

/** Contiguous, ascending, gap-free bucket keys covering [gte, lt). Drives zero-fill. */
export function enumerateBuckets(g: Granularity, gte: Date, lt: Date): string[] {
  const out: string[] = [];
  let cursor = gte;
  let guard = 0;
  while (cursor < lt && guard < 5_000) {
    const key = istBucketKey(cursor, g);
    out.push(key);
    cursor = bucketRangeUtc(key, g).lt;
    guard += 1;
  }
  return out;
}

/** Default analytics/topics range: the current Indian fiscal year to date. */
export function currentFiscalYearRangeUtc(now = new Date()): { gte: Date; lt: Date } {
  const { year, month } = istParts(now);
  const fyStart = month >= FISCAL_YEAR_START_MONTH ? year : year - 1;
  return {
    gte: istDayStartUtc(fyStart, FISCAL_YEAR_START_MONTH, 1),
    lt: new Date(now.getTime() + 1),
  };
}

// ── Aggregation-expression form (used by the analytics pipelines) ───────────

/**
 * The SAME arithmetic as above, expressed for the aggregation framework.
 *
 * `$dateToString` with a timezone argument is MongoDB 3.6+, which keeps the
 * feature floor low (see the spec's D14). `$dateTrunc` would require 5.0 and
 * buy nothing here.
 *
 * tests/istPeriod.test.ts asserts that, for the same instant, this expression
 * and the TypeScript functions above return the SAME STRING — for both
 * granularities, on both sides of 2026-03-31T18:30:00Z. That test is §4.6's
 * "computed identically in the worker and in the API" made checkable rather
 * than aspirational.
 */
export function istBucketExpr(fieldPath: string, g: Granularity): Record<string, unknown> {
  if (g === 'month') {
    return { $dateToString: { date: fieldPath, format: '%Y-%m', timezone: IST_OFFSET } };
  }
  return {
    $let: {
      vars: {
        m: { $toInt: { $dateToString: { date: fieldPath, format: '%m', timezone: IST_OFFSET } } },
        y: { $toInt: { $dateToString: { date: fieldPath, format: '%Y', timezone: IST_OFFSET } } },
      },
      in: {
        $concat: [
          'FY',
          { $toString: { $cond: [{ $gte: ['$$m', FISCAL_YEAR_START_MONTH] }, '$$y', { $subtract: ['$$y', 1] }] } },
          '-Q',
          { $toString: { $add: [{ $floor: { $divide: [{ $mod: [{ $add: ['$$m', 8] }, 12] }, 3] } }, 1] } },
        ],
      },
    },
  };
}
