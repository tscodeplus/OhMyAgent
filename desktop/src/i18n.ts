import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDesktopConfig } from './config.js';

// ── Supported locales ──

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// ── Desktop locale shapes ──

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

// ── Language resolution ──

/**
 * Determine the UI language for the application.
 *
 * Priority:
 *  1. Desktop config language (persisted from user's last WebUI choice)
 *  2. Explicitly set UI_LANGUAGE env var
 *  3. System locale (if it matches a supported language)
 *  4. Fallback to "en"
 *
 * Desktop config takes priority over env var because the env var is set
 * once at first launch (based on system locale) and never updated, while
 * the desktop config reflects the user's explicit choice in WebUI settings.
 */
export function resolveUILanguage(): SupportedLocale {
  // 1. Check desktop config for user's persisted language preference (takes priority)
  try {
    const lang = getDesktopConfig().get('language');
    if (lang && SUPPORTED_LOCALES.includes(lang as SupportedLocale)) {
      return lang as SupportedLocale;
    }
  } catch { /* config store may not be ready yet; fall through */ }

  // 2. If user explicitly set UI_LANGUAGE env var, respect that
  if (process.env.UI_LANGUAGE) {
    const explicit = process.env.UI_LANGUAGE;
    if (SUPPORTED_LOCALES.includes(explicit as SupportedLocale)) {
      return explicit as SupportedLocale;
    }
  }

  const sysLocale = app.getLocale(); // e.g. "zh-CN", "en-US", "ja"
  // Exact match
  if (SUPPORTED_LOCALES.includes(sysLocale as SupportedLocale)) {
    return sysLocale as SupportedLocale;
  }
  // Language-only match (e.g. "zh" → "zh-CN", "en-US" → "en")
  const langPart = sysLocale.split('-')[0]!.toLowerCase();
  const matched = SUPPORTED_LOCALES.find((s) => s.toLowerCase().startsWith(langPart));
  if (matched) return matched;
  // Fallback
  return 'en';
}

// ── Locale file loading ──

/** Resolve the path to `src/locales/` for both dev and packaged builds. */
function resolveLocalesDir(): string {
  if (app.isPackaged) {
    // electron-builder copies dist/ (which includes locales/) to resources/server-dist/
    return path.join(process.resourcesPath, 'server-dist', 'locales');
  }
  // Dev: __dirname is either desktop/src/ (tsx) or desktop/dist/ (tsc).
  // Both resolve to the same repository root → src/locales/
  const candidates = [
    path.resolve(__dirname, '..', '..', 'src', 'locales'),
    path.resolve(__dirname, '..', 'src', 'locales'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Last-resort fallback: search from cwd
  return path.resolve(process.cwd(), 'src', 'locales');
}

function loadDesktopLocale(lang: SupportedLocale): DesktopLocales {
  const localesDir = resolveLocalesDir();
  const filePath = path.join(localesDir, lang, 'desktop.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DesktopLocales;
  } catch (err) {
    // Fall back to English if the requested locale fails to load
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

// ── Singleton accessor ──

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

/** Switch to a different language at runtime (invalidates cache immediately). */
export function setDesktopLanguage(lang: SupportedLocale): void {
  currentLang = lang;
  cachedT = loadDesktopLocale(lang);
}

/** Return the currently resolved language. */
export function currentLanguage(): SupportedLocale {
  return resolveUILanguage();
}

// ── Template interpolation ──

/** Replace {{key}} placeholders in a template string with the given values. */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (key in values) return String(values[key]!);
    return `{{${key}}}`; // leave unrecognized placeholders intact
  });
}
