import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';
import type { MemoryRepository } from '../../../memory/repositories/memory-repository.js';
import { matchesMemoryAccess } from '../../../memory/memory-access-policy.js';

export const memoryListToolCapability: ToolCapabilityDescriptor = {
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

const MemoryListParams = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('session'), Type.Literal('system')])),
  kind: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  /** Include inactive (superseded/deleted) memories. Default false. */
  includeInactive: Type.Optional(Type.Boolean()),
});

interface MemoryListArgs {
  scope?: string;
  kind?: string;
  query?: string;
  limit?: number;
  includeInactive?: boolean;
}

function preview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

export function createMemoryListToolDefinition(options: {
  memoryRepository: MemoryRepository;
}): ToolDefinition<MemoryListArgs> {
  return {
    name: 'memory_list',
    label: 'Memory List',
    description: 'List memories visible to current agent. Active only by default.',
    category: 'memory',
    parametersSchema: MemoryListParams,
    capability: memoryListToolCapability,
    execute: async (args, ctx) => {
      const scope = args.scope ?? 'user';
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const includeInactive = args.includeInactive === true;

      const rows = args.query?.trim()
        ? options.memoryRepository.searchByContent(args.query.trim(), scope, undefined, { includeInactive })
        : options.memoryRepository.findAllByScope(scope);

      // searchByContent and findAllByScope already filter active-only.
      // If includeInactive, we need to use the raw repository findByScope with includeInactive flag.
      let visible = rows
        .filter(memory => matchesMemoryAccess(memory, {
          scope,
          kind: args.kind,
          agentId: ctx.agentId,
          includeShared: true,
        }));

      // If includeInactive, also fetch inactive memories across ALL scope_keys.
      // Using findByScopeKind (no scope_key filter) to catch memories with any scope_key.
      if (includeInactive && !args.query?.trim()) {
        const allKinds = ['preference', 'fact', 'task', 'summary', 'scene', 'device_state'];
        const seen = new Set(visible.map(m => m.id));
        for (const kind of allKinds) {
          const inactiveRows = options.memoryRepository.findByScopeKind(scope, kind, { includeInactive: true });
          for (const m of inactiveRows) {
            if (seen.has(m.id)) continue;
            if (!matchesMemoryAccess(m, {
              scope,
              kind: args.kind,
              agentId: ctx.agentId,
              includeShared: true,
            })) continue;
            seen.add(m.id);
            visible.push(m);
          }
        }
      }

      visible = visible.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, limit);

      if (visible.length === 0) {
        return textResult('No visible memories found.');
      }

      const lines = visible.map((memory, index) => {
        const statusTag = memory.status !== 'active' ? ` [${memory.status}]` : '';
        return [
          `${index + 1}. ${memory.id}${statusTag}`,
          `kind=${memory.kind}`,
          `visibility=${memory.visibility}`,
          `updated=${memory.updated_at}`,
          `content=${preview(memory.content)}`,
        ].join(' | ');
      });

      return textResult(lines.join('\n'), { count: visible.length });
    },
  };
}
