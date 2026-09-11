'use client';

import { useState, type FormEvent } from 'react';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput } from '@/components/ui/Field';
import { SearchIcon } from '@/components/ui/Icon';
import { Toolbar } from '@/components/ui/Layout';
import type { DocumentFilters, DocumentStatus, DocumentType } from '@/features/documents/api';
import { TopicFilter } from '@/features/topics/components/TopicFilter';

/**
 * The document-list filter strip — PRD §5.4.
 *
 * Four server-side filters plus the text search, and one deliberate ABSENCE:
 * there is no "suspicious content" filter. `injectionSuspected` is read by the
 * service but is not declared in `documentQuerySchema`, and Zod strips unknown
 * query keys — so `?injectionSuspected=true` is discarded in silence and the
 * list comes back unfiltered with no error at all. Filtering on "Needs review"
 * and reading the flag off the rows is the honest substitute, and it is honest
 * only about the pages that have actually been fetched.
 */

/**
 * The bar's own state, which `DocumentFilters` cannot express: every field is a
 * string where '' means "not filtering", and `requiresReview` on the wire is
 * the string enum 'true' | 'false' with no third value — an empty one is a 400,
 * not an unfiltered list (document.schema.ts:19-29).
 */
export interface DocumentListFilters {
  subsidiaryId: string;
  status: DocumentStatus | '';
  type: DocumentType | '';
  requiresReview: 'true' | 'false' | '';
  q: string;
  /** Topic ids. Empty means no topic filter — there is no '' placeholder here. */
  topics: string[];
  /** Only sent when two or more topics are selected. */
  topicMatch: 'any' | 'all';
}

export const EMPTY_DOCUMENT_FILTERS: DocumentListFilters = {
  subsidiaryId: '',
  status: '',
  type: '',
  requiresReview: '',
  q: '',
  topics: [],
  topicMatch: 'any',
};

/**
 * Exhaustive `Record`s rather than arrays of strings. A status or type added to
 * the backend enum then fails to compile here instead of quietly going missing
 * from a dropdown, which is the failure nobody notices.
 */
const STATUS_LABELS: Record<DocumentStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  validated: 'Validated',
  failed: 'Failed',
};

/**
 * The stored `type` is derived from the file EXTENSION, not the contents, so
 * the labels name extensions. Notably `.csv` and `.txt` are 'spreadsheet', and
 * only `.tif`/`.tiff` are 'scan' — a scanned PDF is still 'pdf'.
 */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  pdf: 'PDF',
  scan: 'Scan (.tif)',
  spreadsheet: 'Spreadsheet or text',
  image: 'Image',
  archive: 'Archive (.zip)',
};

const REVIEW_LABELS: Record<'true' | 'false', string> = {
  true: 'Needs review',
  false: 'No review needed',
};

export function hasActiveFilters(filters: DocumentListFilters): boolean {
  return (
    filters.subsidiaryId !== '' ||
    filters.status !== '' ||
    filters.type !== '' ||
    filters.requiresReview !== '' ||
    filters.q.trim() !== '' ||
    filters.topics.length > 0
  );
}

/** Drop the '' placeholders — an empty `requiresReview` on the wire is a 400. */
export function toDocumentFilters(filters: DocumentListFilters): DocumentFilters {
  return {
    subsidiaryId: filters.subsidiaryId || undefined,
    status: filters.status || undefined,
    type: filters.type || undefined,
    requiresReview: filters.requiresReview || undefined,
    q: filters.q.trim() || undefined,
    // An empty array serialises to no parameter at all, so it needs no
    // placeholder of its own — unlike the string filters above.
    topic: filters.topics,
    topicMatch: filters.topicMatch,
  };
}

