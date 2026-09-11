/**
 * Topic and keyword extraction — the analysis behind "what is this document about".
 *
 * Deterministic, offline, dependency-free, and in the same house style as
 * `services/ai/local.adapter.ts`: it never writes a sentence, it SELECTS
 * evidence that is already in the document. Given the same text and the same
 * corpus baseline it returns byte-identical output, which is what makes
 * reprocessing idempotent and the tests assertable.
 *
 * ─── WHY NOT AN LLM ─────────────────────────────────────────────────────────
 * The specification asks for structured LLM output. There is no backend LLM in
 * this system: `services/ai/local.adapter.ts` is extractive by design (that is
 * what makes every citation exact), and the only model access is a browser-held
 * Gemini key on a 20-request-per-day free quota — which cannot process a corpus
 * of thousands of documents, and which §26 forbids moving into a place where
 * the backend could reach it without new credentials. So the intelligence lives
 * in the scoring, not in a prompt.
 *
 * That is not a downgrade for this task. The failure mode the spec is guarding
 * against — "do NOT simply extract the most frequently occurring words" — is a
 * SCORING failure, and it is fixed by scoring, whoever does the scoring:
 *
 *   1. DOMAIN AWARENESS  `taxonomy.ts` decides what counts as mining vocabulary
 *      at all, so `stripping ratio` outranks `financial` even when rarer.
 *   2. DISTINCTIVENESS   Inverse document frequency against the subsidiary's
 *      own corpus. A word every filing uses carries almost no weight however
 *      often it appears — this is precisely the "not the most frequent words"
 *      requirement, expressed as arithmetic.
 *   3. PHRASE STRUCTURE  `coal seam` is evidence about a document; `coal` is
 *      background. Multi-token matches outweigh single tokens.
 *
 * If a backend LLM is ever funded, `extractTopics` is the seam it slots behind:
 * the result shape is what the rest of the system consumes, and a model could
 * fill it instead. Nothing else would change.
 */
import { env } from '../../config/env.js';
import { normalisedText } from '../../utils/unicodeNormalize.js';
import { MIN_TERM_LENGTH, STOPWORDS, TERM_REGEX } from '../../utils/textTerms.js';
import {
  MAX_ALIAS_TOKENS,
  aliasFor,
  categoryForTopicId,
  foldedAliasFor,
  foldedWordFor,
  labelForTopicId,
  ocrFold,
  topicById,
  type TopicCategory,
} from './taxonomy.js';

/**
 * Bumped whenever scoring changes in a way that would give an already-processed
 * document a DIFFERENT answer. §21 names "extraction version changes" as one of
 * the four reasons to reprocess, and this is the value that decides it.
 */
export const EXTRACTION_VERSION = 'topic-intel-1';

// ── Tuning ─────────────────────────────────────────────────────────────────

/**
 * Below this many documents, inverse document frequency is noise rather than
 * signal — with three documents in the corpus, a word in two of them looks
 * "common" for no good reason. Under the floor every term gets idf 1 and the
 * ranking falls back to domain weight and phrase structure alone.
 */
const MIN_CORPUS_FOR_IDF = 5;

/** A topic needs this share of the leader's score to be reported at all. */
const SECONDARY_RELEVANCE_FLOOR = 0.18;
const MAX_SECONDARY_TOPICS = 6;

/** A single alias hit in a long document is a mention, not a subject. */
const MIN_TOPIC_SCORE = 1.2;

const MAX_KEYWORDS = 18;
const MAX_TECHNICAL_TERMS = 14;
const MAX_DISCOVERED_TOPICS = 3;
const MAX_EVIDENCE_PER_TOPIC = 2;
const EVIDENCE_CHARS = 220;

/** A discovered topic must clear this to be worth inventing a name for. */
const DISCOVERY_MIN_COUNT = 3;
const DISCOVERY_MIN_IDF = 1.6;
/**
 * The count required when there is no usable corpus baseline.
 *
 * Below `MIN_CORPUS_FOR_IDF` every term scores idf 1, so an idf gate is not
 * merely weak there — it is unsatisfiable, and discovery would silently never
 * fire on a new deployment. That is the deployment where it matters most: a
 * fresh corpus is exactly the one whose vocabulary the taxonomy has not seen.
 * With no distinctiveness measure available, repetition and collocation
 * strength are what is left, so the bar moves onto the count.
 */
const DISCOVERY_MIN_COUNT_UNCALIBRATED = 4;

const SUMMARY_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 700;

