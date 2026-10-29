/**
 * EntityExtractor — LLM-driven entity & relation extraction with regex fallback.
 *
 * Primary: uses a cheap LLM for near-perfect person/org extraction.
 * Fallback: pure regex + heuristics when no LLM configured or call fails.
 *
 * The fallback path emits `MENTIONED` and nothing else. It cannot type a
 * relation: a keyword hit anywhere in the text is not a predicate. The removed
 * inference tested each `RELATION_PATTERNS` keyword against the whole memory and
 * gave the highest-priority hit to *every* entity in it, which is how a weather
 * answer containing 建议 produced `穿衣建议 —ADVISES→ 周五` and a memory about
 * "何时会使用" produced `复杂任务 —FOUNDED→ 何时` — 14 typed but baseless
 * `memory_links` rows at confidence 0.9–0.95 on a real 712-memory database.
 * Adjacency, sentence and subject/predicate/object structure are what attest a
 * relation, and only the LLM path reads those — it takes `relationType` from the
 * model (`parseLLMEntities`).
 *
 * Data files (editable without touching code):
 *   data/chinese-surnames.json   — surname lists for regex fallback
 *   data/entity-stop-words.json  — common words that trigger false positives
 *   data/entity-generic-terms.json — multi-language filter for LLM misreports
 */

import type { Logger } from 'pino';
import type { AuxModelConfig } from './aux-llm-client.js';
import { auxLLMCall } from './aux-llm-client.js';
import { errorForObservation, hashForObservation, memoryObservability } from './observability.js';
import { cutCJK } from './fts-tokenizer.js';
// The graph layer owns "is this string a name or a phrase"; reusing it keeps the
// write path and the projection from disagreeing about what may be an endpoint.
import {
  directionOf,
  isTokenAlignedMention,
  isVouchableEntityName,
} from '../graph/entity-mining.js';

import surnames from './data/chinese-surnames.json' with { type: 'json' };
import stopWords from './data/entity-stop-words.json' with { type: 'json' };
import genericTermsData from './data/entity-generic-terms.json' with { type: 'json' };

export interface ExtractedEntity {
  entity: string;
  relationType: string;
  confidence: number;
  /** `PERSON|ORG|PRODUCT|CONCEPT` when the producer named one. */
  entityType?: string;
}

export interface LLMExtractionConfig {
  auxConfig?: AuxModelConfig;
  enabled: boolean;
  minConfidence: number;
  logger: Logger;
}

// ─── Data loaded from JSON files ────────────────────────────────────

const CN_SURNAMES = new Set(surnames.single);
const CN_COMPOUND_SURNAMES = new Set(surnames.compound);
const COMMON_WORDS = new Set(stopWords['zh-CN'].commonWords);
const NAME_ENDING_STOPS = new Set(stopWords['zh-CN'].nameEndingStops);
const STOP_ENTITIES = new Set(stopWords['zh-CN'].stopEntities);

// Merge all language generic terms
const GENERIC_TERMS = new Set<string>();
for (const langTerms of Object.values(genericTermsData.terms)) {
  for (const term of langTerms) GENERIC_TERMS.add(term);
}

// ─── Relation priority (LLM path only) ──────────────────────────────

/**
 * Closed relation vocabulary, used to validate what the model returned.
 *
 * It used to be five social/business predicates, which is an ontology for people
 * and companies. On a technical corpus — Excel, Power Query, excel-mcp, Termux —
 * the only truthful answer in that vocabulary was `MENTIONED`, and `MENTIONED`
 * is deliberately not an edge, so the graph was 371 isolated nodes on the
 * reference device: every entity the corpus talks about, nothing about how they
 * hang together. `USES`/`DEPENDS_ON`/`PART_OF`/`EXTENDS` are what a tool corpus
 * actually states, so they are in the vocabulary now and the projector attests
 * them from the same text (see `RELATION_EVIDENCE` in `src/graph/entity-mining.ts`).
 *
 * Ordering only matters when one memory yields several relations: the more
 * specific, harder-to-earn predicate wins.
 */
const RELATION_PRIORITY: Record<string, number> = {
  FOUNDED: 10,
  INVESTED: 9,
  ADVISES: 8,
  WORKS_AT: 7,
  USES: 6,
  ATTENDED: 5,
  DEPENDS_ON: 4,
  PART_OF: 3,
  EXTENDS: 2,
  MENTIONED: 1,
};

