/**
 * TripletExtractor — turns a finished turn (user message + assistant reply)
 * into SPO (subject-predicate-object) statements for the entity graph.
 *
 * Runs through the existing aux-LLM client (`auxLLMCall`, the same
 * modelRef → fallbackRefs chain the memory summarizer and entity extractor
 * use) and is fire-and-forget: every failure path returns `[]` so a slow or
 * broken model can never block or fail the turn it is attached to.
 */

import type { Logger } from 'pino';
import type { AuxModelConfig } from '../memory/aux-llm-client.js';
import { auxLLMCall } from '../memory/aux-llm-client.js';
import { errorForObservation, memoryObservability } from '../memory/observability.js';

export interface Triplet {
  subject: string;
  relation: string;
  object: string;
  /** 0..1; 1 when the model did not say. */
  confidence: number;
}

export interface TripletTurn {
  userMessage: string;
  assistantReply: string;
}

export interface TripletExtractionDeps {
  auxConfig?: AuxModelConfig;
  /** Master switch; when false no model call is made. */
  enabled: boolean;
  logger: Logger;
  /** Drop triplets below this confidence. Default 0 (keep everything parsed). */
  minConfidence?: number;
}

/**
 * The edge vocabulary is deliberately small and closed: free-form relation
 * names would fragment the graph into near-duplicate labels ("works_at",
 * "employed_by", "is_employed_by") that no traversal can join back together.
 */
export const TRIPLET_RELATIONS = [
  'likes',
  'works_on',
  'lives_in',
  'owns',
  'knows',
  'prefers',
  'part_of',
] as const;

export const TRIPLET_EXTRACTION_PROMPT =
  'You extract knowledge-graph facts from one conversation turn.\n' +
  'Output ONLY a JSON array of triplets, no prose, no markdown:\n' +
  '[{"subject":"...","relation":"likes","object":"...","confidence":0.9}]\n' +
  'Rules:\n' +
  `- "relation" MUST be one of: ${TRIPLET_RELATIONS.join(', ')}.\n` +
  '- Emit only facts that are explicitly stated in the turn. Never infer, guess, or complete.\n' +
  '- subject and object are concrete named entities (a person, project, place, tool, team); ' +
  'no pronouns, no sentence fragments, no "user" as a subject.\n' +
  '- "confidence" is 0..1; use 1.0 only when the turn states the fact directly.\n' +
  '- If the turn contains no such fact, output [].';

function clampConfidence(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
}

function readString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * Pull the first balanced JSON value out of a possibly chatty model response.
 * String-aware so braces inside a quoted subject/object do not end the scan.
 */
function extractJsonText(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
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
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Flatten `[{...}]`, `{ "triplets": [{...}] }` and a lone `{...}` into entries. */
function toEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['triplets', 'triples', 'facts', 'statements']) {
      const nested = record[key];
      if (Array.isArray(nested)) return nested;
    }
    return [record];
  }
  return [];
}

function toTriplet(entry: unknown): Triplet | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const subject = readString(record, ['subject']);
  const relation = readString(record, ['relation', 'predicate', 'relation_type', 'relationType']);
  const object = readString(record, ['object']);
  if (!subject || !relation || !object) return null;
  return {
    subject,
    relation: relation.toLowerCase().replace(/\s+/g, '_'),
    object,
    confidence: clampConfidence(record.confidence),
  };
}

/**
 * Parse a model response into triplets. Tolerates ```json fences, surrounding
 * prose, a top-level object instead of an array, and one broken entry among
 * good ones. Never throws — malformed input yields [].
 */
export function parseTriplets(raw: string): Triplet[] {
  if (typeof raw !== 'string') return [];
  const stripped = raw
    .replace(/```[A-Za-z0-9_-]*/g, ' ')
    .replace(/```/g, ' ')
    .trim();
  if (!stripped) return [];

  const candidates = new Set<unknown>();
  const balanced = extractJsonText(stripped);
  if (balanced) {
    try {
      candidates.add(JSON.parse(balanced));
    } catch {
      // Fall through to the per-object scan below.
    }
  }
  if (candidates.size === 0) {
    // Salvage mode: the whole payload is unparseable, but individual
    // flat `{...}` entries may still be intact.
    for (const match of stripped.matchAll(/\{[^{}]*\}/g)) {
      try {
        candidates.add(JSON.parse(match[0]));
      } catch {
        // Skip this entry, keep the others.
      }
    }
  }

  const triplets: Triplet[] = [];
  for (const candidate of candidates) {
    for (const entry of toEntries(candidate)) {
      const triplet = toTriplet(entry);
      if (triplet) triplets.push(triplet);
    }
  }
  return triplets;
}

/**
 * Ask the model for the triplets of one finished turn.
 *
 * Returns [] on every failure (disabled, no model configured, network error,
 * unparseable response) — callers attach this to the turn's tail without
 * awaiting it for correctness.
 */
export async function extractTriplets(
  input: TripletTurn,
  deps: TripletExtractionDeps,
): Promise<Triplet[]> {
  try {
    const hasModel =
      Boolean(deps.auxConfig?.modelRef) || (deps.auxConfig?.fallbackRefs?.length ?? 0) > 0;
    if (!deps.enabled || !hasModel) return [];

    const userPrompt = `USER:\n${input.userMessage}\n\nASSISTANT:\n${input.assistantReply}`;
    if (!userPrompt.trim()) return [];

    const response = await auxLLMCall(deps.auxConfig!, {
      systemPrompt: TRIPLET_EXTRACTION_PROMPT,
      userPrompt,
      temperature: 0,
      maxTokens: 400,
      logger: deps.logger,
    });

    const triplets = parseTriplets(response).filter(
      (triplet) => triplet.confidence >= (deps.minConfidence ?? 0),
    );
    deps.logger.debug({ count: triplets.length }, 'Triplet extraction finished');
    return triplets;
  } catch (err) {
    memoryObservability.record('memory.entity.failed', {
      stage: 'triplet_extraction',
      error: errorForObservation(err),
    });
    deps.logger.info({ err }, 'Triplet extraction failed — skipping graph update for this turn');
    return [];
  }
}
