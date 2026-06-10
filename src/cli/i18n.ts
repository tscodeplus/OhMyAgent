import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const locale = process.env.UI_LANGUAGE || 'en';
const localeFile = locale === 'zh-CN' ? 'zh-CN' : 'en';

let messages: Record<string, string> = {};

try {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Try multiple paths: dist/src/cli → ../locales, dist/src/cli → ../../src/locales, etc.
  const candidates = [
    join(currentDir, '..', 'locales', localeFile, 'cli.json'),
    join(currentDir, '..', '..', 'src', 'locales', localeFile, 'cli.json'),
    join(currentDir, '..', '..', 'locales', localeFile, 'cli.json'),
  ];
  for (const p of candidates) {
    try {
      messages = JSON.parse(readFileSync(p, 'utf-8'));
      break;
    } catch { /* try next path */ }
  }
} catch { /* fall back to empty messages */ }

export function t(key: string, vars?: Record<string, string | number>): string {
  let msg = messages[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replace(`{${k}}`, String(v));
    }
  }
  return msg;
}
