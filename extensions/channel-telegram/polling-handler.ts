/**
 * Polling mode handler for Telegram Bot.
 *
 * Uses grammY's built-in long-polling via bot.start().
 * Includes automatic reconnection with exponential backoff.
 */
import type { Bot } from 'grammy';
import type { Logger } from 'pino';

export interface PollingOptions {
  maxRetryDelayMs: number;
  initialRetryDelayMs: number;
}

const DEFAULT_OPTIONS: PollingOptions = {
  maxRetryDelayMs: 15_000,
  initialRetryDelayMs: 1_000,
};

const stoppingBots = new WeakSet<Bot>();

export async function startPolling(
  bot: Bot,
  logger: Logger,
  options: PollingOptions = DEFAULT_OPTIONS,
): Promise<void> {
  let retryDelay = options.initialRetryDelayMs;

  const startWithRetry = async () => {
    try {
      await bot.start({
        drop_pending_updates: true,
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
        onStart(botInfo) {
          logger.info({ username: botInfo.username }, 'Telegram polling started');
          retryDelay = options.initialRetryDelayMs; // reset on successful start
        },
      });
    } catch (err) {
      if (stoppingBots.has(bot)) {
        logger.debug({ reason: getErrorMessage(err) }, 'Telegram polling stopped during shutdown');
        return;
      }
      logger.warn({ err, retryDelayMs: retryDelay }, 'Telegram polling stopped, retrying...');
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, options.maxRetryDelayMs);
      await startWithRetry();
    }
  };

  await startWithRetry();
}

export async function stopPolling(bot: Bot, logger: Logger): Promise<void> {
  stoppingBots.add(bot);
  try {
    await bot.stop();
    logger.info('Telegram polling stopped');
  } catch (err) {
    logger.debug({ reason: getErrorMessage(err) }, 'Telegram polling stop completed with non-fatal error');
  } finally {
    stoppingBots.delete(bot);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
