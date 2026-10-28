/**
 * `session_search` — raw conversation text as a tool result.
 *
 * The gap this closes: every retrieval path the agent had (`memory_recall`,
 * per-turn injection) reads the `memories` table, i.e. compressed preferences
 * and summaries. The original messages were indexed in `messages_fts_jieba` and
 * readable by nobody but the WebUI, so "上次那个方案叫什么" had no route to an
 * answer. See `src/memory/conversation-search.ts` for the retrieval contract.
 *
 * The split mirrors `memory/recall-definition.ts`: this module owns the
 * arguments, the search call and the result formatting; `session-search-
 * definition.ts` owns the registry-facing `ToolDefinition` (capability
 * descriptor, category, deferral).
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { zodToTypeBox } from '../../tool-adapter.js';
import { errorResult, textResult } from '../../platform/tool-result.js';
import type { ToolExecutionResult } from '../../platform/tool-result.js';
import {
  DEFAULT_CONVERSATION_SEARCH_LIMIT,
  MAX_CONVERSATION_SEARCH_LIMIT,
  searchMessages,
} from '../../../memory/conversation-search.js';
import type { ConversationSearchHit } from '../../../memory/conversation-search.js';
import type { SessionAccessPolicy } from '../../../memory/session-access.js';

export const SESSION_SEARCH_TOOL_NAME = 'session_search';
export const SESSION_SEARCH_TOOL_LABEL = 'Session Search';

export const sessionSearchParams = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'What to look for in past conversations. Keyword search (BM25), Chinese and English both work.',
    ),
  sessionId: z.string().optional().describe('Restrict the search to one session id.'),
  channel: z
    .string()
    .optional()
    .describe('Restrict to one channel: feishu | telegram | wechat | qq | webui | cron | unknown.'),
  since: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Only messages at or after this time: ISO date (2026-10-01) or epoch milliseconds.'),
  until: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Only messages at or before this time: ISO date (2026-10-01) or epoch milliseconds.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONVERSATION_SEARCH_LIMIT)
    .optional()
    .describe(
      `Maximum entries to return, surrounding context included (default ${DEFAULT_CONVERSATION_SEARCH_LIMIT}).`,
    ),
});

export type SessionSearchArgs = z.infer<typeof sessionSearchParams>;

export const SESSION_SEARCH_PARAMETERS_SCHEMA = zodToTypeBox(sessionSearchParams);

export interface SessionSearchToolOptions {
  db: Database.Database;
  /** Current session's project id; undefined means "no project restriction". */
  projectId?: string;
  logger?: Pick<import('pino').Logger, 'debug'>;
}

export const SESSION_SEARCH_DESCRIPTION =
  'Search the original text of past conversations (every channel, all sessions) and return the ' +
  'matching messages with their session title, channel, time, one message of surrounding ' +
  'context, and the ids of memories / knowledge pages derived from them. Use it for anything ' +
  'that refers to an earlier discussion ("the plan from last time", "where did we put that ' +
  'script") instead of guessing from summaries.';

/**
 * Run the search and render it for the model.
 *
 * `metadata.hits` carries the structured result: later per-turn injection of a
 * `<recent_conversation>` block formats the same array instead of re-querying.
 */
export async function runSessionSearch(
  args: SessionSearchArgs,
  options: SessionSearchToolOptions,
): Promise<ToolExecutionResult> {
  const parsed = sessionSearchParams.safeParse(args);
  if (!parsed.success) {
    return errorResult(
      `Invalid session_search arguments: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  const input = parsed.data;

  // Derived, not inherited, from MemoryAccessPolicy: messages have a
  // project/session dimension memories do not. Only a *set* project narrows the
  // search — an IM or project-less turn keeps every session visible.
  const policy: SessionAccessPolicy = options.projectId ? { projectId: options.projectId } : {};

  let hits: ConversationSearchHit[];
  try {
    hits = searchMessages({
      db: options.db,
      query: input.query,
      sessionId: input.sessionId,
      channel: input.channel,
      since: input.since,
      until: input.until,
      limit: input.limit,
      policy,
    });
  } catch (err) {
    return errorResult(
      `session_search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  options.logger?.debug(
    { query: input.query, hitCount: hits.length, limit: input.limit },
    'session_search results',
  );

  if (hits.length === 0) {
    return textResult(`No conversation messages matched "${input.query}".`, { hits });
  }

  const lines = hits.map((hit, index) => formatHit(hit, index));
  return textResult(
    `Found ${hits.length} message(s) for "${input.query}" (oldest first; entries marked ` +
      `"+context" are the neighbouring message, not a keyword match):\n\n${lines.join('\n\n')}`,
    { query: input.query, hits },
  );
}

function formatHit(hit: ConversationSearchHit, index: number): string {
  const header = [
    `${index + 1}. ${formatTime(hit.created_at)}`,
    hit.channel,
    hit.session_title ?? '(untitled session)',
    hit.role,
    hit.expanded ? '+context' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const meta = [`message ${hit.message_id}`, `session ${hit.session_id}`];
  if (hit.memory_ids.length > 0) meta.push(`memories ${hit.memory_ids.join(', ')}`);
  if (hit.knowledge_slugs.length > 0) meta.push(`knowledge ${hit.knowledge_slugs.join(', ')}`);

  return `${header}\n  (${meta.join(' · ')})\n  ${hit.snippet}`;
}

/** `2026-10-08 14:03Z`; the epoch-ms number is formatted, never re-parsed as text. */
function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown time';
  return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