/** A document shorter than this cannot support a claim about its subject. */
const MIN_TOKENS_FOR_EXTRACTION = 25;

// ── Shapes ─────────────────────────────────────────────────────────────────

export interface CorpusBaseline {
  /** Documents the baseline was measured over. */
  documentCount: number;
  /** Single token -> how many documents contain it. */
  documentFrequency: ReadonlyMap<string, number>;
}

export interface ExtractionChunk {
  text: string;
  pageNumber?: number;
  /** Sheet name, statement heading — a title carries more weight than a body line. */
  section?: string;
}

export interface ExtractionInput {
  chunks: readonly ExtractionChunk[];
  /** Titles are strong evidence; §23 names report titles explicitly. */
  filename: string;
  /**
   * Enables the OCR-confusion fold (§22). Set for scans and images, where
   * `Geologlcal` is a plausible rendering of `Geological` — and left off for a
   * digital text layer, where it would only add false positives.
   */
  ocrTolerant: boolean;
  /** 0..1 from the OCR provider. Caps the reported extraction confidence. */
  ocrConfidence: number;
  baseline: CorpusBaseline;
}

export interface TopicEvidence {
  chunkIndex: number;
  pageNumber?: number;
  /** A verbatim slice of the document — never a generated sentence. */
  quote: string;
}

export interface ExtractedTopic {
  topicId: string;
  label: string;
  category: TopicCategory;
  /** Raw score. Comparable within one document only. */
  score: number;
  /** 0..1 against this document's leading topic — what the UI sizes chips by. */
  relevance: number;
  /** Total alias occurrences across the document. */
  termCount: number;
  /** The surface forms actually seen, most frequent first. */
  matchedTerms: string[];
  /** True when the topic was found in the text rather than in the taxonomy. */
  discovered: boolean;
  firstPage?: number;
  evidence: TopicEvidence[];
}

export interface ScoredTerm {
  term: string;
  count: number;
  score: number;
  /** True when the term is curated mining vocabulary rather than a free phrase. */
  domain: boolean;
}

export type ExtractionStatus = 'extracted' | 'insufficient_text' | 'low_quality';

export interface ExtractionResult {
  primary: ExtractedTopic | null;
  secondary: ExtractedTopic[];
  /** Every topic above the floor, ranked. `primary` is `topics[0]`. */
  topics: ExtractedTopic[];
  keywords: ScoredTerm[];
  technicalTerms: ScoredTerm[];
  /** Verbatim sentences selected from the document, in document order. */
  summary: string;
  /** 0..1. Capped by OCR quality, so a poor scan cannot report certainty (§22). */
  confidence: number;
  status: ExtractionStatus;
  version: string;
  /** Diagnostics for the audit record — counts only, never content. */
  stats: { tokens: number; distinctTerms: number; aliasHits: number; noiseDropped: number };
}

// ── Term hygiene ───────────────────────────────────────────────────────────

/**
 * Units and formulae that look like garbage to a general rule but are not.
 *
 * Every entry mixes letters and digits, which is the exact shape the noise
 * filter rejects; without this list `co2` and `pm10` would be dropped from an
 * environmental report, where they are the subject.
 */
const TECHNICAL_ALPHANUMERIC = new Set(['co2', 'so2', 'no2', 'nox', 'sox', 'pm10', 'pm25', 'h2o', 'ch4', 'm3', 'km2']);

/** `fy2026`, `q1`, `h2` — period labels, not junk. */
const PERIOD_TOKEN = /^(fy\d{2,4}|[qh][1-4]|\d{4}-\d{2})$/;

/**
 * Words that are real, common and say nothing about a document's subject.
 *
 * This is NOT added to `textTerms.STOPWORDS`, deliberately. That list is shared
 * with the retriever, and removing `total`, `quarter` or `crore` from a
 * parliamentary question would change which passages the retriever finds.
 * Here the job is different — deciding what to PRINT as a keyword — so the list
 * lives here and affects nothing else.
 *
 * Units and magnitudes (`tonne`, `crore`, `metre`) are on it for the same
 * reason `million tonnes` is not a taxonomy alias: every production figure ever
 * filed carries one, so they are the letterhead of a mining corpus.
 */
