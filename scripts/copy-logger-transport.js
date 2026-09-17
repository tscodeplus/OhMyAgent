/**
 * Copy the self-healing pino transports (src/app/file-self-heal.js and
 * src/app/console-transport.js) into the compiled output. tsc only emits `.ts`
 * files, but pino loads transport targets at runtime via `import()`, and the
 * target modules must be plain JS (pino wires up ts-node/ts-node-dev for `.ts`
 * targets only — a `.ts` module fails under tsx). This script keeps the files
 * next to the compiled `dist/src/app/logger.js`, which resolves the
 * `./file-self-heal.js` and `./console-transport.js` targets relative to itself.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const transports = ['file-self-heal.js', 'console-transport.js'];

for (const name of transports) {
  const src = join('src', 'app', name);
  const dest = join('dist', 'src', 'app', name);

  if (!existsSync(src)) {
    console.warn(`Logger transport source not found: ${src}`);
    continue;
  }

  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`Copied ${src} to ${dest}`);
}
