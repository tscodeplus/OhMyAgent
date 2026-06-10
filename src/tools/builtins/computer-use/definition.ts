// ---------------------------------------------------------------------------
// v4 ToolDefinition wrapper for the computer_use tool
// ---------------------------------------------------------------------------

import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { createComputerUseTool, type ComputerUseToolOptions } from '../computer-use-tool.js';
import type { ComputerUseHost } from '../../../computer-use/computer-host.js';
import type { Ctx } from '../../../computer-use/types.js';

export const computerUseToolCapability: ToolCapabilityDescriptor = {
  category: 'computer_use',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: true,
  pathAccess: 'none',
  approvalDefault: 'high_risk',
};

export function createComputerUseToolDefinition(
  computerUseHost: ComputerUseHost,
  getCtx?: () => Ctx,
  options: ComputerUseToolOptions = {},
): ToolDefinition {
  const legacyTool = createComputerUseTool(computerUseHost, getCtx, options);

  return {
    name: legacyTool.name,
    label: legacyTool.label,
    description: legacyTool.description,
    category: 'computer_use',
    parametersSchema: legacyTool.parameters,
    capability: computerUseToolCapability,
    execute: async (args, _ctx) => {
      const result = await legacyTool.execute('' as any, args as any);
      return {
        content: (result.content ?? []) as any,
        isError: !result.content?.length,
        metadata: result.details as Record<string, unknown> | undefined,
      };
    },
  };
}