const GENERIC_TERMS: ReadonlySet<string> = new Set([
  // Quantifiers, magnitudes, units.
  'per',
  'cent',
  'percent',
  'percentage',
  'crore',
  'lakh',
  'million',
  'billion',
  'thousand',
  'tonne',
  'tonnes',
  'metre',
  'metres',
  'meter',
  'meters',
  'kilometre',
  'number',
  'nos',
  'total',
  'average',
  'approximately',
  'respectively',
  // Time and period scaffolding.
  'year',
  'years',
  'month',
  'months',
  'quarter',
  'quarterly',
  'annual',
  'annually',
  'period',
  'date',
  'dated',
  'during',
  'corresponding',
  'previous',
  'current',
  // `quarter ended June 30` is a date, and without these `ended june` and
  // `ended march` are recurrent, distinctive two-word collocations — which is
  // exactly the shape discovery promotes to a topic. Measured on a real
  // quarterly filing, where they were two of the three discovered subjects.
  'ended',
  'ending',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  // Reporting verbs and connectives that survive the stopword list.
  'against',
  'above',
  'below',
  'accordingly',
  'carried',
  'made',
  'given',
  'taken',
  'shown',
  'stated',
  'noted',
  'observed',
  'considered',
  'includes',
  'including',
  'included',
  'follows',
  'following',
  'various',
  'certain',
  'relevant',
  'appropriate',
  'accordance',
  'basis',
  'value',
  'values',
  'detail',
  'details',
  'information',
  'data',
  'part',
  'parts',
  'case',
  'cases',
  'term',
  'terms',
  'area',
  'areas',
  'work',
  'works',
  'time',
  'times',
  'well',
  'said',
  'may',
  'shall',
]);

/**
 * Reject what OCR produces when it fails — §15, §22.
 *
 * Each rule below was chosen because it fires on OCR debris and not on mining
 * vocabulary. They are deliberately conservative: a real term wrongly dropped
 * is invisible, while junk that survives is stored as a topic and read by a
 * human as a claim about the document.
 */
export function isNoiseTerm(term: string): boolean {
  if (term.length < MIN_TERM_LENGTH) return true;
  if (TECHNICAL_ALPHANUMERIC.has(term) || PERIOD_TOKEN.test(term)) return false;

  // Letters fused with digits: `1284b`, `tonnes500`. Real vocabulary that does
  // this is on the allowlist above.
  if (/[a-z]/.test(term) && /\d/.test(term)) return true;

  const letters = term.replace(/[^a-z]/g, '');
  if (letters.length < MIN_TERM_LENGTH) return true;

  /**
   * No true vowel — `wrtsp`, `mnthy`, `dprtmnt`.
   *
   * `y` is deliberately NOT counted. Counting it lets `mnthy` (a mangled
   * `monthly`) through, and the words it would rescue — `myth`, `rhythm` — are
   * not mining vocabulary. Three-letter initialisms like `tph` and `oms` are
   * shorter than this rule's floor and are judged by length instead.
   */
  if (letters.length >= 4 && !/[aeiou]/.test(letters)) return true;

  // Three of the same letter in a row occurs in no English or Hindi term.
  if (/(.)\1\1/.test(letters)) return true;

  // A run of five consonants: `mplmnts`. Kept at five so `strength` survives.
  if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(letters)) return true;

  // Almost no distinct characters — `aaabaa`, `lililil`.
  if (letters.length >= 6 && new Set(letters).size / letters.length < 0.4) return true;

  return false;
}

// ── Tokenisation with offsets ──────────────────────────────────────────────

interface PositionedToken {
  term: string;
  /** Character offset INTO THE NORMALISED CHUNK TEXT, so quotes slice cleanly. */
  at: number;
}

/**
 * The same vocabulary as `textTerms.tokenize`, but keeping offsets.
 *
 * Offsets are what let a topic carry a verbatim quote as evidence instead of a
 * bare count — and evidence is the difference between "this document is about
 * drilling" and "this document is about drilling, here is where it says so".
 */
function tokenizePositioned(normalised: string): PositionedToken[] {
  const out: PositionedToken[] = [];
  for (const m of normalised.toLowerCase().matchAll(TERM_REGEX)) {
    const term = m[0];
    if (!STOPWORDS.has(term)) out.push({ term, at: m.index });
  }
  return out;
}

// ── Corpus-relative weighting ──────────────────────────────────────────────

/**
 * Smoothed inverse document frequency.
 *
 * The `+1`s keep an unseen term finite, and the trailing `+1` keeps a term
 * present in EVERY document at a floor of ~1 rather than 0 — a universal term
 * should be weak, not erased, or a document that genuinely is about production
 * would lose its own subject.
 */