// ─── Regex patterns (fallback path) ─────────────────────────────────

const CN_NAME_SHAPE = (() => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const single = [...CN_SURNAMES].map(esc).join('|');
  const compound = [...CN_COMPOUND_SURNAMES].map(esc).join('|');
  return `(?:${compound}|${single})[一-鿿]{1,2}`;
})();

/** Fallback scan over a bare CJK run (no jieba available). */
const CN_NAME_RE = new RegExp(CN_NAME_SHAPE, 'g');

/** Whole-token test: this one jieba token is shaped like a Chinese name. */
const CN_NAME_TOKEN_RE = new RegExp(`^${CN_NAME_SHAPE}$`);

const EN_NAME_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g;

const ORG_RE = new RegExp(
  `[\\u4e00-\\u9fffA-Z][\\u4e00-\\u9fffA-Za-z]{1,20}(?:公司|有限公司|科技|集团|股份|企业|Inc|Corp|Ltd|LLC|GmbH|S\\.A\\.|大学|学院|医院|研究所|实验室)`,
  'g',
);

// ─── Name context ───────────────────────────────────────────────────

const NAME_CONTEXT_RE = /的|说|告诉|和|跟|与|是|先生|女士|老师|经理|总|工|同事|朋友|客户|用户/i;

// ─── Helpers ────────────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
}

function isStopEntity(entity: string): boolean {
  const lower = entity.toLowerCase();
  if (STOP_ENTITIES.has(lower)) return true;
  if (/^\d+$/.test(entity)) return true;
  if (entity.length < 2) return true;
  if (COMMON_WORDS.has(entity)) return true;
  return false;
}

function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x4e00 && cp <= 0x9fff;
}

function hasCommonBigramBoundary(text: string, matchIndex: number, matchLength: number): boolean {
  if (matchIndex > 0) {
    const before = text[matchIndex - 1];
    if (isCJKChar(before) && COMMON_WORDS.has(before + text[matchIndex])) return true;
  }
  const lastIdx = matchIndex + matchLength - 1;
  if (lastIdx + 1 < text.length) {
    const after = text[lastIdx + 1];
    if (isCJKChar(after) && COMMON_WORDS.has(text[lastIdx] + after)) return true;
  }
  return false;
}

function overlapsWithCommonWord(entity: string): boolean {
  if (entity.length < 2) return false;
  if (COMMON_WORDS.has(entity.slice(0, 2))) return true;
  if (entity.length >= 3 && COMMON_WORDS.has(entity.slice(-2))) return true;
  return false;
}

function isPureCJK(value: string): boolean {
  if (value.length === 0) return false;
  for (const ch of value) if (!isCJKChar(ch)) return false;
  return true;
}

// ─── CJK person candidates ──────────────────────────────────────────

interface CJKTokenSpan {
  token: string;
  start: number;
}

/**
 * jieba tokens with their offsets in `text`, or null when jieba is unavailable.
 *
 * Null is also returned when the tokens do not tile the text: offsets are
 * recovered by locating each token after the previous one, so a mismatch means
 * an alignment we cannot prove — the caller falls back to the conservative rule
 * rather than trusting it.
 */
function cjkTokenSpans(text: string): CJKTokenSpan[] | null {
  const tokens = cutCJK(text);
  if (tokens.length === 0) return null;
  const spans: CJKTokenSpan[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const start = text.indexOf(token, cursor);
    if (start < 0) return null;
    spans.push({ token, start });
    cursor = start + token.length;
  }
  return spans;
}

/**
 * Chinese person candidates.
 *
 * A surname-anchored substring is not a name: `如何称呼` contains 何称 and
 * `张照奇` contains 张奇 and 张照, because 何, 张, 林 are surnames and every
 * prose sentence contains them. So a candidate is admitted only where the text
 * proves a *word boundary* at both ends — that boundary is what the surname
 * heuristic was standing in for.
 *
 * - With jieba: the candidate must be exactly one whole token (see
 *   {@link cjkTokenSpans}) that is pure CJK and name-shaped. 如何/称呼, 一张/图片
 *   and 工程师 never produce a name-shaped whole token; 张伟今 is not a token
 *   while 张伟 is, so the greedy `[一-鿿]{1,2}` over-capture no longer costs the
 *   real name (the old `full.slice(0, -1)` did — it produced 王小 out of 王小明
 *   and the prefix dedupe then discarded the real name).
 * - Without jieba: no boundary can be proven inside a CJK run, so a candidate is
 *   admitted only when both of its neighbours are non-CJK (i.e. it *is* the
 *   whole run). Conservative on purpose: an entity nobody confirmed is worse
 *   than a missed one, and jieba ships with the repo.
 */
