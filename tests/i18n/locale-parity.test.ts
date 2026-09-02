import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * i18n dictionaries are two independent trees (server `src/locales/<lang>/*.json`,
 * UI `ui/src/i18n/locales/<lang>/common.json`) with `fallbackLng: 'zh-CN'`.
 *
 * That fallback makes drift invisible and user-visible at the same time: a key
 * present only in Chinese renders Chinese text in the English UI (not the key
 * name, so nobody notices), and a key present only in English renders an
 * untranslated string to Chinese users. Neither is caught by a type check or by
 * the UI build, because both dictionaries are plain JSON looked up by string.
 *
 * Interpolation placeholders are checked too — an en value missing a `{{var}}`
 * that zh has renders the braces literally.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LANGS = ['en', 'zh-CN'] as const;
type Lang = (typeof LANGS)[number];

/** A key that exists in one language but not the other, with its value. */
interface Drift {
  file: string;
  key: string;
  onlyIn: Lang;
  value: string;
}

/** Same key, different `{{placeholder}}` sets. */
interface PlaceholderDrift {
  file: string;
  key: string;
  enMissing: string[];
  zhMissing: string[];
}

function flatten(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    if (typeof obj === 'string') out.set(prefix, obj);
    return out;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flatten(value, dotted)) out.set(k, v);
    } else if (typeof value === 'string') {
      out.set(dotted, value);
    } else {
      // Non-string leaf (number/array/null) — i18next stringifies it, which is
      // almost always a mistake in a translation file. Record it as a sentinel
      // so the empty-value check below reports it.
      out.set(dotted, '');
    }
  }
  return out;
}

function loadDictionary(absPath: string): Map<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(absPath, 'utf8'));
  return flatten(parsed);
}

function placeholders(value: string): Set<string> {
  return new Set([...value.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]));
}

/** Compare one dictionary pair by absolute path. */
function comparePair(label: string, enPath: string, zhPath: string) {
  const drift: Drift[] = [];
  const placeholderDrift: PlaceholderDrift[] = [];
  const empty: string[] = [];

  const en = loadDictionary(enPath);
  const zh = loadDictionary(zhPath);

  for (const [key, value] of en) {
    if (!zh.has(key)) drift.push({ file: label, key, onlyIn: 'en', value });
    else if (!value.trim()) empty.push(`${label}: ${key}`);
  }
  for (const [key, value] of zh) {
    if (!en.has(key)) drift.push({ file: label, key, onlyIn: 'zh-CN', value });
    else if (!value.trim()) empty.push(`${label}: ${key}`);
  }

  for (const [key, enValue] of en) {
    const zhValue = zh.get(key);
    if (zhValue === undefined) continue;
    const enPh = placeholders(enValue);
    const zhPh = placeholders(zhValue);
    const enMissing = [...zhPh].filter((p) => !enPh.has(p));
    const zhMissing = [...enPh].filter((p) => !zhPh.has(p));
    if (enMissing.length > 0 || zhMissing.length > 0) {
      placeholderDrift.push({ file: label, key, enMissing, zhMissing });
    }
  }

  return { en, zh, drift, placeholderDrift, empty };
}

function serverNamespaceFiles(): string[] {
  const dir = path.join(REPO_ROOT, 'src/locales');
  return readdirSync(path.join(dir, 'zh-CN'))
    .filter((f) => f.endsWith('.json'))
    .sort();
}

describe('i18n dictionary parity', () => {
  it('has the same namespace files on both server sides', () => {
    const missing: string[] = [];
    for (const lang of LANGS) {
      for (const file of serverNamespaceFiles()) {
        if (!existsSync(path.join(REPO_ROOT, 'src/locales', lang, file))) {
          missing.push(`src/locales/${lang}/${file}`);
        }
      }
    }
    expect(missing, `missing namespace files: ${missing.join(', ')}`).toEqual([]);
  });

  const serverResults = serverNamespaceFiles().map((file) => {
    const label = `src/locales/${file}`;
    return {
      label,
      ...comparePair(
        label,
        path.join(REPO_ROOT, 'src/locales/en', file),
        path.join(REPO_ROOT, 'src/locales/zh-CN', file),
      ),
    };
  });

  it('server locales have no keys present in only one language', () => {
    const drift = serverResults.flatMap((r) => r.drift);
    expect(
      drift.map((d) => `${d.file} — only in ${d.onlyIn}: ${d.key} = "${d.value}"`),
      'key drift between src/locales/en and src/locales/zh-CN',
    ).toEqual([]);
  });

  it('server locales use matching {{placeholders}} per key', () => {
    const found = serverResults.flatMap((r) => r.placeholderDrift);
    expect(
      found.map(
        (d) =>
          `${d.file} — ${d.key}: en missing [${d.enMissing.join(', ')}], ` +
          `zh missing [${d.zhMissing.join(', ')}]`,
      ),
    ).toEqual([]);
  });

  it('server locales have no empty values', () => {
    const empty = [...new Set(serverResults.flatMap((r) => r.empty))];
    expect(empty, 'empty / non-string translation values').toEqual([]);
  });

  const ui = comparePair(
    'ui/src/i18n/locales/common.json',
    path.join(REPO_ROOT, 'ui/src/i18n/locales/en/common.json'),
    path.join(REPO_ROOT, 'ui/src/i18n/locales/zh-CN/common.json'),
  );

  it('UI dictionary has no keys present in only one language', () => {
    expect(
      ui.drift.map((d) => `only in ${d.onlyIn}: ${d.key} = "${d.value}"`),
      'key drift between ui en and zh-CN common.json',
    ).toEqual([]);
  });

  it('UI dictionary uses matching {{placeholders}} per key', () => {
    expect(
      ui.placeholderDrift.map(
        (d) =>
          `${d.key}: en missing [${d.enMissing.join(', ')}], ` +
          `zh missing [${d.zhMissing.join(', ')}]`,
      ),
    ).toEqual([]);
  });

  it('UI dictionary has no empty values', () => {
    expect([...new Set(ui.empty)]).toEqual([]);
  });

  it('both dictionaries are non-trivially populated', () => {
    // Guards the parity checks themselves: an empty or truncated file would
    // otherwise pass every comparison above vacuously.
    for (const r of serverResults) {
      expect(r.en.size, `${r.label} (en) is empty — parity checks would pass vacuously`).toBeGreaterThan(0);
      expect(r.zh.size, `${r.label} (zh-CN) is empty — parity checks would pass vacuously`).toBeGreaterThan(0);
    }
    expect(ui.en.size).toBeGreaterThan(500);
    expect(ui.zh.size).toBeGreaterThan(500);
  });
});
