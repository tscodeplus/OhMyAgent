import type { Logger } from 'pino';
import type { CronJob, JobRunResult, RunStatus } from './types.js';
import type { CronDeliveryRegistry } from './delivery-registry.js';
import type { FooterConfig } from '../app/types.js';
import { withTimeout } from '../shared/with-timeout.js';
import { ToolTimeoutError } from '../shared/errors.js';
import { judgeProactiveNotifyRoute, NOTIFY_LATER_DELAY_MS } from '../judge/hooks/notify-routing.js';

// ── Exponential backoff schedule ──

const BACKOFF_SCHEDULE_MS = [
  30_000, // attempt 1 → 30s
  60_000, // attempt 2 → 1m
  300_000, // attempt 3 → 5m
  900_000, // attempt 4 → 15m
  3_600_000, // attempt 5 → 60m (cap)
];

function getBackoffMs(retryCount: number): number {
  const idx = Math.min(retryCount, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx]!;
}

/** Agent execution result with captured text output. */
export interface AgentRunResult {
  text: string;
  modelLabel: string;
}

/**
 * Runs cron job prompts through a full Agent (with tools) and returns the output.
 * Implemented by AgentService adapter in bootstrap.
 */
export interface AgentRunner {
  /** Execute the cron job prompt with full agent capabilities. */
  run(
    prompt: string,
    sessionId: string,
    chatId: string,
    agentId?: string,
    computerUseAllowed?: boolean,
  ): Promise<AgentRunResult>;
  /** Clean up agent runtime to prevent memory leaks. */
  cleanup(sessionId: string): void;
}

export interface JobRunnerOptions {
  executionTimeoutMs: number;
  footer: FooterConfig;
  logger: Logger;
}

export class JobRunner {
  constructor(
    private deliveryRegistry: CronDeliveryRegistry,
    private agentRunner: AgentRunner,
    private options: JobRunnerOptions,
  ) {}

  updateConfig(partial: Partial<JobRunnerOptions>): void {
    Object.assign(this.options, partial);
  }

  async run(job: CronJob): Promise<JobRunResult> {
    const startMs = Date.now();
    const sessionId = `cron:${job.id}`;

    try {
      const { text, modelLabel } = await this.runWithTimeout(job, sessionId);

      const durationMs = Date.now() - startMs;

      const finalText = (text || '(no output)').trim();
      let deliveredToChat = false;
      try {
        deliveredToChat = await this.deliver(
          job.channel,
          job.chatId,
          finalText,
          modelLabel,
          job.agentName,
          sessionId,
        );
      } catch (e) {
        this.options.logger.warn(
          { jobId: job.id, channel: job.channel, err: e },
          'Failed to deliver cron result',
        );
      }

      // Clean up the runtime
      this.agentRunner.cleanup(sessionId);

      return {
        jobId: job.id,
        status: 'success',
        output: finalText,
        durationMs,
        deliveredToChat,
      };
    } catch (err) {
      // Clean up on error too
      this.agentRunner.cleanup(sessionId);

      const durationMs = Date.now() - startMs;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jobId: job.id,
        status: err instanceof ToolTimeoutError ? 'timeout' : 'error',
        output: '',
        durationMs,
        error: msg,
        deliveredToChat: false,
      };
    }
  }

  private async runWithTimeout(job: CronJob, sessionId: string): Promise<AgentRunResult> {
    const { executionTimeoutMs, logger } = this.options;

    let result: AgentRunResult;
    try {
      result = await withTimeout(
        this.agentRunner.run(
          job.prompt,
          sessionId,
          job.chatId,
          job.agentId,
          job.computerUseAllowed === true,
        ),
        executionTimeoutMs,
        'timeout',
      );
    } catch (err) {
      // Remap the generic timeout into a typed error so callers can branch on
      // the type rather than string-matching the message.
      if (err instanceof Error && err.message === 'timeout') {
        throw new ToolTimeoutError(`cron:${job.id}`, executionTimeoutMs);
      }
      throw err;
    }

    logger.info({ jobId: job.id, textLen: result.text.length }, 'Cron agent execution complete');

    return result;
  }

  /**
   * Deliver one proactive notification (cron result / task completion text).
   * Kernel M4 `notify.routing` consult (impl doc §4.10): in active mode the
   * judged route may defer or withhold the delivery; shadow/off/fallback
   * routes collapse to 'now' (the current immediate routing).
   *
   * Returns whether the notification was (immediately) delivered — 'later'
   * returns false and schedules a single deferred attempt.
   */
  private async deliver(
    channel: string,
    chatId: string,
    text: string,
    modelLabel: string,
    agentName?: string,
    sessionId?: string,
  ): Promise<boolean> {
    const route = await judgeProactiveNotifyRoute({
      sessionId,
      kind: 'cron-result',
      channel,
      chatId,
      textPreview: text.slice(0, 300),
      logger: this.options.logger,
    });
    if (route === 'never') {
      this.options.logger.info(
        { channel, chatId, sessionId },
        '[job-runner] notify.routing judged never — withholding proactive delivery',
      );
      return false;
    }
    if (route === 'later') {
      // One best-effort deferred attempt (deliverNow already logs failures).
      // No judge consult on the deferred pass — the route decision is applied
      // exactly once per notification.
      const timer = setTimeout(() => {
        this.deliverNow(channel, chatId, text, modelLabel, agentName).catch((err) =>
          this.options.logger.warn(
            { err, channel, chatId, sessionId },
            '[job-runner] deferred (notify.routing later) delivery failed',
          ),
        );
      }, NOTIFY_LATER_DELAY_MS);
      // The job run must not keep the process alive just for the deferral.
      timer.unref?.();
      return false;
    }
    return await this.deliverNow(channel, chatId, text, modelLabel, agentName);
  }

  /** Route initialization for tests / direct callers: no judge consult. */
  private async deliverNow(
    channel: string,
    chatId: string,
    text: string,
    modelLabel: string,
    agentName?: string,
  ): Promise<boolean> {
    this.options.logger.info(
      { channel, chatId, textLen: text.length },
      '[job-runner] attempting delivery',
    );
    const client = this.deliveryRegistry.get(channel);
    if (!client) {
      this.options.logger.warn(
        { channel, chatId, availableChannels: this.deliveryRegistry.listChannels() },
        '[job-runner] No delivery client registered for channel, skipping cron result delivery',
      );
      return false;
    }
    this.options.logger.info(
      { channel, chatId },
      '[job-runner] delivery client found, calling deliver',
    );
    await client.deliver({ chatId, text, modelLabel, agentName, footer: this.options.footer });
    this.options.logger.info({ channel, chatId }, '[job-runner] delivery complete');
    return true;
  }

  /**
   * Compute the next run time with exponential backoff applied.
   */
  applyBackoff(job: CronJob): number | null {
    if (job.retryCount === 0) return null;
    const backoffMs = getBackoffMs(job.retryCount - 1);
    return Date.now() + backoffMs;
  }
}
