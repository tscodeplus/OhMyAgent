// ---------------------------------------------------------------------------
// v4 ToolDefinition for the file_write tool
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { shouldRouteToDesktopBridge } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { writeFileNoFollow } from '../../../shared/safe-fs.js';

export const fileWriteCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: false,
  readsFiles: false,
  writesFiles: true,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'write',
  approvalDefault: 'none',
};

export function createFileWriteToolDefinition(): ToolDefinition {
  return {
    name: 'file_write',
    label: 'File Write',
    description:
      'Write content to a file, creating parent directories if they do not exist.',
    category: 'file',
    parametersSchema: Type.Object({
      filePath: Type.String({
        description: 'The file path to write to',
      }),
      content: Type.String({
        description: 'The content to write to the file',
      }),
    }),
    capability: fileWriteCapability,
    execute: async (
      args: { filePath: string; content: string },
      ctx,
    ) => {
      // Forward to desktop bridge only for Windows absolute paths
      if (ctx.desktopBridge && shouldRouteToDesktopBridge(args.filePath)) {
        try {
          const result = await ctx.desktopBridge.callTool('file_write', { path: args.filePath, content: args.content }, 30_000);
          if (result.ok) {
            const data = result.data as { content?: string } | undefined;
            return textResult(data?.content ?? String(result.data ?? ''));
          }
          return errorResult(result.error ?? 'Unknown desktop bridge error');
        } catch (err: any) {
          return errorResult(`Desktop bridge error: ${err.message}`);
        }
      }

      try {
        const resolvedPath = ctx.resolvedPath ?? path.resolve(ctx.cwd, args.filePath);
        // Symlink-safe write: O_NOFOLLOW closes the policy-check→write TOCTOU gap.
        const bytesWritten = writeFileNoFollow(resolvedPath, args.content);
        return textResult(
          `Successfully wrote ${bytesWritten} bytes to ${resolvedPath}`,
        );
      } catch (err: any) {
        return errorResult(
          `Failed to write file: ${err.message ?? String(err)}`,
        );
      }
    },
  };
}
