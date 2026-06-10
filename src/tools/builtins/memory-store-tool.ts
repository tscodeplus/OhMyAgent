import { z } from 'zod';
import { zodToTypeBox } from '../tool-adapter.js';
import { i18n } from '../../i18n/index.js';
import type { MemoryWriter } from '../../memory/memory-writer.js';
import type { MemoryCategory } from '../../memory/memory-filter.js';
import { type FilterResult, isSafe, detectCategory } from '../../memory/memory-filter.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import { defaultAgentId } from '../../agent/agent-context.js';

export interface MemoryFilter {
  /** Safety-only check (injection + size). No trigger words required. */
  isSafe: (text: string) => FilterResult;
  detectCategory: (text: string) => MemoryCategory;
}

/** @deprecated Use `createMemoryStoreToolDefinition` from `./memory/store-definition.js` instead. */
export function createMemoryStoreTool(options: {
  memoryWriter: MemoryWriter;
  memoryFilter?: MemoryFilter;
  getAgentId?: () => string | undefined;
  getChannel?: () => string | undefined;
  getMessageId?: () => string | undefined;
}): AgentTool<any> {
  const schema = z.object({
    content: z.string().describe('The memory content to store'),
    category: z.enum(['preference', 'fact', 'task', 'device_state']).optional()
      .describe('Memory category (auto-detected if not provided)'),
    visibility: z.enum(['shared', 'private']).optional()
      .describe('Memory visibility — "shared" (accessible across agents, default) or "private" (only accessible by this agent)'),
  });

  return {
    name: 'memory-store',
    label: 'Memory Store',
    description: 'Store a new memory. Use when the user shares preferences, facts, or information worth remembering.',
    parameters: zodToTypeBox(schema),
    execute: async (callId: string, args: { content: string; category?: string; visibility?: string }) => {
      try {
        // Safety check: validate size & detect prompt injection only.
        // No trigger words required — the LLM already decided to store.
        if (options.memoryFilter) {
          const safetyResult = options.memoryFilter.isSafe(args.content);
          if (!safetyResult.capture) {
            return { content: [{ type: 'text', text: i18n.t('tools-builtins:memoryStore.rejected', { reason: safetyResult.reason ?? 'unknown' }) }] };
          }
        }

        // Detect category if not provided
        const category: MemoryCategory = (args.category as MemoryCategory | undefined) ||
          (options.memoryFilter
            ? options.memoryFilter.detectCategory(args.content)
            : detectCategory(args.content));

        const agentId = options.getAgentId?.() ?? defaultAgentId;

        const writeOptions = {
          content: args.content,
          scope: 'user',
          kind: category,
          visibility: args.visibility ?? 'shared',
          ...(agentId ? { agentId } : {}),
          sourceChannel: options.getChannel?.() ?? null,
          sourceMessageId: options.getMessageId?.() ?? null,
        };

        const result = await options.memoryWriter.write(writeOptions);

        if (result.action === 'merged') {
          return { content: [{ type: 'text', text: i18n.t('tools-builtins:memoryStore.stored', { id: result.mergedInto ?? result.id }) }], details: result };
        }

        if (result.isDuplicate) {
          return { content: [{ type: 'text', text: i18n.t('tools-builtins:memoryStore.duplicate') }] };
        }

        return { content: [{ type: 'text', text: i18n.t('tools-builtins:memoryStore.stored', { id: result.id }) }], details: result };
      } catch (error) {
        return {
          content: [{ type: 'text', text: i18n.t('tools-builtins:memoryStore.error', { message: error instanceof Error ? error.message : String(error) }) }],
        };
      }
    },
  } as AgentTool<any>;
}

// Default filter using standalone functions from memory-filter
export function createDefaultMemoryFilter(): MemoryFilter {
  return {
    isSafe,
    detectCategory,
  };
}
