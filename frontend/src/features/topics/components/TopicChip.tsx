import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * A topic, as a chip.
 *
 * §18 asks for "clean tags/chips rather than huge decorative elements", and
 * that rules out the obvious treatment: a chip sized or tinted by relevance.
 * A word cloud sized by weight is precisely the decorative pattern the whole
 * feature was specified against, and at chip scale a 12% difference in font
 * size is unreadable anyway — it reads as inconsistent spacing, not as data.
 *
 * So relevance is carried by ORDER and, on the leading topic, by a filled chip.
 * Everything else is one flat, quiet object, like the tags already on the
 * document detail page.
 *
 * A discovered topic — a phrase the extractor found that the curated taxonomy
 * does not know — is marked with a dotted edge rather than a colour, because it
 * is a statement about PROVENANCE and the palette is already spent on status.
 */
export function TopicChip({
  label,
  href,
  primary = false,
  discovered = false,
  count,
  title,
  className,
}: {
  label: string;
  /** Makes the chip a link into the filtered document list. */
  href?: string;
  primary?: boolean;
  discovered?: boolean;
  /** Documents carrying this topic, for the catalogue. Omitted on a document. */
  count?: number;
  title?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="truncate">{label}</span>
      {count === undefined ? null : (
        <span
          className={cn(
            'shrink-0 rounded-sm px-1 text-xs tabular-nums',
            primary ? 'bg-surface/25' : 'bg-surface-muted',
          )}
        >
          {count}
        </span>
      )}
    </>
  );

  const classes = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-sm',
    primary
      ? 'border-primary-dark bg-primary-dark font-medium text-white'
      : 'border-border bg-surface text-text-default',
    discovered && !primary && 'border-dashed',
    href && 'transition-colors hover:border-sih-blue hover:text-sih-blue',
    className,
  );

  // `title` defaults to the label, so a chip truncated by `max-w` can still be
  // read on hover. It is not a substitute for the text — the label is present.
  const tooltip = title ?? (discovered ? `${label} — found in your documents` : label);

  return href ? (
    <Link href={href} className={classes} title={tooltip}>
      {body}
    </Link>
  ) : (
    <span className={classes} title={tooltip}>
      {body}
    </span>
  );
}

/**
 * The link a topic chip points at: the document list, filtered.
 *
 * Built here rather than at each call site so every chip in the app agrees on
 * the parameter name — the API takes `topic`, repeated, and a chip that sent
 * `topicId` would 400 rather than filter.
 */
export function topicHref(topicId: string): string {
  return `/documents?topic=${encodeURIComponent(topicId)}`;
}
