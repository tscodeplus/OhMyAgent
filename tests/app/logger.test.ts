import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger, resetLogger } from '../../src/app/logger';

describe('createLogger', () => {
  beforeEach(() => {
    resetLogger();
  });

  it('creates a logger instance', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('respects custom log level', () => {
    const logger = createLogger('error');
    expect(logger.level).toBe('error');
  });

  it('caches the logger instance', () => {
    const logger1 = createLogger();
    const logger2 = createLogger();
    expect(logger1).toBe(logger2);
  });
});