function cjkNameCandidates(cleaned: string): Candidate[] {
  const out: Candidate[] = [];
  const spans = cjkTokenSpans(cleaned);
  if (spans) {
    for (const span of spans) {
      if (!isPureCJK(span.token)) continue;
      if (!CN_NAME_TOKEN_RE.test(span.token)) continue;
      out.push({ entity: span.token, source: 'cn_name', idx: span.start });
    }
    return out;
  }
  for (const match of cleaned.matchAll(CN_NAME_RE)) {
    const idx = match.index!;
    const before = idx > 0 ? cleaned[idx - 1] : '';
    const after = cleaned[idx + match[0].length] ?? '';
    if (before !== '' && isCJKChar(before)) continue;
    if (after !== '' && isCJKChar(after)) continue;
    out.push({ entity: match[0], source: 'cn_name', idx });
  }
  return out;
}

// ─── Regex-based extraction (fallback path) ─────────────────────────

type CandidateSource = 'cn_name' | 'en_name' | 'org';

interface Candidate {
  entity: string;
  source: CandidateSource;
  idx: number;
}

export interface ExtractOptions {
  scope?: string;
  kind?: string;
  /**
   * Called when the model path did not produce entities and the deterministic
   * extractor answered instead. Without this a caller cannot tell "the model
   * said nothing worth recording" from "every model call failed", and a run that
   * wrote zero typed relations looked identical to a run with nothing to do.
   */
  onFallback?: (reason: 'llm_error' | 'llm_empty') => void;
}

export function extractEntities(text: string, options?: ExtractOptions): ExtractedEntity[] {
  const cleaned = stripCodeFences(text);
  const entities = new Map<string, number>();

  const candidates: Candidate[] = cjkNameCandidates(cleaned);

  for (const match of cleaned.matchAll(EN_NAME_RE)) {
    candidates.push({ entity: match[0], source: 'en_name', idx: match.index! });
  }

  for (const match of cleaned.matchAll(ORG_RE)) {
    candidates.push({ entity: match[0], source: 'org', idx: match.index! });
  }

  const unique: Candidate[] = [];
  for (const c of candidates) {
    if (isStopEntity(c.entity)) continue;
    if (GENERIC_TERMS.has(c.entity)) continue;
    if (c.source === 'cn_name') {
      // Whole-token candidates cannot be prefixes of each other within one
      // occurrence, but the same name may appear bare and inside a longer
      // match later in the text; the shorter form is the entity.
      const hasShorter = unique.some(
        (u) =>
          u.source === 'cn_name' &&
          c.entity.startsWith(u.entity) &&
          c.entity.length > u.entity.length,
      );
      if (hasShorter) continue;
      for (let i = unique.length - 1; i >= 0; i--) {
        if (
          unique[i].source === 'cn_name' &&
          unique[i].entity.startsWith(c.entity) &&
          unique[i].entity.length > c.entity.length
        ) {
          unique.splice(i, 1);
        }
      }
      if (overlapsWithCommonWord(c.entity)) continue;
      if (hasCommonBigramBoundary(cleaned, c.idx, c.entity.length)) continue;
    }
    if (unique.some((u) => u.entity.toLowerCase() === c.entity.toLowerCase())) continue;
    unique.push(c);
  }

  for (const candidate of unique) {
    let confidence = 0.6;

    if (candidate.source === 'cn_name') confidence = Math.min(1.0, confidence + 0.15);
    if (candidate.source === 'en_name') confidence = Math.min(1.0, confidence + 0.1);
    if (candidate.source === 'org' && options?.scope === 'user')
      confidence = Math.min(1.0, confidence + 0.05);

    // Below 0.8 a candidate also has to sit next to a name-shaped context
    // (的/说/是/老师 …), which drops surname-shaped ordinary words that have no
    // such neighbour (何时 in "复杂任务何时会使用", 周五 in "穿衣建议：周五"). It is
    // a heuristic, not a proof: a surname-shaped common word that lands inside a
    // real name context (顾问 after 是这里的) still passes — those belong in
    // `data/entity-stop-words.json` commonWords, not in another regex here.
    if (confidence < 0.8 && candidate.source !== 'org') {
      const ctxStart = Math.max(0, candidate.idx - 6);
      const ctxEnd = Math.min(cleaned.length, candidate.idx + candidate.entity.length + 6);
      if (!NAME_CONTEXT_RE.test(cleaned.slice(ctxStart, ctxEnd))) continue;
    }

    entities.set(candidate.entity, confidence);
  }

  const result: ExtractedEntity[] = [];
  for (const [entity, confidence] of entities) {
    result.push({
      entity,
      relationType: 'MENTIONED',
      confidence: Math.round(confidence * 100) / 100,
    });
  }
  result.sort((a, b) => b.confidence - a.confidence);
  return result;
}

