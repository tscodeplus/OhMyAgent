/**
 * LLM-driven query expansion — rewrites short/ambiguous queries into
 * multiple search angles for better retrieval recall.
 *
 * Falls back to the pure-rule expandQuery() when:
 *   - The feature is disabled via config
 *   - No aux model is configured (modelRef + fallbackRefs both empty)
 *   - The LLM call fails
 *   - The query is already long and specific (fast path)
 */

import type { Logger } from 'pino';
import type { AuxModelConfig } from './aux-llm-client.js';
import { auxLLMCall } from './aux-llm-client.js';
import { expandQuery } from './query-expansion.js';
import type { ExpandedQuery } from './query-expansion.js';

export interface LLMExpansionConfig {
  /** Aux model config. Follows the same structure as SummaryLLMConfig. */
  auxConfig?: AuxModelConfig;
  /** Whether LLM expansion is enabled. Default true. */
  enabled: boolean;
  /** Skip LLM when query length >= this. Default 15. */
  minQueryLength: number;
  /** Trigger LLM when initial search max score < this. Default 0.3. */
  minScoreTrigger: number;
  /** Maximum number of expanded queries. Default 5. */
  maxVariants: number;
  logger: Logger;
}

const EXPANSION_SYSTEM_PROMPT =
  'Rewrite the user\'s query into search queries from different angles, one per line. Only output the queries, no numbering or explanation.';

/**
 * Expand a user query for memory retrieval.
 *
 * Returns:
 *   - The original expanded query (rule-based expandQuery result) as baseline
 *   - Plus LLM-generated variants when applicable
 */
export async function expandQueryLLM(
  rawQuery: string,
  config: LLMExpansionConfig,
  initialMaxScore?: number,
): Promise<{ baseline: ExpandedQuery; variants: ExpandedQuery[] }> {
  const baseline = expandQuery(rawQuery);

  // Fast path: feature disabled
  if (!config.enabled) {
    return { baseline, variants: [] };
  }

  // Fast path: query is long and specific enough
  if (rawQuery.trim().length >= config.minQueryLength && (initialMaxScore === undefined || initialMaxScore >= config.minScoreTrigger)) {
    return { baseline, variants: [] };
  }

  // Fast path: no aux model configured
  const hasModel = config.auxConfig?.modelRef || (config.auxConfig?.fallbackRefs?.length ?? 0) > 0;
  if (!hasModel) {
    return { baseline, variants: [] };
  }

  try {
    const response = await auxLLMCall(config.auxConfig!, {
      systemPrompt: EXPANSION_SYSTEM_PROMPT,
      userPrompt: rawQuery,
      temperature: 0.3,
      maxTokens: 200,
      logger: config.logger,
    });

    const lines = response
      .split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, config.maxVariants);

    if (lines.length === 0) return { baseline, variants: [] };

    const variants = lines
      .map(q => expandQuery(q))
      .filter(v => v.ftsQuery && v.ftsQuery !== baseline.ftsQuery);

    // Deduplicate by ftsQuery
    const seen = new Set<string>();
    seen.add(baseline.ftsQuery);
    const deduped = variants.filter(v => {
      if (seen.has(v.ftsQuery)) return false;
      seen.add(v.ftsQuery);
      return true;
    });

    return { baseline, variants: deduped };
  } catch {
    // LLM expansion failed — fall back to rule-based only
    config.logger.info('LLM query expansion failed, using rule-based only');
    return { baseline, variants: [] };
  }
}
