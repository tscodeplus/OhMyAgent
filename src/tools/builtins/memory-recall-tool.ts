import { z } from 'zod';
import { zodToTypeBox } from '../tool-adapter.js';
import { i18n } from '../../i18n/index.js';
import type { MemoryRetriever, RetrievedMemory } from '../../memory/memory-retriever.js';
import { isPromptInjection } from '../../memory/memory-filter.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import { defaultAgentId } from '../../agent/agent-context.js';
import { truncate } from '../../shared/truncation.js';
import type { Logger } from 'pino';
import { formatHints, type GraphHint } from '../../graph/neighborhood.js';

/** @deprecated Use `createMemoryRecallToolDefinition` from `./memory/recall-definition.js` instead. */
type MemoryRecallProvider = Pick<MemoryRetriever, 'retrieve'> &
  Partial<Pick<MemoryRetriever, 'retrieveGrouped'>>;

export function createMemoryRecallTool(options: {
  memoryRetriever: MemoryRecallProvider;
  topK?: number;
  agentId?: string;
  getAgentId?: () => string | undefined;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'>;
  /**
   * Relations the graph records about the memories just recalled.
   *
   * Optional so a caller without a graph (tests, a bare retriever) gets exactly
   * the old output. Hints are appended after the memories and are labelled as
   * incomplete, because they are a derived view, not another retrieval result.
   */
  hintsFor?: (memoryIds: string[]) => GraphHint[];
  /**
   * Called with the hints this call actually appended to its result, so the
   * turn-end reference check can score whether the answer used one. Optional:
   * a caller without a session to publish against (a bare tool in a test) gets
   * exactly the old output.
   */
  onHintsInjected?: (hints: GraphHint[]) => void;
}): AgentTool<any> {
  const schema = z.object({
    query: z.string().describe('Search query for finding relevant memories'),
  });

  return {
    name: 'memory-recall',
    label: 'Memory Recall',
    description:
      'Search and recall relevant memories from the memory store for user context, past conversations, or stored information.',
    parameters: zodToTypeBox(schema),
    execute: async (callId: string, args: { query: string }) => {
      try {
        let results: RetrievedMemory[];

        const effectiveAgentId = options.agentId || options.getAgentId?.() || defaultAgentId;

        if (effectiveAgentId && options.memoryRetriever.retrieveGrouped) {
          results = await options.memoryRetriever.retrieveGrouped({
            query: args.query,
            agentId: effectiveAgentId,
            topK: options.topK ?? 3,
          });
        } else {
          results = await options.memoryRetriever.retrieve({
            query: args.query,
            topK: options.topK ?? 3,
            agentId: effectiveAgentId,
          });
        }

        options.logger?.debug(
          {
            query: args.query,
            resultCount: results.length,
            top3: results
              .slice(0, 3)
              .map((r) => ({ score: r.score.toFixed(3), content: truncate(r.content, 80) })),
          },
          'memory_recall results',
        );

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: i18n.t('tools-builtins:memoryRecall.noResults') }],
          };
        }

        // Read-path injection gate (L1): recalled content goes straight into
        // the LLM's context as a tool result — drop anything that looks like
        // an instruction override before formatting.
        const safeResults = results.filter((r) => !isPromptInjection(r.content));
        if (safeResults.length === 0) {
          return {
            content: [{ type: 'text', text: i18n.t('tools-builtins:memoryRecall.noResults') }],
          };
        }

        const formatted = safeResults
          .map((r, i) =>
            i18n.t('tools-builtins:memoryRecall.resultItem', {
              index: i + 1,
              content: r.content,
              score: r.score.toFixed(2),
            }),
          )
          .join('\n');

        const hints = options.hintsFor?.(safeResults.map((r) => r.id)) ?? [];
        if (hints.length === 0) {
          return { content: [{ type: 'text', text: formatted }] };
        }
        // A hint that reached the model is what the reference check scores. The
        // observer is a metric, so a throw from it must not replace a result
        // that is already correct.
        try {
          options.onHintsInjected?.(hints);
        } catch (err) {
          options.logger?.debug({ err }, 'graph hint observer failed — reference metric skipped');
        }
        // Appended, never sorted into the results above: an edge is derived from a
        // memory, so promoting that memory would turn one bad edge into a ranking
        // bug on top of a content bug. Each line keeps its source id so a wrong
        // relation can be traced back to the sentence that produced it.
        const hintBlock = [
          '',
          i18n.t('tools-builtins:memoryRecall.structuralHints'),
          ...formatHints(hints),
        ].join('\n');

        return { content: [{ type: 'text', text: `${formatted}${hintBlock}` }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  } as AgentTool<any>;
}
