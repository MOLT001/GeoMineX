/**
 * Geological and mining topic taxonomy — the domain vocabulary behind §4.3.
 *
 * ─── WHY A TAXONOMY AND NOT A WORD COUNT ────────────────────────────────────
 * The frequency index (`wordFrequency.model.ts`) answers "which words appear
 * most often", and in a CIL corpus the answer is always the same handful of
 * words: coal, production, mine, report. That is a fact about the corpus, not
 * about any document in it, which is why a cloud built from raw counts is
 * decorative. This file supplies the missing half: a mention of `stripping
 * ratio` says something about a document that a mention of `coal` does not.
 *
 * Scoring combines three signals and needs all three (see topicExtraction.ts):
 *   1. THIS list — is the term domain vocabulary at all?
 *   2. Distinctiveness — is it characteristic of THIS document, or does every
 *      document in the corpus say it? (inverse document frequency)
 *   3. Phrase length — `coal seam` is evidence; `coal` is background.
 *
 * ─── THIS IS A SEED LIST, NOT A CLOSED SET ──────────────────────────────────
 * `topicExtraction.ts` also DISCOVERS topics: a distinctive collocation that
 * matches nothing here is promoted to a topic of its own with `discovered:
 * true`. That is deliberate — a taxonomy frozen in code would quietly cap what
 * the system can ever notice, and CMPDI's vocabulary is not ours to fix.
 *
 * ─── ALIASES ARE TOKENISED, NOT MATCHED RAW ─────────────────────────────────
 * Every alias below is pushed through the SAME `tokenize()` the document text
 * goes through, so `bord and pillar` becomes the two-token key `bord pillar`
 * (`and` is a stopword) and matches the document's token stream. Writing the
 * alias in natural form here and normalising once at load is what keeps this
 * file readable by someone who knows mining but not this codebase.
 */
import { tokenize } from '../../utils/textTerms.js';

export const TOPIC_CATEGORIES = [
  'exploration',
  'geology',
  'planning',
  'operations',
  'production',
  'quality',
  'environment',
  'safety',
  'commercial',
  'regulatory',
  'discovered',
] as const;
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

export interface CanonicalTopic {
  /** Stable slug. STORED on every row — renaming one orphans its documents. */
  id: string;
  label: string;
  category: TopicCategory;
  /**
   * Surface forms, in natural spelling. Order is irrelevant; matching is by
   * longest token span, not by list position.
   */
  aliases: string[];
  /**
   * How strongly a mention implies the document is ABOUT this topic, 0.5–1.4.
   *
   * Low is not "unimportant" — `coal-production` sits at 0.8 because every
   * document in this corpus mentions production, so a mention is weak evidence
   * even though the topic itself is central. Distinctiveness does the rest.
   */
  weight: number;
  /**
   * §16's topic relationships, as a static prior. The service merges these
   * with co-occurrence measured in the actual corpus, so a relationship the
   * corpus contradicts loses to the corpus.
   */
  related: string[];
}

/**
 * Roughly thirty concepts spanning a CMPDI/CIL document set: exploration and
 * geology at one end, statutory and commercial reporting at the other. Every
 * concept PS 26023 names appears here; the rest come from the vocabulary of
 * the filings themselves (DGMS, MoEFCC, FSA, OMS, GCV).
 */
