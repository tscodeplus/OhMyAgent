/**
 * Optional LLM-driven query planner — classifies intent and extracts entities
 * for the coverage-retrieval path, improving on the regex rules when names are
 * lowercase, non-Latin, or the intent is phrased indirectly.
 *
 * Falls back to the pure-rule planStructuredQueries() when:
 *   - The feature is disabled via config (default OFF)
 *   - No aux model is configured (modelRef + fallbackRefs both empty)
 *   - The LLM call fails or returns unparseable output
 *
 * The LLM only decides intent + entity list; slot construction stays
 * deterministic via buildQueryPlan(), so the production path never gains an
 * uncontrolled query shape.
 */

import type { Logger } from 'pino';
import type { AuxModelConfig } from './aux-llm-client.js';
import { auxLLMCall } from './aux-llm-client.js';
import {
  planMemoryQueries,
  planStructuredQueries,
  buildQueryPlan,
} from './query-planner.js';
import type { QueryIntent, QueryPlan, StructuredPlannerConfig } from './query-planner.js';

export interface LLMPlannerConfig {
  /** Aux model config. Same structure as the other aux tasks. */
  auxConfig?: AuxModelConfig;
  /** Whether the LLM planner is enabled. Default false. */
  enabled: boolean;
  /** Max entities to keep from the LLM output. Default 4. */
  maxEntities: number;
  logger: Logger;
}

const VALID_INTENTS: ReadonlySet<QueryIntent> = new Set<QueryIntent>([
  'commonality', 'attribute', 'temporal', 'multi_hop', 'open_domain', 'generic',
]);

const PLANNER_SYSTEM_PROMPT =
  'You analyze a memory-retrieval question. Output ONLY a compact JSON object ' +
  '{"intent": one of ["commonality","attribute","temporal","multi_hop","open_domain","generic"], ' +
  '"entities": [person/topic names mentioned, most specific first]}. ' +
  'Use "commonality" when the question asks what two or more named people share or have in common. ' +
  'Use "attribute" when it asks for a single named person\'s property. ' +
  'No prose, no markdown fences.';

/** Parse the LLM JSON response into a validated {intent, entities} pair, or null. */
function parsePlannerResponse(
  raw: string,
  maxEntities: number,
): { intent: QueryIntent; entities: string[] } | null {
  // Strip optional ```json fences and locate the first JSON object.
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const intentRaw = typeof obj.intent === 'string' ? obj.intent.trim().toLowerCase() : '';
  const intent: QueryIntent = VALID_INTENTS.has(intentRaw as QueryIntent)
    ? (intentRaw as QueryIntent)
    : 'generic';

  const seen = new Set<string>();
  const entities: string[] = [];
  if (Array.isArray(obj.entities)) {
    for (const e of obj.entities) {
      if (typeof e !== 'string') continue;
      const name = e.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      entities.push(name);
      if (entities.length >= maxEntities) break;
    }
  }
  return { intent, entities };
}

/**
 * Plan queries with an optional LLM intent/entity step.
 * Always returns a valid QueryPlan; on any disable/miss/failure it returns the
 * rule-based planStructuredQueries() output unchanged (non-regression).
 */
export async function planQueriesLLM(
  query: string,
  config: LLMPlannerConfig,
  structuredConfig?: StructuredPlannerConfig,
): Promise<QueryPlan> {
  const rulePlan = planStructuredQueries(query, structuredConfig);

  // Fast path: feature disabled.
  if (!config.enabled) return rulePlan;

  // Fast path: no aux model configured.
  const hasModel = config.auxConfig?.modelRef || (config.auxConfig?.fallbackRefs?.length ?? 0) > 0;
  if (!hasModel) return rulePlan;

  const normalized = query.trim();
  if (!normalized) return rulePlan;

  try {
    const response = await auxLLMCall(config.auxConfig!, {
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: normalized,
      temperature: 0,
      maxTokens: 120,
      logger: config.logger,
    });

    const parsed = parsePlannerResponse(response, config.maxEntities);
    if (!parsed) {
      config.logger.warn('LLM planner returned unparseable output, using rule-based plan');
      return rulePlan;
    }

    // The LLM only decides intent + entities; slots stay deterministic.
    // Reuse the rule plan's flatQueries so the non-coverage path is identical.
    return buildQueryPlan(normalized, parsed.intent, parsed.entities, rulePlan.flatQueries ?? planMemoryQueries(normalized));
  } catch {
    config.logger.warn('LLM planner failed, using rule-based plan');
    return rulePlan;
  }
}

