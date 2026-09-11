/**
 * Topic-aware query understanding — §11, feeding §10's retrieval.
 *
 * "Give me reports related to borehole drilling" contains a topic. "What was
 * the figure for last quarter" does not. This module is the difference between
 * those two cases, and the second one is the important one: §11 says not to
 * force a topic where none is clearly present, and a classifier that always
 * returns something would quietly re-rank every question in the system.
 *
 * ─── IT ADDS A SIGNAL; IT NEVER SUBSTITUTES FOR ONE ─────────────────────────
 * The result of this is used to REORDER passages the text search already found.
 * It never widens the candidate pool, never relaxes a scope filter, and never
 * becomes evidence. §10 is explicit that "topic extraction must NEVER cause the
 * system to answer from topic labels alone", and the way that is guaranteed
 * here is structural: nothing downstream of this module can see a topic label,
 * because retrieval hands the provider passages and refs, exactly as before.
 */
import { tokenize } from '../../utils/textTerms.js';
import { MAX_ALIAS_TOKENS, aliasFor, labelForTopicId, topicById } from './taxonomy.js';

export interface QuestionIntent {
  /** Topics the question appears to be about. Empty when it is not about one. */
  topicIds: string[];
  /** The alias surfaces that produced them, for the audit trail. */
  matchedTerms: string[];
  /** 0..1. Below `MIN_INTENT_CONFIDENCE` the caller ignores the whole result. */
  confidence: number;
}

/**
 * Below this, retrieval behaves exactly as it did before this feature existed.
 *
 * Calibrated so that ONE multi-word domain phrase ("borehole drilling",
 * "coal reserve estimation") clears it and one incidental single word ("coal")
 * does not — because almost every question in this system says "coal", and a
 * signal that fires on every question is not a signal.
 */
export const MIN_INTENT_CONFIDENCE = 0.5;

const EMPTY: QuestionIntent = { topicIds: [], matchedTerms: [], confidence: 0 };

/** Phrases are evidence of intent; a lone common word is not. */
function evidenceWeight(tokens: number): number {
  if (tokens <= 1) return 0.25;
  if (tokens === 2) return 0.6;
  return 0.8;
}

/**
 * Read a question for the subjects it names.
 *
 * Longest-match-first over the same alias index the document extractor uses,
 * so a question and a document that discuss the same thing resolve to the same
 * topic id — which is the only reason matching them is worth anything.
 *
 * The OCR fold is deliberately NOT applied: a user typed this. Repairing what
 * they typed would silently answer a different question.
 */
export function classifyQuestion(questionText: string): QuestionIntent {
  const tokens = tokenize(questionText);
  if (tokens.length === 0) return EMPTY;

  const weights = new Map<string, number>();
  const matched: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    let hit: { topicId: string; span: number; surface: string } | null = null;

    for (let span = Math.min(MAX_ALIAS_TOKENS, tokens.length - i); span >= 1; span -= 1) {
      const entry = aliasFor(tokens.slice(i, i + span).join(' '));
      if (entry) {
        hit = { topicId: entry.topicId, span, surface: entry.surface };
        break;
      }
    }

    if (!hit) {
      i += 1;
      continue;
    }

    const topic = topicById(hit.topicId);
    weights.set(hit.topicId, (weights.get(hit.topicId) ?? 0) + evidenceWeight(hit.span) * (topic?.weight ?? 1));
    matched.push(hit.surface);
    i += hit.span;
  }

  if (weights.size === 0) return EMPTY;

  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = ranked.reduce((sum, [, w]) => sum + w, 0);

  return {
    // Capped at three: past that the "intent" is the whole taxonomy, which
    // reorders nothing and only costs a lookup.
    topicIds: ranked.slice(0, 3).map(([id]) => id),
    matchedTerms: [...new Set(matched)],
    confidence: Math.min(1, total),
  };
}

/** Human-readable, for the audit metadata and the answer's provenance. */
export function describeIntent(intent: QuestionIntent): string[] {
  return intent.topicIds.map(labelForTopicId);
}
