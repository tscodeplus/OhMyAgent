import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = 'src/locales';
const dest1 = 'dist/locales';
const dest2 = 'dist/src/locales';

if (!existsSync(src)) {
  console.warn(`Locales source not found: ${src}`);
  process.exit(0);
}

mkdirSync(dest1, { recursive: true });
cpSync(src, dest1, { recursive: true });
console.log(`Copied ${src} to ${dest1}`);

mkdirSync(dest2, { recursive: true });
cpSync(src, dest2, { recursive: true });
console.log(`Copied ${src} to ${dest2}`);
