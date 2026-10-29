// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the memory_recall tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { createMemoryRecallTool } from '../memory-recall-tool.js';
import { recordInjectedGraphHints } from '../../../agent/context-transform.js';
import type { MemoryRetriever } from '../../../memory/memory-retriever.js';

export const memoryRecallToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

export function createMemoryRecallToolDefinition(options: {
  memoryRetriever: MemoryRetriever;
  topK?: number;
  agentId?: string;
  logger?: import('pino').Logger;
  hintsFor?: (memoryIds: string[]) => import('../../../graph/neighborhood.js').GraphHint[];
}): ToolDefinition {
  const legacyTool = createMemoryRecallTool(options);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'memory',
    parametersSchema: legacyTool.parameters,
    capability: memoryRecallToolCapability,
    execute: async (args, ctx) => {
      const tool = createMemoryRecallTool({
        ...options,
        getAgentId: () => ctx.agentId,
        logger: options.logger,
        // The tool layer is the only place that knows which hints the model was
        // shown, and this wrapper is the only layer that knows the session, so
        // the two are joined here. `readInjectionReferences` credits them under
        // the `graph` lane at turn end.
        onHintsInjected: (hints) =>
          recordInjectedGraphHints({
            agentId: ctx.agentId,
            sessionKey: ctx.sessionId,
            hints,
          }),
      });
      const result = await tool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}
