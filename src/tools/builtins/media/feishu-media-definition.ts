// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for feishu_send_media
// — enables PolicyCenter path approval flow for media sending
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';

const MAX_FILE_SIZE = 100_000;

export const feishuMediaCapability: ToolCapabilityDescriptor = {
  category: 'file',
  readOnly: true,
  readsFiles: true,
  writesFiles: false,
  usesShell: false,
  usesNetwork: true,
  usesComputerUse: false,
  pathAccess: 'read',
  approvalDefault: 'none',
};

export function createFeishuMediaDefinition(options: {
  legacyTool: any;
}): ToolDefinition {
  const tool = options.legacyTool;

  return {
    name: 'feishu_send_media',
    label: tool.label,
    description: tool.description,
    category: 'file',
    parametersSchema: tool.parameters,
    capability: feishuMediaCapability,
    execute: async (args, ctx) => {
      // When approval was already handled by v4 hooks, send directly
      if (ctx.approvalAlreadyHandled) {
        return tool.execute('' as any, args as any);
      }
      // Fallback: execute with legacy inline checks
      return tool.execute('' as any, args as any);
    },
  };
}
