import { cpSync, existsSync, mkdirSync } from 'node:fs';

const src = 'skills';
const dest = 'dist/skills';

if (!existsSync(src)) {
  console.warn(`Skills source not found: ${src}`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} → ${dest}`);
