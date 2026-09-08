'use client';

import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput, fieldErrorsOf } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import type {
  AnalyticsInclude,
  GetAnalyticsQuery,
  Granularity,
  IncludeBySubsidiary,
} from '@/features/analytics/api';

/**
 * The analytics filter strip — PRD §5.3.
 *
 * One control per wire param, and three of the six are not the shape a filter
 * bar usually takes:
 *
 *   `include` is a SINGLE enum, not a multi-select. `analytics.schema.ts:31-41`
 *   records that a comma-separated transform was considered and rejected, so
 *   `include=documents,reports` is a 400 rather than a two-section request. The
 *   control is one-of-five because the API is one-of-five.
 *
 *   `includeBySubsidiary` is the STRING 'true' | 'false', compared with
 *   `=== 'true'` at `analytics.service.ts:578` rather than parsed by
 *   `z.coerce.boolean()`. So the state holds those strings, and a real boolean
 *   never reaches the query string.
 *
 *   `from`/`to` are IST CALENDAR dates ('YYYY-MM-DD'), which is exactly what
 *   `<input type="date">` produces, so the value goes through untouched.
 *   `toIstRangeParams` in the feature module is for a caller holding a `Date`;
 *   pushing a date-input string through `new Date(...)` and back would
 *   reinterpret a calendar date as an instant for no gain, and a `toISOString()`
 *   here is a 400 outright — the schema regex rejects a time component.
 */

/**
 * The bar's own state. Every optional param is a string here, with '' meaning
 * "do not send it" — which for `from`/`to` asks for the server's default
 * window, and for `subsidiaryId` asks for the caller's whole scope.
 */
export interface AnalyticsFilters {
  granularity: Granularity;
  from: string;
  to: string;
  subsidiaryId: string;
  include: AnalyticsInclude;
  includeBySubsidiary: IncludeBySubsidiary;
}

/**
 * The server's own defaults, restated so the controls show what the request
 * actually asks for. Sending them explicitly changes nothing: the cache key is
 * built from the RESOLVED values (`analytics.service.ts:584-594`), so an
 * explicit `granularity=quarter` and an omitted one share one entry.
 *
 * `from`/`to` stay empty on purpose. The default window is the current INDIAN
 * fiscal year to date, resolved in IST on the server; a client that restated it
 * would drift at the April boundary and for any viewer whose clock is not IST.
 */
export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilters = {
  granularity: 'quarter',
  from: '',
  to: '',
  subsidiaryId: '',
  include: 'all',
  includeBySubsidiary: 'true',
};

/**
 * Exhaustive `Record`s rather than arrays of options: a value added to a
 * backend enum then fails to compile here instead of quietly going missing from
 * a dropdown, which is the failure nobody notices.
 */
const GRANULARITY_LABELS: Record<Granularity, string> = {
  month: 'Month',
  quarter: 'Fiscal quarter',
};

const INCLUDE_LABELS: Record<AnalyticsInclude, string> = {
  all: 'All sections',
  documents: 'Documents only',
  extraction: 'Extraction only',
  reports: 'Reports only',
  queries: 'Queries only',
};

const BY_SUBSIDIARY_LABELS: Record<IncludeBySubsidiary, string> = {
  true: 'Show',
  false: 'Hide',
};

/** Drop the '' placeholders — the transport omits empty values from the query anyway. */
export function toAnalyticsParams(filters: AnalyticsFilters): GetAnalyticsQuery {
  return {
    granularity: filters.granularity,
    from: filters.from || undefined,
    to: filters.to || undefined,
    subsidiaryId: filters.subsidiaryId || undefined,
    include: filters.include,
    includeBySubsidiary: filters.includeBySubsidiary,
  };
}

export function hasNonDefaultFilters(filters: AnalyticsFilters): boolean {
  return (Object.keys(DEFAULT_ANALYTICS_FILTERS) as Array<keyof AnalyticsFilters>).some(
    (key) => filters[key] !== DEFAULT_ANALYTICS_FILTERS[key],
  );
}

export function AnalyticsFilterBar({
  value,
  onChange,
  error,
}: {
  value: AnalyticsFilters;
  onChange: (next: AnalyticsFilters) => void;
  /**
   * The last request's failure, read ONLY for per-field messages. A malformed
   * date or id arrives as VALIDATION_ERROR with `error.fields` keyed by query
   * param name; a well-formed but rejected range (`to` before `from`, more
   * buckets than the cap) arrives as INVALID_REQUEST with NO fields at all
   * (`analytics.schema.ts:1-10`). The second kind is invisible here by
   * construction, so the page renders it as a whole-request message instead.
   */
  error?: unknown;
}) {
  const fieldError = fieldErrorsOf(error);

  return (
    <Toolbar>
      <div className="min-w-44 flex-1">
        <Field
          label="Bucket by"
          description="Fiscal quarters start in April."
          error={fieldError('granularity')}
        >
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.granularity}
              onChange={(next) =>
                // Select hands back the chosen option's value as a bare string.
                // The options are generated from the exhaustive Record above, so
                // the cast can only ever carry a real member of the union.
                onChange({ ...value, granularity: next as Granularity })
              }
            >
              {(Object.entries(GRANULARITY_LABELS) as Array<[Granularity, string]>).map(
                ([granularity, label]) => (
                  <option key={granularity} value={granularity}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          )}
        </Field>
      </div>

      <div className="min-w-40 flex-1">
        <Field label="From" description="Empty = fiscal year to date." error={fieldError('from')}>
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={value.from}
              onChange={(event) => onChange({ ...value, from: event.target.value })}
            />
          )}
        </Field>
      </div>

      <div className="min-w-40 flex-1">
        <Field label="To" description="Includes the whole day, IST." error={fieldError('to')}>
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="date"
              value={value.to}
              onChange={(event) => onChange({ ...value, to: event.target.value })}
            />
          )}
        </Field>
      </div>

      <div className="min-w-52 flex-1">
        <SubsidiaryPicker
          value={value.subsidiaryId}
          onChange={(subsidiaryId) => onChange({ ...value, subsidiaryId })}
          allowAll
          error={fieldError('subsidiaryId')}
        />
      </div>

      <div className="min-w-44 flex-1">
        <Field
          label="Sections"
          description="One section or all — the API takes no list."
          error={fieldError('include')}
        >
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.include}
              onChange={(next) => onChange({ ...value, include: next as AnalyticsInclude })}
            >
              {(Object.entries(INCLUDE_LABELS) as Array<[AnalyticsInclude, string]>).map(
                ([include, label]) => (
                  <option key={include} value={include}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          )}
        </Field>
      </div>

      <div className="min-w-44 flex-1">
        <Field
          label="Subsidiary breakdown"
          description="Turn it off to skip the per-subsidiary pass."
          error={fieldError('includeBySubsidiary')}
        >
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.includeBySubsidiary}
              onChange={(next) =>
                onChange({ ...value, includeBySubsidiary: next as IncludeBySubsidiary })
              }
            >
              {(Object.entries(BY_SUBSIDIARY_LABELS) as Array<[IncludeBySubsidiary, string]>).map(
                ([flag, label]) => (
                  <option key={flag} value={flag}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          )}
        </Field>
      </div>

      {hasNonDefaultFilters(value) ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => onChange(DEFAULT_ANALYTICS_FILTERS)}
        >
          Reset filters
        </Button>
      ) : null}
    </Toolbar>
  );
}