export const TAXONOMY: readonly CanonicalTopic[] = [
  {
    id: 'geological-exploration',
    label: 'Geological Exploration',
    category: 'exploration',
    weight: 1.2,
    related: ['drilling', 'coal-reserves', 'geological-modelling', 'surveying'],
    aliases: [
      'geological exploration',
      'geological investigation',
      'geological survey',
      'exploration',
      'prospecting',
      'regional exploration',
      'detailed exploration',
      'promotional exploration',
      'exploratory survey',
      'field investigation',
    ],
  },
  {
    id: 'drilling',
    label: 'Drilling & Boreholes',
    category: 'exploration',
    weight: 1.3,
    related: ['geological-exploration', 'coal-seam', 'geological-modelling', 'geotechnical'],
    aliases: [
      'borehole',
      'boreholes',
      'bore hole',
      'drilling',
      'drill hole',
      'drillhole',
      'exploratory drilling',
      'borehole drilling',
      'drilling investigation',
      'core drilling',
      'drill core',
      'core recovery',
      'drilling metreage',
      'drilling meterage',
      'departmental drilling',
      'outsourced drilling',
    ],
  },
  {
    id: 'coal-reserves',
    label: 'Coal & Mineral Reserves',
    category: 'geology',
    weight: 1.3,
    related: ['geological-exploration', 'coal-seam', 'geological-modelling', 'mine-planning'],
    aliases: [
      'coal reserve',
      'coal reserves',
      'geological reserve',
      'mineral reserve',
      'extractable reserve',
      'mineable reserve',
      'proved reserve',
      'indicated reserve',
      'inferred reserve',
      'measured reserve',
      'reserve estimation',
      'resource estimation',
      'reserve assessment',
      'resource assessment',
      'in situ reserve',
      'coal resource',
      'mineral resource',
      'reserve base',
    ],
  },
  {
    id: 'coal-seam',
    label: 'Coal Seams & Strata',
    category: 'geology',
    weight: 1.3,
    related: ['drilling', 'coal-reserves', 'geological-modelling', 'coal-quality'],
    aliases: [
      'coal seam',
      'seam',
      'seams',
      'seam thickness',
      'seam correlation',
      'strata',
      'stratum',
      'stratigraphy',
      'lithology',
      'borehole log',
      'coal horizon',
      'parting',
      'roof rock',
      'floor rock',
      'coal band',
      'barren measure',
      'gondwana',
    ],
  },
  {
    id: 'geological-modelling',
    label: 'Geological Modelling',
    category: 'geology',
    weight: 1.2,
    related: ['coal-reserves', 'drilling', 'mine-planning', 'surveying'],
    aliases: [
      'geological model',
      'geological modelling',
      'geological modeling',
      'block model',
      'borehole database',
      'three dimensional model',
      'digital terrain model',
      'structural contour',
      'isopach',
    ],
  },
  {
    id: 'geophysical-survey',
    label: 'Geophysical Survey',
    category: 'exploration',
    weight: 1.3,
    related: ['geological-exploration', 'drilling', 'hydrogeology'],
    aliases: [
      'geophysical survey',
      'geophysics',
      'seismic survey',
      'resistivity survey',
      'magnetic survey',
      'gravity survey',
      'wireline logging',
      'well logging',
      'geophysical logging',
    ],
  },
  {
    id: 'surveying',
    label: 'Surveying & Mapping',
    category: 'exploration',
    weight: 1.1,
    related: ['geological-modelling', 'geological-exploration', 'overburden'],
    aliases: [
      'topographical survey',
      'surveying',
      'contour map',
      'total station',
      'drone survey',
      'aerial survey',
      'photogrammetry',
      'geo referencing',
      'cadastral map',
      'mine plan map',
    ],
  },
  {
    id: 'mine-planning',
    label: 'Mine Planning',
    category: 'planning',
    weight: 1.2,
    related: ['coal-reserves', 'opencast-mining', 'underground-mining', 'project-monitoring'],
    aliases: [
      'mine plan',
      'mining plan',
      'mine planning',
      'mine design',
      'pit design',
      'project report',
      'feasibility report',
      'feasibility study',
      'life of mine',
      'mine closure plan',
      'capacity expansion',
      'ultimate pit',
      'production schedule',
      'sequence of mining',
    ],
  },
  {
    id: 'opencast-mining',
    label: 'Opencast Mining',
    category: 'operations',
    weight: 1.2,
    related: ['overburden', 'blasting', 'equipment', 'coal-production'],
    aliases: [
      'opencast',
      'open cast',
      'opencast mine',
      'opencast project',
      'open pit',
      'quarry',
      'bench height',
      'haul road',
      'dragline',
      'shovel dumper',
      'surface miner',
    ],
  },
  {
    id: 'underground-mining',
    label: 'Underground Mining',
    category: 'operations',
    weight: 1.3,
    related: ['mine-safety', 'geotechnical', 'coal-production', 'equipment'],
    aliases: [
      'underground mine',
      'underground mining',
      'bord and pillar',
      'board and pillar',
      'longwall',
      'depillaring',
      'roof support',
      'roof bolting',
      'gallery',
      'incline',
      'mine shaft',
      'continuous miner',
      'goaf',
      'stowing',
    ],
  },
  {
    id: 'overburden',
    label: 'Overburden Removal',
    category: 'operations',
    weight: 1.3,
    related: ['opencast-mining', 'land-reclamation', 'equipment', 'blasting'],
    aliases: [
      'overburden',
      'overburden removal',
      'stripping ratio',
      'waste rock',
      'external dump',
      'internal dump',
      'overburden dump',
      'backfilling',
      'decoaling',
      'rehandling',
    ],
  },
  {
    id: 'blasting',
    label: 'Drilling & Blasting',
    category: 'operations',
    weight: 1.3,
    related: ['opencast-mining', 'overburden', 'mine-safety'],
    aliases: [
      'blasting',
      'controlled blasting',
      'blast design',
      'explosive consumption',
      'detonator',
      'ground vibration',
      'fly rock',
      'powder factor',
      'deep hole blasting',
    ],
  },
  {
    id: 'coal-production',
    label: 'Coal Production',
    category: 'production',
    weight: 0.8,
    related: ['dispatch', 'coal-quality', 'opencast-mining', 'equipment'],
    aliases: [
      'coal production',
      'raw coal production',
      'production',
      'coal output',
      'production target',
      'annual production',
      'production performance',
      'coal offtake',
      'raw coal',
      'saleable coal',
    ],
  },
  {
    id: 'dispatch',
    label: 'Coal Dispatch & Evacuation',
    category: 'production',
    weight: 1.1,
    related: ['coal-production', 'power-sector', 'coal-quality'],
    aliases: [
      'dispatch',
      'despatch',
      'coal dispatch',
      'coal evacuation',
      'rake loading',
      'railway siding',
      'first mile connectivity',
      'coal movement',
      'road dispatch',
      'wagon loading',
      'weighbridge',
    ],
  },
  {
    id: 'coal-quality',
    label: 'Coal Quality & Grade',
    category: 'quality',
    weight: 1.3,
    related: ['washery', 'dispatch', 'coal-seam', 'power-sector'],
    aliases: [
      'coal quality',
      'coal grade',
      'grade slippage',
      'gross calorific value',
      'calorific value',
      'ash content',
      'ash percentage',
      'moisture content',
      'volatile matter',
      'fixed carbon',
      'sulphur content',
      'useful heat value',
      'third party sampling',
      'coal sampling',
      'proximate analysis',
      'ultimate analysis',
      'gradation',
    ],
  },
  {
    id: 'washery',
    label: 'Coal Beneficiation & Washery',
    category: 'quality',
    weight: 1.4,
    related: ['coal-quality', 'coal-production', 'power-sector'],
    aliases: [
      'washery',
      'coal washery',
      'beneficiation',
      'coal washing',
      'washed coal',
      'middlings',
      'washery rejects',
      'coal preparation',
      'yield percentage',
      'float sink',
    ],
  },
  {
    id: 'geotechnical',
    label: 'Geotechnical Investigation',
    category: 'geology',
    weight: 1.4,
    related: ['underground-mining', 'opencast-mining', 'mine-safety', 'drilling'],
    aliases: [
      'geotechnical',
      'geotechnical investigation',
      'slope stability',
      'rock mass rating',
      'bearing capacity',
      'soil investigation',
      'subsidence',
      'ground control',
      'dump stability',
      'rock mechanics',
      'strata control',
    ],
  },
  {
    id: 'hydrogeology',
    label: 'Hydrogeology & Mine Water',
    category: 'geology',
    weight: 1.4,
    related: ['environment', 'geotechnical', 'geophysical-survey'],
    aliases: [
      'hydrogeology',
      'hydrogeological',
      'groundwater',
      'ground water',
      'aquifer',
      'water table',
      'dewatering',
      'mine water',
      'seepage',
      'pumping test',
      'water balance',
      'rainwater harvesting',
    ],
  },
  {
    id: 'environment',
    label: 'Environmental Management',
    category: 'environment',
    weight: 1.2,
    related: ['land-reclamation', 'regulatory-compliance', 'hydrogeology'],
    aliases: [
      'environmental management',
      'environmental impact',
      'environmental impact assessment',
      'environment management plan',
      'ambient air quality',
      'air quality',
      'water quality',
      'effluent treatment',
      'pollution control',
      'noise level',
      'fugitive dust',
      'particulate matter',
      'carbon footprint',
      'environmental monitoring',
    ],
  },
  {
    id: 'land-reclamation',
    label: 'Land Reclamation & Rehabilitation',
    category: 'environment',
    weight: 1.4,
    related: ['environment', 'overburden', 'land-acquisition'],
    aliases: [
      'land reclamation',
      'reclamation',
      'afforestation',
      'plantation',
      'biological reclamation',
      'technical reclamation',
      'mine closure',
      'restoration',
      'eco park',
      'green belt',
      'reclaimed land',
    ],
  },
  {
    id: 'mine-safety',
    label: 'Mine Safety',
    category: 'safety',
    weight: 1.3,
    related: ['underground-mining', 'geotechnical', 'blasting', 'regulatory-compliance'],
    aliases: [
      'mine safety',
      'safety management',
      'fatal accident',
      'reportable accident',
      'safety audit',
      'inundation',
      'spontaneous heating',
      'mine fire',
      'gas emission',
      'methane',
      'ventilation',
      'mines rescue',
      'safety committee',
      'internal safety organisation',
      'risk assessment',
    ],
  },
  {
    id: 'equipment',
    label: 'Mining Equipment & HEMM',
    category: 'operations',
    weight: 1.2,
    related: ['opencast-mining', 'overburden', 'coal-production'],
    aliases: [
      'heavy earth moving machinery',
      'equipment availability',
      'equipment utilisation',
      'equipment utilization',
      'capacity utilisation',
      'dumper',
      'excavator',
      'drill machine',
      'conveyor',
      'crusher',
      'idle equipment',
      'breakdown hours',
    ],
  },
  {
    id: 'land-acquisition',
    label: 'Land Acquisition & R&R',
    category: 'regulatory',
    weight: 1.3,
    related: ['regulatory-compliance', 'land-reclamation', 'csr'],
    aliases: [
      'land acquisition',
      'resettlement',
      'rehabilitation policy',
      'project affected',
      'displaced family',
      'compensation payment',
      'coal bearing areas act',
      'land possession',
      'employment against land',
    ],
  },
  {
    id: 'regulatory-compliance',
    label: 'Statutory & Regulatory Compliance',
    category: 'regulatory',
    weight: 1.0,
    related: ['environment', 'mine-safety', 'land-acquisition', 'mine-planning'],
    aliases: [
      'environmental clearance',
      'forest clearance',
      'statutory compliance',
      'mining lease',
      'lease area',
      'consent to operate',
      'consent to establish',
      'gazette notification',
      'wildlife clearance',
      'stage ii clearance',
      'compliance report',
      'statutory approval',
    ],
  },
  {
    id: 'power-sector',
    label: 'Power Sector Supply',
    category: 'commercial',
    weight: 1.3,
    related: ['dispatch', 'coal-quality', 'coal-production'],
    aliases: [
      'fuel supply agreement',
      'coal linkage',
      'thermal power plant',
      'power utility',
      'power sector',
      'independent power producer',
      'linkage auction',
      'shakti policy',
    ],
  },
  {
    id: 'financial-performance',
    label: 'Financial Performance',
    category: 'commercial',
    weight: 1.0,
    related: ['coal-production', 'project-monitoring', 'dispatch'],
    aliases: [
      'revenue from operations',
      'financial results',
      'profit before tax',
      'profit after tax',
      'turnover',
      'operating profit',
      'capital expenditure',
      'cost of production',
      'gross sales',
      'net sales',
      'levies',
      'earnings per share',
    ],
  },
  {
    id: 'manpower',
    label: 'Manpower & Productivity',
    category: 'commercial',
    weight: 1.1,
    related: ['coal-production', 'mine-safety', 'csr'],
    aliases: [
      'manpower',
      'output per manshift',
      'manshift',
      'workforce',
      'industrial relations',
      'recruitment',
      'wage agreement',
      'absenteeism',
      'employee strength',
      'contractual workers',
      'productivity per employee',
    ],
  },
  {
    id: 'project-monitoring',
    label: 'Project Monitoring',
    category: 'planning',
    weight: 1.1,
    related: ['mine-planning', 'financial-performance', 'regulatory-compliance'],
    aliases: [
      'ongoing project',
      'completed project',
      'capital project',
      'project cost',
      'time overrun',
      'cost overrun',
      'project milestone',
      'commissioning',
      'physical progress',
      'financial progress',
      'revised cost estimate',
    ],
  },
  {
    id: 'csr',
    label: 'Corporate Social Responsibility',
    category: 'commercial',
    weight: 1.3,
    related: ['land-acquisition', 'manpower', 'environment'],
    aliases: [
      'corporate social responsibility',
      'community development',
      'peripheral development',
      'skill development',
      'health camp',
      'drinking water supply',
      'csr expenditure',
      'sustainable development',
    ],
  },
];

