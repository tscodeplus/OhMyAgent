/**
 * Application entry point.
 *
 * Loads environment variables, bootstraps all services,
 * starts the server, and registers graceful shutdown handlers.
 */

import 'dotenv/config';
import { bootstrap } from './app/bootstrap.js';

async function main() {
  const { services, start, stop } = await bootstrap();

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
  console.error('Fatal error:', error);
  process.exit(1);
});
