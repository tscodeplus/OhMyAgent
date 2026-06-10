import { z } from 'zod';
import { zodToTypeBox } from '../../src/tools/tool-adapter.js';
import type { AgentTool } from '../../src/pi-mono/agent/types.js';
import type { CronService } from '../../src/cron/service.js';
import type { CronJob } from '../../src/cron/types.js';
import { i18n } from '../../src/i18n/index.js';

const schema = z.object({
  action: z.enum(['create', 'list', 'pause', 'resume', 'remove', 'run'])
    .describe('Action to perform on cron jobs'),
  name: z.string().optional()
    .describe('Human-readable name for the job (used with create)'),
  schedule: z.string().optional()
    .describe('Schedule expression: "5m", "30m", "2h", "every 2h", "0 8 * * *"'),
  prompt: z.string().optional()
    .describe('Self-contained prompt for the agent to execute when the job fires'),
  end_at: z.string().optional()
    .describe('ISO 8601 datetime after which the job stops (e.g. "2026-05-11T00:00:00+08:00"). ' +
              'The scheduler will auto-complete the job after this time.'),
  job_id: z.string().optional()
    .describe('8-character job ID for operations on existing jobs'),
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
}): AgentTool<any> {
  return {
    name: 'cronjob',
    label: 'Cron Job Manager',
    description:
      'Manage scheduled cron jobs. Create one-shot ("30m"), interval ("every 2h"), ' +
      'or cron-expression ("0 8 * * *") scheduled tasks that run a prompt via the agent ' +
      'and deliver results back to this chat.',
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
              channel: 'cron',
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
