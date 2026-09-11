'use client';

import Link from 'next/link';
import { InlineError, LoadingBlock } from '@/components/ui/Feedback';
import { Card, Section } from '@/components/ui/Layout';
import type { Document } from '@/features/documents/api';
import { useRelatedDocuments } from '@/features/topics/api';
import { formatRelative } from '@/lib/datetime';
import { TopicChip } from './TopicChip';

/**
 * "Related documents" — §17.
 *
 * ─── IT IS TOPIC OVERLAP, AND IT SAYS SO ────────────────────────────────────
 * §17 lists "semantic similarity" among the signals to combine. There is no
 * embedding model in this system, so this is weighted topic overlap and nothing
 * else, and the description below says that in the user's words rather than
 * implying a capability that does not exist. Weighted matters: sharing the
 * document's LEADING subject counts for more than sharing a marginal one, which
 * is why a percentage is shown at all.
 *
 * The panel renders nothing when there is nothing to show. An empty "Related
 * documents" card on every one-of-a-kind filing is noise on a page that is
 * already dense (§18), and the absence is not information the reader needs.
 */
export function RelatedDocuments({ doc }: { doc: Document }) {
  const enabled = doc.status === 'validated';
  const related = useRelatedDocuments(doc.id, { enabled });

  // Nothing at all until there is something to say — including while loading,
  // so the section does not appear and then vanish on a document with no peers.
  if (!enabled || (!related.isPending && !related.error && (related.data?.length ?? 0) === 0)) {
    return null;
  }

  return (
    <Section
      id="related"
      title="Related documents"
      description="Earlier documents that share this one’s subjects."
    >
      <Card>
        {related.isPending ? (
          <LoadingBlock label="Finding related documents" rows={2} />
        ) : related.error ? (
          <InlineError>Related documents could not be loaded.</InlineError>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {(related.data ?? []).map((item) => (
              <li key={item.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <Link
                    href={`/documents/${item.id}`}
                    // A filename can arrive as 255 unbroken characters, so it
                    // must be allowed to break or it pushes the page sideways.
                    className="min-w-0 font-medium break-words text-sih-blue hover:underline"
                  >
                    {item.originalFilename}
                  </Link>
                  <span className="shrink-0 text-sm text-text-muted tabular-nums">
                    {/*
                      Worded as overlap, not as similarity: it is the share of
                      THIS document's topic weight the two have in common, and
                      calling it similarity would claim a measurement that was
                      never taken.
                    */}
                    {Math.round(item.similarity * 100)}% topic overlap
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.sharedTopics.slice(0, 4).map((topic) => (
                    <TopicChip key={topic.topicId} label={topic.label} />
                  ))}
                  <span className="text-sm text-text-muted">
                    uploaded {formatRelative(item.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}
