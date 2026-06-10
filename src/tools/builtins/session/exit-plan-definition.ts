// ---------------------------------------------------------------------------
// v4 ToolDefinition for the exit_plan_mode tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';
import { sessionMetadata } from './shared-metadata.js';

export const exitPlanModeCapability: ToolCapabilityDescriptor = {
  category: 'session',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

export function createExitPlanModeToolDefinition(): ToolDefinition {
  return {
    name: 'exit_plan_mode',
    label: 'Exit Plan Mode',
    description: 'Exit plan mode and resume normal execution.',
    category: 'session',
    parametersSchema: Type.Object({}),
    capability: exitPlanModeCapability,
    execute: async (_args: Record<string, never>, ctx) => {
      const sessionId = ctx.sessionId ?? 'default';
      const existing = sessionMetadata.get(sessionId);
      if (!existing) {
        return textResult(`Not in plan mode for session '${sessionId}'.`);
      }
      sessionMetadata.set(sessionId, { ...existing, planMode: false });
      return textResult(`Exited plan mode for session '${sessionId}'.`);
    },
  };
}
