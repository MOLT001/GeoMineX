'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SubsidiaryPicker } from '@/components/SubsidiaryPicker';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { Field, Select } from '@/components/ui/Field';
import { GridIcon } from '@/components/ui/Icon';
import { Card, PageHeader, Section, Toolbar } from '@/components/ui/Layout';
import {
  categoryLabel,
  useTopicAnalytics,
  useTopicCatalog,
  type CatalogTopic,
} from '@/features/topics/api';
import { TopicChip, topicHref } from '@/features/topics/components/TopicChip';
import { formatRelative } from '@/lib/datetime';

/**
 * Topic Explorer — §13.
 *
 * ─── WHY THIS SCREEN EXISTS AND THE WORD CLOUD DOES NOT ─────────────────────
 * An earlier version of this route was a word cloud built from raw term
 * frequencies, and it was removed because it did not answer a question anyone
 * had: in a CIL corpus the largest words are always `coal`, `production` and
 * `mine`, which is a fact about the corpus rather than about anything in it.
 *
 * This is the replacement, and §15 endorses the trade explicitly — a word cloud
 * is optional, and "if the existing UI does not need a word cloud, prioritise
 * useful topic analytics instead". A counted, sortable, clickable list of
 * subjects is the same information with the decoration removed, and every row
 * leads somewhere: to the documents carrying that topic.
 *
 * ─── WHAT EACH NUMBER MEANS ─────────────────────────────────────────────────
 * `documentCount` is documents carrying the topic at all. `primaryCount` is
 * documents whose LEADING subject it is. The two differ a lot for a topic like
 * Coal Production, which almost every filing mentions and few are about — and
 * showing only the first would make that topic look like the corpus's main
 * concern when it is its background.
 */

type SortMode = 'documents' | 'primary' | 'recent';

const SORT_LABELS: Record<SortMode, string> = {
  documents: 'Most documents',
  primary: 'Most often the main subject',
  recent: 'Most recently seen',
};

/**
 * The catalogue is capped server-side; this is the cap the page asks for.
 * Well above the taxonomy's own size, so a full corpus is shown whole and the
 * limit only ever bites on discovered topics.
 */
const CATALOG_LIMIT = 60;

