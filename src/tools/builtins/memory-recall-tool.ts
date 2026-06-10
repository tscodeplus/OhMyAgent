import { z } from 'zod';
import { zodToTypeBox } from '../tool-adapter.js';
import { i18n } from '../../i18n/index.js';
import type { MemoryRetriever, RetrievedMemory } from '../../memory/memory-retriever.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import { defaultAgentId } from '../../agent/agent-context.js';
import type { Logger } from 'pino';

/** @deprecated Use `createMemoryRecallToolDefinition` from `./memory/recall-definition.js` instead. */
export function createMemoryRecallTool(options: {
  memoryRetriever: MemoryRetriever;
  topK?: number;
  agentId?: string;
  getAgentId?: () => string | undefined;
  logger?: Pick<Logger, 'info' | 'warn'>;
}): AgentTool<any> {
  const schema = z.object({
    query: z.string().describe('Search query for finding relevant memories'),
  });

  return {
    name: 'memory-recall',
    label: 'Memory Recall',
    description: 'Search and recall relevant memories from the memory store for user context, past conversations, or stored information.',
    parameters: zodToTypeBox(schema),
    execute: async (callId: string, args: { query: string }) => {
      try {
        let results: RetrievedMemory[];

        const effectiveAgentId = options.agentId || options.getAgentId?.() || defaultAgentId;

        const canUseGrouped = effectiveAgentId &&
          typeof (options.memoryRetriever as any).retrieveGrouped === 'function';

        if (canUseGrouped) {
          results = await (options.memoryRetriever as any).retrieveGrouped({
            query: args.query,
            agentId: effectiveAgentId!,
            topK: options.topK ?? 3,
          });
        } else {
          results = await options.memoryRetriever.retrieve({
            query: args.query,
            topK: options.topK ?? 3,
            agentId: effectiveAgentId,
          });
        }

        options.logger?.info({
          query: args.query,
          resultCount: results.length,
          top3: results.slice(0, 3).map(r => ({ score: r.score.toFixed(3), content: r.content.slice(0, 80) })),
        }, 'memory_recall results');

        if (results.length === 0) {
          return { content: [{ type: 'text', text: i18n.t('tools-builtins:memoryRecall.noResults') }] };
        }

        const formatted = results
          .map((r, i) => i18n.t('tools-builtins:memoryRecall.resultItem', { index: i + 1, content: r.content, score: r.score.toFixed(2) }))
          .join('\n');

        return { content: [{ type: 'text', text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error recalling memories: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  } as AgentTool<any>;
}
