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
import { formatDateTime } from '@/lib/datetime';
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
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">
          {fields.length.toLocaleString('en-IN')} {fields.length === 1 ? 'figure' : 'figures'}
          {hasDuplicateNames
            ? ' · some field names appear twice. Reprocessing keeps a corrected row and adds a fresh machine row beside it, so read the provenance column to tell them apart.'
            : ''}
        </p>

        <TableFrame caption={`Figures extracted from ${doc.originalFilename}`}>
          <THead>
            {/*
              A bare <tr>, not `TR`: that component paints every row
              `bg-surface` for the body, and layering it over THead's muted
              ground would leave two background utilities fighting in the class
              attribute — which source order in the stylesheet, not the markup,
              would settle.
            */}
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
            {fields.map((field) => (
              <TR key={field.id}>
                <TD className="w-48">
                  <ProseText className="font-medium">{field.fieldName}</ProseText>
                </TD>

                <TD>
                  <ProseText>{field.value}</ProseText>
                  {/*
                    Non-null only after an override, and it holds the FIRST
                    machine value for ever — repeat corrections never clobber
                    it. It is text lifted out of the document, so it goes
                    through `ProseText` like every other extracted string
                    rather than into a hand-rolled paragraph; the label carries
                    the de-emphasis that `ProseText` deliberately will not
                    accept as a class override.
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
                  {/*
                    A number and a flag, not a bar. The provider emits exactly
                    two scores today — 0.82 when the value looked numeric, 0.6
                    otherwise — so a meter would show two positions forever and
                    read as broken.
                  */}
                  <span className="tabular-nums">{Math.round(field.confidenceScore * 100)}%</span>
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
                      {field.overrideReason ? <ProseText>{field.overrideReason}</ProseText> : null}
                    </>
                  )}
                </TD>

                {mayOverride ? (
                  <TD>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSavedFieldName(null);
                        setEditing(field);
                      }}
                    >
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
 * Where the figure came from.
 *
 * `sourceLocation.chunkIndex` is deliberately not shown and not linked: the
 * bundled provider hard-codes it to 0 for every field, so it is not a pointer
 * into the text below and a "jump to source" control built on it would send
 * every figure to the same paragraph.
 */
function SourcePage({ field }: { field: ExtractedField }) {
  const page = field.sourceLocation?.pageNumber;

  // Absent for .csv and .txt, whose text path never attaches a page — not an
  // error, and not something a reader should have to interpret as one.
  if (page === undefined) return <span className="text-text-muted">Not recorded</span>;

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <SourceLinkIcon size={14} />
      Page <span className="tabular-nums">{page}</span>
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
