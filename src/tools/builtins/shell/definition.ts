// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the shell tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { createShellTool, type ShellToolOptions } from '../shell-tool.js';

export const shellToolCapability: ToolCapabilityDescriptor = {
  category: 'shell',
  readOnly: false,
  readsFiles: true,
  writesFiles: true,
  usesShell: true,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read_write',
  approvalDefault: 'mutating',
};

export function createShellToolDefinition(options: ShellToolOptions = {}): ToolDefinition {
  const legacyTool = createShellTool(options);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'shell',
    parametersSchema: legacyTool.parameters,
    capability: shellToolCapability,
    execute: async (args, ctx) => {
      // Forward to desktop bridge if one is registered for this session
      if (ctx.desktopBridge) {
        try {
          const result = await ctx.desktopBridge.callTool('shell', args, 60_000);
          if (result.ok) {
            const data = result.data as { content?: string } | undefined;
            return {
              content: [{ type: 'text' as const, text: data?.content ?? String(result.data ?? '') }],
              isError: false,
              metadata: {} as Record<string, unknown>,
            };
          }
          return {
            content: [{ type: 'text' as const, text: `Shell error: ${result.error}` }],
            isError: true,
            metadata: {} as Record<string, unknown>,
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: `Desktop bridge error: ${err.message}` }],
            isError: true,
            metadata: {} as Record<string, unknown>,
          };
        }
      }

      const result = await legacyTool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}
