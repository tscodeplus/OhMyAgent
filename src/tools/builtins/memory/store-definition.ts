// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the memory_store tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { createMemoryStoreTool, type MemoryFilter } from '../memory-store-tool.js';
import type { MemoryWriter } from '../../../memory/memory-writer.js';

export const memoryStoreToolCapability: ToolCapabilityDescriptor = {
  category: 'memory',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

export function createMemoryStoreToolDefinition(options: {
  memoryWriter: MemoryWriter;
  memoryFilter?: MemoryFilter;
}): ToolDefinition {
  const legacyTool = createMemoryStoreTool(options);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'memory',
    parametersSchema: legacyTool.parameters,
    capability: memoryStoreToolCapability,
    execute: async (args, ctx) => {
      const tool = createMemoryStoreTool({
        ...options,
        getAgentId: () => ctx.agentId,
        getChannel: () => ctx.channel,
        getMessageId: () => ctx.messageId,
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
