// ---------------------------------------------------------------------------
// The knowledge scope of one tool call, derived from the turn it runs in
// ---------------------------------------------------------------------------

import { SCOPE_GLOBAL, scopeFromContext } from '../../../memory/knowledge/scope.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';

export interface TurnScope {
  /** The scope a write records, and the scope a result reports. */
  scope: string;
  /**
   * The scope argument for a read; `undefined` means every scope.
   *
   * For a chat this is the chat's own scope (the read rule adds `global` on top,
   * see `isVisibleInScope`). For a turn carrying no channel, chat or session
   * there is nothing to narrow by: it derives `global`, and the read it can make
   * is the console read — every scope, which is exactly the reading the console
   * affordances (search box, eval, export) get from an omitted scope. Passing
   * `'global'` literally there would hide every chat's page from it.
   */
  readScope: string | undefined;
}

/**
 * Derive the scope from the turn context.
 *
 * The rule itself lives in `memory/knowledge/scope.ts` and is not re-derived
 * here; this only spells out which parts of the context are identity (the
 * conversation: channel, chat, session) and which are not (`projectId` is a
 * memory subdivision, not a knowledge scope).
 */
export function turnScope(ctx: ToolExecutionContext): TurnScope {
  const scope = scopeFromContext({
    channel: ctx.channel,
    chatId: ctx.chatId,
    sessionId: ctx.sessionId,
  });
  return { scope, readScope: scope === SCOPE_GLOBAL ? undefined : scope };
}