function idfOf(term: string, baseline: CorpusBaseline): number {
  if (baseline.documentCount < MIN_CORPUS_FOR_IDF) return 1;
  const df = baseline.documentFrequency.get(term) ?? 0;
  return Math.log((baseline.documentCount + 1) / (df + 1)) + 1;
}

/**
 * A phrase's document frequency is bounded by its rarest word.
 *
 * The frequency index stores single tokens only, so a phrase's true df is not
 * recorded. `min` over its words is an UPPER bound on that df, which makes the
 * resulting idf a LOWER bound — the phrase is never scored as rarer than it is.
 * Erring toward under-weighting is the right direction: an over-weighted phrase
 * becomes a wrong headline topic, an under-weighted one is merely ranked lower.
 */
function phraseIdf(words: string[], baseline: CorpusBaseline): number {
  if (baseline.documentCount < MIN_CORPUS_FOR_IDF) return 1;
  let maxDf = 0;
  for (const w of words) maxDf = Math.max(maxDf, baseline.documentFrequency.get(w) ?? 0);
  return Math.log((baseline.documentCount + 1) / (maxDf + 1)) + 1;
}

/** Diminishing returns on repetition: the 40th mention is not 40 times the 1st. */
function tfWeight(count: number): number {
  return 1 + Math.log(count);
}

/**
 * Repair a single token that the taxonomy recognises through the OCR fold.
 *
 * Repairs a WORD, not a phrase: `geologlcal` becomes `geological` because that
 * word appears inside curated aliases, even though `geological` alone is not an
 * alias of anything. Memoised per document, because a scan repeats its own
 * misreadings on every page.
 */
function canonicalise(term: string, ocrTolerant: boolean, memo: Map<string, string>): string {
  if (!ocrTolerant) return term;
  const cached = memo.get(term);
  if (cached !== undefined) return cached;

  // A term the taxonomy already spells this way is not a misreading.
  const out = aliasFor(term) ? term : (foldedWordFor(ocrFold(term)) ?? term);
  memo.set(term, out);
  return out;
}

/** A phrase is stronger evidence than a word, and a long phrase stronger still. */
function phraseBonus(tokens: number): number {
  if (tokens <= 1) return 0.6;
  if (tokens === 2) return 1;
  return 1.25;
}

// ── Extraction ─────────────────────────────────────────────────────────────

interface TopicAccumulator {
  topicId: string;
  score: number;
  termCount: number;
  surfaces: Map<string, number>;
  evidence: TopicEvidence[];
  firstPage?: number;
}

interface PhraseAccumulator {
  words: string[];
  count: number;
}

/**
 * Read one document.
 *
 * Two passes over each chunk: alias matching (longest span wins, matches do not
 * overlap) and free-term accumulation. The second pass does not skip tokens the
 * first consumed — a document that says `coal seam` twenty times SHOULD surface
 * both the topic and the keyword, and de-duplication happens at presentation.
 */
