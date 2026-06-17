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
 */

import type { MemoryRetriever, RetrievedMemory } from '../memory/memory-retriever.js';
import type { MermaidCanvas } from '../runtime-artifacts/mermaid-canvas.js';
import type { AutoCompressConfig } from '../app/types.js';
import { compressContext, estimateTokens } from './compress.js';
import type { Logger } from 'pino';

function formatCurrentDatePrefix(lang?: string, granularity: 'minute' | 'day' = 'minute'): string | null {
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
  return TIME_SENSITIVE_PATTERNS.some(pattern => pattern.test(text));
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
];

const deepseekMemorySignatureBySession = new Map<string, string>();
const deepseekPersonaSignatureBySession = new Map<string, string>();
const deepseekCanvasSignatureBySession = new Map<string, string>();

function isMemoryRelevantRequest(text: string): boolean {
  return MEMORY_RELEVANT_PATTERNS.some(pattern => pattern.test(text));
}

function isCanvasRelevantRequest(text: string): boolean {
  return CANVAS_RELEVANT_PATTERNS.some(pattern => pattern.test(text));
}

function allowsHistoricalTimeMemory(text: string): boolean {
  return /上次|之前|历史|过去|记录|回忆|以前|问过|previous|history|past/i.test(text);
}

function isStaleCurrentTimeMemory(content: string): boolean {
  return STALE_CURRENT_TIME_MEMORY_PATTERNS.some(pattern => pattern.test(content));
}

function getUserQueryText(content: string | any[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return false;
      const text = b.text.trimStart();
      return !INJECTED_BLOCK_PREFIXES.some(prefix => text.startsWith(prefix));
    })
    .map((b: any) => b.text)
    .join('\n');
}

function buildMemoryLines(memories: RetrievedMemory[], query: string): string[] {
  const allowStaleTime = allowsHistoricalTimeMemory(query);
  return memories
    .filter(m => m.content?.trim())
    .filter(m => allowStaleTime || !isStaleCurrentTimeMemory(m.content))
    .map(m => `- ${m.content}`)
    .slice(0, 5);
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
   * Optional provider that returns a system-reminder string when a Desktop Bridge
   * is active for the current session. Injected into the context so the LLM knows
   * it can access the user's local files and shell.
   */
  desktopBridgeReminderProvider?: (sessionKey?: string) => string | undefined;
  /** Config for Mermaid canvas task graph injection. */
  mermaidCanvasConfig?: { enabled: boolean; injectFormat: 'summary' | 'full'; maxNodesInContext: number };
  /** MermaidCanvas instance for tracking tool execution progress. */
  mermaidCanvas?: MermaidCanvas;
  /** Optional logger for context-injection observability. */
  logger?: Pick<Logger, 'debug' | 'warn' | 'info'>;
  /** Provider-tuned cache behavior. Currently used for DeepSeek automatic prefix cache. */
  cacheProfile?: 'default' | 'deepseek';
}

/**
 * Convert a string user message content to an array of content blocks,
 * preserving the original text as the first block.
 */
function ensureContentBlocks(content: string | any[]): any[] {
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: content }];
}

/**
 * Check whether a date prefix has already been injected into the content blocks.
 */
function hasDatePrefix(blocks: any[]): boolean {
  return blocks.some((b: any) =>
    b.type === 'text' && (
      (b.text ?? '').startsWith('[当前时间') ||
      (b.text ?? '').startsWith('[当前日期') ||
      (b.text ?? '').startsWith('[Current time') ||
      (b.text ?? '').startsWith('[Current date')
    ),
  );
}

