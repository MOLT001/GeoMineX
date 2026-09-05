/**
 * Topic clustering — PRD §4.3 "group related documents/queries into topic clusters".
 *
 * Deterministic, offline, no dependency, and HONEST ABOUT WHAT IT IS: two terms
 * cluster because they appear in the SAME SOURCES, not because they mean the
 * same thing. A synonym pair that never co-occurs will not merge, and
 * boilerplate that always co-occurs will. That limitation is the price of
 * having no embedding model until §11.7 is settled, and a word-cloud UI must
 * present clusters as a navigation aid rather than a statistical claim.
 *
 * Runs over the <= TOPICS_CLUSTER_MAX_TERMS already-aggregated term rows —
 * never over documents — so §4.6's "not by loading documents into application
 * memory" holds. At the default 60 terms that is at most 1,770 pairwise
 * comparisons.
 *
 * A SECOND LIMIT, stated rather than hidden: each row carries only a bounded
 * sample of its sources (topics.pipelines.ts slices to 25), so for a term
 * present in more sources than that, the overlap score is computed over a
 * sample and can under-report. The caller sorts each sample before it arrives
 * here, which is what makes a given set of rows produce byte-identical output
 * on every run.
 */
import { titleCase } from '../../utils/textTerms.js';

export interface TermRow {
  term: string;
  frequency: number;
  /** Source ids as strings — a Set of ObjectIds would compare by identity, not value. */
  sources: string[];
}

export interface TermCluster {
  label: string;
  terms: string[];
  frequency: number;
  sourceCount: number;
  sourceIds: string[];
}

/** Intersection over union; an empty pair scores 0 rather than dividing by zero. */
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Greedy agglomeration from a seed order of (frequency desc, term asc).
 *
 * Every tie-break is on the term string, so the output is byte-identical across
 * runs — which is what makes the determinism test assertable. Ordering compares
 * the strings directly rather than with `localeCompare`, whose result depends on
 * the host's ICU collation data: an ordering a test asserts must not change with
 * the machine it runs on.
 *
 * KNOWN BIAS, stated rather than hidden: a cluster's source union GROWS as
 * terms are absorbed, so later terms attach more readily than earlier ones.
 * Acceptable for a navigation aid; it would not be acceptable for a claim.
 *
 * The 12-terms-per-cluster cap is a readability bound, not a statistical one:
 * past a dozen labels a cloud cluster stops being navigable. An overflowing
 * term seeds a new cluster rather than being dropped, so no term the caller
 * asked for silently disappears.
 */
export function clusterTerms(
  rows: TermRow[],
  threshold: number,
  maxTerms: number,
  maxClusters: number,
): TermCluster[] {
  const seeds = [...rows]
    .sort((a, b) => b.frequency - a.frequency || (a.term < b.term ? -1 : 1))
    .slice(0, maxTerms);

  const clusters: { terms: string[]; frequency: number; sources: Set<string> }[] = [];

  for (const row of seeds) {
    const rowSources = new Set(row.sources);
    let best = -1;
    let bestScore = threshold; // strictly greater than the threshold wins
    for (const [i, c] of clusters.entries()) {
      const score = jaccard(rowSources, c.sources);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && clusters[best]!.terms.length < 12) {
      clusters[best]!.terms.push(row.term);
      clusters[best]!.frequency += row.frequency;
      for (const s of row.sources) clusters[best]!.sources.add(s);
    } else if (clusters.length < maxClusters) {
      clusters.push({ terms: [row.term], frequency: row.frequency, sources: rowSources });
    }
  }

  return clusters.map((c) => ({
    label: titleCase(c.terms[0]!), // highest-frequency member seeds the label
    terms: c.terms,
    frequency: c.frequency,
    sourceCount: c.sources.size,
    sourceIds: [...c.sources].sort().slice(0, 25), // sorted => stable sample
  }));
}