// ─── LLM-driven extraction (primary path) ───────────────────────────

/**
 * A relation the text *states*, quoted from the text.
 *
 * The entity list shape this replaces could only say "these names appear", so the
 * write path had to compose a triple out of two different answers: the subject
 * came from the mining pass and the relation from a model talking about the
 * object. Measured on a real memory ("用户偏好使用 excel-mcp，而不是 Python")
 * that produced `Python —USES→ excel-mcp` — a statement neither producer made,
 * and one the sentence argues against. A triple carries its own anchor, so
 * nothing has to be composed.
 */
export interface EntityTriple {
  subject: string;
  subjectType?: string;
  relation: string;
  object: string;
  objectType?: string;
  /** The span the model copied out of the memory; verified literally below. */
  evidence?: string;
  confidence: number;
}

const LLM_TRIPLE_PROMPT = [
  'You extract the relations a text STATES between the entities it names.',
  'Output ONLY a JSON array, one object per stated relation:',
  '[{"subject":"A","relation":"USES","object":"B","evidence":"the words that say so","confidence":0.9}]',
  '',
  'relation is exactly one of:',
  'FOUNDED, INVESTED, ADVISES, WORKS_AT, ATTENDED, USES, DEPENDS_ON, PART_OF, EXTENDS.',
  // Widened after a measured miss: "希望使用 Power Query 获取 Excel 文件信息" is a
  // stated use, and the model answered []. Spelling out that handling a file
  // format counts — and that a stated intention counts — is what turned that
  // answer into a triple. The endpoint rules did not move: the model then offered
  // `Excel 文件` as an object, and the token-alignment gate still refuses it.
  'USES = one thing is used, called, run or applied to do something, including a',
  '  tool that reads, writes or handles a file format, a site or an API. A stated',
  '  intention ("希望使用 X") counts as a use;',
  'DEPENDS_ON = requires, needs, only works with, must be installed first;',
  'PART_OF = is a feature, component, module or subset of;',
  'EXTENDS = extends, forks, is built on top of.',
  '',
  'Rules:',
  '- subject and object are entity names exactly as the text writes them',
  '- evidence is the shortest span of the text that states this relation, copied',
  '  character for character, and it must contain BOTH subject and object',
  '- a pair the text merely mentions is NOT a relation — omit it',
  '- subject is the actor or the owner: write "X uses Y", never "Y uses X". A',
  '  passive sentence ("Y 被 X 使用", "Y was built by X") states the same relation',
  '  in that order, so invert it to the active form instead of copying the order',
  '- no relation stated anywhere -> output []',
  '- no prose, no markdown fences',
].join('\n');

