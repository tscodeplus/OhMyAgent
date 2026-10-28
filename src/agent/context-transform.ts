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
 * Both are budgeted (together the plan's ≤400 G4 limit, configurable through
 * `injectionBudget`) and both are no-ops when their provider throws — retrieval
 * must never be a reason a turn fails.
 *
 * Since plan §6 K5 item 4 the ≤400 tokens are ONE pool, not two independent
 * budgets appended in a fixed order: both providers are consulted, then a single
 * ranking pass (`allocateInjectionCandidates`) decides which entries fit. The
 * blocks themselves stay separate and keep their labels — they are what the
 * model reads — but a weak knowledge title no longer takes tokens a stronger
 * excerpt needed. Cross-lane comparability is the whole difficulty: per-lane
 * scores are not numbers on one scale (`KnowledgeService`'s search contract only
 * promises scores comparable within one result set), so each in-tree provider
 * normalises its relevance onto the same BM25 curve before reporting it, and a
 * provider that reports nothing is ordered by position.
 */

import type { MemoryRetriever, RetrievedMemory } from '../memory/memory-retriever.js';
import { memoryObservability } from '../memory/observability.js';
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
/**
 * What this session's last prompt build injected, per lane, for the reference
 * check (plan §6 K0 item 3, ②「是否被引用」).
 *
 * The transform's per-invocation state dies before the model's next tool call
 * runs, so the offer has to be published somewhere the caller can read it: one
 * entry per build, replaced on the next build, with a short TTL and
 * consume-on-hit (an id is credited to the build that offered it, once, and a
 * stale offer is dropped rather than handed to a later turn).
 *
 * Bounded four ways, because this lives as long as the process does: one LRU
 * entry per session (`max`), a 15-minute TTL, each lane's array capped by that
 * lane's item cap at build time, and at most two ≤60-character evidence
 * fragments per item (see `referenceFragments`) — ~1 KB per session, never a
 * copy of the injected text.
 */
interface InjectedOffer {
  memories: InjectionOfferItem[];
  messages: InjectionOfferItem[];
  knowledge: InjectionOfferItem[];
}
const injectedOfferBySession = new LRUCache<string, InjectedOffer>({
  max: 2000,
  ttl: 15 * 60_000,
});
/**
 * The scope key each session's last build published under.
 *
 * The turn-end reader (`readInjectionReferences`) is called from agent-service,
 * which knows the session but not the effective agent id — the factory derives
 * that from the resolved agent config, and `options.agentId` is unset on the
 * ordinary IM path. Rather than guess, the build records the key it used and the
 * reader resolves through it. Same bounds as the registry it points into.
 */
const publishedInjectionScope = new LRUCache<string, string>({
  max: 2000,
  ttl: 15 * 60_000,
});

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

// ── Reference tracking: what "an injected item was used" means ──────────────

/**
 * One injected item as the reference check sees it: the id the telemetry names,
 * and the literal fragments of the text that reached the prompt.
 *
 * Fragments are extracted at build time from the item's own text (memory
 * content, excerpt) rather than from the rendered block, so the block's headers
 * — date, channel, `user:` — never become evidence. The knowledge lane carries
 * none: a page is matched by slug, which is exact and needs no text.
 */
interface InjectionOfferItem {
  id: string;
  fragments: string[];
}

/**
 * Minimum length of a fragment that may be called evidence of use, measured
 * after normalisation.
 *
 * Below this a match is a coincidence: "用户", "the user", "ok", "TypeScript"
 * all appear in answers for reasons unrelated to what was injected. Every
 * fragment that clears the floor is also a whole clause (the extractor splits on
 * punctuation), which is what makes a literal substring match evidence rather
 * than a guess.
 */
const REFERENCE_FRAGMENT_MIN_CHARS = 6;

/** Longest fragment kept: an answer quoting a phrase quotes its head, not 200 characters of it. */
const REFERENCE_FRAGMENT_MAX_CHARS = 60;

/** Fragments kept per item, longest first. */
const REFERENCE_FRAGMENTS_PER_ITEM = 2;

/** Offers examined per lane at turn end — a build caps at 5/2/2, this is the belt. */
const REFERENCE_MAX_ITEMS_PER_LANE = 8;

/**
 * Answer characters scanned at turn end.
 *
 * A hit test does not need the whole reply: a fragment quoted 20 KB into an
 * answer is worth less than the cost of scanning every enormous answer the
 * gateway ever produces, and the cap keeps the scan O(1) in reply length.
 */
