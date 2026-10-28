/**
 * `session_search` — raw conversation text as a tool result.
 *
 * The gap this closes: every retrieval path the agent had (`memory_recall`,
 * per-turn injection) reads the `memories` table, i.e. compressed preferences
 * and summaries. The original messages were indexed in `messages_fts_jieba` and
 * readable by nobody but the WebUI, so "上次那个方案叫什么" had no route to an
 * answer. See `src/memory/conversation-search.ts` for the retrieval contract.
 *
 * ## Why it goes through `unifiedSearch()`
 *
 * The same corpus was ranked twice — once here, once by the WebUI's
 * `/api/search` — which is the divergence K5 exists to remove. So this tool
 * asks `unifiedSearch()` for the message lane (raw transcript) plus the
 * knowledge lane (the curated page that may already settle the question), and
 * the fused list is what it renders. The knowledge lane is optional: with the
 * layer off, no service is wired in, the fusion reduces to the message lane
 * alone (an identity), and the result is byte-for-byte what this tool returned
 * before K5.
 *
 * ## The budget
 *
 * `limit` stays a **hard total cap**, neighbourhood expansion and knowledge
 * hits included: a budget that only capped hits would let `limit: 8` return
 * 8 × 3 = 24 fragments and blow the 400-token per-turn budget. Fusion enforces
 * it (`hits.length <= limit`, whatever mix of lanes), and the page lane may
 * spend at most `KNOWLEDGE_SUPPLEMENT_LIMIT` of those entries so the message
 * lane keeps the allowance the caller asked for.
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
} from '../../../memory/conversation-search.js';
import type { SessionAccessPolicy } from '../../../memory/session-access.js';
import type { KnowledgeService } from '../../../memory/knowledge/service-contract.js';
import { unifiedSearch } from '../../../memory/unified-search.js';
import type {
  UnifiedKnowledgeHit,
  UnifiedMessageHit,
  UnifiedSearchResult,
} from '../../../memory/unified-search.js';

export const SESSION_SEARCH_TOOL_NAME = 'session_search';
export const SESSION_SEARCH_TOOL_LABEL = 'Session Search';

/**
 * How many of the `limit` entries the knowledge lane may take.
 *
 * Pages are a supplement, not a second half of the answer: this tool exists to
 * hand back messages, and a page lane that returned as many rows as the message
 * lane would take half the budget on every call. Two is the same ceiling the
 * per-turn `<knowledge_available>` block uses (titles only, ≤2), so a tool
 * result tells the model about as many pages as injection does.
 */
const KNOWLEDGE_SUPPLEMENT_LIMIT = 2;

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
      `Maximum entries to return across messages and knowledge pages, surrounding context ` +
        `included (default ${DEFAULT_CONVERSATION_SEARCH_LIMIT}).`,
    ),
});

export type SessionSearchArgs = z.infer<typeof sessionSearchParams>;

export const SESSION_SEARCH_PARAMETERS_SCHEMA = zodToTypeBox(sessionSearchParams);

export interface SessionSearchToolOptions {
  db: Database.Database;
  /** Current session's project id; undefined means "no project restriction". */
  projectId?: string;
  /**
   * The knowledge lane's service. Absent means the layer is off, and the tool
   * behaves exactly as the message-only search it used to be.
   */
  knowledge?: Pick<KnowledgeService, 'search' | 'get'>;
  logger?: Pick<import('pino').Logger, 'debug' | 'warn'>;
}

export const SESSION_SEARCH_DESCRIPTION =
  'Search the original text of past conversations (every channel, all sessions) and return the ' +
  'matching messages with their session title, channel, time, one message of surrounding ' +
  'context, and the ids of memories / knowledge pages derived from them. Curated knowledge ' +
  'pages that match are returned alongside them, labelled by source. Use it for anything ' +
  'that refers to an earlier discussion ("the plan from last time", "where did we put that ' +
  'script") instead of guessing from summaries.';

