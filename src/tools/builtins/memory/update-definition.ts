import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { errorResult, textResult } from '../../platform/tool-result.js';
import type { MemoryRepository } from '../../../memory/repositories/memory-repository.js';
import type { EmbeddingRepository } from '../../../memory/repositories/embedding-repository.js';
import type { EmbeddingClient } from '../../../provider/embedding-client.js';
import type { MemoryChangeEvent } from '../../../memory/memory-writer.js';
import { appendTimeline } from '../../../memory/memory-merge.js';
import { generateId } from '../../../shared/ids.js';
import { matchesMemoryAccess } from '../../../memory/memory-access-policy.js';

export const memoryUpdateToolCapability: ToolCapabilityDescriptor = {
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

const MemoryUpdateParams = Type.Object({
  id: Type.String(),
  content: Type.String(),
  kind: Type.Optional(Type.String()),
  visibility: Type.Optional(Type.Union([Type.Literal('shared'), Type.Literal('private')])),
});

interface MemoryUpdateArgs {
  id: string;
  content: string;
  kind?: string;
  visibility?: 'shared' | 'private';
}

export function createMemoryUpdateToolDefinition(options: {
  memoryRepository: MemoryRepository;
  embeddingRepository: EmbeddingRepository;
  embeddingClient: EmbeddingClient;
  onMemoryChanged?: (event?: MemoryChangeEvent) => void;
}): ToolDefinition<MemoryUpdateArgs> {
  return {
    name: 'memory_update',
    label: 'Memory Update',
    description: 'Update a stored memory visible to current agent.',
    category: 'memory',
    parametersSchema: MemoryUpdateParams,
    capability: memoryUpdateToolCapability,
    execute: async (args, ctx) => {
      const memory = options.memoryRepository.findById(args.id);
      if (!memory) return errorResult(`Memory not found: ${args.id}`);

      if (!matchesMemoryAccess(memory, { agentId: ctx.agentId, includeShared: true })) {
        return errorResult(`Memory is not visible to the current agent: ${args.id}`);
      }

      const metadata = appendTimeline(memory.metadata, {
        timestamp: Date.now(),
        previousContent: memory.content,
        newEvidence: args.content,
      });

      const updated = options.memoryRepository.update(args.id, {
        content: args.content,
        kind: args.kind,
        visibility: args.visibility,
        metadata,
      });
      if (!updated) return errorResult(`Memory not updated: ${args.id}`);

      options.embeddingRepository.deleteByMemoryId(args.id);

      try {
        const embedding = await options.embeddingClient.embedOne(args.content);
        options.embeddingRepository.create({
          id: generateId(),
          memory_id: args.id,
          embedding,
          model: 'default',
          dimension: embedding.length,
        });
      } catch {
        // Updating the memory is more important than refreshing embeddings.
      }

      options.onMemoryChanged?.({
        content: updated.content,
        kind: memory.kind === 'preference' ? memory.kind : updated.kind,
        scope: updated.scope,
        scopeKey: updated.scope_key,
        action: 'update',
      });
      return textResult(`Memory updated: ${args.id}`, { id: args.id });
    },
  };
}
