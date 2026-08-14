/**
 * pino transport worker: self-healing file destination.
 *
 * pino's built-in `pino/file` transport opens its destination once at startup
 * and reuses the same file descriptor forever. If the log file is deleted from
 * outside (e.g. the user clears `logs/` while the server is running), the open
 * fd keeps writing into the now-unlinked inode and the file never reappears on
 * disk until the process restarts — a classic "delete the log, no new logs"
 * trap. This worker re-checks the destination before every write: when it no
 * longer exists, the stale fd is closed and a fresh append stream is opened,
 * so the file is recreated on the next log line instead of requiring a restart.
 *
 * This module is loaded by pino's transport worker via `import()`, so it must
 * stay plain ESM JavaScript. pino only wires up ts-node/ts-node-dev for `.ts`
 * transport targets (see pino/lib/transport-stream.js), so a `.ts` module
 * would fail to load under tsx — hence `.js`, copied into `dist` at build time
 * by scripts/copy-logger-transport.js.
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';

export default function fileSelfHeal(opts) {
  const file = opts?.destination;
  if (!file) {
    throw new Error('file-self-heal transport requires a `destination` option');
  }
  if (opts?.mkdir) {
    mkdirSync(dirname(file), { recursive: true });
  }

  let stream = createWriteStream(file, { flags: 'a' });
  const onError = (err) => {
    // Must attach an error handler or an unwritable path would crash the
    // transport worker thread. Log through the worker's console (no pino
    // recursion — this is the log sink itself).
    console.error('[file-self-heal] log write failed:', err);
  };
  stream.on('error', onError);

  return new Writable({
    write(chunk, _enc, cb) {
      if (!existsSync(file)) {
        // File was deleted behind our back — close the stale fd (still
        // pointing at the unlinked inode) and reopen; append mode recreates it.
        stream.end();
        stream = createWriteStream(file, { flags: 'a' });
        stream.on('error', onError);
      }
      stream.write(chunk, cb);
    },
    final(cb) {
      stream.end(cb);
    },
    destroy(err, cb) {
      stream.destroy();
      cb(err);
    },
  });
}