export function extractTopics(input: ExtractionInput): ExtractionResult {
  const topics = new Map<string, TopicAccumulator>();
  const unigrams = new Map<string, number>();
  const phrases = new Map<string, PhraseAccumulator>();
  const canonicalMemo = new Map<string, string>();
  /** Terms seen in a filename or a section heading — titles name subjects. */
  const titleTerms = new Set<string>();

  let totalTokens = 0;
  let aliasHits = 0;
  let noiseDropped = 0;

  const titleText = normalisedText(input.filename).toLowerCase().replace(/[._-]+/g, ' ');
  for (const t of tokenizePositioned(titleText)) titleTerms.add(t.term);

  const chunkTexts: string[] = [];

  input.chunks.forEach((chunk, chunkIndex) => {
    const text = normalisedText(chunk.text);
    chunkTexts.push(text);
    const tokens = tokenizePositioned(text);
    totalTokens += tokens.length;

    // Token offsets are measured in the LOWERCASED text. For every script that
    // appears in this corpus the two strings are the same length, so a quote
    // can be sliced from the cased original — but `toLowerCase` is not always
    // length-preserving (U+0130 expands to two code units), and a quote cut at
    // a shifted offset would be a mangled quote presented as verbatim evidence.
    // When the lengths disagree, take the loss of casing over the loss of truth.
    const lower = text.toLowerCase();
    const quoteSource = lower.length === text.length ? text : lower;

    if (chunk.section) {
      for (const t of tokenizePositioned(normalisedText(chunk.section).toLowerCase())) titleTerms.add(t.term);
    }

    // ── Pass 1: taxonomy alias matching, longest span first ───────────────
    let i = 0;
    while (i < tokens.length) {
      let matched: { entry: ReturnType<typeof aliasFor>; span: number } | null = null;

      for (let span = Math.min(MAX_ALIAS_TOKENS, tokens.length - i); span >= 1; span -= 1) {
        const words = tokens.slice(i, i + span).map((t) => t.term);
        const entry = aliasFor(words.join(' '));
        if (entry) {
          matched = { entry, span };
          break;
        }
      }

      // §22 — only when the text came from pixels. Running the fold over a
      // digital text layer would invent matches the document does not contain.
      if (!matched && input.ocrTolerant) {
        for (let span = Math.min(MAX_ALIAS_TOKENS, tokens.length - i); span >= 1; span -= 1) {
          const folded = tokens
            .slice(i, i + span)
            .map((t) => ocrFold(t.term))
            .join(' ');
          const entry = foldedAliasFor(folded);
          if (entry) {
            matched = { entry, span };
            break;
          }
        }
      }

      if (!matched?.entry) {
        i += 1;
        continue;
      }

      const { entry, span } = matched as { entry: NonNullable<ReturnType<typeof aliasFor>>; span: number };
      const topic = topicById(entry.topicId)!;
      const words = tokens.slice(i, i + span).map((t) => t.term);

      let acc = topics.get(entry.topicId);
      if (!acc) {
        acc = { topicId: entry.topicId, score: 0, termCount: 0, surfaces: new Map(), evidence: [] };
        topics.set(entry.topicId, acc);
      }

      acc.termCount += 1;
      acc.surfaces.set(entry.surface, (acc.surfaces.get(entry.surface) ?? 0) + 1);
      acc.firstPage ??= chunk.pageNumber;

      if (acc.evidence.length < MAX_EVIDENCE_PER_TOPIC) {
        const start = Math.max(0, Math.round(tokens[i]!.at - EVIDENCE_CHARS / 3));
        acc.evidence.push({
          chunkIndex,
          pageNumber: chunk.pageNumber,
          quote: quoteSource.slice(start, start + EVIDENCE_CHARS).replace(/\s+/g, ' ').trim(),
        });
      }

      // Scored per occurrence; `tfWeight` is applied to the total afterwards so
      // repetition cannot dominate — see the finalisation loop.
      acc.score += phraseBonus(span) * topic.weight * phraseIdf(words, input.baseline);
      aliasHits += 1;
      i += span;
    }

    // ── Pass 2: free terms and collocations ───────────────────────────────
    for (let j = 0; j < tokens.length; j += 1) {
      const raw = tokens[j]!.term;
      if (isNoiseTerm(raw)) {
        noiseDropped += 1;
        continue;
      }
      // §22 — a scanned `exploratlon` is stored as `exploration`. Without this
      // the topic is right (the fold already matched it) while the keyword
      // beside it is the misreading, which is exactly the "do not let OCR
      // garbage become stored topics" failure, one field over.
      const term = canonicalise(raw, input.ocrTolerant, canonicalMemo);
      unigrams.set(term, (unigrams.get(term) ?? 0) + 1);

      const following = tokens[j + 1];
      if (!following || isNoiseTerm(following.term)) continue;

      /**
       * Only genuinely ADJACENT words form a phrase.
       *
       * The token stream has stopwords removed, so `profit before tax` leaves
       * `profit` next to `tax` and `content of 34.8 per cent` leaves `content`
       * next to `per`. Both would be recorded as collocations that appear
       * nowhere in the document. Requiring nothing but whitespace between the
       * two spans is what separates a real phrase from an artefact of the
       * tokeniser — and it is why alias matching (pass 1) deliberately does NOT
       * apply the same rule: `bord and pillar` IS one term.
       */
      const between = lower.slice(tokens[j]!.at + raw.length, following.at);
      if (!/^\s{1,3}$/.test(between)) continue;

      const next = canonicalise(following.term, input.ocrTolerant, canonicalMemo);
      const key = `${term} ${next}`;
      const existing = phrases.get(key);
      if (existing) existing.count += 1;
      else phrases.set(key, { words: [term, next], count: 1 });
    }
  });

  if (totalTokens < MIN_TOKENS_FOR_EXTRACTION) {
    return empty('insufficient_text', { tokens: totalTokens, distinctTerms: unigrams.size, aliasHits, noiseDropped });
  }

  // ── Collocations: keep pairs that behave like a phrase ────────────────────
  /**
   * A bigram survives only if it recurs AND its words prefer each other's
   * company. `min` in the denominator asks "of the times the rarer word
   * appeared, how often was it in this pair?" — which separates `stripping
   * ratio` from `annual figure`, where both words are common and their
   * adjacency is chance.
   */
  const collocations: { phrase: string; words: string[]; count: number }[] = [];
  for (const [key, p] of phrases) {
    if (p.count < 2) continue;
    // `million tonnes`, `per cent` — a pair of units is a unit, not a concept.
    // One informative word is enough to keep it: `coal quality` survives.
    if (p.words.every((w) => GENERIC_TERMS.has(w))) continue;
    const floor = Math.min(unigrams.get(p.words[0]!) ?? 0, unigrams.get(p.words[1]!) ?? 0);
    if (floor === 0 || p.count / floor < 0.35) continue;
    collocations.push({ phrase: key, words: p.words, count: p.count });
  }

  // ── Discovery: distinctive phrases the taxonomy does not know (§4) ────────
  const discovered = collocations
    // Stricter than the keyword rule on purpose: a keyword is a hint, whereas a
    // discovered topic is given a NAME and shown beside curated ones, so
    // `annual production` must not become a topic on the strength of `annual`.
    .filter((c) => !aliasFor(c.phrase) && c.count >= DISCOVERY_MIN_COUNT)
    .filter((c) => !c.words.some((w) => GENERIC_TERMS.has(w)))
    .map((c) => ({ ...c, idf: phraseIdf(c.words, input.baseline) }))
    .filter((c) =>
      input.baseline.documentCount >= MIN_CORPUS_FOR_IDF
        ? c.idf >= DISCOVERY_MIN_IDF
        : c.count >= DISCOVERY_MIN_COUNT_UNCALIBRATED,
    )
    .sort((a, b) => b.count * b.idf - a.count * a.idf || (a.phrase < b.phrase ? -1 : 1))
    .slice(0, MAX_DISCOVERED_TOPICS);

  for (const d of discovered) {
    const id = `discovered:${d.phrase.replace(/\s+/g, '-')}`;
    topics.set(id, {
      topicId: id,
      /**
       * PER-OCCURRENCE, like an alias hit — the finalisation loop below applies
       * `tfWeight` once, to the total, for every topic. Storing an
       * already-tf-weighted score here would put the discount through twice and
       * push most discovered topics under `MIN_TOPIC_SCORE`, which is a silent
       * way of switching discovery off.
       *
       * The 0.7 is the real discount: a phrase nobody vetted is a candidate,
       * and it must not be able to outrank a curated subject on equal evidence.
       */
      score: d.count * d.idf * 0.7,
      termCount: d.count,
      surfaces: new Map([[d.phrase, d.count]]),
      evidence: [],
    });
  }

  // ── Finalise topic scores ────────────────────────────────────────────────
  const ranked: ExtractedTopic[] = [...topics.values()]
    .map((acc) => {
      const known = topicById(acc.topicId);
      const surfaces = [...acc.surfaces.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

      // Repetition is folded in ONCE, against the topic's total occurrences —
      // scoring each occurrence linearly would let a boilerplate header that
      // repeats on ninety pages outrank the document's actual subject.
      let score = acc.score * (tfWeight(acc.termCount) / Math.max(1, acc.termCount));

      // A subject named in the filename or a sheet name is being declared, not
      // mentioned. §23 asks for exactly this on spreadsheets.
      const inTitle = known?.aliases.some((a) => a.split(/\s+/).every((w) => titleTerms.has(w.toLowerCase())));
      if (inTitle) score *= 1.6;

      return {
        topicId: acc.topicId,
        label: labelForTopicId(acc.topicId),
        category: categoryForTopicId(acc.topicId),
        score: round4(score),
        relevance: 0,
        termCount: acc.termCount,
        matchedTerms: surfaces.map(([s]) => s).slice(0, 8),
        discovered: !known,
        firstPage: acc.firstPage,
        evidence: acc.evidence,
      } satisfies ExtractedTopic;
    })
    .filter((t) => t.score >= MIN_TOPIC_SCORE)
    // Ties break on the id so a rerun cannot reorder equal topics.
    .sort((a, b) => b.score - a.score || (a.topicId < b.topicId ? -1 : 1));

  const top = ranked[0]?.score ?? 0;
  for (const t of ranked) t.relevance = top > 0 ? round4(t.score / top) : 0;

  /**
   * A lone mention is not a subject.
   *
   * One occurrence of `stripping ratio` in a fifty-page geology report is a
   * true statement about the text and a false one about the document, so a
   * secondary topic needs either a second occurrence or enough weight to sit
   * near the leader on the strength of that single phrase.
   */
  const kept = ranked.filter(
    (t, index) =>
      index === 0 ||
      (t.relevance >= SECONDARY_RELEVANCE_FLOOR && (t.termCount >= 2 || t.relevance >= 0.5)),
  );
  const primary = kept[0] ?? null;
  const secondary = kept.slice(1, 1 + MAX_SECONDARY_TOPICS);

  // ── Keywords and technical terms ─────────────────────────────────────────
  const keywords = rankKeywords(unigrams, collocations, titleTerms, input.baseline);
  const technicalTerms = rankTechnicalTerms(
    topics,
    new Map(kept.map((t) => [t.topicId, t.relevance])),
    input.baseline,
  );

  // ── Confidence ───────────────────────────────────────────────────────────
  /**
   * Three independent doubts, multiplied:
   *   - how well the page was read,
   *   - whether there was enough of it to judge,
   *   - how much of what it says is recognisable mining vocabulary.
   * They multiply rather than average, because averaging lets a perfect OCR
   * score paper over a document that yielded four tokens.
   *
   * Topic SEPARATION is deliberately not a term here. An early version
   * penalised documents whose top topics scored closely, which punished exactly
   * the documents the system reads best: a geological report genuinely is about
   * exploration AND reserves AND drilling AND seams, and treating that richness
   * as ambiguity made the most confident results look the least confident.
   */
  const volume = Math.min(1, totalTokens / 250);
  const domainDensity = totalTokens > 0 ? Math.min(1, 0.4 + (aliasHits / totalTokens) * 3) : 0;
  const ocr = Math.max(0.25, Math.min(1, input.ocrConfidence || 0.5));
  const confidence = primary ? round4(ocr * volume * domainDensity) : 0;

  const status: ExtractionStatus = !primary
    ? 'low_quality'
    : input.ocrConfidence > 0 && input.ocrConfidence <= env.OCR_REVIEW_THRESHOLD
      ? 'low_quality'
      : 'extracted';

  return {
    primary,
    secondary,
    topics: kept,
    keywords,
    technicalTerms,
    summary: buildSummary(chunkTexts, topics, input.baseline),
    confidence,
    status,
    version: EXTRACTION_VERSION,
    stats: { tokens: totalTokens, distinctTerms: unigrams.size, aliasHits, noiseDropped },
  };
}

/**
 * The document's distinctive vocabulary — §15's "what concepts are present",
 * answered per document rather than per corpus.
 *
 * Phrases are scored alongside single words and win ties, because `coal seam`
 * tells a reader more than `coal` and `seam` listed separately. A word that is
 * already inside a kept phrase is dropped, so the list does not spend three of
 * its eighteen slots saying the same thing.
 */
function rankKeywords(
  unigrams: ReadonlyMap<string, number>,
  collocations: { phrase: string; words: string[]; count: number }[],
  titleTerms: ReadonlySet<string>,
  baseline: CorpusBaseline,
): ScoredTerm[] {
  const scored: ScoredTerm[] = [];

  for (const c of collocations) {
    const domain = aliasFor(c.phrase) !== undefined;
    const boost = (domain ? 1.6 : 1) * (c.words.some((w) => titleTerms.has(w)) ? 1.3 : 1);
    scored.push({
      term: c.phrase,
      count: c.count,
      score: round4(tfWeight(c.count) * phraseIdf(c.words, baseline) * 1.25 * boost),
      domain,
    });
  }

  for (const [term, count] of unigrams) {
    if (count < 2) continue;
    // Blocked only as a STANDALONE keyword. `lease area` still reaches the list
    // as a phrase, and as a taxonomy alias it still matches a topic.
    if (GENERIC_TERMS.has(term)) continue;
    const domain = aliasFor(term) !== undefined;
    const boost = (domain ? 1.6 : 1) * (titleTerms.has(term) ? 1.3 : 1);
    scored.push({
      term,
      count,
      score: round4(tfWeight(count) * idfOf(term, baseline) * 0.6 * boost),
      domain,
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1));

  const kept: ScoredTerm[] = [];
  const coveredWords = new Set<string>();
  for (const s of scored) {
    if (kept.length >= MAX_KEYWORDS) break;
    const words = s.term.split(' ');
    if (words.length === 1 && coveredWords.has(words[0]!)) continue;
    kept.push(s);
    if (words.length > 1) for (const w of words) coveredWords.add(w);
  }
  return kept;
}

/**
 * §3 — "technical terms should be preserved rather than replaced with generic
 * words". These are the curated surface forms the document actually used, so a
 * filing that says `bord and pillar` is reported as saying `bord and pillar`
 * and not as `Underground Mining`.
 */
function rankTechnicalTerms(
  topics: ReadonlyMap<string, TopicAccumulator>,
  relevanceByTopic: ReadonlyMap<string, number>,
  baseline: CorpusBaseline,
): ScoredTerm[] {
  const out: ScoredTerm[] = [];
  for (const acc of topics.values()) {
    if (!topicById(acc.topicId)) continue; // curated vocabulary only

    /**
     * Weighted by the topic's standing in THIS document.
     *
     * Without it, most one-off phrases score identically and the list is cut
     * alphabetically — so a report whose leading subject is reserves would
     * publish `borehole log` and drop `reserve estimation`, purely because `b`
     * sorts before `r`. The floor keeps a term from a topic that fell below the
     * reporting threshold visible but last.
     */
    const standing = Math.max(0.15, relevanceByTopic.get(acc.topicId) ?? 0);

    for (const [surface, count] of acc.surfaces) {
      const words = surface.toLowerCase().split(/\s+/);
      out.push({
        term: surface,
        count,
        score: round4(tfWeight(count) * phraseIdf(words, baseline) * phraseBonus(words.length) * standing),
        domain: true,
      });
    }
  }
  return out
    .sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
    .slice(0, MAX_TECHNICAL_TERMS);
}

/**
 * An extractive summary — §12's "AI Summary" slot.
 *
 * Sentences are SELECTED, never written, for the same reason the AI adapter
 * selects them: a sentence lifted verbatim from the document cannot state
 * something the document does not say. Scoring favours sentences dense in the
 * terms that made this document's topics, and earlier sentences break ties,
 * because a report states its purpose near the front.
 */
function buildSummary(
  chunkTexts: readonly string[],
  topics: ReadonlyMap<string, TopicAccumulator>,
  baseline: CorpusBaseline,
): string {
  const weights = new Map<string, number>();
  for (const acc of topics.values()) {
    for (const surface of acc.surfaces.keys()) {
      for (const w of surface.toLowerCase().split(/\s+/)) {
        weights.set(w, Math.max(weights.get(w) ?? 0, idfOf(w, baseline)));
      }
    }
  }
  if (weights.size === 0) return '';

  interface Candidate {
    text: string;
    order: number;
    score: number;
  }
  const candidates: Candidate[] = [];
  let order = 0;

  for (const text of chunkTexts) {
    /**
     * Paragraph first, THEN sentence.
     *
     * A PDF's text layer wraps at the column edge, so splitting on newlines
     * treats every visual line as a sentence and the summary comes back as
     * three truncated fragments — which is what the first version of this did.
     * A blank line is a real boundary; a single newline inside a paragraph is
     * the page, not the prose.
     */
    for (const paragraph of text.split(/\n\s*\n+/)) {
      const flat = paragraph.replace(/\s+/g, ' ').trim();

      for (const raw of flat.split(/(?<=[.!?])\s+/)) {
        const sentence = raw.trim();
        order += 1;
        if (sentence.length < 40 || sentence.length > 400) continue;

        const tokens = tokenizePositioned(sentence.toLowerCase());
        if (tokens.length < 6) continue;

        let hit = 0;
        for (const t of tokens) hit += weights.get(t.term) ?? 0;
        if (hit <= 0) continue;

        // Divided by length, so a long sentence cannot win on volume alone; the
        // small position term keeps an early sentence ahead of an equal later one.
        candidates.push({ text: sentence, order, score: hit / Math.sqrt(tokens.length) + 1 / (order + 8) });
      }
    }
  }

  const picked = candidates
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, SUMMARY_SENTENCES)
    .sort((a, b) => a.order - b.order);

  let summary = '';
  for (const p of picked) {
    const next = summary ? `${summary} ${p.text}` : p.text;
    if (next.length > SUMMARY_MAX_CHARS) break;
    summary = next;
  }
  return summary;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function empty(status: ExtractionStatus, stats: ExtractionResult['stats']): ExtractionResult {
  return {
    primary: null,
    secondary: [],
    topics: [],
    keywords: [],
    technicalTerms: [],
    summary: '',
    confidence: 0,
    status,
    version: EXTRACTION_VERSION,
    stats,
  };
}
