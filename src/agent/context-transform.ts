/**
 * Context Transform
 *
 * Prunes old messages to keep the context window manageable.
 * Optionally auto-injects relevant memories before each LLM call
 * (controlled by MEMORY_AUTO_RECALL in .env).
 *
 * When enabled, uses the full hybrid retrieval pipeline (vector + FTS5 → RRF merge)
 * to search for memories semantically and by keyword. One embedding API call per
 * session when frequency is "first", or per LLM call when "every".
 *
 * Cache optimization: dynamic injections (date, memories, mermaid canvas) are
 * placed in separate content blocks AFTER the user's original text. This keeps
 * the user text as the cache boundary (for providers that support cache_control)
 * while the dynamic content lives outside the cached prefix.
 *
 * Persona is appended after the user text and other dynamic context so repeated
 * user-message prefixes stay stable while current preferences remain available.
 *
 * Two optional per-turn blocks sit between the memory block and persona, OFF
 * unless their provider is supplied (MyDocs/KNOWLEDGE_WORKBENCH_PLAN.md §6 K1-4
 * and K2-6):
 *
 *   <recent_conversation> — up to 2 raw message excerpts for a recall-shaped
 *       query ("上次那个方案叫什么"), from conversation search. Conditional on
 *       intent: a turn that asks for new work never pays for it.
 *   <knowledge_available> — up to 2 curated page titles + slugs, so the model
 *       knows a page exists and can read its body with `knowledge_get` instead
 *       of guessing from a title.
 *
 * Both are budgeted (≤250 and ≤150 tokens; together the plan's ≤400 G4 limit)
 * and both are no-ops when their provider throws — retrieval must never be a
 * reason a turn fails.
 */

import type { MemoryRetriever, RetrievedMemory } from '../memory/memory-retriever.js';
import type { MermaidCanvas } from '../runtime-artifacts/mermaid-canvas.js';
import type { AutoCompressConfig } from '../app/types.js';
import { compressContext, estimateTokensCached } from './compress.js';
import { estimateTokensForText } from '../shared/token-estimate.js';
import { extractPreferredName } from '../memory/persona-store.js';
import { isPromptInjection } from '../memory/memory-filter.js';
import { truncate } from '../shared/truncation.js';
import { neutralizePromptTags } from '../shared/prompt-boundary.js';
import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';
import { judgeContextForget } from '../judge/hooks/context-forget.js';
import { judgeContextCompactPrune } from '../judge/hooks/context-compact.js';
import { getTurnTaskHint } from './agent-context.js';

