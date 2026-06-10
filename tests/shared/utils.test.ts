import { describe, it, expect } from 'vitest';
import {
  AppError,
  ConfigError,
  ToolError,
  ToolTimeoutError,
  FeishuError,
  MemoryError,
} from '../../src/shared/errors';
import { generateId, shortId } from '../../src/shared/ids';
import { truncate, truncateToolOutput } from '../../src/shared/truncation';
import { retry } from '../../src/shared/retry';

describe('AppError hierarchy', () => {
  it('AppError has correct properties', () => {
    const err = new AppError('test', 'TEST_CODE', 400);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_CODE');
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe('AppError');
  });

  it('AppError defaults statusCode to 500', () => {
    const err = new AppError('msg', 'CODE');
    expect(err.statusCode).toBe(500);
  });

  it('ConfigError extends AppError', () => {
    const err = new ConfigError('bad config');
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('ConfigError');
  });

  it('ToolError extends AppError', () => {
    const err = new ToolError('tool failed');
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('TOOL_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('ToolError');
  });

  it('ToolError accepts custom code', () => {
    const err = new ToolError('custom', 'CUSTOM_CODE');
    expect(err.code).toBe('CUSTOM_CODE');
  });

  it('ToolTimeoutError extends ToolError', () => {
    const err = new ToolTimeoutError('myTool', 5000);
    expect(err).toBeInstanceOf(ToolTimeoutError);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('TOOL_TIMEOUT');
    expect(err.message).toBe('Tool "myTool" timed out after 5000ms');
    expect(err.name).toBe('ToolTimeoutError');
  });

  it('FeishuError extends AppError with statusCode 502', () => {
    const err = new FeishuError('feishu failed');
    expect(err).toBeInstanceOf(FeishuError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('FEISHU_ERROR');
    expect(err.statusCode).toBe(502);
    expect(err.name).toBe('FeishuError');
  });

  it('MemoryError extends AppError', () => {
    const err = new MemoryError('memory issue');
    expect(err).toBeInstanceOf(MemoryError);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('MEMORY_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe('MemoryError');
  });
});

describe('generateId', () => {
  it('returns a 21-character string', () => {
    const id = generateId();
    expect(id).toHaveLength(21);
    expect(typeof id).toBe('string');
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('shortId', () => {
  it('returns an 8-character string', () => {
    const id = shortId();
    expect(id).toHaveLength(8);
    expect(typeof id).toBe('string');
  });

  it('generates unique short IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => shortId()));
    expect(ids.size).toBe(100);
  });
});

describe('truncate', () => {
  it('returns text unchanged if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns text unchanged if exactly at limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and appends ellipsis when over limit', () => {
    const result = truncate('hello world', 8);
    expect(result).toBe('hello...');
    expect(result).toHaveLength(8);
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('truncateToolOutput', () => {
  it('returns output unchanged if within limit', () => {
    expect(truncateToolOutput('short', 100)).toBe('short');
  });

  it('truncates and adds info header when over limit', () => {
    const output = 'a'.repeat(200);
    const result = truncateToolOutput(output, 50);
    expect(result).toContain('[Output truncated: 150 characters omitted]');
    expect(result).toContain('a'.repeat(50));
  });
});

describe('retry', () => {
  it('succeeds on first try', async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
        return 'success';
      },
      { baseDelayMs: 1, maxDelayMs: 1 },
    );
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  it('gives up after maxRetries', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('always fail');
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toThrow('always fail');
    expect(calls).toBe(3); // initial + 2 retries
  });
});