const REFERENCE_MAX_ANSWER_CHARS = 20_000;

/**
 * `toolName` recorded when the answer text, not a tool call, proved the
 * reference. The payload's field names the consumer that acted on the offer;
 * the memory and message lanes have no tool to name, so it names the consumer.
 */
const ANSWER_REFERENCE_CONSUMER = 'assistant_message';

/**
 * Normalise text for the reference check — case-folded, inner whitespace
 * collapsed, trimmed.
 *
 * The fragment extracted at build time and the answer scanned at turn end go
 * through this same function, for the reason the id matcher trims both sides
 * before comparing: two normalisations would mean a fragment that exists
 * verbatim in the answer is not found, and the miss would be invisible.
 */
function normalizeReferenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The fragments of `text` that could prove it was read.
 *
 * Clauses, not words: the text is split on sentence/clause punctuation and
 * newlines and only pieces long enough to be distinctive survive, longest
 * first. A word ("Excel") is a topic the memory and the answer can share with
 * no causal link; "批量替换用的是 python" is a statement that can only come from
 * the injected text. The rule is therefore deliberately lossy — a memory the
 * answer paraphrases is *not* counted — because a false "it was used" makes the
 * metric a lie, while a missing datapoint only costs a datapoint.
 *
 * Known residual risk: punctuation and spacing must match, so an answer that
 * re-punctuates a quoted clause is missed; and a clause of ≥6 characters that a
 * task answer cannot avoid (a product name, a file path) can match without the
 * model having read the injection.
 */
function referenceFragments(text: string | undefined): string[] {
  if (!text) return [];
  return normalizeReferenceText(text)
    .split(/[。；;，,、!！?？.:：\n\r]+/)
    .map((fragment) => fragment.trim().slice(0, REFERENCE_FRAGMENT_MAX_CHARS))
    .filter((fragment) => isStatementFragment(fragment))
    .sort((a, b) => b.length - a.length)
    .slice(0, REFERENCE_FRAGMENTS_PER_ITEM);
}

/**
 * Is this clause more than a term?
 *
 * Both tests are about the same thing from two directions: a fragment has to be
 * a statement. Unspaced scripts say that with length alone ("不要长篇大论" is
 * six characters of clause), while a space-separated script needs at least two
 * words in it — a lone `TypeScript` is a topic the answer may name for its own
 * reasons, and crediting a memory for it would be a false positive.
 */
