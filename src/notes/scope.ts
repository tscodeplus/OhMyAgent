/**
 * The read rule for notes: `(scope, scope_key)` (plan §4.2-5).
 *
 * One function, called by the repository's list/get, the FTS lane and the HTTP
 * routes, because a filter that ranks differently from the layer that returns it
 * leaks the rows it meant to exclude — the lesson every scope filter in this
 * codebase carries.
 *
 * The rule is a four-way match against the caller's context:
 *
 *   scope='user'
 *     OR (scope='project' AND scope_key = <current project>)
 *     OR (scope='channel' AND scope_key = '<channel>:<chatId>')
 *     OR (scope='session' AND scope_key = <current session>)
 *
 * There is no "global" level: a note is either personal, or
 * scoped to a project, a chat, or one session. A console request with no context
 * sees everything, which is what makes the WebUI page (where a human is looking
 * at their own library) work.
 */

import type { NoteChannel, NoteScope, NoteScopeContext } from './types.js';

export interface ScopeFilter {
  /** SQL fragment to append to a WHERE clause, `scope`-qualified as needed. */
  sql: string;
  params: string[];
}

/**
 * The SQL predicate for "readable from this context", or `null` for unscoped
 * access (console/WebUI, where a human browses their whole library).
 *
 * `alias` is the table alias the predicate is written against (`n` in the
 * repository's joins), and the params are positional in the order returned.
 */
export function readableScopeSql(
  context: NoteScopeContext | null | undefined,
  alias = 'n',
): ScopeFilter | null {
  if (!context) return null;

  const clauses = [`${alias}.scope = 'user'`];
  const params: string[] = [];
  if (context.projectId) {
    clauses.push(`(${alias}.scope = 'project' AND ${alias}.scope_key = ?)`);
    params.push(context.projectId);
  }
  if (context.channelKey) {
    clauses.push(`(${alias}.scope = 'channel' AND ${alias}.scope_key = ?)`);
    params.push(context.channelKey);
  }
  if (context.sessionId) {
    clauses.push(`(${alias}.scope = 'session' AND ${alias}.scope_key = ?)`);
    params.push(context.sessionId);
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

/** `<channel>:<chatId>` — the `channel` scope key format. */
export function channelScopeKey(channel: NoteChannel | string, chatId: string): string {
  return `${channel}:${chatId}`;
}

export interface DefaultScopeInput {
  channel?: NoteChannel | string | null;
  /** True for a group chat: other people are in it, so it must not leak to `user`. */
  isGroupChat?: boolean;
  chatId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
}

/**
 * The scope a new note lands in when the user did not choose one (plan §5.7).
 *
 * Defaults are chosen so that opening injection later does not leak (§4.5):
 * a group chat's notes belong to that chat, a project conversation's notes to
 * that project, everything else to the person. `session` is never inferred —
 * it is a "just this once" promise, and guessing it loses notes.
 */
export function defaultScope(input: DefaultScopeInput): { scope: NoteScope; scopeKey: string } {
  if (input.isGroupChat && input.chatId && input.channel) {
    return { scope: 'channel', scopeKey: channelScopeKey(input.channel, input.chatId) };
  }
  if (input.projectId) return { scope: 'project', scopeKey: input.projectId };
  return { scope: 'user', scopeKey: '' };
}
