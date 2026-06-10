import type { WechatConfig } from './wechat-types.js';

/**
 * Apply defaults to the raw wechat config from AppConfig.
 */
export function resolveWechatConfig(raw: Partial<WechatConfig>): WechatConfig {
  return {
    enabled: raw.enabled ?? true,
    botToken: raw.botToken || undefined,
    apiBase: raw.apiBase ?? 'https://ilinkai.weixin.qq.com',
    cursorDir: raw.cursorDir ?? './data/wechat',
    textLimit: raw.textLimit ?? 2048,
    aesKey: raw.aesKey || undefined,
    allowedUsers: raw.allowedUsers ?? [],
  };
}
