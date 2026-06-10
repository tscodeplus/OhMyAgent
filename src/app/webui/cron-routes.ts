/**
 * Cron Job API Routes for WebUI
 *
 * Exposes CronService CRUD operations as REST endpoints so the WebUI
 * CronView can manage scheduled jobs. WebUI-created jobs use
 * channel="webui" so results are delivered via WebSocket broadcast.
 */

import type { FastifyInstance } from 'fastify';
import { type CronService, parseSchedule } from '../../cron/service.js';
import type { CronJob, CronSchedule } from '../../cron/types.js';

/** Shape the WebUI frontend expects. */
interface CronJobDTO {
  id: string;
  name: string;
  description?: string;
  expression: string;
  enabled: boolean;
  state: string;
  channel: string;
  chat_id?: string;
  agent_id?: string;
  prompt?: string;
  last_run_at?: string | null;
  next_run_at?: string | null;
  created_at: string;
}

function scheduleToExpression(job: CronJob): string {
  if (job.scheduleText) return job.scheduleText;

  const schedule = job.schedule;
  switch (schedule.type) {
    case 'cron':
      return schedule.expression;
    case 'interval':
      return `every ${Math.round(schedule.intervalMs / 60_000)}m`;
    case 'oneshot':
      return new Date(schedule.timestampMs).toISOString();
    default:
      return '';
  }
}

function jobToDTO(job: CronJob): CronJobDTO {
  return {
    id: job.id,
    name: job.name,
    description: job.description,
    expression: scheduleToExpression(job),
    enabled: job.enabled,
    state: job.state,
    channel: job.channel || 'webui',
    chat_id: job.chatId,
    agent_id: job.agentId,
    prompt: job.prompt,
    last_run_at: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
    next_run_at: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
    created_at: new Date(job.createdAt).toISOString(),
  };
}

export function registerCronRoutes(
  app: FastifyInstance,
  cronService: CronService,
): void {
  // List all jobs with optional filtering
  app.get('/api/cron/jobs', async (request, reply) => {
    const query = request.query as { status?: string; q?: string };
    let jobs = cronService.list();

    if (query.status && query.status !== 'all') {
      jobs = jobs.filter(j => j.state === query.status);
    }
    if (query.q) {
      const keyword = query.q.toLowerCase();
      jobs = jobs.filter(j =>
        j.name.toLowerCase().includes(keyword) ||
        j.prompt.toLowerCase().includes(keyword),
      );
    }

    console.log(`[cron] list jobs: count=${jobs.length} status=${query.status} q=${query.q}`);
    return reply.send(jobs.map(jobToDTO));
  });

  // Get single job
  app.get('/api/cron/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = cronService.get(id);
    if (!job) {
      return reply.status(404).send({ error: 'Not Found', message: 'Job not found' });
    }
    return reply.send(jobToDTO(job));
  });

  // Create job
  app.post('/api/cron/jobs', async (request, reply) => {
    const body = request.body as {
      name?: string;
      expression?: string;
      description?: string;
      prompt?: string;
      agent_id?: string;
      enabled?: boolean;
    };

    if (!body.name?.trim() || !body.expression?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'name and expression are required' });
    }

    try {
      console.log(`[cron] creating job: name=${body.name} expr=${body.expression}`);
      const job = cronService.add({
        name: body.name.trim(),
        schedule: body.expression.trim(),
        prompt: body.prompt ?? '',
        chatId: 'webui',
        channel: 'webui',
        agentName: undefined,
        agentId: body.agent_id,
      });
      console.log(`[cron] job created: id=${job.id} channel=${job.channel} chatId=${job.chatId}`);

      if (body.enabled === false) {
        cronService.pause(job.id);
      }

      return reply.status(201).send(jobToDTO(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cron] create job failed: ${message}`);
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  // Update job
  app.put('/api/cron/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      expression?: string;
      description?: string;
      prompt?: string;
      agent_id?: string;
      channel?: string;
      enabled?: boolean;
      next_run_at?: string | null;
    };

    const job = cronService.get(id);
    if (!job) {
      return reply.status(404).send({ error: 'Not Found', message: 'Job not found' });
    }

    // Update simple fields
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (body.description !== undefined) (patch as any).description = body.description;
    if (body.prompt !== undefined) patch.prompt = body.prompt;
    if (body.agent_id !== undefined) patch.agentId = body.agent_id;
    if (body.channel !== undefined) patch.channel = body.channel;

    // Track whether schedule was changed (to auto-reactivate completed jobs)
    let scheduleChanged = false;

    // Re-parse schedule if expression changed
    if (typeof body.expression === 'string' && body.expression.trim() && body.expression.trim() !== scheduleToExpression(job)) {
      try {
        const { schedule, scheduleText, nextRunAt } = parseSchedule(body.expression.trim());
        patch.schedule = schedule;
        patch.scheduleText = scheduleText;
        patch.nextRunAt = nextRunAt;
        scheduleChanged = true;
      } catch (err) {
        return reply.status(400).send({ error: 'Bad Request', message: (err as Error).message });
      }
    }

    // Override next run time if explicitly provided
    if (body.next_run_at !== undefined) {
      if (body.next_run_at === null) {
        patch.nextRunAt = null;
      } else {
        const ts = Date.parse(body.next_run_at);
        if (!isNaN(ts)) {
          patch.nextRunAt = ts;
          scheduleChanged = true;
        }
      }
    }

    // Handle enable/disable toggle
    if (typeof body.enabled === 'boolean' && body.enabled !== job.enabled) {
      patch.state = body.enabled ? 'idle' : 'paused';
      patch.enabled = body.enabled;
    }

    // Auto-reactivate completed/paused jobs when schedule is changed
    if (scheduleChanged && (job.state === 'completed' || job.state === 'paused')) {
      patch.state = 'idle';
      patch.enabled = true;
    }

    // Apply patch
    if (Object.keys(patch).length > 0) {
      cronService.update(id, patch as any);
    }

    const updated = cronService.get(id);
    return reply.send(jobToDTO(updated!));
  });

  // Delete job
  app.delete('/api/cron/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = cronService.remove(id);
    if (!ok) {
      return reply.status(404).send({ error: 'Not Found', message: 'Job not found' });
    }
    return reply.send({ ok: true });
  });

  // Trigger immediate run
  app.post('/api/cron/jobs/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      console.log(`[cron] running job now: id=${id}`);
      const result = await cronService.runOnce(id);
      console.log(`[cron] run result: status=${result.status} delivered=${result.deliveredToChat}`);
      return reply.send({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cron] run failed: id=${id} err=${message}`);
      return reply.status(400).send({ error: 'Run failed', message });
    }
  });
}
