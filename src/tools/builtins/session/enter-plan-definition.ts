// ---------------------------------------------------------------------------
// v4 ToolDefinition for the enter_plan_mode tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';
import { sessionMetadata } from './shared-metadata.js';

export const enterPlanModeCapability: ToolCapabilityDescriptor = {
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

export function createEnterPlanModeToolDefinition(): ToolDefinition {
  return {
    name: 'enter_plan_mode',
    label: 'Enter Plan Mode',
    description: 'Enter plan mode — focus on planning and analysis rather than execution.',
    category: 'session',
    parametersSchema: Type.Object({}),
    capability: enterPlanModeCapability,
    execute: async (_args: Record<string, never>, ctx) => {
      const sessionId = ctx.sessionId ?? 'default';
      const existing = sessionMetadata.get(sessionId) ?? {};
      sessionMetadata.set(sessionId, { ...existing, planMode: true });
      return textResult(`Entered plan mode for session '${sessionId}'.`);
    },
  };
}
