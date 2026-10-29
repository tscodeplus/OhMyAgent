/**
 * Page scopes: which conversation a page belongs to.
 *
 * The problem this models: `knowledge_pages` is one table behind every channel
 * (Feishu, Telegram, WeChat, QQ, cron, WebUI), so without a scope a page curated
 * from one group chat is a candidate answer in *every* chat on that database —
 * and `findByTitleOrAlias` would let a curation in chat B silently rewrite chat
 * A's page on the same subject. Privacy is only half of it; the other half is
 * that a `decision` page from another group answers "what did we decide here"
 * with someone else's decision.
 *
 * The model is deliberately three-valued and tiny:
 *
 * - `global` — visible everywhere. A human acting at the console (WebUI edit,
 *   `POST /api/knowledge/page`, approving a pending page) writes here, because a
 *   person reviewing pages is the authority for the whole install, and because a
 *   review queue that produces pages nobody can read is a dead end.
 * - `channel:<chatId>` — one chat's knowledge. Written by tool calls, curation
 *   and `/knowledge share` on the channel hot path, read back only there.
 * - `session:<sessionId>` — a channel message with no chat id (direct messages
 *   that report only a session). Kept distinct from `global` for the same reason
 *   as the chat scope: a DM is not a broadcast.
 *
 * The console channel (`webui`) is the exception, and it is why
 * {@link scopeFromContext} folds it to `global`: a person editing or approving a
 * page at the console speaks for the whole install (that is what `create` and
 * `update` default to), and a console write landing in a scope no chat reads is
 * a page nobody sees. A console is not a conversation.
 *
 * Reads are `scope = :scope OR scope = 'global'` (see {@link isVisibleInScope}),
 * never a strict equality: a page promoted to global must stay readable where it
 * came from, and a chat must still see what the console wrote.
 *
 * Scope is a **value**, not a permission: it decides what one query returns, not
 * whether a caller is allowed to ask. Access control belongs to the channel
 * layer, which already knows who is talking.
 */

/** The scope every install has, and the only one an unscoped caller gets. */
export const SCOPE_GLOBAL = 'global';

/** Longest plausible `channel:<id>` / `session:<id>`; longer input is truncated. */
const MAX_SCOPE_LENGTH = 190;

/**
 * Normalise anything a caller passes into a storable scope.
 *
 * Empty, whitespace-only and non-string input mean `global` — an unscoped write
 * is a console write, and silently inventing a per-row scope for it would make
 * the page unreadable by the very caller that created it. Whitespace is folded
 * to `-` and the value is lower-cased so `Feishu:oc_1` and `feishu:oc_1` are one
 * scope rather than two rows that never see each other.
 */
export function normalizeScope(raw: unknown): string {
  if (typeof raw !== 'string') return SCOPE_GLOBAL;
  const folded = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!folded || folded === SCOPE_GLOBAL) return SCOPE_GLOBAL;
  return folded.slice(0, MAX_SCOPE_LENGTH);
}

/** What the channel hot path knows about the turn, and nothing more. */
export interface ScopeSource {
  channel?: string | null;
  chatId?: string | null;
  sessionId?: string | null;
}

/** The channel id of the console; see {@link scopeFromContext}. */
const CONSOLE_CHANNEL = 'webui';

/**
 * The scope a turn reads and writes.
 *
 * A chat id outranks a session id because a chat is shared and a session is a
 * conversation *inside* it: scoping to the session would hide "how we deploy"
 * from the next turn in the same group. No channel means no chat, which is cron
 * (and a programmatic caller) — those fall through to `session:` and then to
 * `global`, so an unpinned background write does not disappear into a scope
 * nobody reads.
 *
 * The console is always `global`, even though it does carry a channel and a
 * chat id (`webui`, `webui:<projectId>`): it is not a conversation. A person
 * writing or approving a page there is the authority for the whole install, and
 * a console write that landed in `webui:webui:<project>` would be readable from
 * that one project and invisible to every chat.
 */
export function scopeFromContext(source: ScopeSource | undefined): string {
  if (!source) return SCOPE_GLOBAL;
  const channel = typeof source.channel === 'string' ? source.channel.trim().toLowerCase() : '';
  const chatId = typeof source.chatId === 'string' ? source.chatId.trim() : '';
  const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : '';

  if (channel === CONSOLE_CHANNEL) return SCOPE_GLOBAL;
  if (channel && chatId) return normalizeScope(`${channel}:${chatId}`);
  if (channel && sessionId) return normalizeScope(`${channel}:session:${sessionId}`);
  if (sessionId) return normalizeScope(`session:${sessionId}`);
  return SCOPE_GLOBAL;
}

/**
 * Whether a page stored under `pageScope` answers a read in `scope`.
 *
 * The one rule every lane must agree on, which is why it is a function rather
 * than an inline `OR` at each call site: a strict equality would hide globals
 * (the console's writes vanish from chat) and dropping the filter entirely is
 * the bug this whole mechanism exists to fix.
 */
export function isVisibleInScope(pageScope: string | null | undefined, scope: string): boolean {
  const stored = normalizeScope(pageScope);
  const asked = normalizeScope(scope);
  return stored === SCOPE_GLOBAL || stored === asked;
}

/**
 * SQL fragment for the same rule, with the column owner spelled out.
 *
 * Two positional parameters, in order: the asked scope (twice). Kept here beside
 * {@link isVisibleInScope} so the JS and SQL versions cannot drift — a repository
 * that filtered differently from the service would leak exactly the pages the
 * service thought it had excluded.
 */
export function scopeSql(column: string, askedScope: string): { sql: string; params: string[] } {
  const scope = normalizeScope(askedScope);
  return {
    sql: `(${column} = ? OR ${column} = '${SCOPE_GLOBAL}')`,
    params: [scope],
  };
}
