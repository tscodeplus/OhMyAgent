// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the file_read tool
// ---------------------------------------------------------------------------

import { open } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { shouldRouteToDesktopBridge } from '../../platform/tool-context.js';
import { expandHomePath } from '../../../shared/path-utils.js';
import { createFileReadTool, type FileReadToolDeps } from '../file-read-tool.js';

const MAX_FILE_SIZE = 100_000;

export const fileReadToolCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: true,
  readsFiles: true,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'read',
  approvalDefault: 'none',
};

export function createFileReadToolDefinition(deps: FileReadToolDeps): ToolDefinition {
  // Create legacy tool WITHOUT policyCenter — path approval is handled by
  // the v4 before-tool-call + beforeExecute hooks (PolicyCenter.evaluateToolCall).
  // The legacy tool's internal policyCenter check would double-deny after approval.
  const legacyTool = createFileReadTool({
    allowedRoots: deps.config.tools.fileRead.allowedRoots,
    deniedPatterns: deps.config.tools.fileRead.deniedPatterns,
  });

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'file',
    parametersSchema: legacyTool.parameters,
    capability: fileReadToolCapability,
    execute: async (args, ctx) => {
      // Forward to desktop bridge for paths that route to the local desktop
      const rawPath = (args as { path: string }).path;
      if (ctx.desktopBridge && shouldRouteToDesktopBridge(rawPath)) {
        try {
          const result = await ctx.desktopBridge.callTool('file_read', args, 30_000);
          if (result.ok) {
            const data = result.data as { content?: string } | undefined;
            const content = data?.content ?? String(result.data ?? '');
            // Include a desktop-bridge:// link so the WebUI can trigger a
            // native Save-As dialog via Electron IPC — no gateway caching needed.
            const fileName = path.basename(rawPath);
            const link = `\n\n[${fileName}](/desktop-bridge-download?path=${encodeURIComponent(rawPath)}&name=${encodeURIComponent(fileName)})`;
            return { content: [{ type: 'text' as const, text: content + link }], isError: false };
          }
          return {
            content: [{ type: 'text' as const, text: `Error reading file: ${result.error}` }],
            isError: true,
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: `Desktop bridge error: ${err.message}` }],
            isError: true,
          };
        }
      }

      // When approval was already handled by v4 hooks, skip internal path check
      if (ctx.approvalAlreadyHandled) {
        try {
          const rawPath = (args as { path: string }).path;
          const resolvedPath = path.resolve(expandHomePath(rawPath));
          // Size pre-check via fd stat (symlink-safe — the path cannot be
          // swapped between check and read): reject oversized files before
          // reading so a multi-GB file is never pulled into memory, and bound
          // the fd read to the stat'd size in case the file grows meanwhile.
          const handle = await open(resolvedPath, 'r');
          try {
            const stats = await handle.stat();
            if (stats.size > MAX_FILE_SIZE) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `File too large to read (${stats.size} bytes, limit ${MAX_FILE_SIZE} bytes)`,
                  },
                ],
                isError: true,
              };
            }
            // UTF-8 bytes >= chars, so a file within the byte limit is also
            // within the character display limit and needs no truncation.
            const buffer = Buffer.alloc(Math.max(stats.size, 1));
            let total = 0;
            while (total < buffer.length) {
              const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
              if (bytesRead === 0) break;
              total += bytesRead;
            }
            const content = buffer.subarray(0, total).toString('utf-8');
            return { content: [{ type: 'text', text: content }], isError: false };
          } finally {
            await handle.close();
          }
        } catch (e: any) {
          return {
            content: [{ type: 'text', text: `Error reading file: ${e.message}` }],
            isError: true,
          };
        }
      }
      // Fallback: legacy tool with its own path check
      const result = await legacyTool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: (result as any).isError ?? !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}
