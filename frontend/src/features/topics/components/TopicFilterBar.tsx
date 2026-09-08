'use client';

import { useState } from 'react';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { Field, FormError, Select, TextInput, fieldErrorsOf } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import { ApiError } from '@/lib/api/errors';
import {
  isRealIstCalendarDate,
  type Granularity,
  type TopicsClusterFlag,
  type TopicsCompareMode,
  type TopicsParams,
  type TopicsSourceFilter,
} from '@/features/topics/api';

/**
 * The filter strip for `/topics` — PRD §5.6.
 *
 * ─── EVERY CONTROL HERE CAN 400 THE ENDPOINT ────────────────────────────────
 * `GET /topics` takes nine optional params and NONE of them tolerates an empty
 * value: Zod's `.default()` fires on `undefined` only, so `?from=` or
 * `?subsidiaryId=` is a 400 rather than a fallback to the default. That is why
 * the blank state of every control here is the empty string and the whole
 * object is handed to `useTopics`, which drops blank keys in `toTopicsQuery`.
 * Nothing in this file builds a query string.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The filter state, shaped so it can be passed to `useTopics` unchanged.
 *
 * `''` means "unset — let the server apply its default", which is exactly what
 * `toTopicsQuery` strips. Keeping one object rather than nine pieces of state
 * also keeps the TanStack query key stable across renders.
 */
export interface TopicFilters extends TopicsParams {
  from: string;
  to: string;
  granularity: Granularity;
  subsidiaryId: string;
  source: TopicsSourceFilter;
  cluster: TopicsClusterFlag;
  compare: TopicsCompareMode;
}

/**
 * The server's own defaults, restated.
 *
 * `granularity`, `source`, `cluster` and `compare` are sent explicitly because
 * their value is what the reader sees in the dropdown — a control showing
 * "Quarterly" while the request omits the key is a lie the moment the server
 * default changes. `from`/`to` stay blank so the fiscal-year-to-date default
 * (1 April → now, `istPeriod.ts:138-145`) is the server's to compute in IST.
 */
export const DEFAULT_TOPIC_FILTERS: TopicFilters = {
  from: '',
  to: '',
  granularity: 'quarter',
  subsidiaryId: '',
  source: 'all',
  cluster: 'true',
  compare: 'previous',
};

/**
 * The failures that belong to no single control.
 *
 * Two shapes reach this, and neither carries `fields`:
 *
 *   INVALID_REQUEST   'Range ends before it starts' and 'Range exceeds the
 *                     maximum of 1100 days' (`topics.service.ts:313-320`). The
 *                     range is a PAIR of controls, so there is no one field to
 *                     hang it on.
 *   VALIDATION_ERROR  usually Zod, which DOES carry `fields` and lands on the
 *                     control itself — but `rejectOperatorInjection` emits the
 *                     same code with no `fields` at all (`sanitize.ts:51-54`).
 *                     Without this branch that one renders absolutely nothing,
 *                     because the page has already stood down for a filter
 *                     error.
 */
function formErrorOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'INVALID_REQUEST') return error.message;
  if (error.code === 'VALIDATION_ERROR' && !error.fields) return error.message;
  return undefined;
}

/**
 * True when the failure is something the reader can fix in this bar.
 *
 * Exported so the page can suppress its own `ErrorState` for these and let the
 * control that caused the failure carry the message — a full-page "Something
 * went wrong" for a date typo names neither the problem nor the fix.
 */
export function isFilterError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'INVALID_REQUEST' || error.code === 'VALIDATION_ERROR')
  );
}