function isStatementFragment(fragment: string): boolean {
  if (fragment.length < REFERENCE_FRAGMENT_MIN_CHARS) return false;
  if (/\p{Script=Han}/u.test(fragment)) return (fragment.match(/\p{L}/gu) ?? []).length >= 3;
  return fragment.split(' ').filter((word) => word !== '').length >= 2;
}
function isMemoryRelevantRequest(text: string): boolean {
  return MEMORY_RELEVANT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The per-session cache namespace, used by the module-level caches above and by
 * `recordInjectionReference` — both sides of the reference check must derive the
 * same key or the offer is never matched.
 */
function injectionScopeKey(agentId: string | undefined, sessionKey: string | undefined): string {
  return `${agentId ?? '*'}:${sessionKey || 'default'}`;
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

/**
 * The memories that actually reach the block, best-first.
 *
 * Split from the formatting because the per-turn injection event records which
 * memories were injected (plan §6 K0 item 3), and an id is not recoverable from
 * a formatted line.
 */
function selectMemoryEntries(memories: RetrievedMemory[], query: string): RetrievedMemory[] {
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
      .slice(0, 5)
  );
}

function buildMemoryLines(memories: RetrievedMemory[]): string[] {
  return memories.map((m) => neutralizePromptTags(`- ${m.content}`));
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
  /**
   * Relevance in (0, 1], best first, when the caller can report one (the real
   * provider passes `ConversationSearchHit.score`, already normalised BM25).
   *
   * Optional because a provider that only knows an order is still useful: the
   * transform then ranks the entry by its position in the returned list.
   */
  score?: number;
  /**
   * `messages.id` of the hit this excerpt came from, when the caller knows it.
   *
   * Optional and only ever recorded — no caller renders it, but without it the
   * per-turn injection event can say "two excerpts" and not which two, which is
   * exactly the comparison the injection telemetry exists for.
   */
  messageId?: string;
}

/** One curated page offered as a title, per plan §6 K2-6. */
export interface KnowledgeContextItem {
  /** `page_type/slug`, e.g. `topic/excel-etl` or bare `excel-etl` as stored. */
  slug: string;
  title: string;
  /**
   * Relevance in (0, 1], best first, when the provider can report one.
   *
   * This is the only cross-block signal there is (plan §6 K5 item 4), so it has
   * to be on a comparable scale: raw BM25 magnitudes are not, which is why
   * `titlesForInjection` normalises onto the same curve `conversation-search`
   * uses. Omitted means "ordered, not scored", and the transform ranks such an
   * entry by its position.
   */
  score?: number;
}

// ── Per-turn injection budget (plan §4 principle 5 / §6 G4, §6 K5 item 4) ───
// The whole automatic injection may add ≤400 tokens per turn. That was two
// independent budgets (250 episodic + 150 knowledge) appended in a fixed order,
// which let a weak knowledge title spend tokens a stronger excerpt needed; the
// 400 is now one pool allocated by one ranking pass, and the lanes' item and
// line caps are what bound each block. The numbers stay configuration
// (`TransformOptions.injectionBudget`) — the constants below are the defaults.
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

/**
 * Token budgets for the two injected blocks, as configuration rather than
 * constants: `totalTokens` is the plan's ≤400 G4 ceiling for both blocks
 * together, and the per-lane ceilings are optional — left unset, a lane may use
 * the whole pool, which is the point of K5-4 (the pool follows relevance, not a
 * fixed 250/150 split). Set a lane ceiling to reserve the other lane's share.
 */
export interface InjectionBudgetConfig {
  /** Ceiling for `<recent_conversation>` + `<knowledge_available>`, in tokens. */
  totalTokens?: number;
  /** Optional ceiling for the episodic block alone. */
  episodicTokens?: number;
  /** Optional ceiling for the knowledge block alone. */
  knowledgeTokens?: number;
  /** Episodic entries per turn (the provider may return more; the tail is cut). */
  episodicMaxItems?: number;
  /** Knowledge titles per turn. */
  knowledgeMaxItems?: number;
}

interface ResolvedInjectionBudget {
  totalTokens: number;
  episodicTokens?: number;
  knowledgeTokens?: number;
  episodicMaxItems: number;
  knowledgeMaxItems: number;
}

function resolveInjectionBudget(config?: InjectionBudgetConfig): ResolvedInjectionBudget {
  return {
    totalTokens: config?.totalTokens ?? EPISODIC_BLOCK_TOKEN_BUDGET + KNOWLEDGE_BLOCK_TOKEN_BUDGET,
    episodicTokens: config?.episodicTokens,
    knowledgeTokens: config?.knowledgeTokens,
    episodicMaxItems: config?.episodicMaxItems ?? EPISODIC_MAX_ITEMS,
    knowledgeMaxItems: config?.knowledgeMaxItems ?? KNOWLEDGE_MAX_ITEMS,
  };
}

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
   * Token budgets for the two injected blocks. Defaults to 400 tokens shared by
   * both, with each lane bounded by its item and line caps.
   */
  injectionBudget?: InjectionBudgetConfig;
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
 * Render a tagged block from entries, or `null` for an empty lane.
 *
 * Budgets are not enforced here: `allocateInjectionCandidates` owns that, because
 * the two blocks now share one pool and a block is only cheap to rebuild while
 * deciding what fits. An empty tag is never rendered — it is pure cost.
 */
function renderInjectedBlock(
  tag: 'recent_conversation' | 'knowledge_available',
  entries: string[],
): string | null {
  if (entries.length === 0) return null;
  return `\n\n<${tag}>\n${entries.join('\n')}\n</${tag}>`;
}

/** The two lanes that own a labelled block; memories share `<memory_context>`. */
type InjectedBlockLane = 'messages' | 'knowledge';

/** One entry competing for the shared injection budget (plan §6 K5 item 4). */
interface InjectionCandidate {
  lane: InjectedBlockLane;
  /** Position in the provider's output — the fallback order when no score. */
  rank: number;
  /** Provider-reported relevance in (0, 1], when it reported one. */
  score?: number;
  /** Rendered entry, as it appears inside the block. */
  text: string;
  /** Ids this entry contributes to its lane's telemetry row (ids only). */
  ids: string[];
  /**
   * The item's own text (excerpt), from which the reference check extracts its
   * evidence fragments. Never rendered: the block text above carries headers
   * that must not become evidence.
   */
  referenceText?: string;
}

/**
 * Allocation weight for one candidate: bounded, and comparable across lanes.
 *
 * A provider that reports `score` is taken at its word — the value is relevance
 * in (0, 1], which both in-tree providers normalise raw BM25 into, so the two
 * lanes land on one curve instead of two magnitudes. A provider that reports
 * nothing is ordered by position, the only information it gave: `1/(rank+1)`
 * puts its best hit at parity with the other lane's best and its second entry at
 * half, which is the honest reading of "the caller did not say how much better".
 * A reported `0` is a real value (an expanded neighbour is context, not a hit),
 * never "unscored".
 */
function candidateWeight(candidate: InjectionCandidate): number {
  const score = candidate.score;
  if (typeof score === 'number' && Number.isFinite(score) && score >= 0) {
    return Math.min(score, 1);
  }
  return 1 / (candidate.rank + 1);
}

function compareInjectionCandidates(a: InjectionCandidate, b: InjectionCandidate): number {
  const byWeight = candidateWeight(b) - candidateWeight(a);
  if (byWeight !== 0) return byWeight;
  // Ties keep the pre-K5-4 order: the episodic block is appended first.
  if (a.lane !== b.lane) return a.lane === 'messages' ? -1 : 1;
  return a.rank - b.rank;
}

/**
 * One ranking pass over both blocks: decide what fits the shared budget.
 *
 * Candidates are admitted best-weight first, and each admission is checked
 * against the lane's optional ceiling and the pool as a whole by re-rendering
 * both blocks — an entry that does not fit is dropped whole, never truncated
 * mid-line, and a lane that fits nothing renders no block at all. A rejected
 * candidate does not stop the pass: a cheaper entry further down can still fit,
 * and keeping the weaker of two excerpts while dropping the stronger is exactly
 * the outcome the pre-K5-4 tail-drop produced anyway.
 *
 * Work is bounded by the item caps (2 + 2 by default), so the re-render per
 * candidate is at most a handful of short strings — no allocation loop can grow
 * with query size.
 */
function allocateInjectionCandidates(
  candidates: InjectionCandidate[],
  budget: ResolvedInjectionBudget,
): {
  kept: Record<InjectedBlockLane, InjectionCandidate[]>;
  blocks: Record<InjectedBlockLane, string | null>;
} {
  const kept: Record<InjectedBlockLane, InjectionCandidate[]> = { messages: [], knowledge: [] };
  const blocks: Record<InjectedBlockLane, string | null> = { messages: null, knowledge: null };
  const laneCeiling: Record<InjectedBlockLane, number> = {
    messages: budget.episodicTokens ?? budget.totalTokens,
    knowledge: budget.knowledgeTokens ?? budget.totalTokens,
  };

  for (const candidate of [...candidates].sort(compareInjectionCandidates)) {
    const lane = candidate.lane;
    const other: InjectedBlockLane = lane === 'messages' ? 'knowledge' : 'messages';
    // Rebuilt from scratch per candidate (≤4 candidates × 2 short blocks): the
    // rendered block is what the token estimate is measured on, so deciding on
    // anything else would be measuring a different object than the one injected.
    const laneEntries = [...kept[lane], candidate]
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.text);
    const otherEntries = [...kept[other]]
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.text);
    const laneBlock = renderInjectedBlock(blockTag(lane), laneEntries);
    const otherBlock = renderInjectedBlock(blockTag(other), otherEntries);
    const laneTokens = laneBlock ? estimateTokensForText(laneBlock) : 0;
    const otherTokens = otherBlock ? estimateTokensForText(otherBlock) : 0;
    if (laneTokens > laneCeiling[lane]) continue;
    if (laneTokens + otherTokens > budget.totalTokens) continue;

    kept[lane].push(candidate);
    blocks[lane] = laneBlock;
    blocks[other] = otherBlock;
  }

  return { kept, blocks };
}

