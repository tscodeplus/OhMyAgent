// ---------------------------------------------------------------------------
// v4 ToolDefinition for the brief tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';

export const briefCapability: ToolCapabilityDescriptor = {
  category: 'session',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const BriefParams = Type.Object({
  instruction: Type.Optional(Type.String()),
});

interface BriefArgs {
  instruction?: string;
}

export function createBriefToolDefinition(): ToolDefinition {
  return {
    name: 'brief',
    label: 'Brief',
    description: 'Request a concise summary from the agent based on provided instruction.',
    category: 'session',
    parametersSchema: BriefParams,
    capability: briefCapability,
    execute: async (args: BriefArgs, _ctx) => {
      const instruction = args.instruction ?? 'Summarize the current session';
      const result = [
        '[BRIEF REQUEST]',
        `Instruction: ${instruction}`,
        'Response: [The agent should now respond with a concise summary based on the instruction above.]',
      ].join('\n');
      return textResult(result);
    },
  };
}
