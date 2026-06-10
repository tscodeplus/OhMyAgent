import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { errorResult, textResult } from '../../platform/tool-result.js';
import type { MemoryRepository } from '../../../memory/repositories/memory-repository.js';
import type { EmbeddingRepository } from '../../../memory/repositories/embedding-repository.js';
import type { MemoryLinkRepository } from '../../../memory/repositories/memory-link-repository.js';
import type { MemoryChangeEvent } from '../../../memory/memory-writer.js';
import { matchesMemoryAccess } from '../../../memory/memory-access-policy.js';

export const memoryDeleteToolCapability: ToolCapabilityDescriptor = {
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

const MemoryDeleteParams = Type.Object({
  id: Type.String(),
  /** If true, physically delete the row (default: soft delete, status='deleted'). */
  purge: Type.Optional(Type.Boolean()),
});

interface MemoryDeleteArgs {
  id: string;
  purge?: boolean;
}

export function createMemoryDeleteToolDefinition(options: {
  memoryRepository: MemoryRepository;
  embeddingRepository: EmbeddingRepository;
  memoryLinkRepository?: MemoryLinkRepository;
  onMemoryChanged?: (event?: MemoryChangeEvent) => void;
}): ToolDefinition<MemoryDeleteArgs> {
  return {
    name: 'memory_delete',
    label: 'Memory Delete',
    description: 'Delete a memory. Default soft-delete; use purge=true for permanent removal.',
    category: 'memory',
    parametersSchema: MemoryDeleteParams,
    capability: memoryDeleteToolCapability,
    execute: async (args, ctx) => {
      const memory = options.memoryRepository.findById(args.id);
      if (!memory) return errorResult(`Memory not found: ${args.id}`);

      if (!matchesMemoryAccess(memory, { agentId: ctx.agentId, includeShared: true })) {
        return errorResult(`Memory is not visible to the current agent: ${args.id}`);
      }

      if (memory.status !== 'active') {
        return errorResult(`Memory is already ${memory.status}: ${args.id}`);
      }

      let deleted: boolean;
      if (args.purge) {
        options.embeddingRepository.deleteByMemoryId(args.id);
        options.memoryLinkRepository?.deleteByMemory(args.id);
        deleted = options.memoryRepository.delete(args.id);
      } else {
        // Soft delete: FTS status filter in JOIN prevents inactive memories from appearing.
        // The FTS index retains the content row, but JOIN with m.status='active' excludes it.
        deleted = options.memoryRepository.softDelete(args.id);
      }

      if (deleted) {
        options.onMemoryChanged?.({
          content: memory.content,
          kind: memory.kind,
          scope: memory.scope,
          scopeKey: memory.scope_key,
          action: 'delete',
        });
      }

      const mode = args.purge ? 'purged' : 'soft-deleted';
      return textResult(deleted ? `Memory ${mode}: ${args.id}` : `Memory not deleted: ${args.id}`, { deleted });
    },
  };
}
