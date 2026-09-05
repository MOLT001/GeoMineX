/**
 * Local answer provider — deterministic, offline, EXTRACTIVE.
 *
 * Same posture as services/ocr/local.adapter.ts: it does genuine work where it
 * honestly can, and refuses to guess where it cannot.
 *
 * IT NEVER WRITES A SENTENCE. It SELECTS sentences verbatim from the passages
 * it was handed. That one decision buys four properties at once:
 *   - every sentence has a known source passage, so `citedRefs` is exact BY
 *     CONSTRUCTION rather than claimed;
 *   - there is nothing for an injected instruction to manipulate, because no
 *     text is being composed;
 *   - the output cannot contain a figure that is not in an authorised document,
 *     which is precisely the residual risk §9.5 names ("fabricated figures
 *     carrying plausible-looking citations in a parliamentary response");
 *   - it runs offline with no dependency and no key.
 *
 * THE COST, stated plainly: the answers read as quotations, not as drafted
 * prose. Fluency is what a hosted provider buys, and §11.7 gates it. This
 * mirrors the OCR adapter's trade, which the codebase has already made once.
 *
 * DETERMINISM CONTRACT (asserted by tests/aiProvider.test.ts, byte equality):
 *   - no Math.random, no crypto.randomBytes, no Date/clock value in answerText
 *     (latencyMs is metadata and is never asserted on);
 *   - every sort is a TOTAL order with an explicit tie-break on `ref` then text;
 *   - plain `<`/`>` string comparison, NEVER localeCompare (locale- and
 *     ICU-build-dependent, so CI and a developer's machine would disagree);
 *   - scores rounded to 1e-6 before comparison, so float ordering cannot flip
 *     between runs on different hardware;
 *   - IDF computed over the SUPPLIED PASSAGES ONLY — no corpus state, no
 *     database read, so the same request always scores identically;
 *   - iteration over arrays, never over Object.keys of a dynamically built map.
 *
 * OFFLINE CONTRACT: imports `node:` builtins and local modules only. No fetch,
 * no http, no SDK, no key. The suite reaches nothing.
 */
import { env } from '../../config/env.js';
import { tokenize, bigrams, splitSentences, normaliseForDedup } from '../../utils/textTerms.js';
import { escapePassage, PROMPT_VERSION } from './prompt.js';
import { UNSUPPORTED_ANSWER, type AiProvider, type AnswerRequest, type AnswerResult } from './ai.types.js';

const K1 = 1.2;
const B = 0.75;
const MIN_SENTENCE_SCORE = 0.15;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function createLocalAiProvider(): AiProvider {
  return {
    name: 'local',
    promptVersion: PROMPT_VERSION,

    answer(req: AnswerRequest): Promise<AnswerResult> {
      const startedAt = Date.now();
      const qTokens = tokenize(req.question);
      const qBigrams = bigrams(qTokens);

      // Escape BEFORE anything reaches answerText, so the local path exercises
      // the same escaping the network path will (§9.5).
      const passages = req.passages.map((p, i) => ({
        ref: p.ref,
        order: i,
        text: escapePassage(p.text, req.nonce, env.AI_MAX_CONTEXT_CHARS_PER_CHUNK),
      }));

      // 1. BM25-lite over the supplied passages only.
      const docs = passages.map((p) => ({ ...p, tokens: tokenize(p.text) }));
      const avgLen = docs.reduce((a, d) => a + d.tokens.length, 0) / Math.max(1, docs.length);
      const df = new Map<string, number>();
      for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);

      const scored = docs.map((d) => {
        const tf = new Map<string, number>();
        for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        let score = 0;
        for (const q of new Set(qTokens)) {
          const f = tf.get(q) ?? 0;
          if (f === 0) continue;
          const idf = Math.log(1 + (docs.length - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
          score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.tokens.length) / Math.max(1, avgLen))));
        }
        // A parliamentary question usually wants a phrase, not scattered words.
        const lower = d.text.toLowerCase();
        if (qBigrams.some((bg) => lower.includes(bg))) score += 0.5;
        return { ...d, score: round6(score) };
      });

      const top = [...scored]
        .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
        .filter((d) => d.score > 0)
        .slice(0, env.AI_ANSWER_MAX_PASSAGES);

      // 2. Sentence selection within the kept passages.
      const candidates: { ref: string; order: number; sIndex: number; text: string; score: number }[] = [];
      for (const p of top) {
        for (const s of splitSentences(p.text)) {
          const sTokens = new Set(tokenize(s.text));
          const overlap = [...new Set(qTokens)].filter((t) => sTokens.has(t)).length;
          if (overlap === 0) continue;
          const positional = Math.pow(0.9, s.index);          // an opening sentence carries the claim
          const numericBonus = /\d/.test(s.text) ? 0.25 : 0;  // a parliamentary answer wants a figure
          candidates.push({
            ref: p.ref,
            order: p.order,
            sIndex: s.index,
            text: s.text,
            score: round6((overlap / Math.max(1, qTokens.length)) * positional + numericBonus),
          });
        }
      }

      const chosen = candidates
        .filter((c) => c.score >= MIN_SENTENCE_SCORE)
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.order - b.order ||
            a.sIndex - b.sIndex ||
            (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
        )
        .slice(0, env.AI_LOCAL_MAX_SENTENCES);

      // 3. Dedup, then present in DOCUMENT order so the answer reads naturally.
      const seen = new Set<string>();
      const ordered = chosen
        .filter((c) => {
          const k = normaliseForDedup(c.text);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => a.order - b.order || a.sIndex - b.sIndex);

      const latencyMs = Date.now() - startedAt;

      if (ordered.length === 0) {
        return Promise.resolve({
          answerText: UNSUPPORTED_ANSWER,
          citedRefs: [],
          unsupported: true,
          providerName: 'local',
          latencyMs,
        });
      }

      const body = ordered.map((c) => `${c.text} {{ref:${c.ref}}}`).join(' ');
      const answerText =
        req.style === 'parliamentary'
          ? [
              'Draft response, assembled verbatim from authorised source material:',
              '',
              ...ordered.map((c, i) => `${i + 1}. ${c.text} {{ref:${c.ref}}}`),
              '',
              'Sources are cited separately. This draft requires human review and approval before use in an official response.',
            ].join('\n')
          : // Distinct passages, not sentences: `ordered` holds the selected
            // SENTENCES, and several may come from one passage. Announcing the
            // sentence count as a passage count puts a wrong figure in prose
            // that §4.4 destines for an official response.
            `Based on ${new Set(ordered.map((c) => c.ref)).size} source passage(s): ${body}`;

      return Promise.resolve({
        answerText: answerText.slice(0, req.maxAnswerChars),
        citedRefs: [...new Set(ordered.map((c) => c.ref))],
        unsupported: false,
        providerName: 'local',
        latencyMs,
      });
    },
  };
}
