// ---------------------------------------------------------------------------
// v4 ToolDefinition for the sleep tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';

export const sleepCapability: ToolCapabilityDescriptor = {
  category: 'shell',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const MAX_SLEEP_SECONDS = 300;

const SleepParams = Type.Object({
  seconds: Type.Number({ minimum: 0, maximum: MAX_SLEEP_SECONDS }),
});

interface SleepArgs {
  seconds: number;
}

export function createSleepToolDefinition(): ToolDefinition {
  return {
    name: 'sleep',
    label: 'Sleep',
    description: 'Pause for N seconds (max 300).',
    category: 'shell',
    parametersSchema: SleepParams,
    capability: sleepCapability,
    execute: async (args: SleepArgs, _ctx) => {
      const clamped = Math.min(Math.max(0, args.seconds), MAX_SLEEP_SECONDS);
      await new Promise((resolve) => setTimeout(resolve, clamped * 1000));
      return textResult(`Slept for ${clamped}s`);
    },
  };
}
