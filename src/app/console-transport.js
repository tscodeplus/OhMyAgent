/**
 * pino transport worker: console destination that survives non-UTF-8 consoles.
 *
 * pino's built-in console targets (`pino-pretty`, and `pino/file` with
 * `destination: 1`) write through sonic-boom, i.e. `fs.writeSync(fd, …)`. On
 * Windows that is `WriteFile`, whose bytes a console decodes with its *output
 * code page* — CP936 on a Chinese system. UTF-8 log lines therefore turn into
 * mojibake (`查询当前时间` renders as `鏌ヨ褰撳墠鏃堕棿`) in PowerShell 7, Windows
 * Terminal and psmux alike.
 *
 * `chcp 65001` in the pane does not fix it either (measured on Windows 11 with
 * CP936 and CP65001: `console.log` is correct, `fs.writeSync(1, …)` is mojibake
 * under both). The difference is the write call, not the code page:
 * `console.log` / `process.stdout.write` go through libuv's TTY path
 * (`WriteConsoleW`, code-page independent), while raw fd writes do not.
 *
 * So this worker formats each line itself (pino-pretty's `prettyFactory`, same
 * output as the previous `pino-pretty` target) and hands it to
 * `process.stdout.write`. When stdout is a pipe or a file the bytes are plain
 * UTF-8 either way, so `pnpm dev > log.txt` and Linux/Termux output are
 * unchanged.
 *
 * Chunks are split into lines first: thread-stream batches the log lines it has
 * queued into a single write (two `logger.info()` calls in the same tick arrive
 * as one chunk), and `prettyFactory` parses exactly one line — given several it
 * falls back to echoing the raw JSON. pino-pretty's own transport gets this from
 * `abstractTransport({ parse: 'lines' })`, so the same buffering happens here,
 * including the trailing partial line.
 *
 * Like file-self-heal.js this module is loaded by pino's transport worker via
 * `import()` and must stay plain ESM JavaScript (pino only wires up
 * ts-node/ts-node-dev for `.ts` targets, and a `.ts` target would fail under
 * tsx) — hence `.js`, copied into `dist` at build time by
 * scripts/copy-logger-transport.js.
 */

import { Writable } from 'node:stream';
import { prettyFactory } from 'pino-pretty';

export default function consoleTransport(opts = {}) {
  const format = opts.pretty ? prettyFactory(opts.pretty) : null;

  // Trailing part of a line whose `\n` has not arrived yet.
  let tail = '';

  return new Writable({
    write(chunk, _enc, cb) {
      const text = tail + chunk.toString();
      tail = '';

      if (!format) {
        // Production mode: raw JSON lines, byte-for-byte as pino produced them.
        process.stdout.write(text, cb);
        return;
      }

      const lines = text.split('\n');
      tail = lines.pop() ?? '';
      // process.stdout.write() — never fs.writeSync(1, …). See the header.
      process.stdout.write(lines.map((line) => format(line)).join(''), cb);
    },

    final(cb) {
      if (format && tail) {
        const last = format(tail);
        tail = '';
        process.stdout.write(last, cb);
        return;
      }
      cb();
    },
  });
}