function blockTag(lane: InjectedBlockLane): 'recent_conversation' | 'knowledge_available' {
  return lane === 'messages' ? 'recent_conversation' : 'knowledge_available';
}

// ── Per-turn injection telemetry (plan §6 K0 item 3) ────────────────────────
// The transform is the only place that knows what automatic injection cost a
// turn, and it is the only place that can record it: the ids are chosen here
// and discarded here. One `memory.injection` row is written per prompt build
// (a tool-using turn builds several prompts, each a distinct injection), and
// only when a block was actually appended — a turn with nothing to inject
// stays silent, because one row per empty turn is noise on a phone.

/** The three lanes whose blocks are counted; persona/date/canvas are not. */
type InjectionLane = 'memories' | 'messages' | 'knowledge';

interface TurnInjection {
  /** What this build offered, per lane, as the reference check sees it. */
  offer: Record<InjectionLane, InjectionOfferItem[]>;
  /** Items rendered into the block; `offer` is shorter when an item carries no id. */
  itemCounts: Record<InjectionLane, number>;
  /** Estimated tokens per lane, measured on the block as built. */
  tokens: Record<InjectionLane, number>;
  /** Provider + block-build time per lane, in milliseconds. */
  latencyMs: Record<InjectionLane, number>;
  /** Blocks actually appended; 0 means the turn injected nothing. */
  blocks: number;
  /** A lane's provider threw and its block was skipped. */
  degraded: boolean;
}