export async function extractTriplesLLM(
  text: string,
  config: LLMExtractionConfig,
  options?: ExtractOptions,
): Promise<EntityTriple[]> {
  const hasModel = config.auxConfig?.modelRef || (config.auxConfig?.fallbackRefs?.length ?? 0) > 0;
  if (!config.enabled || !hasModel) return [];
  // A JSON record (a distilled profile, an exported row) is not prose: there is
  // no sentence stating a relation, and the model spends its whole budget
  // reasoning about a "task" it was never given. Measured: a profile blob was the
  // only content shape that still came back truncated after the budget increase.
  if (looksLikeJsonDocument(text)) return [];

  try {
    const response = await auxLLMCall(config.auxConfig!, {
      systemPrompt: LLM_TRIPLE_PROMPT,
      userPrompt: text,
      temperature: 0,
      // 300 was too small for a reasoning model: the budget went into the
      // reasoning stream and the JSON never got emitted, so every extraction
      // fell back to the regex path even though the call itself succeeded.
      maxTokens: 1500,
      logger: config.logger,
    });

    const values = parseEntityJsonValues(response);
    // "The model returned nothing parseable" is a real failure. "The model
    // returned JSON saying there is no relation" is a success — conflating the
    // two is what made a healthy run look like a broken one.
    if (values.length === 0 && !/^\s*\[\s*\]\s*$/.test(response)) {
      options?.onFallback?.('llm_empty');
      return [];
    }

    const triples = values
      .map((value) => readTriple(value, text))
      .filter((triple): triple is EntityTriple => triple !== null)
      .filter((triple) => triple.confidence >= config.minConfidence);

    const deduped = new Map<string, EntityTriple>();
    for (const triple of triples) {
      const key = [
        canonicalNameKey(triple.subject),
        triple.relation,
        canonicalNameKey(triple.object),
      ].join('|');
      if (!deduped.has(key)) deduped.set(key, triple);
    }
    config.logger.debug(
      { objects: values.length, triples: deduped.size },
      'LLM triple extraction finished',
    );
    return [...deduped.values()];
  } catch (err) {
    memoryObservability.record('memory.entity.failed', {
      contentHash: hashForObservation(text),
      contentLength: text.length,
      error: errorForObservation(err),
    });
    config.logger.info({ err }, 'LLM triple extraction failed');
    options?.onFallback?.('llm_error');
    return [];
  }
}