export default function TopicsPage() {
  const [subsidiaryId, setSubsidiaryId] = useState('');
  const [sort, setSort] = useState<SortMode>('documents');
  const [includeDiscovered, setIncludeDiscovered] = useState(true);

  const catalog = useTopicCatalog({
    subsidiaryId: subsidiaryId || undefined,
    limit: CATALOG_LIMIT,
    includeDiscovered,
  });
  const analytics = useTopicAnalytics({ subsidiaryId: subsidiaryId || undefined, limit: 6 });

  const topics = sortTopics(catalog.data?.topics ?? [], sort);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        icon={<GridIcon size={24} strokeWidth={2} />}
        title="Topics"
        description="What the documents in your scope are about, from the subjects extracted when each one was processed."
      />

      <Toolbar>
        <div className="min-w-52 flex-1">
          <SubsidiaryPicker value={subsidiaryId} onChange={setSubsidiaryId} allowAll />
        </div>
        <div className="min-w-52 flex-1">
          <Field label="Sort by">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={sort}
                onChange={(next) => setSort(next as SortMode)}
              >
                {(Object.entries(SORT_LABELS) as [SortMode, string][]).map(([mode, label]) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="min-w-52 flex-1">
          <Field
            label="Vocabulary"
            description="Curated subjects, or those plus phrases found in your documents"
          >
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={includeDiscovered ? 'all' : 'curated'}
                onChange={(next) => setIncludeDiscovered(next === 'all')}
              >
                <option value="all">Everything</option>
                <option value="curated">Curated subjects only</option>
              </Select>
            )}
          </Field>
        </div>
      </Toolbar>

      {analytics.data ? (
        <Section
          id="emerging"
          title="Emerging subjects"
          description="Topics appearing in more documents over the last 90 days than in the 90 before."
        >
          <Card>
            {analytics.data.analytics.emergingTopics.length === 0 ? (
              <p className="text-sm text-text-muted">
                Nothing has moved enough to report. This is the usual reading for a corpus with a
                steady mix of filings, or one without 180 days of history yet.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {analytics.data.analytics.emergingTopics.map((topic) => (
                  <li key={topic.topicId}>
                    <TopicChip
                      label={topic.label}
                      href={topicHref(topic.topicId)}
                      count={topic.recent}
                      // A count difference, not a percentage: the previous
                      // window is often zero, and a percentage against zero is
                      // either infinite or invented.
                      title={`${topic.recent} in the last 90 days, ${topic.previous} in the 90 before`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Section>
      ) : null}

      <Section
        id="catalog"
        title="All subjects"
        description={
          catalog.data
            ? `${topics.length} subject${topics.length === 1 ? '' : 's'} across the documents you can see`
            : undefined
        }
      >
        {catalog.isPending ? (
          <LoadingBlock label="Loading topics" rows={5} />
        ) : catalog.error ? (
          <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : topics.length === 0 ? (
          <EmptyState
            title="No topics yet"
            description="Topics appear once documents have been uploaded and processed. Documents uploaded before this feature was added can be analysed from their detail page."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {topics.map((topic) => (
              <TopicCard key={topic.topicId} topic={topic} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/**
 * Sorted in the browser, over a list the server has already capped.
 *
 * The cap is applied by document count server-side, so re-sorting here reorders
 * the same rows rather than selecting different ones — which is worth knowing:
 * "most recently seen" shows the newest among the most common topics, not the
 * newest overall. At the catalogue's size those are the same set.
 */
function sortTopics(topics: CatalogTopic[], sort: SortMode): CatalogTopic[] {
  const sorted = [...topics];
  if (sort === 'primary') {
    sorted.sort((a, b) => b.primaryCount - a.primaryCount || b.documentCount - a.documentCount);
  } else if (sort === 'recent') {
    sorted.sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
  } else {
    sorted.sort((a, b) => b.documentCount - a.documentCount || a.label.localeCompare(b.label));
  }
  return sorted;
}

function TopicCard({ topic }: { topic: CatalogTopic }) {
  return (
    <Card title={<span className="flex items-center justify-between gap-2">
      <Link href={topicHref(topic.topicId)} className="min-w-0 truncate hover:underline">
        {topic.label}
      </Link>
      <span className="shrink-0 text-sm font-normal text-text-muted">
        {categoryLabel(topic.category)}
      </span>
    </span>}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">
          <Link href={topicHref(topic.topicId)} className="font-medium text-sih-blue hover:underline">
            {topic.documentCount} document{topic.documentCount === 1 ? '' : 's'}
          </Link>
          {/*
            Only stated when it differs. On a topic where every mention is the
            main subject, repeating the same number twice reads as a mistake.
          */}
          {topic.primaryCount !== topic.documentCount ? (
            <> · main subject of {topic.primaryCount}</>
          ) : null}
          {topic.lastSeenAt ? <> · last seen {formatRelative(topic.lastSeenAt)}</> : null}
        </p>

        {topic.recentDocuments.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold tracking-wide text-text-muted uppercase">Recent</h4>
            <ul className="mt-1 flex flex-col gap-0.5">
              {topic.recentDocuments.map((doc) => (
                <li key={doc.id} className="min-w-0">
                  <Link
                    href={`/documents/${doc.id}`}
                    title={doc.originalFilename}
                    className="block truncate text-sm text-sih-blue hover:underline"
                  >
                    {doc.originalFilename}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {topic.relatedTopics.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              Appears with
            </h4>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {topic.relatedTopics.map((related) => (
                <li key={related.topicId}>
                  <TopicChip
                    label={related.label}
                    href={topicHref(related.topicId)}
                    title={
                      /*
                        Zero means the link comes from the curated taxonomy
                        rather than from these documents. Saying so is the
                        difference between a measurement and a suggestion.
                      */
                      related.sharedDocuments > 0
                        ? `${related.sharedDocuments} document${related.sharedDocuments === 1 ? '' : 's'} carry both`
                        : 'Related subject — not yet seen together in your documents'
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
