import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = 'extensions';
const dest = 'dist/extensions';

if (!existsSync(src)) {
  console.warn(`Extensions source not found: ${src}`);
  process.exit(0);
}

const entries = readdirSync(src);
let copied = 0;

for (const entry of entries) {
  const extDir = join(src, entry);
  if (!statSync(extDir).isDirectory()) continue;

  const destExtDir = join(dest, entry);
  mkdirSync(destExtDir, { recursive: true });

  const files = readdirSync(extDir);
  for (const file of files) {
    // Skip TypeScript source files and compiled outputs — tsc already handles these.
    // Compiled .js/.d.ts/.map files in the source tree are stale leftovers from
    // previous builds; copying them over fresh tsc output causes version mismatches.
    if (file.endsWith('.ts')) continue;
    if (file.endsWith('.js') || file.endsWith('.js.map')) continue;
    if (file.endsWith('.d.ts') || file.endsWith('.d.ts.map')) continue;
    const srcPath = join(extDir, file);
    const destPath = join(destExtDir, file);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      cpSync(srcPath, destPath, { recursive: true });
    } else {
      cpSync(srcPath, destPath);
    }
    copied++;
    console.log(`  ${entry}/${file}${st.isDirectory() ? '/' : ''}`);
  }
}

console.log(`Copied ${copied} extension resource files to ${dest}`);