/**
 * Run the search and render it for the model.
 *
 * `metadata.hits` carries the structured message result and `metadata.pages`
 * the knowledge hits from the same fused list: later per-turn injection of a
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

  // The cap the caller asked for, defaulted here rather than in the fusion:
  // `unifiedSearch` defaults to 10 and this tool's documented default is 8.
  const limit = input.limit ?? DEFAULT_CONVERSATION_SEARCH_LIMIT;

  let fused: UnifiedSearchResult;
  try {
    fused = await unifiedSearch({
      query: input.query,
      // Message + knowledge, explicitly: without the set, "message only" would
      // be an accident of which options the composer happened to pass.
      lanes: ['message', 'knowledge'],
      messages: {
        db: options.db,
        policy,
        sessionId: input.sessionId,
        channel: input.channel,
        since: input.since,
        until: input.until,
      },
      ...(options.knowledge ? { knowledge: { service: options.knowledge } } : {}),
      // `limit` is the TOTAL cap: fusion trims the mixed list to it, so pages
      // and neighbourhood rows compete for the same entries.
      limit,
      perLaneLimit: limit,
      perLaneLimits: { knowledge: Math.min(limit, KNOWLEDGE_SUPPLEMENT_LIMIT) },
      logger: options.logger,
    });
  } catch (err) {
    return errorResult(
      `session_search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const messageHits = fused.hits.filter((hit): hit is UnifiedMessageHit => hit.lane === 'message');
  const pageHits = fused.hits.filter((hit): hit is UnifiedKnowledgeHit => hit.lane === 'knowledge');

  // Chronological, as this tool has always rendered them: a hit plus its
  // neighbour is meant to read as the consecutive exchange it was. The fused
  // order decided *which* entries survive the cap; it is not a display order.
  const orderedMessages = [...messageHits].sort(
    (a, b) => a.createdAt - b.createdAt || a.ref.localeCompare(b.ref),
  );

  options.logger?.debug(
    {
      query: input.query,
      hitCount: orderedMessages.length,
      pageCount: pageHits.length,
      limit,
      lanes: fused.lanes,
    },
    'session_search results',
  );

  const metadata = {
    query: input.query,
    hits: orderedMessages,
    pages: pageHits,
    lanes: fused.lanes,
  };

  if (orderedMessages.length === 0 && pageHits.length === 0) {
    return textResult(`No conversation messages matched "${input.query}".`, metadata);
  }

  const sections: string[] = [];
  if (orderedMessages.length === 0) {
    sections.push(`No conversation messages matched "${input.query}".`);
  } else {
    sections.push(
      `Found ${orderedMessages.length} message(s) for "${input.query}" (oldest first; entries ` +
        `marked "+context" are the neighbouring message, not a keyword match):`,
      orderedMessages.map((hit, index) => formatMessageHit(hit, index)).join('\n\n'),
    );
  }

  if (pageHits.length > 0) {
    sections.push(
      `Found ${pageHits.length} knowledge page(s) for "${input.query}" (curated pages, already ` +
        `written down — cite the page instead of re-deriving its content from the messages):`,
      pageHits.map((hit, index) => formatPageHit(hit, index)).join('\n\n'),
    );
  }

  return textResult(sections.join('\n\n'), metadata);
}

function formatMessageHit(hit: UnifiedMessageHit, index: number): string {
  const header = [
    `${index + 1}. ${formatTime(hit.createdAt)}`,
    hit.channel,
    hit.sessionTitle ?? '(untitled session)',
    hit.role,
    hit.expanded ? '+context' : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const meta = [`message ${hit.ref}`, `session ${hit.sessionId}`];
  if (hit.memoryIds.length > 0) meta.push(`memories ${hit.memoryIds.join(', ')}`);
  if (hit.knowledgeSlugs.length > 0) meta.push(`knowledge ${hit.knowledgeSlugs.join(', ')}`);

  return `${header}\n  (${meta.join(' · ')})\n  ${hit.snippet}`;
}

/**
 * A page hit, in the same shape as a message hit (index, title, metadata line,
 * excerpt) so the model reads one kind of block — the section heading and the
 * `page` label are what tell it this is a curated document, not a past message.
 * `slug` is what `knowledge_get` takes; the id is there for `knowledge_*`
 * bookkeeping and logs.
 */
function formatPageHit(hit: UnifiedKnowledgeHit, index: number): string {
  const header = [`${index + 1}. ${hit.title}`, hit.pageType].join(' · ');
  const meta = [`page ${hit.slug}`, `id ${hit.ref}`];
  return `${header}\n  (${meta.join(' · ')})\n  ${hit.snippet}`;
}

/** `2026-10-08 14:03Z`; the epoch-ms number is formatted, never re-parsed as text. */
function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown time';
  return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
