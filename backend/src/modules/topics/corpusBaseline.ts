/**
 * The corpus baseline — what makes "distinctive" mean anything.
 *
 * Scoring a document against nothing can only rank by frequency, and frequency
 * in a CIL corpus ranks `coal`, `production` and `mine` first for every
 * document ever filed. The baseline supplies the other half of the comparison:
 * how many documents ALREADY say this. A term two documents share is evidence;
 * a term nine hundred share is letterhead.
 *
 * ─── IT IS DERIVED, NOT A NEW COLLECTION ────────────────────────────────────
 * `wordFrequencies` already stores exactly one row per (term, source), which
 * means counting ROWS per term IS the document frequency — no distinct-count,
 * no second write path, no field to keep in sync. The existing indexer keeps it
 * current for free.
 *
 * ─── SCOPED TO THE SUBSIDIARY, DELIBERATELY ─────────────────────────────────
 * The baseline could be measured corpus-wide, which would be statistically
 * better with a small corpus. It is measured per subsidiary instead, because a
 * corpus-wide baseline would make one subsidiary's document scores depend on
 * another's contents — a weak channel, but a real one, and §9.5 does not make
 * exceptions for weak ones. The cost is that a subsidiary with too few
 * documents has no usable baseline, which `MIN_CORPUS_FOR_IDF` in the extractor
 * handles by falling back to domain weighting alone.
 *
 * ─── ONLY SHARED TERMS ARE STORED ───────────────────────────────────────────
 * Terms appearing in a single document are omitted. Their absence already means
 * "df 0", which yields the maximum idf — the correct answer for a rare term —
 * so storing them would grow the map by the whole long tail to say nothing.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { WordFrequency } from './wordFrequency.model.js';
import type { CorpusBaseline } from './topicExtraction.js';

/** A term shared by fewer than this many documents is left out — see above. */
const MIN_DOCUMENT_FREQUENCY = 2;

/**
 * Hard ceiling on the map, ordered by df descending.
 *
 * The truncated tail is the RAREST shared terms, whose absence costs them
 * nothing: they fall back to the maximum idf, which is within rounding of what
 * they would have scored anyway. Truncating the other end would silently stop
 * suppressing boilerplate, which is the entire job.
 */
const MAX_BASELINE_TERMS = 20_000;

interface CacheEntry {
  baseline: CorpusBaseline;
  expiresAt: number;
}

/**
 * In-process, per subsidiary. Not a Mongo cache collection: this is a hot,
 * cheap, purely derived map read by the ingestion worker, and a document that
 * scored against a baseline a few minutes stale ranks its own terms the same
 * way. The freshness that matters — a brand-new subsidiary crossing the
 * MIN_CORPUS_FOR_IDF floor — arrives within one TTL.
 */
const cache = new Map<string, CacheEntry>();

const EMPTY: CorpusBaseline = { documentCount: 0, documentFrequency: new Map() };

/**
 * Document frequencies for one subsidiary.
 *
 * Never throws. A baseline that cannot be read degrades scoring to domain
 * weight and phrase structure, which still produces sensible topics — losing
 * the corpus comparison must not fail an ingestion, the same contract
 * `termIndexer.ts` and `recordAudit` already hold.
 */
export async function getCorpusBaseline(subsidiaryId: Types.ObjectId): Promise<CorpusBaseline> {
  const key = String(subsidiaryId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.baseline;

  try {
    const [facet] = await WordFrequency.aggregate<{
      terms: { _id: string; df: number }[];
      documents: { n: number }[];
    }>([
      // Queries are indexed alongside documents in `wordFrequencies`, but a
      // question someone typed is not corpus evidence about what documents say.
      { $match: { sourceType: 'document', subsidiaryId, isDeleted: false } },
      {
        $facet: {
          terms: [
            { $group: { _id: '$term', df: { $sum: 1 } } },
            { $match: { df: { $gte: MIN_DOCUMENT_FREQUENCY } } },
            { $sort: { df: -1, _id: 1 } },
            { $limit: MAX_BASELINE_TERMS },
          ],
          documents: [{ $group: { _id: '$sourceId' } }, { $count: 'n' }],
        },
      },
    ]);

    const baseline: CorpusBaseline = {
      documentCount: facet?.documents[0]?.n ?? 0,
      documentFrequency: new Map((facet?.terms ?? []).map((t) => [t._id, t.df])),
    };

    cache.set(key, { baseline, expiresAt: Date.now() + env.TOPICS_CACHE_TTL_SECONDS * 1000 });
    return baseline;
  } catch (err) {
    logger.warn('Failed to compute the topic corpus baseline; scoring without it', {
      subsidiaryId: key,
      message: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  }
}

/**
 * Drop cached baselines.
 *
 * Called by the tests and by the backfill script, which rewrites the term rows
 * the baseline is derived from and would otherwise score the second half of a
 * corpus against a snapshot taken before the first half existed.
 */
export function clearCorpusBaselineCache(subsidiaryId?: Types.ObjectId): void {
  if (subsidiaryId) cache.delete(String(subsidiaryId));
  else cache.clear();
}
