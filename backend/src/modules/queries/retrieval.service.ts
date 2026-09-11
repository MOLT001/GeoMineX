/**
 * Authorization-filtered retrieval — PRD §9.5, §8.2.
 *
 * EVERY step here runs BEFORE the provider exists in the call stack.
 *
 * Stage A — the scoped $text query. The subsidiary clause and the $text
 *   operator are built in the SAME object literal, so there is no code path
 *   that searches first and filters second. That is exactly the shape §8.2
 *   forbids when it says a text index must never become a path around
 *   subsidiary isolation. `documentChunks` carries a denormalised
 *   `subsidiaryId` precisely so this is one query rather than a join a caller
 *   might forget to constrain.
 *
 * Stage B — per-document cap, in TypeScript over the bounded candidate set.
 *   One file must not fill the context window. A relevance measure and an
 *   injection blast-radius measure in one knob.
 *
 * Stage C — parent-document re-verification: a SECOND, INDEPENDENT scoped
 *   query. Deliberately redundant with the denormalised chunk.subsidiaryId —
 *   if the denormalisation is ever stale, or a future refactor drops one
 *   filter, the other still holds, and drift becomes an EMPTY RESULT rather
 *   than a cross-tenant leak. It also enforces §4.2: nothing cites a chunk of
 *   a failed or still-queued document.
 *
 * Stage D — injection scan, then escape, then opaque ref assignment.
 *
 * There is NO $lookup and NO aggregation here: two `find` calls keep the
 * MongoDB feature floor at 4.0 and keep the security-critical code readable.
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { sanitiseSearchTerms } from '../../utils/textTerms.js';
import { detectInjection, type InjectionFlag } from '../../services/ai/injection.js';
import { escapePassage } from '../../services/ai/prompt.js';
import { DocumentModel } from '../documents/document.model.js';
import { DocumentChunk } from '../documents/documentChunk.model.js';
import { DocumentTopic } from '../topics/documentTopic.model.js';
import { MIN_INTENT_CONFIDENCE, classifyQuestion } from '../topics/questionIntent.js';

/**
 * How much a topic match can move a passage — §10's "additional retrieval
 * signal", with the emphasis on ADDITIONAL.
 *
 * At 0.6 a passage whose document is squarely about the question's subject can
 * overtake a passage that merely shares more words, which is the whole point.
 * It cannot overtake one that scored several times higher on the text itself,
 * which is also the point: the words in the document remain the primary
 * evidence, and this reorders a shortlist rather than choosing it.
 */
const TOPIC_BOOST = 0.6;

export const MAX_SNIPPET_CHARS = 240;

/** The server-held record behind one ref. NEVER serialised into a prompt. */
export interface RetrievedRef {
  chunkId: Types.ObjectId;
  documentId: Types.ObjectId;
  documentFilename: string;
  subsidiaryId: Types.ObjectId;
  chunkIndex: number;
  pageNumber?: number;
  section?: string;
  /** Sliced from the STORED chunk, for the citation quote. */
  quote: string;
  relevance: number;
  /** Escaped passage text, ready to hand to a provider. */
  passageText: string;
}

export interface RetrievalResult {
  /** Ordered S1..Sn. */
  refs: string[];
  byRef: Map<string, RetrievedRef>;
  flags: InjectionFlag[];
  candidatesConsidered: number;
  withheld: number;
  /**
   * What the question was read as being about, and whether that was confident
   * enough to be used. Recorded so an answer's provenance can say that topics
   * influenced the ordering — and, just as importantly, when they did not.
   */
  intent: { topicIds: string[]; matchedTerms: string[]; confidence: number; applied: boolean };
}

export interface RetrievalInput {
  questionText: string;
  /** Always concrete and non-empty — resolved by query.service.ts at ask time. */
  scopeSubsidiaryIds: Types.ObjectId[];
  documentIds: Types.ObjectId[];
  nonce: string;
}