function newTurnInjection(): TurnInjection {
  return {
    offer: { memories: [], messages: [], knowledge: [] },
    itemCounts: { memories: 0, messages: 0, knowledge: 0 },
    tokens: { memories: 0, messages: 0, knowledge: 0 },
    latencyMs: { memories: 0, messages: 0, knowledge: 0 },
    blocks: 0,
    degraded: false,
  };
}

function recordInjectedLane(
  injection: TurnInjection,
  lane: InjectionLane,
  injected: {
    offer: InjectionOfferItem[];
    itemCount: number;
    block: string;
    latencyMs: number;
  },
): void {
  injection.offer[lane] = injected.offer;
  injection.itemCounts[lane] = injected.itemCount;
  injection.tokens[lane] = Math.ceil(estimateTokensForText(injected.block));
  injection.latencyMs[lane] = Math.round(injected.latencyMs);
  injection.blocks += 1;
}

/**
 * Write the turn's injection facts as one `memory.injection` observation row.
 *
 * `status: 'degraded'` means a lane's provider threw and its block was skipped
 * — the turn completed, but an incomplete injection is invisible to the offline
 * eval and is the one thing only this row can report.
 *
 * Also republishes the offer for `recordInjectionReference` — every lane, not
 * just knowledge — and clears it when nothing was injected: a later reader must
 * never be credited to an older prompt build's offer. The scope key the build
 * used is published per session so the turn-end reader, which does not know the
 * effective agent id, can resolve back to this entry.
 */
function reportTurnInjection(
  injection: TurnInjection,
  scopeKey: string,
  sessionKey: string | undefined,
): void {
  const offer: InjectedOffer = {
    memories: injection.offer.memories,
    messages: injection.offer.messages,
    knowledge: injection.offer.knowledge,
  };
  if (offer.memories.length + offer.messages.length + offer.knowledge.length > 0) {
    injectedOfferBySession.set(scopeKey, offer);
    publishedInjectionScope.set(sessionKey || 'default', scopeKey);
  } else {
    injectedOfferBySession.delete(scopeKey);
  }
  if (injection.blocks === 0) return;
  const totalTokens =
    injection.tokens.memories + injection.tokens.messages + injection.tokens.knowledge;
  memoryObservability.record('memory.injection', {
    memoryIds: offer.memories.map((item) => item.id),
    knowledgeSlugs: offer.knowledge.map((item) => item.id),
    messageIds: offer.messages.map((item) => item.id),
    itemCounts: {
      memories: injection.itemCounts.memories,
      messages: injection.itemCounts.messages,
      knowledge: injection.itemCounts.knowledge,
    },
    estimatedTokens: {
      memories: injection.tokens.memories,
      messages: injection.tokens.messages,
      knowledge: injection.tokens.knowledge,
      total: totalTokens,
    },
    latencyMs: {
      memories: injection.latencyMs.memories,
      messages: injection.latencyMs.messages,
      knowledge: injection.latencyMs.knowledge,
    },
    status: injection.degraded ? 'degraded' : 'ok',
  });
}

/**
 * Do two page references name the same page?
 *
 * A slug may be offered bare (`excel-etl`) and read with its type prefix
 * (`knowledge_get(ref: 'topic/excel-etl')`), or the other way round, so one is
 * the other with a page-type segment in front. That is the only equivalence:
 * `topic/x` and `entity/x` are different pages.
 */