// ── Normalised indexes, built once at module load ──────────────────────────

/** The longest alias, in TOKENS — bounds the n-gram window in the matcher. */
export const MAX_ALIAS_TOKENS = 4;

export interface AliasEntry {
  topicId: string;
  /** The tokenised key, e.g. `bord pillar`. */
  key: string;
  /** How many tokens the key spans. Longer phrases are stronger evidence. */
  tokens: number;
  /** The natural spelling, kept so a match can report what it actually saw. */
  surface: string;
}

const byId = new Map<string, CanonicalTopic>();
const aliasIndex = new Map<string, AliasEntry>();
const ocrAliasIndex = new Map<string, AliasEntry>();
/** Folded WORD -> its canonical spelling. Repairs one token at a time. */
const ocrWordIndex = new Map<string, string>();

/**
 * Fold the character confusions an OCR engine actually makes — §22.
 *
 * `Geologlcal` (l for i) and `Geological` collapse to the same key here, which
 * is what lets a scanned page match the taxonomy without an edit-distance
 * search over every alias for every token.
 *
 * `rn` -> `m` runs FIRST because it consumes two characters; running it after
 * the single-character folds would never fire. `cl` -> `d` is a real confusion
 * and is deliberately NOT folded: it rewrites ordinary words into other
 * ordinary words (`clean` -> `dean`), which is a false-positive risk that the
 * others do not carry.
 */
