import type { QQConfig } from './qq-types.js';

/**
 * Extract a clean QQConfig from the raw AppConfig.qq section.
 * Applies sensible defaults for all optional fields.
 */
export function resolveQQConfig(raw: Partial<QQConfig>): QQConfig {
  return {
    enabled: raw.enabled ?? false,
    appId: raw.appId ?? '',
    clientSecret: raw.clientSecret ?? '',
    sandbox: raw.sandbox ?? false,
    allowedUsers: raw.allowedUsers ?? [],
    allowedGroups: raw.allowedGroups ?? [],
    streamMode: 'send' as const,
    textLimit: raw.textLimit ?? 2000,
  };
}
