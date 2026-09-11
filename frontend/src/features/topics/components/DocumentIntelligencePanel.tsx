'use client';

import { useAuth } from '@/auth/AuthProvider';
import { can } from '@/auth/permissions';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { InlineError, LoadingBlock, StatusMessage } from '@/components/ui/Feedback';
import { RefreshIcon } from '@/components/ui/Icon';
import { Card, ProseText, Section } from '@/components/ui/Layout';
import type { Document } from '@/features/documents/api';
import {
  INTELLIGENCE_STATUS_LABELS,
  categoryLabel,
  useDocumentIntelligence,
  useReprocessTopics,
  type DocumentIntelligence,
  type IntelligenceStatus,
  type ScoredTerm,
} from '@/features/topics/api';
import { formatDateTime } from '@/lib/datetime';
import { TopicChip, topicHref } from './TopicChip';

/**
 * Document intelligence — §12.
 *
 * ─── WHY THIS IS NOT LABELLED "AI" ──────────────────────────────────────────
 * §12 names the panel "AI Document Intelligence", and the label is dropped
 * deliberately. Nothing behind it calls a model: topics are scored against a
 * curated mining taxonomy weighted by inverse document frequency, and the
 * summary is sentences SELECTED verbatim from the document. It is offline,
 * deterministic and reproducible.
 *
 * Calling that "AI" invites a question the panel would then have to answer, and
 * the true answer is the better one for a government deployment — the analysis
 * runs on this server and no document text reaches a third party. So the page
 * says that instead of implying the opposite.
 *
 * Mounted on the document detail page beneath the extracted figures, because
 * that is the order the reader needs: the figures are what the document SAYS,
 * and this is what it is ABOUT.
 *
 * ─── IT IS GATED ON THE DOCUMENT BEING AT REST ──────────────────────────────
 * Extraction is the last step of the ingestion worker, so asking for it while
 * the document is still queued or processing caches a `pending` record for as
 * long as the query's stale time — and nothing invalidates it when the worker
 * finishes. Same gate the chunk and extracted-field panels use, same reason.
 *
 * ─── WHAT IS DELIBERATELY NOT SHOWN ─────────────────────────────────────────
 * `relevance` is a within-document ranking and is meaningless between
 * documents, so no percentage is printed against a topic. The ORDER carries it,
 * and the leading topic is filled rather than numbered.
 */

/** Only these two carry a subject worth showing; the rest are explained instead. */
const HAS_CONTENT: ReadonlySet<IntelligenceStatus> = new Set(['extracted', 'low_quality']);

const STATUS_TONE: Record<IntelligenceStatus, 'success' | 'warning' | 'danger' | 'progress' | 'pending'> = {
  pending: 'pending',
  processing: 'progress',
  extracted: 'success',
  // Not a failure — the document was read, there was simply too little of it.
  insufficient_text: 'pending',
  low_quality: 'warning',
  failed: 'danger',
};

/**
 * How each state reads to someone who will not be told the schema.
 *
 * `insufficient_text` gets the longest explanation because it is the one most
 * likely to be mistaken for a bug: the document processed fine, the figures are
 * there, and this panel is empty.
 */
const STATUS_EXPLANATION: Partial<Record<IntelligenceStatus, string>> = {
  pending:
    'This document has not been analysed for topics. Documents uploaded before this feature was added are analysed on request.',
  processing: 'Topic analysis is running.',
  insufficient_text:
    'The document was read successfully, but it holds too little text to say what it is about. Covering letters, forms and mostly-numeric returns often land here.',
  failed: 'Topic analysis did not complete. Re-running it is safe — it does not re-read the file.',
};

export function DocumentIntelligencePanel({ doc }: { doc: Document }) {
  const { user } = useAuth();
  // Extraction runs at the END of processing, so there is nothing to read until
  // the document is validated — and a `failed` document has no text at all.
  const enabled = doc.status === 'validated';

  const intelligence = useDocumentIntelligence(doc.id, { enabled });
  const reprocess = useReprocessTopics();
  const mayReprocess = can(user, 'document:retry') && enabled;

  const data = intelligence.data;

  return (
    <Section
      id="intelligence"
      title="Document intelligence"
      description="What this document is about, derived from its own text when it was processed. Analysed on this server — no document text is sent to an external service."
      actions={
        mayReprocess ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshIcon size={14} />}
            disabled={reprocess.isPending}
            onClick={() => reprocess.mutate(doc.id)}
          >
            {reprocess.isPending ? 'Re-analysing…' : 'Re-analyse'}
          </Button>
        ) : null
      }
    >
      <Card>
        {!enabled ? (
          <StatusMessage>
            Topics are extracted once a document has finished processing.
          </StatusMessage>
        ) : intelligence.isPending ? (
          <LoadingBlock label="Loading topics" rows={2} />
        ) : intelligence.error ? (
          <InlineError>Topics could not be loaded.</InlineError>
        ) : data ? (
          <IntelligenceBody data={data} />
        ) : null}

        {reprocess.error ? <InlineError>Re-analysis failed. Please try again.</InlineError> : null}
      </Card>
    </Section>
  );
}

