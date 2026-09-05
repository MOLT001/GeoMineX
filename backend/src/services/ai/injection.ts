/**
 * Prompt-injection detection — PRD §9.5, §9.9.
 *
 * Deterministic, offline, dependency-free. Runs at BOTH ends:
 *   - INGESTION (document.worker.ts): the earliest point untrusted text is
 *     inside the system, and the point §9.5 means by "silently processed".
 *   - RETRIEVAL (retrieval.service.ts): defence for anything ingested before
 *     this scanner existed, and for the case where the patterns improve later.
 *
 * THIS IS A SIGNAL, NOT THE CONTROL. The controls that actually hold are the
 * authorization filter, fence escaping, and citation validation — all three
 * work whether or not a pattern fires. §9.5 says as much when it calls the
 * filter "a genuine partial mitigation".
 *
 * Honest limits, stated so nobody mistakes a green suite for coverage:
 * per-chunk scanning misses a payload straddling a chunk boundary; the patterns
 * are English-only; a sufficiently novel phrasing gets through.
 */
import { normaliseUntrusted } from '../../utils/unicodeNormalize.js';

export const INJECTION_RULES = [
  {
    id: 'instruction-override',
    severity: 'high',
    pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(instruction|prompt|rule|direction)/i,
  },
  {
    id: 'role-reassignment',
    severity: 'high',
    pattern: /\byou are (now|an?|the)\b|\bact as\b|\bsystem prompt\b|\bnew instructions?\b|^\s*(system|assistant)\s*:/im,
  },
  {
    id: 'exfiltration',
    severity: 'high',
    pattern: /\b(reveal|print|output|repeat|disclose)\b[^.\n]{0,40}\b(system prompt|your instructions|api[\s_-]?key|secret|password|credential)/i,
  },
  {
    id: 'fence-forgery',
    severity: 'high',
    pattern: /<<<|>>>|\[\/?INST\]|<\|[a-z_]{1,24}\|>|-{5}\s*(BEGIN|END)/i,
  },
  {
    id: 'cross-tenant',
    severity: 'low',
    pattern: /\b(include|show|add|fetch|list)\b[^.\n]{0,60}\b(all|other|another)\s+subsidiar(y|ies)\b|\bregardless of (access|permission|authoris|authoriz)/i,
  },
  {
    id: 'privileged-action',
    severity: 'low',
    pattern: /\b(publish|archive|approve|grant\s+access|override|revoke)\b[^.\n]{0,40}\b(report|user|field|access)\b/i,
  },
  {
    id: 'tool-invocation',
    severity: 'low',
    pattern: /\b(call|invoke|execute)\b[^.\n]{0,30}\b(function|tool|endpoint|api)\b|"tool_call"|"action"\s*:/i,
  },
  {
    id: 'data-exfil-link',
    severity: 'low',
    pattern: /!\[[^\]]*\]\(\s*https?:/i,
  },
] as const satisfies ReadonlyArray<{ id: string; severity: 'low' | 'high'; pattern: RegExp }>;

export type InjectionRuleId = (typeof INJECTION_RULES)[number]['id'] | 'obfuscation';

export interface InjectionFlag {
  ruleId: InjectionRuleId;
  severity: 'low' | 'high';
  /** The chunk this fired on. A reviewer follows it to the source. */
  ref: string;
}

/**
 * Density of stripped invisibles above which the text is treated as
 * deliberately obfuscated. 12 zero-width characters in a 1200-char chunk is
 * not a formatting accident.
 */
const OBFUSCATION_PER_KCHAR = 10;

/**
 * Scan one passage.
 *
 * NORMALISES BEFORE MATCHING. Without that, "i\u200Bgnore previous instructions"
 * slips past every pattern above.
 *
 * Deliberately records the RULE ID and the ref, and NEVER an excerpt: the
 * attacker-controlled text already lives in `documentChunks`, and copying it
 * into a second collection a review UI renders only widens the §9.13
 * sanitisation surface for no investigative gain (§9.6).
 */
export function detectInjection(raw: string, ref: string): InjectionFlag[] {
  const { text, strippedCount } = normaliseUntrusted(raw);
  const flags: InjectionFlag[] = [];

  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(text)) flags.push({ ruleId: rule.id, severity: rule.severity, ref });
  }

  if (text.length > 0 && (strippedCount * 1000) / text.length >= OBFUSCATION_PER_KCHAR) {
    // An evasion ATTEMPT is itself evidence, so obfuscation is its own high-severity rule.
    flags.push({ ruleId: 'obfuscation', severity: 'high', ref });
  }

  return flags;
}

/**
 * The block decision.
 *
 * The asymmetry is deliberate: ONE high-severity hit blocks, but low-severity
 * hits need two, because "publish", "approve" and "all subsidiaries" are
 * ordinary words in a mining compliance document. A detector that flags
 * everything is a detector nobody leaves switched on.
 */
export function isSuspected(flags: InjectionFlag[]): boolean {
  const high = flags.filter((f) => f.severity === 'high').length;
  const low = flags.filter((f) => f.severity === 'low').length;
  return high >= 1 || low >= 2;
}