export async function retrievePassages(input: RetrievalInput): Promise<RetrievalResult> {
  // An empty grant list must produce a filter that matches NOTHING, never an
  // unfiltered query. `$in: []` does exactly that.
  const scopeClause = { subsidiaryId: { $in: input.scopeSubsidiaryIds } };

  // ── Stage A: scoped $text search. Scope and search in ONE query (§8.2). ──
  const search = sanitiseSearchTerms(input.questionText);
  const candidates = search
    ? await DocumentChunk.find(
        {
          $text: { $search: search },
          ...scopeClause,
          isDeleted: false,
          ...(input.documentIds.length ? { documentId: { $in: input.documentIds } } : {}),
        },
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' }, _id: 1 }) // _id makes the order TOTAL
        .limit(env.AI_RETRIEVAL_CANDIDATES)
        .lean()
    : [];

  // Pinned-document fallback: the user explicitly scoped the question to named
  // documents, so returning their opening chunks is answering what was asked.
  // There is NO fallback when no documents were named: an unmatched question
  // yields `unsupported`, never a broadened search. Putting an unrelated
  // passage in a prompt is pure injection surface with no upside.
  const pool =
    candidates.length === 0 && input.documentIds.length > 0
      ? await DocumentChunk.find({ ...scopeClause, isDeleted: false, documentId: { $in: input.documentIds } })
          .sort({ documentId: 1, chunkIndex: 1 })
          .limit(env.AI_RETRIEVAL_CANDIDATES)
          .lean()
      : candidates;

  const candidatesConsidered = pool.length;

  /**
   * ── Stage A2: topic re-ranking — §10, §11. ─────────────────────────────
   *
   * Runs INSIDE the candidate set that Stage A already produced and already
   * scoped. It changes the ORDER of `pool`, never its membership: a document
   * the text search did not find is not retrieved because its topic matched,
   * and a document outside the caller's scope was never in `pool` to reorder.
   *
   * The pinned-document fallback above is deliberately left alone. A user who
   * named documents asked for those documents, and reordering their opening
   * chunks by topic would answer a question they did not ask.
   */
  const intent = classifyQuestion(input.questionText);
  const applyIntent = intent.confidence >= MIN_INTENT_CONFIDENCE && pool.length > 1;

  if (applyIntent) {
    const documentIds = [...new Set(pool.map((c) => String(c.documentId)))].map((id) => new Types.ObjectId(id));

    // Scoped in the SAME query as the topic clause, for the same reason Stage A
    // is: there must be no code path that reads topic rows first and filters by
    // subsidiary second.
    const topicRows = await DocumentTopic.find({
      documentId: { $in: documentIds },
      topicId: { $in: intent.topicIds },
      ...scopeClause,
      isDeleted: false,
    })
      .select({ documentId: 1, relevance: 1 })
      .lean();

    const boostByDocument = new Map<string, number>();
    for (const row of topicRows) {
      const key = String(row.documentId);
      // A document carrying two of the question's topics keeps the STRONGER
      // signal rather than summing them: summing would let a document that
      // mentions three subjects in passing outrank one that is about the topic.
      boostByDocument.set(key, Math.max(boostByDocument.get(key) ?? 0, row.relevance));
    }

    if (boostByDocument.size > 0) {
      const adjusted = (c: (typeof pool)[number]): number => {
        const base = (c as { score?: number }).score ?? 0;
        return base * (1 + TOPIC_BOOST * (boostByDocument.get(String(c.documentId)) ?? 0));
      };
      // `_id` breaks ties, so the order stays TOTAL — the same property Stage A
      // relies on, and what keeps an answer reproducible.
      pool.sort((a, b) => adjusted(b) - adjusted(a) || (String(a._id) < String(b._id) ? -1 : 1));
    }
  }

  // ── Stage B: per-document cap, deterministic. ───────────────────────────
  const perDoc = new Map<string, number>();
  const capped = pool.filter((c) => {
    const k = String(c.documentId);
    const n = (perDoc.get(k) ?? 0) + 1;
    perDoc.set(k, n);
    return n <= env.AI_RETRIEVAL_MAX_CHUNKS_PER_DOCUMENT;
  });

  // ── Stage C: independent scoped parent re-verification. ─────────────────
  const docIds = [...new Set(capped.map((c) => String(c.documentId)))].map((id) => new Types.ObjectId(id));
  const parents = await DocumentModel.find({
    _id: { $in: docIds },
    isDeleted: false,
    status: 'validated',
    ...scopeClause,
  })
    .select({ _id: 1, subsidiaryId: 1, originalFilename: 1 })
    .lean();

  const parentById = new Map(parents.map((d) => [String(d._id), d]));
  const verified = capped.filter((c) => {
    const parent = parentById.get(String(c.documentId));
    // Drift check: the chunk's denormalised subsidiary must equal its parent's.
    return parent !== undefined && String(parent.subsidiaryId) === String(c.subsidiaryId);
  });

  // ── Stage D: injection scan, escape, opaque refs. ───────────────────────
  const flags: InjectionFlag[] = [];
  const byRef = new Map<string, RetrievedRef>();
  const refs: string[] = [];
  let withheld = 0;

  for (const c of verified) {
    if (refs.length >= env.AI_RETRIEVAL_TOP_K) break;

    const chunkFlags = detectInjection(c.text, String(c._id));
    if (chunkFlags.length > 0) flags.push(...chunkFlags);

    // §9.5. `exclude` is the default and the right one for an EXTRACTIVE
    // provider: a flagged-but-retained chunk would have its injected sentence
    // quoted VERBATIM into a parliamentary draft, and that is the failure
    // independent of whether any model followed the instruction. The chunk is
    // withheld from the PROMPT, never from the USER, who can still open the
    // document through the documents module.
    if (env.AI_INJECTION_POLICY === 'exclude' && isBlocking(chunkFlags)) {
      withheld += 1;
      continue;
    }

    const ref = `S${refs.length + 1}`;
    refs.push(ref);
    byRef.set(ref, {
      chunkId: c._id,
      documentId: c.documentId,
      documentFilename: parentById.get(String(c.documentId))!.originalFilename,
      subsidiaryId: c.subsidiaryId,
      chunkIndex: c.chunkIndex,
      pageNumber: c.pageNumber,
      section: c.section,
      quote: c.text.slice(0, env.AI_CITATION_QUOTE_CHARS),
      relevance: (c as { score?: number }).score ?? 0,
      passageText: escapePassage(c.text, input.nonce, env.AI_MAX_CONTEXT_CHARS_PER_CHUNK),
    });
  }

  return {
    refs,
    byRef,
    flags,
    candidatesConsidered,
    withheld,
    intent: {
      topicIds: intent.topicIds,
      matchedTerms: intent.matchedTerms,
      confidence: Math.round(intent.confidence * 100) / 100,
      applied: applyIntent,
    },
  };
}

/** Local mirror of injection.ts#isSuspected, kept inline so the policy is visible here. */
function isBlocking(flags: InjectionFlag[]): boolean {
  const high = flags.filter((f) => f.severity === 'high').length;
  const low = flags.filter((f) => f.severity === 'low').length;
  return high >= 1 || low >= 2;
}
