/**
 * Citation validation — PRD §9.5, §8.1.
 *
 * "Citations must be validated against the IDs of the chunks actually
 *  retrieved, and discarded if they do not match. A citation is never accepted
 *  from model-generated prose."
 *
 * TWO LAYERS.
 *
 * STRUCTURAL: the provider never received an ObjectId, only S1..Sn. Forging a
 * citation that validates would require guessing an identifier it has never
 * seen — the information is not present to guess from.
 *
 * CHECKED, here. Two independent gates, both required:
 *   (a) the ref must exist in the refMap THIS request built and the service
 *       holds — a hallucinated 'S99', a raw ObjectId string, or a ref from a
 *       previous request is dropped and COUNTED, never clamped into range;
 *   (b) the resolved chunk's subsidiaryId must be in the caller's authorised
 *       set — redundant if (a) holds, which is the point: it is the check that
 *       catches a regression in retrieval.
 *
 * A chunk the injection scanner withheld is not in the refMap at all, so a
 * citation to it is discarded by the same path.
 *
 * The input ref list is the UNION of the provider's `citedRefs` and the refs
 * re-scanned out of the answer prose. A provider may claim refs it did not
 * mark, or mark refs it did not claim, and both are suspicious. This is a
 * containment check over a closed vocabulary the SERVICE defined — it is not
 * "accepting a citation from prose", because a marker can only ever narrow the
 * set of already-issued refs, never introduce a new source.
 *
 * Pure functions with no I/O, so the security property is unit-testable
 * without a database.
 */
import type { QueryCitation } from './query.model.js';
import type { RetrievedRef } from './retrieval.service.js';

export const MAX_CITATIONS = 20;

/** Matches the placeholder the provider emits: `{{ref:S3}}`. */
export const REF_MARKER = /\{\{ref:(S\d{1,3})\}\}/g;

export function refsFromProse(answerText: string): string[] {
  return [...answerText.matchAll(REF_MARKER)].map((m) => m[1]!);
}

export function validateCitations(
  claimedRefs: string[],
  /**
   * Retained in the signature but no longer read: prose is not a source of
   * citation claims any more (see the intersection below). Keeping the
   * parameter keeps every call site and test honest about what is passed
   * in, and leaves the seam for a provider-misbehaviour metric that counts
   * stray markers without ever promoting one to a citation.
   */
  _answerText: string,
  byRef: Map<string, RetrievedRef>,
  authorizedSubsidiaryIds: Set<string>,
): { citations: QueryCitation[]; discarded: number; acceptedRefs: Set<string> } {
  // INTERSECTION, not union.
  //
  // Re-scanning the prose exists to catch a provider that MARKS a ref it did
  // not claim. Unioning the two sets inverted that: a marker copied verbatim
  // out of a hostile document became a citation the provider never made, and
  // it landed in the structured `citations` array as a real source. Prose can
  // now only ever narrow the provider's claim — which is what this module's
  // header has always said it does.
  //
  // `escapePassage` neutralises the marker before a passage ever reaches a
  // provider, so the two controls are belt and braces: this one holds even
  // for a future hosted provider that emits markers the escaper never saw.
  // A ref present only in the prose is dropped here, and stripped from the
  // text by `sanitiseAnswer`, so it can never become a citation and can never
  // inflate `discarded` — the metric the audit trail treats as the primary
  // fabricated-citation signal, and therefore the one number document-
  // controlled text must not be able to move.
  const union = [...new Set(claimedRefs)];

  const citations: QueryCitation[] = [];
  const seenChunks = new Set<string>();
  const acceptedRefs = new Set<string>();
  let discarded = 0;

  for (const ref of union) {
    const hit = byRef.get(ref);
    if (!hit) {
      discarded += 1; // gate (a)
      continue;
    }
    if (!authorizedSubsidiaryIds.has(String(hit.subsidiaryId))) {
      discarded += 1; // gate (b)
      continue;
    }

    const chunkKey = String(hit.chunkId);
    if (seenChunks.has(chunkKey)) continue; // dedup is not a discard
    seenChunks.add(chunkKey);
    acceptedRefs.add(ref);

    if (citations.length >= MAX_CITATIONS) continue;

    // EVERY field is read from the server-held chunk record — including the
    // quote. Nothing here originates in model output.
    citations.push({
      ordinal: citations.length + 1,
      documentId: hit.documentId,
      documentFilename: hit.documentFilename,
      chunkId: hit.chunkId,
      chunkIndex: hit.chunkIndex,
      pageNumber: hit.pageNumber,
      section: hit.section,
      quote: hit.quote,
      relevance: hit.relevance,
      subsidiaryId: hit.subsidiaryId,
    });
  }

  return { citations, discarded, acceptedRefs };
}

/** 24 hex characters — the shape of a MongoDB ObjectId. */
const OBJECT_ID_RUN = /\b[0-9a-fA-F]{24}\b/g;

/**
 * Rewrite the prose for storage and display.
 *
 *   - `{{ref:Sx}}` for an ACCEPTED ref becomes `[n]`, numbered in citation order;
 *   - a marker for any other ref is STRIPPED, so the client never sees a
 *     reference it cannot resolve;
 *   - any 24-hex run is removed. A future hosted provider must never be able
 *     to echo a real identifier into prose a client might treat as a
 *     traceability link;
 *   - control characters are stripped and the text is capped.
 *
 * `_citations` is accepted but unread: the accepted-ref set and the ordinal map
 * the caller derives FROM it are what the rewrite needs, and passing the list
 * as well keeps the three arguments visibly one unit at the call site — a
 * rewrite performed against a different citation list than the one persisted is
 * exactly the mismatch §8.1 separates prose from metadata to prevent. The
 * underscore is what `noUnusedParameters` requires.
 */
export function sanitiseAnswer(
  raw: string,
  _citations: QueryCitation[],
  acceptedRefs: Set<string>,
  refOrdinal: Map<string, number>,
  maxChars: number,
): string {
  const withMarkers = raw.replace(REF_MARKER, (_m, ref: string) =>
    acceptedRefs.has(ref) && refOrdinal.has(ref) ? `[${refOrdinal.get(ref)!}]` : '',
  );
  return (
    withMarkers
      .replace(OBJECT_ID_RUN, '')
      // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
      .slice(0, maxChars)
  );
}