function IntelligenceBody({ data }: { data: DocumentIntelligence }) {
  const explanation = STATUS_EXPLANATION[data.status];
  const showContent = HAS_CONTENT.has(data.status) && data.primaryTopic !== null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[data.status]}>{INTELLIGENCE_STATUS_LABELS[data.status]}</Badge>
        {showContent ? (
          <span className="text-sm text-text-muted">
            {/*
              Confidence is a property of the ANALYSIS — how well the page was
              read, how much text there was, how much of it was recognisable
              vocabulary. It is not a claim about the topics being correct, so
              it is worded as a reading rather than as a score.
            */}
            Confidence {Math.round(data.confidence * 100)}%
          </span>
        ) : null}
        {data.extractedAt ? (
          <span className="text-sm text-text-muted">Analysed {formatDateTime(data.extractedAt)}</span>
        ) : null}
      </div>

      {explanation ? <p className="text-sm text-text-muted">{explanation}</p> : null}
      {/* The server's message, rendered as text. It is non-sensitive by contract. */}
      {data.error ? <InlineError>{data.error}</InlineError> : null}

      {showContent ? (
        <>
          <Group label="Primary topic">
            <TopicChip
              label={data.primaryTopic!.label}
              href={topicHref(data.primaryTopic!.topicId)}
              discovered={data.primaryTopic!.discovered}
              primary
            />
            <span className="text-sm text-text-muted">
              {categoryLabel(data.primaryTopic!.category)}
            </span>
          </Group>

          {data.secondaryTopics.length > 0 ? (
            <Group label="Related topics">
              {data.secondaryTopics.map((topic) => (
                <TopicChip
                  key={topic.topicId}
                  label={topic.label}
                  href={topicHref(topic.topicId)}
                  discovered={topic.discovered}
                  title={
                    // The wordings the document actually used. This is what
                    // separates a chip from a guess: the reader can check it.
                    topic.matchedTerms.length > 0
                      ? `Found as: ${topic.matchedTerms.join(', ')}`
                      : topic.label
                  }
                />
              ))}
            </Group>
          ) : null}

          {data.technicalTerms.length > 0 ? (
            <Group
              label="Key terms"
              description="The document’s own wording, kept rather than replaced with a general word."
            >
              <TermList terms={data.technicalTerms} />
            </Group>
          ) : null}

          {data.keywords.length > 0 ? (
            <Group label="Keywords">
              <TermList terms={data.keywords} />
            </Group>
          ) : null}

          {data.summary ? (
            <Group
              label="Summary"
              description="Sentences selected from the document, word for word — nothing here was written by the system."
            >
              {/* A plain string from the server. Rendered as a text node. */}
              <ProseText className="text-sm">{data.summary}</ProseText>
            </Group>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * A labelled row. Uses a `<h3>` rather than a bare span so the panel is
 * navigable by heading — this is the densest block on the page.
 */
function Group({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</h3>
      {description ? <p className="text-sm text-text-muted">{description}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * Terms as plain text rather than chips.
 *
 * Chips are for topics, which are navigable. A keyword is not a filter — there
 * is no keyword endpoint to link to — and chipping it would promise an action
 * that does not exist. `domain` marks curated mining vocabulary; a free phrase
 * is dimmed rather than hidden, so the reader can see which is which.
 */
function TermList({ terms }: { terms: ScoredTerm[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {terms.map((term) => (
        <li
          key={term.term}
          className={term.domain ? 'text-sm text-text-default' : 'text-sm text-text-muted'}
          title={`Appears ${term.count} time${term.count === 1 ? '' : 's'}`}
        >
          {term.term}
        </li>
      ))}
    </ul>
  );
}
