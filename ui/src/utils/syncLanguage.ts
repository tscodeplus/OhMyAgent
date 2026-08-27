import { apiRequest } from './api';
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
 */
export async function syncLanguageToServer(lang: string = i18n.language): Promise<void> {
  try {
    await apiRequest('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ uiLanguage: lang }),
    });
  } catch {
    // Non-fatal: server-generated text keeps its current language until the
    // next sync. The user-facing UI language is unaffected.
  }
}
