/**
 * Context auto-compression — LLM-driven conversation compression.
 *
 * Follows pi coding-agent conventions:
 * - Trigger: estimatedTokens > contextWindow - reserveTokens
 * - Cut point: walk backwards, keep keepRecentTokens worth of recent messages
 * - Token estimation: chars/4 heuristic (conservative, overestimates)
 * - Summarization: structured Markdown with incremental update support
 */

import type { Logger } from 'pino';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { auxLLMCall, type AuxModelConfig } from '../memory/aux-llm-client.js';

// ---------------------------------------------------------------------------
// Token estimation — chars/4, conservative (pi convention)
// ---------------------------------------------------------------------------

/** Estimate token count for a single message using chars/4 heuristic. */
function estimateMessageTokens(m: AgentMessage): number {
  let chars = 0;
  if (typeof m.content === 'string') {
    chars = m.content.length;
  } else if (Array.isArray(m.content)) {
    for (const b of m.content as any[]) {
      if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length;
      else if (b.type === 'thinking' && typeof (b as any).thinking === 'string') chars += (b as any).thinking.length;
      else if (b.type === 'toolCall') chars += (b.name?.length ?? 0) + JSON.stringify((b as any).arguments ?? {}).length;
      else if (b.type === 'image') chars += 4800; // image estimate
      else chars += JSON.stringify(b).length;
    }
  }
  return Math.ceil(chars / 4);
}

export function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ---------------------------------------------------------------------------
// Cut point — walk backwards, keepRecentTokens budget
// ---------------------------------------------------------------------------

/**
 * Find the split index: walk backwards from newest messages, accumulating
 * token estimates. Stop when accumulated >= keepRecentTokens.
 * Returns the index of the first message to KEEP (older messages get compressed).
 */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // Don't cut at a toolResult — its toolCall is before it
      let cut = i;
      while (cut > 0 && messages[cut]?.role === 'toolResult') cut--;
      return Math.max(cut, 0);
    }
  }
  return 0; // everything fits in keepRecentTokens
}

// ---------------------------------------------------------------------------
// Message formatting for compression prompt
// ---------------------------------------------------------------------------

