/**
 * Context auto-compression — LLM-driven conversation compression.
 *
 * Follows pi coding-agent conventions:
 * - Trigger: estimatedTokens > contextWindow - reserveTokens
 * - Cut point: walk backwards, keep keepRecentTokens worth of recent messages
 * - Token estimation: CJK-aware weighting (src/shared/token-estimate.ts)
 * - Summarization: structured Markdown with incremental update support
 */

import type { Logger } from 'pino';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { auxLLMCall, type AuxModelConfig } from '../memory/aux-llm-client.js';
import { truncate } from '../shared/truncation.js';
import { estimateTokensForText, IMAGE_BLOCK_TOKENS } from '../shared/token-estimate.js';

// ---------------------------------------------------------------------------
// Token estimation — CJK-aware, see src/shared/token-estimate.ts
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a single message. CJK-aware — see
 * src/shared/token-estimate.ts: the flat chars/4 heuristic this replaces
 * underestimated a zh-CN transcript by ~2x, which delayed the compression
 * trigger until the provider rejected the request.
 */
function estimateMessageTokens(m: AgentMessage): number {
  try {
    let tokens = 0;
    if (typeof m.content === 'string') {
      tokens = estimateTokensForText(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && typeof b.text === 'string')
          tokens += estimateTokensForText(b.text);
        else if (b.type === 'thinking' && typeof b.thinking === 'string')
          tokens += estimateTokensForText(b.thinking);
        // b.name may be missing on malformed toolCall blocks — dereference
        // only after the nullish check (b.name.length ?? 0 would throw).
        else if (b.type === 'toolCall')
          tokens += estimateTokensForText((b.name ?? '') + JSON.stringify(b.arguments ?? {}));
        else if (b.type === 'image') tokens += IMAGE_BLOCK_TOKENS;
        else tokens += estimateTokensForText(JSON.stringify(b));
      }
    }
    return Math.ceil(tokens);
  } catch {
    // Malformed content (e.g. BigInt in arguments makes JSON.stringify throw)
    // must never crash the request — estimate as 0 and let callers proceed.
    return 0;
  }
}

export function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Price the per-turn fixed prefix: the system prompt and every tool schema.
 *
 * The context transform is handed `messages` only, so a compression trigger
 * measured there cannot see a prefix that routinely runs to five figures —
 * the request then exceeds the window while the transcript still looks small.
 */
export function estimateStaticContextTokens(
  systemPrompt: string | undefined,
  tools: ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }> | undefined,
): number {
  let tokens = estimateTokensForText(systemPrompt ?? '');
  for (const tool of tools ?? []) {
    tokens += estimateTokensForText((tool.name ?? '') + (tool.description ?? ''));
    try {
      tokens += estimateTokensForText(JSON.stringify(tool.parameters ?? null));
    } catch {
      // An unserializable schema costs its name and description, nothing more.
    }
  }
  return Math.ceil(tokens);
}

// ---------------------------------------------------------------------------
// Memoized estimation — per-message results cached by object identity
// ---------------------------------------------------------------------------

/**
 * Message objects are stable across turns (agent state preserves the same
 * AgentMessage instances), so memoizing by identity lets the per-turn
 * compression-trigger check skip re-running JSON.stringify over every
 * toolCall arguments blob in history. Only NEW messages pay the cost.
 *
 * WeakMap: entries vanish automatically when messages are dropped from the
 * transcript (e.g. after compression), so no manual eviction is needed.
 */
// Memoization precondition: AgentMessage objects are treated as immutable
// once added to a transcript (pi-mono replaces them, never mutates content
// in place). If a message object were ever mutated after its first estimate,
// the memoized value would be stale — the WeakMap entry dies with the object.
const messageTokensMemo = new WeakMap<object, number>();

export function estimateMessageTokensCached(m: AgentMessage): number {
  if (m && typeof m === 'object') {
    let cached = messageTokensMemo.get(m);
    if (cached === undefined) {
      cached = estimateMessageTokens(m);
      messageTokensMemo.set(m, cached);
    }
    return cached;
  }
  return estimateMessageTokens(m);
}

/** Like {@link estimateTokens} but memoizes per-message results across turns. */
export function estimateTokensCached(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokensCached(m), 0);
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
    accumulated += estimateMessageTokensCached(messages[i]);
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
    content = (m.content as { type: string; text?: string; name?: string }[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
  }
  if (!content.trim() && Array.isArray(m.content)) {
    const parts = (m.content as { type: string; name?: string }[])
      .filter((b) => b.type === 'toolCall')
      .map((b) => `[Tool: ${b.name}]`);
    if (parts.length > 0) content = parts.join(', ');
  }
  if (!content.trim()) return '';
  return `[${m.role} #${index}]: ${truncate(content, 500)}`;
}

