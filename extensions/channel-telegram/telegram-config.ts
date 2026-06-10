import type { TelegramConfig } from './telegram-types.js';

/**
 * Extract a plain TelegramConfig from the full AppConfig.telegram section.
 * Ensures all defaults are applied for optional fields.
 */
export function resolveTelegramConfig(raw: TelegramConfig): TelegramConfig {
  return {
    botToken: raw.botToken,
    mode: raw.mode ?? 'polling',
    webhookUrl: raw.webhookUrl,
    webhookPort: raw.webhookPort ?? 8443,
    webhookSecret: raw.webhookSecret,
    allowedUsers: raw.allowedUsers ?? [],
    allowedGroups: raw.allowedGroups ?? [],
    proxyUrl: raw.proxyUrl,
    streamMode: raw.streamMode ?? 'edit',
    textLimit: raw.textLimit ?? 4096,
    streamIntervalMs: raw.streamIntervalMs ?? 500,
  };
}
