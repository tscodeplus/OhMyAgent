import { z } from 'zod';
import { zodToTypeBox } from '../tools/tool-adapter.js';
import type { AgentTool } from '../pi-mono/agent/types.js';
import type { CronService } from './service.js';
import type { CronJob } from './types.js';
import { i18n } from '../i18n/index.js';

const schema = z.object({
  action: z.enum(["create", "list", "pause", "resume", "remove", "run"])
    .describe("Action to perform on cron jobs"),
  name: z.string().optional()
    .describe("Job name (used with create)"),
  schedule: z.string().optional()
    .describe("Schedule: \"5m\", \"30m\", \"2h\", \"every 2h\", \"0 8 * * *\""),
  prompt: z.string().optional()
    .describe("Prompt for the cron agent to execute. For reminders: write the message the user will see."),
  end_at: z.string().optional()
    .describe("ISO 8601 end time. Scheduler auto-completes job after this."),
  job_id: z.string().optional()
    .describe("8-char job ID for operations on existing jobs"),
});

function describeJob(job: CronJob): string {
  const statusIcon = job.enabled ? '▶' : '⏸';
  const locale = i18n.locale;
  const nextRun = job.nextRunAt
    ? new Date(job.nextRunAt).toLocaleString(locale)
    : i18n.t('tools-cron:status.completed');
  const lastRun = job.lastRunAt
    ? new Date(job.lastRunAt).toLocaleString(locale)
    : i18n.t('tools-cron:status.notExecuted');
  const endAtLine = job.endAt
    ? `  ${i18n.t('tools-cron:field.deadline')} ${new Date(job.endAt).toLocaleString(locale)}`
    : '';
  const lines = [
    `${statusIcon} \`${job.id}\` **${job.name}**`,
    `  ${i18n.t('tools-cron:field.schedule')} ${job.scheduleText}`,
    `  ${i18n.t('tools-cron:field.nextRun')} ${nextRun}`,
    `  ${i18n.t('tools-cron:field.lastRun')} ${lastRun} (${job.lastStatus ?? 'n/a'})`,
    `  ${i18n.t('tools-cron:field.prompt')} ${job.prompt.slice(0, 100)}${job.prompt.length > 100 ? '...' : ''}`,
  ];
  if (endAtLine) lines.push(endAtLine);
  return lines.join('\n');
}

export function createCronjobTool(options: {
  cronService: CronService;
  chatId: string;
  channel: string;
  agentName?: string;
  agentId?: string;
  computerUseAllowed?: () => boolean;
}): AgentTool<any> {
  return {
    name: 'cronjob',
    label: 'Cron Job Manager',
    description: "Schedule tasks: one-shot (\"30m\"), interval (\"every 2h\"), or cron (\"0 8 * * *\") jobs that run prompts and deliver results to this chat.",
    parameters: zodToTypeBox(schema),
    execute: async (_callId: string, args: z.infer<typeof schema>) => {
      try {
        switch (args.action) {
          case 'create': {
            const endAt = args.end_at ? new Date(args.end_at).getTime() : undefined;
            if (args.end_at && isNaN(endAt!)) {
              return { content: [{ type: 'text', text: i18n.t('tools-cron:error.parseEndAt', { endAt: args.end_at }) }] };
            }
            const job = options.cronService.add({
              name: args.name ?? 'Untitled',
              schedule: args.schedule ?? '1h',
              prompt: args.prompt ?? '',
              chatId: options.chatId,
              channel: options.channel,
              agentName: options.agentName,
              agentId: options.agentId,
              computerUseAllowed: options.computerUseAllowed?.() ?? false,
              endAt,
            });
            return {
              content: [{
                type: 'text',
                text: i18n.t('tools-cron:create.success', { id: job.id, detail: describeJob(job) }),
              }],
            };
          }

          case 'list': {
            const jobs = options.cronService.list();
            if (jobs.length === 0) {
              return { content: [{ type: 'text', text: i18n.t('tools-cron:list.empty') }] };
            }
            const lines = jobs.map(describeJob);
            return { content: [{ type: 'text', text: i18n.t('tools-cron:list.title', { count: jobs.length, list: lines.join('\n\n') }) }] };
          }

          case 'pause': {
            if (!args.job_id) {
              return { content: [{ type: 'text', text: i18n.t('tools-cron:error.missingJobId') }] };
            }
            const ok = options.cronService.pause(args.job_id);
            return {
              content: [{ type: 'text', text: ok ? i18n.t('tools-cron:pause.success', { id: args.job_id }) : i18n.t('tools-cron:error.jobNotFound', { id: args.job_id }) }],
            };
          }

          case 'resume': {
            if (!args.job_id) {
              return { content: [{ type: 'text', text: i18n.t('tools-cron:error.missingJobIdResume') }] };
            }
            const ok = options.cronService.resume(args.job_id);
            return {
              content: [{ type: 'text', text: ok ? i18n.t('tools-cron:resume.success', { id: args.job_id }) : i18n.t('tools-cron:error.jobNotFound', { id: args.job_id }) }],
            };
          }

          case 'remove': {
            if (!args.job_id) {
              return { content: [{ type: 'text', text: i18n.t('tools-cron:error.missingJobIdRemove') }] };
            }
            const ok = options.cronService.remove(args.job_id);
            return {
              content: [{ type: 'text', text: ok ? i18n.t('tools-cron:remove.success', { id: args.job_id }) : i18n.t('tools-cron:error.jobNotFound', { id: args.job_id }) }],
            };
          }

          case 'run': {
            if (!args.job_id) {
              return { content: [{ type: 'text', text: i18n.t('tools-cron:error.missingJobIdRun') }] };
            }
            const result = await options.cronService.runOnce(args.job_id);
            return {
              content: [{
                type: 'text',
                text: result.status === 'success'
                  ? i18n.t('tools-cron:run.success', { id: result.jobId, ms: result.durationMs, output: result.output.slice(0, 500) })
                  : i18n.t('tools-cron:run.failed', { id: result.jobId, error: result.error ?? 'unknown error' }),
              }],
            };
          }

          default:
            return { content: [{ type: 'text', text: i18n.t('tools-cron:error.unknownAction', { action: args.action }) }] };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: i18n.t('tools-cron:error.operationFailed', { error: error instanceof Error ? error.message : String(error) }),
          }],
        };
      }
    },
  } as AgentTool<any>;
}
