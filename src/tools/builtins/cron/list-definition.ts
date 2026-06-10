// ---------------------------------------------------------------------------
// v4 ToolDefinition for cron_list — list scheduled cron jobs
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import type { CronJob } from '../../../cron/types.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const cronListCapability: ToolCapabilityDescriptor = {
  category: 'cron',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const CronListParams = Type.Object({
  includeDisabled: Type.Optional(Type.Boolean({ description: 'Include disabled jobs in the listing' })),
});

interface CronListArgs {
  includeDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatJob(job: CronJob): string {
  const status = job.enabled ? 'enabled' : 'disabled';
  const state = job.state;
  const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toISOString() : '—';
  const lastRun = job.lastRunAt ? new Date(job.lastRunAt).toISOString() : '—';
  const lastStatus = job.lastStatus ?? '—';

  return (
    `ID:      ${job.id}\n` +
    `Name:    ${job.name}\n` +
    `Prompt:  ${job.prompt.length > 80 ? job.prompt.slice(0, 80) + '...' : job.prompt}\n` +
    `Cron:    ${job.scheduleText}\n` +
    `Status:  ${status} (${state})\n` +
    `Next:    ${nextRun}\n` +
    `Last:    ${lastRun} [${lastStatus}]\n` +
    `Channel: ${job.channel} / ${job.chatId}`
  );
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createCronListToolDefinition(): ToolDefinition {
  return {
    name: 'cron_list',
    label: 'Cron List',
    description: 'List cron jobs in current channel. Optionally include disabled.',
    category: 'cron',
    parametersSchema: CronListParams,
    capability: cronListCapability,
    execute: async (args: CronListArgs, ctx: ToolExecutionContext) => {
      // Derive scope from sessionId or channel (same logic as cron_create)
      let channel: string;
      let chatId: string;

      if (ctx.sessionId) {
        const colonIdx = ctx.sessionId.indexOf(':');
        if (colonIdx > 0 && colonIdx < ctx.sessionId.length - 1) {
          channel = ctx.sessionId.slice(0, colonIdx);
          chatId = ctx.sessionId.slice(colonIdx + 1);
        } else {
          channel = ctx.channel ?? 'unknown';
          chatId = ctx.sessionId;
        }
      } else if (ctx.channel) {
        channel = ctx.channel;
        chatId = ctx.sessionId ?? 'default';
      } else {
        return errorResult('Cannot determine channel from execution context.');
      }

      const allJobs = ctx.services.cronService.listByChannel(channel, chatId);
      const jobs = args.includeDisabled ? allJobs : allJobs.filter(j => j.enabled);

      if (jobs.length === 0) {
        return textResult('No cron jobs found for this channel.');
      }

      const lines = jobs.map((job, i) => `#${i + 1}\n${formatJob(job)}`).join('\n\n---\n\n');
      return textResult(`Cron jobs for ${channel}/${chatId}:\n\n${lines}`);
    },
  };
}
