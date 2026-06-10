import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';
import type { MemoryRepository } from '../../../memory/repositories/memory-repository.js';

export const memoryCompactToolCapability: ToolCapabilityDescriptor = {
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

const MemoryCompactParams = Type.Object({
  /** If true, execute compaction. Default false (dry run only). */
  execute: Type.Optional(Type.Boolean()),
  /** Max age in days for inactive memories to be purged. */
  maxAgeDays: Type.Optional(Type.Number({ minimum: 1, maximum: 365 })),
});

interface MemoryCompactArgs {
  execute?: boolean;
  maxAgeDays?: number;
}

export function createMemoryCompactToolDefinition(options: {
  memoryRepository: MemoryRepository;
}): ToolDefinition<MemoryCompactArgs> {
  return {
    name: 'memory_compact',
    label: 'Memory Compact',
    description: 'Compact inactive memories older than maxAgeDays.',
    category: 'memory',
    parametersSchema: MemoryCompactParams,
    capability: memoryCompactToolCapability,
    execute: async (args) => {
      const maxAgeDays = args.maxAgeDays ?? 90;
      const execute = args.execute === true;

      // Count inactive memories older than maxAgeDays
      const allPrefs = options.memoryRepository.findByScopeKind('user', 'preference', { includeInactive: true });
      const inactive = allPrefs.filter(p => p.status !== 'active');
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const stale = inactive.filter(p => new Date(p.updated_at).getTime() < cutoff);

      if (stale.length === 0) {
        return textResult('No stale inactive memories to compact.', { wouldDelete: 0, deleted: 0 });
      }

      const lines: string[] = [];
      lines.push(`=== Memory Compact (${execute ? 'EXECUTE' : 'DRY RUN'}) ===`);
      lines.push(`Inactive memories older than ${maxAgeDays} days: ${stale.length}`);
      lines.push(`Status breakdown: superseded=${stale.filter(p => p.status === 'superseded').length}, deleted=${stale.filter(p => p.status === 'deleted').length}`);

      if (execute) {
        let deleted = 0;
        for (const mem of stale) {
          if (options.memoryRepository.delete(mem.id)) deleted++;
        }
        lines.push(`Physically purged: ${deleted} memories`);
        return textResult(lines.join('\n'), { wouldDelete: stale.length, deleted });
      }

      lines.push('');
      lines.push('Set execute=true to physically purge these memories.');
      return textResult(lines.join('\n'), { wouldDelete: stale.length, deleted: 0 });
    },
  };
}
