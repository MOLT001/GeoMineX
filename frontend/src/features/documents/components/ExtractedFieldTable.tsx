'use client';

import { useState, type ReactNode } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock, StatusMessage } from '@/components/ui/Feedback';
import { SourceLinkIcon } from '@/components/ui/Icon';
import { ProseText, Section } from '@/components/ui/Layout';
import { ReviewRequiredFlag, isDocumentPending } from '@/components/ui/StatusBadge';
import { TBody, TD, TH, THead, TR, TableFrame } from '@/components/ui/Table';
import { useExtractedFields, type Document, type ExtractedField } from '@/features/documents/api';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/datetime';
import { pivotFields } from '../pivot';
import { FieldOverrideDialog } from './FieldOverrideDialog';

/**
 * The figures pulled out of one document — PRD §5.4.
 *
 * This table is the product's central claim made visible: every figure carries
 * the page it came from, the extractor's confidence in it, and whoever changed
 * it and why. A number here with no provenance beside it is the thing §13 calls
 * a traceability failure.
 */
export function ExtractedFieldTable({ doc }: { doc: Document }) {
  const { user } = useAuth();

  /**
   * Nothing invalidates this key when the worker finishes — only a retry does —
   * so fetching while the document is still queued would cache an empty array
   * that outlives the extraction. Gate on the document being at rest.
   */
  const stillProcessing = isDocumentPending(doc.status);
  const { data, isPending, error, refetch } = useExtractedFields(doc.id, {
    enabled: !stillProcessing,
  });

  const [editing, setEditing] = useState<ExtractedField | null>(null);
  const [savedFieldName, setSavedFieldName] = useState<string | null>(null);

  const fields = data ?? [];
  const mayOverride = can(user, 'field:override');

  /**
   * A reprocess deletes only the fields nobody overrode and re-inserts the full
   * fresh set, so a corrected row can sit beside a new machine row of the same
   * name. Say so when it happens rather than letting the pair read as a bug.
   */
  const hasDuplicateNames = new Set(fields.map((field) => field.fieldName)).size !== fields.length;

  let body: ReactNode;
  if (stillProcessing) {
    body = (
      <EmptyState
        title="Extraction is still running"
        description="Figures appear here once the extractor finishes with this document."
      />
    );
  } else if (error) {
    body = <ErrorState error={error} onRetry={() => void refetch()} />;
  } else if (isPending) {
    // Reached only when the query is enabled — a disabled query reports
    // `isPending` forever, which is why the gate above is tested first.
    body = <LoadingBlock label="Loading extracted figures" rows={4} />;
  } else if (fields.length === 0) {
    body = <EmptyState title="No figures were extracted" description={emptyExplanation(doc)} />;
  } else {
    const { groups, loose } = pivotFields(fields);
    const openEditor = (field: ExtractedField) => {
      setSavedFieldName(null);
      setEditing(field);
    };

    body = (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-text-muted">
          {fields.length.toLocaleString('en-IN')} {fields.length === 1 ? 'figure' : 'figures'}
          {hasDuplicateNames
            ? ' · some field names appear twice. Reprocessing keeps a corrected row and adds a fresh machine row beside it, so read the provenance column to tell them apart.'
            : ''}
        </p>

        {/*
          One table per statement, laid out the way the filing prints it: the
          line item down the side, the periods across the top. A results row
          states the same measure for four periods, and the comparison between
          them IS the statement — a flat list of four rows that look like
          duplicates hides exactly what a reader came for.
        */}
        {groups.map((group) => (
          <div key={group.statement} className="flex flex-col gap-2">
            <h3 className="font-serif text-lg font-semibold text-primary-dark">
              {group.statement}
            </h3>
            <TableFrame
              caption={`${group.statement} figures extracted from ${doc.originalFilename}`}
            >
              <THead>
                <tr>
                  <TH>Particulars</TH>
                  {group.periods.map((period) => (
                    // `whitespace-normal`: a period reads "Quarter ended June
                    // 30,2025 Un Audited", which must wrap rather than force
                    // four columns off the side of the card.
                    <TH key={period}>
                      <span className="block max-w-40 whitespace-normal">{period}</span>
                    </TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {group.rows.map((row) => (
                  <TR key={row.name}>
                    <TD className="w-64">
                      <ProseText className="font-medium">{row.name}</ProseText>
                    </TD>
                    {row.cells.map((field, index) => (
                      <TD key={group.periods[index] ?? index}>
                        {field ? (
                          <FigureCell
                            field={field}
                            period={group.periods[index] ?? ''}
                            mayOverride={mayOverride}
                            onCorrect={openEditor}
                          />
                        ) : (
                          // The filing prints nothing here. An empty cell says
                          // that; a dash or a zero would invent a figure.
                          <span aria-hidden className="text-text-muted">
                            &nbsp;
                          </span>
                        )}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </TableFrame>
          </div>
        ))}

        {/*
          Everything that is not a cell in a period table: document metadata
          like the DIN, and any figure whose period could not be established —
          which must NOT be filed under a column that was guessed for it.
        */}
        {loose.length > 0 ? (
          <div className="flex flex-col gap-2">
            {groups.length > 0 ? (
              <h3 className="font-serif text-lg font-semibold text-primary-dark">
                Other extracted values
              </h3>
            ) : null}
            <TableFrame caption={`Other figures extracted from ${doc.originalFilename}`}>
              <THead>
                <tr>
                  <TH>Field</TH>
                  <TH>Value</TH>
                  <TH>Confidence</TH>
                  <TH>Source</TH>
                  <TH>Provenance</TH>
                  {mayOverride ? (
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  ) : null}
                </tr>
              </THead>
              <TBody>
                {/* Keyed on `id`, never `fieldName` — see the duplicate note above. */}
                {loose.map((field) => (
                  <TR key={field.id}>
                    <TD className="w-48">
                      <ProseText className="font-medium">{field.fieldName}</ProseText>
                    </TD>

                    <TD>
                      <ProseText>{field.value}</ProseText>
                      {/*
                        Non-null only after an override, and it holds the FIRST
                        machine value for ever — repeat corrections never clobber
                        it.
                      */}
                      {field.originalValue === null ? null : (
                        <div className="mt-2">
                          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">
                            Machine value
                          </p>
                          <ProseText>{field.originalValue}</ProseText>
                        </div>
                      )}
                    </TD>

                    <TD>
                      <span className="tabular-nums">
                        {Math.round(field.confidenceScore * 100)}%
                      </span>
                      {field.requiresReview ? (
                        <span className="mt-1 block">
                          <ReviewRequiredFlag />
                        </span>
                      ) : null}
                    </TD>

                    <TD>
                      <SourcePage field={field} />
                    </TD>

                    <TD>
                      {field.overriddenAt === null ? (
                        <span className="text-text-muted">As extracted</span>
                      ) : (
                        <>
                          <p className="text-xs text-text-muted">
                            Corrected {formatDateTime(field.overriddenAt)}
                          </p>
                          {field.overrideReason ? (
                            <ProseText>{field.overrideReason}</ProseText>
                          ) : null}
                        </>
                      )}
                    </TD>

                    {mayOverride ? (
                      <TD>
                        <Button variant="secondary" size="sm" onClick={() => openEditor(field)}>
                          Correct
                          <span className="sr-only"> {field.fieldName}</span>
                        </Button>
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </TableFrame>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Section
      id="extracted-fields"
      title="Extracted figures"
      description="Every figure the extractor read out of this document, with the page it came from and any human correction."
    >
      {savedFieldName ? (
        <StatusMessage>
          “{savedFieldName}” updated. The machine value is kept beside yours.
        </StatusMessage>
      ) : null}

      {body}

      {editing ? (
        <FieldOverrideDialog
          field={editing}
          documentId={doc.id}
          onClose={() => setEditing(null)}
          onSaved={setSavedFieldName}
        />
      ) : null}
    </Section>
  );
}

/**
 * One figure in a period column.
 *
 * A matrix cannot carry the flat table's five columns of provenance without
 * becoming unreadable, so the cell shows the NUMBER and marks only what departs
 * from the ordinary: a figure the extractor wants checked, and a figure a human
 * has corrected. Everything else — confidence, page, period — is on the
 * accessible name, so a screen reader gets the full provenance that sighted
 * readers get from the row and column they are reading along.
 *
 * The value itself is the control. Two hundred `Correct` buttons in a grid is
 * not a table any more, and a figure is exactly the thing you want to click
 * when you disagree with it.
 */
function FigureCell({
  field,
  period,
  mayOverride,
  onCorrect,
}: {
  field: ExtractedField;
  period: string;
  mayOverride: boolean;
  onCorrect: (field: ExtractedField) => void;
}) {
  const corrected = field.overriddenAt !== null;
  const description =
    `${field.value}, ${period}, ${Math.round(field.confidenceScore * 100)}% confidence` +
    (field.sourceLocation?.pageNumber ? `, page ${field.sourceLocation.pageNumber}` : '') +
    (corrected ? ', corrected by a reviewer' : '') +
    (field.requiresReview ? ', needs review' : '');

  const value = (
    <span
      className={cn(
        'tabular-nums',
        // A corrected figure is not the machine's any more, and it should not
        // read as though it were.
        corrected && 'font-semibold text-primary-dark',
      )}
    >
      {field.value}
    </span>
  );

  return (
    <span className="flex flex-col items-end gap-1 text-right">
      {mayOverride ? (
        <button
          type="button"
          onClick={() => onCorrect(field)}
          className="rounded-sm underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
        >
          {value}
          <span className="sr-only"> — correct {field.fieldName}: {description}</span>
        </button>
      ) : (
        <span>
          {value}
          <span className="sr-only"> — {field.fieldName}: {description}</span>
        </span>
      )}

      {field.requiresReview ? <ReviewRequiredFlag /> : null}

      {corrected ? (
        <span className="text-xs text-text-muted">
          Corrected
          {field.originalValue === null ? null : (
            <>
              {' · was '}
              <span className="tabular-nums">{field.originalValue}</span>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Where the figure came from.
 *
 * `sourceLocation.chunkIndex` is deliberately not shown and not linked: the
 * bundled provider hard-codes it to 0 for every field, so it is not a pointer
 * into the text below and a "jump to source" control built on it would send
 * every figure to the same paragraph.
 */
function SourcePage({ field }: { field: ExtractedField }) {
  const page = field.sourceLocation?.pageNumber;
  const section = field.sourceLocation?.section;

  // Absent for .csv and .txt, whose text path never attaches a page — not an
  // error, and not something a reader should have to interpret as one.
  if (page === undefined && !section) {
    return <span className="text-text-muted">Not recorded</span>;
  }

  return (
    <span className="flex flex-col gap-0.5">
      {page === undefined ? null : (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <SourceLinkIcon size={14} />
          Page <span className="tabular-nums">{page}</span>
        </span>
      )}

      {/*
        The statement and period the figure was read from — "Standalone ·
        Quarter ended June 30,2025 Un Audited".

        Not decoration. A results filing states the same row for two statements
        and four periods, so a page number alone does not identify a figure: the
        row it points at holds four numbers, and the page holds the label twice.
        Without this, two rows of this table read as exact duplicates that
        happen to disagree, which is precisely the traceability failure §4.5
        exists to prevent. Omitted entirely when the extractor could not
        establish it, rather than shown as an empty or guessed value.
      */}
      {section ? (
        <span className="text-xs leading-snug text-text-muted">{section}</span>
      ) : null}
    </span>
  );
}

/**
 * Why a settled document can hold no figures at all.
 *
 * For a VALIDATED document this is the EXPECTED outcome for every image, `.tif`
 * scan and `.xlsx`, and for any scanned or encrypted PDF: it still reaches
 * 'validated' and is flagged for review. Rendering that as a failure would send
 * people chasing a bug that is not there — and describing a genuine failure as
 * one of those cases does the reverse.
 */
function emptyExplanation(doc: Document): string {
  /*
    A failed document is empty for a different reason, and it has to be said
    first: the extractor never finished, so none of the "this is the expected
    outcome" copy below is true of it. Telling someone the extractor found
    nothing it recognised, when it in fact crashed, sends them looking at the
    document instead of at the failure the status card is already reporting.
  */
  if (doc.status === 'failed') {
    return 'Extraction did not finish for this document, so nothing was pulled out of it. The status above says what happened; where a retry is still available it is the only way to produce figures.';
  }
  if (doc.type === 'image' || doc.type === 'scan') {
    return 'The extractor reads text, not pictures, so an image or a .tif scan finishes with nothing extracted. The document is still validated, and it is flagged for review so a person reads it against the original.';
  }
  if (doc.ocrConfidence === 0) {
    return 'No readable text was found in this file — the usual cause is a scanned or encrypted PDF. It is validated and flagged for review; download the original below to read the figures yourself.';
  }
  return 'The extractor found no figures it recognised in this document. Spreadsheet workbooks and image-only files always land here; otherwise the text may not contain anything shaped like a labelled figure.';
}
