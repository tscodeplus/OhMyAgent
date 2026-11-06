import { fetchConfig, putConfig } from './config-cache';
import i18n from '../i18n/config';

/**
 * Persist the current WebUI language to the server config (`ui_language`).
 *
 * The server renders slash-command output and other system text in the
 * language of its own i18n singleton, which only updates when `ui_language`
 * in config.yaml changes. The WebUI keeps its display language in
 * localStorage independently, so we must explicitly push the selected
 * language to the server — both when the user toggles it and once after
 * login (so a previously-selected language is restored on the server too).
 *
 * The write is skipped when the server already holds this language. The PUT
 * rewrites `config.yaml` and triggers a full hot-reload (MCP reconciliation,
 * judge rebuild, every config listener), so doing it unconditionally turned
 * each WebUI load into a disk write plus a service reload — and behind a tunnel
 * into another round trip on the critical path. Reading first costs nothing:
 * the config snapshot is shared with the settings panel and the notes layer, so
 * this adds no request of its own.
 */
export async function syncLanguageToServer(lang: string = i18n.language): Promise<void> {
  try {
    const config = await fetchConfig();
    if (config.uiLanguage === lang) return;
    await putConfig({ uiLanguage: lang });
  } catch {
    // Non-fatal: server-generated text keeps its current language until the
    // next sync. The user-facing UI language is unaffected.
  }
}