// ---------------------------------------------------------------------------
// Prompt templates — pi-style structured Markdown
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are a precise conversation analyst. Compress conversation history into a structured summary for another LLM to continue the work. Preserve exact file paths, function names, and error messages.';

const SUMMARIZATION_PROMPT = `Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goals
[What the user wants to achieve. Can have multiple goals.]

## Constraints & Preferences
- [Constraints, preferences, requirements mentioned by the user]
- [Or "(none)" if absent]

## Progress
### Completed
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Currently ongoing work]

### Blocked
- [Issues blocking progress; omit this subsection if none]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What to do next]

## Key Context
- [Data, examples, references needed to continue work]
- [Or "(none)" if absent]

Keep each section concise.`;

const UPDATE_PROMPT = `The above are new conversation messages that need to be merged into the existing summary inside <previous-summary>. Update the summary with these rules:
- Retain ALL existing information from the old summary
- Add new progress, decisions, and context
- Update progress: move "In Progress" items to "Completed"
- Update "Next Steps"
- Preserve exact file paths, function names, and error messages

Output using the same format.`;

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
export async function compressContext(input: CompressContextInput): Promise<CompressContextOutput> {
  const {
    messages,
    contextWindow,
    settings,
    sessionKey,
    mainModelRef,
    globalFallbackRefs,
    apiKeys,
    baseUrls,
    baseUrl,
    compressModelRef,
    compressFallbackRefs,
    previousSummary,
    logger,
  } = input;
  const empty: CompressContextOutput = { summaryMessage: null, compressedIndex: 0, summary: '' };

  const estimatedTokens = estimateTokens(messages);
  const shouldTrigger = estimatedTokens > contextWindow - settings.reserveTokens;

  if (!shouldTrigger) {
    logger?.debug(
      {
        sessionKey,
        estimatedTokens,
        contextWindow,
        threshold: contextWindow - settings.reserveTokens,
      },
      'Compression not needed yet',
    );
    return empty;
  }

  const cutPoint = findCutPoint(messages, settings.keepRecentTokens);
  if (cutPoint <= 0) return empty;

  const oldMessages = messages.slice(0, cutPoint);
  const compressibleMessages = oldMessages.filter((m) => formatMessage(m, 0).length > 0);
  if (compressibleMessages.length < 4) return empty;

  // Model selection mirrors buildSummaryLLMConfig (memory_aux_models):
  //   configured → use it + its fallback chain
  //   not configured → use primary model + global fallback chain
  const modelRef = compressModelRef || mainModelRef;
  const fallbackRefs = compressModelRef ? (compressFallbackRefs ?? []) : globalFallbackRefs;

  const modelConfig: AuxModelConfig = {
    modelRef,
    fallbackRefs,
    apiKeys,
    baseUrls,
    baseUrl,
  };

  logger?.info(
    {
      sessionKey,
      totalMessages: messages.length,
      compressCount: compressibleMessages.length,
      keepCount: messages.length - cutPoint,
      estimatedTokens,
      contextWindow,
      modelRef: modelConfig.modelRef,
    },
    'Starting context compression',
  );

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

    logger?.info(
      {
        sessionKey,
        compressedCount: compressibleMessages.length,
        keptCount: messages.length - cutPoint,
        summaryLength: summary.length,
      },
      'Context compression completed',
    );

    return {
      summaryMessage: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `\n\n---\n[Context Compression — Earlier Conversation Summary]\n${summary}\n---\n`,
          },
        ],
      } as AgentMessage,
      compressedIndex: cutPoint,
      summary,
    };
  } catch (err) {
    // Hard truncation fallback: the compression LLM failed. Instead of
    // returning empty (which would leave the over-budget context intact and
    // re-trigger a failing compression on every LLM call), drop the old
    // messages at the cut point and keep the recent tail so the request can
    // still go out. The marker keeps the split visible to the model; summary
    // stays empty so a later turn can retry real summarization.
    logger?.warn(
      {
        sessionKey,
        err: err instanceof Error ? err.message : String(err),
      },
      'Context compression failed, falling back to hard truncation',
    );
    const recentMessages = messages.slice(cutPoint);
    if (recentMessages.length === 0) return empty;
    return {
      summaryMessage: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '\n\n---\n[Context Compression — Earlier Conversation Truncated (summarization failed)]\n---\n',
          },
        ],
      } as AgentMessage,
      compressedIndex: cutPoint,
      summary: '',
    };
  }
}