function formatCurrentDatePrefix(
  lang?: string,
  granularity: 'minute' | 'day' = 'minute',
): string | null {
  if (!lang) return null;
  const now = new Date();
  if (granularity === 'day') {
    if (lang === 'zh-CN') {
      const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `[当前日期: ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 (${weekDays[now.getDay()]})]`;
    }
    return `[Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}]`;
  }
  const time = now.toLocaleTimeString(lang === 'zh-CN' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  if (lang === 'zh-CN') {
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `[当前时间: ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 (${weekDays[now.getDay()]}) ${time}]`;
  }
  return `[Current time: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${time}]`;
}

const TIME_SENSITIVE_PATTERNS = [
  /几点/,
  /现在.*时间/,
  /当前.*时间/,
  /多久后/,
  /多长时间/,
  /提醒/,
  /定时/,
  /闹钟/,
  /倒计时/,
  /今天.*剩/,
  /今天.*还有/,
  /今晚/,
  /明早|明天早上/,
  /上午|下午|中午|傍晚|凌晨/,
  /\b\d+\s*(分钟|小时|天|周|个月|秒)(后|以后|之后)?/,
  /\b(now|current time|what time|remind|reminder|schedule|timer|alarm|countdown)\b/i,
  /\bin\s+\d+\s*(minutes?|hours?|days?|weeks?|seconds?)\b/i,
  /\b(today|tonight|tomorrow morning|this evening)\b/i,
  /\b(am|pm)\b/i,
];

function getMessageText(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

function isTimeSensitiveRequest(text: string): boolean {
  return TIME_SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

const MEMORY_RELEVANT_PATTERNS = [
  /记忆|记住|回忆|偏好|persona|画像|上次|之前|历史|过去|删除.*记忆|改.*记忆|列.*记忆/i,
  /\b(memory|remember|preference|previous|history|persona)\b/i,
];

const CANVAS_RELEVANT_PATTERNS = [
  /任务|进度|步骤|执行|工具|状态|完成|失败|审批|删除|创建|修改|查看|列出/,
  /\b(task|progress|step|tool|status|done|failed|approve|delete|create|update|list)\b/i,
];

const STALE_CURRENT_TIME_MEMORY_PATTERNS = [
  /当前时间/,
  /当前对话时间/,
  /当前时间背景/,
  /时间设定为/,
  /current time/i,
];

const INJECTED_BLOCK_PREFIXES = [
  '[当前时间',
  '[当前日期',
  '[Current time',
  '[Current date',
  '---\nRelevant remembered information:',
  '---\n[任务进度]',
  '---\n[任务画布]',
  '[当前用户画像',
  '[最新用户偏好',
  // XML-wrapped injection blocks (pi-style structure)
  '<memory_context>',
  '<recent_conversation>',
  '<knowledge_available>',
  '<persona>',
  '<task_progress>',
  '<archived_tool_results>',
];

// Per-session cache signatures — bounded LRU so long-running gateways don't
// accumulate an entry per session forever.
const deepseekMemorySignatureBySession = new LRUCache<string, string>({
  max: 2000,
  ttl: 1000 * 60 * 60 * 24,
});
const deepseekCanvasSignatureBySession = new LRUCache<string, string>({
  max: 2000,
  ttl: 1000 * 60 * 60 * 24,
});

// ── Session-scoped caches (module-level, bounded) ───────────────────────────
// A fresh Agent + transformContext is created PER TURN on the channel hot path
// (see agent-service.ts), so closure-level caches never hit across turns —
// snapshot 'first' mode re-retrieved every turn and incremental compression
// lost its previous summary. These live at module level instead.
// All are bounded LRUs so a long-running gateway doesn't accumulate an entry
// per session forever. ALL keys are namespaced by agentId (nsSessionKey) so
// agents sharing a sessionKey never read each other's injected state.

/** Sessions that already had classic auto-recall triggered ('first' mode). */
const autoRecalledSessions = new LRUCache<string, true>({ max: 2000 });
/** Snapshot-mode memory retrieval results, keyed by agentId:session. */
const snapshotMemoryCache = new LRUCache<string, RetrievedMemory[]>({
  max: 500,
  ttl: 10 * 60_000,
});
const personaInjectedSessions = new LRUCache<string, true>({ max: 2000 });
const personaTextBySession = new LRUCache<string, string>({ max: 2000 });
const desktopBridgeInjectedSessions = new LRUCache<string, true>({ max: 2000 });
/** v9: last compressed index + summary per session for incremental updates. */
const lastCompressedIndexBySession = new LRUCache<string, number>({ max: 500 });
const lastCompressionSummaryBySession = new LRUCache<string, string>({ max: 500 });

function isMemoryRelevantRequest(text: string): boolean {
  return MEMORY_RELEVANT_PATTERNS.some((pattern) => pattern.test(text));
}

function isCanvasRelevantRequest(text: string): boolean {
  return CANVAS_RELEVANT_PATTERNS.some((pattern) => pattern.test(text));
}

function allowsHistoricalTimeMemory(text: string): boolean {
  return /上次|之前|历史|过去|记录|回忆|以前|问过|previous|history|past/i.test(text);
}

function isStaleCurrentTimeMemory(content: string): boolean {
  return STALE_CURRENT_TIME_MEMORY_PATTERNS.some((pattern) => pattern.test(content));
}

function getUserQueryText(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return false;
      // Structured marker first — injection sites tag their blocks with
      // `injected: true`, which cannot false-positive on user text.
      if (b.injected === true) return false;
      // Prefix fallback for blocks from sources without the marker.
      const text = b.text.trimStart();
      return !INJECTED_BLOCK_PREFIXES.some((prefix) => text.startsWith(prefix));
    })
    .map((b: any) => b.text)
    .join('\n');
}

/**
 * Check whether a memory content contains a preferred-name expression.
 * These memories are stale by definition: the persona already provides
 * the authoritative current name, so injecting old name preferences
 * only confuses the LLM.
 */
function containsPreferredNameExpression(content: string): boolean {
  return extractPreferredName(content) !== null;
}

function buildMemoryLines(memories: RetrievedMemory[], query: string): string[] {
  const allowStaleTime = allowsHistoricalTimeMemory(query);
  return (
    memories
      .filter((m) => m.content?.trim())
      .filter((m) => allowStaleTime || !isStaleCurrentTimeMemory(m.content))
      .filter((m) => !containsPreferredNameExpression(m.content))
      // Read-path injection gate (L1): recalled content is untrusted — it may
      // predate the write-side filter or have bypassed it via non-tool writes
      // (summarizer, offload, dream cycle). Never let it override instructions.
      .filter((m) => !isPromptInjection(m.content))
      .map((m) => neutralizePromptTags(`- ${m.content}`))
      .slice(0, 5)
  );
}

/**
 * One message excerpt for the `<recent_conversation>` block.
 *
 * Structured, not pre-formatted: the transform renders the date, collapses
 * whitespace, neutralises prompt tags and enforces the budget, so a provider
 * cannot spend more of the context window than the cap allows.
 */
export interface EpisodicContextItem {
  /** Epoch milliseconds — rendered as `YYYY-MM-DD` by the transform. */
  createdAt: number;
  /** Owning session's title, if it has one. */
  sessionTitle?: string | null;
  /** Channel id as stored (`feishu`, `webui`, …). */
  channel?: string | null;
  role: string;
  /** Already windowed around the match by the caller (`conversation-search`). */
  excerpt: string;
}

/** One curated page offered as a title, per plan §6 K2-6. */
export interface KnowledgeContextItem {
  /** `page_type/slug`, e.g. `topic/excel-etl` or bare `excel-etl` as stored. */
  slug: string;
  title: string;
}

// ── Per-turn injection budget (plan §4 principle 5 / §6 G4) ─────────────────
// The whole automatic injection may add ≤400 tokens per turn. The two blocks
// below are capped separately (250 + 150 = 400) so neither can starve the
// other, and each drops its weakest entries until it fits.
const EPISODIC_BLOCK_TOKEN_BUDGET = 250;
const EPISODIC_MAX_ITEMS = 2;
/** Plan K1-4: "≤2 条片段 × ≤200 字". */
const EPISODIC_EXCERPT_MAX_CHARS = 200;
const KNOWLEDGE_BLOCK_TOKEN_BUDGET = 150;
const KNOWLEDGE_MAX_ITEMS = 2;
/** One `slug — title` line; a title long enough to blow the budget is not a title. */
const KNOWLEDGE_LINE_MAX_CHARS = 80;
/** Header (date · channel · title) is metadata, not content — keep it short. */
const INJECTION_HEADER_MAX_CHARS = 60;

export interface TransformOptions {
  /** Maximum number of messages to retain (default: 100). */
  maxMessages?: number;
  /** Optional system prompt (reserved for future use). */
  systemPrompt?: string;
  /** Memory retriever for auto-recall. Required when autoRecall is true. */
  memoryRetriever?: MemoryRetriever;
  /** When true, inject relevant memories via hybrid search (vector + FTS5). */
  autoRecall?: boolean;
  /**
   * Auto-recall frequency:
   *   "first" — only on the first message of a session (default, one embedding call)
   *   "every" — before every LLM call (one embedding call per message)
   */
  autoRecallFrequency?: 'first' | 'every';
  /**
   * UI language for current date injection (e.g. "zh-CN", "en").
   * When set, the current date is prepended to each user message so the LLM
   * always knows today's date, even if the Agent was created in a prior session.
   */
  dateLanguage?: string;
  /** Session key for scoped memory retrieval. */
  sessionKey?: string;
  /**
   * Agent ID for agent-scoped snapshot memory injection (V2).
   * When set, uses retrieveGrouped with 3-pool retrieval (current/shared/other)
   * instead of the classic single-pool retrieve.
   */
  agentId?: string;
  /**
   * Snapshot memory injection mode (V2):
   *   "first" — retrieve once per session via retrieveGrouped and cache the result (default)
   *   "every" — retrieve before every LLM call via retrieveGrouped
   *   "off"   — disable snapshot injection
   * When unset, derives from autoRecallFrequency ('every' → 'every', otherwise 'first').
   */
  snapshotMode?: 'first' | 'every' | 'off';
  /** Config for tool result offloading index injection. */
  offloadConfig?: { enabled: boolean; maxRefsInContext: number; preserveInMessages?: number };
  /** OffloadStore instance for reading offloaded records. */
  offloadStore?: import('../runtime-artifacts/offload-store.js').OffloadStore;
  /** v9: Auto context compression config (pi-style). */
  compressConfig?: {
    config: AutoCompressConfig;
    contextWindow: number;
    mainModelRef: string;
    globalFallbackRefs: string[];
    compressModelRef?: string;
    compressFallbackRefs?: string[];
    apiKeys: Record<string, string>;
    baseUrls: Record<string, string>;
    baseUrl?: string;
  };
  /** Optional dynamic persona context. Prepended so current preferences override stale context. */
  personaContextProvider?: () => string;
  /**
   * Optional episodic provider (plan §6 K1-4): raw conversation excerpts for a
   * recall-shaped query, best first. Receives the turn's user text — the search
   * needs the query, unlike the persona provider.
   *
   * The transform owns the block (`<recent_conversation>`), the 2-item cap and
   * the token budget; the provider owns retrieval and any turn-level gating it
   * wants (e.g. `conversationSearch.enabled`). Returning `[]`/`undefined` means
   * "nothing relevant", not an error. Undefined provider = no block, exactly as
   * before this option existed.
   */
  episodicContextProvider?: (query: string) => EpisodicContextItem[] | undefined;
  /**
   * Optional knowledge provider (plan §6 K2-6): at most a couple of page
   * titles worth offering this turn, most relevant first — typically
   * `KnowledgeService.titlesForInjection(query, max)`.
   *
   * Titles only, never bodies: the body is a `knowledge_get` call away, and the
   * budget for this block is 150 tokens. Undefined provider = no block.
   */
  knowledgeContextProvider?: (query: string) => KnowledgeContextItem[] | undefined;
  /**
   * Optional provider that returns a system-reminder string when a Desktop Bridge
   * is active for the current session. Injected into the context so the LLM knows
   * it can access the user's local files and shell.
   */
  desktopBridgeReminderProvider?: (sessionKey?: string) => string | undefined;
  /** Config for Mermaid canvas task graph injection. */
  mermaidCanvasConfig?: {
    enabled: boolean;
    injectFormat: 'summary' | 'full';
    maxNodesInContext: number;
  };
  /** MermaidCanvas instance for tracking tool execution progress. */
  mermaidCanvas?: MermaidCanvas;
  /** Optional logger for context-injection observability. */
  logger?: Pick<Logger, 'debug' | 'warn' | 'info'>;
  /** Provider-tuned cache behavior. Currently used for DeepSeek automatic prefix cache. */
  cacheProfile?: 'default' | 'deepseek';
  /**
   * Tokens of the per-turn fixed prefix — system prompt plus every tool schema.
   * pi-mono hands the transform only `messages`, so the compression budget
   * cannot see this itself, and an auto-compress trigger measured on messages
   * alone reads a 128k window as roomy while 10k+ tokens are already spent.
   */
  staticContextTokens?: number;
  /**
   * Called with the compacted transcript after context compression succeeds.
   * Lets the owner (agent factory) write the result back to agent state so
   * future turns start from the summary instead of the full history.
   */
  onCompressed?: (messages: any[]) => void;
  /**
   * Kernel M2/M3 judged decisions (`context.forget` / `context.compact`):
   * live-engine getter — the context events are judged only when this
   * resolves to a JudgeEngine and the respective point mode is not 'off'.
   */
  judgeGet?: () => import('../judge/engine.js').JudgeEngine | undefined;
}

/**
 * Deictic and temporal back-references — "上次", "当时", "we discussed".
 *
 * This is the K1-4 trigger for the episodic block, and it is deliberately a
 * separate list from `MEMORY_RELEVANT_PATTERNS`: that one decides whether to
 * talk about memory at all (and drives the DeepSeek cache bypass), while this
 * one decides whether the turn is *asking about a past exchange*. A query may
 * match either; the block is injected if it matches one.
 */
const RECALL_QUERY_PATTERNS = [
  /上次|上回|那次|当时|刚才|刚刚|前几天|前阵子|之前|以前/,
  /我们(?:说过|聊过|提过|讨论过)|说过|聊过|讨论过/,
  /\b(last time|earlier|previously|the other day|we (?:discussed|talked|said)|before that)\b/i,
];

function isEpisodicRelevantRequest(text: string): boolean {
  return (
    isMemoryRelevantRequest(text) || RECALL_QUERY_PATTERNS.some((pattern) => pattern.test(text))
  );
}

/** `YYYY-MM-DD` in local time; empty when the timestamp is unreadable. */
function formatInjectionDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** One-line excerpt: retrieved chat text is Markdown/HTML-heavy and multi-line. */
function flattenInjectedText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render one `<recent_conversation>` entry, shaped like plan §6 K1-4:
 *
 * ```
 * 2026-10-08 · 飞书 · 目录检查
 *   user: 上次那个 Excel 的批量替换脚本放在哪？
 * ```
 */
function formatEpisodicEntry(item: EpisodicContextItem): string {
  const title = item.sessionTitle?.trim();
  const header = [
    formatInjectionDate(item.createdAt),
    item.channel?.trim() ?? '',
    title ? truncate(title, INJECTION_HEADER_MAX_CHARS) : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
  const excerpt = truncate(
    neutralizePromptTags(flattenInjectedText(item.excerpt)),
    EPISODIC_EXCERPT_MAX_CHARS,
  );
  const speaker = item.role?.trim() || 'unknown';
  const line = `  ${speaker}: ${excerpt}`;
  return header ? `${header}\n${line}` : line;
}

/**
 * Build a tagged block from candidate entries under a token budget.
 *
 * Callers pass entries best-first, so the tail is what gets dropped: an
 * injection that cannot fit is reduced, never truncated mid-line, and a block
 * that cannot fit even one entry is omitted entirely (an empty tag would be
 * pure cost). Uses the same CJK-aware estimator as context compression, so
 * "150 tokens" means the same thing here as it does to the overflow guard.
 */
function buildBudgetedBlock(
  tag: 'recent_conversation' | 'knowledge_available',
  entries: string[],
  tokenBudget: number,
): string | null {
  for (let count = entries.length; count > 0; count--) {
    const block = `\n\n<${tag}>\n${entries.slice(0, count).join('\n')}\n</${tag}>`;
    if (estimateTokensForText(block) <= tokenBudget) return block;
  }
  return null;
}

/**
 * Convert a string user message content to an array of content blocks,
 * preserving the original text as the first block.
 *
 * Array input is copied, not returned as-is: callers append injected blocks to
 * what they get back, and that array is usually the live `AgentMessage.content`
 * held by `agent.state.messages` — mutating it there would leak injected
 * context (date hints, memories) into the persisted transcript.
 */
function ensureContentBlocks(content: string | any[]): any[] {
  if (Array.isArray(content)) return [...content];
  return [{ type: 'text', text: content }];
}

/**
 * Check whether a date prefix has already been injected into the content blocks.
 */
function hasDatePrefix(blocks: any[]): boolean {
  return blocks.some(
    (b: any) =>
      b.type === 'text' &&
      ((b.text ?? '').startsWith('[当前时间') ||
        (b.text ?? '').startsWith('[当前日期') ||
        (b.text ?? '').startsWith('[Current time') ||
        (b.text ?? '').startsWith('[Current date')),
  );
}

function hasPreciseTimePrefix(blocks: any[]): boolean {
  return blocks.some(
    (b: any) =>
      b.type === 'text' &&
      ((b.text ?? '').startsWith('[当前时间') || (b.text ?? '').startsWith('[Current time')),
  );
}

/**
 * Create a context transform function.
 */
export function createTransformContext(options?: TransformOptions) {
  const maxMessages = options?.maxMessages ?? 100;
  const memoryRetriever = options?.memoryRetriever;
  const autoRecall = options?.autoRecall ?? false;
  const autoRecallFrequency = options?.autoRecallFrequency ?? 'first';
  const sessionKey = options?.sessionKey;
  const agentId = options?.agentId;
  // Session-scoped cache key namespaced by agentId: two agents sharing a
  // sessionKey (mid-chat agent switch) never read each other's injected
  // state — persona text, recall flags, canvas signatures, compression
  // progress.
  const nsSessionKey = `${agentId ?? '*'}:${sessionKey || 'default'}`;
  const snapshotMode =
    options?.snapshotMode ?? (autoRecallFrequency === 'every' ? 'every' : 'first');

  // Capture language for per-message date injection (per-instance config,
  // NOT session state — see module-level caches above for the hoisted ones)
  const dateLanguage = options?.dateLanguage;
  const cacheProfile = options?.cacheProfile ?? 'default';
  const prefixTokens = options?.staticContextTokens ?? 0;
  const dateGranularity = 'day';

  return async (messages: any[], _signal?: AbortSignal): Promise<any[]> => {
    const result = [...messages];

    // Inject date/time into the last user message so the LLM knows today's
    // date. Precise time is only appended for clearly time-sensitive turns.
    const datePrefix = formatCurrentDatePrefix(dateLanguage, dateGranularity);
    if (datePrefix) {
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      if (lastUserMsg?.content) {
        const idx = result.lastIndexOf(lastUserMsg);
        const blocks = ensureContentBlocks(lastUserMsg.content);
        if (!hasDatePrefix(blocks)) {
          blocks.push({ type: 'text', text: '\n\n' + datePrefix, injected: true } as any);
        }
        if (
          !hasPreciseTimePrefix(blocks) &&
          isTimeSensitiveRequest(getMessageText(lastUserMsg.content))
        ) {
          const preciseTime = formatCurrentDatePrefix(dateLanguage, 'minute');
          if (preciseTime)
            blocks.push({ type: 'text', text: '\n\n' + preciseTime, injected: true } as any);
        }
        result[idx] = { ...lastUserMsg, content: blocks };
      }
    }

    // Determine which recall strategy to use
    const useSnapshot = memoryRetriever && agentId && snapshotMode !== 'off';

    if (useSnapshot) {
      // V2: Agent-aware snapshot memory injection via retrieveGrouped
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      if (lastUserMsg?.content) {
        const blocks = ensureContentBlocks(lastUserMsg.content);
        const query = getUserQueryText(blocks);
        // Skip very short messages — too vague for meaningful memory search
        if (query.trim().length >= 5) {
          try {
            const cacheKey = nsSessionKey;
            let memories: RetrievedMemory[];
            if (snapshotMode === 'first' && snapshotMemoryCache.has(cacheKey)) {
              memories = snapshotMemoryCache.get(cacheKey)!;
            } else {
              memories = await memoryRetriever.retrieveGrouped({
                query,
                agentId,
                topK: 5,
              });
              if (snapshotMode === 'first') {
                snapshotMemoryCache.set(cacheKey, memories);
              }
            }

            if (memories.length > 0) {
              const memoryLines = buildMemoryLines(memories, query);
              if (memoryLines.length > 0) {
                const memoryHint = `\n\n<memory_context>\nRelevant remembered information:\n${memoryLines.join('\n')}\n</memory_context>`;
                const memoryKey = nsSessionKey;
                const previous = deepseekMemorySignatureBySession.get(memoryKey);
                const shouldInjectMemory =
                  cacheProfile !== 'deepseek' ||
                  previous !== memoryHint ||
                  isMemoryRelevantRequest(query);
                if (shouldInjectMemory) {
                  options?.logger?.debug(
                    {
                      count: memoryLines.length,
                      memories: memoryLines.map((l) => truncate(l, 60)),
                    },
                    'Memories injected into context',
                  );
                  const idx = result.lastIndexOf(lastUserMsg);
                  const injectedBlocks = [
                    ...blocks,
                    { type: 'text', text: memoryHint, injected: true } as any,
                  ];
                  result[idx] = { ...lastUserMsg, content: injectedBlocks };
                  if (cacheProfile === 'deepseek')
                    deepseekMemorySignatureBySession.set(memoryKey, memoryHint);
                } else {
                  options?.logger?.debug(
                    { sessionKey: memoryKey, count: memoryLines.length },
                    'Repeated memory context skipped for DeepSeek cache profile',
                  );
                }
              }
            }
          } catch {
            options?.logger?.debug('Memory retrieval failed — continuing without memory context');
          }
        }
      }
    } else {
      // Classic auto-recall logic (existing behavior for backward compatibility)
      const shouldRecall =
        autoRecall &&
        memoryRetriever &&
        (autoRecallFrequency === 'every' || !autoRecalledSessions.has(nsSessionKey));

      if (shouldRecall) {
        const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
        if (lastUserMsg?.content) {
          const blocks = ensureContentBlocks(lastUserMsg.content);
          const query = getUserQueryText(blocks);
          // Skip very short messages — too vague for meaningful memory search
          if (query.trim().length >= 5) {
            try {
              const memories = await memoryRetriever.retrieve({
                query,
                topK: cacheProfile === 'deepseek' ? 8 : 5,
                scope: 'user', // limit to user-scoped memories
              });

              if (memories.length > 0) {
                const memoryLines = buildMemoryLines(memories, query);
                if (memoryLines.length > 0) {
                  const memoryHint = `\n\n<memory_context>\nRelevant remembered information:\n${memoryLines.join('\n')}\n</memory_context>`;
                  const memoryKey = nsSessionKey;
                  const previous = deepseekMemorySignatureBySession.get(memoryKey);
                  const shouldInjectMemory =
                    cacheProfile !== 'deepseek' ||
                    previous !== memoryHint ||
                    isMemoryRelevantRequest(query);
                  if (shouldInjectMemory) {
                    const idx = result.lastIndexOf(lastUserMsg);
                    const injectedBlocks = [
                      ...blocks,
                      { type: 'text', text: memoryHint, injected: true } as any,
                    ];
                    result[idx] = { ...lastUserMsg, content: injectedBlocks };
                    if (cacheProfile === 'deepseek')
                      deepseekMemorySignatureBySession.set(memoryKey, memoryHint);
                  } else {
                    options?.logger?.debug(
                      { sessionKey: memoryKey, count: memoryLines.length },
                      'Repeated memory context skipped for DeepSeek cache profile',
                    );
                  }
                }
              }
            } catch (err) {
              options?.logger?.debug(
                { err },
                'Memory retrieval failed — continuing without memory context',
              );
            }
            autoRecalledSessions.set(nsSessionKey, true);
          }
        }
      }
    }

    // ── K1-4: episodic injection (`<recent_conversation>`) ──
    // Only for a recall-shaped turn: "上次那个方案叫什么" needs the original
    // wording, while "写一个排序函数" pays 250 tokens for nothing. The provider
    // does the search; this block owns the cap (2 items × ≤200 chars, ≤250
    // tokens), the neutralisation, and the failure mode (log + skip).
    if (options?.episodicContextProvider) {
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      if (lastUserMsg?.content) {
        const query = getUserQueryText(lastUserMsg.content);
        if (query.trim().length >= 5 && isEpisodicRelevantRequest(query)) {
          try {
            const items = options.episodicContextProvider(query) ?? [];
            const entries = items
              .filter((item) => typeof item?.excerpt === 'string' && item.excerpt.trim() !== '')
              .slice(0, EPISODIC_MAX_ITEMS)
              .map(formatEpisodicEntry);
            const block = buildBudgetedBlock(
              'recent_conversation',
              entries,
              EPISODIC_BLOCK_TOKEN_BUDGET,
            );
            if (block) {
              const idx = result.lastIndexOf(lastUserMsg);
              const blocks = ensureContentBlocks(lastUserMsg.content);
              result[idx] = {
                ...lastUserMsg,
                content: [...blocks, { type: 'text', text: block, injected: true } as any],
              };
              options?.logger?.debug(
                { count: entries.length, tokens: Math.ceil(estimateTokensForText(block)) },
                'Episodic conversation injected into context',
              );
            }
          } catch {
            options?.logger?.debug('Episodic context injection failed — continuing without it');
          }
        }
      }
    }

    // ── K2-6: knowledge titles (`<knowledge_available>`) ──
    // Titles and slugs only: the body is a `knowledge_get` call away, and the
    // block's budget (≤2 titles, ≤150 tokens) exists to say "a page about this
    // exists" without pre-empting the tool. `titlesForInjection` already
    // applies the relevance floor, so an unfocused query yields no entries and
    // therefore no block.
    if (options?.knowledgeContextProvider) {
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      if (lastUserMsg?.content) {
        const query = getUserQueryText(lastUserMsg.content);
        if (query.trim() !== '') {
          try {
            const items = options.knowledgeContextProvider(query) ?? [];
            const entries = items
              .filter((item) => typeof item?.slug === 'string' && item.slug.trim() !== '')
              .slice(0, KNOWLEDGE_MAX_ITEMS)
              .map((item) => {
                const title = flattenInjectedText(item.title ?? '');
                const line = title ? `${item.slug.trim()} — ${title}` : item.slug.trim();
                return neutralizePromptTags(truncate(line, KNOWLEDGE_LINE_MAX_CHARS));
              });
            const block = buildBudgetedBlock(
              'knowledge_available',
              entries,
              KNOWLEDGE_BLOCK_TOKEN_BUDGET,
            );
            if (block) {
              const idx = result.lastIndexOf(lastUserMsg);
              const blocks = ensureContentBlocks(lastUserMsg.content);
              result[idx] = {
                ...lastUserMsg,
                content: [...blocks, { type: 'text', text: block, injected: true } as any],
              };
              options?.logger?.debug(
                { count: entries.length, tokens: Math.ceil(estimateTokensForText(block)) },
                'Knowledge titles injected into context',
              );
            }
          } catch {
            options?.logger?.debug('Knowledge title injection failed — continuing without it');
          }
        }
      }
    }

    // ── Inject Mermaid canvas summary BEFORE persona ──
    // Mermaid may reference stale names from conversation history; persona
    // comes last to ensure the current preferred name overrides old references.
    if (options?.mermaidCanvasConfig?.enabled && options?.mermaidCanvas) {
      try {
        const nodes = options.mermaidCanvas.getAllNodes();
        const total = nodes.length;
        const completed = nodes.filter((n) => n.status !== 'running').length;
        const currentPhase = options.mermaidCanvas.getCurrentPhase();
        const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
        const currentUserText = lastUserMsg ? getUserQueryText(lastUserMsg.content) : '';
        const canvasKey = nsSessionKey;
        const canvasSignature = `${total}:${completed}:${currentPhase}`;
        const previousCanvasSignature = deepseekCanvasSignatureBySession.get(canvasKey);
        const shouldSkipCanvas =
          cacheProfile === 'deepseek' &&
          total > 0 &&
          completed === total &&
          previousCanvasSignature === canvasSignature &&
          !isCanvasRelevantRequest(currentUserText);

        if (shouldSkipCanvas) {
          options.logger?.debug(
            { sessionKey: canvasKey, nodeCount: total, currentPhase },
            'Repeated static Mermaid canvas skipped for DeepSeek cache profile',
          );
        } else if (nodes.length <= options.mermaidCanvasConfig.maxNodesInContext) {
          const canvasText = neutralizePromptTags(
            options.mermaidCanvasConfig.injectFormat === 'full'
              ? options.mermaidCanvas.toMermaid()
              : options.mermaidCanvas.toContextSummary(),
          );
          if (canvasText) {
            const canvasHint = `\n\n<task_progress>\n${canvasText}\n</task_progress>`;
            if (lastUserMsg) {
              const idx = result.lastIndexOf(lastUserMsg);
              const blocks = ensureContentBlocks(lastUserMsg.content);
              result[idx] = {
                ...lastUserMsg,
                content: [...blocks, { type: 'text', text: canvasHint, injected: true } as any],
              };
              options.logger?.debug(
                {
                  sessionKey,
                  nodeCount: nodes.length,
                  injectFormat: options.mermaidCanvasConfig.injectFormat,
                  maxNodesInContext: options.mermaidCanvasConfig.maxNodesInContext,
                },
                'Mermaid canvas injected into context',
              );
              // Cache the signature only after the canvas was actually
              // injected — otherwise a skipped injection would suppress
              // future injections of the same canvas.
              if (cacheProfile === 'deepseek')
                deepseekCanvasSignatureBySession.set(canvasKey, canvasSignature);
            }
          }
        } else {
          // Too many nodes — inject a concise count summary instead
          const max = options.mermaidCanvasConfig.maxNodesInContext;
          const countHint = `\n\n<task_progress>\n[任务进度] 当前阶段: ${neutralizePromptTags(currentPhase)} (${completed}/${total} 完成, 显示最近 ${max}/${total} 步)\n</task_progress>`;
          if (lastUserMsg) {
            const idx = result.lastIndexOf(lastUserMsg);
            const blocks = ensureContentBlocks(lastUserMsg.content);
            result[idx] = {
              ...lastUserMsg,
              content: [...blocks, { type: 'text', text: countHint, injected: true } as any],
            };
            options.logger?.debug(
              {
                sessionKey,
                nodeCount: total,
                completed,
                currentPhase,
                maxNodesInContext: max,
              },
              'Mermaid canvas compact progress injected into context',
            );
            if (cacheProfile === 'deepseek')
              deepseekCanvasSignatureBySession.set(canvasKey, canvasSignature);
          }
        }
      } catch (err) {
        options.logger?.warn(
          {
            sessionKey,
            err: err instanceof Error ? err.message : String(err),
          },
          'Mermaid canvas injection failed',
        );
        // Mermaid canvas injection failure should not block the LLM call
      }
    }

    // Inject persona AFTER Mermaid so the current preferred name overrides any
    // stale name references from conversation history or Mermaid summary.

    // ── Inject Desktop Bridge reminder ──
    // Injected once per session so the LLM knows file/shell tools will execute
    // on the user's local machine, not on the gateway server.
    if (options?.desktopBridgeReminderProvider) {
      const bridgeKey = nsSessionKey;
      const reminderText = options.desktopBridgeReminderProvider(sessionKey);
      if (reminderText) {
        const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
        if (lastUserMsg?.content) {
          const idx = result.lastIndexOf(lastUserMsg);
          const blocks = ensureContentBlocks(lastUserMsg.content);
          // Inject once per session — the reminder is static so repeated injection
          // would just waste context tokens.
          if (!desktopBridgeInjectedSessions.has(bridgeKey)) {
            desktopBridgeInjectedSessions.set(bridgeKey, true);
            const bridgeBlock = { type: 'text' as const, text: `${reminderText}\n\n---\n` };
            const nextBlocks = [...blocks, bridgeBlock];
            result[idx] = { ...lastUserMsg, content: nextBlocks };
            options?.logger?.debug({ bridgeKey }, 'Desktop Bridge reminder injected into context');
          }
        }
      } else {
        // Bridge was disconnected — clear the injection flag so it can be
        // re-injected if the bridge reconnects.
        desktopBridgeInjectedSessions.delete(bridgeKey);
      }
    }

    if (options?.personaContextProvider) {
      const personaKey = nsSessionKey;
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      if (lastUserMsg?.content) {
        try {
          const personaText = options.personaContextProvider();
          if (personaText?.trim()) {
            const previousPersonaText = personaTextBySession.get(personaKey);
            const shouldInjectPersona =
              autoRecallFrequency === 'every' ||
              !personaInjectedSessions.has(personaKey) ||
              previousPersonaText !== personaText;

            if (shouldInjectPersona) {
              options?.logger?.debug(
                { personaText: personaText.slice(0, 120) },
                'Persona injected into context',
              );
              const idx = result.lastIndexOf(lastUserMsg);
              const blocks = ensureContentBlocks(lastUserMsg.content);
              const personaBlock = {
                type: 'text' as const,
                text: `<persona>\n${neutralizePromptTags(personaText)}\n</persona>\n`,
              };
              const nextBlocks = [...blocks, personaBlock];
              result[idx] = { ...lastUserMsg, content: nextBlocks };
              personaInjectedSessions.set(personaKey, true);
              personaTextBySession.set(personaKey, personaText);
            }
          }
        } catch {
          options?.logger?.debug('Persona injection failed — continuing without persona context');
        }
      }
    }

    // ── v9: Auto context compression (pi-style) ──
    // Trigger: (prefix + estimatedTokens) > contextWindow - reserveTokens.
    // Keeps keepRecentTokens worth of recent messages, compresses older ones.
    // Hard truncation below is the safety net.
    const compressCfg = options?.compressConfig;
    if (compressCfg?.config.enabled && sessionKey) {
      // The prefix (system prompt + tool schemas) is part of the request the
      // provider sizes, but is not part of `result` — leaving it out made the
      // trigger fire thousands of tokens late on tool-heavy profiles.
      const estimatedTokens = estimateTokensCached(result) + prefixTokens;
      const messageWindow = Math.max(1000, compressCfg.contextWindow - prefixTokens);
      const defaultThreshold = messageWindow - compressCfg.config.reserveTokens;
      const triggerThreshold =
        cacheProfile === 'deepseek' ? Math.min(defaultThreshold, 12000) : defaultThreshold;

      if (estimatedTokens > triggerThreshold) {
        // ── Kernel M2 `context.forget`: judged eviction of stale tool results ──
        // Runs at the SAME watermark as compression; evicted results are
        // replaced by a one-line tombstone in the OUTBOUND copy only (`result`
        // — the live transcript/session storage keeps the full text). If the
        // eviction alone brings the request below the trigger, the whole LLM
        // compression attempt is skipped.
        let forgetCompleted = false;
        if (options.judgeGet?.()) {
          try {
            const lastIndex = (() => {
              for (let i = result.length - 1; i >= 0; i--) {
                if ((result[i] as any)?.role === 'user') return i;
              }
              return result.length;
            })();
            const forgetResult = await judgeContextForget({
              messages: result as any,
              lastUserIndex: lastIndex,
              sessionKey,
              taskHint: getTurnTaskHint(sessionKey),
            });
            if (forgetResult.entries && forgetResult.entries.length > 0) {
              for (const entry of forgetResult.entries) {
                const message = result[entry.index] as any;
                if (message?.role === 'toolResult') {
                  result[entry.index] = {
                    ...message,
                    content: [{ type: 'text', text: entry.tombstone }],
                  };
                }
              }
              forgetCompleted = true;
              options?.logger?.info(
                { sessionKey, evicted: forgetResult.entries.length },
                'Context forget evicted stale tool results',
              );
            }
          } catch (err) {
            options?.logger?.warn(
              { sessionKey, err: err instanceof Error ? err.message : String(err) },
              'Context forget failed — keeping all tool results',
            );
          }
        }

        const tokensAfterForget = estimateTokensCached(result) + prefixTokens;
        if (forgetCompleted && tokensAfterForget <= triggerThreshold) {
          // Judged eviction alone cleared the watermark — skip the LLM summary.
          options?.logger?.info(
            { sessionKey, tokensBefore: estimatedTokens, tokensAfter: tokensAfterForget },
            'Context forget cleared the watermark — compression skipped',
          );
        } else {
          try {
            const previousSummary = lastCompressionSummaryBySession.get(nsSessionKey);
            const compressResult = await compressContext({
              messages: result as any,
              contextWindow: messageWindow,
              settings: {
                reserveTokens: compressCfg.config.reserveTokens,
                keepRecentTokens:
                  cacheProfile === 'deepseek'
                    ? Math.min(compressCfg.config.keepRecentTokens, 4000)
                    : compressCfg.config.keepRecentTokens,
              },
              sessionKey,
              mainModelRef: compressCfg.mainModelRef,
              globalFallbackRefs: compressCfg.globalFallbackRefs,
              compressModelRef: compressCfg.compressModelRef,
              compressFallbackRefs: compressCfg.compressFallbackRefs,
              apiKeys: compressCfg.apiKeys,
              baseUrls: compressCfg.baseUrls,
              baseUrl: compressCfg.baseUrl,
              previousSummary,
              // Kernel M2 `context.compact`: judged pre-compaction prune — only
              // with `features.compact: 'judged'` (the point mode is gated inside
              // the hook; default 'llm' passes undefined → current behavior).
              judgedPrune:
                options.judgeGet?.()?.section.features.compact === 'judged'
                  ? (oldMessages: any[]) =>
                      judgeContextCompactPrune({
                        oldMessages,
                        messageCount: result.length,
                        taskHint: getTurnTaskHint(sessionKey),
                        sessionId: sessionKey,
                      }).then((r) =>
                        r.keptMessages ? { keptMessages: r.keptMessages } : undefined,
                      )
                  : undefined,
              logger: options?.logger,
            });

            if (compressResult.pruned && compressResult.prunedMessages) {
              // Judged prune alone cleared the watermark — splice the PRUNED
              // messages in (no summary message exists for this pass). Identity
              // filtering against the transcript keeps the same message objects.
              const pruned = compressResult.prunedMessages;
              const tokensBefore = estimateTokensCached(result);
              result.length = 0;
              result.push(...pruned);
              const transcriptKept = messages.filter((m: any) => pruned.indexOf(m) !== -1);
              messages.length = 0;
              messages.push(...transcriptKept);
              options?.onCompressed?.(messages);
              lastCompressedIndexBySession.set(nsSessionKey, result.length);
              options?.logger?.info(
                {
                  sessionKey,
                  newCount: result.length,
                  tokensBefore,
                  tokensAfter: estimateTokensCached(result),
                },
                'Context compacted by judged prune (no summary)',
              );
            } else if (compressResult.summaryMessage && compressResult.compressedIndex > 0) {
              const recentMessages = result.slice(compressResult.compressedIndex);
              const originalCount = result.length;
              const tokensBefore = estimateTokensCached(result);
              result.length = 0;
              result.push(compressResult.summaryMessage, ...recentMessages);
              // Compact the caller's transcript in place (uses the pre-injection
              // messages so injected context blocks — date, memories, canvas —
              // never leak into the transcript) and notify the owner via
              // onCompressed so agent state is updated too. Otherwise every LLM
              // call in this turn re-compresses the same old messages and
              // persistence keeps the full history.
              const transcriptRecent = messages.slice(compressResult.compressedIndex);
              messages.length = 0;
              messages.push(compressResult.summaryMessage, ...transcriptRecent);
              options?.onCompressed?.(messages);
              lastCompressedIndexBySession.set(nsSessionKey, result.length);
              if (compressResult.summary) {
                lastCompressionSummaryBySession.set(nsSessionKey, compressResult.summary);
              }
              options?.logger?.info(
                {
                  sessionKey,
                  originalCount,
                  newCount: result.length,
                  compressedIndex: compressResult.compressedIndex,
                  tokensBefore,
                  tokensAfter: estimateTokensCached(result),
                },
                'Context compressed',
              );
            }
          } catch (err) {
            options?.logger?.warn(
              {
                sessionKey,
                err: err instanceof Error ? err.message : String(err),
              },
              'Context compression failed, falling back to hard truncation',
            );
          }
        } // end else (judged forget did not clear the watermark)
      }
    }

    // Keep only last N messages (preserve system prompt if present).
    // Must also preserve tool_calls ↔ toolResult pairing: DeepSeek and other
    // strict providers reject orphaned tool results.
    if (result.length > maxMessages) {
      const systemMsg = result[0]?.role === 'system' ? result[0] : null;
      const nonSystem = systemMsg ? result.slice(1) : result;
      const trimStart = nonSystem.length - maxMessages;
      let trimmed = nonSystem.slice(-maxMessages);

      // Drop leading orphaned tool results (their tool_calls was trimmed off)
      while (trimmed.length > 0 && trimmed[0]?.role === 'toolResult') {
        trimmed = trimmed.slice(1);
      }
      // Drop trailing orphaned tool_calls (their tool results were trimmed)
      while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.role === 'assistant') {
        const lastContent = trimmed[trimmed.length - 1]!.content;
        if (!Array.isArray(lastContent) || !lastContent.some((b) => b.type === 'toolCall')) break;
        trimmed = trimmed.slice(0, -1);
      }

      // Inject offload index for tool results that were trimmed away
      const offloadCfg = options?.offloadConfig;
      if (offloadCfg?.enabled && options?.offloadStore && sessionKey && trimStart > 0) {
        try {
          const records = options.offloadStore.getSessionRecords(sessionKey);
          if (records.length > 0) {
            const sessionDir = options.offloadStore.getSessionDirPath(sessionKey);
            const preserveCount = offloadCfg.preserveInMessages ?? 0;
            const injectableRecords =
              preserveCount > 0
                ? records.slice(0, Math.max(0, records.length - preserveCount))
                : records;
            const maxRefs = Math.max(1, offloadCfg.maxRefsInContext);
            const trimmedRecords = injectableRecords
              .filter((r) => r.seq <= trimStart)
              .slice(-maxRefs);
            const lines = trimmedRecords.map((r) => {
              const icon = r.status === 'error' ? '❌' : '✅';
              return `${icon} [${r.nodeId}] ${r.summary || r.toolName} | ${sessionDir}/${r.refPath}`;
            });
            if (lines.length > 0) {
              const hint = `\n\n<archived_tool_results>\n[已归档的早期工具结果 (使用 file_read 恢复)]\n${neutralizePromptTags(lines.join('\n'))}\n</archived_tool_results>`;
              const firstUser = trimmed.find((m: any) => m.role === 'user');
              if (firstUser) {
                const idx = trimmed.indexOf(firstUser);
                const blocks = ensureContentBlocks(firstUser.content);
                trimmed[idx] = {
                  ...firstUser,
                  content: [{ type: 'text', text: hint, injected: true } as any, ...blocks],
                };
              }
            }
          }
        } catch {
          options?.logger?.debug(
            'Offload index injection failed — continuing without offload hints',
          );
        }
      }

      return systemMsg ? [systemMsg, ...trimmed] : trimmed;
    }

    return result;
  };
}
