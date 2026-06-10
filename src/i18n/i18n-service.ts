import i18next from 'i18next';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface I18nService {
  t(key: string, interpolations?: Record<string, string | number>): string;
  readonly locale: string;
}

/** Fallback service: returns the key itself. Replaced by createI18nService() or setI18n() on init. */
function createFallbackService(): I18nService {
  return {
    t(key: string, interpolations?: Record<string, string | number>): string {
      if (!interpolations) return key;
      return key.replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(interpolations[name] ?? `{{${name}}}`),
      );
    },
    locale: 'en',
  };
}

/** Module-level singleton — default fallback; replaced by createI18nService() or setI18n() on init. */
export let i18n: I18nService = createFallbackService();

/** Allow external code (e.g. test setup) to directly inject an I18nService. */
export function setI18n(service: I18nService): void {
  i18n = service;
}

/** Hot reload: switch locale without restart. Locale files must already be loaded. */
export async function changeI18nLocale(locale: string): Promise<void> {
  await i18next.changeLanguage(locale);
}

/** Pre-load all locale JSON files and pass as resources to i18next. */
function loadResources(localesPath: string): Record<string, Record<string, string | object>> {
  const resources: Record<string, Record<string, string | object>> = {};

  const localeDirs = readdirSync(localesPath, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const lang of localeDirs) {
    resources[lang] = {};
    const langDir = join(localesPath, lang);
    const files = readdirSync(langDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const ns = file.replace('.json', '');
      resources[lang][ns] = JSON.parse(readFileSync(join(langDir, file), 'utf-8')) as Record<string, string | object>;
    }
  }

  return resources;
}

export async function createI18nService(options: {
  defaultLocale: string;
  localesPath: string;
}): Promise<I18nService> {
  const resources = loadResources(options.localesPath);

  await i18next.init({
    lng: options.defaultLocale,
    fallbackLng: 'en',
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    resources: resources as Record<string, Record<string, string | object>>,
  });

  const service: I18nService = {
    t(key: string, interpolations?: Record<string, string | number>): string {
      return i18next.t(key, interpolations as Record<string, unknown>);
    },
    get locale() {
      return i18next.language;
    },
  };

  i18n = service;
  return service;
}