function formatMessage(m: AgentMessage, index: number): string {
  let content = '';
  if (typeof m.content === 'string') {
    content = m.content;
  } else if (Array.isArray(m.content)) {
    content = (m.content as any[])
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  if (!content.trim() && Array.isArray(m.content)) {
    const parts = (m.content as any[])
      .filter((b: any) => b.type === 'toolCall')
      .map((b: any) => `[调用工具: ${b.name}]`);
    if (parts.length > 0) content = parts.join(', ');
  }
  if (!content.trim()) return '';
  return `[${m.role} #${index}]: ${content.slice(0, 500)}`;
}

// ---------------------------------------------------------------------------
// Prompt templates — pi-style structured Markdown
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = 'You are a precise conversation analyst. Compress conversation history into a structured summary for another LLM to continue the work. Preserve exact file paths, function names, and error messages.';

const SUMMARIZATION_PROMPT = `Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## 目标
[用户想要达成什么？可以有多个目标。]

## 约束与偏好
- [用户提到的约束、偏好、要求]
- [或 "(无)" 如果没有]

## 进度
### 已完成
- [x] [已完成的任务/变更]

### 进行中
- [ ] [当前正在进行的工作]

### 受阻
- [阻碍进展的问题，如果没有则省略此小节]

## 关键决策
- **[决策]**: [简要理由]

## 下一步
1. [接下来应该做什么]

## 关键上下文
- [继续工作所需的数据、示例、引用]
- [或 "(无)" 如果没有]

每个部分保持简洁。`;

const UPDATE_PROMPT = `以上是新的对话消息，需要合并到 <previous-summary> 中的现有摘要。更新摘要，规则：
- 保留旧摘要中的所有信息
- 添加新的进度、决策和上下文
- 更新进度：将"进行中"移到"已完成"
- 更新"下一步"
- 保留准确的文件路径、函数名、错误信息

使用相同的格式输出。`;

// ---------------------------------------------------------------------------
// Compression entry point
// ---------------------------------------------------------------------------

export interface CompressSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_SETTINGS: CompressSettings = {
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export interface CompressContextInput {
  messages: AgentMessage[];
  contextWindow: number;
  settings: CompressSettings;
  sessionKey: string;
  mainModelRef: string;
  globalFallbackRefs: string[];
  apiKeys: Record<string, string>;
  baseUrls: Record<string, string>;
  baseUrl?: string;
  /** Optional compression-specific model. Falls back to mainModelRef. */
  compressModelRef?: string;
  compressFallbackRefs?: string[];
  /** Previous compaction summary for incremental update. */
  previousSummary?: string;
  logger?: Pick<Logger, 'debug' | 'warn' | 'info'>;
}

export interface CompressContextOutput {
  summaryMessage: AgentMessage | null;
  compressedIndex: number;
  summary: string;
}

/**
 * Compress old messages into a structured summary.
 *
 * Algorithm (pi convention):
 * 1. Check if contextTokens > contextWindow - reserveTokens
 * 2. Find cut point to keep ~keepRecentTokens worth of recent messages
 * 3. Generate structured summary of older messages via LLM
 * 4. Return summary message + split index
 */
export async function compressContext(
  input: CompressContextInput,
): Promise<CompressContextOutput> {
  const { messages, contextWindow, settings, sessionKey, mainModelRef, globalFallbackRefs, apiKeys, baseUrls, baseUrl, compressModelRef, compressFallbackRefs, previousSummary, logger } = input;
  const empty: CompressContextOutput = { summaryMessage: null, compressedIndex: 0, summary: '' };

  const estimatedTokens = estimateTokens(messages);
  const shouldTrigger = estimatedTokens > contextWindow - settings.reserveTokens;

  if (!shouldTrigger) {
    logger?.debug({ sessionKey, estimatedTokens, contextWindow, threshold: contextWindow - settings.reserveTokens }, 'Compression not needed yet');
    return empty;
  }

  const cutPoint = findCutPoint(messages, settings.keepRecentTokens);
  if (cutPoint <= 0) return empty;

  const oldMessages = messages.slice(0, cutPoint);
  const compressibleMessages = oldMessages.filter(m => formatMessage(m, 0).length > 0);
  if (compressibleMessages.length < 4) return empty;

  // Model selection mirrors buildSummaryLLMConfig (memory_aux_models):
  //   configured → use it + its fallback chain
  //   not configured → use primary model + global fallback chain
  const modelRef = compressModelRef || mainModelRef;
  const fallbackRefs = compressModelRef
    ? (compressFallbackRefs ?? [])
    : globalFallbackRefs;

  const modelConfig: AuxModelConfig = {
    modelRef,
    fallbackRefs,
    apiKeys,
    baseUrls,
    baseUrl,
  };

  logger?.info({
    sessionKey,
    totalMessages: messages.length,
    compressCount: compressibleMessages.length,
    keepCount: messages.length - cutPoint,
    estimatedTokens,
    contextWindow,
    modelRef: modelConfig.modelRef,
  }, 'Starting context compression');

  try {
    const prompt = previousSummary
      ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${UPDATE_PROMPT}`
      : SUMMARIZATION_PROMPT;

    const transcript = compressibleMessages
      .map((m, i) => formatMessage(m, i + 1))
      .filter(Boolean)
      .join('\n');

    const userPrompt = `<conversation>\n${transcript}\n</conversation>\n\n${prompt}`;

    const response = await auxLLMCall(modelConfig, {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.3,
      maxTokens: 2000,
      logger: logger as Logger,
    });

    if (!response?.trim()) {
      logger?.warn({ sessionKey }, 'Compression LLM returned empty response');
      return empty;
    }

    const summary = response.trim();

    logger?.info({
      sessionKey,
      compressedCount: compressibleMessages.length,
      keptCount: messages.length - cutPoint,
      summaryLength: summary.length,
    }, 'Context compression completed');

    return {
      summaryMessage: {
        role: 'user',
        content: [{ type: 'text', text: `\n\n---\n[上下文压缩 — 早期对话摘要]\n${summary}\n---\n` }],
      } as AgentMessage,
      compressedIndex: cutPoint,
      summary,
    };
  } catch (err) {
    logger?.warn({
      sessionKey,
      err: err instanceof Error ? err.message : String(err),
    }, 'Context compression failed, falling back to hard truncation');
    return empty;
  }
}