export function DocumentFilterBar({
  value,
  onChange,
  resetSignal = 0,
}: {
  value: DocumentListFilters;
  onChange: (next: DocumentListFilters) => void;
  /**
   * Bump to clear the unsubmitted search draft as well as the applied filters.
   * Needed because a caller replacing the filter set cannot reach the draft,
   * and `q` is often already `''` when it does so. See the sync below.
   */
  resetSignal?: number;
}) {
  /**
   * The search box holds a DRAFT until it is submitted, and re-syncs whenever
   * the applied term changes underneath it — a clear from anywhere on the page,
   * for instance.
   *
   * The sync is a render-phase comparison rather than an effect or a remounting
   * `key`: a `key` on the form would tear the whole subtree down on every
   * submit, which drops focus to `<body>` at the exact moment a keyboard user
   * is about to tab into the results.
   */
  const [draft, setDraft] = useState(value.q);
  const [applied, setApplied] = useState(value.q);
  if (applied !== value.q) {
    setApplied(value.q);
    setDraft(value.q);
  }

  /**
   * An explicit reset from the caller also clears the UNSUBMITTED draft.
   *
   * The sync above fires only when the APPLIED term changes, which leaves a
   * real hole: type "coal" without pressing Search, then press a count tile.
   * The caller sets `q: ''` — already `''` — so nothing re-syncs, and the box
   * goes on reading "coal" while the results are not filtered by it. Clear
   * filters could not fix it either, for the same reason. The signal is a
   * counter rather than a `key` on this component so that resetting does not
   * tear down and remount the selects, which would drop focus.
   */
  const [seenReset, setSeenReset] = useState(resetSignal);
  if (seenReset !== resetSignal) {
    setSeenReset(resetSignal);
    setDraft(value.q);
    setApplied(value.q);
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChange({ ...value, q: draft });
  }

  return (
    <Toolbar>
      {/*
        Search takes its OWN row, above the selects, and that is a layout fix
        rather than a preference.

        `Toolbar` aligns on `items-end` because every child is a label stacked
        over a control and only their bottom edges line up. This field carries a
        two-line `description` as well, so inline it was half a row taller than
        its neighbours — which pushed the strip down and left a band of empty
        space above four bottom-aligned selects. Giving it `basis-full` takes
        that height out of their row entirely.

        Above rather than below, because it is the control most people reach for
        first and the reference layout for this screen puts it there too.
      */}
      <form onSubmit={applySearch} className="flex w-full basis-full flex-wrap items-end gap-2">
        {/*
          §8.2 in the user's own words rather than as a section number: the
          index is `{ originalFilename, tags }` only, so someone searching for a
          phrase they remember from inside a PDF gets nothing and needs to be
          told why before they type it.
        */}
        <Field
          label="Search"
          description="Filenames and tags only, not the text inside a document"
          className="flex-1"
        >
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // 1..120 characters server-side, and over-length is a 400 rather
              // than a truncation.
              maxLength={120}
              placeholder="e.g. production report"
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" icon={<SearchIcon size={14} />}>
          Search
        </Button>
      </form>

      {/*
        Topic takes its own row directly under Search, for the same reason
        Search does: it can grow a second line of chips, and inline it would
        push the four bottom-aligned selects down and leave a band of empty
        space above them.

        It sits ABOVE the file-type and status selects because it is the filter
        this screen exists to offer — "what is this about" is the question a
        reader arrives with, and format and pipeline state are how they narrow
        afterwards.
      */}
      <TopicFilter
        value={value.topics}
        match={value.topicMatch}
        onChange={(topics) => onChange({ ...value, topics })}
        onMatchChange={(topicMatch) => onChange({ ...value, topicMatch })}
        subsidiaryId={value.subsidiaryId || undefined}
      />

      <div className="min-w-52 flex-1">
        <SubsidiaryPicker
          value={value.subsidiaryId}
          onChange={(subsidiaryId) => onChange({ ...value, subsidiaryId })}
          allowAll
        />
      </div>

      <div className="min-w-40 flex-1">
        <Field label="Status">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.status}
              onChange={(status) =>
                // The listbox hands back the selected value as a bare string.
                // The options are generated from the exhaustive Record above,
                // so the cast can only ever carry a real member of the union.
                onChange({ ...value, status: status as DocumentStatus | '' })
              }
            >
              <option value="">Any status</option>
              {(Object.entries(STATUS_LABELS) as Array<[DocumentStatus, string]>).map(
                ([status, label]) => (
                  <option key={status} value={status}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          )}
        </Field>
      </div>

      <div className="min-w-40 flex-1">
        <Field label="File type">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.type}
              onChange={(fileType) =>
                onChange({ ...value, type: fileType as DocumentType | '' })
              }
            >
              <option value="">Any file type</option>
              {(Object.entries(DOCUMENT_TYPE_LABELS) as Array<[DocumentType, string]>).map(
                ([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          )}
        </Field>
      </div>

      <div className="min-w-44 flex-1">
        <Field label="Review">
          {(fieldProps) => (
            <Select
              {...fieldProps}
              value={value.requiresReview}
              // The wire values are the STRINGS 'true' and 'false', never
              // booleans: the schema takes string literals because
              // `z.coerce.boolean()` would read 'false' as true and invert the
              // filter. '' is not one of them, which is why `toDocumentFilters`
              // drops the key rather than sending an empty value.
              onChange={(reviewState) =>
                onChange({
                  ...value,
                  requiresReview: reviewState as 'true' | 'false' | '',
                })
              }
            >
              <option value="">Any review state</option>
              {(Object.entries(REVIEW_LABELS) as Array<['true' | 'false', string]>).map(
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

      {/*
        Search applies on SUBMIT, not per keystroke: each filter change starts a
        fresh cursor chain, and all /api traffic shares one IP-keyed limiter of
        100 requests a minute — behind the §11.9 same-origin rewrite a whole
        office can present as a single IP.

        `flex-wrap` is load-bearing, not tidiness: the input and its button
        cannot both shrink below their content, and side by side they are wider
        than this strip at a 320px viewport — which would push the PAGE
        sideways, since only `TableFrame` is allowed to scroll horizontally.
        Wrapping drops the button onto its own line instead.
      */}

      {hasActiveFilters(value) ? (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            // The draft as well as the applied term: `q` may already be '',
            // in which case the sync above will not fire.
            setDraft('');
            onChange(EMPTY_DOCUMENT_FILTERS);
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </Toolbar>
  );
}
