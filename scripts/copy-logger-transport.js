/**
 * Copy the self-healing pino transport (src/app/file-self-heal.js) into the
 * compiled output. tsc only emits `.ts` files, but pino loads transport
 * targets at runtime via `import()`, and the target module must be plain JS
 * (pino wires up ts-node/ts-node-dev for `.ts` targets only — a `.ts` module
 * fails under tsx). This script keeps the file next to the compiled
 * `dist/src/app/logger.js`, which resolves the `./file-self-heal.js` target
 * relative to itself.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const src = 'src/app/file-self-heal.js';
const dest = 'dist/src/app/file-self-heal.js';

if (!existsSync(src)) {
  console.warn(`Logger transport source not found: ${src}`);
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest);
console.log(`Copied ${src} to ${dest}`);
