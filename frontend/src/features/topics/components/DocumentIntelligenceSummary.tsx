'use client';

import Link from 'next/link';
import { InlineError, LoadingBlock } from '@/components/ui/Feedback';
import { Section } from '@/components/ui/Layout';
import { useTopicAnalytics } from '@/features/topics/api';
import { topicHref } from './TopicChip';

/**
 * "Document intelligence" on the dashboard — §14.
 *
 * ─── A RANKED BAR LIST, NOT A CHART ─────────────────────────────────────────
 * §14 asks for topic distribution and warns against clutter in the same breath.
 * A pie or a donut of eight topics needs a legend, a palette of eight colours
 * the design system does not have, and a reader who can distinguish all eight —
 * and it still answers "which is biggest" worse than a sorted list does. The
 * bar is proportional to the leader, so the shape carries the distribution and
 * the number carries the value; neither depends on colour.
 *
 * ─── COVERAGE IS STATED, NOT IMPLIED ────────────────────────────────────────
 * `analysedDocuments` can trail `totalDocuments` — documents that predate this
 * feature, and documents still in the queue. Printing the top topics without
 * saying what fraction of the corpus they were drawn from would present a
 * partial count as a complete one, which is the sort of quiet overstatement
 * §4.6 exists to prevent.
 */
export function DocumentIntelligenceSummary({ subsidiaryId }: { subsidiaryId?: string }) {
  const { data, isPending, error } = useTopicAnalytics({ subsidiaryId, limit: 6 });

  const analytics = data?.analytics;
  const leader = analytics?.topTopics[0]?.documentCount ?? 0;

  return (
    <Section
      id="intelligence"
      title="Document intelligence"
      description="The subjects appearing most often across the documents you can see."
      actions={
        <Link href="/topics" className="text-sm font-medium text-sih-blue hover:underline">
          All topics
        </Link>
      }
    >
      {isPending ? (
        <LoadingBlock label="Loading topics" rows={3} />
      ) : error ? (
        <InlineError>Topic analytics could not be loaded.</InlineError>
      ) : !analytics || analytics.topTopics.length === 0 ? (
        <p className="text-sm text-text-muted">
          No subjects yet. Topics appear once documents have been uploaded and processed.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {analytics.topTopics.map((topic) => (
              <li key={topic.topicId}>
                <Link
                  href={topicHref(topic.topicId)}
                  className="group flex items-center gap-3 text-sm"
                >
                  <span className="w-44 shrink-0 truncate font-medium text-text-default group-hover:text-sih-blue">
                    {topic.label}
                  </span>
                  {/*
                    The bar is decoration for a number that is already printed,
                    so it is hidden from assistive technology rather than given
                    a redundant label to read out.
                  */}
                  <span aria-hidden="true" className="h-2 min-w-1 flex-1 bg-surface-muted">
                    <span
                      className="block h-full bg-sih-blue"
                      style={{
                        width: `${leader > 0 ? Math.max(4, Math.round((topic.documentCount / leader) * 100)) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right text-text-muted tabular-nums">
                    {topic.documentCount}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <p className="text-sm text-text-muted">
            {/*
              `analysedDocuments` counts documents that have an extraction
              record of any kind, including ones found to have too little text
              to have a subject — so it is coverage of the ANALYSIS, not of the
              topic list above.
            */}
            Drawn from {analytics.analysedDocuments} of {analytics.totalDocuments} document
            {analytics.totalDocuments === 1 ? '' : 's'}
            {analytics.analysedDocuments < analytics.totalDocuments
              ? '. The rest were uploaded before topic analysis existed, or are still being processed.'
              : '.'}
          </p>
        </div>
      )}
    </Section>
  );
}
