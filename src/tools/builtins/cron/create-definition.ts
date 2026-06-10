// ---------------------------------------------------------------------------
// v4 ToolDefinition for cron_create — schedule a recurring agent task
// ---------------------------------------------------------------------------

import { Type } from 'typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const cronCreateCapability: ToolCapabilityDescriptor = {
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

const CronCreateParams = Type.Object({
  name: Type.String({ description: 'Human-readable name for this cron job' }),
  schedule: Type.String({ description: 'Schedule in 5-field cron format(e.g. "0 8 * * *" for daily 8am)' }),
  prompt: Type.String({ description: 'Prompt sent to the agent when the job fires' }),
});

interface CronCreateArgs {
  name: string;
  schedule: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive { channel, chatId } from the execution context.
 *
 * If sessionId is present and has the form "channel:chatId", split on the
 * first colon.  Otherwise fall back to ctx.channel and a generic chatId token.
 */
function deriveChannel(ctx: ToolExecutionContext): { channel: string; chatId: string } | null {
  if (ctx.sessionId) {
    const colonIdx = ctx.sessionId.indexOf(':');
    if (colonIdx > 0 && colonIdx < ctx.sessionId.length - 1) {
      return {
        channel: ctx.sessionId.slice(0, colonIdx),
        chatId: ctx.sessionId.slice(colonIdx + 1),
      };
    }
  }

  if (ctx.channel) {
    return { channel: ctx.channel, chatId: ctx.sessionId ?? 'default' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createCronCreateToolDefinition(): ToolDefinition {
  return {
    name: 'cron_create',
    label: 'Cron Create',
    description: 'Create a scheduled cron job that runs an agent task at a specified interval.',
    category: 'cron',
    parametersSchema: CronCreateParams,
    capability: cronCreateCapability,
    execute: async (args: CronCreateArgs, ctx: ToolExecutionContext) => {
      const derived = deriveChannel(ctx);
      if (!derived) {
        return errorResult(
          'Cannot determine channel and chatId from the execution context. ' +
          'Ensure the session is bound to a specific channel.',
        );
      }

      try {
        const job = ctx.services.cronService.add({
          name: args.name,
          schedule: args.schedule,
          prompt: args.prompt,
          channel: derived.channel,
          chatId: derived.chatId,
        });

        return textResult(
          `Cron job created successfully.\n` +
          `  ID:       ${job.id}\n` +
          `  Name:     ${job.name}\n` +
          `  Schedule: ${job.scheduleText}\n` +
          `  Next run: ${new Date(job.nextRunAt!).toISOString()}\n` +
          `  Channel:  ${job.channel} / ${job.chatId}`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Failed to create cron job: ${message}`);
      }
    },
  };
}
