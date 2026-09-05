import type { PipelineStage, Types } from 'mongoose';
import type { TermSourceType } from './wordFrequency.model.js';

/**
 * Topic aggregations — PRD §4.3, §4.6.
 *
 * Every figure is computed by an aggregation pipeline over ALREADY-TOKENISED,
 * ALREADY-BUCKETED rows. Nothing loads document text into application memory
 * (§4.6), and there is no $regexFindAll over the corpus inside an HTTP request.
 *
 * MongoDB feature floor: 4.0. No $sortArray (5.2) — the bounded sourceId
 * sample is sorted in TypeScript after the pipeline returns.
 */

/** The two bucket columns materialised at index time. Both sort lexicographically = chronologically. */
export type BucketField = 'periodMonth' | 'periodQuarter';

export interface TopicPipelineArgs {
  subsidiaryIds: Types.ObjectId[] | null; // null = unscoped admin
  sourceTypes: TermSourceType[];
  range: { gte: Date; lt: Date };
  minSources: number;
  limit: number;
}

/**
 * The subsidiary clause is omitted ONLY when `subsidiaryIds` is null, and the
 * caller derives that from the token rather than from a client parameter — so
 * an absent clause here can only mean "unscoped admin", never "filter
 * forgotten" (§8.3).
 */
function baseMatch(a: TopicPipelineArgs): Record<string, unknown> {
  const m: Record<string, unknown> = {
    isDeleted: false,
    sourceType: { $in: a.sourceTypes },
    sourceCreatedAt: { $gte: a.range.gte, $lt: a.range.lt },
  };
  if (a.subsidiaryIds) m.subsidiaryId = { $in: a.subsidiaryIds };
  return m;
}

/**
 * §5.6's word cloud over the requested range.
 *
 * `sources` is sliced to a bounded sample rather than returned whole: it feeds
 * the cluster step and the "jump to a source" affordance, and an unbounded
 * `$addToSet` would let one ubiquitous term drag thousands of ObjectIds
 * through the group stage and into the response.
 */
export function buildWordCloudPipeline(a: TopicPipelineArgs): PipelineStage[] {
  return [
    { $match: baseMatch(a) },
    {
      $group: {
        _id: '$term',
        frequency: { $sum: '$count' },
        sources: { $addToSet: '$sourceId' },
      },
    },
    {
      $project: {
        _id: 0,
        term: '$_id',
        frequency: 1,
        sourceCount: { $size: '$sources' },
        // Bounded sample for the cluster step and for "jump to a source".
        //
        // `$setUnion` before the slice, NOT `$slice` on the raw `$addToSet`.
        // `$addToSet` gives no ordering guarantee, so slicing it took an
        // arbitrary 25 of N — and the cluster step builds its Jaccard sets from
        // exactly this sample, so which ids happened to survive decided whether
        // two terms merged. The same corpus could produce different clusters
        // and different cluster labels on two runs, which sorting the sample
        // afterwards cannot fix: that fixes the ORDER, not the MEMBERSHIP.
        //
        // `$setUnion` returns its result in a canonical order, so the sample is
        // the same 25 ids every time. `$sortArray` would say so more plainly
        // but is 5.2, above this project's 4.0 floor (D14). The determinism
        // this buys is asserted by a test, so a change in that behaviour fails
        // the build rather than quietly destabilising the word cloud.
        sources: { $slice: [{ $setUnion: ['$sources', []] }, 25] },
      },
    },
    // A term appearing in ONE source is not a topic. It also means a single
    // document cannot own the word cloud — a mild injection-resilience property.
    { $match: { sourceCount: { $gte: a.minSources } } },
    // `term: 1` is the deterministic tie-break; without it the top-N slice is
    // not reproducible and the determinism test flaps.
    { $sort: { frequency: -1, term: 1 } },
    { $limit: a.limit },
  ];
}

/**
 * §5.6: "Topic trend chart (line/area) showing frequency over time."
 *
 * A current-vs-previous pair is NOT a trend chart, so this returns a per-term
 * series across all requested buckets. `bucketField` is 'periodMonth' or
 * 'periodQuarter' — both are precomputed at write time and both are
 * lexicographically sortable, so a sort on the bucket key is chronological.
 *
 * The two-stage `$group` is what keeps this to a single pass: the first
 * collapses (term, bucket) pairs, the second folds each term's buckets into
 * one series — no per-term follow-up query, which is the shape that would turn
 * a 50-term cloud into 50 round trips.
 */
export function buildTrendPipeline(a: TopicPipelineArgs, bucketField: BucketField): PipelineStage[] {
  return [
    { $match: baseMatch(a) },
    {
      $group: {
        _id: { term: '$term', bucket: `$${bucketField}` },
        frequency: { $sum: '$count' },
        sources: { $addToSet: '$sourceId' },
      },
    },
    {
      $group: {
        _id: '$_id.term',
        total: { $sum: '$frequency' },
        series: {
          $push: {
            bucket: '$_id.bucket',
            frequency: '$frequency',
            sourceCount: { $size: '$sources' },
          },
        },
        // Per-bucket source sets, folded below into the term's distinct source
        // count across the whole range.
        sourceSets: { $push: '$sources' },
      },
    },
    // The SAME floor the word cloud applies. Without it the trend and the
    // comparison derived from it would surface a term the cloud refuses to
    // show — so a §5.6 "emerging topics" list could feature a term appearing in
    // exactly one document, which is precisely the single-source influence
    // minSources exists to prevent.
    //
    // $reduce + $setUnion rather than $setUnion on an array-of-arrays: the
    // latter needs the sets as separate arguments, and this stays inside the
    // 4.0 feature floor.
    {
      $addFields: {
        totalSources: {
          $size: {
            $reduce: {
              input: '$sourceSets',
              initialValue: [],
              in: { $setUnion: ['$$value', '$$this'] },
            },
          },
        },
      },
    },
    { $match: { totalSources: { $gte: a.minSources } } },
    { $sort: { total: -1, _id: 1 } },
    { $limit: a.limit },
    { $project: { _id: 0, term: '$_id', total: 1, series: 1 } },
  ];
}