export function ocrFold(word: string): string {
  return word
    .replace(/rn/g, 'm')
    .replace(/[il1|!]/g, 'i')
    .replace(/[o0]/g, 'o')
    .replace(/[s5]/g, 's')
    .replace(/[b8]/g, 'b')
    .replace(/[g9]/g, 'g')
    .replace(/[^a-z]/g, '');
}

/** Below this length a folded key collides too readily to be trusted. */
const MIN_OCR_FOLD_LENGTH = 6;

for (const topic of TAXONOMY) {
  if (byId.has(topic.id)) throw new Error(`taxonomy: duplicate topic id ${topic.id}`);
  byId.set(topic.id, topic);

  for (const alias of topic.aliases) {
    const tokens = tokenize(alias);
    // An alias that tokenises to nothing is all stopwords and can never match;
    // silently keeping it would make the list look richer than it is.
    if (tokens.length === 0 || tokens.length > MAX_ALIAS_TOKENS) continue;

    const key = tokens.join(' ');
    const entry: AliasEntry = { topicId: topic.id, key, tokens: tokens.length, surface: alias };

    // First writer wins, so a phrase shared by two topics belongs to the one
    // declared first. Deterministic, and the list order is reviewable.
    if (!aliasIndex.has(key)) aliasIndex.set(key, entry);

    const folded = tokens.map(ocrFold).join(' ');
    if (folded.replace(/ /g, '').length >= MIN_OCR_FOLD_LENGTH && !ocrAliasIndex.has(folded)) {
      ocrAliasIndex.set(folded, entry);
    }

    // Every WORD of every alias, folded on its own.
    //
    // The phrase index above recognises `geologlcal lnvestlgatlon` as a whole
    // and reports the topic correctly — but the misreadings themselves are
    // still what lands in the keyword list beside it. Repairing token by token
    // is what lets `geologlcal` be STORED as `geological`, and it reaches words
    // like `geological` and `overburden` that never appear as a one-word alias.
    for (const word of tokens) {
      if (word.length < MIN_OCR_FOLD_LENGTH) continue;
      const foldedWord = ocrFold(word);
      if (!ocrWordIndex.has(foldedWord)) ocrWordIndex.set(foldedWord, word);
    }
  }
}