function isSameKnowledgeSlug(offered: string, ref: string): boolean {
  if (offered === ref) return true;
  return offered.endsWith(`/${ref}`) || ref.endsWith(`/${offered}`);
}

/**
 * Record that a consumer acted on something this session's last prompt build
 * injected (plan §6 K0 item 3, ②「是否被引用」), for any of the three lanes.
 *
 * Two kinds of caller exist. A tool that reads an offer back (`knowledge_get`,
 * reported from `agent-factory`'s `afterToolCall`) names the ids it acted on and
 * passes them here. A turn-end reader (`readInjectionReferences`) has no tool to
 * quote, so it proves use from the answer text and calls the same emitter.
 * Between them all three lanes are covered: the knowledge lane by slug, the
 * memory and message lanes by literal fragment.
 *
 * Calling this with an id that was not offered — or offering the same id twice
 * in one build — records nothing.
 *
 * `refs` are the candidate references from the consumer, unparsed: matching
 * (and the page-type prefix equivalence, which only applies to slugs) belongs
 * here, next to the offer list.
 */
export function recordInjectionReference(params: {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  refs: string[];
  /** Which lane's offer these refs may match. Defaults to `knowledge`. */
  lane?: InjectionLane;
}): void {
  const lane = params.lane ?? 'knowledge';
  const scopeKey = injectionScopeKey(params.agentId, params.sessionKey);
  const offer = injectedOfferBySession.get(scopeKey);
  if (!offer) return;
  const offered = offer[lane];
  if (offered.length === 0) return;

  const referenced = new Set<string>();
  for (const ref of params.refs) {
    const trimmed = ref.trim();
    if (trimmed === '') continue;
    for (const item of offered) {
      const matches =
        lane === 'knowledge' ? isSameKnowledgeSlug(item.id, trimmed) : item.id === trimmed;
      if (matches) referenced.add(item.id);
    }
  }
  if (referenced.size === 0) return;

  recordReferencedIds(scopeKey, offer, lane, params.toolName, Array.from(referenced));
}

/**
 * Consume the referenced ids from an offer and emit the correlation row.
 *
 * Shared by both producers so "matched, consumed, recorded" cannot drift apart:
 * the tool path passes ids it matched, the turn-end path passes ids whose
 * fragments it found in the answer.
 */
function recordReferencedIds(
  scopeKey: string,
  offer: InjectedOffer,
  lane: InjectionLane,
  toolName: string,
  ids: string[],
): void {
  const referenced = new Set(ids);
  const offered = offer[lane];

  // Consume: one reference per offer, so reading the same page twice in a turn
  // is one reference, and an id offered again next build can be credited again.
  injectedOfferBySession.set(scopeKey, {
    ...offer,
    [lane]: offered.filter((item) => !referenced.has(item.id)),
  });
  const matched = Array.from(referenced);
  memoryObservability.record('memory.injection.referenced', {
    lane,
    toolName,
    knowledgeSlugs: lane === 'knowledge' ? matched : [],
    memoryIds: lane === 'memories' ? matched : [],
    messageIds: lane === 'messages' ? matched : [],
  });
}

/**
 * The offer a turn-end reader should look at: the one this session's last build
 * published.
 *
 * The registry key is `agentId:sessionKey` so two agents sharing a session never
 * read each other's injections, but the caller with an answer in hand
 * (agent-service) does not know the agent id the transform was built with — the
 * factory derives it from the resolved agent config, and `options.agentId` is
 * unset on the ordinary IM path, where the key reads `default:<session>`.
 * Guessing `*:<session>` there would silently never match, so the published key
 * is the resolution and the caller's own key is only the fallback.
 */
function resolveOfferScope(agentId: string | undefined, sessionKey: string | undefined): string {
  return (
    publishedInjectionScope.get(sessionKey || 'default') ?? injectionScopeKey(agentId, sessionKey)
  );
}

