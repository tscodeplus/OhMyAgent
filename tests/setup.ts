import i18next from 'i18next';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setI18n } from '../src/i18n/i18n-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesPath = resolve(__dirname, '..', 'src', 'locales');

// Pre-load all locale JSON files and pass as i18next resources (same approach as production).
const resources: Record<string, Record<string, unknown>> = {};

for (const lang of readdirSync(localesPath, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)) {
  resources[lang] = {};
  const langDir = join(localesPath, lang);
  for (const file of readdirSync(langDir).filter(f => f.endsWith('.json'))) {
    const ns = file.replace('.json', '');
    resources[lang][ns] = JSON.parse(readFileSync(join(langDir, file), 'utf-8'));
  }
}

await i18next.init({
  lng: 'en',
  fallbackLng: 'en',
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
  resources,
});

// Replace the module-level singleton so all already-imported modules
// pick up the real i18next-backed service via ESM live bindings.
setI18n({
  t(key: string, interpolations?: Record<string, string | number>): string {
    return i18next.t(key, interpolations as Record<string, unknown>);
  },
  get locale() {
    return i18next.language;
  },
});