function hasPreciseTimePrefix(blocks: any[]): boolean {
  return blocks.some((b: any) =>
    b.type === 'text' && (
      (b.text ?? '').startsWith('[当前时间') ||
      (b.text ?? '').startsWith('[Current time')
    ),
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
  const snapshotMode = options?.snapshotMode ??
    (autoRecallFrequency === 'every' ? 'every' : 'first');

  // Track sessions that have already had auto-recall triggered
  const recalledSessions = new Set<string>();
  // Snapshot cache for session-scoped memory caching (V2)
  const snapshotCache = new Map<string, RetrievedMemory[]>();
  const personaInjectedSessions = new Set<string>();
  const personaTextBySession = new Map<string, string>();
  const desktopBridgeInjectedSessions = new Set<string>();

  // Capture language for per-message date injection
  const dateLanguage = options?.dateLanguage;
  const cacheProfile = options?.cacheProfile ?? 'default';
  const dateGranularity = 'day';

  // v9: Track last compressed index + summary per session for incremental updates
  const lastCompressedIndexBySession = new Map<string, number>();
  const lastCompressionSummaryBySession = new Map<string, string>();

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
          blocks.push({ type: 'text', text: '\n\n' + datePrefix });
        }
        if (!hasPreciseTimePrefix(blocks) && isTimeSensitiveRequest(getMessageText(lastUserMsg.content))) {
          const preciseTime = formatCurrentDatePrefix(dateLanguage, 'minute');
          if (preciseTime) blocks.push({ type: 'text', text: '\n\n' + preciseTime });
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
            const cacheKey = sessionKey || 'default';
            let memories: RetrievedMemory[];
            if (snapshotMode === 'first' && snapshotCache.has(cacheKey)) {
              memories = snapshotCache.get(cacheKey)!;
            } else {
              memories = await memoryRetriever.retrieveGrouped({
                query,
                agentId,
                topK: 5,
              });
              if (snapshotMode === 'first') {
                snapshotCache.set(cacheKey, memories);
              }
            }

            if (memories.length > 0) {
              const memoryLines = buildMemoryLines(memories, query);
              if (memoryLines.length > 0) {
                const memoryHint = `\n\n---\nRelevant remembered information:\n${memoryLines.join('\n')}`;
                const memoryKey = sessionKey || 'default';
                const previous = deepseekMemorySignatureBySession.get(memoryKey);
                const shouldInjectMemory =
                  cacheProfile !== 'deepseek' ||
                  previous !== memoryHint ||
                  isMemoryRelevantRequest(query);
                if (shouldInjectMemory) {
                  options?.logger?.debug({ count: memoryLines.length, memories: memoryLines.map(l => l.slice(0, 60)) }, 'Memories injected into context');
                  const idx = result.lastIndexOf(lastUserMsg);
                  const injectedBlocks = [...blocks, { type: 'text', text: memoryHint }];
                  result[idx] = { ...lastUserMsg, content: injectedBlocks };
                  if (cacheProfile === 'deepseek') deepseekMemorySignatureBySession.set(memoryKey, memoryHint);
                } else {
                  options?.logger?.debug({ sessionKey: memoryKey, count: memoryLines.length }, 'Repeated memory context skipped for DeepSeek cache profile');
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
      const shouldRecall = autoRecall && memoryRetriever && (
        autoRecallFrequency === 'every' || !recalledSessions.has(sessionKey ?? '')
      );

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
                scope: 'user',         // limit to user-scoped memories
              });

              if (memories.length > 0) {
                const memoryLines = buildMemoryLines(memories, query);
                if (memoryLines.length > 0) {
                  const memoryHint = `\n\n---\nRelevant remembered information:\n${memoryLines.join('\n')}`;
                  const memoryKey = sessionKey || 'default';
                  const previous = deepseekMemorySignatureBySession.get(memoryKey);
                  const shouldInjectMemory =
                    cacheProfile !== 'deepseek' ||
                    previous !== memoryHint ||
                    isMemoryRelevantRequest(query);
                  if (shouldInjectMemory) {
                    const idx = result.lastIndexOf(lastUserMsg);
                    const injectedBlocks = [...blocks, { type: 'text', text: memoryHint }];
                    result[idx] = { ...lastUserMsg, content: injectedBlocks };
                    if (cacheProfile === 'deepseek') deepseekMemorySignatureBySession.set(memoryKey, memoryHint);
                  } else {
                    options?.logger?.debug({ sessionKey: memoryKey, count: memoryLines.length }, 'Repeated memory context skipped for DeepSeek cache profile');
                  }
                }
              }
            } catch (err) {
              options?.logger?.debug({ err }, 'Memory retrieval failed — continuing without memory context');
            }
            recalledSessions.add(sessionKey ?? '');
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
        const completed = nodes.filter(n => n.status !== 'running').length;
        const currentPhase = options.mermaidCanvas.getCurrentPhase();
        const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
        const currentUserText = lastUserMsg ? getUserQueryText(lastUserMsg.content) : '';
        const canvasKey = sessionKey || 'default';
        const canvasSignature = `${total}:${completed}:${currentPhase}`;
        const previousCanvasSignature = deepseekCanvasSignatureBySession.get(canvasKey);
        const shouldSkipCanvas =
          cacheProfile === 'deepseek' &&
          total > 0 &&
          completed === total &&
          previousCanvasSignature === canvasSignature &&
          !isCanvasRelevantRequest(currentUserText);

        if (shouldSkipCanvas) {
          options.logger?.debug({ sessionKey: canvasKey, nodeCount: total, currentPhase }, 'Repeated static Mermaid canvas skipped for DeepSeek cache profile');
        } else {
          if (cacheProfile === 'deepseek') deepseekCanvasSignatureBySession.set(canvasKey, canvasSignature);
        if (nodes.length <= options.mermaidCanvasConfig.maxNodesInContext) {
          const canvasText = options.mermaidCanvasConfig.injectFormat === 'full'
            ? options.mermaidCanvas.toMermaid()
            : options.mermaidCanvas.toContextSummary();
          if (canvasText) {
            const canvasHint = `\n\n---\n${canvasText}`;
            if (lastUserMsg) {
              const idx = result.lastIndexOf(lastUserMsg);
              const blocks = ensureContentBlocks(lastUserMsg.content);
              result[idx] = { ...lastUserMsg, content: [...blocks, { type: 'text', text: canvasHint }] };
              options.logger?.debug({
                sessionKey,
                nodeCount: nodes.length,
                injectFormat: options.mermaidCanvasConfig.injectFormat,
                maxNodesInContext: options.mermaidCanvasConfig.maxNodesInContext,
              }, 'Mermaid canvas injected into context');
            }
          }
        } else {
          // Too many nodes — inject a concise count summary instead
          const max = options.mermaidCanvasConfig.maxNodesInContext;
          const countHint = `\n\n---\n[任务进度] 当前阶段: ${currentPhase} (${completed}/${total} 完成, 显示最近 ${max}/${total} 步)`;
          if (lastUserMsg) {
            const idx = result.lastIndexOf(lastUserMsg);
            const blocks = ensureContentBlocks(lastUserMsg.content);
            result[idx] = { ...lastUserMsg, content: [...blocks, { type: 'text', text: countHint }] };
            options.logger?.debug({
              sessionKey,
              nodeCount: total,
              completed,
              currentPhase,
              maxNodesInContext: max,
            }, 'Mermaid canvas compact progress injected into context');
          }
        }
        }
      } catch (err) {
        options.logger?.warn({
          sessionKey,
          err: err instanceof Error ? err.message : String(err),
        }, 'Mermaid canvas injection failed');
        // Mermaid canvas injection failure should not block the LLM call
      }
    }

    // Inject persona AFTER Mermaid so the current preferred name overrides any
    // stale name references from conversation history or Mermaid summary.

    // ── Inject Desktop Bridge reminder ──
    // Injected once per session so the LLM knows file/shell tools will execute
    // on the user's local machine, not on the gateway server.
    if (options?.desktopBridgeReminderProvider) {
      const bridgeKey = sessionKey || 'default';
      const reminderText = options.desktopBridgeReminderProvider(sessionKey);
      if (reminderText) {
        const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
        if (lastUserMsg?.content) {
          const idx = result.lastIndexOf(lastUserMsg);
          const blocks = ensureContentBlocks(lastUserMsg.content);
          // Inject once per session — the reminder is static so repeated injection
          // would just waste context tokens.
          if (!desktopBridgeInjectedSessions.has(bridgeKey)) {
            desktopBridgeInjectedSessions.add(bridgeKey);
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
      const personaKey = sessionKey || 'default';
      const lastUserMsg = [...result].reverse().find((m: any) => m.role === 'user');
      if (lastUserMsg?.content) {
        try {
          const personaText = options.personaContextProvider();
          if (personaText?.trim()) {
            const previousPersonaText = personaTextBySession.get(personaKey);
            const previousDeepSeekPersonaText = deepseekPersonaSignatureBySession.get(personaKey);
            const shouldInjectPersona =
              cacheProfile === 'deepseek'
                ? previousDeepSeekPersonaText !== personaText || isMemoryRelevantRequest(getUserQueryText(lastUserMsg.content))
                : autoRecallFrequency === 'every' ||
                  !personaInjectedSessions.has(personaKey) ||
                  previousPersonaText !== personaText;

            if (shouldInjectPersona) {
              options?.logger?.debug({ personaText: personaText.slice(0, 120) }, 'Persona injected into context');
              const idx = result.lastIndexOf(lastUserMsg);
              const blocks = ensureContentBlocks(lastUserMsg.content);
              const personaBlock = { type: 'text' as const, text: `${personaText}\n\n---\n` };
              const nextBlocks = [...blocks, personaBlock];
              result[idx] = { ...lastUserMsg, content: nextBlocks };
              personaInjectedSessions.add(personaKey);
              personaTextBySession.set(personaKey, personaText);
              if (cacheProfile === 'deepseek') deepseekPersonaSignatureBySession.set(personaKey, personaText);
            } else if (cacheProfile === 'deepseek') {
              options?.logger?.debug({ sessionKey: personaKey }, 'Repeated persona context skipped for DeepSeek cache profile');
            }
          }
        } catch {
          options?.logger?.debug('Persona injection failed — continuing without persona context');
        }
      }
    }

    // ── v9: Auto context compression (pi-style) ──
    // Trigger: estimatedTokens > contextWindow - reserveTokens.
    // Keeps keepRecentTokens worth of recent messages, compresses older ones.
    // Hard truncation below is the safety net.
    const compressCfg = options?.compressConfig;
    if (compressCfg?.config.enabled && sessionKey) {
      const estimatedTokens = estimateTokens(result);
      const defaultThreshold = compressCfg.contextWindow - compressCfg.config.reserveTokens;
      const triggerThreshold = cacheProfile === 'deepseek'
        ? Math.min(defaultThreshold, 12000)
        : defaultThreshold;

      if (estimatedTokens > triggerThreshold) {
        try {
          const previousSummary = lastCompressionSummaryBySession.get(sessionKey);
          const compressResult = await compressContext({
            messages: result as any,
            contextWindow: compressCfg.contextWindow,
            settings: {
              reserveTokens: compressCfg.config.reserveTokens,
              keepRecentTokens: cacheProfile === 'deepseek'
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
            logger: options?.logger,
          });

          if (compressResult.summaryMessage && compressResult.compressedIndex > 0) {
            const recentMessages = result.slice(compressResult.compressedIndex);
            const originalCount = result.length;
            const tokensBefore = estimateTokens(result);
            result.length = 0;
            result.push(compressResult.summaryMessage, ...recentMessages);
            lastCompressedIndexBySession.set(sessionKey, result.length);
            if (compressResult.summary) {
              lastCompressionSummaryBySession.set(sessionKey, compressResult.summary);
            }
            options?.logger?.info({
              sessionKey,
              originalCount,
              newCount: result.length,
              compressedIndex: compressResult.compressedIndex,
              tokensBefore,
              tokensAfter: estimateTokens(result),
            }, 'Context compressed');
          }
        } catch (err) {
          options?.logger?.warn({
            sessionKey,
            err: err instanceof Error ? err.message : String(err),
          }, 'Context compression failed, falling back to hard truncation');
        }
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
            const injectableRecords = preserveCount > 0
              ? records.slice(0, Math.max(0, records.length - preserveCount))
              : records;
            const maxRefs = Math.max(1, offloadCfg.maxRefsInContext);
            const trimmedRecords = injectableRecords.filter(r => r.seq <= trimStart).slice(-maxRefs);
            const lines = trimmedRecords.map(r => {
              const icon = r.status === 'error' ? '❌' : '✅';
              return `${icon} [${r.nodeId}] ${r.summary || r.toolName} | ${sessionDir}/${r.refPath}`;
            });
            if (lines.length > 0) {
              const hint = `\n\n---\n[已归档的早期工具结果 (使用 file_read 恢复)]\n${lines.join('\n')}`;
              const firstUser = trimmed.find((m: any) => m.role === 'user');
              if (firstUser) {
                const idx = trimmed.indexOf(firstUser);
                const blocks = ensureContentBlocks(firstUser.content);
                trimmed[idx] = { ...firstUser, content: [{ type: 'text', text: hint }, ...blocks] };
              }
            }
          }
        } catch {
          options?.logger?.debug('Offload index injection failed — continuing without offload hints');
        }
      }

      return systemMsg ? [systemMsg, ...trimmed] : trimmed;
    }

    return result;
  };
}