export function TopicFilterBar({
  value,
  onChange,
  onReset,
  error,
  busy = false,
}: {
  value: TopicFilters;
  onChange: (next: TopicFilters) => void;
  onReset: () => void;
  /** The query error, if any — read for `fields` and for the range messages. */
  error?: unknown;
  /**
   * A refetch is in flight.
   *
   * It marks the bar `aria-busy` and NOTHING else. Disabling the controls was
   * the obvious move and the wrong one: `useTopics` keeps the previous payload
   * on screen through every filter change, so `busy` is true for a moment after
   * each keystroke — disabling then blurs whichever control the reader is
   * using, mid-adjustment, and swallows the next change.
   */
  busy?: boolean;
}) {
  /**
   * A date the calendar rejects, held locally so the input can show what was
   * typed alongside the error instead of silently reverting.
   *
   * `<input type="date">` reports an incomplete value as `''`, so most browsers
   * never reach this branch — but the guard is not decorative. The server's
   * regex checks SHAPE ONLY: `2026-02-30` passes Zod, rolls over to 2 March
   * through `Date.UTC` (`istPeriod.ts:78-79`), and comes back as a 200 for a
   * range nobody asked for with `range.from` echoing the bad string. Nothing
   * server-side complains, so this is the only place it can be caught.
   */
  const [badFrom, setBadFrom] = useState<string | null>(null);
  const [badTo, setBadTo] = useState<string | null>(null);

  const fieldError = fieldErrorsOf(error);
  const formError = formErrorOf(error);

  const setFrom = (raw: string) => {
    if (raw !== '' && !isRealIstCalendarDate(raw)) {
      setBadFrom(raw);
      return;
    }
    setBadFrom(null);
    onChange({ ...value, from: raw });
  };

  const setTo = (raw: string) => {
    if (raw !== '' && !isRealIstCalendarDate(raw)) {
      setBadTo(raw);
      return;
    }
    setBadTo(null);
    onChange({ ...value, to: raw });
  };

  const isDefault =
    value.from === DEFAULT_TOPIC_FILTERS.from &&
    value.to === DEFAULT_TOPIC_FILTERS.to &&
    value.granularity === DEFAULT_TOPIC_FILTERS.granularity &&
    value.subsidiaryId === DEFAULT_TOPIC_FILTERS.subsidiaryId &&
    value.source === DEFAULT_TOPIC_FILTERS.source &&
    value.cluster === DEFAULT_TOPIC_FILTERS.cluster &&
    value.compare === DEFAULT_TOPIC_FILTERS.compare;

  return (
    <div className="flex flex-col gap-2" aria-busy={busy || undefined}>
      <Toolbar>
        <div className="w-full sm:w-56">
          <SubsidiaryPicker
            value={value.subsidiaryId}
            onChange={(subsidiaryId) => onChange({ ...value, subsidiaryId })}
            allowAll
            error={fieldError('subsidiaryId')}
          />
        </div>

        {/*
          Defaults are applied PER EDGE, not per pair (`topics.service.ts:308-310`),
          so each description states what THAT box does when left blank. Leaving
          only `from` set means "from then until now" — a future date there with
          no `to` is a 400, not an empty chart.
        */}
        <Field
          label="From"
          className="w-full sm:w-44"
          description="Blank = 1 April (fiscal year start)"
          error={badFrom === null ? fieldError('from') : 'Not a real calendar date.'}
        >
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={badFrom ?? value.from}
              onChange={(event) => setFrom(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="To"
          className="w-full sm:w-44"
          description="Inclusive. Blank = today (IST)"
          error={badTo === null ? fieldError('to') : 'Not a real calendar date.'}
        >
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={badTo ?? value.to}
              onChange={(event) => setTo(event.target.value)}
            />
          )}
        </Field>

        <Field label="Granularity" className="w-full sm:w-40" error={fieldError('granularity')}>
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.granularity}
              onChange={(granularity) =>
                onChange({ ...value, granularity: granularity as Granularity })
              }
            >
              <option value="quarter">Fiscal quarters</option>
              <option value="month">Months</option>
            </Select>
          )}
        </Field>

        {/*
          Only a query's QUESTION text is indexed, never the generated answer
          (`termIndexer.ts:88-96`) — hence "questions asked", not "answers".
        */}
        <Field label="Source" className="w-full sm:w-48" error={fieldError('source')}>
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.source}
              onChange={(source) =>
                onChange({ ...value, source: source as TopicsSourceFilter })
              }
            >
              <option value="all">Documents and questions</option>
              <option value="document">Documents only</option>
              <option value="query">Questions asked</option>
            </Select>
          )}
        </Field>

        {/*
          `cluster` and `compare` are STRING enums, not booleans
          (`topics.schema.ts:26-27`, tested with `=== 'true'`). A checkbox here
          would want a boolean and `?cluster=1` is a 400, so both stay selects
          whose option values are the wire values verbatim.
        */}
        <Field label="Grouping" className="w-full sm:w-44" error={fieldError('cluster')}>
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.cluster}
              onChange={(cluster) =>
                onChange({ ...value, cluster: cluster as TopicsClusterFlag })
              }
            >
              <option value="true">Group related terms</option>
              <option value="false">No grouping</option>
            </Select>
          )}
        </Field>

        <Field label="Comparison" className="w-full sm:w-44" error={fieldError('compare')}>
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.compare}
              onChange={(compare) =>
                onChange({ ...value, compare: compare as TopicsCompareMode })
              }
            >
              <option value="previous">Against previous period</option>
              <option value="none">Off</option>
            </Select>
          )}
        </Field>

        {/*
          Reset has to clear the rejected-date state too. A bad date never
          reaches `value` — it is held here so the box can show what was typed —
          so resetting the filters alone would leave the input still displaying
          it, still flagged, and no longer describing the range being queried.
        */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setBadFrom(null);
            setBadTo(null);
            onReset();
          }}
          disabled={isDefault}
        >
          Reset
        </Button>
      </Toolbar>

      {formError ? <FormError>{formError}</FormError> : null}

      {/*
        `fieldErrorsOf` keys on the param name, but Zod also emits the literal
        `query` for an object-level issue (`middleware/validate.ts:51`), which
        belongs to no control on this bar.
      */}
      {fieldError('query') ? <FormError>{fieldError('query')}</FormError> : null}
    </div>
  );
}
