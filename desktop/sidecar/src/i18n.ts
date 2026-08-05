// Desktop i18n — port of desktop/src/i18n.ts without Electron. The locale
// strings live in the server's own src/locales/<lang>/desktop.json (bundled at
// server-dist/locales/), so this module just resolves the language and loads
// that file. app.getLocale() → OMA_OS_LOCALE env (set by the Rust shell).

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

interface UpdaterLocale {
  checking: string;
  upToDate: string;
  newVersion: string;
  noReleaseNotes: string;
  upgrade: string;
  cancel: string;
  ok: string;
  checkFailed: string;
  networkTimeout: string;
  noUpdateAvailable: string;
  noUpdateConfig: string;
  downloading: string;
  downloadFailed: string;
  downloaded: string;
  installAndRestart: string;
  speed: string;
  githubRelease: string;
  unsignedMacBuild: string;
}

interface TrayLocale {
  showHide: string;
  restartService: string;
  restarting: string;
  checkUpdates: string;
  openDataDir: string;
  openLogs: string;
  autoStart: string;
  closeToTray: string;
  restartApp: string;
  quit: string;
  serviceStatusRunning: string;
  serviceStatusError: string;
  serviceStatusStopped: string;
  remoteGateway: string;
}

interface GatewayLocale {
  title: string;
  local: string;
  localDesc: string;
  remote: string;
  remoteDesc: string;
  urlPlaceholder: string;
  tokenPlaceholder: string;
  testBtn: string;
  saveBtn: string;
  testing: string;
  exitBtn: string;
  connected: string;
  serverOnlineTokenInvalid: string;
  gatewayUnreachable: string;
}

interface SplashLocale {
  starting: string;
}

interface ErrorLocale {
  startupFailed: string;
  portInUse: string;
  connectionFailed: string;
  tokenInvalid: string;
  pageLoadTimeout: string;
  pageLoadFailed: string;
}

export interface DesktopLocales {
  updater: UpdaterLocale;
  tray: TrayLocale;
  gateway: GatewayLocale;
  splash: SplashLocale;
  error: ErrorLocale;
}

/**
 * Determine the UI language. Priority:
 *  1. Desktop config language (persisted from user's last WebUI choice)
 *  2. Explicitly set UI_LANGUAGE env var
 *  3. System locale (OMA_OS_LOCALE, injected by the shell)
 *  4. Fallback to "en"
 */
export function resolveUILanguage(): SupportedLocale {
  // 1. Desktop config takes priority (user's explicit WebUI choice).
  try {
    const lang = loadConfig().language;
    if (lang && SUPPORTED_LOCALES.includes(lang)) {
      return lang;
    }
  } catch {
    /* config not ready; fall through */
  }

  // 2. UI_LANGUAGE env var.
  const explicit = process.env.UI_LANGUAGE;
  if (explicit && SUPPORTED_LOCALES.includes(explicit as SupportedLocale)) {
    return explicit as SupportedLocale;
  }

  // 3. System locale (Rust shell injected OMA_OS_LOCALE).
  const sysLocale = process.env.OMA_OS_LOCALE ?? 'en';
  if (SUPPORTED_LOCALES.includes(sysLocale as SupportedLocale)) {
    return sysLocale as SupportedLocale;
  }
  const langPart = sysLocale.split('-')[0]!.toLowerCase();
  const matched = SUPPORTED_LOCALES.find((s) => s.toLowerCase().startsWith(langPart));
  if (matched) return matched;

  // 4. Fallback.
  return 'en';
}

/** Locale files: prod lives at server-dist/locales (cwd), dev at repo src/locales. */
function resolveLocalesDir(): string {
  const isDev = process.env.OMA_DEV === '1';
  const base = isDev
    ? path.join(process.cwd(), 'src', 'locales')
    : path.join(process.cwd(), 'locales');
  return base;
}

function loadDesktopLocale(lang: SupportedLocale): DesktopLocales {
  const localesDir = resolveLocalesDir();
  const filePath = path.join(localesDir, lang, 'desktop.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DesktopLocales;
  } catch (err) {
    // Fall back to English.
    if (lang !== 'en') {
      const enPath = path.join(localesDir, 'en', 'desktop.json');
      try {
        const enRaw = fs.readFileSync(enPath, 'utf-8');
        return JSON.parse(enRaw) as DesktopLocales;
      } catch {
        throw new Error(
          `Failed to load desktop locale '${lang}' from ${filePath}, ` +
            `and fallback English locale also failed`,
        );
      }
    }
    throw new Error(
      `Failed to load desktop locale '${lang}' from ${filePath}: ${(err as Error).message}`,
    );
  }
}

let currentLang: SupportedLocale | null = null;
let cachedT: DesktopLocales | null = null;

/** Get the current desktop locale strings. Re-resolves language on each call. */
export function getT(): DesktopLocales {
  const lang = resolveUILanguage();
  if (currentLang !== lang || !cachedT) {
    currentLang = lang;
    cachedT = loadDesktopLocale(lang);
  }
  return cachedT;
}

/** Switch language at runtime (invalidates cache immediately). */
export function setDesktopLanguage(lang: SupportedLocale): void {
  currentLang = lang;
  cachedT = loadDesktopLocale(lang);
}

/** Return the currently resolved language. */
export function currentLanguage(): SupportedLocale {
  return resolveUILanguage();
}

/** Replace {{key}} placeholders in a template string with the given values. */
export function interpolate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (key in values) return String(values[key]!);
    return `{{${key}}}`; // leave unrecognized placeholders intact
  });
}
