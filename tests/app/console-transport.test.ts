import { describe, expect, it, vi, afterEach } from 'vitest';

// Plain-JS pino transport target: it is loaded by pino's transport worker via
// `import()`, so it cannot be a `.ts` file (see the module header) and carries
// no declaration file.
// @ts-expect-error TS7016 — the module is intentionally plain JavaScript
import consoleTransport from '../../src/app/console-transport.js';

/**
 * Regression guard for Windows console mojibake.
 *
 * Console log lines used to be written with `fs.writeSync(fd, …)` (sonic-boom,
 * behind the `pino-pretty` and `pino/file` targets). On Windows a console
 * decodes fd-written bytes with its *output code page* — CP936 on a Chinese
 * system — so UTF-8 log text came out as `查询当前时间` → `鏌ヨ褰撳墠鏃堕棿` in
 * PowerShell 7, Windows Terminal and psmux alike, and `chcp 65001` did not
 * change it. The transport must write through `process.stdout.write`, whose
 * libuv TTY path (`WriteConsoleW`) is code-page independent.
 */
describe('console-transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Capture everything the transport hands to process.stdout. */
  function captureStdout(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) (callback as () => void)();
      return true;
    }) as never);
    return written;
  }

  function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.write(line, (err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  const line = (msg: string, title: string) =>
    `${JSON.stringify({ level: 30, time: 1700000000000, title, msg })}\n`;

  it('writes UTF-8 log text through process.stdout, not the raw fd', async () => {
    const written = captureStdout();
    const stream = consoleTransport();

    await writeLine(stream, line('Session title auto-generated', '查询当前时间'));
    stream.end();

    expect(process.stdout.write).toHaveBeenCalled();
    expect(written.join('')).toContain('查询当前时间');
  });

  it('keeps raw JSON lines in production mode (no `pretty` option)', async () => {
    const written = captureStdout();
    const stream = consoleTransport();
    const json = line('hi', '查询当前时间');
    const json2 = line('again', '中文日志测试');

    // thread-stream batches queued lines into one chunk — production mode must
    // pass them through byte-for-byte, batching included.
    await writeLine(stream, json + json2);
    stream.end();

    expect(written.join('')).toBe(json + json2);
  });

  it('prettifies every line when several arrive in one chunk (thread-stream batching)', async () => {
    const written = captureStdout();
    const stream = consoleTransport({
      pretty: { colorize: false, translateTime: false, ignore: 'pid,hostname' },
    });

    // Two log calls in the same tick arrive as a single chunk. Formatting that
    // chunk as one line makes pino-pretty fall back to echoing the raw JSON, so
    // each line has to be formatted on its own.
    await writeLine(stream, line('first', '查询当前时间') + line('second', '中文日志测试'));
    stream.end();

    const output = written.join('');
    expect(output).toContain('INFO: first');
    expect(output).toContain('INFO: second');
    expect(output).toContain('查询当前时间');
    expect(output).toContain('中文日志测试');
    expect(output).not.toContain('{"level"');
  });

  it('re-joins a line that is split across chunks', async () => {
    const written = captureStdout();
    const stream = consoleTransport({
      pretty: { colorize: false, translateTime: false, ignore: 'pid,hostname' },
    });

    const json = line('split', '查询当前时间');
    const cut = 20;
    await writeLine(stream, json.slice(0, cut));
    await writeLine(stream, json.slice(cut));
    stream.end();

    const output = written.join('');
    expect(output).toContain('INFO: split');
    expect(output).toContain('查询当前时间');
    expect(output).not.toContain('{"level"');
  });

  it('prettifies when a `pretty` option is given', async () => {
    const written = captureStdout();
    const stream = consoleTransport({
      pretty: { colorize: false, translateTime: false, ignore: 'pid,hostname' },
    });

    await writeLine(stream, line('Session title auto-generated', '查询当前时间'));
    stream.end();

    const output = written.join('');
    expect(output).toContain('INFO: Session title auto-generated');
    expect(output).toContain('title: "查询当前时间"');
  });
});