function looksLikeJsonDocument(text: string): boolean {
  // Deliberately shape-only: `JSON.parse` would miss a *truncated* record, and a
  // truncated record is exactly what gets fed back by the profile distillers. A
  // memory that opens with a brace is a row, not a sentence, whether or not its
  // tail survived.
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/** Whitespace- and case-insensitive comparison key. */
function canonicalNameKey(name: string): string {
  return name.trim().replace(/\s+/g, '').toLowerCase();
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * One parsed object → one verified triple, or `null` if any gate refuses it.
 *
 * Every gate here fails *closed*, unlike the graph gates: this decides what gets
 * written, and a triple is only worth writing when the text itself backs it. The
 * cheapest such proof is `evidence` — the model must copy the span, and a copied
 * span can be looked for in the source. A model that paraphrases or invents is
 * caught here for the price of an `includes()`.
 */
function readTriple(value: unknown, text: string): EntityTriple | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const subject = firstString(obj, ['subject', 'source', 'from', 'head', 'entity']);
  const object = firstString(obj, ['object', 'target', 'to', 'tail', 'entity2']);
  const relation = firstString(obj, ['relation', 'relationship', 'predicate', 'rel']);
  if (!subject || !object || !relation) return null;
  if (!RELATION_PRIORITY[relation]) return null;
  if (subject.length > 80 || object.length > 80) return null;
  if (GENERIC_TERMS.has(subject) || GENERIC_TERMS.has(object)) return null;
  if (!isVouchableEntityName(subject) || !isVouchableEntityName(object)) return null;
  // A phrase the tokenizer splits is not an entity ("Excel 相关操作"), and a
  // fragment sliced out of a longer word is not a mention of anything.
  if (!isTokenAlignedMention(text, subject) || !isTokenAlignedMention(text, object)) return null;
  const subjectKey = canonicalNameKey(subject);
  const objectKey = canonicalNameKey(object);
  if (subjectKey === '' || objectKey === '' || subjectKey === objectKey) return null;

  // Both endpoints must actually occur in the memory: a name the text never
  // writes cannot be a thing the text said something about.
  const haystack = normalizeForMatch(text);
  if (!haystack.includes(subjectKey) || !haystack.includes(objectKey)) return null;

  const evidence = firstString(obj, ['evidence', 'quote', 'span', 'support']);
  if (evidence !== undefined) {
    // An evidence span the text does not contain is worse than none: it reads as
    // proof and is not.
    const quoted = normalizeForMatch(evidence);
    if (!haystack.includes(quoted)) return null;
    // ...and it has to quote *both* endpoints. This is what catches a model that
    // names a descriptive phrase as the subject: measured on "通过 excel-mcp 使用
    // Power Query 获取文件" it answered `Excel 相关操作 —USES→ excel-mcp`, and the
    // span it quoted contains excel-mcp but not "Excel 相关操作".
    if (!quoted.includes(subjectKey) || !quoted.includes(objectKey)) return null;
  }

  // Word order. Every gate above proves the two names and the predicate are in
  // the memory; none of them notices which way round the model wrote them, and
  // `Power Query —USES→ excel-mcp` is then an edge that closes the true one.
  // The quoted span is the narrowest statement available, so it is judged first;
  // when it cannot answer (it may drop the verb) the whole memory is asked
  // instead. Only a provable reversal refuses — an unmeasurable direction is not
  // a disproven one, and this is the one gate whose `unknown` stays admissible.
  const quotedDirection =
    evidence === undefined ? 'unknown' : directionOf(evidence, relation, subject, object);
  const direction =
    quotedDirection === 'unknown' ? directionOf(text, relation, subject, object) : quotedDirection;
  if (direction === 'reversed') return null;

  const confidence =
    typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : evidence
        ? 0.9
        : 0.8;

  const subjectType = firstString(obj, ['subjectType', 'subject_type']);
  const objectType = firstString(obj, ['objectType', 'object_type', 'type']);
  const triple: EntityTriple = { subject, relation, object, confidence };
  if (subjectType) triple.subjectType = subjectType.toUpperCase();
  if (objectType) triple.objectType = objectType.toUpperCase();
  if (evidence) triple.evidence = evidence;
  return triple;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Mention-only view of the same model call, kept for callers that store
 * `memory_links` rows without relation structure.
 *
 * The endpoints of a stated relation are, by construction, mentioned — so this
 * does not need a second model call, and it never has to invent a subject.
 */
export async function extractEntitiesLLM(
  text: string,
  config: LLMExtractionConfig,
  options?: ExtractOptions,
): Promise<ExtractedEntity[]> {
  const triples = await extractTriplesLLM(text, config, options);
  const byName = new Map<string, ExtractedEntity>();
  for (const triple of triples) {
    for (const [name, type] of [
      [triple.subject, triple.subjectType],
      [triple.object, triple.objectType],
    ] as const) {
      const key = canonicalNameKey(name);
      const existing = byName.get(key);
      if (!existing || existing.confidence < triple.confidence) {
        byName.set(key, {
          entity: name,
          relationType: 'MENTIONED',
          confidence: triple.confidence,
          ...(type ? { entityType: type } : {}),
        });
      }
    }
  }
  if (byName.size === 0) {
    // No relation stated. The deterministic pass still names entities, and those
    // mentions are what the graph's nodes are built from.
    return extractEntities(text, options);
  }
  return [...byName.values()];
}

export function parseLLMEntities(response: string): ExtractedEntity[] {
  const values = parseEntityJsonValues(response);
  const entities: ExtractedEntity[] = [];
  for (const parsed of values) {
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as {
      entity?: unknown;
      type?: unknown;
      relation?: unknown;
      confidence?: unknown;
    };
    if (typeof obj.entity !== 'string') continue;
    const name = obj.entity.trim();
    if (!name || GENERIC_TERMS.has(name)) continue;
    const relationType =
      typeof obj.relation === 'string' && RELATION_PRIORITY[obj.relation] !== undefined
        ? obj.relation
        : 'MENTIONED';
    const fallbackConfidence = obj.type === 'PERSON' ? 0.95 : 0.85;
    const confidence =
      typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
        ? Math.max(0, Math.min(1, obj.confidence))
        : fallbackConfidence;
    entities.push({ entity: name, relationType, confidence });
  }
  return entities;
}

function parseEntityJsonValues(response: string): unknown[] {
  const trimmed = response.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const values: unknown[] = [];
    for (const line of response.split('\n')) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed.startsWith('{')) continue;
      try {
        values.push(JSON.parse(lineTrimmed));
      } catch {
        memoryObservability.record('memory.entity.failed', {
          stage: 'parse_json_line',
          lineHash: hashForObservation(lineTrimmed),
        });
      }
    }
    if (values.length > 0) return values;
    return salvageJsonObjects(response);
  }
}

/**
 * Pull every balanced `{...}` out of a response that is not valid JSON as a
 * whole.
 *
 * Measured need: a reasoning model emits its JSON inside the reasoning stream,
 * and the stream is cut off at `max_tokens`. The truncated tail cannot parse,
 * but every object before the cut is complete — before this scan, one truncation
 * meant "the model produced nothing" and the run fell back to the regex path
 * while the answer was sitting there. Strings are skipped so braces inside a
 * name cannot unbalance the scan.
 */
function salvageJsonObjects(response: string): unknown[] {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < response.length; index++) {
    const char = response[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(response.slice(start, index + 1)));
        } catch {
          // Not JSON (prose with braces): keep scanning, the next object may be.
        }
        start = -1;
      }
    }
  }
  return values;
}
