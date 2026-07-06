/**
 * EntityExtractor — LLM-driven entity & relation extraction with regex fallback.
 *
 * Primary: uses a cheap LLM for near-perfect person/org extraction.
 * Fallback: pure regex + heuristics when no LLM configured or call fails.
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

// ─── Relation priority ──────────────────────────────────────────────

const RELATION_PRIORITY: Record<string, number> = {
  FOUNDED: 6, INVESTED: 5, ADVISES: 4, WORKS_AT: 3, ATTENDED: 2, MENTIONED: 1,
};

// ─── Regex patterns (fallback path) ─────────────────────────────────

const CN_NAME_RE = (() => {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const single = [...CN_SURNAMES].map(esc).join('|');
  const compound = [...CN_COMPOUND_SURNAMES].map(esc).join('|');
  return new RegExp(`(?:${compound}|${single})[一-鿿]{1,2}`, 'g');
})();

const EN_NAME_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g;

const ORG_RE = new RegExp(
  `[\\u4e00-\\u9fffA-Z][\\u4e00-\\u9fffA-Za-z]{1,20}(?:公司|有限公司|科技|集团|股份|企业|Inc|Corp|Ltd|LLC|GmbH|S\\.A\\.|大学|学院|医院|研究所|实验室)`,
  'g',
);

// ─── Relation keywords ──────────────────────────────────────────────

interface RelationPattern { type: string; keywords: RegExp[] }

const RELATION_PATTERNS: RelationPattern[] = [
  { type: 'FOUNDED',   keywords: [/创立|创建|创办|成立|开了|建立了/i, /founded|created|established|started/i] },
  { type: 'INVESTED',  keywords: [/投资|入股|投了|融资|参股/i, /invested|funded|backed|financed/i] },
  { type: 'ADVISES',   keywords: [/顾问|指导|咨询|建议/i, /advises|consults|mentors|guides/i] },
  { type: 'WORKS_AT',  keywords: [/在.{1,10}(工作|上班|任职|就职|担任|做)/i, /works at|employed by|joined|works for|engineer at/i] },
  { type: 'ATTENDED',  keywords: [/参加|参与|出席|去了|在场/i, /attended|participated|joined|went to/i] },
  { type: 'MENTIONED', keywords: [/提到|说起|谈起|说过/i, /mentioned|talked about|discussed|referred to/i] },
];

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
  return cp >= 0x4E00 && cp <= 0x9FFF;
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

// ─── Regex-based extraction (fallback path) ─────────────────────────

export interface ExtractOptions {
  scope?: string;
  kind?: string;
}

export function extractEntities(text: string, options?: ExtractOptions): ExtractedEntity[] {
  const cleaned = stripCodeFences(text);
  const entities: Map<string, { type: string; priority: number; confidence: number }> = new Map();

  const candidates: { entity: string; source: 'cn_name' | 'en_name' | 'org'; idx: number }[] = [];

  for (const match of cleaned.matchAll(CN_NAME_RE)) {
    const full = match[0];
    if (full.length >= 3) {
      const short = full.slice(0, -1);
      if (short.length >= 2) candidates.push({ entity: short, source: 'cn_name', idx: match.index! });
    }
    candidates.push({ entity: full, source: 'cn_name', idx: match.index! });
  }

  for (const match of cleaned.matchAll(EN_NAME_RE)) {
    candidates.push({ entity: match[0], source: 'en_name', idx: match.index! });
  }

  for (const match of cleaned.matchAll(ORG_RE)) {
    candidates.push({ entity: match[0], source: 'org', idx: match.index! });
  }

  const unique: typeof candidates = [];
  for (const c of candidates) {
    if (isStopEntity(c.entity)) continue;
    if (GENERIC_TERMS.has(c.entity)) continue;
    if (c.source === 'cn_name') {
      const hasShorter = unique.some(u => u.source === 'cn_name' && c.entity.startsWith(u.entity) && c.entity.length > u.entity.length);
      if (hasShorter) continue;
      for (let i = unique.length - 1; i >= 0; i--) {
        if (unique[i].source === 'cn_name' && unique[i].entity.startsWith(c.entity) && unique[i].entity.length > c.entity.length) {
          unique.splice(i, 1);
        }
      }
      if (overlapsWithCommonWord(c.entity)) continue;
      if (hasCommonBigramBoundary(cleaned, c.idx, c.entity.length)) continue;
    }
    if (unique.some(u => u.entity.toLowerCase() === c.entity.toLowerCase())) continue;
    unique.push(c);
  }

  for (const candidate of unique) {
    let bestType = 'MENTIONED';
    let bestPriority = RELATION_PRIORITY.MENTIONED;
    let confidence = 0.6;

    for (const pattern of RELATION_PATTERNS) {
      for (const kw of pattern.keywords) {
        if (kw.test(cleaned)) {
          const prio = RELATION_PRIORITY[pattern.type] ?? 0;
          if (prio > bestPriority) { bestType = pattern.type; bestPriority = prio; }
        }
      }
    }

    if (candidate.source === 'cn_name') confidence = Math.min(1.0, confidence + 0.15);
    if (candidate.source === 'en_name') confidence = Math.min(1.0, confidence + 0.1);
    if (bestType !== 'MENTIONED') confidence = Math.min(1.0, confidence + 0.2);
    if (candidate.source === 'org' && options?.scope === 'user') confidence = Math.min(1.0, confidence + 0.05);

    if (bestType === 'MENTIONED' && confidence < 0.8 && candidate.source !== 'org') {
      const ctxStart = Math.max(0, candidate.idx - 6);
      const ctxEnd = Math.min(cleaned.length, candidate.idx + candidate.entity.length + 6);
      if (!NAME_CONTEXT_RE.test(cleaned.slice(ctxStart, ctxEnd))) continue;
    }

    entities.set(candidate.entity, { type: bestType, priority: bestPriority, confidence });
  }

  const result: ExtractedEntity[] = [];
  for (const [entity, info] of entities) {
    result.push({ entity, relationType: info.type, confidence: Math.round(info.confidence * 100) / 100 });
  }
  result.sort((a, b) => b.confidence - a.confidence);
  return result;
}

// ─── LLM-driven extraction (primary path) ───────────────────────────

const LLM_EXTRACTION_PROMPT =
  'Extract person names and organizations from the text. Output ONLY a JSON array:\n' +
  '[{"entity":"name","type":"PERSON|ORG","relation":"FOUNDED|INVESTED|ADVISES|WORKS_AT|ATTENDED|MENTIONED","confidence":0.9}]\n' +
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
      maxTokens: 300,
      logger: config.logger,
    });

    const entities = parseLLMEntities(response);

    if (entities.length > 0) {
      config.logger.debug({ count: entities.length }, 'LLM entity extraction succeeded');
      return entities.filter(e => e.confidence >= config.minConfidence);
    }

    return extractEntities(text, options);
  } catch (err) {
    memoryObservability.record('memory.entity.failed', {
      contentHash: hashForObservation(text),
      contentLength: text.length,
      error: errorForObservation(err),
    });
    config.logger.info({ err }, 'LLM entity extraction failed, falling back to regex');
    return extractEntities(text, options);
  }
}

export function parseLLMEntities(response: string): ExtractedEntity[] {
  const values = parseEntityJsonValues(response);
  const entities: ExtractedEntity[] = [];
  for (const parsed of values) {
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as { entity?: unknown; type?: unknown; relation?: unknown; confidence?: unknown };
    if (typeof obj.entity !== 'string') continue;
    const name = obj.entity.trim();
    if (!name || GENERIC_TERMS.has(name)) continue;
    const relationType = typeof obj.relation === 'string' && RELATION_PRIORITY[obj.relation] !== undefined
      ? obj.relation
      : 'MENTIONED';
    const fallbackConfidence = obj.type === 'PERSON' ? 0.95 : 0.85;
    const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
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
    return values;
  }
}