/**
 * Turn-end reader: was an injected memory or excerpt actually used (plan §6 K0
 * item 3, ②「是否被引用」)?
 *
 * The transform returns before the answer exists, so the two lanes that have no
 * tool to read them back (`knowledge_get` covers the third) can only be checked
 * after generation. The evidence is literal: an item counts when a fragment of
 * the text that was injected appears in the answer, matched through the same
 * normalisation `referenceFragments` applied at build time. Nothing else — not
 * a topic word, not a paraphrase — is evidence, and the rule is intentionally
 * one-sided: a false "it was used" makes the metric a lie, a miss only costs a
 * datapoint.
 *
 * Matching consumes the offer exactly as the tool path does, so one answer
 * cannot credit the same memory twice, and the registry's TTL bounds how long
 * anything here can still be attributed to a build.
 *
 * Cost is bounded by construction: ≤8 offers per lane, ≤2 fragments of ≤60
 * characters each, one scan of ≤20 KB of answer, once per assistant turn, and
 * no allocation proportional to session history. Callers may therefore run it
 * inline — but it is still a metric, so agent-service calls it inside a guard:
 * a failed metric must not fail a turn.
 */
export function readInjectionReferences(params: {
  agentId?: string;
  sessionKey?: string;
  answerText: string;
}): void {
  const answer = params.answerText;
  if (!answer) return;
  const scopeKey = resolveOfferScope(params.agentId, params.sessionKey);
  const offer = injectedOfferBySession.get(scopeKey);
  if (!offer) return;
  const haystack = normalizeReferenceText(answer.slice(0, REFERENCE_MAX_ANSWER_CHARS));
  if (haystack === '') return;

  // The knowledge lane is deliberately absent: its reference is a slug the model
  // asked for by name (`knowledge_get`), which is proof, not a likeness test.
  for (const lane of ['memories', 'messages'] as const) {
    const matched = offer[lane]
      .slice(0, REFERENCE_MAX_ITEMS_PER_LANE)
      .filter((item) =>
        item.fragments.some((fragment) => fragment !== '' && haystack.includes(fragment)),
      )
      .map((item) => item.id);
    if (matched.length === 0) continue;
    recordReferencedIds(scopeKey, offer, lane, ANSWER_REFERENCE_CONSUMER, matched);
  }
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
  const nsSessionKey = injectionScopeKey(agentId, sessionKey);
  const snapshotMode =
    options?.snapshotMode ?? (autoRecallFrequency === 'every' ? 'every' : 'first');

  // Capture language for per-message date injection (per-instance config,
  // NOT session state — see module-level caches above for the hoisted ones)
  const dateLanguage = options?.dateLanguage;
  const cacheProfile = options?.cacheProfile ?? 'default';
  const prefixTokens = options?.staticContextTokens ?? 0;
  const injectionBudget = resolveInjectionBudget(options?.injectionBudget);
  const dateGranularity = 'day';

  return async (messages: any[], _signal?: AbortSignal): Promise<any[]> => {
    const result = [...messages];
    // Injection telemetry for this prompt build (plan §6 K0 item 3), emitted
    // once at the single exit below.
    const injection = newTurnInjection();

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
          const laneStarted = performance.now();
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
              const memoryEntries = selectMemoryEntries(memories, query);
              const memoryLines = buildMemoryLines(memoryEntries);
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
                  recordInjectedLane(injection, 'memories', {
                    offer: memoryEntries.map((m) => ({
                      id: m.id,
                      fragments: referenceFragments(m.content),
                    })),
                    itemCount: memoryEntries.length,
                    block: memoryHint,
                    latencyMs: performance.now() - laneStarted,
                  });
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
            injection.degraded = true;
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
            const laneStarted = performance.now();
            try {
              const memories = await memoryRetriever.retrieve({
                query,
                topK: cacheProfile === 'deepseek' ? 8 : 5,
                scope: 'user', // limit to user-scoped memories
              });

              if (memories.length > 0) {
                const memoryEntries = selectMemoryEntries(memories, query);
                const memoryLines = buildMemoryLines(memoryEntries);
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
                    recordInjectedLane(injection, 'memories', {
                      offer: memoryEntries.map((m) => ({
                        id: m.id,
                        fragments: referenceFragments(m.content),
                      })),
                      itemCount: memoryEntries.length,
                      block: memoryHint,
                      latencyMs: performance.now() - laneStarted,
                    });
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
              injection.degraded = true;
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

    // ── K1-4 + K2-6 + K5-4: the two labelled blocks, one shared budget ──
    // Both providers are consulted first, then ONE ranking pass decides what
    // fits the plan's ≤400-token budget (K5-4): the blocks keep their labels and
    // their order in the message — the labels are what the model reads — but a
    // weak knowledge title can no longer spend budget a stronger excerpt needed.
    // Each lane keeps its own failure mode (log + skip, the turn always
    // completes) and its own telemetry fields.
    //
    // The episodic lane is still gated on a recall-shaped turn: "上次那个方案叫什么"
    // needs the original wording, while "写一个排序函数" must not pay for it.
    {
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      const query = lastUserMsg?.content ? getUserQueryText(lastUserMsg.content) : '';
      const candidates: InjectionCandidate[] = [];
      const laneLatencyMs: Record<InjectedBlockLane, number> = { messages: 0, knowledge: 0 };

      if (
        options?.episodicContextProvider &&
        query.trim().length >= 5 &&
        isEpisodicRelevantRequest(query)
      ) {
        const laneStarted = performance.now();
        try {
          const items = options.episodicContextProvider(query) ?? [];
          items
            .filter((item) => typeof item?.excerpt === 'string' && item.excerpt.trim() !== '')
            .slice(0, injectionBudget.episodicMaxItems)
            .forEach((item, rank) => {
              candidates.push({
                lane: 'messages',
                rank,
                score: item.score,
                text: formatEpisodicEntry(item),
                ids: item.messageId ? [item.messageId] : [],
                // The excerpt, not the rendered line: the date/channel/speaker
                // header is not something the model can quote back.
                referenceText: item.excerpt,
              });
            });
        } catch {
          injection.degraded = true;
          options?.logger?.debug('Episodic context injection failed — continuing without it');
        }
        laneLatencyMs.messages = performance.now() - laneStarted;
      }

      // Titles and slugs only: the body is a `knowledge_get` call away, so this
      // block exists to say "a page about this exists" without pre-empting the
      // tool. `titlesForInjection` already applies the relevance floor, so an
      // unfocused query yields no entries and therefore no block.
      if (options?.knowledgeContextProvider && query.trim() !== '') {
        const laneStarted = performance.now();
        try {
          const items = options.knowledgeContextProvider(query) ?? [];
          items
            .filter((item) => typeof item?.slug === 'string' && item.slug.trim() !== '')
            .slice(0, injectionBudget.knowledgeMaxItems)
            .forEach((item, rank) => {
              const title = flattenInjectedText(item.title ?? '');
              const line = title ? `${item.slug.trim()} — ${title}` : item.slug.trim();
              candidates.push({
                lane: 'knowledge',
                rank,
                score: item.score,
                text: neutralizePromptTags(truncate(line, KNOWLEDGE_LINE_MAX_CHARS)),
                ids: [item.slug.trim()],
              });
            });
        } catch {
          injection.degraded = true;
          options?.logger?.debug('Knowledge title injection failed — continuing without it');
        }
        laneLatencyMs.knowledge = performance.now() - laneStarted;
      }

      if (lastUserMsg?.content && candidates.length > 0) {
        const allocation = allocateInjectionCandidates(candidates, injectionBudget);
        const appendedBlocks: any[] = [];
        for (const lane of ['messages', 'knowledge'] as const) {
          const block = allocation.blocks[lane];
          if (!block) continue;
          appendedBlocks.push({ type: 'text', text: block, injected: true });
          // Rendered order (rank), not admission order: the block is what the
          // model reads, and the ids must describe that block.
          const kept = [...allocation.kept[lane]].sort((a, b) => a.rank - b.rank);
          recordInjectedLane(injection, lane, {
            // One offer item per id: the reference check names what was
            // injected, and an entry with no id cannot be named.
            offer: kept.flatMap((entry) =>
              entry.ids.map((id) => ({
                id,
                fragments: referenceFragments(entry.referenceText),
              })),
            ),
            itemCount: kept.length,
            block,
            latencyMs: laneLatencyMs[lane],
          });
          options?.logger?.debug(
            { count: kept.length, tokens: Math.ceil(estimateTokensForText(block)) },
            lane === 'messages'
              ? 'Episodic conversation injected into context'
              : 'Knowledge titles injected into context',
          );
        }
        if (appendedBlocks.length > 0) {
          const idx = result.lastIndexOf(lastUserMsg);
          const blocks = ensureContentBlocks(lastUserMsg.content);
          result[idx] = { ...lastUserMsg, content: [...blocks, ...appendedBlocks] };
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
    let outbound = result;
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

      outbound = systemMsg ? [systemMsg, ...trimmed] : trimmed;
    }

    // Single exit: every lane above either recorded its block here or already
    // set `degraded`, so this is the one place the turn's facts are emitted.
    reportTurnInjection(injection, nsSessionKey, sessionKey);
    return outbound;
  };
}
