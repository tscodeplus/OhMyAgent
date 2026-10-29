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

import surnames from './data/chinese-surnames.json' with { type: 'json' };
import stopWords from './data/entity-stop-words.json' with { type: 'json' };
import genericTermsData from './data/entity-generic-terms.json' with { type: 'json' };

export interface ExtractedEntity {
  entity: string;
  relationType: string;
  confidence: number;
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

const LLM_EXTRACTION_PROMPT =
  'Extract the named entities from the text: people, organizations, products, tools, ' +
  'platforms and technical concepts. Relation is how the text connects the entity to ' +
  'what the sentence is about — USES (a tool/feature is used, called, run or applied), ' +
  'DEPENDS_ON (requires, needs, only works with), PART_OF (is a part, feature or ' +
  'component of), EXTENDS (extends, forks, is built on top of), plus the social ones. ' +
  'Use MENTIONED only when the text names the entity and states nothing about it. ' +
  'Output ONLY a JSON array:\n' +
  '[{"entity":"name","type":"PERSON|ORG|PRODUCT|CONCEPT",' +
  '"relation":"FOUNDED|INVESTED|ADVISES|WORKS_AT|ATTENDED|USES|DEPENDS_ON|PART_OF|EXTENDS|MENTIONED",' +
  '"confidence":0.9}]\n' +
  'If no entities, output [].';

export async function extractEntitiesLLM(
  text: string,
  config: LLMExtractionConfig,
  options?: ExtractOptions,
): Promise<ExtractedEntity[]> {
  const hasModel = config.auxConfig?.modelRef || (config.auxConfig?.fallbackRefs?.length ?? 0) > 0;
  if (!config.enabled || !hasModel) {
    return extractEntities(text, options);
  }

  try {
    const response = await auxLLMCall(config.auxConfig!, {
      systemPrompt: LLM_EXTRACTION_PROMPT,
      userPrompt: text,
      temperature: 0,
      // 300 was too small for a reasoning model: the budget went into the
      // reasoning stream and the JSON never got emitted, so every extraction
      // fell back to the regex path even though the call itself succeeded.
      maxTokens: 1000,
      logger: config.logger,
    });

    const entities = parseLLMEntities(response);

    if (entities.length > 0) {
      config.logger.debug({ count: entities.length }, 'LLM entity extraction succeeded');
      return entities.filter((e) => e.confidence >= config.minConfidence);
    }

    options?.onFallback?.('llm_empty');
    return extractEntities(text, options);
  } catch (err) {
    memoryObservability.record('memory.entity.failed', {
      contentHash: hashForObservation(text),
      contentLength: text.length,
      error: errorForObservation(err),
    });
    config.logger.info({ err }, 'LLM entity extraction failed, falling back to regex');
    options?.onFallback?.('llm_error');
    return extractEntities(text, options);
  }
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