// A related id that does not exist is a typo that would silently drop an edge.
for (const topic of TAXONOMY) {
  for (const id of topic.related) {
    if (!byId.has(id)) throw new Error(`taxonomy: ${topic.id} relates to unknown topic ${id}`);
  }
}

export function topicById(id: string): CanonicalTopic | undefined {
  return byId.get(id);
}

/** Exact token-key lookup. */
export function aliasFor(key: string): AliasEntry | undefined {
  return aliasIndex.get(key);
}

/** OCR-tolerant lookup, used only after `aliasFor` misses (§22). */
export function foldedAliasFor(key: string): AliasEntry | undefined {
  return ocrAliasIndex.get(key);
}

/**
 * The canonical spelling of a single mis-OCRed word, if the taxonomy knows one.
 *
 * Words shorter than `MIN_OCR_FOLD_LENGTH` are deliberately not repairable: the
 * fold collapses enough characters that a short key stops being distinctive,
 * and rewriting a four-letter word into a different four-letter word is a
 * corruption dressed as a correction.
 */
export function foldedWordFor(folded: string): string | undefined {
  return ocrWordIndex.get(folded);
}

/** Every canonical topic, for the topic filter's option list. */
export function allTopics(): readonly CanonicalTopic[] {
  return TAXONOMY;
}

/**
 * A display label for any topic id, including discovered ones.
 *
 * Discovered ids are `discovered:<slug>`; their label is the slug with hyphens
 * restored to spaces and each word capitalised, which is the closest thing to
 * a name a phrase nobody curated can have.
 */
export function labelForTopicId(id: string): string {
  const known = byId.get(id);
  if (known) return known.label;
  const slug = id.startsWith('discovered:') ? id.slice('discovered:'.length) : id;
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function categoryForTopicId(id: string): TopicCategory {
  return byId.get(id)?.category ?? 'discovered';
}
