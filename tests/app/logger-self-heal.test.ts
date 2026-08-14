import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, resetLogger } from '../../src/app/logger';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Self-healing log transport tests.
 *
 * Regression guard for the "deleted log file never comes back" bug: pino's
 * built-in `pino/file` transport holds one fd forever, so deleting the log
 * file at runtime keeps writes going into the unlinked inode and the file is
 * never recreated until restart. The `file-self-heal.js` transport must
 * recreate the file on the next write.
 */
describe('file-self-heal transport', () => {
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'oma-self-heal-'));
    logFile = join(logDir, 'ohmyagent.log');
    process.env.OHMYAGENT_LOG_DIR = logDir;
    resetLogger();
  });

  afterEach(() => {
    delete process.env.OHMYAGENT_LOG_DIR;
    resetLogger();
    rmSync(logDir, { recursive: true, force: true });
  });

  it('creates the log file on first write', async () => {
    createLogger().info('first line');
    await sleep(600);
    expect(existsSync(logFile)).toBe(true);
  });

  it('recreates the log file after it is deleted externally', async () => {
    const logger = createLogger();

    logger.info('line one');
    await sleep(600);
    expect(existsSync(logFile)).toBe(true);

    // Simulate the user deleting the log file while the server is running.
    rmSync(logFile, { force: true });
    expect(existsSync(logFile)).toBe(false);

    // The next write must recreate the file (no restart needed).
    logger.info('line after delete');
    await sleep(800);
    expect(existsSync(logFile)).toBe(true);

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(logFile, 'utf8')).toContain('line after delete');
  });
});
