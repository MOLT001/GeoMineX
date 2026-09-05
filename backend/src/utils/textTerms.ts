/**
 * Tokenisation vocabulary — PRD §4.3, §9.5.
 *
 * Deterministic, offline, dependency-free. Shared by the topic indexer
 * (write-time term rows), the local AI adapter (relevance scoring) and
 * sanitiseSearchTerms (what may reach a $text operator).
 */
import { normalisedText } from './unicodeNormalize.js';

export const MIN_TERM_LENGTH = 3;
export const MAX_TERM_LENGTH = 24;

/** Single source of the term shape: 3..24 chars, starts with a letter. */
export const TERM_REGEX = /[a-z][a-z0-9-]{2,23}/g;

/**
 * ~180 English function words plus document-scaffolding noise that dominates
 * government PDFs and carries no topic signal.
 *
 * Domain nouns (`coal`, `overburden`, `subsidiary`, `production`) are
 * DELIBERATELY NOT stopwords — they are the vocabulary the analysis exists to
 * surface. Every entry below is either closed-class English or a word that
 * appears in a government letter's furniture rather than in its subject
 * matter; nothing that could plausibly answer "what is this corpus about?"
 * belongs here.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // Closed-class English.
  'the','and','for','are','but','not','you','all','any','can','had','her','was','one','our','out',
  'has','him','his','how','its','may','new','now','old','see','two','who','did','get','let','put',
  'say','she','too','use','that','this','with','from','they','been','have','were','their','said',
  'each','which','them','than','then','some','into','only','other','more','also','such','shall',
  'must','when','what','will','would','could','should','there','these','those','where','while',
  'about','after','before','under','over','between','because','during','through','being','above',
  'along','already','although','always','among','another','around','both','cannot','either','else',
  'ever','every','except','further','hence','here','herself','himself','however','indeed','instead',
  'itself','just','least','less','many','much','myself','neither','never','none','nor','nothing',
  'once','onto','ours','perhaps','quite','rather','same','since','still','thus','unless','until',
  'upon','very','whether','within','without','yours','themselves','whom','whose',
  // Document scaffolding — noise HERE, not noise generally.
  'page','annexure','appendix','table','figure','signed','dated','sub','ref','encl','sir','madam',
  'respectfully','whereas','hereby','herein','thereof','pursuant','document','report','attached',
  'para','paragraph','section','subsection','enclosure','dear','faithfully','sincerely','kindly',
  'please','regards','undersigned','forwarded','vide','hereinafter','hereunder','thereto','therein',
  'thereby','whereby','wherein','aforesaid',
]);

/** Lowercase, normalise, match TERM_REGEX, drop stopwords. */
export function tokenize(text: string): string[] {
  const lower = normalisedText(text).toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(TERM_REGEX)) {
    const t = m[0];
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

/**
 * Top `cap` terms by (count desc, term asc).
 *
 * The tie-break on the term string is load-bearing: truncation must be
 * deterministic, or the same document produces different rows on a retry and
 * the "reprocessing does not change the word cloud" test flaps.
 */
export function countTerms(text: string, cap: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(sorted.slice(0, cap));
}

/** Adjacent term pairs — the retriever's phrase bonus and cluster labels. */
export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/** Sentences of 20..400 characters. A snippet must be a sentence, not a fragment. */
export function splitSentences(text: string): { text: string; index: number }[] {
  return normalisedText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 400)
    .map((s, index) => ({ text: s, index }));
}

/**
 * Everything that reaches a MongoDB $text operator goes through here — PRD §8.2, §9.5.
 *
 * MongoDB text search treats a LEADING HYPHEN as term NEGATION and a double
 * quote as a phrase delimiter. An ordinary parliamentary question ("what was
 * year-on-year output?") would otherwise silently NEGATE a term and exclude
 * exactly the documents that answer it. Reducing the question to bare tokens
 * removes every operator character and keeps the retriever's notion of a term
 * identical to the word cloud's.
 */
export function sanitiseSearchTerms(question: string, max = 24): string {
  return [...new Set(tokenize(question))].slice(0, max).join(' ');
}

export function normaliseForDedup(s: string): string {
  return normalisedText(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function titleCase(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}
