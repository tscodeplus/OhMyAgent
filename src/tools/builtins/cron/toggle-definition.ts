// ---------------------------------------------------------------------------
// v4 ToolDefinition for cron_toggle — enable/disable a cron job
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const cronToggleCapability: ToolCapabilityDescriptor = {
  category: 'cron',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

const CronToggleParams = Type.Object({
  jobId: Type.String({ description: 'ID of the cron job to toggle' }),
  enabled: Type.Boolean({ description: 'true to enable the job, false to disable it' }),
});

interface CronToggleArgs {
  jobId: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createCronToggleToolDefinition(): ToolDefinition {
  return {
    name: 'cron_toggle',
    label: 'Cron Toggle',
    description: 'Enable or disable a cron job(same channel/chat only).',
    category: 'cron',
    parametersSchema: CronToggleParams,
    capability: cronToggleCapability,
    execute: async (args: CronToggleArgs, ctx: ToolExecutionContext) => {
      const job = ctx.services.cronService.get(args.jobId);
      if (!job) {
        return errorResult(`Cron job "${args.jobId}" not found.`);
      }

      // Determine current scope
      let currentChannel: string;
      let currentChatId: string;

      if (ctx.sessionId) {
        const colonIdx = ctx.sessionId.indexOf(':');
        if (colonIdx > 0 && colonIdx < ctx.sessionId.length - 1) {
          currentChannel = ctx.sessionId.slice(0, colonIdx);
          currentChatId = ctx.sessionId.slice(colonIdx + 1);
        } else {
          currentChannel = ctx.channel ?? 'unknown';
          currentChatId = ctx.sessionId;
        }
      } else if (ctx.channel) {
        currentChannel = ctx.channel;
        currentChatId = ctx.sessionId ?? 'default';
      } else {
        return errorResult('Cannot determine channel from execution context.');
      }

      if (job.channel !== currentChannel || job.chatId !== currentChatId) {
        return errorResult(
          `Cron job "${args.jobId}" belongs to ${job.channel}/${job.chatId}, ` +
          `not ${currentChannel}/${currentChatId}. Operation denied.`,
        );
      }

      const updated = ctx.services.cronService.toggle(args.jobId, args.enabled);
      if (!updated) {
        return errorResult(`Failed to update cron job "${args.jobId}".`);
      }

      const stateLabel = args.enabled ? 'enabled' : 'disabled';
      return textResult(`Cron job "${args.jobId}" (${job.name}) ${stateLabel} successfully.`);
    },
  };
}
