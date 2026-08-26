/**
 * Application entry point.
 *
 * Loads environment variables, bootstraps all services,
 * starts the server, and registers graceful shutdown handlers.
 */

import 'dotenv/config';
import { bootstrap } from './app/bootstrap.js';
import { createLogger } from './app/logger.js';

const logger = createLogger();

/**
 * Stop function assigned once bootstrap() has completed; process-level crash
 * handlers use it to roll back already-started services before exiting.
 */
let stopServices: (() => Promise<void>) | undefined;

/**
 * Last-resort handler for unhandled promise rejections / uncaught exceptions.
 *
 * Without these handlers Node.js ≥20 crashes the process on an unhandled
 * rejection with no cleanup: WebSocket connections, schedulers and timers
 * are abandoned without a graceful stop(). We log the error, attempt a
 * bounded rollback of started services, and exit non-zero.
 */
const fatal = (kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
  logger.error({ err, kind }, `Fatal ${kind} — shutting down`);
  void (async () => {
    try {
      // Bound the rollback so a hung stop() cannot block exit forever.
      await Promise.race([
        stopServices?.(),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
    } catch (error) {
      logger.error({ error }, 'Error during crash-triggered shutdown');
    }
    process.exit(1);
  })();
};

process.on('uncaughtException', (err) => fatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));

async function main() {
  const { services, start, stop } = await bootstrap();
  stopServices = stop;

  // ─── Graceful shutdown ───

  const shutdown = async (signal: string) => {
    services.logger.info(`Received ${signal}, shutting down...`);
    try {
      await stop();
    } catch (error) {
      services.logger.error({ error }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ─── Start ───

  await start();
}

main().catch((error) => {
  logger.error({ err: error }, 'Fatal error');
  process.exit(1);
});
