/**
 * Required-field registry for the settings UI.
 *
 * A field is required only when its owning feature is enabled (enabled-gating)
 * — e.g. Feishu credentials only matter when channels.feishu.enabled is true.
 * Rules are evaluated per dirty tab by useConfigDirty, which exposes
 * handle.validateRequired() to the settings modal: the modal blocks save,
 * jumps to the offending tab and marks the empty fields red.
 */
export interface RequiredFieldRule {
  /** Config path of the field, e.g. 'feishu.appSecret'. */
  path: string;
  /**
   * Display label for validation messages. Either an i18n key (resolved via
   * t()) or a literal string — anything without a matching translation falls
   * back to the raw string, so plain labels like 'Host' are fine.
   */
  label: string;
  /**
   * Gate: return false to skip this rule. Receives a resolver that reads the
   * dirty value first and falls back to the saved config, e.g.
   * (get) => !!get('feishu.enabled', false).
   */
  when?: (get: (path: string, fallback?: unknown) => unknown) => boolean;
}

export interface MissingRequiredField {
  path: string;
  label: string;
}

/** Channels: an enabled channel must have its credentials filled in. */
export const CHANNELS_REQUIRED_RULES: RequiredFieldRule[] = [
  {
    path: 'feishu.appId',
    label: 'settings.channels.appId',
    when: (get) => !!get('feishu.enabled', false),
  },
  {
    path: 'feishu.appSecret',
    label: 'settings.channels.appSecret',
    when: (get) => !!get('feishu.enabled', false),
  },
  {
    path: 'telegram.botToken',
    label: 'settings.channels.botToken',
    when: (get) => !!get('telegram.enabled', false),
  },
  {
    path: 'wechat.botToken',
    label: 'settings.channels.botToken',
    when: (get) => !!get('wechat.enabled', false),
  },
  {
    path: 'qq.appId',
    label: 'settings.channels.appId',
    when: (get) => !!get('qq.enabled', false),
  },
  {
    path: 'qq.clientSecret',
    label: 'settings.channels.clientSecret',
    when: (get) => !!get('qq.enabled', false),
  },
];

/** Computer use: SSH provider needs host+user; node provider needs a URL. */
export const COMPUTER_REQUIRED_RULES: RequiredFieldRule[] = [
  {
    path: 'computerUse.ssh.host',
    label: 'Host',
    when: (get) =>
      !!get('computerUse.enabled', false) && get('computerUse.provider', 'auto') === 'ssh',
  },
  {
    path: 'computerUse.ssh.user',
    label: 'User',
    when: (get) =>
      !!get('computerUse.enabled', false) && get('computerUse.provider', 'auto') === 'ssh',
  },
  {
    path: 'computerUse.node.url',
    label: 'URL',
    when: (get) =>
      !!get('computerUse.enabled', false) && get('computerUse.provider', 'auto') === 'node',
  },
];

/**
 * NOTE: multimodal (vision bridge / image & video generation) intentionally
 * has no required rules — an empty modelRef falls back to the primary model
 * (agent-services.ts), so it is optional by design.
 */

/** Treat empty string / null / undefined as missing; anything else is present. */
export function isBlankValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

/**
 * Evaluate rules against a resolver (dirty value first, saved config as
 * fallback). Rules without `when` always apply — used for dynamically built
 * rule lists (e.g. web-search API keys for the selected providers).
 */
export function missingRequiredFields(
  rules: RequiredFieldRule[],
  get: (path: string, fallback?: unknown) => unknown,
): MissingRequiredField[] {
  return rules
    .filter((r) => (!r.when || r.when(get)) && isBlankValue(get(r.path, '')))
    .map((r) => ({ path: r.path, label: r.label }));
}
