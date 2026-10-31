/**
 * Facet tokens for the FTS index (plan §4.6).
 *
 * A facet — author, channel, project name — is read off a column, never stored
 * in `notes.tags`, because two stores for one fact eventually disagree and the
 * disagreement surfaces as "the filter and the row disagree". But search still
 * has to answer "which notes came from Feishu", and `tags` is the column the FTS
 * table indexes, so the **index** gets the union: user tags plus the facet
 * tokens. Display reads columns, search reads the index, and neither is a second
 * source of truth for the other.
 *
 * Project names are passed in rather than looked up: the caller has one row per
 * note and a fresh name map, so this stays a pure function.
 */

import type { NoteChannel, NoteOrigin } from './types.js';

/**
 * Tokens written into the FTS `tags` column for one note.
 *
 * Both the raw value and its label-ish aliases are included where they differ
 * (`feishu` and `飞书`), because a user searching in Chinese types 飞书 while the
 * column stores `feishu`. Boundaries: origin is `user`/`agent`, which collides
 * with nothing common enough to matter, and `channel` values are platform names.
 */
export function ftsFacetTokens(
  note: {
    origin: NoteOrigin;
    channel: NoteChannel | null;
    projectName?: string | null;
  },
  locale: 'zh' | 'en' = 'zh',
): string[] {
  const tokens: string[] = [note.origin];
  if (note.channel) {
    tokens.push(note.channel);
    const alias = CHANNEL_SEARCH_ALIASES[note.channel];
    if (alias) tokens.push(locale === 'zh' ? alias.zh : alias.en);
  }
  if (note.projectName) tokens.push(note.projectName);
  return tokens;
}

/** How each channel is spelled in a search box, per UI language. */
export const CHANNEL_SEARCH_ALIASES: Partial<Record<NoteChannel, { zh: string; en: string }>> = {
  feishu: { zh: '飞书', en: 'feishu lark' },
  telegram: { zh: '电报 tg', en: 'telegram' },
  wechat: { zh: '微信', en: 'wechat' },
  qq: { zh: 'qq', en: 'qq' },
  webui: { zh: '网页', en: 'webui' },
  cron: { zh: '定时任务', en: 'cron' },
};
