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
  let firstAttempt = true;

  const startWithRetry = async () => {
    try {
      await bot.start({
        // grammY's start() calls deleteWebhook({ drop_pending_updates }) every
        // time it is invoked. Passing it on a retry would discard everything
        // the user queued while we were disconnected — which on a flapping
        // Termux connection means the messages that triggered the reconnect are
        // dropped before we ever read them. First start only.
        drop_pending_updates: firstAttempt ? true : undefined,
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
        onStart(botInfo) {
          logger.info({ username: botInfo.username }, 'Telegram polling started');
          retryDelay = options.initialRetryDelayMs; // reset on successful start
        },
      });
      firstAttempt = false;
    } catch (err) {
      if (stoppingBots.has(bot)) {
        logger.debug({ reason: getErrorMessage(err) }, 'Telegram polling stopped during shutdown');
        return;
      }
      logger.warn({ err, retryDelayMs: retryDelay }, 'Telegram polling stopped, retrying...');
      firstAttempt = false;
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
    logger.debug(
      { reason: getErrorMessage(err) },
      'Telegram polling stop completed with non-fatal error',
    );
  } finally {
    stoppingBots.delete(bot);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
